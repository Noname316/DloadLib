/**
 * DownloadLib content script
 * Injects the download button next to the read button on MangaLib/RanobeLib pages
 * @module content/DownloadButton
 * @license MIT
 * @author ivanvit
 * @version 1.0.7
 */

'use strict';

(function downloadButton() {
    const DOWNLOAD_BTN_CLASS = 'dl-ext-download-btn';
    const _dlApi = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome) || null;

    // Настройки по сайтам (форматы дублируют config.formats сервисов: контент-скрипт
    // не загружает конфиги). Первый формат в списке — формат по умолчанию.
    // readSelector — кнопка «Читать», рядом с которой встаёт «Скачать»;
    // buttonClass — классы сайта, чтобы кнопка выглядела родной.
    const SITES = {
        mangalib: { formats: ['cbz'], readSelector: 'a.btn', buttonClass: 'btn is-filled variant-primary' },
        hentailib: { formats: ['cbz'], readSelector: 'a.btn', buttonClass: 'btn is-filled variant-primary' },
        ranobelib: { formats: ['fb2', 'epub'], readSelector: 'a.btn', buttonClass: 'btn is-filled variant-primary' },
        comx: { formats: ['cbz'], readSelector: 'a.page__btn-read', buttonClass: 'btn page__btn-sec' }
    };
    const host = location.hostname.toLowerCase();
    let SITE_KEY = 'mangalib';
    if (host === 'com-x.life' || host.endsWith('.com-x.life')) SITE_KEY = 'comx';
    else if (/ranobelib\./.test(host)) SITE_KEY = 'ranobelib';
    else if (host === 'hentailib.me' || host.endsWith('.hentailib.me')) SITE_KEY = 'hentailib';
    const SITE = SITES[SITE_KEY];
    const READ_BTN_SELECTOR = SITE.readSelector;
    const ALLOWED_FORMATS = SITE.formats;
    // Окно загрузки всегда открывается с форматом по умолчанию (первым в списке).
    const [DEFAULT_FORMAT] = ALLOWED_FORMATS;

    /**
     * Находит на странице все кнопки чтения и добавляет рядом с каждой ещё не
     * добавленную кнопку загрузки DownloadLib, показывающую формат по умолчанию
     * и открывающую окно загрузки по клику.
     * @returns {void}
     */
    function injectDownloadButton() {
        document.querySelectorAll(READ_BTN_SELECTOR).forEach(readLink => {
            const container = readLink.parentElement;
            /* istanbul ignore next */
            if (!container) return;
            if (container.querySelector(`.${DOWNLOAD_BTN_CLASS}`)) return;

            let insertBefore = null;
            for (let node = readLink.nextSibling; node; node = node.nextSibling) {
                if (node.nodeType !== 1) continue;
                /* istanbul ignore next */
                if (node.classList.contains(DOWNLOAD_BTN_CLASS)) continue;
                insertBefore = node;
                break;
            }
            if (!insertBefore) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.title = 'Скачать через DloadLIB';
            btn.className = `${SITE.buttonClass} ${DOWNLOAD_BTN_CLASS}`;
            btn.style.cssText = `display:inline-flex!important;justify-content:space-between;align-items:center;gap:0.4em;`;
            btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:0.4em;"><svg class="svg-inline--fa fa-fw" style="width:1em;height:1em;flex-shrink:0" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 242.7-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7 288 32zM64 352c-35.3 0-64 28.7-64 64l0 32c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-32c0-35.3-28.7-64-64-64l-101.5 0-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352 64 352zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/></svg><span>Скачать</span></span><span class="dl-format-label" style="font-size:0.75em;opacity:0.8;"></span>`;

            btn.querySelector('.dl-format-label').textContent = DEFAULT_FORMAT.toUpperCase();

            btn.addEventListener('click', () => {
                if (!_dlApi || !_dlApi.runtime) return;
                _dlApi.runtime.sendMessage({ action: 'openDownloadWindow', format: DEFAULT_FORMAT });
            });

            container.insertBefore(btn, insertBefore);
        });
    }

    /**
     * Обработчик MutationObserver: при появлении новой кнопки чтения (или узла,
     * содержащего её) повторно вызывает injectDownloadButton() для добавления кнопки загрузки.
     * @param {MutationRecord[]} mutations - Список изменений DOM, полученных от observer'а.
     * @returns {void}
     */
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;

                if ((node.matches && node.matches(READ_BTN_SELECTOR)) ||
                    (node.querySelector && node.querySelector(READ_BTN_SELECTOR))) {
                    injectDownloadButton();
                    return;
                }
            }
        }
    });

    /**
     * Запускает наблюдение observer'ом за document.body; если body ещё не существует,
     * откладывает попытку до следующего кадра анимации.
     * @returns {void}
     */
    const startObserving = () => {
        if (document.body)
            observer.observe(document.body, { childList: true, subtree: true });
        else
            requestAnimationFrame(startObserving);
    };
    startObserving();

    if (document.body) injectDownloadButton();
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', injectDownloadButton);
    window.addEventListener('load', injectDownloadButton);
})();
