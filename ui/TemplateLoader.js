/**
 * DownloadLib ui module
 * Loads HTML template fragments into the anchor element
 * @module ui/TemplateLoader
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    /**
     * Синглтон-загрузчик HTML-фрагментов шаблонов в элемент-якорь на странице.
     *
     * Два слоя:
     * - основной экран (title, wrong-service, no-title) — show(); заменяет предыдущий
     *   основной экран;
     * - экран поверх (история, настройки) — showOverlay(); основной экран на это время
     *   только скрывается и после hideOverlay() возвращается как был — со всем
     *   состоянием, включая идущую загрузку, прогресс и обработчики.
     * @namespace TemplateLoader
     */
    const TemplateLoader = {
        _anchor: null,
        _main: null,
        _overlay: null,
        _current: null,
        _mainName: null,

        /**
         * Находит элемент-якорь и создаёт в нём слои основного экрана и экрана поверх.
         * @param {string} anchorId - id элемента-якоря в DOM.
         * @returns {void}
         */
        init(anchorId) {
            this._anchor = document.getElementById(anchorId);
            if (!this._anchor) {
                console.error('[TemplateLoader] Anchor element not found:', anchorId);
                return;
            }
            this._anchor.innerHTML = '';
            this._main = document.createElement('div');
            this._main.id = 'mainView';
            this._overlay = document.createElement('div');
            this._overlay.id = 'overlayView';
            this._overlay.hidden = true;
            this._anchor.append(this._main, this._overlay);
            this._current = null;
            this._mainName = null;
        },

        /**
         * Загружает текст шаблона из папки templates/.
         * @param {string} templateName - Имя шаблона без расширения.
         * @returns {Promise<string>} HTML шаблона.
         */
        async _fetch(templateName) {
            const res = await fetch(`templates/${templateName}.html`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
        },

        /**
         * Показывает основной экран: заменяет предыдущий основной экран и закрывает экран поверх.
         * @param {string} templateName - Имя шаблона (без расширения) из папки templates/.
         * @param {?function(): void} [onReady] - Колбэк после вставки шаблона.
         * @returns {Promise<void>}
         */
        async show(templateName, onReady = null) {
            if (!this._main) {
                console.error('[TemplateLoader] Anchor not initialized');
                return;
            }

            try {
                const html = await this._fetch(templateName);
                this._clearOverlay();
                this._main.innerHTML = html;
                this._main.hidden = false;
                this._current = templateName;
                this._mainName = templateName;
                if (onReady) onReady();
            } catch (e) {
                console.error('[TemplateLoader] Failed to load template:', templateName, e);
            }
        },

        /**
         * Показывает экран поверх основного (история, настройки). Основной экран не
         * пересоздаётся, а только скрывается; экран поверх каждый раз строится заново.
         * @param {string} templateName - Имя шаблона.
         * @param {?function(): void} [onReady] - Колбэк после вставки шаблона.
         * @returns {Promise<void>}
         */
        async showOverlay(templateName, onReady = null) {
            if (!this._overlay) {
                console.error('[TemplateLoader] Anchor not initialized');
                return;
            }

            try {
                const html = await this._fetch(templateName);
                this._overlay.innerHTML = html;
                this._overlay.hidden = false;
                this._main.hidden = true;
                this._current = templateName;
                if (onReady) onReady();
            } catch (e) {
                console.error('[TemplateLoader] Failed to load template:', templateName, e);
            }
        },

        /**
         * Закрывает экран поверх и показывает основной экран в том виде, в каком он был.
         * @returns {boolean} true, если основной экран есть и показан; false — его ещё нет
         * (тогда вызывающий код должен построить его сам).
         */
        hideOverlay() {
            this._clearOverlay();
            if (!this._mainName) return false;
            this._main.hidden = false;
            this._current = this._mainName;
            return true;
        },

        /**
         * Очищает и скрывает слой экрана поверх.
         * @returns {void}
         */
        _clearOverlay() {
            if (!this._overlay) return;
            this._overlay.innerHTML = '';
            this._overlay.hidden = true;
        },

        /**
         * Возвращает имя текущего видимого шаблона.
         * @returns {?string} Имя шаблона или null, если ни один шаблон ещё не загружен.
         */
        current() {
            return this._current;
        },

        /**
         * Возвращает имя основного экрана (даже если поверх открыт другой).
         * @returns {?string} Имя шаблона основного экрана.
         */
        mainView() {
            return this._mainName;
        }
    };

    global.TemplateLoader = TemplateLoader;
    console.log('[TemplateLoader] Loaded');
})(typeof window !== 'undefined' ? window : self);
