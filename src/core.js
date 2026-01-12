/**
 * Core prefetch logic - shared between IIFE and ESM builds.
 * @param {Object} options
 * @param {function(): string|null} options.getNonce - Function to get CSP nonce
 * @param {boolean} options.isBrowser - Whether running in browser environment
 * @returns {Object} Prefetch API
 */
export function createPrefetchCore(options) {
  'use strict'

  var getNonce = options && options.getNonce
  var isBrowser = options ? options.isBrowser : true

  // SSR/Non-browser guard
  if (!isBrowser || typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      __prefetchRu: true,
      version: '__VERSION__',
      preload: function () {},
      destroy: function () {},
      refresh: function () {}
    }
  }

  // Состояние
  var preloaded = new Set()
  var hoverTimers = new WeakMap()
  var disabled = false

  // v1.0.11: in-flight лимит (макс. параллельных запросов)
  var inFlight = 0
  var maxInFlight = 4
  var queue = []
  var maxQueue = 50 // v1.0.11: лимит очереди (защита от переполнения)

  // v1.0.13: Set активных AbortController для корректного destroy()
  var activeControllers = new Set()

  // v1.0.13: буфер для Speculation Rules (группируем URL и вставляем одним JSON)
  var specBuffer = { prefetch: [], prerender: [], crossOrigin: [] }
  var specFlushTimer = 0

  // v1.0.11: кэш ключа текущей страницы (избегаем new URL() в горячих местах)
  var currentKey = ''

  var lastTouchTime = 0
  var touchTimer = 0
  var touchCancel = null

  var isMobile = false
  var isIOS = false
  var chromiumVer = null
  var platform = null
  var saveData = false
  var connType = null

  // CSP / поддержка
  var scriptNonce = null
  var supportsLinkPrefetch = false

  // Настройки
  var hoverDelay = 65
  var touchDelay = 80
  var maxPreloads = 50
  var allowQuery = false
  var allowExternal = false
  var whitelist = false

  var useSpecRules = false
  var specMode = 'none' // 'none' | 'prefetch' | 'prerender'
  var specRulesFallback = false // v1.0.11: fallback при SpecRules (по умолчанию отключён)
  var prerenderAll = false

  var mousedownMode = false
  var viewportMode = false
  var observeDom = false

  // v1.0.11: regex вынесены в верхний scope (perf — не создавать на каждый вызов)
  var DANGEROUS_PATH_RE = /(^|\/)(login|logout|auth|register|cart|basket|add|delete|remove)(\/|$|\.)/i
  var FILE_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|zip|rar|exe)($|\?)/i

  // Инициализация
  ;(function init() {
    // CSP nonce через переданную функцию
    if (getNonce) {
      try {
        scriptNonce = getNonce()
      } catch (e) {}
    }

    // rel=prefetch support
    try {
      var l = document.createElement('link')
      if (l.relList && typeof l.relList.supports === 'function') {
        supportsLinkPrefetch = l.relList.supports('prefetch')
      }
    } catch (e) {}

    var ua = navigator.userAgent
    var uaData = navigator.userAgentData // v1.0.12: UA-CH API (более надёжно в долгосрочной перспективе)

    // Определяем устройство
    // v1.0.12: используем userAgentData если доступен, иначе fallback на UA
    if (uaData) {
      // UA-CH API: https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData
      isIOS = false // UA-CH пока не поддерживается на iOS
      var isAndroid = uaData.platform === 'Android'
      isMobile = uaData.mobile || false
      // Chromium версия через brands
      var brands = uaData.brands || []
      for (var i = 0; i < brands.length; i++) {
        var b = brands[i]
        if (b.brand === 'Chromium' || b.brand === 'Google Chrome') {
          chromiumVer = parseInt(b.version, 10)
          break
        }
      }
    } else {
      // Fallback на традиционный UA sniffing
      isIOS =
        /iPad|iPhone/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      var isAndroid = /Android/.test(ua)
      isMobile = (isIOS || isAndroid) && Math.min(screen.width, screen.height) < 768
      // Chromium версия из UA
      var cm = ua.match(/Chrome\/(\d+)/)
      if (cm) chromiumVer = parseInt(cm[1], 10)
    }
    if (isMobile) maxPreloads = 20

    // Сеть
    var conn = navigator.connection
    if (conn) {
      connType = conn.effectiveType
      saveData = conn.saveData || false
    }

    // Ждём DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setup)
    } else {
      setup()
    }
  })()

  function setup() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return

    var body = document.body
    if (!body) return

    // v1.0.11: кэшируем ключ текущей страницы
    currentKey = location.origin + location.pathname + location.search

    platform = detectPlatform()

    // Читаем конфигурацию
    var ds = body.dataset
    allowQuery = 'prefetchAllowQueryString' in ds || 'instantAllowQueryString' in ds
    allowExternal = 'prefetchAllowExternalLinks' in ds || 'instantAllowExternalLinks' in ds
    whitelist = 'prefetchWhitelist' in ds || 'instantWhitelist' in ds

    // CSP nonce override через data-*
    // <body data-prefetch-nonce="...">
    if (ds.prefetchNonce) scriptNonce = ds.prefetchNonce
    if (!scriptNonce && ds.instantNonce) scriptNonce = ds.instantNonce

    // Speculation Rules — opt-in по наличию атрибута:
    // <body data-prefetch-specrules> (prefetch)
    // <body data-prefetch-specrules="prerender">
    // <body data-prefetch-specrules="no">
    var hasSr = 'prefetchSpecrules' in ds || 'instantSpecrules' in ds
    if (
      !isIOS &&
      hasSr &&
      HTMLScriptElement.supports &&
      HTMLScriptElement.supports('speculationrules')
    ) {
      var sr = ds.prefetchSpecrules || ds.instantSpecrules
      if (sr === 'prerender') {
        specMode = 'prerender'
        useSpecRules = true
      } else if (sr !== 'no') {
        specMode = 'prefetch'
        useSpecRules = true
      }
    }

    // v1.0.11: fallback при Speculation Rules (по умолчанию отключён для избежания двойного трафика)
    // <body data-prefetch-specrules-fallback>
    specRulesFallback = 'prefetchSpecrulesFallback' in ds || 'instantSpecrulesFallback' in ds

    // Разрешить "глобальный" prerender без whitelist (не рекомендуется, но бывает нужно)
    // <body data-prefetch-prerender-all>
    prerenderAll = 'prefetchPrerenderAll' in ds || 'instantPrerenderAll' in ds

    // Интенсивность
    var intensity = ds.prefetchIntensity || ds.instantIntensity
    if (intensity === 'mousedown') {
      mousedownMode = true
    } else if (intensity === 'viewport' || intensity === 'viewport-all') {
      if (intensity === 'viewport-all' || (isMobile && isNetworkOk())) {
        viewportMode = true
      }
    } else if (intensity) {
      var d = parseInt(intensity, 10)
      if (!isNaN(d) && d >= 0) hoverDelay = d
    }

    // На мобильных делаем touch-предзагрузку менее агрессивной
    if (isMobile) {
      touchDelay = Math.max(60, Math.min(hoverDelay || 0, 150))
    }

    // DOM observer для SPA
    // v1.0.11: добавлен алиас instantObserveDom
    observeDom = 'prefetchObserveDom' in ds || 'instantObserveDom' in ds
    if (!observeDom && (platform === 'bitrix' || platform === 'tilda')) {
      observeDom = true
    }

    // v1.0.11: обновляем currentKey при навигации (pushState, popstate, hashchange)
    window.addEventListener('popstate', updateCurrentKey)
    window.addEventListener('hashchange', updateCurrentKey)
    // v1.0.12: pageshow для bfcache restore (popstate не всегда срабатывает при возврате из bfcache)
    window.addEventListener('pageshow', onPageShow)

    // Tilda — увеличиваем задержку из-за popup-ов
    if (platform === 'tilda' && hoverDelay < 100) hoverDelay = 100

    // События
    var opts = { capture: true, passive: true }
    document.addEventListener('touchstart', onTouchStart, opts)
    if (!mousedownMode) {
      document.addEventListener('mouseover', onMouseOver, opts)
    } else {
      document.addEventListener('mousedown', onMouseDown, opts)
    }

    // Viewport observer
    // v1.0.10: feature-detection — если IntersectionObserver недоступен, отключаем viewport режим
    if (viewportMode && typeof IntersectionObserver === 'undefined') viewportMode = false

    if (viewportMode) {
      var rIC = window.requestIdleCallback || function (cb) { setTimeout(cb, 1) }
      rIC(startViewportObserver, { timeout: 1500 })
    }

    // v1.0.9: MutationObserver нужен только для viewport режима (отслеживать новые ссылки)
    // v1.0.10: feature-detection — если MutationObserver недоступен, не запускаем
    if (observeDom && viewportMode && typeof MutationObserver !== 'undefined') startMutationObserver()
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

  // v1.0.11: обновление currentKey при навигации (SPA-гибриды, pushState)
  function updateCurrentKey() {
    currentKey = location.origin + location.pathname + location.search
  }

  // v1.0.12: pageshow для bfcache restore
  function onPageShow(e) {
    // persisted === true означает восстановление из bfcache
    if (e && e.persisted) {
      updateCurrentKey()
    }
  }

  function getAnchorFromEventTarget(t) {
    if (!t) return null
    if (t.nodeType && t.nodeType !== 1) t = t.parentElement
    if (!t || typeof t.closest !== 'function') return null
    return t.closest('a')
  }

  function onTouchStart(e) {
    // v1.0.11: защита от синтетических событий и disabled режим
    if (disabled) return
    if (e && e.isTrusted === false) return

    // v1.0.9: используем Date.now() для единой шкалы времени
    lastTouchTime = Date.now()

    var a = getAnchorFromEventTarget(e.target)
    if (!canPreload(a)) return

    // задержка + отмена на scroll/touchmove
    if (touchTimer) {
      clearTimeout(touchTimer)
      touchTimer = 0
    }
    if (touchCancel) {
      document.removeEventListener('touchmove', touchCancel, true)
      document.removeEventListener('scroll', touchCancel, true)
      touchCancel = null
    }

    var cancelled = false
    touchCancel = function () {
      cancelled = true
      if (touchTimer) {
        clearTimeout(touchTimer)
        touchTimer = 0
      }
      document.removeEventListener('touchmove', touchCancel, true)
      document.removeEventListener('scroll', touchCancel, true)
      touchCancel = null
    }

    document.addEventListener('touchmove', touchCancel, { capture: true, passive: true, once: true })
    document.addEventListener('scroll', touchCancel, { capture: true, passive: true, once: true })

    touchTimer = setTimeout(function () {
      if (touchCancel) {
        document.removeEventListener('touchmove', touchCancel, true)
        document.removeEventListener('scroll', touchCancel, true)
        touchCancel = null
      }
      touchTimer = 0
      if (!cancelled) preload(a.href, a)
    }, touchDelay)
  }

  function onMouseOver(e) {
    // v1.0.11: защита от синтетических событий и disabled режим
    if (disabled) return
    if (e && e.isTrusted === false) return

    // v1.0.9: единая шкала времени Date.now()
    if (lastTouchTime && Date.now() - lastTouchTime < 2500) return

    var a = getAnchorFromEventTarget(e.target)
    if (!a) return

    // v1.0.11: проверяем таймер ДО canPreload (perf — mouseover очень шумный)
    if (hoverTimers.has(a)) return

    if (!canPreload(a)) return

    // mouseleave не срабатывает при перемещении внутри ссылки (в отличие от mouseout)
    a.addEventListener('mouseleave', onMouseLeave, { passive: true, once: true })

    var t = setTimeout(function () {
      preload(a.href, a)
      hoverTimers.delete(a)
    }, hoverDelay)
    hoverTimers.set(a, t)
  }

  function onMouseLeave(e) {
    var a = e.currentTarget
    if (!a) return

    var t = hoverTimers.get(a)
    if (t) {
      clearTimeout(t)
      hoverTimers.delete(a)
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

    var a = getAnchorFromEventTarget(e.target)
    if (canPreload(a)) preload(a.href, a)
  }

  function canPreload(a) {
    if (!a) return false

    // v1.0.7: исключаем <a href=""> и <a> без href (часто используются как кнопки)
    var hrefAttr = a.getAttribute('href')
    if (hrefAttr === null || hrefAttr.trim() === '') return false

    if (!a.href) return false

    // Не навигация в текущей вкладке
    if (a.target && a.target !== '_self') return false
    if (a.hasAttribute('download')) return false

    // Явный запрет
    if ('noPrefetch' in a.dataset || 'prefetchNo' in a.dataset) return false

    // Белый список
    if (whitelist && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false

    // Протокол
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false
    if (a.protocol === 'http:' && location.protocol === 'https:') return false

    // Внешние ссылки
    if (a.origin !== location.origin) {
      if (!allowExternal && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false
      if (!chromiumVer) return false
    }

    // Query string
    if (a.search && !allowQuery && !('prefetch' in a.dataset) && !('instant' in a.dataset)) return false

    // Якорь на той же странице
    if (a.hash && a.pathname + a.search === location.pathname + location.search) return false

    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var key = a.origin + a.pathname + a.search
    if (key === currentKey) return false

    // Уже загружено
    if (preloaded.has(key)) return false

    if (!checkPlatform(a)) return false
    if (!checkAnalytics(a)) return false

    return true
  }

  function checkPlatform(a) {
    var href = a.href

    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var pathname = a.pathname || ''
    var hash = a.hash || ''

    if (platform === 'bitrix' || platform === 'bitrix24') {
      if (href.indexOf('/bitrix/') !== -1 || href.indexOf('sessid=') !== -1) return false
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
    var cls = a.className || ''

    // v1.0.11: используем свойства <a> напрямую вместо new URL() (perf)
    var host = a.hostname || ''

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

  // v1.0.12: объединённая функция — парсим URL один раз вместо двух
  // Возвращает { requestUrl, key } для preload()
  function parseUrl(url) {
    try {
      var u = new URL(url, location.href)
      var key = u.origin + u.pathname + u.search
      u.hash = ''
      return { requestUrl: u.href, key: key }
    } catch (e) {
      return { requestUrl: url, key: url }
    }
  }

  function resolveSpecMode(a) {
    if (!useSpecRules || specMode === 'none') return 'none'
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

  function preload(url, a) {
    if (disabled) return
    if (!isNetworkOk()) return

    // v1.0.12: парсим URL один раз вместо двух
    var parsed = parseUrl(url)
    var requestUrl = parsed.requestUrl
    var key = parsed.key

    if (preloaded.has(key)) return
    if (preloaded.size >= maxPreloads) {
      preloaded.delete(preloaded.values().next().value)
    }
    preloaded.add(key)

    var mode = resolveSpecMode(a)

    // v1.0.11: in-flight лимит — ставим в очередь если превышен
    if (inFlight >= maxInFlight) {
      // v1.0.11: лимит очереди — отбрасываем новые при переполнении
      // v1.0.11: при drop удаляем ключ (иначе URL "навсегда" считается прогретым)
      if (queue.length >= maxQueue) { preloaded.delete(key); return }
      queue.push({ url: requestUrl, key: key, mode: mode })
      return
    }

    doPreload(requestUrl, key, mode)
  }

  function doPreload(requestUrl, key, mode) {
    if (mode !== 'none') {
      // v1.0.11: try/catch для preloadSpec — при строгом CSP/Trusted Types может выбросить исключение
      var specOk = false
      try {
        preloadSpec(requestUrl, mode)
        specOk = true
      } catch (e) {
        // Ошибка в Speculation Rules — fallback обязателен
      }

      // v1.0.11: fallback только если явно включён ИЛИ если SpecRules не удался
      // По умолчанию fallback отключён для избежания двойного трафика
      if (specRulesFallback || !specOk) {
        if (isIOS || !supportsLinkPrefetch) preloadFetch(requestUrl, key)
        else preloadLink(requestUrl, key)
      }
      return
    }

    if (isIOS || !supportsLinkPrefetch) preloadFetch(requestUrl, key)
    else preloadLink(requestUrl, key)
  }

  function processQueue() {
    while (queue.length > 0 && inFlight < maxInFlight) {
      var item = queue.shift()
      doPreload(item.url, item.key, item.mode)
    }
  }

  function preloadSpec(url, mode) {
    // v1.0.13: для cross-origin проверяем и модифицируем правила
    var isCrossOrigin = false
    try {
      var u = new URL(url, location.href)
      isCrossOrigin = u.origin !== location.origin
    } catch (e) {}

    // v1.0.13: для cross-origin никогда не делаем prerender (только prefetch)
    if (isCrossOrigin && mode === 'prerender') {
      mode = 'prefetch'
    }

    // v1.0.13: буферизуем URL — вставляем одним JSON за idle tick
    if (isCrossOrigin) {
      specBuffer.crossOrigin.push(url)
    } else if (mode === 'prerender') {
      specBuffer.prerender.push(url)
    } else {
      specBuffer.prefetch.push(url)
    }

    // Планируем flush если ещё не запланирован
    if (!specFlushTimer) {
      var rIC = window.requestIdleCallback || function (cb) { setTimeout(cb, 1) }
      specFlushTimer = rIC(flushSpecBuffer, { timeout: 50 })
    }
  }

  // v1.0.13: вставляем все накопленные URL одним JSON
  function flushSpecBuffer() {
    specFlushTimer = 0

    // v1.0.13: проверяем disabled (flush может быть вызван после destroy())
    if (disabled) return

    var head = document.head
    if (!head) return

    var rules = {}

    // Same-origin prefetch
    if (specBuffer.prefetch.length > 0) {
      rules.prefetch = rules.prefetch || []
      rules.prefetch.push({ source: 'list', urls: specBuffer.prefetch.slice() })
      specBuffer.prefetch.length = 0
    }

    // Same-origin prerender
    if (specBuffer.prerender.length > 0) {
      rules.prerender = rules.prerender || []
      rules.prerender.push({ source: 'list', urls: specBuffer.prerender.slice() })
      specBuffer.prerender.length = 0
    }

    // Cross-origin (только prefetch, с privacy requirements)
    if (specBuffer.crossOrigin.length > 0) {
      rules.prefetch = rules.prefetch || []
      rules.prefetch.push({
        source: 'list',
        urls: specBuffer.crossOrigin.slice(),
        referrer_policy: 'no-referrer',
        requires: ['anonymous-client-ip-when-cross-origin']
      })
      specBuffer.crossOrigin.length = 0
    }

    // Если нет правил — выходим
    if (!rules.prefetch && !rules.prerender) return

    var s = document.createElement('script')
    s.type = 'speculationrules'
    if (scriptNonce) s.nonce = scriptNonce
    s.textContent = JSON.stringify(rules)
    head.appendChild(s)
    // v1.0.11: удаляем после вставки — браузер применяет правила на appendChild
    head.removeChild(s)
  }

  function preloadLink(url, key) {
    var head = document.head
    // v1.0.10: если head недоступен, откатываем ключ
    if (!head) { preloaded.delete(key); return }

    inFlight++

    var l = document.createElement('link')
    l.rel = 'prefetch'
    l.href = url
    l.as = 'document'
    try { l.fetchPriority = 'low' } catch (e) {}

    // v1.0.11: для cross-origin: referrerPolicy + crossOrigin
    try {
      var u = new URL(url, location.href)
      if (u.origin !== location.origin) {
        l.referrerPolicy = 'no-referrer'
        l.crossOrigin = 'anonymous' // не отправлять cookies на внешние домены
      }
    } catch (e) {}

    // v1.0.13: safety timeout — предохранитель если onload/onerror не сработают
    // (экзотические браузеры, сетевые ошибки без событий)
    var safetyTimer = setTimeout(function () {
      safetyTimer = 0
      // v1.0.13: при safety timeout считаем попытку неуспешной — удаляем key
      preloaded.delete(key)
      cleanup()
    }, 30000)

    function cleanup() {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0 }
      l.onload = l.onerror = null
      if (l.parentNode) l.parentNode.removeChild(l)
      inFlight--
      processQueue()
    }

    l.onload = cleanup
    l.onerror = function () { preloaded.delete(key); cleanup() }
    head.appendChild(l)
  }

  function preloadFetch(url, key) {
    // v1.0.10: если fetch недоступен, откатываем ключ
    if (typeof fetch !== 'function') { preloaded.delete(key); return }

    inFlight++

    // v1.0.11: settled флаг — защита от двойного вызова done() при abort+catch
    var settled = false
    var ctrl = null
    var tid = 0

    function done(success) {
      if (settled) return
      settled = true

      if (tid) clearTimeout(tid)
      // v1.0.13: удаляем контроллер из активных
      if (ctrl) activeControllers.delete(ctrl)
      if (!success) preloaded.delete(key)
      inFlight--
      processQueue()
    }

    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController()
      // v1.0.13: добавляем в Set для возможности abort при destroy()
      activeControllers.add(ctrl)
      tid = setTimeout(function () {
        try { ctrl.abort() } catch (e) {}
        done(false)
      }, 5000)
    }

    // v1.0.13: определяем cross-origin для корректных настроек fetch
    var isCrossOrigin = false
    try {
      isCrossOrigin = new URL(url, location.href).origin !== location.origin
    } catch (e) {}

    var opts = {
      method: 'GET',
      cache: 'force-cache',
      // v1.0.13: для cross-origin: omit credentials, no-referrer (избегаем CORS preflight и утечки referrer)
      credentials: isCrossOrigin ? 'omit' : 'same-origin',
      // v1.0.11: Accept header для корректного content negotiation
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }

    // v1.0.13: Purpose header только для same-origin (избегаем CORS preflight на cross-origin)
    if (!isCrossOrigin) {
      opts.headers.Purpose = 'prefetch'
    }

    // v1.0.13: referrerPolicy для cross-origin (приватность)
    if (isCrossOrigin) {
      opts.referrerPolicy = 'no-referrer'
    }

    if (ctrl) opts.signal = ctrl.signal

    try {
      fetch(url, opts)
        .then(function (r) {
          // v1.0.12: 304 Not Modified тоже считаем успехом (кэш прогрет)
          done(r && (r.ok || r.status === 304))
        })
        .catch(function () {
          done(false)
        })
    } catch (e) {
      done(false)
    }
  }

  // Viewport Observer
  var vpObserver = null

  function startViewportObserver() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return
    if (vpObserver) return
    vpObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            vpObserver.unobserve(entry.target)
            if (canPreload(entry.target)) preload(entry.target.href, entry.target)
          }
        })
      },
      { rootMargin: isMobile ? '100px' : '200px' }
    )
    observeLinks()
  }

  function observeLinks() {
    if (!vpObserver) return
    document.querySelectorAll('a').forEach(function (a) {
      if (canPreload(a)) vpObserver.observe(a)
    })
  }

  // Mutation Observer
  var mutObserver = null
  var mutTimer = null

  function startMutationObserver() {
    // v1.0.11: защита от вызова после destroy()
    if (disabled) return
    if (mutObserver) return
    mutObserver = new MutationObserver(function (muts) {
      // v1.0.13: оптимизация — обычный цикл вместо Array.from + querySelector вместо querySelectorAll
      var hasLinks = false
      outer: for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j]
          if (n.nodeType === 1) {
            if (n.tagName === 'A' || (n.querySelector && n.querySelector('a'))) {
              hasLinks = true
              break outer
            }
          }
        }
      }
      if (hasLinks && vpObserver) {
        clearTimeout(mutTimer)
        mutTimer = setTimeout(observeLinks, 100)
      }
    })
    mutObserver.observe(document.body, { childList: true, subtree: true })
  }

  // v1.0.11: валидация URL для публичного API (усилена)
  function isValidPrefetchUrl(url) {
    if (!url || typeof url !== 'string') return false
    url = url.trim() // v1.0.11: trim для защиты от ' javascript:...'
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
    disabled = true
    queue.length = 0

    // v1.0.13: очищаем touch-таймер
    if (touchTimer) {
      clearTimeout(touchTimer)
      touchTimer = 0
    }

    // v1.0.13: удаляем touchCancel listener если есть
    if (touchCancel) {
      document.removeEventListener('touchmove', touchCancel, true)
      document.removeEventListener('scroll', touchCancel, true)
      touchCancel = null
    }

    // v1.0.13: прерываем все активные fetch-запросы
    activeControllers.forEach(function (ctrl) {
      try { ctrl.abort() } catch (e) {}
    })
    activeControllers.clear()

    // v1.0.13: отменяем отложенный flush Speculation Rules
    if (specFlushTimer) {
      var cancelIC = window.cancelIdleCallback || clearTimeout
      cancelIC(specFlushTimer)
      specFlushTimer = 0
    }
    // Очищаем буфер
    specBuffer.prefetch.length = specBuffer.prerender.length = specBuffer.crossOrigin.length = 0

    var opts = { capture: true, passive: true }
    document.removeEventListener('touchstart', onTouchStart, opts)
    document.removeEventListener('mouseover', onMouseOver, opts)
    document.removeEventListener('mousedown', onMouseDown, opts)

    // v1.0.11: снимаем слушатели навигации
    window.removeEventListener('popstate', updateCurrentKey)
    window.removeEventListener('hashchange', updateCurrentKey)
    // v1.0.12: снимаем pageshow listener
    window.removeEventListener('pageshow', onPageShow)

    if (vpObserver) {
      vpObserver.disconnect()
      vpObserver = null
    }
    if (mutObserver) {
      mutObserver.disconnect()
      mutObserver = null
    }
  }

  // Публичный API
  var api = {
    __prefetchRu: true,
    version: '__VERSION__',
    preload: function (url) {
      // v1.0.11: валидация URL + прогон через canPreload() (консистентность с авто-режимом)
      if (!isValidPrefetchUrl(url)) return
      // v1.0.11: создаём временный <a> для проверки через canPreload()
      var a = document.createElement('a')
      a.setAttribute('href', url.trim())
      if (!canPreload(a)) return
      preload(a.href, a)
    },
    destroy: destroy,
    // v1.0.11: публичный метод для ручного обновления currentKey (SPA)
    refresh: updateCurrentKey
  }

  return api
}
