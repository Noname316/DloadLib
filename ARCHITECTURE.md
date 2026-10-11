# Архитектура DownloadLib

## Дерево модулей

![Дерево модулей](/screenshots/schema.svg)

---

## Связи между модулями

### Контексты исполнения

Код расширения работает в трёх изолированных контекстах:

**Popup-контекст** (`popup.html`) — открывается браузером при клике на иконку расширения или в отдельном окне при запуске загрузки. Имеет доступ к DOM, может делать fetch, но не может напрямую перехватывать сетевые запросы.

**Background-контекст** — для Firefox: `background/background.html`, для Chrome MV3: `background/service-worker.js`. Живёт в фоне, перехватывает HTTP-запросы через `webRequest`, принимает сообщения от popup и контент-скриптов через `runtime.onMessage`.

**Content scripts** (`content/`) — три скрипта, исполняемых на страницах сайтов. Не участвуют в логике загрузки (кроме `ImageFetcher.js`, который прокидывает fetch-запросы изображений через вкладку).

Общение между контекстами — исключительно через `runtime.sendMessage` / `runtime.onMessage`. Напрямую вызывать функции другого контекста нельзя.

### Паттерн самостоятельной регистрации

Каждый сервис и каждый экспортер после объявления класса **сам** регистрируется в своём реестре:

```js
// В конце MangaLibService.js:
if (global.serviceRegistry) global.serviceRegistry.register(MangaLibService);

// В конце FB2Exporter.js:
if (global.ExporterRegistry) global.ExporterRegistry.register('fb2', FB2Exporter, { label: 'FB2' });
```

Реестры к этому моменту уже созданы (они загружены раньше). Добавление нового сервиса или экспортера не требует правок в реестре — только добавление файла в массив скриптов реестра.

### Паттерн IIFE

Каждый файл обёрнут в:

```js
(function(global) {
    // ...
    global.MyClass = MyClass;
})(typeof window !== 'undefined' ? window : self);
```

Это позволяет одному и тому же коду работать в `window`-контексте (popup) и `self`-контексте (Service Worker), не загрязняя глобальное пространство имён посторонними переменными. Background-скрипты (`RequestInterceptor.js`, `MessageRouter.js`) используют безаргументное IIFE — они исполняются только в `self`-контексте воркера.

### Маршрут данных при загрузке

```
PopupController.loadMetadata()
    → AuthManager.apply(serviceKey, tabId, service)
        → runtime.sendMessage({ action: 'getAuthToken' })       [background]
        ↓  если не найден:
        → browserAPI.scripting.executeScript(tabId, …)          [localStorage scan]
    → service.fetchMangaMetadata(slug)     [BaseService → fetchWithRateLimit]
        → runtime.sendMessage({ action: 'fetchWithRateLimit' })  [background]
    → MangaPatcher.patch(rawMeta)          [core]
    → ChapterController.loadAndPopulate(service, slug, …)
        → service.fetchChaptersList(slug)

PopupController.startDownload()
    → DownloadManager.startDownload(options)
        → service.fetchChapter(slug, num, vol, branchId)
        → service.extractText(rawContent)
        → service.processChapterContent(extracted, …)
            → runtime.sendMessage({ action: 'fetchImage', url })   [background]
                ↓ (background → content script)
            → tabs.sendMessage(tabId, { action: 'fetchImageFromTab', url })
                ↓ (ImageFetcher content script)
            → fetch(url) → FileReader → base64
        → ExporterRegistry.create(format).export(manga, chapters, cover)
        → DownloadHistory.add(entry)
        → saveFile(blob, filename)
```

---

## Описание модулей

### `core/BrowserApi.js`

Выставляет четыре глобала: `getExtensionApi`, `getBrowserEnv`, `extensionApi`, `browserEnv`.

`extensionApi` — унифицированный объект с Promise-based методами: `runtime.sendMessage`, `tabs.query/sendMessage`, `windows.getCurrent/create/update`, `downloads.download`, `storage.local.get/set`, `scripting.executeScript`. Firefox нативно возвращает промисы, для Chrome callback-API оборачивается вручную через `toPromise()`.

`browserEnv` — объект `{ isFirefox, isChromium, supportsDnr }` для условной логики.

