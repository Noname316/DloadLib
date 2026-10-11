/**
 * DownloadLib service module
 * Collects MangaLib title data by searching links in the rendered site pages (DOM mode)
 * @module services/mangalib/MangaLibDomScraper
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[MangaLibDomScraper] Loading...');

    const TAB_LOAD_TIMEOUT = 45000;
    const CONTENT_TIMEOUT = 30000;
    const INFO_TIMEOUT = 8000;
    const PAGE_TIMEOUT = 12000;
    const LIST_SCAN_TIMEOUT = 240000;
    // Читалка при загрузке делает ~7 запросов к API сайта + сама страница.
    const PAGE_LOAD_COST = 8;
    /**
     * @param {string} siteUrl - Адрес сайта.
     * @returns {string} Текст ошибки «нужен вход» с адресом нужного сайта.
     */
    const authRequiredMessage = siteUrl => 'Тайтл доступен только авторизованным пользователям (18+). ' +
        `Войдите на сайт ${new URL(siteUrl).hostname} в этом браузере и повторите загрузку`;

    // ------------------------------------------------------------------
    // Функции ниже сериализуются и исполняются в контексте страницы сайта
    // (scripting.executeScript), поэтому они не должны ссылаться ни на что
    // снаружи себя.
    // ------------------------------------------------------------------

    /**
     * [Страница] Подменяет requestAnimationFrame на версию, работающую в фоновой
     * вкладке. Сайт построен на Vue, а виртуальный список глав и читалка
     * перерисовываются через requestAnimationFrame, который браузер не вызывает
     * в скрытых вкладках, — без подмены ссылки на главы и страницы просто
     * не появятся в DOM.
     * @returns {boolean} true, если подмена установлена.
     */
    function pageInstallRafShim() {
        // Буфер Resource Timing нужен, чтобы видеть HTTP-статусы запросов страницы к API.
        try { performance.setResourceTimingBufferSize(2000); } catch (e) { /* не поддерживается */ }

        const install = (target, wrap) => {
            if (target.__dlRafShim) return true;
            const channel = new MessageChannel();
            const queue = [];
            channel.port1.onmessage = () => {
                const now = performance.now();
                queue.splice(0).forEach(cb => {
                    try { cb(now); } catch (e) { /* ошибка колбэка страницы */ }
                });
            };

            const raf = (cb) => {
                queue.push(cb);
                channel.port2.postMessage(0);
                return queue.length;
            };
            target.requestAnimationFrame = wrap ? wrap(raf) : raf;
            target.__dlRafShim = true;
            return true;
        };

        // Firefox без world: 'MAIN' — скрипт работает в изолированном мире,
        // до функций страницы можно дотянуться только через wrappedJSObject.

        if (window.wrappedJSObject && typeof exportFunction === 'function') {
            // eslint-disable-next-line no-undef
            return install(window.wrappedJSObject, fn => exportFunction(fn, window));
        }
        return install(window, null);
    }

    /**
     * [Страница] Помечает текущий документ как устаревший перед переходом на другой адрес.
     * @returns {boolean} true.
     */
    function pageMarkStale() {
        window.__dlStale = true;
        return true;
    }

    /**
     * [Страница] Проверяет, что во вкладке уже новый документ, а не помеченный старый.
     * @returns {boolean} true, если документ не помечен как устаревший.
     */
    function pageIsFresh() {
        return !window.__dlStale;
    }

    /**
     * [Страница] Снимок состояния страницы тайтла: загрузилась ли шапка и список глав.
     * @returns {{ready: boolean, hasList: boolean, needsAuth: boolean, notFound: boolean}}
     */
    function pageProbeTitle() {
        const text = document.body ? document.body.innerText : '';
        const h1 = document.querySelector('h1');
        return {
            ready: !!(h1 && h1.textContent.trim()),
            hasInfo: !!document.querySelector('.text-collapse, a[href*="/people/"], a[href*="year_min"]'),
            hasList: !!document.querySelector(
                '.media-chapters .vue-recycle-scroller, .media-chapters a[href*="/read/"]'),
            needsAuth: /необходимо\s+авторизоваться/i.test(text),
            notFound: /не\s+найден/i.test(document.title) || /^404/.test(document.title),
            // HTTP-ошибки запросов самой страницы к API сайта (403/429 — ограничение частоты).
            apiErrors: performance.getEntriesByType('resource')
                .filter(e => /(?:cdnlibs|hentaicdn)\.org\/api\//.test(e.name) && e.responseStatus >= 400)
                .map(e => e.responseStatus),
            // Сообщение сайта об ограничении частоты (уведомление на странице).
            limitText: (/(?:превышен\S*\s+лимит\S*|слишком\s+много\s+запросов)[^\n]{0,60}/i
                .exec(text) || [''])[0].trim(),
            blockedText: ''
        };
    }

    /**
     * [Страница] Читает метаданные тайтла из отрисованной страницы.
     * @returns {object} Сырые метаданные в формате, понятном MangaPatcher.
     */
    function pageReadTitleMeta() {
        const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
        const h1 = document.querySelector('h1');
        const altName = h1 && h1.parentElement ? h1.parentElement.querySelector('h2') : null;

        const coverImg = [...document.querySelectorAll('img')].find(img => {
            const src = img.getAttribute('src') || '';
            return /\/uploads\/cover\/[^/]+\/cover\//.test(src) && !/_thumb\./.test(src);
        });

        const metaDesc = document.querySelector('meta[name="description"]');
        const summaryEl = document.querySelector('.text-collapse');
        const summary = txt(summaryEl) || (metaDesc ? metaDesc.content : '');

        // Ссылка автора: аватар, <span>Имя</span> и подпись роли («Автор и Художник»).
        const authors = [...document.querySelectorAll('a[href*="/people/"]')]
            .map(a => txt(a.querySelector('span')) || txt(a))
            .filter(Boolean);

        const findInfo = (label) => {
            const el = [...document.querySelectorAll('body *')].find(e =>
                e.children.length === 0 && e.textContent.trim() === label);
            if (!el || !el.parentElement) return '';
            return txt(el.parentElement).replace(label, '').trim();
        };

        const genres = [...document.querySelectorAll('a[href*="genres"]')].map(txt).filter(Boolean);
        const tags = [...document.querySelectorAll('a[href*="tags"]')].map(txt).filter(Boolean);
        const age = txt(document.querySelector('a[href*="caution"]')) || findInfo('Возрастной рейтинг');

        return {
            rus_name: txt(h1),
            eng_name: txt(altName), // eslint-disable-line camelcase
            cover: coverImg ? coverImg.getAttribute('src') : '',
            summary,
            authors: [...new Set(authors)],
            genres: [...new Set(genres)],
            tags: [...new Set(tags)],
            releaseDate: (txt(document.querySelector('a[href*="year_min"]')).replace(/^Выпуск/, '') ||
                findInfo('Выпуск')).replace(/\s*г\.?$/, '').trim(),
            ageRestriction: age ? { label: age } : null
        };
    }

    /**
     * [Страница] Прокручивает страницу до позиции y и собирает видимые сейчас
     * ссылки на главы (список глав виртуальный — в DOM одновременно есть только
     * часть строк, поэтому сбор выполняется по шагам прокрутки).
     * @param {number} y - Позиция прокрутки.
     * @returns {{links: {href: string, text: string}[], scrollHeight: number, viewport: number}}
     */
    function pageScanChaptersStep(y) {
        window.scrollTo(0, y);
        window.dispatchEvent(new Event('scroll'));
        const root = document.querySelector('.media-chapters') || document;
        const links = [...root.querySelectorAll('a[href*="/read/"]')]
            .filter(a => /Глава/i.test(a.textContent))
            .map(a => ({ href: a.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim() }));
        return {
            links,
            scrollHeight: document.documentElement.scrollHeight,
            viewport: window.innerHeight
        };
    }

    /**
     * [Страница] Снимок состояния читалки: сколько страниц в главе и для каких
     * из них уже известны ссылки на изображения.
     * @returns {{total: number, pages: {num: number, src: ?string}[], needsAuth: boolean, notFound: boolean}}
     */
    function pageProbeReader() {
        const text = document.body ? document.body.innerText : '';
        const pages = [...document.querySelectorAll('[data-page]')]
            .filter(el => /^\d+$/.test(el.dataset.page))
            .map(el => {
                const img = el.querySelector('img');
                let src = img ? (img.getAttribute('src') || img.dataset.src || '') : '';
                if (src.startsWith('//')) src = location.protocol + src;
                return { num: Number(el.dataset.page), src: /^https?:\/\//i.test(src) ? src : null };
            });
        // Явная причина, по которой читалка не показывает страницы (платная/удалённая глава и т.п.).
        const flat = text.replace(/\s+/g, ' ');
        const blocked = /платн|купить|подписк|недоступн|удален|нет страниц|не загружен/i.exec(flat);
        const blockedText = blocked
            ? flat.slice(Math.max(0, blocked.index - 60), blocked.index + 80).trim()
            : '';

        return {
            total: pages.length,
            pages,
            needsAuth: /необходимо\s+авторизоваться/i.test(text),
            notFound: /не\s+найден/i.test(document.title) || /^404/.test(document.title),
            // HTTP-ошибки запросов самой страницы к API сайта (403/429 — ограничение частоты).
            apiErrors: performance.getEntriesByType('resource')
                .filter(e => /(?:cdnlibs|hentaicdn)\.org\/api\//.test(e.name) && e.responseStatus >= 400)
                .map(e => e.responseStatus),
            // Сообщение сайта об ограничении частоты (уведомление на странице).
            limitText: (/(?:превышен\S*\s+лимит\S*|слишком\s+много\s+запросов)[^\n]{0,60}/i
                .exec(text) || [''])[0].trim(),
            blockedText
        };
    }

    /**
     * [Страница] Переключает читалку на страницу с номером pageNum — через
     * селектор «Страница N / M», а при его отсутствии — прокруткой к странице.
     * @param {number} pageNum - Номер страницы (с 1).
     * @returns {?string} Использованный способ ('select' | 'scroll') или null.
     */
    function pageReaderGoTo(pageNum) {
        const select = [...document.querySelectorAll('select')]
            .find(s => [...s.options].some(o => /Страница/i.test(o.textContent)));
        if (select) {
            const opt = [...select.options].find(o => o.value === String(pageNum)) || select.options[pageNum - 1];
            if (opt) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return 'select';
            }
        }
        const el = document.querySelector(`[data-page="${pageNum}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center' });
            window.dispatchEvent(new Event('scroll'));
            return 'scroll';
        }
        return null;
    }

    // ------------------------------------------------------------------

    /**
     * Разбирает ссылку на главу из списка глав сайта.
     * @param {{href: string, text: string}} link - Ссылка и её текст («Том 5 Глава 12 - Название»).
     * @param {string} origin - Origin сайта для построения абсолютного URL.
     * @returns {?{volume: string, number: string, name: string, branchId: ?number, url: string}}
     */
    function parseChapterLink(link, origin) {
        const hrefMatch = /\/read\/v([^/]+)\/c([^/?#]+)/.exec(link.href || '');
        if (!hrefMatch) return null;
        const textMatch = /Том\s+(\S+)\s+Глава\s+(\S+)(?:\s+-\s+(.*))?/i.exec(link.text || '');
        const stripZeros = v => v.replace(/^0+(?=\d)/, '');

        const url = new URL(link.href, origin);
        const bid = url.searchParams.get('bid');
        return {
            volume: textMatch ? textMatch[1] : stripZeros(hrefMatch[1]),
            number: textMatch ? textMatch[2] : stripZeros(hrefMatch[2]),
            name: textMatch && textMatch[3] ? textMatch[3].trim() : '',
            branchId: bid && /^\d+$/.test(bid) ? Number(bid) : null,
            url: url.href
        };
    }

    /**
     * Собирает данные MangaLib через отрисованные страницы сайта вместо API:
     * открывает служебную фоновую вкладку, загружает в неё страницу тайтла или
     * читалки и ищет на ней ссылки на главы и изображения страниц.
     */
    class MangaLibDomScraper {
        /**
         * @param {{siteUrl: string, tabPatterns?: string[]}} options - Адрес сайта и
         * match-паттерны его вкладок.
         */
        constructor({ siteUrl, tabPatterns, guardTab = true }) {
            this.siteUrl = siteUrl.replace(/\/+$/, '');
            this.tabPatterns = tabPatterns || ['*://mangalib.me/*', '*://mangalib.org/*'];
            this.tabId = null;
            this._world = 'MAIN';
            this._onRemoved = null;
            this._guard = null;
            // Защита служебной вкладки через порт к фону нужна странице расширения;
            // в самом фоне (TitleJobs) вкладку закрывает задание.
            this.guardTab = guardTab;
        }

        /**
         * @returns {object} Promise-based API расширения.
         */
        get api() {
            const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : null;
            if (!api?.tabs || !api?.scripting?.executeScript)
                throw new Error('Режим DOM недоступен: нет доступа к вкладкам браузера');
            return api;
        }

        /**
         * Загружает страницу тайтла и собирает метаданные и полный список глав.
         * @param {string} slug - Slug тайтла.
         * @param {{onProgress?: function(string): void}} [opts] - Колбэк прогресса.
         * @returns {Promise<{meta: object, chapters: object[]}>} Метаданные и главы
         * (в порядке возрастания).
         * @throws {Error} Если страница не загрузилась или список глав не найден.
         */
        async fetchTitle(slug, opts = {}) {
            // 1. Вкладка «О тайтле» — метаданные (авторы, год, рейтинг есть только на ней).
            const infoUrl = `${this.siteUrl}/ru/manga/${slug}`;
            await this._openWithRetry(infoUrl, pageProbeTitle, p => p.ready, {
                notFound: `Страница тайтла не найдена: ${infoUrl}`,
                empty: 'Страница тайтла не загрузилась (DOM): не найден заголовок',
                onProgress: opts.onProgress
            });
            await this._waitFor(pageProbeTitle, [], p => p.hasInfo, INFO_TIMEOUT);
            const meta = await this._exec(pageReadTitleMeta);

            // 2. Вкладка «Главы» — список ссылок на главы.
            const url = `${infoUrl}?section=chapters`;
            await this._openWithRetry(url, pageProbeTitle, p => p.ready && p.hasList, {
                notFound: `Страница тайтла не найдена: ${url}`,
                empty: 'На странице тайтла не найден список глав (DOM)',
                onProgress: opts.onProgress
            });

            const chapters = await this._scanChapters(opts.onProgress);
            if (chapters.length === 0) throw new Error('В списке глав на странице не найдено ни одной ссылки на главу');
            return { meta, chapters };
        }

        /**
         * Пошагово прокручивает виртуальный список глав и собирает все ссылки.
         * @param {function(string): void} [onProgress] - Колбэк прогресса.
         * @returns {Promise<object[]>} Главы в порядке возрастания тома/номера.
         */
        async _scanChapters(onProgress) {
            const {origin} = new URL(this.siteUrl);
            const found = new Map();
            const started = Date.now();
            let y = 0;
            let bottomHits = 0;

            while (Date.now() - started < LIST_SCAN_TIMEOUT) {
                const step = await this._exec(pageScanChaptersStep, [y]);
                for (const link of step.links) {
                    if (found.has(link.href)) continue;
                    const parsed = parseChapterLink(link, origin);
                    if (parsed) found.set(link.href, parsed);
                }
                if (onProgress) onProgress(`Поиск глав на странице: найдено ${found.size}`);

                const stepSize = Math.min(Math.max(step.viewport * 0.8, 200), 600);
                if (y + step.viewport >= step.scrollHeight - 5 || y >= step.scrollHeight) {
                    bottomHits += 1;
                    if (bottomHits >= 3) break;
                } else bottomHits = 0;
                y = Math.min(y + stepSize, step.scrollHeight);
                await this._sleep(90);
            }

            const merged = new Map();
            for (const ch of found.values()) {
                const key = `${ch.volume}_${ch.number}`;
                const entry = merged.get(key) || {
                    id: null, volume: ch.volume, number: ch.number, name: ch.name, branches: [], urls: {}
                };
                if (ch.branchId != null && !entry.branches.some(b => b.branch_id === ch.branchId))
                    entry.branches.push({ branch_id: ch.branchId, teams: [] }); // eslint-disable-line camelcase
                entry.urls[ch.branchId ?? 'default'] = ch.url;
                if (!entry.urls.default) entry.urls.default = ch.url;
                merged.set(key, entry);
            }

            return [...merged.values()].sort((a, b) => {
                const volA = parseFloat(a.volume) || 0;
                const volB = parseFloat(b.volume) || 0;
                if (volA !== volB) return volA - volB;
                return (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0);
            });
        }

        /**
         * Открывает главу в читалке и собирает ссылки на изображения всех её страниц.
         * @param {string} url - Адрес главы в читалке.
         * @param {{onProgress?: function(string): void, checkpoint?: function(): Promise<void>}} [opts]
         * Колбэк прогресса и проверка паузы/остановки загрузки.
         * @returns {Promise<string[]>} Ссылки на изображения страниц по порядку.
         * @throws {Error} Если читалка не загрузилась или какая-то страница не найдена.
         */
        async fetchChapterPages(url, opts = {}) {
            let state = await this._openWithRetry(url, pageProbeReader, s => s.total > 0, {
                notFound: `Глава не найдена на сайте: ${url}`,
                empty: 'В читалке не найдено ни одной страницы главы (DOM)',
                onProgress: opts.onProgress
            });
            // Переключение страницы заставляет читалку скачать картинку с CDN — это полоса «картинки».
            const pacer = this._pacer('images');

            const urls = new Map();
            const remember = s => s.pages.forEach(p => { if (p.src) urls.set(p.num, p.src); });
            remember(state);

            const nums = state.pages.map(p => p.num).sort((a, b) => a - b);
            for (const num of nums) {
                if (urls.has(num)) continue;
                if (opts.checkpoint) await opts.checkpoint();
                if (opts.onProgress) opts.onProgress(`Поиск страниц: ${urls.size}/${nums.length}`);

                // Переключение страницы заставляет читалку загрузить изображение — тоже запрос к сайту.
                if (pacer) await pacer.acquire(1);
                await this._exec(pageReaderGoTo, [num]);
                state = await this._waitFor(pageProbeReader, [],
                    s => s.pages.some(p => p.num === num && p.src), PAGE_TIMEOUT);
                remember(state);
                if (!urls.has(num))
                    throw new Error(`Не удалось найти ссылку на изображение страницы ${num} из ${nums.length}`);
            }

            return nums.map(n => urls.get(n));
        }

        /**
         * @returns {?object} Общий регулятор запросов (RequestPacer), если доступен.
         */
        _pacer(lane = 'site') {
            return typeof global.getRequestPacer === 'function' ? global.getRequestPacer(lane) : null;
        }

        /**
         * Открывает страницу сайта и ждёт её содержимого, переживая ограничения частоты:
         * - ответы API страницы 403/429/503 → пауза регулятора для всех запросов и повтор;
         * - пустая страница без видимой причины → быстрый повтор, затем паузы регулятора
         *   (сайт под нагрузкой часто просто не отдаёт данные);
         * - явная причина на странице (платная/удалённая глава) → ошибка сразу.
         * @param {string} url - Адрес страницы.
         * @param {function} probe - Функция-снимок состояния страницы.
         * @param {function(object): boolean} isDone - Готово ли содержимое.
         * @param {{notFound: string, empty: string, onProgress?: function(string): void}} texts
         * Тексты ошибок и колбэк статуса.
         * @returns {Promise<object>} Снимок готовой страницы.
         * @throws {Error} Если страница недоступна или сервер не снимает ограничение.
         */
        async _openWithRetry(url, probe, isDone, texts) {
            const pacer = this._pacer();
            const throttleStatus = s => (s.apiErrors || []).find(st => [403, 429, 503].includes(st)) || null;
            let quickRetryUsed = false;

            for (;;) {
                await this._open(url);
                await this._exec(pageInstallRafShim);
                const state = await this._waitFor(probe, [],
                    s => s.needsAuth || s.notFound || isDone(s), CONTENT_TIMEOUT);

                if (state.needsAuth) throw new Error(authRequiredMessage(this.siteUrl));
                if (state.notFound) throw new Error(texts.notFound);
                if (isDone(state)) {
                    if (pacer) pacer.success();
                    return state;
                }
                if (state.blockedText && !state.limitText)
                    throw new Error(`${texts.empty}. На странице: «${state.blockedText}»`);

                const status = throttleStatus(state);
                try {
                    if (state.limitText && pacer)
                        await pacer.throttled(status || 429, null, `сайт: «${state.limitText}»`);
                    else if (status && pacer)
                        await pacer.throttled(status);
                     else if (!quickRetryUsed) {
                        quickRetryUsed = true;
                        if (texts.onProgress) texts.onProgress('Сайт не отдал содержимое, повторная попытка...');
                        await this._sleep(5000);
                    } else if (pacer)
                        await pacer.throttled(0, null, 'сайт не отдаёт содержимое страниц');
                     else
                        throw new Error(texts.empty);
                } catch (e) {
                    if (e?.rateLimited) e.message = `${texts.empty}. ${e.message}`;
                    throw e;
                }
            }
        }

        /**
         * Закрывает служебную вкладку.
         * @returns {Promise<void>}
         */
        async close() {
            const { tabId } = this;
            this.tabId = null;
            this._closed = true;
            if (this._onRemoved) {
                try { this.api.tabs.onRemoved.removeListener(this._onRemoved); } catch (e) { /* ignore */ }
                this._onRemoved = null;
            }

            if (tabId == null) {
                this._releaseGuard();
                return;
            }

            try {
                await this.api.tabs.remove(tabId);
            } catch (e) {
                console.warn('[MangaLibDomScraper] Failed to close helper tab:', e?.message || e);
            }
            this._releaseGuard();
        }

        /**
         * Открывает порт к background-скрипту, который закроет служебную вкладку,
         * если страница расширения закроется раньше, чем вызовет close()
         * (например, пользователь закрыл попап во время сканирования).
         * @param {number} tabId - id служебной вкладки.
         * @returns {void}
         */
        _guardTab(tabId) {
            this._releaseGuard();
            if (!this.guardTab) return;
            const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : null;
            if (!api?.runtime?.connect) return;

            const guard = { stopped: false, port: null, interval: null, timer: null };
            const connect = () => {
                if (guard.stopped) return;
                try {
                    guard.port = api.runtime.connect({ name: `domHelperTab:${tabId}` });
                    guard.interval = setInterval(() => {
                        try { guard.port.postMessage({ type: 'ping' }); } catch (e) { clearInterval(guard.interval); }
                    }, 20000);
                    guard.port.onDisconnect?.addListener?.(() => {
                        clearInterval(guard.interval);
                        if (!guard.stopped) guard.timer = setTimeout(connect, 1000);
                    });
                } catch (e) {
                    console.warn('[MangaLibDomScraper] Failed to guard helper tab:', e?.message || e);
                }
            };
            connect();
            this._guard = guard;
        }

        /**
         * Снимает защиту служебной вкладки (она закрыта или больше не нужна).
         * @returns {void}
         */
        _releaseGuard() {
            const guard = this._guard;
            if (!guard) return;
            this._guard = null;
            guard.stopped = true;
            clearInterval(guard.interval);
            clearTimeout(guard.timer);
            try {
                guard.port?.postMessage({ type: 'release' });
                guard.port?.disconnect();
            } catch (e) { /* порт уже закрыт */ }
        }

        /**
         * Открывает URL в служебной вкладке (создаёт её при первом вызове) и ждёт загрузки.
         * @param {string} url - Адрес страницы.
         * @returns {Promise<void>}
         */
        async _open(url) {
            const { api } = this;
            // Загрузка страницы сайта — это сразу несколько запросов (HTML, API, картинки),
            // поэтому она занимает несколько слотов регулятора.
            const pacer = this._pacer();
            if (pacer) await pacer.acquire(PAGE_LOAD_COST);
            // Сборщик закрыт (загрузка закончилась), а опоздавшая подготовка главы
            // пытается открыть страницу — новую вкладку не создаём.
            if (this._closed) throw new Error('Служебная вкладка режима DOM уже закрыта');

            if (this.tabId != null) {
                try {
                    // Помечаем текущий документ, чтобы не прочитать старую страницу,
                    // пока вкладка ещё не начала загружать новую.
                    await this._exec(pageMarkStale).catch(() => {});
                    await api.tabs.update(this.tabId, { url });
                    await this._waitComplete(this.tabId);
                    return;
                } catch (e) {
                    console.warn('[MangaLibDomScraper] Helper tab lost, reopening:', e?.message || e);
                    this.tabId = null;
                }
            }

            const createProps = { url, active: false };
            try {
                const tabs = await api.tabs.query({ url: this.tabPatterns });
                const host = (tabs || []).find(t => t.windowId != null);
                if (host) createProps.windowId = host.windowId;
            } catch (e) { /* без windowId вкладка откроется в текущем окне */ }

            const tab = await api.tabs.create(createProps);
            if (!tab?.id) throw new Error('Не удалось открыть служебную вкладку для режима DOM');
            this.tabId = tab.id;
            this._guardTab(tab.id);
            // Служебная вкладка постоянно переходит между страницами — через неё нельзя качать картинки.
            if (typeof global.excludeServiceTab === 'function') global.excludeServiceTab(tab.id);

            if (!this._onRemoved && api.tabs.onRemoved?.addListener) {
                this._onRemoved = (removedId) => { if (removedId === this.tabId) this.tabId = null; };
                api.tabs.onRemoved.addListener(this._onRemoved);
            }
            await this._waitComplete(this.tabId);
        }

        /**
         * Ждёт, пока вкладка закончит загрузку страницы.
         * @param {number} tabId - id вкладки.
         * @returns {Promise<void>}
         * @throws {Error} Если вкладка закрыта или не загрузилась за отведённое время.
         */
        async _waitComplete(tabId) {
            const started = Date.now();
            await this._sleep(300);
            while (Date.now() - started < TAB_LOAD_TIMEOUT) {
                if (this.tabId !== tabId) throw new Error('Служебная вкладка режима DOM была закрыта');
                let tab;
                try {
                    tab = await this.api.tabs.get(tabId);
                } catch (e) {
                    throw new Error('Служебная вкладка режима DOM была закрыта');
                }

                if (tab?.status === 'complete') {
                    const fresh = await this._exec(pageIsFresh).catch(() => false);
                    if (fresh) return;
                }
                await this._sleep(250);
            }
            throw new Error('Страница сайта не загрузилась за отведённое время');
        }

        /**
         * Выполняет функцию в контексте страницы служебной вкладки. Сначала в мире
         * страницы (MAIN), а если браузер его не поддерживает — в изолированном мире.
         * @param {function} func - Самодостаточная функция.
         * @param {Array} [args] - Аргументы (сериализуемые).
         * @returns {Promise<*>} Результат функции.
         */
        async _exec(func, args = []) {
            if (this.tabId == null) throw new Error('Служебная вкладка режима DOM была закрыта');
            const target = { tabId: this.tabId };
            // Скрипт в загружающейся странице может ждать её готовности долго —
            // при остановке загрузки ожидание прерывается сразу.
            const gate = typeof this.getGate === 'function' ? this.getGate() : null;
            const run = details => (typeof global.abortable === 'function'
                ? global.abortable(this.api.scripting.executeScript(details), gate)
                : this.api.scripting.executeScript(details));
            let results;
            if (this._world) {
                try {
                    results = await run({ target, world: this._world, func, args });
                } catch (e) {
                    if (e?.aborted) throw e;
                    if (!/world/i.test(String(e?.message || e))) throw this._wrapExecError(e);
                    this._world = null;
                }
            }

            if (!results) {
                try {
                    results = await run({ target, func, args });
                } catch (e) {
                    if (e?.aborted) throw e;
                    throw this._wrapExecError(e);
                }
            }
            return results?.[0]?.result;
        }

        /**
         * @param {*} e - Исходная ошибка executeScript.
         * @returns {Error} Ошибка с понятным текстом.
         */
        _wrapExecError(e) {
            return new Error(`Не удалось прочитать страницу сайта: ${e?.message || e}`);
        }

        /**
         * Повторяет probe, пока predicate не вернёт true или не выйдет время.
         * @param {function} probe - Функция-снимок, исполняемая на странице.
         * @param {Array} args - Аргументы probe.
         * @param {function(*): boolean} predicate - Условие готовности.
         * @param {number} timeoutMs - Максимальное время ожидания.
         * @returns {Promise<*>} Последний снимок.
         */
        async _waitFor(probe, args, predicate, timeoutMs) {
            const started = Date.now();
            let last;
            do {
                last = await this._exec(probe, args);
                if (last && predicate(last)) return last;
                await this._sleep(150);
            } while (Date.now() - started < timeoutMs);
            return last || {};
        }

        /**
         * Пауза с проверкой остановки загрузки (checkpoint задаёт сервис).
         * @param {number} ms - Пауза в миллисекундах.
         * @returns {Promise<void>}
         */
        async _sleep(ms) {
            await new Promise(resolve => setTimeout(resolve, ms));
            if (typeof this.checkpoint === 'function') await this.checkpoint();
        }
    }

    MangaLibDomScraper.parseChapterLink = parseChapterLink;
    global.MangaLibDomScraper = MangaLibDomScraper;
    console.log('[MangaLibDomScraper] Loaded');
})(typeof window !== 'undefined' ? window : self);
