/**
 * DownloadLib service module
 * Module to interact with the MangaLib manga service
 * @module services/mangalib/MangaLibService
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[MangaLibService] Loading...');

    const DOM_CACHE_PREFIX = 'downloadlib_dom_title_';
    const DOM_CACHE_TTL = 10 * 60 * 1000;
    // Сколько раз повторять пустую главу, если регулятор темпа недоступен.
    const EMPTY_CHAPTER_RETRIES = 3;
    const PAGE_ATTEMPTS = 3;
    const PAGE_WORKERS = 6;

    /**
     * Сервис-парсер сайта MangaLib: изображения страниц отдаются одним "сжатым"
     * сервером, но могут быть аномально длинными — при необходимости
     * разбиваются на части по соотношению сторон A4 перед сжатием.
     */
    class MangaLibService extends global.BaseService {
        /**
         * Создаёт сервис с конфигурацией MangaLib и пустым кэшем загруженных изображений.
         * Наследники (например, ComXService) передают свою конфигурацию и переиспользуют
         * загрузку картинок страниц (пул загрузчиков, повторы, строгие ошибки, кэш, CBZ-оригиналы).
         * @param {object} [config] - Конфигурация сервиса.
         */
        constructor(config = global.mangalibConfig) {
            super(config);
            this._imageCache = new Map();
            this.sourceMode = 'api';
            this.onStatus = null;
            this._domScraper = null;
            this._domTitle = null;
            this._lastImageError = null;
            console.log('[MangaLibService] Instance created');
        }

        /**
         * Переключает способ получения данных: 'api' — REST API сайта,
         * 'dom' — поиск ссылок на отрисованных страницах сайта.
         * @param {string} mode - Способ загрузки.
         * @returns {void}
         */
        setSourceMode(mode) {
            this.sourceMode = mode === 'dom' && this.config.supportsDomMode ? 'dom' : 'api';
        }

        /**
         * @returns {boolean} true, если сервис работает в режиме DOM.
         */
        get isDomMode() {
            return this.sourceMode === 'dom' && !!this.config.supportsDomMode;
        }

        /**
         * Передаёт текст промежуточного статуса подписчику (UI/менеджеру загрузки).
         * @param {string} message - Текст статуса.
         * @returns {void}
         */
        _reportStatus(message) {
            if (typeof this.onStatus === 'function')
                try { this.onStatus(message); } catch (e) { /* ignore */ }
        }

        /**
         * Возвращает (создавая при необходимости) сборщик данных со страниц сайта.
         * @returns {object} Экземпляр MangaLibDomScraper.
         */
        _getDomScraper() {
            if (!global.MangaLibDomScraper) throw new Error('Модуль режима DOM не загружен');
            if (!this._domScraper) {
                this._domScraper = new global.MangaLibDomScraper({
                    siteUrl: this.config.siteUrl,
                    ...(this.domScraperOptions || {})
                });
                this._domScraper.checkpoint = () => this.checkpoint();
                this._domScraper.getGate = () => this._gate;
            }
            return this._domScraper;
        }

        /**
         * Кладёт данные тайтла, полученные в фоне (TitleJobs), в кэш режима DOM, чтобы
         * окно загрузки не сканировало страницу тайтла повторно.
         * @param {string} slug - Slug тайтла.
         * @param {{metadata: object, chapters: object}} data - Ответы fetchMangaMetadata и fetchChaptersList.
         * @returns {void}
         */
        primeDomCache(slug, { metadata, chapters } = {}) {
            const meta = metadata?.data || metadata;
            const list = chapters?.data || chapters;
            if (!meta || !Array.isArray(list)) return;
            const data = { meta, chapters: list };
            this._domTitle = { slug, data };
            try {
                localStorage.setItem(DOM_CACHE_PREFIX + slug, JSON.stringify({ timestamp: Date.now(), data }));
            } catch (e) { /* кэш — необязательная оптимизация */ }
        }

        /**
         * Загружает метаданные и список глав тайтла со страницы сайта (режим DOM).
         * Результат кэшируется на 10 минут в localStorage расширения, чтобы окно
         * загрузки не сканировало страницу повторно сразу после попапа.
         * @param {string} slug - Slug тайтла.
         * @returns {Promise<{meta: object, chapters: object[]}>} Данные тайтла.
         */
        async _loadDomTitle(slug) {
            if (this._domTitle?.slug === slug) return this._domTitle.data;

            const cacheKey = DOM_CACHE_PREFIX + slug;
            try {
                const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
                if (cached && Date.now() - cached.timestamp < DOM_CACHE_TTL) {
                    this._domTitle = { slug, data: cached.data };
                    return cached.data;
                }
            } catch (e) { /* localStorage недоступен или кэш повреждён */ }

            this._reportStatus('Открываем страницу тайтла (DOM)...');
            const data = await this._getDomScraper().fetchTitle(slug, { onProgress: m => this._reportStatus(m) });
            this._domTitle = { slug, data };
            try {
                localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
            } catch (e) { /* кэш — необязательная оптимизация */ }
            return data;
        }

        /**
         * Метаданные тайтла: через API или со страницы сайта (режим DOM).
         * @param {string} slug - Slug тайтла.
         * @returns {Promise<?object>} Ответ в формате API ({ data }).
         */
        async fetchMangaMetadata(slug) {
            if (!this.isDomMode) return super.fetchMangaMetadata(slug);
            const { meta } = await this._loadDomTitle(slug);
            return { data: { ...meta, slug } };
        }

        /**
         * Список глав: через API или со страницы сайта (режим DOM).
         * @param {string} slug - Slug тайтла.
         * @returns {Promise<?object>} Ответ в формате API ({ data: chapters[] }).
         */
        async fetchChaptersList(slug) {
            if (!this.isDomMode) return super.fetchChaptersList(slug);
            const { chapters } = await this._loadDomTitle(slug);
            return { data: chapters.map(ch => ({ ...ch, branches: ch.branches.map(b => ({ ...b })) })) };
        }

        /**
         * Находит адрес главы в читалке среди ссылок, собранных со страницы тайтла;
         * если глава не найдена в списке, строит адрес по шаблону сайта.
         * @param {string} slug - Slug тайтла.
         * @param {*} number - Номер главы.
         * @param {*} volume - Номер тома.
         * @param {?number} branchId - id ветки перевода.
         * @returns {string} Абсолютный адрес главы.
         */
        _resolveDomChapterUrl(slug, number, volume, branchId) {
            const chapters = this._domTitle?.slug === slug ? this._domTitle.data.chapters : [];
            const chapter = chapters.find(ch =>
                String(ch.volume) === String(volume) && String(ch.number) === String(number));
            if (chapter?.urls) return chapter.urls[branchId ?? 'default'] || chapter.urls.default;
            const bid = branchId != null ? `?bid=${encodeURIComponent(branchId)}` : '';
            return `${this.config.siteUrl}/ru/${slug}/read/v${volume}/c${number}${bid}`;
        }

        /**
         * Освобождает ресурсы режима DOM (закрывает служебную вкладку) и кэш изображений.
         * @returns {Promise<void>}
         */
        async dispose() {
            this._imageCache.clear();
            if (this._domScraper) {
                const scraper = this._domScraper;
                this._domScraper = null;
                await scraper.close();
            }
        }

        /**
         * Проверяет, относится ли URL к хостам MangaLib.
         * @param {string} url - Проверяемый URL.
         * @returns {boolean} true, если хост URL принадлежит MangaLib.
         */
        static matches(url) {
            try {
                const { hostname } = new URL(url);
                return /mangalib\.me$/i.test(hostname) ||
                    /imgslib\.link$/i.test(hostname) ||
                    /mangalib\.org$/i.test(hostname);
            } catch {
                return false;
            }
        }

        /**
         * Извлекает список страниц главы в унифицированном текстовом формате.
         * @param {object} content - Сырое содержимое главы от API.
         * @returns {{type: 'image', src: string}[]} Список страниц как изображений.
         */
        extractText(content) {
            const pages = this.extractPages(content);
            if (pages.length > 0) {
                return pages.map(page => {
                    if (typeof page === 'string')
                        return { type: 'image', src: page };
                    else if (page && page.filename)
                        return { type: 'image', src: page.filename };
                    else if (page && page.url)
                        return { type: 'image', src: page.url };
                    else if (page && page.src)
                        return { type: 'image', src: page.src };
                    return { type: 'image', src: String(page) };
                });
            }
            return [];
        }

        /**
         * Возвращает конфигурацию сервера изображений.
         * @returns {{domain: string, compress: boolean, apiParam: string}} Конфигурация сервера.
         */
        _getActiveServer() {
            return { domain: this.config.imagesDomain, compress: true, apiParam: 'compress' };
        }

        /**
         * Загружает данные главы, всегда запрашивая изображения со "сжатого" сервера.
         * @param {string} slug - Slug тайтла.
         * @param {*} number - Номер главы.
         * @param {*} [volume='1'] - Номер тома.
         * @param {?number} [branchId] - id ветки перевода.
         * @param {{onProgress?: function(string): void}} [opts] - Статус подготовки главы
         * (в режиме DOM; по умолчанию — общий статус сервиса).
         * @returns {Promise<?object>} Данные главы от API.
         */
        async fetchChapter(slug, number, volume = '1', branchId = null, opts = {}) {
            if (!this.isDomMode) return this._fetchChapterApi(slug, number, volume, branchId);

            // Сборщик берётся синхронно, до первого await: подготовка, запущенная заранее,
            // не должна создать новую служебную вкладку после окончания загрузки.
            const scraper = this._getDomScraper();
            if (this._domTitle?.slug !== slug) await this._loadDomTitle(slug);
            const url = this._resolveDomChapterUrl(slug, number, volume, branchId);
            const pages = await scraper.fetchChapterPages(url, {
                checkpoint: () => this.checkpoint(),
                onProgress: opts?.onProgress || (m => this._reportStatus(m))
            });
            return { data: { pages } };
        }

        /**
         * Загружает главу через API. Если сайт ответил успешно, но без страниц (так бывает
         * после множества запросов подряд, хотя на сайте глава читается), запрос
         * повторяется после пауз со снижением темпа — загрузка пережидает ограничение сайта
         * (до 60 минут ожидания, см. RequestPacer), а не останавливается сразу.
         * @param {string} slug - Slug тайтла.
         * @param {*} number - Номер главы.
         * @param {*} volume - Номер тома.
         * @param {?number} branchId - id ветки перевода.
         * @returns {Promise<?object>} Данные главы от API.
         */
        async _fetchChapterApi(slug, number, volume, branchId) {
            const pacer = typeof global.getRequestPacer === 'function' ? global.getRequestPacer('site') : null;
            for (let attempt = 1; ; attempt++) {
                const data = await super.fetchChapter(slug, number, volume, branchId, { server: 'compress' });
                const raw = data?.data || data || {};
                if (this.extractPages(raw.content || raw).length) return data;

                const reason = raw.toast?.message || data?.toast?.message || '';
                const label = `глава без страниц${reason ? ` («${reason}»)` : ''}`;
                console.warn(`[MangaLibService] Empty chapter v${volume} c${number}, retry ${attempt}`, raw);
                // Пауза и снижение темпа — как при ответе «слишком много запросов»; когда
                // запас ожидания исчерпан, RequestPacer остановит загрузку с объяснением.
                if (pacer) await pacer.throttled(200, null, label);
                else if (attempt > EMPTY_CHAPTER_RETRIES) {
                    throw new Error(`Сайт ${attempt} раза подряд вернул ${label}. Подождите и докачайте, ` +
                        'начиная с этой главы');
                } else await new Promise(resolve => setTimeout(resolve, 30000 * attempt));
                await this.checkpoint();
            }
        }

        /**
         * fetchChapter принимает пятым аргументом опции (а не query-параметры, как у BaseService).
         * @returns {boolean} true.
         */
        get acceptsFetchOptions() {
            return true;
        }

        /**
         * Строит абсолютный URL страницы главы из ссылки (строка, либо объект
         * с полем filename/url/src) на домене активного сервера изображений.
         * @param {*} filename - Ссылка на страницу.
         * @returns {?string} Абсолютный URL страницы, либо null, если filename пуст.
         */
        resolvePageUrl(filename) {
            if (!filename) return null;

            let filenameStr;
            if (typeof filename === 'string')
                filenameStr = filename;
            else if (filename && filename.filename)
                filenameStr = filename.filename;
            else if (filename && filename.url)
                filenameStr = filename.url;
            else if (filename && filename.src)
                filenameStr = filename.src;
            else
                filenameStr = String(filename);

            if (/^https?:\/\//i.test(filenameStr)) return filenameStr;
            const { domain } = this._getActiveServer();
            if (filenameStr.startsWith('/')) return `${domain}${filenameStr}`;
            return `${domain}/${filenameStr}`;
        }

        /**
         * Разбивает аномально длинное изображение на несколько
         * частей по соотношению сторон, близкому к A4, чтобы каждая часть нормально
         * помещалась на страницу файла; изображения с обычным соотношением сторон
         * возвращаются без изменений.
         * @param {string} base64Data - Исходное изображение в base64.
         * @param {string} contentType - MIME-тип исходного изображения.
         * @param {{format?: string, quality?: number}} [compressOpts] - Формат и качество
         * для перекодирования частей через canvas.
         * @returns {Promise<{base64: string, contentType: string}[]>} Список частей
         * изображения (один элемент, если разбиение не потребовалось).
         */
        splitLongImage(base64Data, contentType, compressOpts = {}) {
            return new Promise((resolve) => {
                const img = new Image();
                const dataUrl = `data:${contentType};base64,${base64Data}`;
                const outputFormat = compressOpts.format || contentType || 'image/jpeg';
                const quality = compressOpts.quality || 0.92;

                img.onload = () => {
                    const A4_RATIO = 297 / 210;
                    const imgRatio = img.height / img.width;

                    if (imgRatio <= A4_RATIO * 1.1) {
                        resolve([{ base64: base64Data, contentType }]);
                        return;
                    }

                    const numParts = Math.ceil(imgRatio / A4_RATIO);
                    const partHeight = Math.floor(img.height / numParts);

                    const parts = [];
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = img.width;

                    for (let i = 0; i < numParts; i++) {
                        const y = i * partHeight;
                        const h = (i === numParts - 1) ? (img.height - y) : partHeight;

                        canvas.height = h;
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        if (outputFormat === 'image/jpeg') {
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, canvas.width, h);
                        }
                        ctx.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);

                        const partDataUrl = canvas.toDataURL(outputFormat, quality);
                        const [, partBase64] = partDataUrl.split(',');

                        parts.push({ base64: partBase64, contentType: outputFormat });
                    }

                    console.log(`[MangaLibService] Split image into ${parts.length} parts (ratio: ${imgRatio.toFixed(2)})`);
                    resolve(parts);
                };

                img.onerror = () => {
                    console.warn('[MangaLibService] Error loading image for splitting');
                    resolve([{ base64: base64Data, contentType }]);
                };

                img.src = dataUrl;
            });
        }

        /**
         * Извлекает и разрешает абсолютный URL страницы из ссылки произвольной формы.
         * @param {*} ref - Ссылка на страницу.
         * @returns {?string} Абсолютный URL страницы, либо null, если формат не распознан.
         */
        _resolveRefUrl(ref) {
            if (typeof ref === 'string') return this.resolvePageUrl(ref);
            if (ref.filename) return this.resolvePageUrl(ref.filename);
            if (ref.url) {
                const { url } = ref;
                if (/^https?:\/\//i.test(url)) return url;
                if (url.startsWith('//')) return this.resolvePageUrl(url.slice(1));
                return this.resolvePageUrl(url);
            }
            if (ref.image) return this.resolvePageUrl(ref.image);
            if (ref.src) return this.resolvePageUrl(ref.src);
            return null;
        }

        /**
         * Обрабатывает изображение страницы.
         * @param {string} base64Data - Исходное изображение в base64.
         * @param {string} contentType - MIME-тип исходного изображения.
         * @param {object} compressOpts - Опции сжатия.
         * @param {boolean} splitLongImages - Нужно ли разбивать длинные изображения на части.
         * @returns {Promise<{base64: string, contentType: string}|{base64: string, contentType: string}[]>}
         * Обработанное изображение, либо массив частей, если было выполнено разбиение.
         */
        async _processImage(base64Data, contentType, compressOpts, splitLongImages) {
            // Оригинальная страница без разрезания и перекодирования (CBZ хранит файлы как есть).
            if (!splitLongImages && !compressOpts.maxWidth && this.config.keepOriginalImages)
                return { base64: base64Data, contentType: this._sniffImageType(base64Data, contentType) };

            if (splitLongImages) {
                const parts = await this.splitLongImage(base64Data, contentType, compressOpts);
                if (parts.length > 1) {
                    if (!compressOpts.maxWidth || !global.ImageCompressor) return parts;
                    return Promise.all(parts.map(part =>
                        global.ImageCompressor.compress(part.base64, part.contentType, compressOpts)));
                }
                const [raw] = parts;
                return global.ImageCompressor
                    ? global.ImageCompressor.compress(raw.base64, raw.contentType, compressOpts)
                    : raw;
            }
            return global.ImageCompressor
                ? global.ImageCompressor.compress(base64Data, contentType, compressOpts)
                : { base64: base64Data, contentType };
        }

        /**
         * Определяет настоящий тип изображения по сигнатуре файла: сервер может отдать
         * неточный Content-Type, а от типа зависит расширение файла внутри CBZ.
         * @param {string} base64Data - Изображение в base64.
         * @param {string} fallback - Тип, заявленный сервером.
         * @returns {string} MIME-тип изображения.
         */
        _sniffImageType(base64Data, fallback) {
            let bytes = '';
            try {
                bytes = atob(String(base64Data || '').slice(0, 24));
            } catch (e) {
                return fallback || 'image/jpeg';
            }
            if (bytes.startsWith('\xFF\xD8\xFF')) return 'image/jpeg';
            if (bytes.startsWith('\x89PNG')) return 'image/png';
            if (bytes.startsWith('GIF8')) return 'image/gif';
            if (bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') return 'image/webp';
            if (/^ftypavi[fs]$/.test(bytes.slice(4, 12))) return 'image/avif';
            return fallback || 'image/jpeg';
        }

        /**
         * Загружает изображение страницы через общий fetchPageImage (background/вкладка).
         * @param {string} url - URL изображения.
         * @returns {Promise<?object>} Результат загрузки, либо null при ошибке.
         */
        async _fetchWithCompressionFallback(url) {
            // В режиме DOM картинку только что загрузила читалка — берём её из кэша браузера.
            const response = await global.fetchPageImage(url, this.name,
                { throttleOn403: true, cached: this.isDomMode });
            if (response?.ok) return response;
            this._lastImageError = response?.error || 'сервер изображений не ответил';
            console.warn(`[MangaLibService] Failed to fetch ${url}:`, response?.error);
            return null;
        }

        /**
         * Загружает и обрабатывает (при необходимости разбивает/сжимает) одну
         * страницу главы, кэшируя результат по разрешённому URL, чтобы не
         * загружать одно и то же изображение повторно.
         * @param {*} ref - Ссылка на страницу.
         * @param {{compressionFormat?: string, compressionQuality?: number,
         * splitLongImages?: boolean, imageFit?: object}} [opts] - Параметры обработки изображения.
         * @returns {Promise<?({base64: string, contentType: string}|
         * {base64: string, contentType: string}[])>} Обработанное изображение
         * (или массив частей), либо null при ошибке.
         */
        async loadPageAsBase64(ref, opts = {}) {
            try {
                if (!ref) return null;

                const url = this._resolveRefUrl(ref);
                if (!url) {
                    console.warn('[MangaLibService] Could not resolve page url for', ref);
                    return null;
                }

                if (this._imageCache.has(url)) return this._imageCache.get(url);

                if (!this.extensionApi?.runtime?.sendMessage) {
                    console.error('[MangaLibService] browser.runtime not available!');
                    return null;
                }

                const response = await this._fetchWithCompressionFallback(url);
                if (!response) return null;

                const compressOpts = {
                    format: opts.compressionFormat || 'image/jpeg',
                    quality: opts.compressionQuality || 0.92,
                    ...opts.imageFit
                };
                const result = await this._processImage(
                    response.base64,
                    response.contentType || 'image/jpeg',
                    compressOpts,
                    opts.splitLongImages ?? !!this.config.splitLongImages
                );

                this._imageCache.set(url, result);
                return result;
            } catch (e) {
                if (global.NoServiceTabError && e instanceof global.NoServiceTabError) throw e;
                if (e?.aborted || e?.rateLimited) throw e;
                this._lastImageError = e?.message || String(e);
                console.error('[MangaLibService] loadPageAsBase64 error', e);
                return null;
            }
        }

        /**
         * Загружает все страницы главы пакетами (по 5 одновременно), обновляя
         * статус прогресса, и приводит результат к унифицированному формату
         * содержимого главы.
         * @param {Array} extracted - Список страниц, извлечённых extractText.
         * @param {?{textContent: string}} status - Элемент статуса для отображения прогресса.
         * @param {object} [opts] - Опции обработки (chapterMeta, chapterObj, splitLongImages,
         * compressionFormat, compressionQuality, imageFit).
         * @returns {Promise<object[]>} Список элементов содержимого главы.
         */
        async processChapterContent(extracted, status, opts = {}) {
            const chapterMeta = opts.chapterMeta || {};
            const chapterObj = opts.chapterObj || {};

            let pages = [];
            try {
                pages = this.extractPages(chapterMeta) || this.extractPages(chapterObj) || [];
                if ((!pages || pages.length === 0) && Array.isArray(extracted) && extracted.length)
                    pages = extracted.filter(b => b && b.src).map(b => b.src);
            } catch (e) {
                pages = [];
            }

            const strict = !!this.config.strictErrors;
            if (strict && pages.length === 0)
                throw new Error('Глава не содержит страниц (возможно, она платная или недоступна)');

            // Кэш нужен только в пределах главы; без очистки он копит все страницы тайтла в памяти.
            this._imageCache.clear();
            this._lastImageError = null;

            const loadOpts = {
                splitLongImages: opts.splitLongImages ?? !!this.config.splitLongImages,
                compressionFormat: opts.compressionFormat || 'image/jpeg',
                compressionQuality: opts.compressionQuality || 0.92,
                imageFit: opts.imageFit
            };

            /**
             * Загружает страницу; в строгом режиме — с повторными попытками.
             * @param {*} page - Ссылка на страницу.
             * @returns {Promise<?object>} Изображение или null.
             */
            const loadWithRetry = async (page) => {
                const attempts = strict ? PAGE_ATTEMPTS : 1;
                for (let attempt = 1; attempt <= attempts; attempt++) {
                    const img = await this.loadPageAsBase64(page, loadOpts);
                    if (img) return img;
                    if (attempt < attempts) await this.interruptibleDelay(1500 * attempt);
                }
                return null;
            };

            // Пул загрузчиков: следующая страница начинается, как только освободился любой из них
            // (а не после самой медленной страницы пачки). Реальное число одновременных запросов
            // и их темп задаёт полоса «картинки» RequestPacer — она же снижает их при отказах.
            const images = new Array(pages.length).fill(null);
            let nextIndex = 0;
            let completed = 0;
            let failure = null;
            this._reportStatus(`Загружено страниц: 0/${pages.length}`);

            const worker = async () => {
                while (!failure && nextIndex < pages.length) {
                    const index = nextIndex;
                    nextIndex += 1;
                    try {
                        const img = await loadWithRetry(pages[index]);
                        if (!img && strict) {
                            const reason = this._lastImageError ? `: ${this._lastImageError}` : '';
                            throw new Error(`Не удалось загрузить страницу ${index + 1} из ${pages.length} ` +
                                `(попыток: ${PAGE_ATTEMPTS})${reason}`);
                        }
                        images[index] = img;
                    } catch (err) {
                        const fatal = (global.NoServiceTabError && err instanceof global.NoServiceTabError) ||
                            err?.aborted || err?.rateLimited || strict;
                        if (fatal) {
                            failure = failure || err;
                            return;
                        }
                        console.warn(`[MangaLibService] Failed to load page ${index + 1}:`, err);
                    }
                    completed += 1;
                    this._reportStatus(`Загружено страниц: ${completed}/${pages.length}`);
                }
            };

            await Promise.all(Array.from({ length: Math.min(PAGE_WORKERS, pages.length) }, worker));
            if (failure) throw failure;
            if (status && !this.onStatus) status.textContent = `Загружено страниц: ${completed}/${pages.length}`;

            return images.flatMap((img, index) => this._pageBlocks(img, index));
        }

        /**
         * Превращает загруженную страницу (или её части после разбиения) в блоки
         * содержимого главы; незагруженная страница становится текстом-заглушкой
         * (только в нестрогом режиме — в строгом до этого не доходит).
         * @param {?(object|object[])} img - Изображение, массив частей или null.
         * @param {number} index - Индекс страницы в главе.
         * @returns {object[]} Блоки содержимого.
         */
        _pageBlocks(img, index) {
            if (!img) return [{ type: 'text', text: `[Ошибка загрузки изображения ${index + 1}]` }];
            if (!Array.isArray(img))
                return [{ type: 'image', id: `manga_img_${Date.now()}_${index}`, data: img, originalIndex: index }];
            return img.map((part, partIndex) => ({
                type: 'image',
                id: `manga_img_${Date.now()}_${index}_part${partIndex}`,
                data: part,
                originalIndex: index,
                partIndex,
                totalParts: img.length
            }));
        }
    }

    global.MangaLibService = MangaLibService;
    if (global.serviceRegistry) global.serviceRegistry.register(MangaLibService);
    console.log('[MangaLibService] Loaded');
})(typeof window !== 'undefined' ? window : self);