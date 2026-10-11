/**
 * DownloadLib core module
 * Manages manga downloads from various services
 * @module core/DownloadManager
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[DownloadManager] Loading...');

    let activeGate = null;
    let activeStats = null;

    /**
     * Сколько скачанных глав может ждать записи на диск, пока качается следующая.
     * 1 — запись главы N идёт параллельно со скачиванием N+1, но N+2 ждёт записи N.
     */
    const SAVE_BACKLOG = 1;

    /**
     * Ждёт промис, но прекращает ожидание сразу, как только загрузку остановили
     * (или отменили внутренне): сам запрос во вкладке сайта не прерывается, но
     * результат больше никому не нужен. Без этого «Завершить» ждал запросов, которые
     * сервер держит открытыми (до минуты и дольше).
     * @param {Promise<*>} promise - Ожидаемая операция.
     * @param {?{controller: object, cancelled?: boolean, interrupted?: boolean}} gate - Гейт загрузки.
     * @returns {Promise<*>} Результат операции.
     * @throws {Error} С полем aborted=true, если загрузку остановили раньше, чем операция завершилась.
     */
    async function abortable(promise, gate) {
        if (!gate?.controller) return promise;
        promise.catch(() => {});
        let timer = null;
        const stopped = new Promise((_, reject) => {
            const check = () => {
                if (!gate.controller.shouldStop() && !gate.cancelled) return;
                clearInterval(timer);
                gate.interrupted = true;
                const error = new Error('Download aborted');
                error.aborted = true;
                reject(error);
            };
            timer = setInterval(check, 150);
            check();
        });
        try {
            return await Promise.race([promise, stopped]);
        } finally {
            clearInterval(timer);
        }
    }

    /**
     * Заглушка статистики, если модуль DownloadStats не загружен.
     */
    const NULL_STATS = {
        setTotal() {}, imageDone() {}, chapterDone() {}, setPrefetch() {},
        log() {}, finish() {}, snapshot() { return null; }
    };

    /**
     * Габариты, в которые вписываются изображения FB2 при включённой настройке.
     * Okular вёрстает FB2 на страницы 600×800 с полями 20px и режет картинки,
     * не помещающиеся по высоте; запас по высоте — на отступы абзаца и строки.
     */
    const FB2_IMAGE_FIT = { maxWidth: 560, maxHeight: 740 };

    /**
     * Функция, прерывающая загрузку при паузе или завершении загрузки.
     * @param { DownloadManager } controller - Контроллер загрузки,
     * предоставляющий методы для проверки состояния загрузки.
     * @returns {interrupted: boolean, checkpoint: function(): Promise<void> } - Флаги состояния загрузки
     * и функция для проверки состояния загрузки.
     */
    function createGate(controller) {
        const gate = {
            controller,
            interrupted: false,
            // cancelled — внутренняя отмена фоновых операций (подготовки следующей главы)
            // после завершения или ошибки загрузки; в отличие от stop() не трогает UI.
            cancelled: false,
            async checkpoint() {
                if (!gate.cancelled) await controller.waitIfPaused();
                if (controller.shouldStop() || gate.cancelled) {
                    gate.interrupted = true;
                    const error = new Error('Download aborted');
                    error.aborted = true;
                    throw error;
                }
            }
        };
        return gate;
    }

    /**
     * Оркестрирует полный жизненный цикл загрузки тайтла с сервиса или обновления
     * существующего файла: получение метаданных и глав, скачивание содержимого
     * с учётом паузы/остановки, разбиение результата на файлы по лимиту размера
     * и сохранение готовых файлов.
     */
    class DownloadManager {
        /**
         * Создаёт менеджер с пустой картой активных загрузок и собственной шиной событий.
         */
        constructor() {
            this.activeDownloads = new Map();
            this.eventBus = new global.EventBus();
            console.log('[DownloadManager] Instance created');
        }

        /**
         * Создаёт экспортёр указанного формата, при необходимости предварительно
         * догружая плагины (если формат не зарегистрирован стандартными экспортёрами).
         * @param {string} format - Ключ формата экспорта.
         * @returns {Promise<object>} Экземпляр экспортёра.
         */
        async _createExporter(format) {
            if (!global.ExporterRegistry.getSupportedFormats().includes(format.toLowerCase()) &&
                global.PluginManager) {
                console.log(`[DownloadManager] Format "${format}" not registered, loading plugins...`);
                await global.PluginManager.loadAll();
            }
            return global.ExporterRegistry.create(format);
        }

        /**
         * Определяет экземпляр сервиса по ключу или по URL и, при наличии токена,
         * подставляет его в заголовок Authorization конфигурации сервиса.
         * @param {?string} serviceKey - Ключ сервиса (приоритетнее url).
         * @param {?string} url - URL тайтла, используется, если serviceKey не передан.
         * @param {?string} authToken - Токен авторизации для подстановки в заголовки.
         * @param {?string} [sourceMode] - Способ получения данных ('api' | 'dom'), если сервис
         * поддерживает выбор.
         * @returns {object} Экземпляр сервиса.
         */
        _resolveService(serviceKey, url, authToken, sourceMode = null) {
            let service;
            if (serviceKey) {
                service = global.serviceRegistry.createService(serviceKey);
                if (!service) throw new Error(`Unknown service: ${serviceKey}`);
            } else if (url)
                service = global.serviceRegistry.getServiceByUrl(url);
            else
                throw new Error('Either serviceKey or url must be provided');

            if (!service) throw new Error('Unsupported service');

            if (authToken)
                service.config.headers = { ...service.config.headers, 'Authorization': `Bearer ${authToken}` };

            if (sourceMode && typeof service.setSourceMode === 'function')
                service.setSourceMode(sourceMode);

            return service;
        }

        /**
         * Строит начальное состояние новой загрузки на основе переданных опций.
         * @param {object} options - Опции запуска загрузки (см. startDownload).
         * @param {object} service - Разрешённый экземпляр сервиса.
         * @returns {object} Начальное состояние загрузки, регистрируемое в activeDownloads.
         */
        _createDownloadState(options, service) {
            const { url, format = 'fb2', slug, serviceKey, controller,
                loadedFile, maxSizeMB = 200, splitPages = null, fitFb2Images = false,
                saver = null, sourceMode = 'api' } = options;
            const downloadId = this.generateId();
            const config = service.config || {};
            return {
                stats: global.DownloadStats ? new global.DownloadStats() : NULL_STATS,
                saver,
                sourceMode,
                splitByChapter: !!config.splitByChapter,
                singleFile: !!config.singleFile,
                chaptersTotal: 0,
                strictErrors: !!config.strictErrors,
                savedChapters: 0,
                id: downloadId,
                service: service.name,
                serviceKey,
                slug: slug || this.extractSlug(url),
                format,
                maxSizeMB,
                // Разрезание длинных страниц задаётся конфигом сервиса (у MangaLib выключено).
                splitPages: splitPages ?? !!config.splitLongImages,
                imageFit: fitFb2Images && format === 'fb2' ? FB2_IMAGE_FIT : null,
                status: 'initializing',
                progress: 0,
                controller: controller || this.createController(),
                loadedFile,
                manga: null,
                mangaId: null,
                coverBase64: null,
                chapterContents: [],
                chapters: [],
                currentChapterIndex: 0
            };
        }

        /**
         * Загружает список глав тайтла у сервиса, сортирует их и фильтрует
         * по ветке перевода и/или диапазону индексов.
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки (используется slug).
         * @param {?number} branchId - id ветки перевода для фильтрации, либо null.
         * @param {?{from: number, to: number}} chapterRange - Диапазон индексов глав, либо null.
         * @returns {Promise<object[]>} Отфильтрованный и отсортированный список глав.
         */
        async _fetchAndFilterChapters(service, downloadState, branchId, chapterRange) {
            const chaptersData = await service.fetchChaptersList(downloadState.slug);
            // Сервисы с ненадёжными номерами томов (com-x) отдают главы уже в порядке сайта.
            const list = chaptersData.data || [];
            let chapters = service.config?.keepChapterOrder ? list.slice() : this.sortChapters(list);

            if (branchId != null) {
                chapters = chapters
                    .filter(ch => ch.branches && ch.branches.some(b => b.branch_id === branchId))
                    .map(ch => ({ ...ch, branchId }));
                console.log(`[DownloadManager] Filtered chapters by branch ${branchId}: ${chapters.length}`);
            }

            // Сколько глав у тайтла (в выбранном переводе) — чтобы понять, скачан ли он целиком.
            downloadState.chaptersTotal = chapters.length;

            if (chapterRange && 'from' in chapterRange && 'to' in chapterRange) {
                chapters = chapters.slice(chapterRange.from, chapterRange.to + 1);
                console.log(`[DownloadManager] Filtered chapters: ${chapters.length} from ${chapterRange.from} to ${chapterRange.to}`);
            }

            return chapters;
        }

        /**
         * Открывает и поддерживает long-lived порт подключения к background-скрипту
         * (с автопереподключением при разрыве), чтобы service worker не выгружался
         * во время длительной загрузки.
         * @returns {?{stopped: boolean, port: ?object, interval: ?number,
         * reconnectTimer: ?number}} Объект состояния keep-alive, либо null,
         * если runtime.connect недоступен.
         */
        _startKeepAlive() {
            const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : global.extensionApi;
            if (!api?.runtime?.connect) return null;

            const state = { stopped: false, port: null, interval: null, reconnectTimer: null };

            const connect = () => {
                if (state.stopped) return;
                try {
                    const port = api.runtime.connect({ name: 'downloadKeepAlive' });
                    state.port = port;
                    state.interval = setInterval(() => {
                        try {
                            port.postMessage({ type: 'ping' });
                        } catch (e) {
                            clearInterval(state.interval);
                        }
                    }, 20000);
                    port.onDisconnect?.addListener?.(() => {
                        clearInterval(state.interval);
                        if (state.stopped) return;
                        state.reconnectTimer = setTimeout(connect, 2000);
                    });
                } catch (e) {
                    console.warn('[DownloadManager] Failed to start keep-alive port:', e.message);
                }
            };

            connect();
            return state;
        }

        /**
         * Останавливает keep-alive порт: снимает таймеры и отключает соединение.
         * @param {?object} keepAlive - Объект состояния, возвращённый _startKeepAlive.
         * @returns {void}
         */
        _stopKeepAlive(keepAlive) {
            if (!keepAlive) return;
            keepAlive.stopped = true;
            clearInterval(keepAlive.interval);
            clearTimeout(keepAlive.reconnectTimer);
            try {
                keepAlive.port?.disconnect();
            } catch (e) {  }
        }

        /**
         * Запускает полный цикл новой загрузки тайтла: разрешает сервис, создаёт
         * состояние загрузки и keep-alive порт, затем либо обновляет ранее
         * загруженный файл (если передан loadedFile), либо последовательно
         * загружает метаданные, обложку, список глав и содержимое глав с разбиением
         * на файлы по лимиту размера.
         * @param {{url?: string, format?: string, chapterRange?: {from: number, to: number},
         * branchId?: number, maxSizeMB?: number, authToken?: string, loadedFile?: File,
         * serviceKey?: string, slug?: string, controller?: object, splitPages?: boolean,
         * fitFb2Images?: boolean, saver?: object, sourceMode?: string}} options
         * Параметры загрузки. saver — FileSaver выбранной папки (без него файлы уходят
         * в «Загрузки» браузера), sourceMode — способ получения данных ('api' | 'dom').
         * @returns {Promise<{success: boolean, downloadId: string}>} Результат загрузки.
         * @throws {Error} При ошибке на любом из этапов загрузки (после эмиссии download:failed).
         */
        async startDownload(options) {
            console.log('[DownloadManager] Starting download with options:', options);
            const { url, format = 'fb2', chapterRange, branchId = null, maxSizeMB = 200,
                authToken = null, loadedFile, serviceKey, sourceMode = null } = options;

            const service = this._resolveService(serviceKey, url, authToken, sourceMode);
            console.log('[DownloadManager] Using service:', service.name);

            const allowedFormats = service.config?.formats;
            if (Array.isArray(allowedFormats) && !allowedFormats.includes(String(format).toLowerCase())) {
                const list = allowedFormats.map(f => f.toUpperCase()).join(', ');
                const error = new Error(`Формат ${String(format).toUpperCase()} недоступен для ` +
                    `${service.config.label || service.name}. Доступно: ${list}`);
                this.eventBus.emit('download:failed', { downloadState: null, error });
                throw error;
            }

            const downloadState = this._createDownloadState(options, service);
            const { id: downloadId } = downloadState;

            this.activeDownloads.set(downloadId, downloadState);
            this.eventBus.emit('download:started', downloadState);

            const keepAlive = this._startKeepAlive();
            const gate = createGate(downloadState.controller);
            downloadState.gate = gate;
            service._gate = gate;
            activeGate = gate;
            const defaultStatus = (message) => {
                const dl = this.activeDownloads.get(downloadId);
                this.updateStatus(downloadId, message, dl ? dl.progress : 0);
            };
            service.onStatus = defaultStatus;

            const { stats } = downloadState;
            activeStats = stats;
            stats.log('info', `Старт: ${service.config?.label || service.name}, формат ${String(format).toUpperCase()}, ` +
                `способ ${downloadState.sourceMode === 'dom' ? 'DOM' : 'API'}`);

            // Регуляторы запросов (API сайта и CDN картинок): равномерный темп, автоподбор
            // и паузы при ответах «слишком часто». Статус паузы показывается через текущий
            // обработчик сервиса (с номером главы), события — в журнале отладочной панели.
            const pacers = typeof global.prepareRequestPacers === 'function'
                ? global.prepareRequestPacers({
                    rateLimit: options.rateLimit,
                    profile: service.config?.pacing || null,
                    serviceKey: service.name,
                    gate,
                    onStatus: message => (service.onStatus || defaultStatus)(message),
                    onEvent: (level, message) => stats.log(level, message)
                })
                : [];
            if (pacers.length) {
                stats.log('info', `Темп: ${  pacers.map(p => {
                    const d = p.describe();
                    return `${d.label} ${d.rate}/мин (до ${d.max}), потоков ${d.concurrency}`;
                }).join('; ')}`);
            }

            try {
                if (loadedFile) return await this.updateExistingFile(downloadState, service, loadedFile);

                this.updateStatus(downloadId, 'Загрузка метаданных...', 5);
                const metadata = await service.fetchMangaMetadata(downloadState.slug);
                console.log('[DownloadManager] Metadata:', metadata);

                const patched = global.MangaPatcher.patch(metadata.data || metadata);
                downloadState.manga = patched;
                downloadState.mangaId = patched.id || null;

                this.updateStatus(downloadId, 'Загружаем обложку...', 7);
                downloadState.coverBase64 =
                    await this._fetchCoverBase64(service, patched.cover, downloadState.imageFit);

                this.updateStatus(downloadId, 'Загрузка списка глав...', 10);
                const chapters = await this._fetchAndFilterChapters(service, downloadState, branchId, chapterRange);
                downloadState.chapters = chapters;
                stats.setTotal(chapters.length);
                stats.log('info', `Глав к загрузке: ${chapters.length}`);

                if (downloadState.splitByChapter) {
                    if (chapters.length === 0) throw new Error('Нет глав для загрузки');
                    await this.downloadPerChapter(downloadState,
                        service, chapters, patched, downloadState.coverBase64, format);
                    const saved = downloadState.savedChapters;
                    const doneMessage = saved < chapters.length
                        ? `Остановлено. Сохранено глав: ${saved} из ${chapters.length}`
                        : `Готово! Сохранено глав: ${saved}`;
                    this.updateStatus(downloadId, doneMessage, 100);
                } else if (downloadState.singleFile) {
                    if (chapters.length === 0) throw new Error('Нет глав для загрузки');
                    await this.downloadAsSingleFile(downloadState,
                        service, chapters, patched, downloadState.coverBase64, format);
                    this.updateStatus(downloadId, `Готово! Глав в файле: ${downloadState.savedChapters}`, 100);
                } else {
                    await this.downloadWithSizeLimit(downloadState,
                        service, chapters, patched, downloadState.coverBase64, format, maxSizeMB);
                    this.updateStatus(downloadId, 'Готово!', 100);
                }

                this.eventBus.emit('download:completed', downloadState);
                return { success: true, downloadId, savedChapters: downloadState.savedChapters };
            } catch (error) {
                console.error('[DownloadManager] Error:', error);
                stats.log('error', error.message);
                this.updateStatus(downloadId, `Ошибка: ${error.message}`, -1);
                this.eventBus.emit('download:failed', { downloadState, error });
                throw error;
            } finally {
                stats.finish();
                if (activeGate === gate) activeGate = null;
                if (activeStats === stats) activeStats = null;
                if (service._gate === gate) service._gate = null;
                service.onStatus = null;
                for (const pacer of pacers) {
                    pacer.setGate(null);
                    pacer.onStatus = null;
                    pacer.onEvent = null;
                }

                if (typeof service.dispose === 'function') {
                    try {
                        await service.dispose();
                    } catch (e) {
                        console.warn('[DownloadManager] Service dispose failed:', e);
                    }
                }
                this._stopKeepAlive(keepAlive);
                setTimeout(() => this.activeDownloads.delete(downloadId), 5000);
            }
        }

        /**
         * Загружает обложку тайтла и кодирует её в data-URL с base64-содержимым.
         * @param {object} service - Экземпляр сервиса (используется для rate limiting по имени).
         * @param {?string} cover - URL обложки.
         * @param {?{maxWidth: number, maxHeight: number}} [imageFit] - Габариты, в которые
         * вписывается обложка; без них обложка сохраняется как есть.
         * @returns {Promise<string>} data-URL с обложкой, либо пустая строка при
         * отсутствии URL или ошибке загрузки.
         */
        async _fetchCoverBase64(service, cover, imageFit = null) {
            if (!cover || typeof cover !== 'string') return '';
            try {
                const result = await global.fetchViaTab(cover, service.name);
                if (result?.ok) {
                    const { base64, contentType } = imageFit && global.ImageCompressor
                        ? await global.ImageCompressor.compress(result.base64, result.contentType, imageFit)
                        : result;
                    return `data:${contentType};base64,${base64}`;
                }
                console.warn('[DownloadManager] fetchViaTab returned no result for cover');
                return '';
            } catch (e) {
                console.warn('[DownloadManager] Failed to load cover:', e);
                return '';
            }
        }

        /**
         * Оценивает приблизительный размер содержимого главы в байтах (для решения
         * о необходимости разбиения файла по лимиту размера).
         * @param {?{content: Array}} chapter - Обработанное содержимое главы.
         * @returns {number} Оценочный размер в байтах.
         */
        estimateChapterSize(chapter) {
            if (!chapter || !Array.isArray(chapter.content)) return 0;
            let bytes = 0;
            for (const block of chapter.content) {
                if (block.type === 'text' && block.text)
                    bytes += block.text.length * 2;
                else if (block.type === 'image') {
                    const b64 = (block.data && block.data.base64) ? block.data.base64 : '';
                    if (b64) bytes += Math.ceil(b64.length * 3 / 4);
                }
            }
            return bytes;
        }

        /**
         * Возвращает номер тома главы (или '1', если том не указан).
         * @param {{volume?: *}} chapter - Глава.
         * @returns {*} Номер тома.
         */
        _chapterVolume(chapter) {
            return chapter.volume || '1';
        }

        /**
         * Строит суффикс названия файла тома, добавляя номер части при разбиении
         * тома на несколько файлов из-за превышения лимита размера.
         * @param {*} volume - Номер тома.
         * @param {number} partIndex - Порядковый номер части (1 — единственная/первая часть).
         * @returns {string} Суффикс вида " Том N" или " Том N (Часть M)".
         */
        _buildVolumeSuffix(volume, partIndex) {
            return partIndex > 1 ? ` Том ${volume} (Часть ${partIndex})` : ` Том ${volume}`;
        }

        /**
         * Суффикс имени единого файла: если скачан не весь тайтл, в скобках — диапазон,
         * чтобы файлы разных диапазонов не путались.
         * @param {object[]} chapters - Скачанные главы (по порядку).
         * @param {number} total - Сколько глав у тайтла в выбранном переводе.
         * @returns {string} Суффикс вида « (Том 1 Гл. 1 – Том 3 Гл. 20)» или пустая строка.
         */
        _buildRangeSuffix(chapters, total) {
            if (!chapters.length || chapters.length >= total) return '';
            const label = ch => `Том ${this._chapterVolume(ch)} Гл. ${ch.number}`;
            const first = label(chapters[0]);
            const last = label(chapters[chapters.length - 1]);
            return first === last ? ` (${first})` : ` (${first} – ${last})`;
        }

        /**
         * Загружает главы по порядку и сохраняет их одним файлом (ранобэ: в основном текст,
         * поэтому делить на тома и части по размеру не нужно). При остановке сохраняет
         * уже скачанные главы.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} service - Экземпляр сервиса.
         * @param {object[]} chapters - Главы для загрузки.
         * @param {object} manga - Нормализованные метаданные тайтла.
         * @param {string} coverBase64 - Обложка тайтла.
         * @param {string} format - Формат экспорта.
         * @returns {Promise<void>}
         */
        async downloadAsSingleFile(downloadState, service, chapters, manga, coverBase64, format) {
            const { id: downloadId } = downloadState;
            const exporter = await this._createExporter(format);
            const results = await this.downloadChapters(service, downloadState, chapters, null);
            if (!results.length) return;

            const done = chapters.slice(0, results.length);
            const suffix = this._buildRangeSuffix(done, downloadState.chaptersTotal || chapters.length);
            this.updateStatus(downloadId, `Сохранение файла (${results.length} глав)...`, 95);
            const file = await exporter.export({ ...manga, name: manga.name + suffix }, results, coverBase64);
            await this.saveFile(file.blob, file.filename, downloadState.saver);
            downloadState.savedChapters = results.length;
            downloadState.stats?.log('info', `Сохранён файл: ${results.length} глав, ` +
                `${global.DownloadStats ? global.DownloadStats.formatBytes(file.blob.size) : `${file.blob.size} байт`}`);
        }

        /**
         * Загружает содержимое всех глав по порядку и сохраняет результат несколькими
         * файлами — новый файл начинается при смене тома или при превышении лимита
         * размера текущего накопленного файла.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} service - Экземпляр сервиса.
         * @param {object[]} chapters - Список глав для загрузки.
         * @param {object} manga - Нормализованные метаданные тайтла.
         * @param {string} coverBase64 - Обложка тайтла в base64.
         * @param {string} format - Формат экспорта.
         * @param {number} maxSizeMB - Максимальный размер одного файла в мегабайтах.
         * @returns {Promise<void>}
         */
        async downloadWithSizeLimit(downloadState, service, chapters, manga, coverBase64, format, maxSizeMB) {
            const { id: downloadId } = downloadState;
            const maxSizeBytes = maxSizeMB * 1024 * 1024;
            const exporter = await this._createExporter(format);
            let currentBatch = [];
            let currentSize = 0;
            let currentVolume = null;
            let volumePartIndex = 0;

            /**
             * Экспортирует накопленный пакет глав текущего тома в файл и сохраняет
             * его, сбрасывая накопленный пакет и размер.
             * @param {number} progress - Процент прогресса для отображения статуса.
             * @returns {Promise<void>}
             */
            const flushBatch = async (progress) => {
                if (currentBatch.length === 0) return;
                volumePartIndex += 1;
                const suffix = this._buildVolumeSuffix(currentVolume, volumePartIndex);
                this.updateStatus(downloadId, `Сохранение тома ${currentVolume}${volumePartIndex > 1 ? `, часть ${volumePartIndex}` : ''}...`, progress);
                const file = await exporter.export({ ...manga, name: manga.name + suffix }, currentBatch, coverBase64);
                await this.saveFile(file.blob, file.filename, downloadState.saver);
                currentBatch = [];
                currentSize = 0;
            };

            service._on429 = () => {
                const dl = this.activeDownloads.get(downloadId);
                this.updateStatus(downloadId, 'Ожидание разрешения от сервера...', dl ? dl.progress : 0);
            };

            try {
                for (let i = 0; i < chapters.length; i++) {
                    await downloadState.controller.waitIfPaused();
                    if (downloadState.controller.shouldStop()) break;

                    downloadState.currentChapterIndex = i;
                    const chapter = chapters[i];
                    const progress = Math.floor((i / chapters.length) * 80) + 10;
                    this.updateStatus(downloadId, `Глава ${i + 1}/${chapters.length}: ${chapter.name || chapter.number}`, progress);

                    const chapterResult = await this.downloadSingleChapter(service, downloadState, chapter);
                    if (downloadState.gate?.interrupted) break;
                    const chapterSize = this.estimateChapterSize(chapterResult);
                    const chapterVolume = this._chapterVolume(chapter);
                    const volumeChanged = currentBatch.length > 0 && chapterVolume !== currentVolume;
                    const sizeExceeded = currentBatch.length > 0 && currentSize + chapterSize > maxSizeBytes;

                    if (volumeChanged || sizeExceeded) {
                        await flushBatch(progress);
                        if (volumeChanged) volumePartIndex = 0;
                    }

                    if (currentBatch.length === 0) currentVolume = chapterVolume;
                    currentBatch.push(chapterResult);
                    currentSize += chapterSize;

                    downloadState.chapterContents.push(chapterResult);
                }
            } finally {
                service._on429 = null;
            }

            await flushBatch(95);
        }

        /**
         * Дополняет нулями целую часть номера тома/главы, чтобы файлы сортировались
         * в правильном порядке («Глава 0009» перед «Глава 0010»).
         * @param {*} value - Номер (может быть дробным, например «10.5»).
         * @param {number} width - Ширина целой части.
         * @returns {string} Номер с ведущими нулями.
         */
        _padNumber(value, width) {
            const str = String(value ?? '');
            const [intPart, ...rest] = str.split('.');
            if (!/^\d+$/.test(intPart)) return str;
            return [intPart.padStart(width, '0'), ...rest].join('.');
        }

        /**
         * Строит имя файла отдельной главы: «Тайтл - Том 01 Глава 0012 - Название.ext».
         * @param {string} title - Название тайтла.
         * @param {object} chapter - Глава (volume, number, name).
         * @param {{volume: number, number: number}} widths - Ширина номеров тома и главы.
         * @param {string} exportedName - Имя файла, предложенное экспортёром (берётся расширение).
         * @returns {string} Имя файла.
         */
        _buildChapterFilename(title, chapter, widths, exportedName) {
            const ext = /\.([a-z0-9]+)$/i.exec(exportedName || '')?.[1] || 'bin';
            let base;
            if (chapter.order != null && chapter.label) {
                // Сайты с ненадёжной нумерацией томов (com-x): порядковый номер на сайте
                // для правильной сортировки файлов + название главы как на сайте.
                const order = this._padNumber(chapter.order, widths.order);
                base = `${title} - ${order} - ${String(chapter.label).trim().substring(0, 80)}`;
            } else {
                const vol = this._padNumber(this._chapterVolume(chapter), widths.volume);
                const num = this._padNumber(chapter.number ?? '0', widths.number);
                const chapterName = String(chapter.name || '').trim().substring(0, 60);
                base = `${title} - Том ${vol} Глава ${num}${chapterName ? ` - ${chapterName}` : ''}`;
            }
            const safe = typeof global.sanitizeFileName === 'function'
                ? global.sanitizeFileName(base, 'chapter')
                : base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_'); // eslint-disable-line no-control-regex
            return `${safe}.${ext}`;
        }

        /**
         * Вычисляет ширину номеров томов и глав для выравнивания имён файлов.
         * @param {object[]} chapters - Список глав.
         * @returns {{volume: number, number: number}} Ширина целой части номеров.
         */
        _chapterNumberWidths(chapters) {
            const width = values => Math.max(2, ...values.map(v => String(v ?? '').split('.')[0].length));
            return {
                volume: width(chapters.map(ch => this._chapterVolume(ch))),
                number: width(chapters.map(ch => ch.number)),
                order: Math.max(3, ...chapters.map(ch => String(ch.order ?? '').length))
            };
        }

        /**
         * Оборачивает ошибку загрузки главы в сообщение, понятное пользователю:
         * какая глава, что случилось и сколько глав уже сохранено.
         * @param {Error} error - Исходная ошибка.
         * @param {object} chapter - Глава, на которой произошла ошибка.
         * @param {?number} saved - Сколько глав уже сохранено (null — файлы ещё не сохранялись).
         * @param {number} total - Сколько глав было запрошено.
         * @returns {Error} Новая ошибка с исходной в поле cause.
         */
        _chapterError(error, chapter, saved, total) {
            const label = chapter.label || `Том ${this._chapterVolume(chapter)} Глава ${chapter.number}`;
            const tail = saved == null
                ? 'Загрузка остановлена, файл не изменён'
                : `Загрузка остановлена, сохранено глав: ${saved} из ${total}`;
            const wrapped = new Error(`Ошибка в главе «${label}»: ${error?.message || error}. ${tail}`);
            wrapped.cause = error;
            return wrapped;
        }

        /**
         * Загружает главы и сохраняет каждую отдельным файлом. Работает конвейером
         * из трёх этапов, идущих одновременно:
         *  1. подготовка — список страниц следующей главы (запрос к API или читалка в режиме DOM);
         *  2. загрузка — картинки текущей главы;
         *  3. сохранение — сборка файла и запись предыдущей главы (строго по порядку).
         * В памяти одновременно не больше двух-трёх глав. Ошибка любой главы прерывает
         * загрузку, уже сохранённые главы остаются на диске.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} service - Экземпляр сервиса.
         * @param {object[]} chapters - Список глав для загрузки.
         * @param {object} manga - Нормализованные метаданные тайтла.
         * @param {string} coverBase64 - Обложка тайтла в base64.
         * @param {string} format - Формат экспорта.
         * @returns {Promise<void>}
         * @throws {Error} Если не удалось загрузить или сохранить главу.
         */
        async downloadPerChapter(downloadState, service, chapters, manga, coverBase64, format) {
            const { id: downloadId, stats } = downloadState;
            const exporter = await this._createExporter(format);
            const widths = this._chapterNumberWidths(chapters);
            const total = chapters.length;
            const shortLabel = ch => ch.label || `Том ${this._chapterVolume(ch)} Гл. ${ch.number}`;
            downloadState.savedChapters = 0;
            if (stats) stats.setTotal(total);

            service._on429 = () => {
                const dl = this.activeDownloads.get(downloadId);
                this.updateStatus(downloadId, 'Ожидание разрешения от сервера...', dl ? dl.progress : 0);
            };

            /**
             * Запускает подготовку главы заранее; ошибка будет обработана, когда до неё дойдёт очередь.
             * @param {number} index - Индекс главы.
             * @returns {Promise<object>} Подготовленная глава.
             */
            const prepare = (index) => {
                const chapter = chapters[index];
                const onStatus = message => stats?.setPrefetch(`${shortLabel(chapter)} — ${message}`);
                if (stats) stats.setPrefetch(`${shortLabel(chapter)} — получение списка страниц...`);
                const promise = this._prepareChapter(service, downloadState, chapter, onStatus)
                    .finally(() => stats?.setPrefetch(''));
                promise.catch(() => {});
                return promise;
            };

            let saveChain = Promise.resolve();
            let saveError = null;
            let pending = total > 0 ? prepare(0) : null;
            // Завершение записи каждой главы: загрузка не уходит вперёд записи больше чем
            // на SAVE_BACKLOG глав. Иначе при медленной записи скачанные главы копятся
            // в памяти, и после «Завершить»/«Пауза» файлы продолжают появляться ещё долго.
            const saveDone = [];
            let lastBacklogLog = 0;

            try {
                for (let i = 0; i < total; i++) {
                    await downloadState.controller.waitIfPaused();
                    if (downloadState.controller.shouldStop()) break;
                    if (saveError) throw saveError;

                    downloadState.currentChapterIndex = i;
                    const chapter = chapters[i];
                    const label = `Глава ${i + 1} из ${total} · ${shortLabel(chapter)}`;
                    const progress = Math.floor((i / total) * 85) + 10;

                    const waitFor = saveDone[i - 1 - SAVE_BACKLOG];
                    if (waitFor) {
                        const waitStarted = Date.now();
                        this.updateStatus(downloadId, label, progress, 'Ожидание записи предыдущей главы на диск...');
                        await waitFor;
                        const waited = Date.now() - waitStarted;
                        if (stats && waited > 1000 && Date.now() - lastBacklogLog > 60000) {
                            lastBacklogLog = Date.now();
                            stats.log('info', `Запись файлов медленнее загрузки — загрузка ждёт диск ` +
                                `(${(waited / 1000).toFixed(1)} с)`);
                        }
                        await downloadState.controller.waitIfPaused();
                        if (downloadState.controller.shouldStop()) break;
                        if (saveError) throw saveError;
                    }

                    const started = Date.now();
                    // Заголовок (глава) и детали (страницы, паузы) — отдельными строками,
                    // чтобы текст не менял длину и не сдвигал интерфейс при каждом обновлении.
                    this.updateStatus(downloadId, label, progress, 'Подготовка страниц...');
                    service.onStatus = message => this.updateStatus(downloadId, label, progress, message);

                    let chapterResult;
                    try {
                        const prepared = await pending;
                        pending = i + 1 < total ? prepare(i + 1) : null;
                        chapterResult = await this._loadChapterContent(service, downloadState, chapter, prepared);
                    } catch (error) {
                        if (error?.aborted || downloadState.gate?.interrupted) break;
                        await saveChain;
                        if (saveError) throw saveError;
                        throw this._chapterError(error, chapter, downloadState.savedChapters, total);
                    }
                    if (downloadState.gate?.interrupted) break;

                    // Сохранение — в фоне, строго по порядку глав; загрузка идёт дальше.
                    saveChain = saveChain.then(async () => {
                        if (saveError) return;
                        try {
                            const saveStarted = Date.now();
                            const volume = this._chapterVolume(chapter);
                            const file = await exporter.export(
                                { ...manga, seriesName: manga.name, name: `${manga.name} - Том ${volume} Глава ${chapter.number}` },
                                [chapterResult],
                                coverBase64
                            );
                            const filename = this._buildChapterFilename(manga.name, chapter, widths, file.filename);
                            await this.saveFile(file.blob, filename, downloadState.saver);
                            downloadState.savedChapters += 1;
                            if (stats) {
                                stats.chapterDone(shortLabel(chapter), file.blob.size, Date.now() - started,
                                    Date.now() - saveStarted);
                            }
                        } catch (error) {
                            saveError = this._chapterError(error, chapter, downloadState.savedChapters, total);
                        }
                    });
                    saveDone[i] = saveChain;
                }

                await saveChain;
                if (saveError) throw saveError;
            } finally {
                // Отменяем подготовку следующей главы и дожидаемся записи уже скачанных.
                if (downloadState.gate) downloadState.gate.cancelled = true;
                if (downloadState.controller.shouldStop()) {
                    const dl = this.activeDownloads.get(downloadId);
                    this.updateStatus(downloadId, 'Остановка загрузки', dl ? dl.progress : 0,
                        'Новые главы не скачиваются, дописывается последняя скачанная...');
                    if (stats) stats.log('info', 'Нажато «Завершить»: скачивание остановлено');
                }
                await saveChain;
                if (pending) await Promise.race([pending.catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
                if (stats) stats.setPrefetch('');
                service._on429 = null;
                service.onStatus = null;
            }
        }

        /**
         * Этап 1: получает список страниц главы (запрос к API или читалка в режиме DOM).
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} chapter - Метаданные главы.
         * @param {?function(string): void} [onStatus] - Статус подготовки (для отладочной панели).
         * @returns {Promise<{rawContent: object, extracted: *}>} Подготовленная глава.
         */
        async _prepareChapter(service, downloadState, chapter, onStatus = null) {
            const fetchArgs = [downloadState.slug, chapter.number, chapter.volume || '1', chapter.branchId ?? null];
            // Пятый аргумент у базового сервиса — query-параметры запроса, поэтому опции
            // передаются только сервисам, которые их явно поддерживают.
            if (service.acceptsFetchOptions) fetchArgs.push({ onProgress: onStatus, chapter });
            const chapterData = await service.fetchChapter(...fetchArgs);

            const rawContent = chapterData?.data || chapterData || {};
            const contentToExtract = rawContent.content || rawContent;
            const extracted = service.extractText ? service.extractText(contentToExtract) : contentToExtract;
            return { rawContent, extracted };
        }

        /**
         * Этап 2: загружает картинки (обрабатывает содержимое) подготовленной главы.
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} chapter - Метаданные главы.
         * @param {{rawContent: object, extracted: *}} prepared - Результат _prepareChapter.
         * @returns {Promise<{title: string, content: Array, volume: *, number: *}>} Глава для экспортёра.
         */
        async _loadChapterContent(service, downloadState, chapter, prepared) {
            const { rawContent, extracted } = prepared;
            const processedContent = service.processChapterContent
                ? await service.processChapterContent(
                    extracted,
                    document.getElementById('status'),
                    {
                        chapterMeta: rawContent,
                        chapterObj: chapter,
                        mangaSlug: downloadState.slug,
                        mangaId: downloadState.mangaId,
                        splitLongImages: downloadState.splitPages && downloadState.format !== 'simple',
                        imageFit: downloadState.imageFit
                    }
                )
                : extracted;

            return {
                title: chapter.name || `Том ${chapter.volume}, Глава ${chapter.number}`,
                content: processedContent,
                volume: chapter.volume,
                number: chapter.number
            };
        }

        /**
         * Загружает и обрабатывает содержимое одной главы: получает сырые данные
         * от сервиса, извлекает страницы/текст и прогоняет через обработку контента
         * (сжатие изображений и т.п.). При ошибке возвращает главу с текстом-заглушкой
         * вместо содержимого, не прерывая общую загрузку.
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} chapter - Метаданные главы (number, volume, branchId, name).
         * @returns {Promise<{title: string, content: Array, volume: *, number: *}>}
         * Готовое содержимое главы для экспортёра.
         */
        async downloadSingleChapter(service, downloadState, chapter) {
            try {
                const prepared = await this._prepareChapter(service, downloadState, chapter);
                const result = await this._loadChapterContent(service, downloadState, chapter, prepared);
                if (downloadState.stats) downloadState.stats.chapterDone();
                return result;
            } catch (error) {
                console.error(`[DownloadManager] Failed to download chapter ${chapter.number}:`, error);
                // Строгий режим: ошибка поднимается наверх и показывается пользователю,
                // вместо того чтобы попасть в файл текстом-заглушкой.
                if (downloadState.strictErrors || error?.rateLimited) throw error;
                return {
                    title: chapter.name || `Том ${chapter.volume}, Глава ${chapter.number}`,
                    content: [{ type: 'text', text: `[Ошибка загрузки главы: ${error.message}]` }],
                    volume: chapter.volume,
                    number: chapter.number
                };
            }
        }

        /**
         * Обновляет ранее загруженный файл: сверяет главы на сервере с главами
         * в файле, докачивает недостающие/пустые главы, объединяет результат
         * с существующим содержимым и пересохраняет файл(ы) с учётом лимита размера.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object} service - Экземпляр сервиса.
         * @param {File} loadedFile - Ранее загруженный файл для обновления.
         * @returns {Promise<{success: boolean, downloadId: string, updated: boolean,
         * addedChapters?: number}>} Результат обновления: updated=false, если файл уже
         * содержит все главы.
         * @throws {Error} При ошибке разбора файла или загрузки недостающих глав.
         */
        async updateExistingFile(downloadState, service, loadedFile) {
            const { id: downloadId, slug, format } = downloadState;

            try {
                this.updateStatus(downloadId, 'Загрузка списка глав с сервера...', 5);
                const chaptersData = await service.fetchChaptersList(slug);
                const serverChapters = this.sortChapters(chaptersData.data || []);

                this.updateStatus(downloadId, 'Анализ существующего файла...', 10);
                const exporter = await this._createExporter(format);

                const existingData = exporter.parse ?
                    await exporter.parse(loadedFile) :
                    await this.parseFile(loadedFile, format);

                console.log('[DownloadManager] Existing chapters:', existingData.chapters.length);

                const chaptersToDownload = this.findMissingChapters(
                    serverChapters,
                    existingData.chapters
                );

                console.log('[DownloadManager] Chapters to download:', chaptersToDownload.length);

                if (chaptersToDownload.length === 0) {
                    this.updateStatus(downloadId, 'Файл уже актуален!', 100);
                    this.eventBus.emit('download:completed', downloadState);
                    return { success: true, downloadId, updated: false };
                }

                downloadState.chapters = serverChapters;
                downloadState.manga = existingData.metadata;
                downloadState.coverBase64 = existingData.cover;

                const newChapterContents = await this.downloadSpecificChapters(
                    service,
                    downloadState,
                    chaptersToDownload,
                    serverChapters.length
                );

                this.updateStatus(downloadId, 'Объединение глав...', 90);
                const mergedChapters = this.mergeChapters(
                    existingData.chapters,
                    newChapterContents,
                    serverChapters,
                    { skipMissing: downloadState.strictErrors }
                );

                const patch = global.MangaPatcher.patch(existingData.metadata);

                // Единый файл (ранобэ): все главы — в один обновлённый файл.
                if (downloadState.singleFile) {
                    this.updateStatus(downloadId, `Создание обновлённого ${format.toUpperCase()}...`, 95);
                    const file = await exporter.export(patch, mergedChapters, existingData.cover);
                    await this.saveFile(file.blob, file.filename, downloadState.saver);
                    this.updateStatus(downloadId, 'Файл обновлён!', 100);
                    this.eventBus.emit('download:completed', downloadState);
                    return { success: true, downloadId, updated: true, addedChapters: chaptersToDownload.length };
                }

                const maxSizeBytes = (downloadState.maxSizeMB || 200) * 1024 * 1024;
                let currentBatch = [];
                let currentSize = 0;
                let currentVolume = null;
                let volumePartIndex = 0;

                /**
                 * Экспортирует накопленный пакет объединённых глав текущего тома
                 * в обновлённый файл и сохраняет его, сбрасывая накопленный пакет и размер.
                 * @param {number} progress - Процент прогресса для отображения статуса.
                 * @returns {Promise<void>}
                 */
                const flushMergedBatch = async (progress) => {
                    if (currentBatch.length === 0) return;
                    volumePartIndex += 1;
                    const suffix = this._buildVolumeSuffix(currentVolume, volumePartIndex);
                    this.updateStatus(downloadId, `Создание обновлённого ${format.toUpperCase()} - том ${currentVolume}${volumePartIndex > 1 ? `, часть ${volumePartIndex}` : ''}...`, progress);
                    const file = await exporter.export(
                        { ...patch, name: patch.name + suffix }, currentBatch, existingData.cover
                    );
                    await this.saveFile(file.blob, file.filename, downloadState.saver);
                    currentBatch = [];
                    currentSize = 0;
                };

                for (const chapter of mergedChapters) {
                    const chapterSize = this.estimateChapterSize(chapter);
                    const chapterVolume = this._chapterVolume(chapter);
                    const volumeChanged = currentBatch.length > 0 && chapterVolume !== currentVolume;
                    const sizeExceeded = currentBatch.length > 0 && currentSize + chapterSize > maxSizeBytes;

                    if (volumeChanged || sizeExceeded) {
                        await flushMergedBatch(93);
                        if (volumeChanged) volumePartIndex = 0;
                    }

                    if (currentBatch.length === 0) currentVolume = chapterVolume;
                    currentBatch.push(chapter);
                    currentSize += chapterSize;
                }

                await flushMergedBatch(95);

                this.updateStatus(downloadId, 'Файл обновлён!', 100);
                this.eventBus.emit('download:completed', downloadState);

                return {
                    success: true,
                    downloadId,
                    updated: true,
                    addedChapters: chaptersToDownload.length
                };
            } catch (error) {
                console.error('[DownloadManager] Update error:', error);
                this.updateStatus(downloadId, `Ошибка обновления: ${error.message}`, -1);
                this.eventBus.emit('download:failed', { downloadState, error });
                throw error;
            }
        }

        /**
         * Разбирает ранее скачанный файл в унифицированную структуру (метаданные,
         * обложка, главы), используя парсер соответствующего формата.
         * @param {File} file - Файл для разбора.
         * @param {string} format - Формат файла ('fb2', 'epub', 'mobi', 'simple').
         * @returns {Promise<{metadata: object, cover: string, chapters: object[]}>}
         * Разобранное содержимое файла.
         * @throws {Error} Если формат не поддерживается для парсинга (в т.ч. 'pdf').
         */
        async parseFile(file, format) {
            if (format === 'fb2') {
                const text = await this.readFileAsText(file);
                const exporter = global.ExporterRegistry.create('fb2');
                return exporter.parseFB2(text, file.name);
            } else if (format === 'epub') {
                const exporter = global.ExporterRegistry.create('epub');
                return await exporter.parseEPUB(file);
            } else if (format === 'mobi') {
                const exporter = global.ExporterRegistry.create('mobi');
                return await exporter.parse(file);
            } else if (format === 'simple') {
                const exporter = global.ExporterRegistry.create('simple');
                return await exporter.parse(file);
            } else if (format === 'pdf')
                throw new Error('PDF парсинг пока не реализован');

            throw new Error(`Unsupported format: ${format}`);
        }

        /**
         * Читает содержимое файла как текст в кодировке UTF-8.
         * @param {File} file - Читаемый файл.
         * @returns {Promise<string>} Текстовое содержимое файла.
         */
        readFileAsText(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsText(file, 'utf-8');
            });
        }

        /**
         * Находит главы, отсутствующие в ранее загруженном файле (или пустые из-за
         * прошлой ошибки загрузки), начиная с первой главы, совпадающей с содержимым
         * файла (главы до этой точки, добавленные позже на сервере задним числом,
         * не считаются пропущенными).
         * @param {object[]} serverChapters - Актуальный список глав с сервера.
         * @param {object[]} existingChapters - Главы, уже присутствующие в файле.
         * @returns {object[]} Список глав с сервера, которые нужно докачать.
         */
        findMissingChapters(serverChapters, existingChapters) {
            if (existingChapters.length === 0) return [];

            const existingKeys = new Set();
            for (const ch of existingChapters)
                existingKeys.add(this.getChapterKey(ch));

            let startIndex = -1;
            for (let i = 0; i < serverChapters.length; i++) {
                if (existingKeys.has(this.getChapterKey(serverChapters[i]))) {
                    startIndex = i;
                    break;
                }
            }

            if (startIndex === -1) return [];

            const missing = [];
            for (let i = startIndex; i < serverChapters.length; i++) {
                const serverCh = serverChapters[i];
                const key = this.getChapterKey(serverCh);

                if (!existingKeys.has(key))
                    missing.push(serverCh);
                else {
                    const existingCh = existingChapters.find(ch => this.getChapterKey(ch) === key);
                    if (existingCh && this.isChapterEmpty(existingCh)) missing.push(serverCh);
                }
            }

            return missing;
        }

        /**
         * Строит уникальный ключ главы по номеру тома и главы, используемый для
         * сопоставления глав с сервера и глав в загруженном файле.
         * @param {{volume?: *, number?: *}} chapter - Глава.
         * @returns {string} Ключ вида "v{том}_ch{номер}".
         */
        getChapterKey(chapter) {
            const vol = chapter.volume || '1';
            const num = chapter.number || '0';
            return `v${vol}_ch${num}`;
        }

        /**
         * Проверяет, пуста ли глава (нет содержимого, либо всё содержимое —
         * прошлая ошибка загрузки).
         * @param {{content?: Array}} chapter - Глава из существующего файла.
         * @returns {boolean} true, если глава не содержит полезного контента.
         */
        isChapterEmpty(chapter) {
            if (!chapter.content || !Array.isArray(chapter.content)) return true;

            const hasContent = chapter.content.some(block => {
                if (block.type === 'text') {
                    const text = block.text || '';
                    return text.trim() && !text.includes('[Ошибка загрузки главы');
                } else if (block.type === 'image')
                    return block.data && (block.data.base64 || block.data.src);
                return false;
            });

            return !hasContent;
        }

        /**
         * Докачивает заданный список конкретных глав (используется при обновлении
         * существующего файла), обрабатывая ошибки отдельных глав без прерывания
         * общего процесса.
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object[]} chaptersToDownload - Список глав, которые нужно докачать.
         * @returns {Promise<object[]>} Список загруженных (или с текстом ошибки) глав,
         * в том же порядке, что и chaptersToDownload.
         */
        async downloadSpecificChapters(service, downloadState, chaptersToDownload) {
            const results = [];
            const total = chaptersToDownload.length;

            for (let i = 0; i < total; i++) {
                await downloadState.controller.waitIfPaused();
                if (downloadState.controller.shouldStop()) break;

                const chapter = chaptersToDownload[i];
                const progress = Math.floor(((i / total) * 80) + 10);

                this.updateStatus(
                    downloadState.id,
                    `Загрузка главы ${i + 1}/${total}: ${chapter.name || chapter.number}`,
                    progress
                );

                try {
                    const fetchArgs = [downloadState.slug, chapter.number, chapter.volume || '1'];
                    if (chapter.branchId != null) fetchArgs.push(chapter.branchId);
                    const chapterData = await service.fetchChapter(...fetchArgs);

                    const rawContent = chapterData.data || chapterData;
                    const contentToExtract = rawContent.content || rawContent;

                    const extractedContent = service.extractText
                        ? service.extractText(contentToExtract)
                        : contentToExtract;

                    const processedContent = service.processChapterContent
                        ? await service.processChapterContent(
                            extractedContent,
                            document.getElementById('status'),
                            {
                                chapterMeta: rawContent,
                                chapterObj: chapter,
                                mangaSlug: downloadState.slug,
                                mangaId: downloadState.mangaId,
                                splitLongImages: downloadState.splitPages && downloadState.format !== 'simple',
                                imageFit: downloadState.imageFit
                            }
                          )
                        : extractedContent;

                    const chapterResult = {
                        title: chapter.name || `Том ${chapter.volume}, Глава ${chapter.number}`,
                        content: processedContent,
                        volume: chapter.volume,
                        number: chapter.number
                    };

                    if (downloadState.gate?.interrupted) break;
                    results.push(chapterResult);
                } catch (error) {
                    if (error?.aborted || downloadState.gate?.interrupted) break;
                    console.error(`[DownloadManager] Failed to download chapter ${chapter.number}:`, error);
                    if (downloadState.strictErrors || error?.rateLimited)
                        throw this._chapterError(error, chapter, null, total);
                    const errorChapter = {
                        title: chapter.name || `Том ${chapter.volume}, Глава ${chapter.number}`,
                        content: [{
                            type: 'text',
                            text: `[Ошибка загрузки главы: ${error.message}]`
                        }],
                        volume: chapter.volume,
                        number: chapter.number
                    };

                    results.push(errorChapter);
                }
            }

            return results;
        }

        /**
         * Объединяет главы из существующего файла с вновь докачанными главами
         * в порядке актуального списка глав на сервере, подставляя заглушку
         * для глав, которых нет ни там, ни там.
         * @param {object[]} existingChapters - Главы из ранее загруженного файла.
         * @param {object[]} newChapters - Вновь докачанные главы.
         * @param {object[]} serverChapters - Актуальный список глав с сервера (задаёт порядок).
         * @param {{skipMissing?: boolean}} [opts] - skipMissing: не добавлять заглушки
         * для отсутствующих глав (строгий режим), а пропускать их.
         * @returns {object[]} Итоговый список глав для пересборки файла.
         */
        mergeChapters(existingChapters, newChapters, serverChapters, opts = {}) {
            const newChaptersMap = new Map();
            for (const ch of newChapters) {
                const key = this.getChapterKey(ch);
                newChaptersMap.set(key, ch);
            }

            const existingMap = new Map();
            for (const ch of existingChapters) {
                const key = this.getChapterKey(ch);
                existingMap.set(key, ch);
            }

            const result = [];

            for (const serverCh of serverChapters) {
                const key = this.getChapterKey(serverCh);

                if (newChaptersMap.has(key))
                    result.push(newChaptersMap.get(key));
                else if (existingMap.has(key))
                    result.push(existingMap.get(key));
                else if (!opts.skipMissing) {
                    result.push({
                        title: serverCh.name || `Том ${serverCh.volume}, Глава ${serverCh.number}`,
                        content: [{
                            type: 'text',
                            text: '[Глава не загружена]'
                        }],
                        volume: serverCh.volume,
                        number: serverCh.number
                    });
                }
            }

            return result;
        }

        /**
         * Возвращает публичный снимок состояния активной загрузки (без служебных
         * полей вроде controller и gate).
         * @param {string} downloadId - id загрузки.
         * @returns {?object} Снимок состояния загрузки, либо null, если загрузка не найдена.
         */
        getDownloadState(downloadId) {
            const state = this.activeDownloads.get(downloadId);
            if (!state) return null;

            return {
                slug: state.slug,
                serviceKey: state.serviceKey,
                format: state.format,
                manga: state.manga,
                coverBase64: state.coverBase64,
                chapterContents: state.chapterContents,
                chapters: state.chapters,
                currentChapterIndex: state.currentChapterIndex,
                currentStatus: state.status,
                currentProgress: state.progress,
                loadedFile: state.loadedFile
            };
        }

        /**
         * Загружает содержимое списка глав по порядку с учётом паузы/остановки,
         * не выполняя разбиение на файлы по размеру (используется вызывающей
         * стороной, которая сама управляет сохранением файлов).
         * @param {object} service - Экземпляр сервиса.
         * @param {object} downloadState - Текущее состояние загрузки.
         * @param {object[]} chapters - Главы для загрузки в этом вызове.
         * @param {?function} onProgress - Не используется напрямую (прогресс идёт через updateStatus);
         * оставлено для совместимости сигнатуры.
         * @param {number} [startIndex=0] - Смещение для расчёта общего прогресса и currentChapterIndex.
         * @param {?number} [totalChapters] - Общее число глав для расчёта процента (по умолчанию chapters.length).
         * @returns {Promise<object[]>} Список загруженного содержимого глав.
         */
        async downloadChapters(service, downloadState, chapters, onProgress, startIndex = 0, totalChapters = null) {
            const results = [];
            const total = totalChapters || chapters.length;

            service._on429 = () => {
                const dl = this.activeDownloads.get(downloadState.id);
                this.updateStatus(downloadState.id, 'Ожидание разрешения от сервера...', dl ? dl.progress : 0);
            };

            try {
                for (let i = 0; i < chapters.length; i++) {
                    await downloadState.controller.waitIfPaused();
                    if (downloadState.controller.shouldStop()) break;

                    downloadState.currentChapterIndex = startIndex + i;

                    const chapter = chapters[i];
                    const globalIndex = startIndex + i;
                    const progress = Math.floor((globalIndex / total) * 80) + 10;

                    // Две строки статуса, как у манги: глава — в заголовке, её название — в деталях.
                    this.updateStatus(
                        downloadState.id,
                        `Глава ${globalIndex + 1} из ${total} · Том ${this._chapterVolume(chapter)} Гл. ${chapter.number}`,
                        progress,
                        chapter.name || ''
                    );

                    const chapterResult = await this.downloadSingleChapter(service, downloadState, chapter);
                    if (downloadState.gate?.interrupted) break;
                    results.push(chapterResult);
                    downloadState.chapterContents.push(chapterResult);
                }
            } finally {
                service._on429 = null;
            }

            return results;
        }

        /**
         * Создаёт контроллер паузы/остановки по умолчанию для загрузки, запущенной
         * без собственного controller в опциях.
         * @returns {{pause: function(): void, resume: function(): void, stop: function(): void,
         * isPaused: function(): boolean, shouldStop: function(): boolean,
         * waitIfPaused: function(): Promise<void>}} Контроллер загрузки.
         */
        createController() {
            let paused = false;
            let stopped = false;

            const isPaused = () => paused;
            const shouldStop = () => stopped;

            return {
                pause: () => { paused = true; },
                resume: () => { paused = false; },
                stop: () => { stopped = true; },
                isPaused,
                shouldStop,
                waitIfPaused: async () => {
                    while (isPaused() && !shouldStop())
                        await new Promise(resolve => setTimeout(resolve, 100));
                }
            };
        }

        /**
         * Обновляет статус и прогресс активной загрузки и эмитит событие download:progress.
         * @param {string} downloadId - id загрузки.
         * @param {string} message - Текст статуса.
         * @param {number} progress - Процент выполнения (0-100, -1 при ошибке).
         * @param {string} [detail] - Вторая строка статуса (страницы главы, паузы сервера).
         * @returns {void}
         */
        updateStatus(downloadId, message, progress, detail = '') {
            const download = this.activeDownloads.get(downloadId);
            if (download) {
                download.status = message;
                download.statusDetail = detail;
                download.progress = progress;
                this.eventBus.emit('download:progress', download);
            }
        }

        /**
         * Сортирует главы по возрастанию номера тома, а внутри тома — по номеру главы.
         * @param {object[]} chapters - Список глав (сортируется на месте).
         * @returns {object[]} Тот же массив, отсортированный.
         */
        sortChapters(chapters) {
            return chapters.sort((a, b) => {
                const volA = parseInt(a.volume) || 0;
                const volB = parseInt(b.volume) || 0;
                if (volA !== volB) return volA - volB;
                return (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
            });
        }

        /**
         * Извлекает slug тайтла из URL страницы манги/книги.
         * @param {string} url - URL страницы тайтла.
         * @returns {?string} Slug тайтла, либо null, если URL не соответствует ожидаемому формату.
         */
        extractSlug(url) {
            const match = url.match(/\/(?:manga|book)\/([^/?]+)/);
            return match ? match[1] : null;
        }

        /**
         * Генерирует уникальный id новой загрузки.
         * @returns {string} Строка вида "download_<timestamp>_<random>".
         */
        generateId() {
            return `download_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        /**
         * Сохраняет готовый файл: в папку, выбранную пользователем (saver), иначе через
         * FileUtils.downloadBlob, если доступен, иначе через временную ссылку-скачивание.
         * @param {Blob} blob - Содержимое файла.
         * @param {string} filename - Имя сохраняемого файла.
         * @param {?{save: function(Blob, string): Promise<void>}} [saver] - Сохранитель выбранной папки.
         * @returns {Promise<void>}
         */
        async saveFile(blob, filename, saver = null) {
            if (saver) await saver.save(blob, filename);
            else if (global.FileUtils)
                await global.FileUtils.downloadBlob(blob, filename);
            else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();

                setTimeout(() => {
                    URL.revokeObjectURL(url);
                    a.remove();
                }, 10000);
            }
        }

        /**
         * Ставит активную загрузку на паузу и эмитит событие download:paused.
         * @param {string} downloadId - id загрузки.
         * @returns {void}
         */
        pause(downloadId) {
            const download = this.activeDownloads.get(downloadId);
            if (download) {
                download.controller.pause();
                this.eventBus.emit('download:paused', download);
            } else console.log(`[DownloadManager] No active download with ID: ${downloadId}`);
        }

        /**
         * Снимает загрузку с паузы и эмитит событие download:resumed.
         * @param {string} downloadId - id загрузки.
         * @returns {void}
         */
        resume(downloadId) {
            const download = this.activeDownloads.get(downloadId);
            if (download) {
                download.controller.resume();
                this.eventBus.emit('download:resumed', download);
            } else console.log(`[DownloadManager] No active download with ID: ${downloadId}`);
        }

        /**
         * Останавливает активную загрузку и эмитит событие download:stopped.
         * @param {string} downloadId - id загрузки.
         * @returns {void}
         */
        stop(downloadId) {
            const download = this.activeDownloads.get(downloadId);
            if (download) {
                download.controller.stop();
                this.eventBus.emit('download:stopped', download);
            } else console.log(`[DownloadManager] No active download with ID: ${downloadId}`);
        }

        /**
         * Возвращает полное (в т.ч. служебное) внутреннее состояние загрузки.
         * @param {string} downloadId - id загрузки.
         * @returns {?object} Внутреннее состояние загрузки, либо null, если не найдена.
         */
        getStatus(downloadId) {
            return this.activeDownloads.get(downloadId) || null;
        }
    }

    /**
     * Загружает изображение страницы с проверкой контрольных точек прерывания
     * загрузки до и после сетевого запроса (позволяет прервать загрузку максимально
     * быстро, не дожидаясь завершения уже начатого запроса изображения).
     * @param {string} url - URL изображения.
     * @param {string} serviceKey - Ключ сервиса (для rate limiting).
     * @param {{throttleOn403?: boolean}} [policy] - Считать ли ответ 403 сервера изображений
     * ограничением частоты (по умолчанию нет: 403 может означать просто отсутствие файла).
     * @returns {Promise<{ok: boolean, base64?: string, contentType?: string, error?: string}>}
     * Результат загрузки изображения.
     */
    async function fetchPageImage(url, serviceKey, policy = {}) {
        const gate = activeGate;
        if (gate) await gate.checkpoint();
        const result = await fetchPageImageUngated(url, serviceKey, policy);
        if (gate) await gate.checkpoint();
        return result;
    }

    /**
     * Загружает изображение страницы без проверки контрольных точек прерывания:
     * учитывает запрос в общем rate limiter'е и загружает его через вкладку сервиса
     * (fetchViaTab), чтобы браузер сам поставил настоящие Referer/Origin. Если открытой
     * вкладки сервиса нет вообще — бросает NoServiceTabError (а не тихо откатывается на
     * fetch из контекста расширения с подделанными заголовками); если вкладка есть,
     * но сама загрузка не удалась — возвращает ok:false для мягкой постраничной деградации.
     * @param {string} url - URL изображения.
     * @param {string} serviceKey - Ключ сервиса (для rate limiting и выбора вкладки).
     * @param {{throttleOn403?: boolean, cached?: boolean}} [policy] - throttleOn403: считать ли
     * 403 ограничением частоты; cached: картинку только что загрузила читалка сайта (режим DOM),
     * поэтому её можно взять из кэша браузера, не расходуя лимит запросов.
     * @returns {Promise<{ok: boolean, base64?: string, contentType?: string, error?: string}>}
     * Результат загрузки изображения.
     * @throws {Error} NoServiceTabError, если не найдено открытой вкладки сервиса.
     */
    async function fetchPageImageUngated(url, serviceKey, policy = {}) {
        const pacer = typeof global.getRequestPacer === 'function' ? global.getRequestPacer('images') : null;
        const run = () => fetchImageLoop(pacer, url, serviceKey, policy);
        const viaTab = pacer ? await pacer.withPermit(run) : await run();
        if (viaTab?.ok) return viaTab;

        const hasTab = typeof global.hasServiceTab === 'function' && await global.hasServiceTab(serviceKey);
        if (!hasTab) {
            const NoServiceTabError = global.NoServiceTabError || Error;
            throw new NoServiceTabError('Откройте страницу сервиса в отдельной вкладке, чтобы продолжить загрузку');
        }

        return { ok: false, error: viaTab?.status ? `HTTP ${viaTab.status}` : 'Image fetch failed' };
    }

    /**
     * Запрос картинки с учётом темпа полосы «картинки» и пауз при ответах «слишком часто».
     * @param {?object} pacer - Полоса RequestPacer('images').
     * @param {string} url - URL изображения.
     * @param {string} serviceKey - Ключ сервиса.
     * @param {{throttleOn403?: boolean, cached?: boolean}} policy - Политика запроса.
     * @returns {Promise<?object>} Результат fetchViaTab.
     */
    async function fetchImageLoop(pacer, url, serviceKey, policy) {
        const throttleStatuses = policy.throttleOn403 ? [403, 429, 503] : [429, 503];
        let viaTab = null;

        for (;;) {
            // Картинку из кэша браузера не нужно ждать в очереди: она не доходит до сервера.
            // Если её в кэше не оказалось, запрос учитывается после выполнения (charge).
            if (!policy.cached) {
                if (pacer) await pacer.acquire(1);
                else if (global.globalRateLimiter) await global.globalRateLimiter.trackRequest(serviceKey || 'image');
            }
            if (activeGate) await activeGate.checkpoint();

            if (typeof global.fetchViaTab !== 'function') return null;
            viaTab = await abortable(
                global.fetchViaTab(url, serviceKey, policy.cached ? { cache: 'force-cache' } : {}), activeGate);
            if (pacer && policy.cached && !viaTab?.fromCache) pacer.charge(1);

            if (viaTab?.ok) {
                if (pacer) pacer.success();
                const bytes = Math.ceil((viaTab.base64?.length || 0) * 3 / 4);
                if (activeStats) activeStats.imageDone(bytes, !!viaTab.fromCache);
                return viaTab;
            }

            // Сервер изображений просит снизить частоту — пауза для всех запросов полосы и повтор.
            if (pacer && viaTab && throttleStatuses.includes(viaTab.status)) {
                await pacer.throttled(viaTab.status, viaTab.retryAfter);
                continue;
            }
            return viaTab;
        }
    }

    global.DownloadManager = DownloadManager;
    global.fetchPageImage = fetchPageImage;
    global.abortable = abortable;
    console.log('[DownloadManager] Loaded');
})(typeof window !== 'undefined' ? window : self);
