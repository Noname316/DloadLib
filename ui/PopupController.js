/**
 * DownloadLib ui module
 * Module to manage the user interface for manga downloads
 * @module ui/PopupController
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[PopupController] Loading...');

    const browserAPI = typeof global.getExtensionApi === 'function'
        ? global.getExtensionApi()
        : ((typeof global.browser !== 'undefined' && global.browser) ||
            (typeof global.chrome !== 'undefined' && global.chrome) ||
            null);

    if (!browserAPI) {
        console.error('[PopupController] No browser API available');
        return;
    }

    /**
     * Короткий алиас для document.getElementById.
     * @param {string} id - id искомого элемента.
     * @returns {?HTMLElement} Найденный элемент или null.
     */
    function $el(id) {
        return document.getElementById(id);
    }

    const SOURCE_MODE_KEY = 'manga_parser_source_mode';
    const FORMAT_STORAGE_KEY = 'manga_parser_selected_format';
    // Новый ключ: прежняя версия сохраняла «развёрнуто» сама, без действия пользователя.
    const STATS_OPEN_KEY = 'downloadlib_stats_panel_open';
    const STATS_LOG_OPEN_KEY = 'downloadlib_stats_log_open';
    const WINDOW_MIN_HEIGHT = 320;
    const TITLE_JOB_POLL_MS = 400;
    const TITLE_FOLDER_KEY = 'downloadlib_title_folder';
    const SOURCE_MODE_LABELS = { api: 'API', dom: 'DOM (поиск ссылок)' };

    /**
     * Хранилище выбора, действующего только пока открыто окно: каждое новое окно
     * начинает с API и формата по умолчанию (FB2 для RanobeLib), а смена экрана
     * (история, настройки) выбор не сбрасывает.
     * @returns {?Storage} sessionStorage окна или null, если оно недоступно.
     */
    function windowStore() {
        try {
            return global.sessionStorage || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Возвращает способ загрузки, выбранный в этом окне ('api' | 'dom'); по умолчанию — API.
     * @returns {string} Способ загрузки.
     */
    function getSavedSourceMode() {
        try {
            return windowStore()?.getItem(SOURCE_MODE_KEY) === 'dom' ? 'dom' : 'api';
        } catch (e) {
            return 'api';
        }
    }

    /**
     * Главный контроллер попапа расширения: управляет отображением метаданных
     * тайтла, запуском/паузой/остановкой загрузки, переключением между шаблонами
     * (title, settings, history) и состоянием формы скачивания.
     */
    class PopupController {
        /**
         * Создаёт менеджер загрузок и контроллер глав, инициализирует поля состояния
         * загрузки и запускает первичную настройку интерфейса.
         */
        constructor() {
            console.log('[PopupController] Initializing...');
            this.downloadManager = new global.DownloadManager();
            this.chapterController = new global.ChapterController();
            this.isDownloading = false;
            this.isPaused = false;
            this.shouldStop = false;
            this._shellEventsBound = false;
            this.currentDownloadId = null;
            this.currentSlug = null;
            this.currentServiceKey = null;
            this.currentTitle = null;
            this.authToken = null;
            this._activeTabId = null;

            const pauseBtn = $el('pauseBtn');
            const stopBtn = $el('stopBtn');
            if (pauseBtn) {
                pauseBtn.disabled = false;
                pauseBtn.textContent = 'Пауза';
            }
            if (stopBtn) stopBtn.disabled = false;

            this.downloadManager.eventBus.on('download:started', (state) => {
                this.currentDownloadId = state.id;
                this._startStatsRender(state.stats);
                console.log('[PopupController] Download started with ID:', this.currentDownloadId);
            });

            this.subscribeToEvents();
            this._init();

            console.log('[PopupController] Initialized');
        }

        /**
         * Инициализирует TemplateLoader и события оболочки, затем показывает либо
         * экран настроек (если открыт с параметром ?settings), либо главный экран
         * тайтла: загружает метаданные, проверяет здоровье API и подписывается
         * на изменение списка кастомных плагинов для обновления списка форматов.
         * @returns {Promise<void>}
         */
        async _init() {
            global.TemplateLoader.init('view');
            this._bindShellEvents();
            this._setupWindowAutoFit();

            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.has('settings')) {
                await global.TemplateLoader.show('settings', () => global.SettingsController.init());
                return;
            }

            await global.TemplateLoader.show('title');
            this._bindTitleEvents();
            this.setupEventListeners();
            await this.loadMetadata();
            this.checkApiHealth();
        }

        /**
         * Возвращает окно из истории/настроек к основному экрану. Основной экран не
         * пересоздаётся: он был только скрыт, поэтому идущая загрузка, прогресс, кнопки
         * и статистика остаются как были. Если основного экрана ещё нет — строит его.
         * @returns {Promise<void>}
         */
        async _restoreMainView() {
            if (global.TemplateLoader.hideOverlay()) {
                const logoInfo = $el('logoInfo');
                if (logoInfo) logoInfo.textContent = this._logoInfoText || '';
                return;
            }
            await this._reloadMainView();
        }

        /**
         * Строит экран тайтла заново: шаблон, обработчики, метаданные. Нужно, когда
         * меняется то, от чего зависят данные тайтла (например, способ загрузки API/DOM).
         * @returns {Promise<void>}
         */
        async _reloadMainView() {
            const logoInfo = $el('logoInfo');
            if (logoInfo) logoInfo.textContent = '';
            this._logoInfoText = '';
            await global.TemplateLoader.show('title');
            this._bindTitleEvents();
            this.setupEventListeners();
            await this.loadMetadata();
            this.checkApiHealth();
        }

        /**
         * Открывает экран поверх основного (история или настройки) в этом же окне.
         * @param {string} templateName - Шаблон экрана.
         * @param {function(): void} init - Инициализация контроллера экрана.
         * @returns {Promise<void>}
         */
        async _openOverlay(templateName, init) {
            if (global.TemplateLoader.current() === templateName) return;
            const logoInfo = $el('logoInfo');
            if (logoInfo) logoInfo.textContent = '';
            await global.TemplateLoader.showOverlay(templateName, init);
        }

        /**
         * Однократно навешивает обработчики на постоянные элементы оболочки попапа
         * (кнопки истории и настроек), которые не пересоздаются при смене шаблонов.
         * @returns {void}
         */
        _bindShellEvents() {
            if (this._shellEventsBound) return;
            this._shellEventsBound = true;

            const historyBtn = $el('historyBtn');
            if (historyBtn) {
                historyBtn.addEventListener('click', () =>
                    this._openOverlay('history', () => global.HistoryController.init()));
            } else console.warn('[PopupController] historyBtn not found in shell');

            const settingsBtn = $el('settingsBtn');
            if (settingsBtn) {
                // Настройки — в этом же окне, поверх основного экрана (как история).
                settingsBtn.addEventListener('click', () =>
                    this._openOverlay('settings', () => global.SettingsController.init()));
            } else console.warn('[PopupController] settingsBtn not found in shell');
        }

        /**
         * Навешивает обработчики на элементы шаблона title: заполняет и сохраняет выбор
         * формата экспорта, чекбокс разбиения страниц, выбор кастомного файла для
         * обновления и валидацию диапазона выбора глав.
         * @returns {void}
         */
        _bindTitleEvents() {
            const btn = $el('downloadBtn');
            if (!btn) {
                console.error('[PopupController] downloadBtn not found in title template');
                return;
            }

            const formatSelector = $el('formatSelector');
            const chapterFromSelect = $el('chapterFromSelect');
            const chapterToSelect = $el('chapterToSelect');

            this._setVisibility('progress', 'none');
            this._setVisibility('downloadControls', 'none');
            this._setVisibility('downloadInfoPanel', 'none');

            if (formatSelector) {
                this._populateFormats();
                formatSelector.addEventListener('change', () => this._saveSelectedFormat(formatSelector.value));
            }

            // «Создать папку с названием тайтла»: по умолчанию включено, выбор запоминается.
            const titleFolderCheckbox = $el('titleFolderCheckbox');
            if (titleFolderCheckbox) {
                titleFolderCheckbox.checked = localStorage.getItem(TITLE_FOLDER_KEY) !== 'false';
                titleFolderCheckbox.addEventListener('change', () =>
                    localStorage.setItem(TITLE_FOLDER_KEY, String(titleFolderCheckbox.checked)));
            }

            const sourceModeSelect = $el('sourceModeSelect');
            if (sourceModeSelect) {
                sourceModeSelect.value = getSavedSourceMode();
                sourceModeSelect.addEventListener('change', async () => {
                    try { windowStore()?.setItem(SOURCE_MODE_KEY, sourceModeSelect.value); } catch (e) { /* ignore */ }
                    if (this.isDownloading) return;
                    // Другой способ — другие данные тайтла: экран строится заново.
                    await this._reloadMainView();
                });
            }

            if (chapterFromSelect && chapterToSelect) {
                chapterFromSelect.addEventListener('change', () => {
                    if (parseInt(chapterFromSelect.value) > parseInt(chapterToSelect.value))
                        chapterToSelect.value = chapterFromSelect.value;
                    else console.log('[PopupController] Chapter range selectors updated without invalid range');
                });
                chapterToSelect.addEventListener('change', () => {
                    if (parseInt(chapterToSelect.value) < parseInt(chapterFromSelect.value))
                        chapterFromSelect.value = chapterToSelect.value;
                    else console.log('[PopupController] Chapter range selectors updated without invalid range');
                });
            }

            console.log('[PopupController] Title events bound');
        }

        /**
         * Форматы, доступные для текущего сервиса: список config.formats сервиса
         * (в его порядке), либо все зарегистрированные форматы, если сервис их не ограничивает.
         * @returns {{value: string, label: string}[]} Опции формата.
         */
        _allowedFormats() {
            const all = global.ExporterRegistry.getFormats();
            const allowed = this.currentService?.config?.formats;
            if (!Array.isArray(allowed)) return all;
            return allowed.map(value => all.find(f => f.value === value)).filter(Boolean);
        }

        /**
         * Ключ хранения выбранного формата: свой для каждого сервиса, чтобы выбор
         * на одном сайте не подменял формат на другом.
         * @returns {string} Ключ localStorage/storage.local.
         */
        _formatStorageKey() {
            return this.currentServiceKey ? `${FORMAT_STORAGE_KEY}_${this.currentServiceKey}` : FORMAT_STORAGE_KEY;
        }

        /**
         * Заполняет селектор формата разрешёнными для сервиса форматами и выбирает
         * предпочтительный (из URL), выбранный в этом окне или первый доступный (по умолчанию).
         * При единственном доступном формате селектор блокируется.
         * @param {?string} [preferred] - Формат, который нужно выбрать, если он разрешён.
         * @returns {void}
         */
        _populateFormats(preferred = null) {
            const sel = $el('formatSelector');
            if (!sel) return;

            const formats = this._allowedFormats();
            const values = formats.map(f => f.value);
            const current = sel.value;
            sel.innerHTML = '';
            formats.forEach(({ value, label }) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                sel.appendChild(option);
            });

            let saved = null;
            try { saved = windowStore()?.getItem(this._formatStorageKey()) ?? null; } catch (e) { /* ignore */ }
            sel.value = [preferred, current, saved].find(v => v && values.includes(v)) || values[0] || '';
            sel.disabled = formats.length <= 1;
            if (this.currentService) this._saveSelectedFormat(sel.value);
        }

        /**
         * Запоминает выбранный формат для текущего сервиса, пока открыто окно.
         * @param {string} value - Ключ формата.
         * @returns {void}
         */
        _saveSelectedFormat(value) {
            if (!value) return;
            try { windowStore()?.setItem(this._formatStorageKey(), value); } catch (e) { /* ignore */ }
        }

        /**
         * Подгоняет размер отдельного окна расширения (окно загрузки, настройки) под
         * содержимое: при открытии и при каждом изменении высоты содержимого (смена
         * экрана, появление прогресса, сворачивание панели). Окно не выходит за пределы
         * экрана. Если пользователь сам изменил размер окна, автоподгонка отключается.
         * @returns {Promise<void>}
         */
        async _setupWindowAutoFit() {
            if (!browserAPI?.windows?.getCurrent || !browserAPI.windows.update) return;
            const container = $el('container');
            if (!container || typeof ResizeObserver === 'undefined') return;

            let win;
            try {
                win = await browserAPI.windows.getCurrent();
            } catch (e) {
                return;
            }
            // Выпадающий попап тулбара браузер подгоняет сам; вкладка — не наше окно.
            if (!win || win.type !== 'popup' || win.id == null) return;

            let expected = null;
            let userResized = false;
            let timer = null;

            const fit = async () => {
                if (userResized) return;
                const bodyStyle = getComputedStyle(document.body);
                const px = v => parseFloat(v) || 0;
                const rect = container.getBoundingClientRect();
                const scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
                const contentWidth = Math.ceil(rect.width + px(bodyStyle.paddingLeft) + px(bodyStyle.paddingRight) +
                    px(bodyStyle.marginLeft) + px(bodyStyle.marginRight) + scrollbar);
                const contentHeight = Math.ceil(rect.bottom + window.scrollY +
                    px(bodyStyle.paddingBottom) + px(bodyStyle.marginBottom));

                const frameW = Math.max(0, window.outerWidth - window.innerWidth);
                const frameH = Math.max(0, window.outerHeight - window.innerHeight);
                const availTop = screen.availTop || 0;
                const availHeight = screen.availHeight || 900;
                const width = contentWidth + frameW;
                const height = Math.min(availHeight, Math.max(WINDOW_MIN_HEIGHT, contentHeight + frameH));
                if (Math.abs(height - window.outerHeight) < 4 && Math.abs(width - window.outerWidth) < 4) return;

                const update = { width, height };
                // Растущее окно не должно уходить за нижний край экрана.
                if (window.screenY + height > availTop + availHeight)
                    update.top = Math.max(availTop, availTop + availHeight - height);
                expected = { width, height };
                try {
                    await browserAPI.windows.update(win.id, update);
                } catch (e) {
                    console.warn('[PopupController] Window auto-fit failed:', e?.message || e);
                }
            };

            const schedule = () => {
                clearTimeout(timer);
                timer = setTimeout(fit, 120);
            };

            new ResizeObserver(schedule).observe(container);
            window.addEventListener('resize', () => {
                if (!expected) return;
                const off = Math.abs(window.outerHeight - expected.height) > 12 ||
                    Math.abs(window.outerWidth - expected.width) > 12;
                if (off) userResized = true;
            });
            schedule();
        }

        /**
         * Сколько глав выбрано в диапазоне «от/до» (или все, если диапазона нет).
         * @returns {number} Число глав.
         */
        _selectedChapterCount() {
            const from = $el('chapterFromSelect');
            const to = $el('chapterToSelect');
            const container = $el('chapterRangeContainer');
            if (from && to && container && container.style.display !== 'none' && from.options.length)
                return Math.max(0, parseInt(to.value) - parseInt(from.value) + 1);
            return from ? from.options.length : 0;
        }

        /**
         * @returns {string} Ключ выбранного диапазона (подтверждение действует только для него).
         */
        _selectedRangeKey() {
            return `${this.currentServiceKey}|${this.currentSlug}|${$el('chapterFromSelect')?.value}-${$el('chapterToSelect')?.value}`;
        }

        /**
         * Для сайтов, которые ограничивают массовое скачивание (com-x), при выборе больше
         * config.largeDownloadWarning глав первое нажатие «Скачать» показывает предупреждение,
         * второе — запускает загрузку. Если диапазон изменился, предупреждение показывается снова.
         * @returns {boolean} true, если можно начинать загрузку.
         */
        _confirmLargeDownload() {
            const limit = this.currentService?.config?.largeDownloadWarning;
            // В окне из панели диапазон не выбирается — предупреждение покажет окно загрузки.
            if (!limit || !this._inSeparateWindow) return true;
            const count = this._selectedChapterCount();
            if (count <= limit) return true;

            const key = this._selectedRangeKey();
            if (this._largeConfirmedFor === key) return true;
            this._largeConfirmedFor = key;

            const site = this.currentService.config.label || this.currentServiceKey;
            const btn = $el('downloadBtn');
            this.showError(`Выбрано глав: ${count}. ${site} ограничивает массовое скачивание (у сайта есть квота ` +
                `около 150 глав и блокировки за превышение). Нажмите «${btn?.textContent || 'Скачать'}» ещё раз, ` +
                'чтобы продолжить, или уменьшите диапазон.', { persistent: true });
            const status = $el('status');
            if (status) status.textContent = 'Подтвердите загрузку большого числа глав';
            return false;
        }

        /**
         * Восстанавливает свёрнутое/развёрнутое состояние отладочной панели и журнала
         * и запоминает его при переключении.
         * @returns {void}
         */
        _bindStatsToggles() {
            const toggles = [['downloadStats', STATS_OPEN_KEY], ['statsLogWrap', STATS_LOG_OPEN_KEY]];
            for (const [id, key] of toggles) {
                const el = $el(id);
                if (!el || el.dataset.bound) continue;
                el.dataset.bound = 'true';
                try {
                    const saved = localStorage.getItem(key);
                    // По умолчанию отладочная панель свёрнута, журнал внутри неё — развёрнут.
                    if (saved !== null) el.open = saved === 'true';
                } catch (e) { /* localStorage недоступен */ }
                el.addEventListener('toggle', () => {
                    try { localStorage.setItem(key, String(el.open)); } catch (e) { /* ignore */ }
                });
            }
        }

        /**
         * Показывает панель статистики загрузки и обновляет её раз в секунду.
         * @param {?object} stats - DownloadStats текущей загрузки.
         * @returns {void}
         */
        _startStatsRender(stats) {
            this._stopStatsRender(false);
            if (!stats || typeof stats.snapshot !== 'function' || !global.DownloadStats) return;
            this._stats = stats;
            this._statsLogKey = '';
            this._bindStatsToggles();
            this._setVisibility('downloadStats', 'block');
            this._renderStats();
            this._statsTimer = setInterval(() => this._renderStats(), 1000);
        }

        /**
         * Останавливает обновление панели статистики; последняя сводка остаётся на экране.
         * @param {boolean} [renderFinal=true] - Отрисовать итоговое состояние.
         * @returns {void}
         */
        _stopStatsRender(renderFinal = true) {
            if (this._statsTimer) clearInterval(this._statsTimer);
            this._statsTimer = null;
            if (renderFinal && this._stats) this._renderStats();
        }

        /**
         * Отрисовывает панель статистики: время, скорость, объём, темп полос запросов и журнал.
         * @returns {void}
         */
        _renderStats() {
            const s = this._stats?.snapshot();
            if (!s) return;
            const { formatDuration, formatBytes } = global.DownloadStats;
            // Каждое значение — одна строка (длинное обрезается, полный текст во всплывающей подсказке).
            const set = (id, text) => {
                const el = $el(id);
                if (!el || el.textContent === text) return;
                el.textContent = text;
                el.title = text;
            };

            const eta = s.etaMs != null ? ` · осталось ≈ ${formatDuration(s.etaMs)}` : '';
            set('statsElapsed', `${formatDuration(s.elapsedMs)}${s.finished ? ' · завершено' : eta}`);
            set('statsChapters', `${s.chaptersDone} из ${s.totalChapters || '?'} · ${s.chaptersPerMin.toFixed(1)} в мин`);
            const cached = s.cachedPages ? ` · из кэша ${Math.round((s.cachedPages / s.pages) * 100)}%` : '';
            set('statsPages', `${s.pages} · ${Math.round(s.pagesPerMin)} в мин${cached}`);
            set('statsBytes', `${formatBytes(s.bytes)} · ${formatBytes(s.bytesPerSec)}/с`);

            if (typeof global.getRequestPacer === 'function') {
                const lane = (id, name) => {
                    const d = global.getRequestPacer(name).describe();
                    const paused = d.pausedMs ? ` · пауза ${Math.ceil(d.pausedMs / 1000)} с` : '';
                    const threads = name === 'images' ? ` · потоков ${d.active}/${d.concurrency}` : '';
                    set(id, `${d.rate}/мин (до ${d.max})${threads}${paused}`);
                };
                lane('statsLaneSite', 'site');
                lane('statsLaneImages', 'images');
            }
            set('statsPrefetch', s.prefetch || '—');
            // Краткая сводка — видна, когда панель свёрнута.
            set('statsSummary', `· ${formatDuration(s.elapsedMs)} · ${s.chaptersPerMin.toFixed(1)} гл/мин${
                s.etaMs != null ? ` · ост. ≈ ${formatDuration(s.etaMs)}` : ''}`);

            const last = s.events[s.events.length - 1];
            const logKey = `${s.events.length}:${last ? last.time : 0}`;
            if (logKey === this._statsLogKey) return;
            this._statsLogKey = logKey;

            const log = $el('statsLog');
            if (!log) return;
            log.innerHTML = '';
            for (const event of s.events.slice().reverse()) {
                const row = document.createElement('div');
                row.className = `stats-log-row ${event.level}`;
                const time = document.createElement('span');
                time.className = 'stats-log-time';
                time.textContent = new Date(event.time).toLocaleTimeString('ru-RU');
                row.append(time, document.createTextNode(event.message));
                log.appendChild(row);
            }
        }

        /**
         * Устанавливает CSS-свойство display элемента по его id, если элемент найден.
         * @param {string} id - id элемента.
         * @param {string} display - Значение CSS display.
         * @returns {void}
         */
        _setVisibility(id, display) {
            const el = $el(id);
            if (el) el.style.display = display;
        }

        /**
         * Собирает ссылки на все DOM-элементы формы загрузки в один объект для удобной передачи.
         * @returns {object} Объект со ссылками на элементы: btn, formatSelector, status,
         * progress, controls,
         * chapterRangeContainer, fromSelect, toSelect.
         */
        _getDownloadElements() {
            return {
                btn: $el('downloadBtn'),
                formatSelector: $el('formatSelector'),
                status: $el('status'),
                progress: $el('progress'),
                controls: $el('downloadControls'),
                chapterRangeContainer: $el('chapterRangeContainer'),
                fromSelect: $el('chapterFromSelect'),
                toSelect: $el('chapterToSelect')
            };
        }

        /**
         * Определяет, открыт ли попап в отдельном окне (а не как выпадающий попап
         * тулбара): по параметрам URL (download) либо по типу текущего окна.
         * @returns {Promise<boolean>} true, если попап работает как отдельное окно.
         */
        async isInSeparateWindow() {
            try {
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.has('download')) return true;
                const currentWindow = await browserAPI.windows.getCurrent();
                console.log('[PopupController] Window type:', currentWindow.type);
                return currentWindow.type === 'popup';
            } catch (e) {
                console.warn('Failed to detect window type:', e);
                return false;
            }
        }

        /**
         * Открывает URL в новом контексте вне текущего выпадающего попапа: в Firefox —
         * создаёт отдельное окно (или вкладку, если windows API недоступен), в остальных
         * браузерах — просит background-скрипт открыть окно (обходя ограничения closable
         * попапа тулбара при клике на элементы, требующие постоянного окна).
         * @param {string} url - URL, который нужно открыть.
         * @returns {Promise<void>}
         */
        async openInNewContext(url) {
            const isFirefox = typeof global.getBrowserEnv === 'function'
                ? global.getBrowserEnv().isFirefox
                : typeof global.browser !== 'undefined' && !!global.browser;
            if (!isFirefox) {
                browserAPI.runtime.sendMessage({ action: 'openWindowWithUrl', url }).catch(() => {});
                return;
            }
            if (browserAPI.windows) {
                const win = await browserAPI.windows.create({
                    url,
                    type: 'popup',
                    width: 350,
                    height: 650,
                    focused: true,
                    state: 'normal'
                });
                if (win && win.id) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    browserAPI.windows.update(win.id, { focused: true });
                } else console.warn('Window created but no ID found:', win);
            }
            else if (browserAPI.tabs) {
                const tab = await browserAPI.tabs.create({ url, active: true });
                if (!tab) console.warn('Tab created but no ID found:', tab);
            }
            else console.error('No window/tab API available');
        }

        /**
         * Применяет фирменные цвета и логотип сервиса к оформлению попапа.
         * @param {string} serviceKey - Ключ сервиса.
         * @param {?HTMLImageElement} siteLogo - Элемент логотипа сервиса (может отсутствовать).
         * @returns {void}
         */
        _applyServiceTheme(serviceKey, siteLogo) {
            const cfg = global.serviceRegistry?.getService(serviceKey)?.config || {};
            const set = (name, value) => {
                if (value) document.body.style.setProperty(name, value);
                else document.body.style.removeProperty(name);
            };
            set('--primary-color', cfg.primaryColor || '#ff9100');
            set('--secondary-color', cfg.secondaryColor || '#c77101');
            // Фон, панели и цвет текста на кнопках; без них — значения из css/ui.css.
            set('--bg-color', cfg.backgroundColor);
            set('--panel-color', cfg.panelColor);
            set('--panel-dark', cfg.panelDarkColor);
            set('--on-primary', cfg.onPrimaryColor);
            set('--text-color', cfg.textColor);
            if (siteLogo) siteLogo.src = cfg.logo || 'icons/logo1.png';
            else console.warn('Site logo element not found when setting logo for service:', serviceKey);
        }

        /**
         * Применяет параметры подпапки и максимального размера части, переданные через
         * URL попапа (используется при открытии попапа из фонового скрипта с заранее
         * заданными настройками). Формат из URL применяется позже, в _populateFormats,
         * когда известен сервис и список разрешённых для него форматов.
         * @param {{maxSizeMBFromUrl: ?string, subfolderFromUrl: ?string}} params - Значения параметров из URL.
         * @returns {void}
         */
        _applyUrlParams({ maxSizeMBFromUrl, subfolderFromUrl }) {
            if (typeof subfolderFromUrl === 'string') {
                const subfolderInput = $el('saveSubfolderInput');
                if (subfolderInput) subfolderInput.value = subfolderFromUrl;
            }

            if (maxSizeMBFromUrl)
                localStorage.setItem('manga_parser_max_size_mb', maxSizeMBFromUrl);
        }

        /**
         * Отрисовывает нормализованные метаданные тайтла: обложку (с догрузкой через
         * фоновый fetch), заголовок и краткое описание, сводку "глав/рейтинг/авторы"
         * и дату выхода.
         * @param {{patched: object, chaptersCount: ?number, slug: string, coverImg: HTMLImageElement,
         * desc: HTMLElement, releaseEl: ?HTMLElement, logoInfo: HTMLElement}} params - Нормализованные
         * метаданные тайтла и ссылки на DOM-элементы для отрисовки.
         * @returns {void}
         */
        _renderMeta({ patched, chaptersCount, slug, coverImg, desc, releaseEl, logoInfo }) {
            const title = patched.name || slug;
            this.currentTitle = title;
            const summary = this.truncateText(patched.summary || 'Описание отсутствует.', 100);
            const cover = patched.cover || null;
            if (!cover) console.warn('No cover information found in metadata');

            if (cover) {
                coverImg.style.display = 'block';
                coverImg.src = cover;
                this._fetchCover(cover).then(src => { coverImg.src = src; });
            } else
                coverImg.style.display = 'none';

            const authors = patched.authors.filter(Boolean);
            const rating = patched.rating || null;
            if (!rating) console.warn('No age restriction label found in metadata');

            const firstLineParts = [];
            if (chaptersCount !== null) firstLineParts.push(`Глав: ${chaptersCount}`);
            if (rating) firstLineParts.push(`Рейтинг: ${rating}`);

            const secondLine = (authors && authors.length) ? `Авторы: ${authors.join(', ')}` : '';
            const logoText = secondLine
                ? `${firstLineParts.join(' · ')}\n${secondLine}`
                : firstLineParts.join(' · ');
            logoInfo.textContent = logoText;
            // Запоминаем, чтобы вернуть подпись после истории/настроек.
            this._logoInfoText = logoText;

            desc.innerHTML = `<strong>${title}</strong><br><small>${summary}</small>`;

            const release = patched.releaseDate || '';
            if (releaseEl) releaseEl.textContent = release ? `Дата выхода: ${release}` : '';
            else console.warn('Release date element not found when setting release date:', release);
        }

        /**
         * Переводит форму загрузки в состояние готовности: разблокирует кнопку
         * скачивания и показывает подсказку о следующем шаге.
         * @param {{btn: HTMLButtonElement, status: ?HTMLElement}} params - Элементы формы.
         * @returns {void}
         */
        _setReadyState({ btn, status }) {
            btn.disabled = false;
            btn.textContent = this._downloadButtonLabel();
            if (status) {
                if (!this._inSeparateWindow)
                    status.textContent = 'Нажмите «Скачать» — главы и папка выбираются в окне загрузки';
                else if (this._needsFolderClick())
                    status.textContent = `Выберите главы и нажмите «${btn.textContent}»`;
                else status.textContent = 'Выберите главы и нажмите «Скачать»';
            } else console.warn('Status element not found when setting ready to download message');
        }

        /**
         * Включён ли для текущего сервиса выбор папки сохранения.
         * @returns {boolean} true, если сервис просит выбирать папку перед загрузкой.
         */
        _folderSelectionEnabled() {
            return !!(this.currentService?.config?.chooseSaveFolder && global.FileSaver);
        }

        /**
         * Будет ли папка выбираться системным диалогом (Chrome и др. с File System Access API).
         * @returns {boolean} true, если используется showDirectoryPicker.
         */
        _usesDirectoryPicker() {
            return this._folderSelectionEnabled() && global.FileSaver.supportsDirectoryPicker();
        }

        /**
         * Нужно ли нажатие пользователя, чтобы открыть выбор папки: системный диалог
         * открывается только по клику и только в отдельном окне (выпадающий попап
         * закрывается при потере фокуса).
         * @returns {boolean} true, если загрузка начнётся после клика с выбором папки.
         */
        _needsFolderClick() {
            return this._usesDirectoryPicker() && this._inSeparateWindow;
        }

        /**
         * Подпись кнопки загрузки с учётом выбора папки.
         * @returns {string} Текст кнопки.
         */
        _downloadButtonLabel() {
            return this._needsFolderClick() ? 'Выбрать папку и скачать' : 'Скачать';
        }

        /**
         * Показывает элементы выбора способа загрузки и папки сохранения для сервиса.
         * @param {object} service - Текущий сервис.
         * @returns {void}
         */
        _setupDownloadOptionsUI(service) {
            const config = service?.config || {};

            const sourceModeContainer = $el('sourceModeContainer');
            if (sourceModeContainer)
                sourceModeContainer.style.display = config.supportsDomMode ? 'block' : 'none';

            const folderContainer = $el('saveFolderContainer');
            const folderHint = $el('saveFolderHint');
            const enabled = !!(config.chooseSaveFolder && global.FileSaver);
            const picker = enabled && global.FileSaver.supportsDirectoryPicker();

            if (folderContainer) folderContainer.style.display = enabled && !picker ? 'block' : 'none';
            this._setVisibility('titleFolderContainer', enabled ? 'flex' : 'none');
            if (folderHint) {
                const files = config.singleFile
                    ? 'Все выбранные главы — в один файл.'
                    : 'Каждая глава — отдельный файл.';
                folderHint.style.display = enabled ? 'block' : 'none';
                folderHint.textContent = picker
                    ? `Перед началом загрузки откроется выбор папки. ${files}`
                    : 'Браузер не поддерживает выбор произвольной папки — файлы сохранятся ' +
                        `в папку «Загрузки» (или в указанную в ней подпапку). ${files}`;
            }
        }

        /**
         * Определяет, куда сохранять файлы: открывает выбор папки (Chrome) или берёт
         * подпапку «Загрузок» из поля ввода (Firefox).
         * @returns {Promise<?object>} FileSaver, либо null, если выбор папки для сервиса не нужен.
         * @throws {Error} С полем cancelled=true, если пользователь отменил выбор.
         */
        async _chooseSaver() {
            if (!this._folderSelectionEnabled()) return null;
            let saver;
            if (global.FileSaver.supportsDirectoryPicker()) {
                // Диалог выбора папки — первым await, пока действует клик пользователя.
                saver = await global.FileSaver.pickDirectory();
            } else {
                const input = $el('saveSubfolderInput');
                saver = global.FileSaver.forDownloads(input ? input.value.trim() : '');
            }
            // Флажок «Создать папку с названием тайтла»: главы — в подпапку тайтла.
            if (this._useTitleFolder()) saver = await saver.subfolder(this.currentTitle || this.currentSlug || 'manga');
            return saver;
        }

        /**
         * @returns {boolean} true, если включён флажок «Создать папку с названием тайтла».
         */
        _useTitleFolder() {
            const checkbox = $el('titleFolderCheckbox');
            return !!(checkbox && checkbox.checked);
        }

        /**
         * Отображает ошибку загрузки метаданных тайтла в блоке описания и блокирует
         * кнопку скачивания.
         * @param {Error} error - Возникшая ошибка.
         * @param {{desc: ?HTMLElement, status: ?HTMLElement, btn: ?HTMLButtonElement}} elements
         * Элементы UI, в которых нужно отразить ошибку.
         * @returns {void}
         */
        _handleLoadError(error, { desc, status, btn }) {
            console.error('[PopupController] Failed to load metadata:', error);
            if (desc) desc.textContent = `Ошибка: ${error.message}`;
            if (status) status.textContent = '';
            if (btn) btn.disabled = true;
        }

        /**
         * Показывает экран "неподдерживаемый сервис" со ссылками на переход к
         * поддерживаемым сервисам (mangalib/ranobelib) и на репозиторий проекта.
         * @returns {Promise<void>}
         */
        async _showWrongServiceState() {
            await global.TemplateLoader.show('wrong-service');
            const logoInfo = $el('logoInfo');
            if (logoInfo) logoInfo.textContent = '';
            this._logoInfoText = '';

            const siteLogo = $el('siteLogo');
            const serviceLinks = $el('serviceLinks');

            if (serviceLinks && global.serviceRegistry) {
                for (const service of global.serviceRegistry.getAllServices()) {
                    const { name, siteUrl } = service.config || {};
                    if (!siteUrl) continue;
                    const btn = document.createElement('button');
                    btn.className = `service-link-btn ${name}-link-btn`;
                    btn.style.flex = '1';
                    if (service.config.primaryColor)
                        btn.style.border = `2px solid ${service.config.primaryColor}`;
                    btn.textContent = service.config.label || name;
                    btn.addEventListener('click', async () => {
                        browserAPI.tabs.create({ url: siteUrl });
                        this._applyServiceTheme(name, siteLogo);
                        await this._showNoTitleState();
                    });
                    serviceLinks.appendChild(btn);
                }
            }

            $el('openGithub')?.addEventListener('click', () => {
                browserAPI.tabs.create({ url: 'https://github.com/ivanvit100/DownloadLib' });
            });
        }

        /**
         * Показывает экран "тайтл не определён" (пользователь на поддерживаемом сервисе,
         * но не на странице конкретного тайтла) со ссылкой на репозиторий проекта.
         * @returns {Promise<void>}
         */
        async _showNoTitleState() {
            await global.TemplateLoader.show('no-title');
            const logoInfo = $el('logoInfo');
            if (logoInfo) logoInfo.textContent = '';
            this._logoInfoText = '';

            $el('openGithub')?.addEventListener('click', () => {
                browserAPI.tabs.create({ url: 'https://github.com/ivanvit100/DownloadLib' });
            });
        }

        /**
         * Определяет сервис и slug тайтла: либо напрямую из параметров URL (когда попап
         * открыт с заранее известными данными окна загрузки),
         * либо по URL активной вкладки браузера. Если сервис активной вкладки не
         * поддерживается, показывает экран "неподдерживаемый сервис" и возвращает null.
         * @param {{autoDownload: boolean, slugFromUrl: ?string,
         * serviceFromUrl: ?string, tabIdFromUrl: ?number}} params - Флаги режима и данные из URL.
         * @returns {Promise<?{slug: ?string, serviceKey: string, service: object, activeTabId: ?number}>}
         * Разрешённые slug/сервис и id активной вкладки, либо null, если сервис не поддерживается.
         */
        async _resolveService({ autoDownload, slugFromUrl, serviceFromUrl, tabIdFromUrl }) {
            if (autoDownload && slugFromUrl && serviceFromUrl) {
                const serviceKey = serviceFromUrl;
                let service;
                if (serviceKey === 'ranobelib')
                    service = new global.RanobeLibService();
                else if (serviceKey === 'mangalib')
                    service = new global.MangaLibService();
                else
                    service = global.serviceRegistry?.getService(serviceKey) ?? null;
                if (!service) throw new Error(`Unknown service: ${serviceKey}`);
                return { slug: slugFromUrl, serviceKey, service, activeTabId: tabIdFromUrl };
            }

            // Окно открывается значком расширения и получает id вкладки, с которой его открыли:
            // «активная вкладка текущего окна» здесь — само окно расширения.
            let tab = null;
            if (tabIdFromUrl != null) {
                try {
                    tab = await browserAPI.tabs.get(tabIdFromUrl);
                } catch (e) {
                    console.warn('[PopupController] Source tab is gone:', e?.message || e);
                }
            }

            if (!tab) {
                const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
                if (!tabs || !tabs[0]) throw new Error('No active tab found');
                [tab] = tabs;
            }
            const currentUrl = tab.url || '';
            const activeTabId = tab.id;
            console.log('[PopupController] Current URL:', currentUrl);

            const service = global.serviceRegistry.getServiceByUrl(currentUrl);
            if (!service) {
                await this._showWrongServiceState();
                return null;
            }

            // У сервиса может быть свой формат адреса тайтла (com-x: /17887-nazvanie.html).
            let slug;
            if (typeof service.constructor.extractSlug === 'function')
                slug = service.constructor.extractSlug(currentUrl);
            else {
                const match = currentUrl.match(/\/(?:manga|book)\/([^/?]+)/);
                slug = match ? match[1] : null;
            }

            return { slug, serviceKey: service.name, service, activeTabId };
        }

        /**
         * Главный сценарий загрузки экрана тайтла: разбирает параметры URL, определяет
         * сервис и slug, применяет токен авторизации и тему сервиса, загружает
         * метаданные тайтла и список глав, отрисовывает их и переводит форму
         * в состояние готовности к скачиванию (либо запускает автоскачивание).
         * @returns {Promise<void>}
         */
        async loadMetadata() {
            await Promise.resolve();
            const status = $el('status');
            const btn = $el('downloadBtn');
            const logoInfo = $el('logoInfo');
            const coverImg = $el('cover');
            const desc = $el('description');
            const releaseEl = $el('releaseDate');
            const siteLogo = $el('siteLogo');
            const uiElements = { logoInfo, coverImg, desc, releaseEl, btn, status };

            const urlParams = new URLSearchParams(window.location.search);
            const autoDownload = urlParams.get('download') === 'true';
            const slugFromUrl = urlParams.get('slug');
            const serviceFromUrl = urlParams.get('service');
            const formatFromUrl = urlParams.get('format');
            const chapterFromUrl = urlParams.get('chapterFrom');
            const chapterToUrl = urlParams.get('chapterTo');
            const maxSizeMBFromUrl = urlParams.get('maxSizeMB');
            const branchIdFromUrl = urlParams.get('branchId')
                ? parseInt(urlParams.get('branchId'))
                : null;
            const subfolderFromUrl = urlParams.get('subfolder');
            const tabIdFromUrl = urlParams.get('tabId') ? parseInt(urlParams.get('tabId')) : null;

            this._applyUrlParams({ maxSizeMBFromUrl, subfolderFromUrl });
            this._inSeparateWindow = await this.isInSeparateWindow();

            if (btn) btn.disabled = true;
            if (status) status.textContent = 'Получаем информацию...';

            let loadedService = null;
            try {
                const resolved = await this._resolveService({
                    autoDownload, slugFromUrl, serviceFromUrl, tabIdFromUrl
                });
                if (resolved === null) return;
                const { slug, serviceKey, service, activeTabId } = resolved;

                this._activeTabId = activeTabId;
                if (activeTabId) global.setServiceTab(activeTabId, serviceKey);
                // Тема — сразу, чтобы окно не мигало цветами другого сайта.
                this._applyServiceTheme(serviceKey, siteLogo);
                // Сайтам на cookie (com-x) токен из хранилища страницы не нужен.
                this.authToken = service.config?.noAuthToken
                    ? null
                    : await global.AuthManager.apply(serviceKey, activeTabId, service);

                if (!slug) {
                    await this._showNoTitleState();
                    return;
                }

                this.currentSlug = slug;
                this.currentServiceKey = serviceKey;
                this.currentService = service;
                loadedService = service;
                this._populateFormats(formatFromUrl);

                if (typeof service.setSourceMode === 'function') {
                    service.setSourceMode(getSavedSourceMode());
                    service.onStatus = (message) => { if (status) status.textContent = message; };
                }
                this._setupDownloadOptionsUI(service);

                console.log('[PopupController] Fetching metadata for slug:', slug);

                const titleData = await this._loadTitleData(service, serviceKey, slug, status);
                const rawResp = titleData.metadata;
                console.log('[PopupController] Raw response:', rawResp);

                const meta = rawResp?.data || rawResp;
                if (!meta) throw new Error('Не удалось получить информацию о тайтле');
                const patched = global.MangaPatcher.patch(meta);
                // Список глав уже получен — ChapterController берёт его из готовых данных.
                const chaptersSource = { fetchChaptersList: async () => titleData.chapters };
                const chaptersCount = await this.chapterController.loadAndPopulate(
                    chaptersSource, slug, chapterFromUrl, chapterToUrl, branchIdFromUrl
                );

                this._renderMeta({ patched, chaptersCount, slug, coverImg, desc, releaseEl, logoInfo });
                // В окне из панели расширений главы и переводчик не выбираются: это делается
                // в окне загрузки, которое открывает «Скачать» (там же выбирается папка).
                if (!this._inSeparateWindow) {
                    this._setVisibility('chapterRangeContainer', 'none');
                    this._setVisibility('translatorContainer', 'none');
                }
                this._setReadyState({ btn, status });

                // Системный выбор папки открывается только по клику пользователя,
                // поэтому при его использовании загрузка ждёт нажатия кнопки.
                // Окно загрузки не стартует само: сначала выбираются главы (и папка), затем «Скачать».
                if (autoDownload) console.log('[PopupController] Download window ready, waiting for user');
            } catch (error) {
                this._handleLoadError(error, uiElements);
            } finally {
                if (loadedService) {
                    loadedService.onStatus = null;
                    // Закрываем служебную вкладку режима DOM: окно загрузки откроет свою.
                    if (typeof loadedService.dispose === 'function')
                        loadedService.dispose().catch(e => console.warn('[PopupController] dispose failed:', e));
                }
            }
        }

        /**
         * Получает метаданные и список глав тайтла. Загрузка идёт в фоне расширения
         * (background/TitleJobs): выпадающее окно закрывается при переключении вкладки,
         * но работа продолжается, и при повторном открытии окно подхватывает прогресс
         * или готовый результат. Если фон недоступен — загружает здесь же.
         * @param {object} service - Экземпляр сервиса (уже с выбранным способом загрузки).
         * @param {string} serviceKey - Ключ сервиса.
         * @param {string} slug - Slug тайтла.
         * @param {?HTMLElement} status - Элемент статуса для прогресса.
         * @returns {Promise<{metadata: object, chapters: object}>} Ответы API (или их аналоги из DOM).
         */
        async _loadTitleData(service, serviceKey, slug, status) {
            const mode = service.isDomMode ? 'dom' : 'api';
            const fromBackground = await this._loadTitleInBackground({ serviceKey, slug, mode, status });
            if (fromBackground) {
                if (mode === 'dom' && typeof service.primeDomCache === 'function')
                    service.primeDomCache(slug, fromBackground);
                return fromBackground;
            }

            console.warn('[PopupController] Background title loading unavailable, loading in popup');
            return {
                metadata: await service.fetchMangaMetadata(slug),
                chapters: await service.fetchChaptersList(slug)
            };
        }

        /**
         * Опрашивает фоновое задание загрузки тайтла, показывая его прогресс.
         * @param {{serviceKey: string, slug: string, mode: string, status: ?HTMLElement}} params - Параметры.
         * @returns {Promise<?{metadata: object, chapters: object}>} Данные тайтла, либо null,
         * если фон не поддерживает задания (тогда загрузка идёт в окне).
         * @throws {Error} Если фоновое задание завершилось ошибкой.
         */
        async _loadTitleInBackground({ serviceKey, slug, mode, status }) {
            if (!browserAPI?.runtime?.sendMessage) return null;
            const request = { action: 'titleJob:load', serviceKey, slug, mode, authToken: this.authToken };

            for (;;) {
                let response;
                try {
                    response = await browserAPI.runtime.sendMessage(request);
                } catch (e) {
                    console.warn('[PopupController] titleJob request failed:', e?.message || e);
                    return null;
                }
                if (!response?.ok) return null;
                if (response.status === 'done') return response.result;
                if (response.status === 'error') throw new Error(response.error);

                if (status) {
                    const seconds = Math.round((response.elapsedMs || 0) / 1000);
                    status.textContent = `${response.progress || 'Загрузка...'} (${seconds} с)`;
                }
                await new Promise(resolve => setTimeout(resolve, TITLE_JOB_POLL_MS));
            }
        }

        /**
         * Пытается догрузить обложку через контекст вкладки сервиса (обходя CORS/rate-limit
         * ограничения), возвращая data-URL с base64-содержимым.
         * @param {string} url - Исходный URL обложки.
         * @returns {Promise<string>} data-URL с изображением, либо исходный URL при ошибке загрузки.
         */
        async _fetchCover(url) {
            try {
                const result = await global.fetchViaTab(url, this.currentServiceKey);
                if (result?.ok) return `data:${result.contentType};base64,${result.base64}`;
            } catch (e) {
                console.warn('[PopupController] Cover fetch failed:', e.message);
            }
            return url;
        }

        /**
         * Обрезает текст до заданной длины, добавляя многоточие при обрезке.
         * @param {?string} text - Исходный текст.
         * @param {number} [maxLength=128] - Максимальная длина результата (без многоточия).
         * @returns {?string} Обрезанный текст, исходный text, если он короче лимита или пуст.
         */
        truncateText(text, maxLength = 128) {
            if (!text) return text;
            const str = String(text).trim();
            if (str.length <= maxLength) return str;
            return `${str.substring(0, maxLength)}...`;
        }

        /**
         * Навешивает обработчики на кнопки скачивания, паузы и остановки на главном
         * экране тайтла. Клик по скачиванию в выпадающем попапе тулбара (без загруженного
         * файла обновления) переоткрывает попап в отдельном окне с параметрами загрузки
         * в URL, чтобы процесс скачивания не прерывался закрытием попапа.
         * @returns {void}
         */
        setupEventListeners() {
            const downloadBtn = $el('downloadBtn');
            const pauseBtn = $el('pauseBtn');
            const stopBtn = $el('stopBtn');

            if (downloadBtn) {
                downloadBtn.addEventListener('click', async () => {
                    // Проверка синхронная: выбор папки должен открыться в рамках этого клика.
                    if (!this._confirmLargeDownload()) return;
                    const inSeparateWindow = this._inSeparateWindow ?? await this.isInSeparateWindow();

                    if (!inSeparateWindow) {
                        const formatSelector = $el('formatSelector');
                        const fromSelect = $el('chapterFromSelect');
                        const toSelect = $el('chapterToSelect');
                        const chapterRangeContainer = $el('chapterRangeContainer');

                        const format = formatSelector ? formatSelector.value : 'fb2';
                        const maxSizeMB = localStorage.getItem('manga_parser_max_size_mb') || '200';

                        let urlParams = `?download=true&slug=${encodeURIComponent(this.currentSlug)}` +
                            `&service=${encodeURIComponent(this.currentServiceKey)}` +
                            `&format=${encodeURIComponent(format)}&maxSizeMB=${encodeURIComponent(maxSizeMB)}`;

                        if (fromSelect && toSelect &&
                            chapterRangeContainer &&
                            chapterRangeContainer.style.display !== 'none')
                            urlParams += `&chapterFrom=${encodeURIComponent(fromSelect.value)}&chapterTo=${encodeURIComponent(toSelect.value)}`;

                        const translatorSelect = $el('translatorSelect');
                        const translatorContainer = $el('translatorContainer');
                        if (translatorSelect && translatorContainer &&
                            translatorContainer.style.display !== 'none')
                            urlParams += `&branchId=${encodeURIComponent(translatorSelect.value)}`;

                        const subfolderInput = $el('saveSubfolderInput');
                        if (subfolderInput && this._folderSelectionEnabled())
                            urlParams += `&subfolder=${encodeURIComponent(subfolderInput.value.trim())}`;

                        // Вкладка тайтла — через неё окно загрузки будет качать картинки.
                        if (this._activeTabId != null) urlParams += `&tabId=${encodeURIComponent(this._activeTabId)}`;

                        try {
                            await this.openInNewContext(browserAPI.runtime.getURL('popup.html') + urlParams);
                        } catch (e) {
                            console.error('Failed to create window:', e);
                            await this.startDownload();
                        }
                    } else await this.startDownload();
                });
                console.log('[PopupController] Download button listener attached');
            }

            if (pauseBtn) {
                pauseBtn.addEventListener('click', () => {
                    if (this.shouldStop) return;
                    this.isPaused = !this.isPaused;
                    pauseBtn.textContent = this.isPaused ? 'Продолжить' : 'Пауза';
                    // Заголовок главы остаётся на месте, меняется только строка деталей.
                    const detail = $el('statusDetail');
                    if (detail) detail.textContent = this.isPaused ? 'Пауза — нажмите «Продолжить»' : 'Продолжение...';
                    else console.warn('Status detail element not found when updating status on pause/resume');
                });
            }

            if (stopBtn) stopBtn.addEventListener('click', () => this.stopDownload());
        }

        /**
         * Подписывается на события шины downloadManager'а (прогресс, завершение, ошибка)
         * и обновляет соответствующим образом интерфейс попапа.
         * @returns {void}
         */
        subscribeToEvents() {
            this.downloadManager.eventBus.on('download:progress', (state) => {
                this.updateProgress(state.status, state.progress, state.statusDetail);
            });

            this.downloadManager.eventBus.on('download:completed', () => {
                this.resetUI();
            });

            this.downloadManager.eventBus.on('download:failed', ({ error }) => {
                this.showError(error.message, { persistent: true });
                this.resetUI();
            });
        }

        /**
         * Строит объект диапазона глав из значений select-элементов, если контейнер
         * диапазона видим.
         * @param {?HTMLSelectElement} fromSelect - Select начала диапазона.
         * @param {?HTMLSelectElement} toSelect - Select конца диапазона.
         * @param {?HTMLElement} container - Контейнер блока выбора диапазона.
         * @returns {?{from: number, to: number}} Диапазон индексов глав, либо null,
         * если селекторы/контейнер отсутствуют или скрыты.
         */
        _buildChapterRange(fromSelect, toSelect, container) {
            if (fromSelect && toSelect && container && container.style.display !== 'none')
                return { from: parseInt(fromSelect.value), to: parseInt(toSelect.value) };
            return null;
        }

        /**
         * Переводит интерфейс в состояние "идёт загрузка": скрывает элементы выбора
         * (формат, переводчик, папка, диапазон), показывает прогресс-бар
         * и панель с параметрами текущей загрузки, обновляет статус.
         * @param {{btn: HTMLButtonElement, progress: ?HTMLElement, controls: ?HTMLElement,
         * chapterRangeContainer: ?HTMLElement, status: ?HTMLElement}} elements - Элементы формы загрузки.
         * @returns {void}
         */
        _setDownloadingUIState({ btn, progress, controls, chapterRangeContainer, status }, saver = null) {
            btn.disabled = true;
            btn.style.display = 'none';
            this._setVisibility('formatContainer', 'none');
            this._setVisibility('sourceModeContainer', 'none');
            this._setVisibility('saveFolderContainer', 'none');
            this._setVisibility('titleFolderContainer', 'none');
            this._setVisibility('saveFolderHint', 'none');
            // Во время загрузки статус — две строки фиксированной высоты (заголовок и детали).
            if (status) status.classList.add('status-fixed');
            this._setVisibility('statusDetail', '');
            this._setVisibility('translatorContainer', 'none');
            if (progress) progress.style.display = 'block';
            if (controls) controls.style.display = 'block';
            if (chapterRangeContainer) chapterRangeContainer.style.display = 'none';

            const downloadInfoPanel = $el('downloadInfoPanel');
            if (downloadInfoPanel) {
                const formatSelector = $el('formatSelector');
                const formatLabel = formatSelector
                    ? (formatSelector.options[formatSelector.selectedIndex]?.text || formatSelector.value)
                    : '';
                const maxSizeMBDisplay = localStorage.getItem('manga_parser_max_size_mb') || '200';
                const config = this.currentService?.config || {};
                const rows = [
                    ['Формат', formatLabel]
                ];
                if (config.supportsDomMode)
                    rows.push(['Способ загрузки', SOURCE_MODE_LABELS[getSavedSourceMode()]]);
                if (config.splitByChapter) rows.push(['Файлы', 'по одной главе']);
                else if (config.singleFile) rows.push(['Файл', 'один на весь диапазон']);
                else rows.push(['Макс. размер части', `${maxSizeMBDisplay} МБ`]);
                if (saver) rows.push(['Папка', saver.describe()]);

                downloadInfoPanel.innerHTML = '';
                for (const [label, value] of rows) {
                    const row = document.createElement('div');
                    row.className = 'info-row';
                    const labelEl = document.createElement('span');
                    labelEl.className = 'info-label';
                    labelEl.textContent = label;
                    const valueEl = document.createElement('span');
                    valueEl.className = 'info-value';
                    valueEl.textContent = value;
                    row.append(labelEl, valueEl);
                    downloadInfoPanel.appendChild(row);
                }
                downloadInfoPanel.style.display = 'block';
            }

            if (status) status.textContent = 'Запуск скачивания...';
        }

        /**
         * Запускает загрузку текущего тайтла: собирает параметры (диапазон глав, ветку
         * перевода, формат, лимиты), переводит UI в состояние загрузки, вызывает
         * downloadManager.startDownload с контроллером паузы/остановки, а по завершении
         * отображает результат и добавляет запись в историю загрузок.
         * @returns {Promise<void>}
         */
        async startDownload() {
            if (!this.currentSlug || !this.currentServiceKey) {
                this.showError('Не удалось определить тайтл');
                return;
            }

            const { btn, formatSelector, status, progress,
                controls, chapterRangeContainer, fromSelect, toSelect } = this._getDownloadElements();

            this.hideError();

            // Папку выбираем первым делом: системный диалог открывается только
            // в рамках клика пользователя, пока не начались другие await.
            let saver = null;
            try {
                saver = await this._chooseSaver();
            } catch (error) {
                if (error?.cancelled) {
                    if (status) status.textContent = 'Папка не выбрана — загрузка не начата';
                } else this.showError(error.message, { persistent: true });
                return;
            }

            try {
                const { chapterRange, branchId, historyParams } = await this._prepareDownload({
                    fromSelect, toSelect, chapterRangeContainer
                });

                this.isDownloading = true;
                this.isPaused = false;
                this.shouldStop = false;

                this._setDownloadingUIState({
                    btn, progress, controls, chapterRangeContainer, status
                }, saver);

                const format = formatSelector?.value || 'fb2';
                const maxSizeMB = parseInt(localStorage.getItem('manga_parser_max_size_mb')) || 200;

                const fitFb2Images = localStorage.getItem('manga_parser_fit_fb2_images') === 'true';

                await this.downloadManager.startDownload({
                    slug: this.currentSlug,
                    serviceKey: this.currentServiceKey,
                    format,
                    chapterRange,
                    branchId,
                    maxSizeMB,
                    fitFb2Images,
                    saver,
                    sourceMode: getSavedSourceMode(),
                    authToken: this.authToken,
                    controller: {
                        isPaused: () => this.isPaused,
                        shouldStop: () => this.shouldStop,
                        stop: () => { this.shouldStop = true; },
                        waitIfPaused: async () => {
                            while (this.isPaused && !this.shouldStop)
                                await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                });

                global.DownloadHistory.add({
                    service: this.currentServiceKey,
                    slug: this.currentSlug,
                    title: this.currentTitle || this.currentSlug,
                    format,
                    ...historyParams
                });
            } catch (error) {
                console.error('[PopupController] Download failed:', error);
                this.showError(error.message, { persistent: true });
                this.resetUI();
            }
        }

        /**
         * Возвращает текст выбранной опции select-элемента.
         * @param {?HTMLSelectElement} select - Проверяемый select.
         * @returns {?string} Текст выбранной опции, либо null, если select отсутствует
         * или ничего не выбрано.
         */
        _getSelectText(select) {
            if (!select || select.selectedIndex < 0) return null;
            return select.options[select.selectedIndex]?.text || null;
        }

        /**
         * Собирает параметры предстоящей загрузки: диапазон глав, ветку перевода
         * и текстовые значения для записи в историю.
         * @param {{fromSelect: ?HTMLSelectElement, toSelect: ?HTMLSelectElement,
         * chapterRangeContainer: ?HTMLElement}} params - Элементы выбора диапазона глав.
         * @returns {{chapterRange: ?{from: number, to: number}, branchId: ?number,
         * historyParams: {chapterFrom: ?string, chapterTo: ?string, translator: ?string}}}
         * Параметры для запуска загрузки и записи в историю.
         */
        _prepareDownload({ fromSelect, toSelect, chapterRangeContainer }) {
            const chapterRange = this._buildChapterRange(fromSelect, toSelect, chapterRangeContainer);

            const translatorSelect = $el('translatorSelect');
            const translatorContainer = $el('translatorContainer');
            const translatorVisible = !!(translatorSelect && translatorContainer &&
                translatorContainer.style.display !== 'none');
            const branchId = translatorVisible ? parseInt(translatorSelect.value) : null;

            return {
                chapterRange,
                branchId,
                historyParams: {
                    chapterFrom: this._getSelectText(fromSelect),
                    chapterTo: this._getSelectText(toSelect),
                    translator: translatorVisible ? this._getSelectText(translatorSelect) : null
                }
            };
        }

        /**
         * Останавливает текущую загрузку: снимает паузу, выставляет флаг остановки,
         * блокирует кнопки паузы/остановки и просит downloadManager прервать загрузку.
         * @returns {void}
         */
        stopDownload() {
            this.shouldStop = true;
            this.isPaused = false;
            this.isDownloading = false;
            const pauseBtn = $el('pauseBtn');
            const stopBtn = $el('stopBtn');
            if (pauseBtn) pauseBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = true;
            if (this.currentDownloadId)
                this.downloadManager.stop(this.currentDownloadId);
            const status = $el('status');
            if (status) status.textContent = 'Досрочное завершение...';
            else console.warn('Status element not found when setting status on download stop');
        }

        /**
         * Обновляет текст статуса (если загрузка не на паузе) и значение прогресс-бара.
         * @param {string} message - Текст статуса загрузки.
         * @param {number} percent - Процент выполнения (0-100).
         * @param {string} [detail] - Вторая строка статуса (страницы главы, паузы сервера).
         * @returns {void}
         */
        updateProgress(message, percent, detail = '') {
            const statusEl = $el('status');
            const progressEl = $el('progress');
            if (statusEl) {
                if (!this.isPaused) {
                    statusEl.textContent = message;
                    statusEl.title = message;
                    const detailEl = $el('statusDetail');
                    if (detailEl) {
                        detailEl.textContent = detail || '';
                        detailEl.title = detail || '';
                    }
                }
            } else console.warn('Status element not found when updating progress status');
            if (progressEl) progressEl.value = percent;
            else console.warn('Progress element not found when updating progress percentage');
        }

        /**
         * Возвращает интерфейс попапа в исходное состояние после завершения, ошибки
         * или остановки загрузки: сбрасывает флаги, очищает загруженный файл, снова
         * показывает элементы выбора формата/файла/диапазона глав и переводчика,
         * скрывает прогресс-бар и панель параметров загрузки.
         * @returns {void}
         */
        resetUI() {
            this.isDownloading = false;
            this.isPaused = false;
            this.shouldStop = false;
            this._stopStatsRender();
            const statusReset = $el('status');
            if (statusReset) {
                statusReset.classList.remove('status-fixed');
                statusReset.title = '';
            }
            this._setVisibility('statusDetail', 'none');

            const pauseBtn = $el('pauseBtn');
            const stopBtn = $el('stopBtn');
            if (pauseBtn) {
                pauseBtn.disabled = false;
                pauseBtn.textContent = 'Пауза';
            }
            if (stopBtn) stopBtn.disabled = false;

            this.currentDownloadId = null;

            const { btn, progress, controls } = this._getDownloadElements();

            if (btn) {
                btn.style.display = 'block';
                btn.disabled = false;
                btn.textContent = this._downloadButtonLabel();
            } else console.warn('Download button not found when resetting UI');
            this._setVisibility('formatContainer', '');
            this._setupDownloadOptionsUI(this.currentService);
            this._populateFormats();
            this._setVisibility('downloadInfoPanel', 'none');
            if (progress) progress.style.display = 'none';
            else console.warn('Progress element not found when resetting UI');
            if (controls) controls.style.display = 'none';
            else console.warn('Controls container not found when resetting UI');

            const chapterRangeContainer = $el('chapterRangeContainer');
            const fromSelectReset = $el('chapterFromSelect');
            if (chapterRangeContainer) {
                chapterRangeContainer.style.display =
                    (fromSelectReset && fromSelectReset.options.length > 0) ? 'block' : 'none';
            } else console.warn('Chapter range container not found when resetting UI');

            const translatorContainerReset = $el('translatorContainer');
            const translatorSelectReset = $el('translatorSelect');
            if (translatorContainerReset) {
                translatorContainerReset.style.display =
                    (translatorSelectReset && translatorSelectReset.options.length > 1) ? 'block' : 'none';
            } else console.warn('Translator container not found when resetting UI');
        }

        /**
         * Показывает сообщение об ошибке. Обычные сообщения скрываются через 5 секунд,
         * ошибки загрузки (persistent) остаются на экране до следующего запуска загрузки.
         * @param {string} message - Текст сообщения об ошибке.
         * @param {{persistent?: boolean}} [opts] - Не скрывать сообщение автоматически.
         * @returns {void}
         */
        showError(message, { persistent = false } = {}) {
            const errorEl = $el('error');
            if (errorEl) {
                clearTimeout(this._errorTimer);
                errorEl.textContent = message;
                errorEl.classList.remove('hidden');
                if (!persistent) this._errorTimer = setTimeout(() => errorEl.classList.add('hidden'), 5000);
            } else console.warn('Error element not found when showing error message');
        }

        /**
         * Скрывает блок ошибки.
         * @returns {void}
         */
        hideError() {
            clearTimeout(this._errorTimer);
            const errorEl = $el('error');
            if (errorEl) {
                errorEl.classList.add('hidden');
                errorEl.textContent = '';
            }
        }

        /**
         * Показывает сообщение об успехе во всплывающем блоке на 5 секунд.
         * @param {string} message - Текст сообщения об успехе.
         * @returns {void}
         */
        showSuccess(message) {
            const successEl = $el('success');
            if (successEl) {
                successEl.textContent = message;
                successEl.classList.remove('hidden');
                setTimeout(() => successEl.classList.add('hidden'), 5000);
            } else console.warn('Success element not found when showing success message');
        }

        /**
         * Проверяет (с кэшированием на 4 часа в localStorage) статус последнего запуска
         * health-check воркфлоу проекта на GitHub и показывает предупреждение о
         * возможной неработоспособности части запросов к API, если проверка провалена.
         * @returns {Promise<void>}
         */
        async checkApiHealth() {
            const CACHE_KEY = 'DLoadLib_API_check';
            const CACHE_TTL = 4 * 60 * 60 * 1000;
            const API_URL = `https://api.github.com/repos/ivanvit100/DownloadLib/actions/workflows/health-check.yaml/runs?per_page=1`;
            const REPO_URL = 'https://github.com/ivanvit100/DownloadLib/issues';

            try {
                const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
                const useCache = cached && (Date.now() - cached.timestamp < CACHE_TTL);

                if (!useCache) {
                    const res = await fetch(API_URL, { cache: 'no-cache' });
                    const data = await res.json();
                    const conclusion = data.workflow_runs?.[0]?.conclusion;
                    const isFailing = conclusion === 'failure';
                    localStorage.setItem(CACHE_KEY, JSON.stringify({ isFailing, timestamp: Date.now() }));
                    if (isFailing) this._showApiWarning(REPO_URL);
                    return;
                }

                if (cached.isFailing) this._showApiWarning(REPO_URL);
            } catch (e) {
                console.warn('[PopupController] Health check status unavailable:', e.message);
            }
        }

        /**
         * Вставляет перед кнопкой скачивания предупреждение о нестабильности API
         * со ссылкой на страницу issues репозитория.
         * @param {string} repoUrl - URL страницы issues репозитория проекта.
         * @returns {void}
         */
        _showApiWarning(repoUrl) {
            const warning = document.createElement('div');
            warning.id = 'apiWarning';

            const msg = document.createElement('div');
            msg.id = 'apiWarningMsg';
            msg.textContent = '⚠️ Некоторые запросы к API могут не работать. ';
            warning.appendChild(msg);

            const link = document.createElement('a');
            link.id = 'apiWarningLink';
            link.textContent = 'Подробнее на GitHub →';
            link.href = '#';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                browserAPI.tabs.create({ url: repoUrl });
            });
            warning.appendChild(link);

            const downloadBtn = $el('downloadBtn');
            if (downloadBtn && downloadBtn.parentNode)
                downloadBtn.parentNode.insertBefore(warning, downloadBtn);
        }
    }

    global.PopupController = PopupController;
    console.log('[PopupController] Loaded');
})(typeof window !== 'undefined' ? window : self);