Все остальные модули читают API через `getExtensionApi()`, никогда не обращаясь к `browser`/`chrome` напрямую.

---

### `core/Storage.js`

Безопасная обёртка над `localStorage`. Проверяет доступность при инициализации; все методы (`get`, `set`, `getJSON`, `setJSON`, `remove`) перехватывают исключения и возвращают `null`/`false` вместо выброса.

Создаётся `window.Storage` — класс, не синглтон; `DownloadHistory` создаёт свой экземпляр.

---

### `core/DownloadHistory.js`

Хранит до 10 последних успешных загрузок в `localStorage` (через `Storage`). Ключ `manga_parser_download_history`.

Методы: `add(entry)`, `getAll()`, `clear()`. `add()` добавляет запись в начало массива (`unshift`) и обрезает до 10.

Вызывается из `DownloadManager` после успешного сохранения файла.

---

### `core/AuthManager.js`

Управляет JWT-токенами авторизации для API cdnlibs.org.

`getToken(serviceKey, tabId)` — сначала запрашивает кэшированный токен у background через `getAuthToken`. Если не найден и передан `tabId` — извлекает токен из `localStorage`/`sessionStorage` страницы через `scripting.executeScript`.

`apply(serviceKey, tabId, service)` — вызывает `getToken`, при успехе добавляет `Authorization: Bearer <token>` в `service.config.headers`.

Кэш токенов хранится в `globalThis.authTokenStore` внутри background-процесса; синхронизируется сообщениями `getAuthToken` / `cacheAuthToken` через `MessageRouter`.

---

### `core/EventBus.js`

Реализует паттерн Pub/Sub. Класс `EventBus` — не синглтон, каждый потребитель создаёт свой экземпляр.

Методы: `on(event, cb)`, `once(event, cb)`, `off(event, cb)`, `emit(event, data)`, `clear(event?)`.

`on()` возвращает функцию-отписку. `emit()` оборачивает каждый вызов подписчика в `try/catch` — ошибка в одном обработчике не ломает остальные.

Используется в `DownloadManager`: шина создаётся при инстанциировании и передаётся наружу как `downloadManager.eventBus`. `PopupController` подписывается на события `download:started`, `download:progress`, `download:completed`, `download:failed`.

---

### `core/RateLimiter.js`

Ограничивает количество HTTP-запросов к API сервиса. При загрузке создаётся синглтон `window.globalRateLimiter` (80 req/min по умолчанию).

`acquire(name)` / `trackRequest(name)` — возвращает промис, который резолвится только тогда, когда счётчик запросов за последнюю минуту не превышает лимит. Запросы встают в очередь `_pendingQueue`.

`throttle(ms)` — принудительная пауза всех запросов на `ms` миллисекунд. Вызывается при HTTP 429 в `MessageRouter.fetchWithRateLimit`.

`setLimit(n)` / `getStats()` — динамическое изменение лимита и диагностика.

Экземпляр присутствует как в popup, так и в background; background-копия используется для учёта реальных сетевых запросов.

---

### `core/MangaPatcher.js`

Нормализует сырой объект метаданных тайтла из API в единый контракт, который могут использовать все экспортеры и UI без знания о специфике конкретного сервиса.

Реализован как пайплайн независимых статических классов-модулей. `MangaPatcher.patch(obj)` последовательно применяет каждый.

---

### `core/DownloadManager.js`

Оркестрирует полный жизненный цикл загрузки.

**`startDownload(options)`** — принимает `{ url?, serviceKey?, slug, format, controller, loadedFile, chapterRange, branchId, maxSizeMB }`. Если передан `loadedFile` — делегирует в `updateExistingFile()` (в интерфейсе этот режим больше не используется), иначе запускает стандартный flow:

