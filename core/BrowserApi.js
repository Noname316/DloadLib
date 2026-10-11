/**
 * DownloadLib core module
 * Cross-browser API adapter for Firefox and Chromium
 * @module core/BrowserApi
 * @license MIT
 * @author ivanvit
 * @version 1.0.6
 */

'use strict';

(function(global) {
    /**
     * Оборачивает callback-based метод в промис, преобразуя chrome.runtime.lastError
     * (при его наличии) в отклонение промиса.
     * @param {function} fn - Callback-based функция API (последний аргумент — колбэк результата).
     * @param {object} context - Контекст (this), с которым нужно вызвать fn.
     * @param {Array} args - Аргументы вызова fn (без колбэка).
     * @returns {Promise<*>} Промис, разрешающийся результатом колбэка или отклоняющийся ошибкой.
     */
    function toPromise(fn, context, args) {
        return new Promise((resolve, reject) => {
            try {
                fn.call(context, ...args, (result) => {
                    const err = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
                    if (err) {
                        reject(new Error(err.message || String(err)));
                        return;
                    }
                    resolve(result);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Оборачивает callback-based Chrome extension API в promise-based интерфейс,
     * совместимый по форме вызова с нативным WebExtensions API Firefox (browser.*).
     * @param {?object} chromeApi - Глобальный объект chrome, либо null.
     * @returns {?object} Promise-based обёртка над chromeApi (runtime, tabs, windows,
     * downloads, storage.local — с промисифицированными методами; scripting,
     * webRequest, declarativeNetRequest — переданы как есть), либо null, если chromeApi не передан.
     */
    function createChromePromiseApi(chromeApi) {
        if (!chromeApi) return null;

        return {
            runtime: {
                ...chromeApi.runtime,
                sendMessage: (...args) => toPromise(chromeApi.runtime.sendMessage, chromeApi.runtime, args)
            },
            tabs: {
                ...chromeApi.tabs,
                query: (...args) => toPromise(chromeApi.tabs.query, chromeApi.tabs, args),
                get: (...args) => toPromise(chromeApi.tabs.get, chromeApi.tabs, args)
            },
            windows: {
                ...chromeApi.windows,
                getCurrent: (...args) => toPromise(chromeApi.windows.getCurrent, chromeApi.windows, args),
                create: (...args) => toPromise(chromeApi.windows.create, chromeApi.windows, args),
                update: (...args) => toPromise(chromeApi.windows.update, chromeApi.windows, args)
            },
            downloads: {
                ...chromeApi.downloads,
                download: (...args) => toPromise(chromeApi.downloads.download, chromeApi.downloads, args)
            },
            storage: {
                ...chromeApi.storage,
                local: chromeApi.storage && chromeApi.storage.local ? {
                    ...chromeApi.storage.local,
                    get: (...args) => toPromise(chromeApi.storage.local.get, chromeApi.storage.local, args),
                    set: (...args) => toPromise(chromeApi.storage.local.set, chromeApi.storage.local, args)
                } : void 0
            },
            scripting: chromeApi.scripting,
            webRequest: chromeApi.webRequest,
            declarativeNetRequest: chromeApi.declarativeNetRequest
        };
    }

    /**
     * Определяет доступное расширение-API текущего браузера: нативный browser
     * (Firefox, уже promise-based) или chrome (промисифицируется отдельно).
     * @returns {{api: ?object, nativeName: 'browser'|'chrome'|'none'}} Найденный API
     * и имя нативного пространства имён.
     */
    function resolveNativeApi() {
        if (typeof global.browser !== 'undefined' && global.browser)
            return { api: global.browser, nativeName: 'browser' };
        if (typeof global.chrome !== 'undefined' && global.chrome)
            return { api: createChromePromiseApi(global.chrome), nativeName: 'chrome' };
        return { api: null, nativeName: 'none' };
    }

    /**
     * Определяет характеристики текущего браузерного окружения. Наличие пространства
     * имён browser само по себе не означает Firefox (Chrome тоже его предоставляет) —
     * надёжным признаком служит поддержка chrome.declarativeNetRequest.
     * @param {'browser'|'chrome'|'none'} nativeName - Имя нативного API из resolveNativeApi.
     * @returns {{nativeName: string, isFirefox: boolean, isChromium: boolean, supportsDnr: boolean}}
     * Флаги окружения.
     */
    function resolveEnv(nativeName) {
        const hasChrome = typeof global.chrome !== 'undefined' && !!global.chrome;
        const hasBrowser = typeof global.browser !== 'undefined' && !!global.browser;
        const supportsDnr = !!(hasChrome && global.chrome.declarativeNetRequest);
        const isFirefox = hasBrowser && !supportsDnr;
        const isChromium = hasChrome && !isFirefox;

        return {
            nativeName,
            isFirefox,
            isChromium,
            supportsDnr
        };
    }

    /**
     * Возвращает единый promise-based API расширения для текущего браузера.
     * @returns {?object} Ранее определённый extensionApi, либо null.
     */
    function getExtensionApi() {
        return global.extensionApi || null;
    }

    /**
     * Возвращает характеристики текущего браузерного окружения.
     * @returns {{nativeName: string, isFirefox: boolean, isChromium: boolean, supportsDnr: boolean}}
     * Ранее определённый browserEnv, либо безопасные значения по умолчанию, если он не был вычислен.
     */
    function getBrowserEnv() {
        return global.browserEnv || {
            nativeName: 'none',
            isFirefox: false,
            isChromium: false,
            supportsDnr: false
        };
    }

    const resolved = resolveNativeApi();
    global.extensionApi = resolved.api;
    global.browserEnv = resolveEnv(resolved.nativeName);
    global.getExtensionApi = getExtensionApi;
    global.getBrowserEnv = getBrowserEnv;

    /**
     * Бросается, когда для сервиса не найдено открытой вкладки, через которую можно
     * выполнить запрос в её контексте. В отличие от обычной ошибки одного запроса,
     * означает, что весь пакет запросов (например, все страницы главы) заведомо
     * провалится — вызывающий код должен прервать операцию, а не деградировать постранично.
     */
    class NoServiceTabError extends Error {}

    // Запомненные вкладки — отдельно для каждого сайта. Одна общая вкладка на все сайты
    // приводила к тому, что запрос к com-x выполнялся во вкладке MangaLib и браузер
    // его блокировал («TypeError: Failed to fetch»).
    /** @type {Map<string, {tabId: number, expiry: number}>} */
    const _serviceTabs = new Map();
    const _excludedTabs = new Set();
    const TAB_CACHE_MS = 3600000;
    // Тайм-ауты запросов, выполняемых во вкладке сайта.
    const IMAGE_FETCH_TIMEOUT_MS = 30000;
    const API_FETCH_TIMEOUT_MS = 45000;

    /**
     * @param {?string} serviceKey - Ключ сервиса.
     * @returns {string} Ключ кэша вкладок (без ключа — MangaLib, как и в _getTabPatterns).
     */
    function _tabCacheKey(serviceKey) {
        return serviceKey || 'mangalib';
    }

    /**
     * Забывает вкладку во всех записях кэша (закрыта, ушла с сайта, служебная).
     * @param {number} tabId - id вкладки.
     * @returns {void}
     */
    function _forgetTab(tabId) {
        for (const [key, entry] of _serviceTabs)
            if (entry.tabId === tabId) _serviceTabs.delete(key);
    }

    /**
     * Запоминает вкладку сервиса на час — приоритетный кандидат для запросов через вкладку.
     * @param {number} tabId - id вкладки сервиса.
     * @param {string} [serviceKey] - Ключ сервиса, к сайту которого относится вкладка.
     * @returns {void}
     */
    function setServiceTab(tabId, serviceKey) {
        _serviceTabs.set(_tabCacheKey(serviceKey), { tabId, expiry: Date.now() + TAB_CACHE_MS });
    }

    /**
     * Проверяет, что адрес относится к сайту из match-паттернов вида `*://host/*`
     * или `*://*.host/*`.
     * @param {?string} url - Адрес вкладки.
     * @param {string[]} patterns - Паттерны.
     * @returns {boolean} true, если вкладка на этом сайте.
     */
    function _urlMatchesPatterns(url, patterns) {
        let host;
        try {
            host = new URL(url).hostname.toLowerCase();
        } catch {
            return false;
        }
        return patterns.some(pattern => {
            const patternHost = String(pattern).split('://')[1]?.split('/')[0]?.toLowerCase() || '';
            if (patternHost.startsWith('*.')) {
                const base = patternHost.slice(2);
                return host === base || host.endsWith(`.${base}`);
            }
            return host === patternHost;
        });
    }

    /**
     * Ищет хосты кастомного плагина, зарегистрированного под указанным ключом сервиса.
     * @param {object} api - Promise-based API расширения.
     * @param {string} serviceKey - Ключ сервиса (или плагина).
     * @returns {Promise<string[]>} Список хостов плагина, либо пустой массив,
     * если плагин не найден, отключён или storage недоступен.
     */
    async function _resolvePluginHosts(api, serviceKey) {
        if (!api?.storage?.local) return [];
        try {
            const result = await api.storage.local.get('custom_plugins');
            const plugin = (result?.custom_plugins || [])
                .find(p => p.service === serviceKey && p.enabled !== false);
            return plugin?.hosts || [];
        } catch {
            return [];
        }
    }

    /**
     * Строит список match-паттернов вкладок для поиска открытой вкладки сервиса.
     * @param {object} api - Promise-based API расширения.
     * @param {string} [serviceKey] - Ключ сервиса ('ranobelib', 'mangalib' или ключ плагина).
     * @returns {Promise<string[]>} Список match-паттернов вида '*://host/*'.
     */
    async function _getTabPatterns(api, serviceKey) {
        if (serviceKey === 'ranobelib') return ['*://ranobelib.me/*'];
        if (!serviceKey || serviceKey === 'mangalib') return ['*://mangalib.me/*', '*://mangalib.org/*'];
        // Встроенные сервисы с собственными шаблонами вкладок (например, com-x).
        const configured = global.serviceRegistry?.getService?.(serviceKey)?.config?.tabPatterns;
        if (Array.isArray(configured) && configured.length) return configured;
        const hosts = await _resolvePluginHosts(api, serviceKey);
        return hosts.map(h => `*://${h}/*`);
    }

    /**
     * Находит id вкладки сервиса для выполнения запроса в её контексте, кэшируя
     * результат на час между вызовами. Общий хелпер для fetchViaTab и requestViaTab.
     * @param {object} api - Promise-based API расширения.
     * @param {string} [serviceKey] - Ключ сервиса, вкладку которого нужно найти.
     * @returns {Promise<?number>} id найденной вкладки, либо null, если не найдена.
     */
    async function _resolveServiceTabId(api, serviceKey) {
        const key = _tabCacheKey(serviceKey);
        const patterns = await _getTabPatterns(api, serviceKey);
        if (!patterns.length) return null;

        // Запомненная вкладка годится, только если она всё ещё открыта и на этом сайте.
        const cached = _serviceTabs.get(key);
        if (cached && Date.now() <= cached.expiry && !_excludedTabs.has(cached.tabId)) {
            let tab = null;
            try {
                tab = await api.tabs.get(cached.tabId);
            } catch { /* вкладка закрыта */ }
            if (tab && !tab.discarded && _urlMatchesPatterns(tab.url, patterns)) return cached.tabId;
            _serviceTabs.delete(key);
        }

        try {
            const tabs = (await api.tabs.query({ url: patterns }) || [])
                .filter(t => !_excludedTabs.has(t.id) && !t.discarded);
            const tabId = tabs?.[0]?.id ?? null;
            if (tabId) _serviceTabs.set(key, { tabId, expiry: Date.now() + TAB_CACHE_MS });
            return tabId;
        } catch (e) {
            console.warn('[BrowserApi] tabs.query failed:', e.message);
            return null;
        }
    }

    /**
     * Исключает вкладку из поиска вкладки сервиса (служебная вкладка режима DOM:
     * она постоянно переходит между страницами, и запросы через неё обрывались бы).
     * @param {number} tabId - id вкладки.
     * @returns {void}
     */
    function excludeServiceTab(tabId) {
        if (tabId == null) return;
        _excludedTabs.add(tabId);
        _forgetTab(tabId);
    }

    /**
     * Загружает ресурс по URL в контексте вкладки сервиса (в обход CORS и ограничений
     * фонового контекста), кэшируя найденную вкладку сервиса на час между вызовами.
     * Если вкладка закрылась, находит другую и повторяет запрос.
     * @param {string} url - URL ресурса для загрузки.
     * @param {string} [serviceKey] - Ключ сервиса, вкладку которого нужно использовать.
     * @param {{cache?: string}} [options] - cache: режим кэша fetch ('force-cache' — взять
     * из кэша браузера, если ресурс там есть).
     * @returns {Promise<?{ok: boolean, base64?: string, contentType?: string, status?: number,
     * retryAfter?: ?string, ms?: number, fromCache?: boolean}>} Результат загрузки в виде base64
     * (fromCache — ответ получен из кэша браузера, без запроса к серверу), либо null, если
     * подходящая вкладка не найдена или запрос не удался.
     */
    async function fetchViaTab(url, serviceKey, options = {}) {
        const api = getExtensionApi();
        if (!api?.scripting?.executeScript) return null;

        for (let attempt = 0; attempt < 2; attempt++) {
            const tabId = await _resolveServiceTabId(api, serviceKey);
            if (!tabId) return null;

            try {
                const results = await api.scripting.executeScript({
                    target: { tabId },
                    /**
                     * Инжектируется в контекст вкладки: загружает ресурс по URL и
                     * кодирует его в base64, замеряя время запроса.
                     * @param {string} imageUrl - URL загружаемого ресурса.
                     * @param {?string} cacheMode - Режим кэша fetch.
                     * @returns {Promise<?object>} Результат загрузки; при HTTP-ошибке — ok=false
                     * со статусом, при сетевой ошибке — null.
                     */
                    func: async (imageUrl, cacheMode, timeoutMs) => {
                        // Тайм-аут: соединение, которое сервер держит открытым, не должно висеть минутами.
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), timeoutMs);
                        try {
                            const started = performance.now();
                            const init = { signal: controller.signal };
                            if (cacheMode) init.cache = cacheMode;
                            const r = await fetch(imageUrl, init);
                            if (!r.ok) return { ok: false, status: r.status, retryAfter: r.headers.get('Retry-After') };
                            const blob = await r.blob();
                            clearTimeout(timer);
                            const ms = performance.now() - started;
                            const contentType = blob.type || 'image/jpeg';
                            return await new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve({
                                    ok: true,
                                    base64: reader.result.split(',')[1],
                                    contentType,
                                    ms,
                                    // Ответ из кэша браузера приходит за единицы миллисекунд,
                                    // запрос по сети — за десятки и сотни.
                                    fromCache: !!cacheMode && ms < 15
                                });
                                reader.readAsDataURL(blob);
                            });
                        } catch {
                            return null;
                        } finally {
                            clearTimeout(timer);
                        }
                    },
                    args: [url, options.cache || null, IMAGE_FETCH_TIMEOUT_MS]
                });
                return results?.[0]?.result ?? null;
            } catch (e) {
                // Вкладка закрыта или перезагружается — ищем другую вкладку сервиса.
                console.warn('[BrowserApi] fetchViaTab failed:', e.message);
                _forgetTab(tabId);
            }
        }
        return null;
    }

    /**
     * Проверяет, есть ли открытая вкладка сервиса, через которую можно выполнить запрос.
     * @param {string} [serviceKey] - Ключ сервиса.
     * @returns {Promise<boolean>} true, если подходящая вкладка найдена.
     */
    async function hasServiceTab(serviceKey) {
        const api = getExtensionApi();
        if (!api?.scripting?.executeScript) return false;
        return !!(await _resolveServiceTabId(api, serviceKey));
    }

    /**
     * Выполняет произвольный fetch в контексте вкладки сервиса и возвращает текстовый
     * результат — в отличие от fetchViaTab (бинарные ресурсы как base64), предназначен
     * для JSON/текстовых API-запросов. Запрос реально уходит со страницы сервиса, поэтому
     * браузер сам ставит корректные Referer/Origin — подделывать их не нужно.
     * @param {string} url - URL запроса.
     * @param {object} [options] - Опции fetch (method, headers, body, credentials, mode, cache).
     * @param {string} [serviceKey] - Ключ сервиса, вкладку которого нужно использовать.
     * @returns {Promise<{ok: boolean, status?: number, text?: string, retryAfter?: ?string,
     * noTab?: boolean, error?: string}>} Результат запроса; noTab=true означает, что
     * подходящая вкладка не найдена (и запрос не выполнялся).
     */
    async function requestViaTab(url, options, serviceKey) {
        const api = getExtensionApi();
        if (!api?.scripting?.executeScript) return { ok: false, noTab: true };

        const tabId = await _resolveServiceTabId(api, serviceKey);
        if (!tabId) return { ok: false, noTab: true };

        try {
            const results = await api.scripting.executeScript({
                target: { tabId },
                /**
                 * Инжектируется в контекст вкладки: выполняет fetch и возвращает текстовое
                 * тело ответа вместе со статусом и заголовком Retry-After.
                 * @param {string} u - URL запроса.
                 * @param {object} opts - Опции fetch.
                 * @returns {Promise<{ok: boolean, status: number, text: string, retryAfter: ?string}>}
                 * Результат запроса.
                 */
                func: async (u, opts, timeoutMs) => {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), timeoutMs);
                    try {
                        const r = await fetch(u, { ...opts, signal: controller.signal });
                        const text = await r.text();
                        // url — итоговый адрес после перенаправлений (страница антибот-проверки сайта и т.п.).
                        const retryAfter = r.headers.get('Retry-After');
                        return { ok: r.ok, status: r.status, text, url: r.url, retryAfter };
                    } catch (e) {
                        const timedOut = e?.name === 'AbortError';
                        const error = timedOut ? 'нет ответа от сервера (тайм-аут)' : String(e);
                        return { ok: false, status: 0, text: '', error };
                    } finally {
                        clearTimeout(timer);
                    }
                },
                args: [url, options || {}, API_FETCH_TIMEOUT_MS]
            });
            const result = results?.[0]?.result;
            return result ? { ...result, noTab: false } : { ok: false, noTab: false, error: 'No result from tab' };
        } catch (e) {
            // Вкладка закрыта или перезагружается — следующий запрос найдёт другую.
            console.warn('[BrowserApi] requestViaTab failed:', e.message);
            _forgetTab(tabId);
            return { ok: false, noTab: false, error: String(e) };
        }
    }

    global.setServiceTab = setServiceTab;
    global.fetchViaTab = fetchViaTab;
    global.excludeServiceTab = excludeServiceTab;
    global.hasServiceTab = hasServiceTab;
    global.requestViaTab = requestViaTab;
    global.NoServiceTabError = NoServiceTabError;

    console.log('[BrowserApi] Loaded:', global.browserEnv.nativeName);
})(typeof window !== 'undefined' ? window : self);
