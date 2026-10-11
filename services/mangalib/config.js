'use strict';

(function(global) {
    global.mangalibConfig = {
        name: 'mangalib',
        baseUrl: 'https://api.cdnlibs.org',
        imagesDomain: 'https://img3.cdnlibs.org',
        siteId: '1',

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
            'Site-Id': '1',
            'X-DL-Service': 'mangalib',
            'Content-Type': 'application/json',
            'Client-Time-Zone': 'Europe/Moscow'
        },

        imageHeaders: {
            'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
            'Accept-Language': 'ru-RU,ru;q=0.8,en-US;q=0.5,en;q=0.3'
        },

        // Единственный доступный формат: каждая глава — отдельный CBZ.
        formats: ['cbz'],
        // Страницы сохраняются как есть: без разрезания длинных изображений
        // и без перекодирования (оригинальные файлы с сервера).
        splitLongImages: false,
        keepOriginalImages: true,

        // Поддерживается загрузка через DOM (поиск ссылок на отрисованных страницах сайта).
        supportsDomMode: true,
        // Каждая глава сохраняется отдельным файлом (вместо разбиения по размеру).
        splitByChapter: true,
        // Ошибка загрузки главы/страницы прерывает загрузку с сообщением,
        // а не записывается в файл текстом-заглушкой.
        strictErrors: true,
        // Перед загрузкой пользователь выбирает папку для сохранения.
        chooseSaveFolder: true,

        label: 'MangaLib',
        siteUrl: 'https://mangalib.me',
        primaryColor: '#ff9100',
        secondaryColor: '#c77101',
        logo: 'icons/logo1.png'
    };
})(typeof window !== 'undefined' ? window : self);