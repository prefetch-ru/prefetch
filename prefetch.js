/*!
 * prefetch.ru v1.0.5 - Мгновенная загрузка страниц
 * © 2026 Сергей Макаров | MIT License
 * https://prefetch.ru | https://github.com/prefetch-ru
 */
;(function () {
  'use strict'

  // Состояние
  var preloaded = new Set()
  var hoverTimers = new WeakMap()

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
  var prerenderAll = false

  var mousedownMode = false
  var viewportMode = false
  var observeDom = false

  // Инициализация
  ;(function init() {
    // CSP nonce (если скрипт подключён с nonce)
    try {
      var cs = document.currentScript
      if (cs && cs.nonce) scriptNonce = cs.nonce
    } catch (e) {}

    // rel=prefetch support
    try {
      var l = document.createElement('link')
      if (l.relList && typeof l.relList.supports === 'function') {
        supportsLinkPrefetch = l.relList.supports('prefetch')
      }
    } catch (e) {}

    var ua = navigator.userAgent

    // Определяем устройство
    isIOS =
      /iPad|iPhone/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    var isAndroid = /Android/.test(ua)
    isMobile = (isIOS || isAndroid) && Math.min(screen.width, screen.height) < 768
    if (isMobile) maxPreloads = 20

    // Chromium версия (для внешних ссылок)
    var cm = ua.match(/Chrome\/(\d+)/)
    if (cm) chromiumVer = parseInt(cm[1], 10)

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
    var body = document.body
    if (!body) return

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
    if (!isIOS && hasSr && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      var sr = ds.prefetchSpecrules || ds.instantSpecrules
      if (sr === 'prerender') {
        specMode = 'prerender'
        useSpecRules = true
      } else if (sr !== 'no') {
        specMode = 'prefetch'
        useSpecRules = true
      }
    }

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
    observeDom = 'prefetchObserveDom' in ds
    if (!observeDom && (platform === 'bitrix' || platform === 'tilda')) {
      observeDom = true
    }

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
    if (viewportMode) {
      var rIC = window.requestIdleCallback || function (cb) { setTimeout(cb, 1) }
      rIC(startViewportObserver, { timeout: 1500 })
    }

    // Mutation observer
    if (observeDom) startMutationObserver()
  }

  function detectPlatform() {
    if (typeof window.BX !== 'undefined') return 'bitrix'
    if (typeof window.B24 !== 'undefined' || typeof window.BX24 !== 'undefined') return 'bitrix24'
    if (document.querySelector('.t-records') || typeof window.Tilda !== 'undefined') return 'tilda'
    return null
  }

  function isNetworkOk() {
    if (saveData) return false
    if (connType === 'slow-2g' || connType === '2g') return false
    return true
  }

  function getAnchorFromEventTarget(t) {
    if (!t) return null
    if (t.nodeType && t.nodeType !== 1) t = t.parentElement
    if (!t || typeof t.closest !== 'function') return null
    return t.closest('a')
  }

  function onTouchStart(e) {
    lastTouchTime = e.timeStamp || Date.now()

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
    if (lastTouchTime && e.timeStamp && e.timeStamp - lastTouchTime < 2500) return

    var a = getAnchorFromEventTarget(e.target)
    if (!canPreload(a)) return

    a.addEventListener('mouseout', onMouseOut, { passive: true, once: true })

    var t = setTimeout(function () {
      preload(a.href, a)
      hoverTimers.delete(a)
    }, hoverDelay)
    hoverTimers.set(a, t)
  }

  function onMouseOut(e) {
    var a = getAnchorFromEventTarget(e.target)
    if (!a) return
    if (e.relatedTarget && e.relatedTarget.closest && a === e.relatedTarget.closest('a')) return

    var t = hoverTimers.get(a)
    if (t) {
      clearTimeout(t)
      hoverTimers.delete(a)
    }
  }

  function onMouseDown(e) {
    if (typeof e.button === 'number' && e.button === 2) return
    if (lastTouchTime && e.timeStamp && e.timeStamp - lastTouchTime < 2500) return

    var a = getAnchorFromEventTarget(e.target)
    if (canPreload(a)) preload(a.href, a)
  }

  function canPreload(a) {
    if (!a || !a.href) return false

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

    // Уже загружено (ключ НЕ модифицирует реальный URL запроса!)
    var key = urlKey(a.href)
    if (preloaded.has(key)) return false

    if (!checkPlatform(a)) return false
    if (!checkAnalytics(a)) return false

    return true
  }

  function checkPlatform(a) {
    var href = a.href

    if (platform === 'bitrix' || platform === 'bitrix24') {
      if (href.indexOf('/bitrix/') !== -1 || href.indexOf('sessid=') !== -1) return false
      if (a.classList.contains('bx-ajax')) return false
    }

    if (platform === 'tilda') {
      if (href.indexOf('#popup:') !== -1 || href.indexOf('#rec') !== -1) return false
    }

    if (
      href.indexOf('/login') !== -1 ||
      href.indexOf('/logout') !== -1 ||
      href.indexOf('/auth') !== -1 ||
      href.indexOf('/register') !== -1 ||
      href.indexOf('/cart') !== -1 ||
      href.indexOf('/basket') !== -1 ||
      href.indexOf('/add') !== -1 ||
      href.indexOf('/delete') !== -1 ||
      href.indexOf('/remove') !== -1
    ) return false

    if (/\.(pdf|doc|docx|xls|xlsx|zip|rar|exe)($|\?)/.test(href)) return false

    return true
  }

  function checkAnalytics(a) {
    var href = a.href
    var cls = a.className || ''

    // Извлекаем hostname для проверки доменов аналитики
    var host = ''
    try { host = new URL(href, location.href).hostname } catch (e) { host = '' }

    if (cls.indexOf('ym-') !== -1) return false
    if (host === 'mc.yandex.ru' || host === 'metrika.yandex.ru') return false

    if (cls.indexOf('ga-') !== -1 || cls.indexOf('gtm-') !== -1) return false
    if (host === 'google-analytics.com' || host.endsWith('.google-analytics.com')) return false
    if (host === 'googletagmanager.com' || host.endsWith('.googletagmanager.com')) return false

    if (cls.indexOf('piwik') !== -1 || cls.indexOf('matomo') !== -1) return false
    if (host === 'matomo.org' || host.endsWith('.matomo.org') || host === 'piwik.org' || host.endsWith('.piwik.org')) return false

    return true
  }

  // Ключ для дедупликации: НЕ трогаем pathname (включая / на конце), только убираем hash
  function urlKey(url) {
    try {
      var u = new URL(url, location.href)
      return u.origin + u.pathname + u.search
    } catch (e) {
      return url
    }
  }

  // URL для реального запроса: абсолютный, без hash, без "улучшений"
  function urlForRequest(url) {
    try {
      var u = new URL(url, location.href)
      u.hash = ''
      return u.href
    } catch (e) {
      return url
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
    if (!isNetworkOk()) return

    var requestUrl = urlForRequest(url)
    var key = urlKey(requestUrl)

    if (preloaded.has(key)) return
    if (preloaded.size >= maxPreloads) {
      preloaded.delete(preloaded.values().next().value)
    }
    preloaded.add(key)

    var mode = resolveSpecMode(a)

    if (mode !== 'none') {
      preloadSpec(requestUrl, mode)

      // Страховка: обычный prefetch (чтобы под CSP/ограничениями SpecRules всё равно грелся кэш)
      if (isIOS || !supportsLinkPrefetch) preloadFetch(requestUrl, key)
      else preloadLink(requestUrl, key)
      return
    }

    if (isIOS || !supportsLinkPrefetch) preloadFetch(requestUrl, key)
    else preloadLink(requestUrl, key)
  }

  function preloadSpec(url, mode) {
    var head = document.head
    if (!head) return

    var s = document.createElement('script')
    s.type = 'speculationrules'
    if (scriptNonce) s.nonce = scriptNonce

    var rules = {}
    rules[mode] = [{ source: 'list', urls: [url] }]
    s.textContent = JSON.stringify(rules)
    head.appendChild(s)
  }

  function preloadLink(url, key) {
    var head = document.head
    if (!head) return

    var l = document.createElement('link')
    l.rel = 'prefetch'
    l.href = url
    l.as = 'document'
    try { l.fetchPriority = 'low' } catch (e) {}

    l.onerror = function () { preloaded.delete(key) }
    head.appendChild(l)
  }

  function preloadFetch(url, key) {
    if (typeof fetch !== 'function') return

    var ctrl = null
    var tid = 0

    if (typeof AbortController !== 'undefined') {
      ctrl = new AbortController()
      tid = setTimeout(function () {
        try { ctrl.abort() } catch (e) {}
      }, 5000)
    }

    var opts = {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'force-cache',
      headers: { Purpose: 'prefetch' }
    }
    if (ctrl) opts.signal = ctrl.signal

    try {
      fetch(url, opts)
        .then(function (r) {
          if (tid) clearTimeout(tid)
          if (!r || !r.ok) preloaded.delete(key)
        })
        .catch(function () {
          if (tid) clearTimeout(tid)
          preloaded.delete(key)
        })
    } catch (e) {
      if (tid) clearTimeout(tid)
      preloaded.delete(key)
    }
  }

  // Viewport Observer
  var vpObserver = null

  function startViewportObserver() {
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
    if (mutObserver) return
    mutObserver = new MutationObserver(function (muts) {
      var hasLinks = muts.some(function (m) {
        return Array.from(m.addedNodes).some(function (n) {
          return (
            n.nodeType === 1 &&
            (n.tagName === 'A' || (n.querySelectorAll && n.querySelectorAll('a').length))
          )
        })
      })
      if (hasLinks && vpObserver) {
        clearTimeout(mutTimer)
        mutTimer = setTimeout(observeLinks, 100)
      }
    })
    mutObserver.observe(document.body, { childList: true, subtree: true })
  }

  // Минимальный публичный API
  window.Prefetch = {
    version: '1.0.5',
    preload: function (url) { preload(url) }
  }
})()
