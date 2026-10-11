/**
 * DownloadLib background module
 * Toolbar icon: opens the download window for the current tab and greys out
 * the icon on unsupported sites
 * @module background/ActionButton
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[ActionButton] Loading...');

    const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : null;
    // Обёртка extensionApi не включает action, поэтому берём нативный объект браузера.
    const action = global.chrome?.action || global.browser?.action || null;

    const WINDOW_SIZE = { width: 350, height: 650 };
    const DEFAULT_ICON = { 16: '/icons/icon16.png', 32: '/icons/icon48.png' };
    const GREY_SOURCES = { 16: '/icons/icon16.png', 32: '/icons/icon48.png' };

    /** @type {Map<string, number>} Открытые окна расширения: ключ (вкладка + параметры) → id окна. */
    const openWindows = new Map();
    let greyIconPromise = null;

    /**
     * Находит встроенный сервис по адресу страницы.
     * @param {string} url - Адрес страницы.
     * @returns {?object} Экземпляр сервиса или null.
     */
    function serviceForUrl(url) {
        if (!url || !/^https?:/i.test(url)) return null;
        try {
            return global.serviceRegistry?.getServiceByUrl(url) || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Извлекает slug тайтла: у сервиса может быть свой формат адреса (com-x),
     * у MangaLib/RanobeLib — /manga/{slug} или /book/{slug}.
     * @param {object} service - Сервис.
     * @param {string} url - Адрес страницы.
     * @returns {?string} Slug или null, если это не страница тайтла.
     */
    function slugForUrl(service, url) {
        if (typeof service?.constructor?.extractSlug === 'function') return service.constructor.extractSlug(url);
        const match = /\/(?:manga|book)\/([^/?#]+)/.exec(url);
        return match ? match[1] : null;
    }

    /**
     * Открывает окно расширения для вкладки или выводит вперёд уже открытое для неё.
     * На странице тайтла — окно загрузки; на поддерживаемом сайте без тайтла — подсказку;
     * на другом сайте — экран со ссылками на поддерживаемые сайты (там же история и настройки).
     * @param {object} tab - Вкладка (id, url).
     * @param {{format?: string}} [extra] - Дополнительные параметры (формат с кнопки на сайте).
     * @returns {Promise<boolean>} true, если окно открыто или выведено вперёд.
     */
    async function openForTab(tab, extra = {}) {
        const params = new URLSearchParams();
        const service = serviceForUrl(tab?.url);
        const slug = service ? slugForUrl(service, tab.url) : null;
        if (slug) {
            params.set('download', 'true');
            params.set('slug', slug);
            params.set('service', service.name);
        }
        if (extra.format) params.set('format', extra.format);
        if (tab?.id != null) params.set('tabId', String(tab.id));

        const key = `${tab?.id}|${slug || ''}|${service?.name || ''}`;
        const existing = openWindows.get(key);
        if (existing != null) {
            try {
                await api.windows.update(existing, { focused: true });
                return true;
            } catch (e) {
                openWindows.delete(key);
            }
        }

        const url = `${api.runtime.getURL('popup.html')  }?${  params.toString()}`;
        if (api?.windows?.create) {
            const win = await api.windows.create({
                url, type: 'popup', ...WINDOW_SIZE, focused: true, state: 'normal'
            });
            if (win?.id != null) openWindows.set(key, win.id);
            return !!win;
        }
        if (api?.tabs?.create) return !!(await api.tabs.create({ url, active: true }));
        return false;
    }

    /**
     * Строит серую полупрозрачную версию значка (для неподдерживаемых сайтов).
     * Картинки рисуются из самого значка, отдельные файлы не нужны.
     * @returns {Promise<?object>} Словарь {размер: ImageData} или null, если canvas недоступен.
     */
    function greyIcon() {
        if (!greyIconPromise) {
            greyIconPromise = (async () => {
                const result = {};
                for (const [size, path] of Object.entries(GREY_SOURCES)) {
                    const blob = await (await fetch(api.runtime.getURL(path))).blob();
                    const bitmap = await createImageBitmap(blob);
                    const n = Number(size);
                    const canvas = typeof OffscreenCanvas !== 'undefined'
                        ? new OffscreenCanvas(n, n)
                        : Object.assign(document.createElement('canvas'), { width: n, height: n });
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(bitmap, 0, 0, n, n);
                    const image = ctx.getImageData(0, 0, n, n);
                    const px = image.data;
                    for (let i = 0; i < px.length; i += 4) {
                        const gray = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
                        px[i] = gray;
                        px[i + 1] = gray;
                        px[i + 2] = gray;
                        px[i + 3] = Math.round(px[i + 3] * 0.55);
                    }
                    result[size] = image;
                }
                return result;
            })().catch(e => {
                console.warn('[ActionButton] Failed to build grey icon:', e?.message || e);
                greyIconPromise = null;
                return null;
            });
        }
        return greyIconPromise;
    }

    /**
     * Красит значок для вкладки: цветной на поддерживаемых сайтах, серый на остальных.
     * @param {object} tab - Вкладка (id, url).
     * @returns {Promise<void>}
     */
    async function updateIcon(tab) {
        if (!action?.setIcon || tab?.id == null || tab.id < 0) return;
        try {
            if (serviceForUrl(tab.url)) {
                await action.setIcon({ tabId: tab.id, path: DEFAULT_ICON });
                await action.setTitle?.({ tabId: tab.id, title: 'DloadLIB — скачать тайтл' });
            } else {
                const imageData = await greyIcon();
                if (imageData) await action.setIcon({ tabId: tab.id, imageData });
                await action.setTitle?.({ tabId: tab.id, title: 'DloadLIB: сайт не поддерживается' });
            }
        } catch (e) {
            // Вкладка закрылась или это служебная страница браузера — ничего страшного.
        }
    }

    if (action?.onClicked) {
        action.onClicked.addListener(tab => {
            openForTab(tab).catch(e => console.error('[ActionButton] Failed to open window:', e));
        });
    }

    if (api?.tabs?.onUpdated) {
        api.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
            if (changeInfo.url || changeInfo.status === 'loading') updateIcon(tab);
        });
    }

    if (api?.windows?.onRemoved) {
        api.windows.onRemoved.addListener(windowId => {
            for (const [key, id] of openWindows) if (id === windowId) openWindows.delete(key);
        });
    }

    // При запуске фона (и после выгрузки service worker'а) — раскрасить уже открытые вкладки.
    if (api?.tabs?.query)
        api.tabs.query({}).then(tabs => (tabs || []).forEach(updateIcon)).catch(() => {});

    global.DownloadWindows = { openForTab, updateIcon };
    console.log('[ActionButton] Loaded');
})(typeof window !== 'undefined' ? window : self);