1. Применяет auth-токен через `AuthManager.apply()`.
2. Загружает метаданные → `MangaPatcher.patch()`.
3. Загружает обложку как base64.
4. Загружает список глав через `ChapterController`, применяет фильтры `branchId` и `chapterRange`.
5. Сохранение по типу сервиса:
   - `downloadPerChapter()` — по файлу на главу (`config.splitByChapter`: MangaLib, com-x);
   - `downloadAsSingleFile()` — весь диапазон одним файлом (`config.singleFile`: RanobeLib). Если скачан не весь тайтл, к имени добавляется диапазон («Название (Том 1 Гл. 2 – Том 3 Гл. 20)»). При остановке сохраняются уже скачанные главы. Режим обновления (`loadedFile`) тоже собирает один файл;
   - `downloadWithSizeLimit()` — для остальных: файл на том с разбиением на части при превышении `maxSizeMB` (настройки размера в интерфейсе больше нет).

**`downloadSingleChapter()`** — вызывает `service.fetchChapter()` → `service.extractText()` → `service.processChapterContent()`.

**`updateExistingFile()`** — режим обновления (кнопка «Загрузить файл для обновления» убрана из окна; метод оставлен для совместимости): парсит загруженный файл через `exporter.parse()`, находит отсутствующие главы и дописывает их.

**`createController()`** — фабрика объекта `{ pause(), resume(), stop(), isPaused(), shouldStop(), waitIfPaused() }`. `waitIfPaused()` — асинхронный spin-lock, вызывается перед каждой главой.

---

**`downloadPerChapter()`** — используется для сервисов с `config.splitByChapter` (MangaLib): каждая глава загружается и сразу сохраняется отдельным файлом `Тайтл - Том 01 Глава 0012 - Название.ext`. При `config.strictErrors` ошибка главы/страницы прерывает загрузку с сообщением (уже сохранённые главы остаются), текстовые заглушки в файлы не пишутся.

---

### `core/RequestPacer.js`

Регуляторы запросов страницы расширения — две независимые полосы (`getRequestPacer(lane)`, перед загрузкой `prepareRequestPacers()`):

- `'site'` — API сайта (`BaseService.fetchWithRateLimitRetry`) и открытие страниц сайта в режиме DOM (8 слотов на страницу). Стартовый темп 85/мин (настройки больше нет), автоподбор до ×2, 2 запроса одновременно; сервис может задать свой профиль (`config.pacing`).
- `'images'` — CDN картинок (`fetchPageImage`) и переключение страниц читалки в режиме DOM. 240/мин на старте, до 600/мин, до 6 загрузок одновременно (`withPermit`).

Запросы стартуют равномерно — не чаще одного за `60000 / темп` мс. Автоподбор (AIMD): каждые 15 успехов подряд темп растёт на 10% от стартового. Ответы 403 (если тело не JSON-сообщение API), 429 и 503 ставят на паузу полосу (`Retry-After` или 30 → 60 → 120 → 240 → 300 → 300… с), темп и число потоков падают вдвое, 90% от темпа отказа на 10 минут становится потолком, повторный отказ отключает разгон. Подобранный темп хранится в `localStorage` (`downloadlib_pacer_learned_<lane>`) и используется следующей загрузкой. Загрузка пережидает ограничение сайта: `RateLimitError` бросается, только если за 60 минут пауз подряд (`MAX_LIMIT_WAIT_MS`) ограничение не снято; 10 успехов подряд обнуляют счётчик. Статус показывает, сколько осталось ждать, «Завершить» прерывает ожидание сразу. Для изображений 403 считается ограничением только при `{ throttleOn403: true }` (MangaLib), потому что RanobeLib получает 403 при переборе расширений файла. В режиме DOM картинки берутся из кэша браузера (`{ cached: true }` → `fetch(..., { cache: 'force-cache' })`) и не расходуют лимит; промах кэша (ответ дольше 15 мс) учитывается задним числом (`charge`).

### `services/comx/ComXService.js` и `services/comx/config.js`

Сервис сайта com-x.life. Наследует `MangaLibService` ради загрузки картинок (пул, повторы, строгие ошибки, оригиналы для CBZ), но данные берёт из HTML страниц сайта, без API и без отрисовки:

- страница тайтла `/{id}-{slug}.html`: `window.__DATA__` (полный список глав: `id`, `posi`, `volume`, `number`, `title`, `pages`), `og:image`/`og:description`, блок `.page__list` (год, издатель, статус), жанры `.page__tags`;
- читалка `/reader/{id тайтла}/{id главы}`: `window.__DATA__.images` и хосты зеркал `host`/`host_ru` (российское зеркало — для российских часовых поясов, как в самой читалке).

