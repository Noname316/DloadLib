'use strict';

(function(global) {
    global.comxConfig = {
        name: 'comx',
        baseUrl: 'https://com-x.life',
        // Хост картинок по умолчанию; читалка сайта сама сообщает основной и российский зеркала.
        imagesDomain: 'https://img.com-x.life',

        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ru,en-US;q=0.9,en;q=0.8'
        },

        // Сайт работает на cookie: JWT-токен (как у MangaLib) не ищется и не отправляется.
        noAuthToken: true,

        // Вкладки сайта, через которые выполняются запросы (с cookie пройденной проверки браузера).
        tabPatterns: ['*://com-x.life/*', '*://*.com-x.life/*'],

        formats: ['cbz'],
        splitLongImages: false,
        keepOriginalImages: true,
        splitByChapter: true,
        strictErrors: true,
        chooseSaveFolder: true,
        supportsDomMode: false,
        // Номера томов на сайте ненадёжны (глава 65 может стоять в томе 1, а 64 — в томе 6),
        // поэтому главы идут в порядке сайта (posi), а не сортируются по тому и номеру.
        keepChapterOrder: true,

        // Сайт считает массовые скачивания (встроенная квота около 150 глав, есть блокировки),
        // поэтому темп осторожнее, чем у MangaLib, а при выборе больше 100 глав — предупреждение.
        pacing: {
            site: { perMinute: 30, maxPerMinute: 60, concurrency: 1 },
            images: { perMinute: 120, maxPerMinute: 240, concurrency: 3 }
        },
        largeDownloadWarning: 100,

        label: 'Com-X',
        siteUrl: 'https://com-x.life',
        // Цвета тёмной темы сайта: фон, панели, оранжевый акцент кнопки «Начать чтение»
        // и чёрный текст на нём.
        primaryColor: '#ffa332',
        secondaryColor: '#f39b2e',
        backgroundColor: '#121212',
        panelColor: '#212121',
        panelDarkColor: '#171717',
        onPrimaryColor: '#000000',
        textColor: '#f2f2f2',
        // Логотип DloadLIB в стиле шапки com-x: светлый круг с раскрытой книгой и Nunito с разрядкой.
        logo: 'icons/logo5.png'
    };
})(typeof window !== 'undefined' ? window : self);
