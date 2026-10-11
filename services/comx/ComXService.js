/**
 * DownloadLib service module
 * Module to interact with the Com-X comics/manga site (com-x.life)
 * @module services/comx/ComXService
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[ComXService] Loading...');

    const RU_TIME_ZONES = new RegExp(
        '^Europe/(?:Moscow|Kaliningrad|Samara|Kirov|Volgograd|Astrakhan|Saratov|Ulyanovsk)$|' +
        '^Asia/(?:Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|' +
        'Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr)$'
    );
    const CHALLENGE_MESSAGE = 'Сайт com-x.life запросил проверку браузера. Откройте com-x.life во вкладке, ' +
        'дождитесь, пока сайт загрузится, и повторите загрузку';

    /**
     * Находит объект, присвоенный переменной в HTML (`window.__DATA__ = {...}`), и разбирает
     * его как JSON. Скобки считаются с учётом строк, поэтому `}` внутри названий не мешает.
     * Работает без DOM (в т.ч. в фоновом service worker'е).
     * @param {string} html - HTML страницы.
     * @param {string} name - Имя переменной.
     * @returns {?object} Объект, либо null, если присваивание не найдено.
     */
    function extractAssignedJson(html, name) {
        const at = html.indexOf(name);
        if (at < 0) return null;
        const start = html.indexOf('{', at);
        if (start < 0) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < html.length; i++) {
            const c = html[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') inString = false;
                continue;
            }

            if (c === '"') inString = true;
            else if (c === '{') depth += 1;
            else if (c === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        return JSON.parse(html.slice(start, i + 1));
                    } catch (e) {
                        return null;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Убирает HTML-теги и раскодирует HTML-сущности (без DOM).
     * @param {string} html - Фрагмент HTML.
     * @returns {string} Текст.
     */
    function htmlToText(html) {
        const named = {
            amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
            laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…'
        };
        return String(html || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
            .replace(/[ \t]+/g, ' ')
            .trim();
    }

    /**
     * @param {string} html - HTML страницы.
     * @param {string} property - Свойство мета-тега (например, og:image).
     * @returns {string} Значение content, либо пустая строка.
     */
    function metaContent(html, property) {
        const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
        const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
        const m = re.exec(html) || reversed.exec(html);
        return m ? htmlToText(m[1]) : '';
    }

    /**
     * Сервис сайта com-x.life. Страница тайтла содержит полный список глав в
     * `window.__DATA__.chapters`, страница читалки `/reader/{тайтл}/{глава}` — список
     * картинок в `window.__DATA__.images`, поэтому данные берутся прямо из HTML этих
     * страниц, без API и без отрисовки. Загрузка картинок (пул, повторы, строгие ошибки,
     * оригинальные файлы для CBZ) унаследована от MangaLibService.
     */
    class ComXService extends global.MangaLibService {
        /**
         * Создаёт сервис с конфигурацией com-x.
         */
        constructor() {
            super(global.comxConfig);
            this._chapterIds = new Map();
        }

        /**
         * @param {string} url - Проверяемый URL.
         * @returns {boolean} true, если URL относится к com-x.life.
         */
        static matches(url) {
            try {
                const { hostname } = new URL(url);
                const host = hostname.toLowerCase();
                return host === 'com-x.life' || host.endsWith('.com-x.life');
            } catch {
                return false;
            }
        }

        /**
         * Извлекает идентификатор тайтла из адреса страницы тайтла: `/17887-nazvanie.html`.
         * На страницах читалки и каталога тайтла нет — возвращает null.
         * @param {string} url - Адрес страницы.
         * @returns {?string} Slug вида «17887-nazvanie».
         */
        static extractSlug(url) {
            try {
                const m = /^\/(\d+-[^/]+)\.html$/i.exec(new URL(url).pathname);
                return m ? m[1] : null;
            } catch {
                return null;
            }
        }

        /**
         * В com-x только один способ загрузки — из HTML страниц сайта.
         * @returns {void}
         */
        setSourceMode() {
            this.sourceMode = 'api';
        }

        /**
         * Распознаёт страницу антибот-проверки сайта: её нельзя «переждать» паузой,
         * пользователь должен открыть сайт и дождаться проверки.
         * @param {{url?: string, text: function(): string}} response - Ответ.
         * @returns {boolean} true, если вместо страницы пришла проверка браузера.
         */
        _isChallenge(response) {
            if (/\/_c\?/.test(response.url || '')) return true;
            const html = response.text() || '';
            return !html.includes('window.__DATA__') && /\/_c\?t=/.test(html);
        }

        /**
         * Страница проверки — не сигнал «слишком часто», её не нужно повторять с паузами.
         * @param {object} response - Ответ.
         * @param {boolean} throttleOn403 - Учитывать ли 403.
         * @returns {boolean} true, если сервер просит снизить частоту запросов.
         */
        _isThrottleResponse(response, throttleOn403) {
            if (this._isChallenge(response)) return false;
            return super._isThrottleResponse(response, throttleOn403);
        }

        /**
         * Загружает HTML-страницу сайта через вкладку com-x (с cookie пройденной проверки)
         * и возвращает данные `window.__DATA__` вместе с HTML.
         * @param {string} url - Адрес страницы.
         * @param {string} what - Что загружается (для текста ошибки).
         * @returns {Promise<{data: object, html: string}>} Данные страницы.
         * @throws {Error} При проверке браузера, ошибке HTTP или если данных на странице нет.
         */
        async _fetchPageData(url, what) {
            const response = await this.fetchWithRateLimitRetry(url, {
                method: 'GET',
                headers: this.config.headers,
                credentials: 'include',
                cache: 'no-store'
            });
            if (this._isChallenge(response)) throw new Error(CHALLENGE_MESSAGE);
            if (!response.ok) throw this._httpError(`Не удалось загрузить ${what}`, response);

            const html = response.text();
            const data = extractAssignedJson(html, 'window.__DATA__');
            if (!data) throw new Error(`На странице «${what}» не найдены данные сайта (window.__DATA__)`);
            return { data, html };
        }

        /**
         * @param {string} slug - «17887-nazvanie».
         * @returns {string} Адрес страницы тайтла.
         */
        _titleUrl(slug) {
            return `${this.config.baseUrl}/${slug}.html`;
        }

        /**
         * Метаданные тайтла со страницы тайтла.
         * @param {string} slug - Slug тайтла.
         * @returns {Promise<{data: object}>} Сырые метаданные в формате, понятном MangaPatcher.
         */
        async fetchMangaMetadata(slug) {
            const { data, html } = await this._fetchPageData(this._titleUrl(slug), 'страница тайтла');
            this._rememberChapters(data.chapters);

            // Блок «Год / Издатель / Статус / Автор…»: <li><div>Подпись:</div> значение</li>.
            const info = {};
            for (const m of html.matchAll(/<li>\s*<div>([^<:]+):?<\/div>([\s\S]*?)<\/li>/gi))
                info[htmlToText(m[1]).toLowerCase()] = htmlToText(m[2]);

            const tagsBlock = /<div class="page__tags[^"]*">([\s\S]*?)<\/div>/i.exec(html);
            const tags = tagsBlock
                ? [...tagsBlock[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(m => htmlToText(m[1])).filter(Boolean)
                : [];
            const authors = ['автор', 'сценарист', 'художник']
                .flatMap(k => (info[k] || '').split(/\s*,\s*/))
                .filter(Boolean);
            const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);

            return {
                data: {
                    slug,
                    id: data.news_id,
                    rus_name: data.title || (h1 ? htmlToText(h1[1]) : '') || metaContent(html, 'og:title'),
                    cover: metaContent(html, 'og:image'),
                    summary: metaContent(html, 'og:description'),
                    authors: [...new Set(authors)],
                    genres: tags,
                    tags: [],
                    releaseDate: info['год'] || '',
                    publisher: info['издатель'] || '',
                    status: info['статус'] || ''
                }
            };
        }

        /**
         * Список глав со страницы тайтла, в порядке сайта (posi).
         * @param {string} slug - Slug тайтла.
         * @returns {Promise<{data: object[]}>} Главы в формате, понятном ChapterController/DownloadManager.
         */
        async fetchChaptersList(slug) {
            const { data } = await this._fetchPageData(this._titleUrl(slug), 'список глав');
            const chapters = this._rememberChapters(data.chapters);
            if (!chapters.length) throw new Error('У тайтла на сайте нет глав');
            return { data: chapters };
        }

        /**
         * Приводит главы сайта к общему формату и запоминает их id для загрузки.
         * @param {?object[]} list - `__DATA__.chapters` страницы тайтла.
         * @returns {object[]} Главы по порядку сайта.
         */
        _rememberChapters(list) {
            const chapters = (Array.isArray(list) ? list : [])
                .slice()
                .sort((a, b) => (a.posi ?? 0) - (b.posi ?? 0))
                .map(c => ({
                    id: c.id,
                    volume: String(c.volume ?? '1'),
                    number: String(c.number ?? c.posi ?? ''),
                    name: String(c.title || '').trim(),
                    // Подпись в списке «от/до» и в имени файла — как на сайте («6 - 64», «# 94»).
                    label: String(c.title || '').trim(),
                    order: c.posi,
                    pages: c.pages,
                    branches: []
                }));
            this._chapterIds.clear();
            for (const ch of chapters) this._chapterIds.set(`${ch.volume}|${ch.number}|${ch.order}`, ch.id);
            return chapters;
        }

        /**
         * Хост картинок: как и сама читалка сайта, для российских часовых поясов берётся
         * российское зеркало.
         * @param {object} data - `__DATA__` страницы читалки.
         * @returns {string} Хост без протокола.
         */
        _imageHost(data) {
            let zone = '';
            try {
                zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
            } catch (e) { /* без часового пояса — основной хост */ }
            if (data.host_ru && RU_TIME_ZONES.test(zone)) return data.host_ru;
            return data.host || new URL(this.config.imagesDomain).host;
        }

        /**
         * Список картинок главы со страницы читалки.
         * @param {string} slug - Slug тайтла.
         * @param {*} number - Номер главы.
         * @param {*} volume - Том.
         * @param {?number} branchId - Не используется (веток перевода у сайта нет).
         * @param {{chapter?: object}} [opts] - Глава из списка (с её id на сайте).
         * @returns {Promise<{data: {pages: string[]}}>} Абсолютные адреса картинок.
         */
        // Сигнатура как у остальных сервисов: ветка перевода — четвёртый аргумент.
        // eslint-disable-next-line no-unused-vars
        async fetchChapter(slug, number, volume = '1', _branchId = null, opts = {}) {
            const chapter = opts?.chapter || {};
            const chapterId = chapter.id ?? this._chapterIds.get(`${volume}|${number}|${chapter.order}`);
            if (!chapterId) throw new Error(`Не найден id главы ${number} на сайте`);

            const [newsId] = String(slug).split('-');
            const { data } = await this._fetchPageData(`${this.config.baseUrl}/reader/${newsId}/${chapterId}`, 'глава в читалке');
            const images = Array.isArray(data.images) ? data.images : [];
            if (!images.length)
                throw new Error('Читалка не отдала страницы главы (возможно, нужен вход на сайт или глава недоступна)');

            const host = this._imageHost(data);
            const pages = images.map(path => (/^https?:\/\//i.test(path) ? path : `https://${host}/comix/${path}`));
            return { data: { pages } };
        }
    }

    ComXService.extractAssignedJson = extractAssignedJson;
    ComXService.htmlToText = htmlToText;
    global.ComXService = ComXService;
    if (global.serviceRegistry) global.serviceRegistry.register(ComXService);
    console.log('[ComXService] Loaded');
})(typeof window !== 'undefined' ? window : self);