Особенности:

- главы идут в порядке сайта (`posi`, `config.keepChapterOrder`): номера томов на сайте ненадёжны;
- имена файлов — «Тайтл - 001 - {название главы как на сайте}.cbz»;
- запросы идут через вкладку com-x с cookie пройденной антибот-проверки. Страница проверки (`/_c?t=…`) распознаётся и даёт понятную ошибку без пауз;
- профиль темпа `config.pacing` осторожнее, чем у MangaLib: сайт сам ограничивает массовое скачивание (квота около 150 глав, блокировки). При выборе больше `largeDownloadWarning` глав окно просит подтвердить загрузку повторным нажатием;
- тема окна (`backgroundColor`, `panelColor`, `panelDarkColor`, `onPrimaryColor`, `textColor`, `primaryColor`, `secondaryColor`, `logo`) применяется через CSS-переменные в `PopupController._applyServiceTheme`; логотип — `icons/logo5.png` (DloadLIB в стиле шапки com-x, 330×100, показывается в 165×50);
- токен авторизации не ищется (`noAuthToken`), сайт работает на cookie.

### `services/hentailib/HentaiLibService.js` и `services/hentailib/config.js`

HentaiLib (hentailib.me) — сайт той же платформы, что MangaLib, поэтому `HentaiLibService extends MangaLibService` и наследует всё: API, режим DOM, загрузку страниц, CBZ на главу, выбор папки. Отличается только конфигурацией:
- API — тот же `api.cdnlibs.org`, но с `Site-Id: 4` и `X-DL-Service: hentailib`;
- картинки — сервер «Сжатия» `img3h.hentaicdn.org` (из `/api/constants?fields[]=imageServers` для site_id 4), обложки — `cover.cdnlibs.org`/`cover.hentaicdn.org`;
- вкладки сайта — `tabPatterns` (`hentailib.me`), они же передаются сборщику режима DOM через `domScraperOptions`;
- тема — красная (`#e53935`), логотип `icons/logo4.png`.

Метаданные и список глав отдаются без входа, а содержимое главы — только с токеном пользователя: без него API отвечает 404 «Not Found». `fetchChapter` заменяет такую ошибку подсказкой войти на hentailib.me.

Если API (MangaLib и HentaiLib) отвечает на главу успешно, но без страниц, `MangaLibService._fetchChapterApi` повторяет запрос после пауз `pacer.throttled(…, 'глава без страниц')` — так же, как при 429, в пределах того же 60-минутного запаса ожидания. Токен ищется во вкладке сайта (`AuthManager`), а `RequestInterceptor` относит запросы с `Site-Id: 4`/реферером hentailib.me к сервису `hentailib`, чтобы токены сайтов не смешивались.

### `background/ActionButton.js`

Значок расширения. Встроенной всплывающей панели больше нет (`action.default_popup` убран из манифестов): щелчок по значку (`action.onClicked`) открывает отдельное окно `popup.html` для текущей вкладки:

- на странице тайтла — окно загрузки (`?download=true&slug=…&service=…&tabId=…`);
- на поддерживаемом сайте без тайтла, а также на чужом сайте — окно с `?tabId=…`: PopupController берёт адрес этой вкладки через `tabs.get` и показывает подсказку или ссылки на сайты.

Повторный щелчок (и кнопка «Скачать» на странице сайта — `openDownloadWindow` в `MessageRouter`) выводит вперёд уже открытое окно этой вкладки. Окно загрузки не стартует само: главы и папка выбираются в нём. Значок на неподдерживаемых сайтах серый и полупрозрачный (`action.setIcon` с `imageData`, нарисованной из самого значка через canvas), на MangaLib, RanobeLib и com-x — цветной. Цвет обновляется при смене адреса вкладки (`tabs.onUpdated`) и при запуске фона.

### `background/TitleJobs.js`

