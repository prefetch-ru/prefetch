/**
 * IIFE entry point for prefetch.ru
 * This file is bundled into prefetch.js
 * Rollup wraps this in an IIFE
 */
import { createPrefetchCore } from './core.js'

// Guard от двойной инициализации (проверяем PrefetchRu первым)
if (!(window.PrefetchRu && window.PrefetchRu.__prefetchRu) && 
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
