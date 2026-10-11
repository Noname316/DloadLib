'use strict';

(function(global) {
    // HentaiLib — сайт той же платформы, что MangaLib: общий API (api.cdnlibs.org),
    // отличаются Site-Id, домены картинок и сайта.
    global.hentailibConfig = {
        name: 'hentailib',
        baseUrl: 'https://api.cdnlibs.org',
        // Сервер «Сжатия» из /api/constants (imageServers) для site_id 4.
        imagesDomain: 'https://img3h.hentaicdn.org',
        siteId: '4',

        fields: [
            'background', 'eng_name', 'otherNames', 'summary', 'releaseDate', 'type_id',
            'caution', 'views', 'close_view', 'rate_avg', 'rate', 'genres',
            'tags', 'teams', 'user', 'franchise', 'authors', 'publisher',
            'userRating', 'moderated', 'metadata', 'metadata.count',
            'metadata.close_comments', 'manga_status_id', 'chap_count',
            'status_id', 'artists', 'format'
        ],

        headers: {
            'Accept': '*/*',
            'Accept-Language': 'ru,en-US;q=0.9,en;q=0.8',
            'Site-Id': '4',
            'X-DL-Service': 'hentailib',
            'Content-Type': 'application/json',
            'Client-Time-Zone': 'Europe/Moscow'
        },

        imageHeaders: {
            'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
            'Accept-Language': 'ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3'
        },

        // Вкладки сайта, через которые выполняются запросы (с cookie и токеном входа).
        tabPatterns: ['*://hentailib.me/*', '*://*.hentailib.me/*'],

        // Всё как у MangaLib: CBZ на главу, оригинальные страницы, режим DOM, выбор папки.
        formats: ['cbz'],
        splitLongImages: false,
        keepOriginalImages: true,
        supportsDomMode: true,
        splitByChapter: true,
        strictErrors: true,
        chooseSaveFolder: true,

        label: 'HentaiLib',
        siteUrl: 'https://hentailib.me',
        primaryColor: '#e53935',
        secondaryColor: '#c62828',
        logo: 'icons/logo4.png'
    };
})(typeof window !== 'undefined' ? window : self);
