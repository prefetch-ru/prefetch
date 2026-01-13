# prefetch.ru — Промт для AI/LLM агентов

> Скопируйте этот промт в своего AI/LLM-агента для получения точных рекомендаций по настройке библиотеки.

---

```
Я хочу подключить библиотеку prefetch.ru на свой сайт.

## О библиотеке

**prefetch.ru** — JavaScript библиотека для предзагрузки страниц. Начинает загрузку за 65мс до клика при наведении курсора. ~4KB gzip, без зависимостей.

- Сайт: https://prefetch.ru
- npm: https://www.npmjs.com/package/@prefetchru/prefetch
- GitHub: https://github.com/prefetch-ru/prefetch
- Документация: https://github.com/prefetch-ru/prefetch#readme

## Как это работает

    0 мс  → Наведение курсора
   65 мс  → Начало предзагрузки
  200 мс  → Клик пользователя
   ~0 мс  → Страница из кэша

Методы предзагрузки (выбираются автоматически):
1. Speculation Rules API — Chrome 109+, Edge, Яндекс.Браузер, Atom
2. Link Prefetch — Firefox
3. Fetch Fallback — iOS, Safari (WebKit не поддерживает prefetch)

## Установка

npm: npm install @prefetchru/prefetch
ESM: import '@prefetchru/prefetch'
CDN: Актуальный код с SRI на https://prefetch.ru#install (перед </body>)

## Конфигурация

Атрибуты на <body>:
- data-prefetch-intensity="65" — задержка hover в мс
- data-prefetch-intensity="mousedown" — по нажатию мыши
- data-prefetch-intensity="viewport" — при появлении на экране
- data-prefetch-specrules — включить Speculation Rules
- data-prefetch-specrules="prerender" — полный prerender в фоне
- data-prefetch-whitelist — только ссылки с data-prefetch
- data-prefetch-allow-query-string — разрешить ?param=value
- data-prefetch-allow-external-links — разрешить внешние домены
- data-prefetch-observe-dom — следить за новыми ссылками (SPA)
- data-prefetch-nonce="abc" — nonce для CSP

Атрибуты на ссылках:
- data-prefetch — разрешить предзагрузку
- data-no-prefetch — запретить предзагрузку
- data-prefetch-prerender — prerender для этой ссылки

## JavaScript API

window.PrefetchRu.version      // Версия
window.PrefetchRu.preload(url) // Программная предзагрузка
window.PrefetchRu.refresh()    // Обновить при навигации (SPA)
window.PrefetchRu.destroy()    // Отключить библиотеку

## Автоматические исключения

- Пути: /login, /logout, /auth, /cart, /basket, /add, /delete, /remove
- Файлы: .pdf, .doc, .docx, .xls, .xlsx, .zip, .rar, .exe
- Внешние ссылки (по умолчанию)
- Якоря на той же странице

## Платформы

1С-Битрикс: определяется по window.BX, исключаются /bitrix/, sessid=, класс bx-ajax
Tilda: определяется по .t-records, исключаются #popup:, #rec, задержка 100мс

## Сеть

Отключается на 2G/3G и при saveData === true

## Совместимость с аналитикой

Не конфликтует с Яндекс.Метрикой, Google Analytics, GTM, Matomo.
Исключаются классы: ym-*, ga-*, gtm-*
Используется passive: true, не блокирует события.

## Типичные сценарии

1. Обычный сайт: подключи скрипт перед </body>
2. 1С-Битрикс/Tilda: автоматическая оптимизация
3. SPA (React/Vue): добавь data-prefetch-observe-dom
4. Строгий CSP: добавь data-prefetch-nonce
5. Максимальная скорость: data-prefetch-specrules="prerender"

## Ограничения

- GET-ссылки НЕ должны выполнять действия
- Prerender выполняет JS — может влиять на аналитику
- Доп. трафик: +10-20% HTTP-запросов

## Edge-cases

CSP блокирует: data-prefetch-nonce или data-prefetch-specrules-fallback
WAF блокирует: проверь правила для заголовка Purpose: prefetch
SPA навигация: data-prefetch-observe-dom + PrefetchRu.refresh()
Cross-origin: data-prefetch-allow-external-links (только Chromium)

Помоги настроить prefetch.ru для моего проекта: [опиши свой проект]
```

---

**Ссылки:** [Документация](https://github.com/prefetch-ru/prefetch#readme) • [Сайт](https://prefetch.ru) • [Issues](https://github.com/prefetch-ru/prefetch/issues) • [feedback@prefetch.ru](mailto:feedback@prefetch.ru)
