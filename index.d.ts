/*!
 * prefetch.ru - типы публичного API
 * MIT License | https://prefetch.ru
 */

export interface PrefetchApi {
  /** Метка экземпляра библиотеки (используется guard-ом от двойной инициализации) */
  readonly __prefetchRu: true
  /** Версия библиотеки, например "1.1.4" */
  readonly version: string
  /**
   * Ручная предзагрузка URL.
   * Проходит те же фильтры, что и автоматическая (опасные пути, расширения
   * файлов, аналитика); whitelist, внешние домены и query string при явном
   * вызове разрешены.
   */
  preload(url: string): void
  /** Отключает библиотеку: снимает обработчики, отменяет активные запросы */
  destroy(): void
  /** Обновляет ключ текущей страницы после SPA-навигации */
  refresh(): void
}

declare const Prefetch: PrefetchApi

export { Prefetch }
export default Prefetch

declare global {
  interface Window {
    PrefetchRu?: PrefetchApi
    Prefetch?: PrefetchApi
  }
}