Загрузка данных тайтла (метаданные + список глав, API или DOM) в фоне расширения. Выпадающее окно закрывается при переключении вкладки и теряет свой код, поэтому `PopupController._loadTitleData` не загружает тайтл сам, а отправляет `{ action: 'titleJob:load', serviceKey, slug, mode, authToken }` и опрашивает ответ (`running` + текст прогресса → `done` + результат или `error`). Задание продолжается без окна; результат хранится 10 минут в памяти и `storage.local` (переживает выгрузку service worker'а), ошибка — 5 секунд, после чего следующее открытие запускает задание заново. В режиме DOM окно кладёт результат в кэш `MangaLibService.primeDomCache`, и окно загрузки не сканирует страницу повторно. Если фон недоступен, окно загружает тайтл само.

### `core/DownloadStats.js`

Статистика загрузки для панели над прогресс-баром: прошедшее и оставшееся время, главы/страницы в минуту (окно 5 минут), МБ/с (окно 15 с), доля страниц из кэша, что готовится заранее и журнал событий (последние 60: смена темпа, отказы сервера, сохранённые главы, ежеминутная скорость, ошибки).

### Конвейер глав (`DownloadManager.downloadPerChapter`)

Три этапа идут одновременно: подготовка следующей главы (`_prepareChapter`: запрос к API или читалка), загрузка картинок текущей (`_loadChapterContent`), сборка CBZ и запись предыдущей (фоновая цепочка, строго по порядку). При остановке или ошибке подготовка отменяется через `gate.cancelled`, уже скачанные главы дописываются.

---

### `core/FileSaver.js`

Сохранение файлов в папку, выбранную пользователем. `FileSaver.pickDirectory()` — системный диалог выбора папки (File System Access API, Chrome/Edge; вызывается только по клику). `FileSaver.forDownloads(subfolder)` — запасной вариант для Firefox: подпапка «Загрузок» через `downloads.download`. Экземпляр передаётся в `DownloadManager.startDownload({ saver })`.

---

### `services/mangalib/MangaLibDomScraper.js`

Режим загрузки «через DOM» для MangaLib (`service.setSourceMode('dom')`). Открывает служебную фоновую вкладку, читает метаданные со страницы тайтла, собирает ссылки на главы прокруткой виртуального списка и ссылки на изображения страниц, переключая страницы в читалке. Подменяет `requestAnimationFrame` на странице, иначе Vue не перерисовывает список в фоновой вкладке. Вкладка закрывается в `service.dispose()`; если страница расширения закрылась раньше, её закрывает background по разрыву порта `domHelperTab:<id>`.

---

### `services/ServiceRegistry.js`

Реестр сервисов. Создаёт синглтон `window.serviceRegistry`. При своей загрузке через `importScripts` (background) или `<script>` (popup) подключает все конфиги и классы сервисов.

Методы:
- `register(ServiceClass)` — создаёт экземпляр, сохраняет `{ class, instance, matcher }`.
- `getServiceByUrl(url)` — перебирает сервисы, возвращает экземпляр первого, чей `matches(url)` вернул `true`.
- `getService(name)` — возвращает существующий экземпляр по имени.
- `createService(name)` — создаёт **новый** экземпляр (используется в `DownloadManager` для каждой загрузки).

---

### `services/BaseService.js`

Базовый класс. Принимает объект `config` в конструктор.

Реализует API-запросы к cdnlibs.org через `runtime.sendMessage({ action: 'fetchWithRateLimit' })` — все fetch-запросы идут через background, где применяются нужные заголовки и учитывается rate limit.

- `fetchMangaMetadata(slug)` — `GET /api/manga/{slug}?fields[]=...`
- `fetchChaptersList(slug)` — `GET /api/manga/{slug}/chapters`
- `fetchChapter(slug, number, volume, branchId)` — `GET /api/manga/{slug}/chapter?number=...`

Абстрактный метод `static matches(url)` — обязателен в подклассе.

---

### `services/*/config.js`

Объект конфигурации сервиса, выставляемый в `global`. Содержит: `name`, `baseUrl`, `imagesDomain`, `siteId`, `fields[]`, `headers`, `imageHeaders`, опциональные `formats[]` (разрешённые форматы: MangaLib — `['cbz']`, RanobeLib — `['epub', 'fb2']`; без поля доступны все), `splitLongImages`, `keepOriginalImages`, `splitByChapter`, `strictErrors`, `supportsDomMode`, `chooseSaveFolder` (выбор папки перед загрузкой — MangaLib, com-x, RanobeLib), `singleFile` (весь диапазон одним файлом — RanobeLib). Загружается до класса сервиса.

---

### `exporters/ExporterRegistry.js`

Реестр экспортеров со статическим приватным полем `#registry`. При загрузке подключает все файлы экспортеров.

Методы:
- Встроенные форматы: FB2, EPUB, MOBI, PDF, Simple, CBZ (`exporters/CBZExporter.js`, раньше был плагином). Пользовательские плагины отключены: `PluginManager` не загружается, а при старте фон снимает ранее зарегистрированные для плагинов content scripts. Список плагинов в `storage.local` не удаляется.
- `register(format, Class, meta)` — регистрация по строковому ключу формата.
- `create(format)` — фабрика, бросает `Error` при неизвестном формате.
- `getFormats()` — список `[{ value, label }]` для построения `<select>` в UI.
- `_reset()` — полный сброс реестра (используется в тестах).

---

### `exporters/BaseExporter.js`

Базовый класс. Предоставляет утилиты: `escapeXml()`, `escapeHtml()`, `stripHtml()`, `sanitizeText()`, `extractText()`.

Обязательный метод для переопределения: `async export(manga, chapters, coverBase64)` — должен вернуть `{ blob, filename, mimeType }`.

Опциональный метод: `parse(file)` — разобрать файл в `{ metadata, cover, chapters }` для режима обновления.

**Контракт аргументов `export()`:**
- `manga` — нормализованный объект из `MangaPatcher`: `{ name, authors[], summary, cover, genres[], tags[], releaseDate, ageRating, rating }`.
- `chapters` — `[{ title, content: Block[], volume, number }]`, где `Block` — `{ type: 'text', text: string }` или `{ type: 'image', id: string, data: { base64: string, contentType: string } }`.
- `coverBase64` — data-URL строка или пустая строка.

**Контракт `parse()`:** `{ metadata: { name, authors[], summary, genres[], tags[], releaseDate, rating }, cover: string, chapters: [{ title, content: Block[], volume, number }] }`.

---

### `content/AdCleaner.js`

Content script. Удаляет рекламные DOM-элементы на страницах MangaLib/RanobeLib: слайдеры, рекламные попапы (по CSS-классам и маркерам), восстанавливает прокрутку страницы после закрытия попапов. Отслеживает динамически добавляемые узлы через `MutationObserver`. Не участвует в логике загрузки.

---

### `content/DownloadButton.js`

Content script. Инжектирует кнопку «Скачать» рядом с кнопкой «Читать» на странице тайтла. При клике отправляет `{ action: 'openDownloadWindow', format }` в background. Читает последний выбранный формат из `storage.local` и обновляет подпись кнопки при его изменении через `storage.onChanged`. Отслеживает динамическое появление кнопок через `MutationObserver`.

---

### `content/ImageFetcher.js`

Content script. Слушает сообщение `{ action: 'fetchImageFromTab', url }` от background. Делает `fetch(url)` в контексте вкладки (с cookies и заголовками сайта), конвертирует в base64 через `FileReader` и возвращает `{ ok, base64, contentType }`. Это позволяет background получать изображения, не имея собственного доступа к CDN с авторизованными cookies.

---

### `background/RequestInterceptor.js`

Перехватчик сетевых запросов. Загружается в background-контекст до `MessageRouter`.

**Firefox** (`webRequest.onBeforeSendHeaders` в режиме `blocking`): подменяет заголовки запросов от расширения на нужные из конфига сервиса, захватывает JWT-токены из запросов страницы (`captureAuthToken`), добавляет `Access-Control-Allow-Origin` к ответам изображений (`onHeadersReceived`).

**Chrome**: только rate-limiting и перехват токенов без изменения заголовков (управляются через `rules.json` и `declarativeNetRequest`).

В обоих браузерах блокирует запросы к рекламным URL через `webRequest.onBeforeRequest`.

Выставляет `globalThis.detectServiceByUrl` — функцию определения сервиса по URL, используемую также в `MessageRouter`.

---

### `background/MessageRouter.js`

Маршрутизатор сообщений. Слушает `runtime.onMessage` и делегирует обработку зарегистрированным хендлерам.

Хендлеры (`Map<action, handler>`):
- `getAuthToken` / `cacheAuthToken` — чтение и запись токенов из `globalThis.authTokenStore`.
- `setRateLimit` / `getRateLimiterStats` — управление rate limiter background-процесса.
- `fetchImage` — находит открытую вкладку нужного сервиса, отправляет ей `fetchImageFromTab`, прокидывает ответ обратно в popup.
- `fetchWithRateLimit` — делает fetch с rate limiting и retry при 429, возвращает тело и заголовки.
- `openDownloadWindow` / `openWindowWithUrl` — открывает popup.html с нужными параметрами в новом окне или вкладке.

---

### `ui/TemplateLoader.js`

Загружает HTML-фрагменты из папки `templates/` в якорный элемент (`#view`), в два слоя:

- основной экран (`#mainView`): `show(templateName, onReady?)` — `title`, `wrong-service`, `no-title`; заменяет предыдущий основной экран;
- экран поверх (`#overlayView`): `showOverlay(templateName, onReady?)` — `history`, `settings`. Основной экран только скрывается, а `hideOverlay()` возвращает его как был: идущая загрузка, прогресс, статистика и обработчики сохраняются.

`PopupController._restoreMainView()` (кнопки «Назад») закрывает экран поверх; заново экран тайтла строит только `_reloadMainView()` — при смене способа API/DOM. Настройки открываются в том же окне. Параметр `?settings=true` (отдельное окно настроек) по-прежнему поддерживается, но кнопкой больше не используется. Другие методы: `current()` — видимый шаблон, `mainView()` — основной экран.

Шаблоны: `templates/title.html` (основная форма загрузки), `templates/history.html` (история), `templates/settings.html` (настройки), `templates/wrong-service.html`, `templates/no-title.html`.

---

### `ui/ChapterController.js`

Управляет выбором диапазона глав и переводчика.

`loadAndPopulate(service, slug, chapterFromUrl, chapterToUrl, branchIdUrl)` — загружает список глав через `service.fetchChaptersList()`, заполняет `<select>` элементы и при наличии нескольких переводов показывает `translatorSelect`.

`getFilteredChapters(branchId)` — возвращает главы, принадлежащие нужной ветке перевода.

`repopulateSelects(chapters, fromSelect, toSelect)` — пересобирает `<option>` в обоих селектах при смене переводчика.

---

### `ui/HistoryController.js`

Управляет видом истории загрузок (шаблон `history.html`).

`init()` — рендерит список через `DownloadHistory.getAll()` и вешает обработчики кнопок «Назад» и «Очистить». Карточки содержат цветовую метку сервиса, формат, дату, диапазон глав и переводчика. При наличии `browserAPI.tabs` заголовок карточки становится кликабельной ссылкой на тайтл.

---

### `ui/PopupController.js`

Управляет всем DOM popup-страницы. Создаётся один раз из `app.js`.

**Инициализация (`_init`):**
1. Инициализирует `TemplateLoader` на элементе `#view`.
2. Привязывает события оболочки (`_bindShellEvents`): кнопка истории `#historyBtn`.
3. Загружает шаблон `title`, привязывает события формы (`_bindTitleEvents`), настраивает слушатели.
4. Вызывает `loadMetadata()` и `checkApiHealth()`.

**`loadMetadata()`** — определяет активную вкладку, парсит slug из URL, применяет auth-токен, загружает метаданные тайтла, заполняет UI обложкой/описанием, передаёт управление главами в `ChapterController`. Читает URL-параметры окна загрузки (`download=true`, `slug`, `service`, `tabId` и др.).

**`openInNewContext(url)`** — открывает popup.html в новом окне/вкладке через `openWindowWithUrl` сообщение в background. Используется кнопкой «Скачать» (открывает новое окно с `download=true`).

**Шаблонные состояния:** `_showWrongServiceState` (не та страница), `_showNoTitleState` (нет тайтла), `_setReadyState` (готов к загрузке), `_setDownloadingUIState` / `resetUI` (во время/после загрузки).

**`checkApiHealth()`** — проверяет кэшированный статус API в `localStorage`. При наличии флага `isFailing` показывает предупреждение `_showApiWarning`.

---

## Как добавить новый экспортер

1. Создать `exporters/XyzExporter.js` по шаблону:

```js
'use strict';
(function(global) {
    class XyzExporter extends global.BaseExporter {
        async export(manga, chapters, coverBase64) {
            // manga.name, manga.authors[], manga.summary — всегда строки/массивы строк
            // chapters[i].content[j] — { type: 'text', text } или { type: 'image', data: { base64, contentType } }
            const blob = new Blob([...], { type: 'application/xyz' });
            return { blob, filename: `${manga.name}.xyz`, mimeType: 'application/xyz' };
        }

        // Опционально — для поддержки режима обновления файла
        async parse(file) {
            return {
                metadata: { name: '', authors: [], summary: '', genres: [], tags: [], releaseDate: '', rating: '' },
                cover: '',
                chapters: [] // [{ title, content: Block[], volume, number }]
            };
        }
    }

    global.XyzExporter = XyzExporter;
    if (global.ExporterRegistry)
        global.ExporterRegistry.register('xyz', XyzExporter, { label: 'XYZ' });
})(typeof window !== 'undefined' ? window : self);
```

2. Добавить путь `/exporters/XyzExporter.js` в массив `EXPORTER_SCRIPTS` в `exporters/ExporterRegistry.js`.

3. `PopupController` автоматически добавит новый вариант в `<select>` форматов через `ExporterRegistry.getFormats()`.

---

## Как добавить новый сервис

1. Создать `services/newsite/config.js`:

```js
'use strict';
(function(global) {
    global.newsiteConfig = {
        name: 'newsite',
        baseUrl: 'https://api.newsite.example',
        imagesDomain: 'https://img.newsite.example',
        siteId: '42',
        fields: ['authors', 'summary', 'genres', 'tags'],
        headers: {
            'User-Agent': '...',
            'Site-Id': '42',
            'X-DL-Service': 'newsite',
            'Referer': 'https://newsite.example/'
        },
        imageHeaders: { 'Referer': 'https://newsite.example/' }
    };
})(typeof window !== 'undefined' ? window : self);
```

2. Создать `services/newsite/NewSiteService.js`:

```js
'use strict';
(function(global) {
    class NewSiteService extends global.BaseService {
        constructor() { super(global.newsiteConfig); }

        static matches(url) {
            try { return /newsite\.example$/i.test(new URL(url).hostname); }
            catch { return false; }
        }

        extractText(content) {
            // Разобрать content (формат зависит от API сервиса)
            return [];
        }

        async processChapterContent(extracted, _statusEl, opts) {
            const result = [];
            for (const block of extracted) {
                if (block.type === 'image') {
                    const resp = await this.extensionApi.runtime.sendMessage({
                        action: 'fetchImage', url: block.src
                    });
                    if (resp?.ok)
                        result.push({ type: 'image', id: `img_${Date.now()}`, data: { base64: resp.base64, contentType: resp.contentType } });
                } else result.push(block);
            }
            return result;
        }
    }

    global.NewSiteService = NewSiteService;
    if (global.serviceRegistry) global.serviceRegistry.register(NewSiteService);
})(typeof window !== 'undefined' ? window : self);
```

3. Добавить оба пути в массив `SERVICE_SCRIPTS` в `services/ServiceRegistry.js` (конфиг — перед классом).

4. В `manifest.json`: добавить домен в `host_permissions` и `content_scripts.matches`.

5. В `background/RequestInterceptor.js`:
   - Добавить домен в `FIREFOX_WEBREQUEST_URLS`.
   - Добавить обнаружение в `detectServiceByUrl()` и `detectServiceByReferer()`.
   - Добавить конфиг в `ServiceConfigs`:
     ```js
     if (typeof newsiteConfig !== 'undefined')
         ServiceConfigs.newsite = newsiteConfig;
     ```

6. В `background/MessageRouter.js`: обновить массив `patterns` в хендлере `fetchImage` для новых URL-паттернов поиска вкладки.
