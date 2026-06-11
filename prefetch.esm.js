/*!
 * prefetch.ru v1.1.4 (ESM) - Мгновенная загрузка страниц
 * © 2026 Сергей Макаров | MIT License
 * https://prefetch.ru | https://github.com/prefetch-ru
 */
/**
 * Core prefetch logic - shared between IIFE and ESM builds.
 * @param {Object} options
 * @param {function(): string|null} options.getNonce - Function to get CSP nonce
 * @param {boolean} options.isBrowser - Whether running in browser environment
 * @returns {Object} Prefetch API
 */
function createPrefetchCore(options) {

  var getNonce = options && options.getNonce;
  var isBrowser = options ? options.isBrowser : true;

  // SSR/Non-browser guard
  if (!isBrowser || typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      __prefetchRu: true,
      version: '1.1.4',
      preload: function () {},
      destroy: function () {},
      refresh: function () {}
    }
  }

  // Состояние
  var preloaded = new Set();
  var hoverTimers = new WeakMap();
  var disabled = false;

  // v1.0.11: in-flight лимит (макс. параллельных запросов)
  var inFlight = 0;
  var maxInFlight = 4;
  var queue = [];
  var maxQueue = 50; // v1.0.11: лимит очереди (защита от переполнения)

  // v1.0.13: Set активных AbortController для корректного destroy()
  var activeControllers = new Set();

  // v1.0.13: буфер для Speculation Rules (группируем URL и вставляем одним JSON)
  // v1.1.4: элементы {url, key} вместо строк (нужны для fallback при ошибке вставки);
  // crossOrigin убран - cross-origin идёт мимо Speculation Rules (см. doPreload)
  var specBuffer = { prefetch: [], prerender: [] };
  var specFlushTimer = 0;
  // v1.1.4: вставленные speculationrules-скрипты; удаление элемента из DOM отменяет
  // его правила, поэтому убираем их только в destroy()
  var specScripts = [];

  // v1.0.11: кэш ключа текущей страницы (избегаем new URL() в горячих местах)
  var currentKey = '';

  var lastTouchTime = 0;
  var touchTimer = 0;
  var touchCancel = null;

  var isMobile = false;
  var isIOS = false;
  var platform = null;
  var saveData = false;
  var connType = null;

  // v1.1.3: ссылка на navigator.connection для снятия listener в destroy()
  var conn = null;

  // CSP / поддержка
  var scriptNonce = null;
  var supportsLinkPrefetch = false;

  // Настройки
  var hoverDelay = 65;
  var touchDelay = 80;
  var maxPreloads = 50;
  var allowQuery = false;
  var allowExternal = false;
  var whitelist = false;

  // v1.1.4: переменная useSpecRules удалена - дублировала specMode !== 'none'
  var specMode = 'none'; // 'none' | 'prefetch' | 'prerender'
  var specRulesFallback = false; // v1.0.11: fallback при SpecRules (по умолчанию отключён)
  var prerenderAll = false;

  var mousedownMode = false;
  var viewportMode = false;
  var observeDom = false;

  // v1.0.11: regex вынесены в верхний scope (perf — не создавать на каждый вызов)
  var DANGEROUS_PATH_RE = /(^|\/)(login|logout|auth|register|cart|basket|add|delete|remove)(\/|$|\.)/i;
  var FILE_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|zip|rar|exe)($|\?)/i

  // Инициализация
  ;(function init() {
    // CSP nonce через переданную функцию
    if (getNonce) {
      try {
        scriptNonce = getNonce();
      } catch (e) {}
    }

    // rel=prefetch support
    try {
      var l = document.createElement('link');
      if (l.relList && typeof l.relList.supports === 'function') {
        supportsLinkPrefetch = l.relList.supports('prefetch');
      }
    } catch (e) {}

    var ua = navigator.userAgent;
    var uaData = navigator.userAgentData; // v1.0.12: UA-CH API (более надёжно в долгосрочной перспективе)

    // v1.1.3: UA-CH API если доступен, иначе fallback на UA
    if (uaData) {
      // UA-CH API: https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData
      isIOS = false; // UA-CH пока не поддерживается на iOS
      isMobile = uaData.mobile || false;
    } else {
      // Fallback на традиционный UA sniffing
      isIOS =
        /iPad|iPhone/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      isMobile = (isIOS || /Android/.test(ua)) && Math.min(screen.width, screen.height) < 768;
    }
    if (isMobile) maxPreloads = 20;

    // Сеть
    conn = navigator.connection;
    if (conn) {
      connType = conn.effectiveType;
      saveData = conn.saveData || false;
      // v1.1.3: реактивное обновление при смене типа соединения
      if (typeof conn.addEventListener === 'function') {
        conn.addEventListener('change', onConnectionChange);
      }
    }

    // Ждём DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setup);
    } else {
      setup();
    }
  })();

  function setup() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return

    var body = document.body;
    if (!body) return

    // v1.0.11: кэшируем ключ текущей страницы
    currentKey = location.origin + location.pathname + location.search;

    platform = detectPlatform();

    // Читаем конфигурацию
    var ds = body.dataset;
    allowQuery = 'prefetchAllowQueryString' in ds || 'instantAllowQueryString' in ds;
    allowExternal = 'prefetchAllowExternalLinks' in ds || 'instantAllowExternalLinks' in ds;
    whitelist = 'prefetchWhitelist' in ds || 'instantWhitelist' in ds;

    // CSP nonce через data-* - fallback при отсутствии nonce у самого скрипта
    // <body data-prefetch-nonce="...">
    // v1.1.4: после чтения атрибут удаляется: копия nonce в видимом DOM обходит браузерный
    // nonce hiding и доступна для эксфильтрации CSS-селекторами по атрибуту
    if (!scriptNonce && ds.prefetchNonce) scriptNonce = ds.prefetchNonce;
    if (!scriptNonce && ds.instantNonce) scriptNonce = ds.instantNonce;
    if (ds.prefetchNonce) body.removeAttribute('data-prefetch-nonce');
    if (ds.instantNonce) body.removeAttribute('data-instant-nonce');

    // Speculation Rules — opt-in по наличию атрибута:
    // <body data-prefetch-specrules> (prefetch)
    // <body data-prefetch-specrules="prerender">
    // <body data-prefetch-specrules="no">
    var hasSr = 'prefetchSpecrules' in ds || 'instantSpecrules' in ds;
    if (
      !isIOS &&
      hasSr &&
      HTMLScriptElement.supports &&
      HTMLScriptElement.supports('speculationrules')
    ) {
      var sr = ds.prefetchSpecrules || ds.instantSpecrules;
      if (sr === 'prerender') {
        specMode = 'prerender';
      } else if (sr !== 'no') {
        specMode = 'prefetch';
      }
    }

    // v1.0.11: fallback при Speculation Rules (по умолчанию отключён для избежания двойного трафика)
    // <body data-prefetch-specrules-fallback>
    specRulesFallback = 'prefetchSpecrulesFallback' in ds || 'instantSpecrulesFallback' in ds;

    // Разрешить "глобальный" prerender без whitelist (не рекомендуется, но бывает нужно)
    // <body data-prefetch-prerender-all>
    prerenderAll = 'prefetchPrerenderAll' in ds || 'instantPrerenderAll' in ds;

    // Интенсивность
    var intensity = ds.prefetchIntensity || ds.instantIntensity;
    if (intensity === 'mousedown') {
      mousedownMode = true;
    } else if (intensity === 'viewport' || intensity === 'viewport-all') {
      if (intensity === 'viewport-all' || (isMobile && isNetworkOk())) {
        viewportMode = true;
      }
    } else if (intensity) {
      var d = parseInt(intensity, 10);
      if (!isNaN(d) && d >= 0) hoverDelay = d;
    }

    // На мобильных делаем touch-предзагрузку менее агрессивной
    if (isMobile) {
      touchDelay = Math.max(60, Math.min(hoverDelay || 0, 150));
    }

    // DOM observer для SPA
    // v1.0.11: добавлен алиас instantObserveDom
    observeDom = 'prefetchObserveDom' in ds || 'instantObserveDom' in ds;
    if (!observeDom && (platform === 'bitrix' || platform === 'tilda')) {
      observeDom = true;
    }

    // v1.0.11: обновляем currentKey при навигации (pushState, popstate, hashchange)
    window.addEventListener('popstate', updateCurrentKey);
    window.addEventListener('hashchange', updateCurrentKey);
    // v1.0.12: pageshow для bfcache restore (popstate не всегда срабатывает при возврате из bfcache)
    window.addEventListener('pageshow', onPageShow);

    // Tilda — увеличиваем задержку из-за popup-ов
    if (platform === 'tilda' && hoverDelay < 100) hoverDelay = 100;

    // События
    var opts = { capture: true, passive: true };
    document.addEventListener('touchstart', onTouchStart, opts);
    if (!mousedownMode) {
      document.addEventListener('mouseover', onMouseOver, opts);
    } else {
      document.addEventListener('mousedown', onMouseDown, opts);
    }

    // Viewport observer
    // v1.0.10: feature-detection — если IntersectionObserver недоступен, отключаем viewport режим
    if (viewportMode && typeof IntersectionObserver === 'undefined') viewportMode = false;

    if (viewportMode) {
      scheduleIdle(startViewportObserver, 1500);
    }

    // v1.0.9: MutationObserver нужен только для viewport режима (отслеживать новые ссылки)
    // v1.0.10: feature-detection — если MutationObserver недоступен, не запускаем
    if (observeDom && viewportMode && typeof MutationObserver !== 'undefined') startMutationObserver();
  }

  // v1.1.4: единый шим requestIdleCallback (раньше дублировался в трёх местах)
  function scheduleIdle(cb, timeout) {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(cb, { timeout: timeout })
    }
    return setTimeout(cb, 1)
  }

  function cancelIdle(id) {
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(id);
    else clearTimeout(id);
  }

  function detectPlatform() {
    if (typeof window.BX !== 'undefined') return 'bitrix'
    if (typeof window.B24 !== 'undefined' || typeof window.BX24 !== 'undefined') return 'bitrix24'
    if (document.querySelector('.t-records') || typeof window.Tilda !== 'undefined') return 'tilda'
    return null
  }

  function isNetworkOk() {
    if (saveData) return false
    if (connType === 'slow-2g' || connType === '2g' || connType === '3g') return false
    return true
  }

  // v1.1.3: реактивное обновление состояния сети
  function onConnectionChange() {
    if (conn) {
      connType = conn.effectiveType;
      saveData = conn.saveData || false;
    }
  }

  // v1.0.11: обновление currentKey при навигации (SPA-гибриды, pushState)
  function updateCurrentKey() {
    currentKey = location.origin + location.pathname + location.search;
  }

  // v1.0.12: pageshow для bfcache restore
  function onPageShow(e) {
    // persisted === true означает восстановление из bfcache
    if (e && e.persisted) {
      updateCurrentKey();
    }
  }

  // v1.1.4: принимает событие; через composedPath() достаёт настоящий target внутри shadow DOM
  // (ретаргетинг подменяет e.target на хост-элемент, и ссылки в shadow-дереве терялись)
  function getAnchorFromEvent(e) {
    if (!e) return null
    var t = e.target;
    if (t && t.shadowRoot && typeof e.composedPath === 'function') {
      var path = e.composedPath();
      if (path && path.length) t = path[0];
    }
    if (!t) return null
    if (t.nodeType && t.nodeType !== 1) t = t.parentElement;
    if (!t || typeof t.closest !== 'function') return null
    return t.closest('a')
  }

  // v1.1.4: единая очистка touch-таймера и слушателей отмены (дублировалась в четырёх местах)
  function resetTouch() {
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = 0;
    }
    if (touchCancel) {
      document.removeEventListener('touchmove', touchCancel, true);
      document.removeEventListener('scroll', touchCancel, true);
      touchCancel = null;
    }
  }

  function onTouchStart(e) {
    // v1.0.11: защита от синтетических событий и disabled режим
    if (disabled) return
    if (e && e.isTrusted === false) return

    // v1.0.9: используем Date.now() для единой шкалы времени
    lastTouchTime = Date.now();

    var a = getAnchorFromEvent(e);
    if (!canPreload(a)) return

    // задержка + отмена на scroll/touchmove
    resetTouch();

    var cancelled = false;
    touchCancel = function () {
      cancelled = true;
      resetTouch();
    };

    document.addEventListener('touchmove', touchCancel, { capture: true, passive: true, once: true });
    document.addEventListener('scroll', touchCancel, { capture: true, passive: true, once: true });

    touchTimer = setTimeout(function () {
      resetTouch();
      if (!cancelled) preload(a);
    }, touchDelay);
  }

  function onMouseOver(e) {
    // v1.0.11: защита от синтетических событий и disabled режим
    if (disabled) return
    if (e && e.isTrusted === false) return

    // v1.0.9: единая шкала времени Date.now()
    if (lastTouchTime && Date.now() - lastTouchTime < 2500) return

    var a = getAnchorFromEvent(e);
    if (!a) return

    // v1.0.11: проверяем таймер ДО canPreload (perf — mouseover очень шумный)
    if (hoverTimers.has(a)) return

    if (!canPreload(a)) return

    // mouseleave не срабатывает при перемещении внутри ссылки (в отличие от mouseout)
    a.addEventListener('mouseleave', onMouseLeave, { passive: true, once: true });

    var t = setTimeout(function () {
      preload(a);
      hoverTimers.delete(a);
    }, hoverDelay);
    hoverTimers.set(a, t);
  }

  function onMouseLeave(e) {
    var a = e.currentTarget;
    if (!a) return

    var t = hoverTimers.get(a);
    if (t) {
      clearTimeout(t);
      hoverTimers.delete(a);
    }
  }

  function onMouseDown(e) {
    // v1.0.11: защита от синтетических событий и disabled режим
    if (disabled) return
    if (e && e.isTrusted === false) return

    // v1.0.12: button===1 (middle click) тоже открывает новую вкладку — префетч бессмысленен
    if (typeof e.button === 'number' && (e.button === 1 || e.button === 2)) return
    // v1.0.10: при модификаторах (Ctrl/Meta/Shift/Alt) открывается новая вкладка — префетч бессмысленен
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    // v1.0.9: единая шкала времени Date.now()
    if (lastTouchTime && Date.now() - lastTouchTime < 2500) return

    var a = getAnchorFromEvent(e);
    if (canPreload(a)) preload(a);
  }

  function canPreload(a) {
    if (!a) return false

    // v1.0.7: исключаем <a href=""> и <a> без href (часто используются как кнопки)
    var hrefAttr = a.getAttribute('href');
    if (hrefAttr === null || hrefAttr.trim() === '') return false

    if (!a.href) return false

    // Не навигация в текущей вкладке
    if (a.target && a.target !== '_self') return false
    if (a.hasAttribute('download')) return false

    // Явный запрет
    // v1.1.4: + legacy data-no-instant (instant.page) для мигрировавших сайтов
    if ('noPrefetch' in a.dataset || 'prefetchNo' in a.dataset || 'noInstant' in a.dataset) return false

    // Белый список
    if (whitelist && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false

    // Протокол
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false
    if (a.protocol === 'http:' && location.protocol === 'https:') return false

    // Внешние ссылки
    if (a.origin !== location.origin) {
      if (!allowExternal && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false
      // v1.1.1: убрано ограничение chromiumVer — Firefox и Safari тоже поддерживают cross-origin prefetch
    }

    // Query string
    if (a.search && !allowQuery && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false

    // Якорь на той же странице
    // v1.1.4: + проверка origin - внешняя ссылка с совпадающим path+search не якорь этой страницы
    if (a.hash && a.origin === location.origin && a.pathname + a.search === location.pathname + location.search) return false

    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var key = a.origin + a.pathname + a.search;
    if (key === currentKey) return false

    // Уже загружено
    if (preloaded.has(key)) return false

    if (!checkPlatform(a)) return false
    if (!checkAnalytics(a)) return false

    return true
  }

  function checkPlatform(a) {
    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var pathname = a.pathname || '';
    var hash = a.hash || '';

    if (platform === 'bitrix' || platform === 'bitrix24') {
      // v1.1.3: проверяем pathname и search вместо href (точнее, без ложных срабатываний на домене)
      if (pathname.indexOf('/bitrix/') !== -1 || (a.search && a.search.indexOf('sessid=') !== -1)) return false
      if (a.classList.contains('bx-ajax')) return false
    }

    if (platform === 'tilda') {
      // Можно проверять и по href, но hash надёжнее/дешевле
      if (hash.indexOf('#popup:') !== -1 || hash.indexOf('#rec') !== -1) return false
    }

    // v1.0.9: все опасные пути проверяем по сегментам pathname, не по подстроке href
    // v1.0.11: regex вынесены в верхний scope (perf)
    if (DANGEROUS_PATH_RE.test(pathname)) return false
    // v1.0.11: проверяем расширение по pathname (href может содержать #hash)
    if (FILE_EXT_RE.test(pathname)) return false

    return true
  }

  function checkAnalytics(a) {
    var cls = a.className || '';

    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var host = a.hostname || '';

    if (cls.indexOf('ym-') !== -1) return false
    if (host === 'mc.yandex.ru' || host === 'metrika.yandex.ru') return false

    if (cls.indexOf('ga-') !== -1 || cls.indexOf('gtm-') !== -1) return false
    if (host === 'google-analytics.com' || host.endsWith('.google-analytics.com')) return false
    if (host === 'googletagmanager.com' || host.endsWith('.googletagmanager.com')) return false

    if (cls.indexOf('piwik') !== -1 || cls.indexOf('matomo') !== -1) return false
    if (
      host === 'matomo.org' ||
      host.endsWith('.matomo.org') ||
      host === 'piwik.org' ||
      host.endsWith('.piwik.org')
    ) return false

    return true
  }

  function resolveSpecMode(a) {
    if (specMode === 'none') return 'none'
    if (specMode !== 'prerender') return specMode

    // specMode === 'prerender'
    if (prerenderAll) return 'prerender'
    if (whitelist) return 'prerender' // ссылки и так явно размечены

    // иначе prerender только по ссылке:
    if (a && a.dataset && (('prefetchPrerender' in a.dataset) || ('instantPrerender' in a.dataset))) {
      return 'prerender'
    }
    return 'prefetch'
  }

  // v1.1.4: принимает только <a> - все вызовы (включая публичный API, который создаёт
  // временный якорь) передают элемент; parseUrl и ветка произвольных строк удалены как недостижимые
  function preload(a) {
    if (disabled) return
    if (!isNetworkOk()) return
    if (!a || !a.origin) return

    var key = a.origin + a.pathname + a.search;
    var requestUrl = a.href.split('#')[0]; // убираем hash для запроса
    var isCrossOrigin = a.origin !== location.origin;

    if (preloaded.has(key)) return
    if (preloaded.size >= maxPreloads) {
      preloaded.delete(preloaded.values().next().value);
    }
    preloaded.add(key);

    var mode = resolveSpecMode(a);

    // v1.0.11: in-flight лимит — ставим в очередь если превышен
    // v1.1.4: чистый spec-путь не занимает сетевой слот - очередь только для fetch/link
    var usesNetwork = mode === 'none' || isCrossOrigin || specRulesFallback;
    if (usesNetwork && inFlight >= maxInFlight) {
      // v1.0.11: лимит очереди — отбрасываем новые при переполнении
      // v1.0.11: при drop удаляем ключ (иначе URL "навсегда" считается прогретым)
      if (queue.length >= maxQueue) { preloaded.delete(key); return }
      queue.push({ url: requestUrl, key: key, mode: mode, crossOrigin: isCrossOrigin });
      return
    }

    doPreload(requestUrl, key, mode, isCrossOrigin);
  }

  // v1.1.3: isCrossOrigin передаётся через цепочку вызовов (без повторного new URL())
  function doPreload(requestUrl, key, mode, isCrossOrigin) {
    // v1.1.4: cross-origin всегда мимо Speculation Rules: requires
    // anonymous-client-ip-when-cross-origin выполним только через private prefetch proxy
    // (фактически недоступен), и браузер молча игнорирует таких кандидатов
    if (mode !== 'none' && !isCrossOrigin) {
      preloadSpec(requestUrl, key, mode);
      // По умолчанию fallback отключён для избежания двойного трафика;
      // v1.1.4: ошибки вставки правил обрабатываются внутри flushSpecBuffer, а не здесь
      if (!specRulesFallback) return
    }

    // v1.1.1: cross-origin всегда через fetch (no-cors), <link crossorigin=anonymous> требует CORS
    if (isIOS || !supportsLinkPrefetch || isCrossOrigin) preloadFetch(requestUrl, key, isCrossOrigin);
    else preloadLink(requestUrl, key, isCrossOrigin);
  }

  function processQueue() {
    while (queue.length > 0 && inFlight < maxInFlight) {
      var item = queue.shift();
      doPreload(item.url, item.key, item.mode, item.crossOrigin);
    }
  }

  function preloadSpec(url, key, mode) {
    // v1.0.13: буферизуем URL — вставляем одним JSON за idle tick
    // v1.1.4: храним {url, key} - key нужен для fallback при ошибке вставки правил
    if (mode === 'prerender') {
      specBuffer.prerender.push({ url: url, key: key });
    } else {
      specBuffer.prefetch.push({ url: url, key: key });
    }

    // Планируем flush если ещё не запланирован
    if (!specFlushTimer) {
      specFlushTimer = scheduleIdle(flushSpecBuffer, 50);
    }
  }

  function pluckUrls(items) {
    var urls = [];
    for (var i = 0; i < items.length; i++) urls.push(items[i].url);
    return urls
  }

  // v1.0.13: вставляем все накопленные URL одним JSON
  function flushSpecBuffer() {
    specFlushTimer = 0;

    // v1.0.13: проверяем disabled (flush может быть вызван после destroy())
    if (disabled) return

    var head = document.head;
    if (!head) return

    var prefetchItems = specBuffer.prefetch;
    var prerenderItems = specBuffer.prerender;
    if (!prefetchItems.length && !prerenderItems.length) return
    specBuffer.prefetch = [];
    specBuffer.prerender = [];

    var rules = {};
    if (prefetchItems.length) rules.prefetch = [{ source: 'list', urls: pluckUrls(prefetchItems) }];
    if (prerenderItems.length) rules.prerender = [{ source: 'list', urls: pluckUrls(prerenderItems) }];

    try {
      var s = document.createElement('script');
      s.type = 'speculationrules';
      if (scriptNonce) s.nonce = scriptNonce;
      s.textContent = JSON.stringify(rules);
      head.appendChild(s);
      // v1.1.4: скрипт ОСТАЁТСЯ в DOM: правила привязаны к присутствию элемента, обработка
      // асинхронна, и немедленное удаление (поведение v1.0.11) отменяло предзагрузку -
      // режим specrules фактически не работал. Удаляем только в destroy()
      specScripts.push(s);
    } catch (e) {
      // v1.1.4: строгий CSP/Trusted Types заблокировал вставку - переходим на fetch/link.
      // При включённом specRulesFallback сеть уже задействована в doPreload - не дублируем.
      // Путь редкий и разовый, поэтому идём мимо inFlight-очереди
      if (specRulesFallback) return
      var items = prefetchItems.concat(prerenderItems);
      for (var i = 0; i < items.length; i++) {
        if (isIOS || !supportsLinkPrefetch) preloadFetch(items[i].url, items[i].key, false);
        else preloadLink(items[i].url, items[i].key, false);
      }
    }
  }

  function preloadLink(url, key, isCrossOrigin) {
    var head = document.head;
    // v1.0.10: если head недоступен, откатываем ключ
    if (!head) { preloaded.delete(key); return }

    inFlight++;

    var l = document.createElement('link');
    l.rel = 'prefetch';
    l.href = url;
    l.as = 'document';
    try { l.fetchPriority = 'low'; } catch (e) {}

    // v1.0.11: для cross-origin: referrerPolicy + crossOrigin
    if (isCrossOrigin) {
      l.referrerPolicy = 'no-referrer';
      l.crossOrigin = 'anonymous'; // не отправлять cookies на внешние домены
    }

    // v1.0.13: safety timeout — предохранитель если onload/onerror не сработают
    // (экзотические браузеры, сетевые ошибки без событий)
    var safetyTimer = setTimeout(function () {
      safetyTimer = 0;
      // v1.0.13: при safety timeout считаем попытку неуспешной — удаляем key
      preloaded.delete(key);
      cleanup();
    }, 30000);

    function cleanup() {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }
      l.onload = l.onerror = null;
      if (l.parentNode) l.parentNode.removeChild(l);
      inFlight--;
      processQueue();
    }

    l.onload = cleanup;
    l.onerror = function () { preloaded.delete(key); cleanup(); };
    head.appendChild(l);
  }

  function preloadFetch(url, key, isCrossOrigin) {
    // v1.0.10: если fetch недоступен, откатываем ключ
    if (typeof fetch !== 'function') { preloaded.delete(key); return }

    inFlight++;

    // v1.0.11: settled флаг — защита от двойного вызова done() при abort+catch
    var settled = false;
    var ctrl = null;
    var tid = 0;

    function done(success) {
      if (settled) return
      settled = true;

      if (tid) clearTimeout(tid);
      // v1.0.13: удаляем контроллер из активных
      if (ctrl) activeControllers.delete(ctrl);
      if (!success) preloaded.delete(key);
      inFlight--;
      processQueue();
    }

    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      // v1.0.13: добавляем в Set для возможности abort при destroy()
      activeControllers.add(ctrl);
      tid = setTimeout(function () {
        try { ctrl.abort(); } catch (e) {}
        done(false);
      }, 5000);
    }

    var opts = {
      method: 'GET',
      cache: 'force-cache',
      // v1.0.13: для cross-origin: omit credentials, no-referrer (избегаем CORS preflight и утечки referrer)
      credentials: isCrossOrigin ? 'omit' : 'same-origin',
      // v1.1.1: для cross-origin используем no-cors mode (opaque response, но кэш прогревается)
      mode: isCrossOrigin ? 'no-cors' : 'cors'
    };

    // v1.1.1: headers только для same-origin (no-cors не позволяет кастомные headers)
    if (!isCrossOrigin) {
      opts.headers = {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Purpose: 'prefetch'
      };
    }

    // v1.0.13: referrerPolicy для cross-origin (приватность)
    if (isCrossOrigin) {
      opts.referrerPolicy = 'no-referrer';
    }

    if (ctrl) opts.signal = ctrl.signal;

    try {
      fetch(url, opts)
        .then(function (r) {
          // v1.1.1: для no-cors mode response.type === 'opaque', r.ok === false, но кэш прогрет
          // v1.0.12: 304 Not Modified тоже считаем успехом
          var ok = r && (r.ok || r.status === 304 || r.type === 'opaque');
          // v1.1.4: same-origin: слот inFlight занят до полной загрузки тела, а не до заголовков
          // (иначе лимит "4 параллельных" ограничивал только фазу заголовков). Заголовки пришли -
          // 5s-таймер заменяем на щадящий 30s для тела. Opaque-ответ читать нельзя,
          // поэтому для cross-origin учёт остаётся по заголовкам
          if (ok && !isCrossOrigin && typeof r.arrayBuffer === 'function') {
            if (tid) {
              clearTimeout(tid);
              tid = setTimeout(function () {
                try { if (ctrl) ctrl.abort(); } catch (e) {}
                done(false);
              }, 30000);
            }
            r.arrayBuffer().then(
              function () { done(true); },
              function () { done(false); }
            );
            return
          }
          done(ok);
        })
        .catch(function () {
          done(false);
        });
    } catch (e) {
      done(false);
    }
  }

  // Viewport Observer
  var vpObserver = null;

  function startViewportObserver() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return
    if (vpObserver) return
    vpObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            vpObserver.unobserve(entry.target);
            if (canPreload(entry.target)) preload(entry.target);
          }
        });
      },
      { rootMargin: isMobile ? '100px' : '200px' }
    );
    observeLinks();
  }

  function observeLinks() {
    if (!vpObserver) return
    document.querySelectorAll('a').forEach(function (a) {
      if (canPreload(a)) vpObserver.observe(a);
    });
  }

  // Mutation Observer
  var mutObserver = null;

  function startMutationObserver() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return
    if (mutObserver) return
    mutObserver = new MutationObserver(function (muts) {
      if (!vpObserver) return
      // v1.1.3: собираем только новые ссылки из addedNodes (не пересканируем весь DOM)
      var pending = [];
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.nodeType !== 1) continue
          if (n.tagName === 'A') {
            pending.push(n);
          } else if (n.querySelectorAll) {
            var links = n.querySelectorAll('a');
            for (var k = 0; k < links.length; k++) pending.push(links[k]);
          }
        }
      }
      // v1.1.3: обрабатываем через rIC чтобы не блокировать UI при массовых вставках DOM
      if (pending.length > 0) {
        scheduleIdle(function () {
          for (var i = 0; i < pending.length; i++) {
            if (vpObserver && canPreload(pending[i])) vpObserver.observe(pending[i]);
          }
        });
      }
    });
    mutObserver.observe(document.body, { childList: true, subtree: true });
  }

  // v1.0.11: валидация URL для публичного API (усилена)
  function isValidPrefetchUrl(url) {
    if (!url || typeof url !== 'string') return false
    url = url.trim(); // v1.0.11: trim для защиты от ' javascript:...'
    if (!url) return false
    // v1.0.11: блокируем protocol-relative URLs (//evil.com)
    if (/^\/\//.test(url)) return false
    // Блокируем опасные протоколы
    if (/^(javascript|data|vbscript|file):/i.test(url)) return false
    // Разрешаем только http(s) или относительные URL
    if (!/^https?:\/\//i.test(url) && !/^\//.test(url) && !/^\./.test(url)) {
      // Проверяем, что это не протокол
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
    }
    return true
  }

  // v1.0.11: destroy() — отключает библиотеку, снимает обработчики
  function destroy() {
    disabled = true;
    queue.length = 0;

    // v1.0.13: очищаем touch-таймер и слушатели отмены
    resetTouch();

    // v1.0.13: прерываем все активные fetch-запросы
    activeControllers.forEach(function (ctrl) {
      try { ctrl.abort(); } catch (e) {}
    });
    activeControllers.clear();

    // v1.0.13: отменяем отложенный flush Speculation Rules
    if (specFlushTimer) {
      cancelIdle(specFlushTimer);
      specFlushTimer = 0;
    }
    // Очищаем буфер
    specBuffer.prefetch.length = specBuffer.prerender.length = 0;

    // v1.1.4: удаляем вставленные speculationrules-скрипты (это отменяет их правила)
    for (var i = 0; i < specScripts.length; i++) {
      if (specScripts[i] && specScripts[i].parentNode) {
        specScripts[i].parentNode.removeChild(specScripts[i]);
      }
    }
    specScripts.length = 0;

    var opts = { capture: true, passive: true };
    document.removeEventListener('touchstart', onTouchStart, opts);
    document.removeEventListener('mouseover', onMouseOver, opts);
    document.removeEventListener('mousedown', onMouseDown, opts);
    // v1.1.4: снимаем ожидание DOMContentLoaded, если destroy() вызван до готовности DOM
    document.removeEventListener('DOMContentLoaded', setup);

    // v1.1.3: снимаем listener сети
    if (conn && typeof conn.removeEventListener === 'function') {
      conn.removeEventListener('change', onConnectionChange);
    }

    // v1.0.11: снимаем слушатели навигации
    window.removeEventListener('popstate', updateCurrentKey);
    window.removeEventListener('hashchange', updateCurrentKey);
    // v1.0.12: снимаем pageshow listener
    window.removeEventListener('pageshow', onPageShow);

    if (vpObserver) {
      vpObserver.disconnect();
      vpObserver = null;
    }
    if (mutObserver) {
      mutObserver.disconnect();
      mutObserver = null;
    }
  }

  // Публичный API
  var api = {
    __prefetchRu: true,
    version: '1.1.4',
    preload: function (url) {
      // v1.0.11: валидация URL + прогон через canPreload() (консистентность с авто-режимом)
      if (!isValidPrefetchUrl(url)) return
      // v1.0.11: создаём временный <a> для проверки через canPreload()
      var a = document.createElement('a');
      a.setAttribute('href', url.trim());
      // v1.1.4: явный вызов API выражает намерение - проставляем data-prefetch, иначе на сайтах
      // с whitelist, для внешних URL и query string вызов был тихим no-op. Опасные пути,
      // расширения файлов и аналитика по-прежнему фильтруются
      a.dataset.prefetch = '';
      if (!canPreload(a)) return
      preload(a);
    },
    destroy: destroy,
    // v1.0.11: публичный метод для ручного обновления currentKey (SPA)
    refresh: updateCurrentKey
  };

  return api
}

