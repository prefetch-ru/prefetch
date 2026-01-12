/**
 * ESM entry point for prefetch.ru
 * This file is bundled into prefetch.esm.js
 */
import { createPrefetchCore } from './core.js'

/**
 * Detect CSP nonce from the script tag that loaded this module.
 * ESM modules don't have document.currentScript, so we find by import.meta.url
 */
function detectNonceFromImportMeta(metaUrl) {
  try {
    if (!metaUrl) return null
    // script.src и import.meta.url обычно оба абсолютные → можно сравнивать напрямую
    var scripts = document.getElementsByTagName('script')
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i]
      if (!s || !s.src) continue
      if (s.src === metaUrl) {
        var n = s.nonce || s.getAttribute('nonce') || null
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
            var nonce = detectNonceFromImportMeta(import.meta.url)
            if (nonce) return nonce

            // fallback: на случай окружений, где currentScript всё же доступен
            try {
              var cs = document.currentScript
              if (cs && cs.nonce) return cs.nonce
            } catch (e) {}
            return null
          }
        })

// Регистрируем в window (для совместимости)
if (typeof window !== 'undefined') {
  window.PrefetchRu = Prefetch
  if (!window.Prefetch) window.Prefetch = Prefetch
}

export { Prefetch }
export default Prefetch
