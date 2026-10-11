/**
 * DownloadLib ui module
 * Controls the settings view
 * @module ui/SettingsController
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[SettingsController] Loading...');

    const FIT_FB2_IMAGES_KEY = 'manga_parser_fit_fb2_images';

    /**
     * Синглтон-контроллер экрана настроек расширения. Осталась только настройка
     * картинок FB2 для RanobeLib: темп запросов подбирается автоматически, диапазон
     * выбирается по главам, плагины отключены, ранобэ сохраняется одним файлом.
     * @namespace SettingsController
     */
    const SettingsController = {
        /**
         * Инициализирует экран настроек: отрисовывает секции и навешивает обработчики.
         * @returns {void}
         */
        init() {
            this._renderFitFb2Images();
            this._bindEvents();
        },

        /**
         * Отмечает чекбокс вписывания изображений FB2 в страницу согласно сохранённому значению.
         * @returns {void}
         */
        _renderFitFb2Images() {
            const checkbox = document.getElementById('settingsFitFb2Images');
            if (!checkbox) return;
            checkbox.checked = localStorage.getItem(FIT_FB2_IMAGES_KEY) === 'true';
        },

        /**
         * Навешивает обработчики на элементы экрана настроек: кнопку «назад» и чекбокс FB2.
         * @returns {void}
         */
        _bindEvents() {
            const backBtn = document.getElementById('settingsBackBtn');
            if (backBtn) {
                backBtn.addEventListener('click', () => {
                    if (new URLSearchParams(window.location.search).has('settings'))
                        return window.close();
                    const logoInfo = document.getElementById('logoInfo');
                    if (logoInfo) logoInfo.textContent = '';
                    if (global.popupController) global.popupController._restoreMainView();
                    else console.error('[SettingsController] popupController not found');
                });
            }

            const fitFb2ImagesCheckbox = document.getElementById('settingsFitFb2Images');
            if (fitFb2ImagesCheckbox) {
                fitFb2ImagesCheckbox.addEventListener('change', () =>
                    localStorage.setItem(FIT_FB2_IMAGES_KEY, String(fitFb2ImagesCheckbox.checked)));
            }
        }
    };

    global.SettingsController = SettingsController;
    console.log('[SettingsController] Loaded');
})(typeof window !== 'undefined' ? window : self);
