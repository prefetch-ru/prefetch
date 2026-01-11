# prefetch.ru

[![npm](https://img.shields.io/npm/v/@prefetchru/prefetch?color=0969da)](https://www.npmjs.com/package/@prefetchru/prefetch)
[![downloads](https://img.shields.io/npm/dm/@prefetchru/prefetch?color=0969da)](https://www.npmjs.com/package/@prefetchru/prefetch)
[![size](https://img.shields.io/bundlephobia/minzip/@prefetchru/prefetch?color=0969da&label=gzip)](https://bundlephobia.com/package/@prefetchru/prefetch)
[![license](https://img.shields.io/npm/l/@prefetchru/prefetch?color=0969da)](LICENSE)
[![release](https://img.shields.io/github/v/release/prefetch-ru/prefetch?color=0969da)](https://github.com/prefetch-ru/prefetch/releases)
[![updated](https://img.shields.io/github/last-commit/prefetch-ru/prefetch?color=0969da&label=updated)](https://github.com/prefetch-ru/prefetch/commits)
[![lang](https://img.shields.io/badge/язык-русский-0969da)](https://prefetch.ru)

**Instant page loading for Russian web**

Prefetch pages 65ms before user clicks. Pre-loads links on hover with smart fallbacks for iOS/Safari, optimized for Russian browsers (Yandex.Browser, Atom), CMS platforms (1C-Bitrix, Tilda), and e-commerce. Works everywhere with zero configuration — just add one script tag.

[**prefetch.ru**](https://prefetch.ru) • [Documentation](#api)

---

## Описание

**prefetch.ru** — библиотека для предзагрузки страниц. Начинает загрузку за 65 миллисекунд до клика пользователя при наведении курсора на ссылку.

### Особенности

- Работает во всех браузерах — Chrome, Safari, iOS, Firefox, Яндекс.Браузер, Atom
- Автоматические исключения: `/login`, `/logout`, `/auth`, `/register`, `/cart`, `/basket`, `/add`, `/delete`, `/remove`, файлы (pdf, doc, docx, xls, xlsx, zip, rar, exe), внешние ссылки
- Специальная поддержка 1С-Битрикс и Tilda
- Отключается на медленных соединениях (2G/3G) и режиме экономии трафика
- Не влияет на работу аналитики (Яндекс.Метрика, Google Analytics)
- ~3KB gzip, без зависимостей

---

## Установка

### npm

```bash
npm install @prefetchru/prefetch
```

```javascript
import '@prefetchru/prefetch'
```

### CDN

Для подключения через CDN смотрите документацию на [prefetch.ru](https://prefetch.ru#install).

Вставьте код перед закрывающим тегом `</body>`. Скрипт автоматически начнёт работать без настройки.

---

## API

### Глобальные атрибуты `<body>`

Настройте поведение через data-атрибуты:

```html
<body data-prefetch-intensity="65"
      data-prefetch-specrules
      data-prefetch-allow-query-string>
```

| Атрибут | Значения | Описание |
|---------|----------|----------|
| `data-prefetch-intensity` | `65` (default) | Задержка hover в мс |
| | `mousedown` | Загрузка по нажатию кнопки мыши |
| | `viewport` | При появлении в viewport (mobile) |
| | `viewport-all` | Viewport для всех устройств |
| `data-prefetch-specrules` | _(пусто)_ | Включить Speculation Rules (prefetch) |
| | `prerender` | Полный prerender страницы в фоне |
| | `no` | Отключить Speculation Rules |
| `data-prefetch-whitelist` | — | Режим белого списка (только с `data-prefetch`) |
| `data-prefetch-allow-query-string` | — | Разрешить ссылки с query-параметрами |
| `data-prefetch-allow-external-links` | — | Разрешить внешние домены |
| `data-prefetch-observe-dom` | — | Отслеживать новые ссылки (для SPA) |
| `data-prefetch-nonce` | `"abc123"` | Nonce для Content Security Policy |
| `data-prefetch-prerender-all` | — | Разрешить prerender для всех ссылок |

### Атрибуты ссылок `<a>`

Управляйте отдельными ссылками:

```html
<!-- Включить для конкретной ссылки -->
<a href="/catalog" data-prefetch>Каталог</a>

<!-- Исключить из предзагрузки -->
<a href="/logout" data-no-prefetch>Выйти</a>

<!-- Точечный prerender -->
<a href="/pricing" data-prefetch-prerender>Тарифы</a>
```

| Атрибут | Описание |
|---------|----------|
| `data-prefetch` | Явно разрешить предзагрузку |
| `data-no-prefetch` | Явно запретить предзагрузку |
| `data-prefetch-prerender` | Включить prerender для этой ссылки |

### JavaScript API

```javascript
// Доступен объект window.Prefetch после загрузки скрипта

// Версия библиотеки
console.log(Prefetch.version)  // "1.0.7"

// Программная предзагрузка URL
Prefetch.preload('/catalog/product-123')
```

---

## Примеры использования

### Базовое использование

```javascript
// После установки через npm
import '@prefetchru/prefetch'

// Скрипт автоматически начнёт работать
```

### Prerender для максимальной скорости

Полная отрисовка страницы в фоне (Chromium 109+):

```html
<body data-prefetch-specrules="prerender">
  <!-- Страницы полностью рендерятся в фоне, включая JS и CSS -->
</body>
```

**Внимание:** Prerender выполняет JavaScript целевой страницы до перехода. Может влиять на аналитику.

### Режим белого списка

Загружать только выбранные ссылки:

```html
<body data-prefetch-whitelist>
  <a href="/catalog" data-prefetch>Каталог</a> <!-- загружается -->
  <a href="/cart">Корзина</a> <!-- НЕ загружается -->
</body>
```

### Исключение ссылок

```html
<!-- Автоматически исключаются: /login, /logout, /cart, /add, файлы -->

<!-- Исключить вручную -->
<a href="/logout" data-no-prefetch>Выйти</a>
<a href="/cart/clear" data-no-prefetch>Очистить корзину</a>
```

### CSP с nonce

Для сайтов с Content Security Policy:

```html
<body data-prefetch-specrules
      data-prefetch-nonce="{{RANDOM_NONCE}}">
  <!-- Скрипт автоматически унаследует nonce -->
</body>
```

### Точечный prerender

Prerender только для важных страниц:

```html
<body data-prefetch-specrules="prerender">
  <a href="/pricing" data-prefetch-prerender>Тарифы</a> <!-- prerender -->
  <a href="/blog">Блог</a> <!-- prefetch -->
</body>
```

---

## Поддержка браузеров

Работает во всех современных браузерах с автоматическим fallback:

| Браузер | Метод | Статус |
|---------|-------|--------|
| **Chrome 109+** | Speculation Rules API | Полная поддержка |
| **Яндекс.Браузер** | Speculation Rules API | Полная поддержка |
| **Atom (VK)** | Speculation Rules API | Полная поддержка |
| **Safari / iOS** | fetch fallback | Работает |
| **Firefox** | `rel="prefetch"` | Работает |
| **Edge** | Speculation Rules API | Полная поддержка |

### iOS важно!

На iOS **все браузеры** (Chrome, Firefox, Edge) используют движок WebKit, который не поддерживает prefetch. Библиотека автоматически использует `fetch` с `cache: 'force-cache'` как fallback.

---

## Как это работает

### Timeline

```
  0 мс  → Наведение курсора
 65 мс  → Начало предзагрузки
200 мс  → Клик пользователя
~0 мс   → Страница из кэша
```

### Методы предзагрузки

1. **Speculation Rules API** (Chromium 109+) — современный API для prefetch/prerender
2. **Link Prefetch** (`<link rel="prefetch">`) — стандартный метод для Firefox
3. **Fetch Fallback** — для iOS/Safari через `fetch()` с кэшированием

Выбор метода происходит автоматически в зависимости от браузера.

---

## Совместимость с платформами

### 1С-Битрикс

Автоматическое определение и оптимизация:

- Исключаются служебные URL `/bitrix/`
- Пропускаются ссылки с `sessid=`
- Исключаются классы `bx-ajax`
- Автоматически включается `observeDom` для AJAX-компонентов

### Tilda

- Исключаются попапы `#popup:`
- Исключаются якоря `#rec`
- Автоматически включается `observeDom`
- Увеличена задержка hover до 100мс (больше интерактивных элементов)

### Аналитика

**Не конфликтует** с Яндекс.Метрикой, Google Analytics, Matomo:

- Исключаются служебные классы (`ym-*`, `ga-*`, `gtm-*`)
- Не блокируются события onclick
- UTM-метки работают как обычно
- Prefetch не влияет на подсчёт кликов

---

## Производительность

Предзагрузка влияет на Core Web Vitals:

- **LCP** (Largest Contentful Paint) — контент отображается быстрее
- **INP** (Interaction to Next Paint) — предзагруженные страницы отвечают без задержки
- **CLS** (Cumulative Layout Shift) — полностью отрендеренная страница не вызывает сдвигов

---

## Безопасность и приватность

### Защита

- **SRI hash** — браузер проверяет целостность файла
- **crossorigin="anonymous"** — запросы без cookies
- **type="module"** — изолированная область видимости
- **defer** — не блокирует рендер страницы

### Приватность

- Не использует cookies
- Не собирает аналитику
- Не отслеживает пользователей
- Работает локально в браузере
- Не делает запросов к внешним серверам

### Соответствие законодательству РФ

- **152-ФЗ** — не обрабатывает персональные данные
- Не требует согласия пользователей
- CDN на базе Yandex Cloud (серверы в РФ)

---

## Ограничения

### Дополнительный трафик

Часть prefetch-запросов не приведёт к переходу (пользователь передумал или навёл случайно). Это создаёт дополнительный трафик:

- Обычно +10-20% HTTP-запросов
- +5-15% нагрузки на сервер

### Важно проверить

- GET-ссылки не должны выполнять действия (добавление в корзину, удаление данных)
- Используйте `data-no-prefetch` для операций с побочными эффектами
- На highload проектах рекомендуется мониторить нагрузку на сервер

---

## Лицензия

MIT License. Открытый исходный код: форкайте, улучшайте, используйте без ограничений.

```
Copyright (c) 2026 Sergey Makarov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

---

## Contributing

Нашли баг? Есть идея для улучшения? 

- [Issues](https://github.com/prefetch-ru/prefetch/issues)
- [Pull Requests](https://github.com/prefetch-ru/prefetch/pulls)
- Email: [feedback@prefetch.ru](mailto:feedback@prefetch.ru)

---

## Ссылки

- **Сайт:** [prefetch.ru](https://prefetch.ru)
- **GitHub:** [github.com/prefetch-ru/prefetch](https://github.com/prefetch-ru/prefetch)
- **npm:** [npmjs.com/package/@prefetchru/prefetch](https://www.npmjs.com/package/@prefetchru/prefetch)
