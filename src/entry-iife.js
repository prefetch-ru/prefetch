/**
 * IIFE entry point for prefetch.ru
 * This file is bundled into prefetch.js
 * Rollup wraps this in an IIFE
 */
import { createPrefetchCore } from './core.js'

// Guard от двойной инициализации (проверяем PrefetchRu первым)
// v1.1.4: + guard окружения - main/exports.require в package.json указывают на эту сборку,
// и require() в Node/SSR падал с ReferenceError ещё до SSR-guard внутри core.js
if (typeof window !== 'undefined' && typeof document !== 'undefined' &&
    !(window.PrefetchRu && window.PrefetchRu.__prefetchRu) &&
    !(window.Prefetch && window.Prefetch.__prefetchRu)) {

  var api = createPrefetchCore({
    isBrowser: true,
    getNonce: function () {
      // IIFE: nonce доступен через document.currentScript
      try {
        var cs = document.currentScript
        if (cs && cs.nonce) return cs.nonce
      } catch (e) {}
      return null
    }
  })

  // Регистрируем в window
  window.PrefetchRu = api
  if (!window.Prefetch) window.Prefetch = api
}