/**
 * ESM entry point for prefetch.ru
 * This file is bundled into prefetch.esm.js
 */

/**
 * Detect CSP nonce from the script tag that loaded this module.
 * ESM modules don't have document.currentScript, so we find by import.meta.url
 */
function detectNonceFromImportMeta(metaUrl) {
  try {
    if (!metaUrl) return null
    // script.src и import.meta.url обычно оба абсолютные → можно сравнивать напрямую
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (!s || !s.src) continue
      if (s.src === metaUrl) {
        var n = s.nonce || s.getAttribute('nonce') || null;
        if (n) return n
        break
      }
    }
  } catch (e) {}
  return null
}

// Guard от двойной инициализации
var Prefetch =
  (typeof window !== 'undefined' && window.PrefetchRu && window.PrefetchRu.__prefetchRu)
    ? window.PrefetchRu
    : (typeof window !== 'undefined' && window.Prefetch && window.Prefetch.__prefetchRu)
      ? window.Prefetch
      : createPrefetchCore({
          isBrowser: typeof window !== 'undefined',
          getNonce: function () {
            // ESM: nonce через import.meta.url
            var nonce = detectNonceFromImportMeta(import.meta.url);
            if (nonce) return nonce

            // fallback: на случай окружений, где currentScript всё же доступен
            try {
              var cs = document.currentScript;
              if (cs && cs.nonce) return cs.nonce
            } catch (e) {}
            return null
          }
        });

// Регистрируем в window (для совместимости)
if (typeof window !== 'undefined') {
  window.PrefetchRu = Prefetch;
  if (!window.Prefetch) window.Prefetch = Prefetch;
}

export { Prefetch, Prefetch as default };
