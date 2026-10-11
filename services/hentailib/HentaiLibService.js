/**
 * DownloadLib HentaiLib service module
 * @module services/hentailib/HentaiLibService
 * @license MIT
 */

'use strict';

(function(global) {
    console.log('[HentaiLibService] Loading...');

    if (!global.MangaLibService || !global.hentailibConfig) {
        console.error('[HentaiLibService] MangaLibService or hentailibConfig not loaded');
        return;
    }

    /**
     * Сервис HentaiLib: сайт на той же платформе, что MangaLib, поэтому API, режим DOM
     * и загрузка страниц полностью унаследованы — отличаются конфигурация (Site-Id 4,
     * домены сайта и картинок) и распознавание адресов.
     * Главы на HentaiLib доступны только после входа: без токена API отвечает 404.
     */
    class HentaiLibService extends global.MangaLibService {
        /**
         * Создаёт сервис с конфигурацией HentaiLib.
         */
        constructor() {
            super(global.hentailibConfig);
            // Служебная вкладка режима DOM ищется среди вкладок HentaiLib, а не MangaLib.
            this.domScraperOptions = { tabPatterns: this.config.tabPatterns };
        }

        /**
         * Загружает главу; без входа на сайт API HentaiLib отвечает 404 «Not Found»,
         * поэтому такая ошибка заменяется подсказкой войти на сайт.
         * @param {...*} args - Аргументы MangaLibService.fetchChapter.
         * @returns {Promise<?object>} Данные главы.
         */
        async fetchChapter(...args) {
            try {
                return await super.fetchChapter(...args);
            } catch (e) {
                const loggedIn = !!this.config.headers?.Authorization;
                if (!this.isDomMode && !loggedIn && /HTTP 404/.test(e?.message || '')) {
                    throw new Error('Главы HentaiLib доступны только после входа: войдите на hentailib.me ' +
                        'в этом браузере, обновите страницу тайтла и повторите загрузку');
                }
                throw e;
            }
        }

        /**
         * @param {string} url - Проверяемый URL.
         * @returns {boolean} true, если URL относится к hentailib.me.
         */
        static matches(url) {
            try {
                const host = new URL(url).hostname.toLowerCase();
                return host === 'hentailib.me' || host.endsWith('.hentailib.me');
            } catch {
                return false;
            }
        }
    }

    global.HentaiLibService = HentaiLibService;
    if (global.serviceRegistry) global.serviceRegistry.register(HentaiLibService);
    console.log('[HentaiLibService] Loaded');
})(typeof window !== 'undefined' ? window : self);
