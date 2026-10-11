/**
 * DownloadLib exporter module
 * Exports manga to CBZ (Comic Book ZIP) with ComicInfo.xml metadata
 * @module exporters/CBZExporter
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[CBZExporter] Loading...');

    /**
     * Экспортёр в формат CBZ: ZIP-архив со страницами-изображениями и файлом
     * метаданных ComicInfo.xml. Архив из одной главы содержит страницы в корне,
     * архив из нескольких глав — по подпапке на главу.
     */
    class CBZExporter extends global.BaseExporter {
        /**
         * Собирает CBZ-архив из изображений глав.
         * @param {object} manga - Нормализованные метаданные тайтла.
         * @param {{title?: string, volume?: *, number?: *, content: Array}[]} chapters - Главы.
         * @param {string} [coverBase64] - Обложка (data-URL или чистый base64).
         * @returns {Promise<{blob: Blob, filename: string, mimeType: string}>} Готовый архив.
         * @throws {Error} Если JSZip недоступен или в главах нет ни одного изображения.
         */
        async export(manga, chapters, coverBase64) {
            if (typeof global.JSZip === 'undefined')
                throw new Error('JSZip недоступен — CBZ не может быть создан');

            const zip = new global.JSZip();
            const single = chapters.length === 1;
            let pageCount = 0;

            for (let ci = 0; ci < chapters.length; ci++) {
                const ch = chapters[ci];
                if (!Array.isArray(ch.content)) continue;

                const vol = String(ch.volume != null ? ch.volume : ci + 1).padStart(2, '0');
                const num = String(ch.number != null ? ch.number : ci + 1).padStart(3, '0');
                const dir = single ? '' : `v${vol}_c${num}/`;

                let page = 0;
                for (const block of ch.content) {
                    if (block.type !== 'image' || !block.data?.base64) continue;
                    page += 1;
                    const ext = this._mimeToExt(block.data.contentType || 'image/jpeg');
                    zip.file(`${dir}${String(page).padStart(4, '0')}.${ext}`, block.data.base64, { base64: true });
                }
                pageCount += page;
            }

            if (pageCount === 0)
                throw new Error('Нет изображений для сохранения в CBZ');

            // Обложка отдельной страницей нужна только для архивов из нескольких глав:
            // в архиве одной главы она стала бы лишней первой страницей.
            if (coverBase64 && !single) {
                const b64 = coverBase64.includes(',') ? coverBase64.split(',')[1] : coverBase64;
                zip.file('000_cover.jpg', b64, { base64: true });
            }

            zip.file('ComicInfo.xml', this._buildComicInfo(manga, chapters, pageCount));

            const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
            return { blob, filename: `${this._sanitize(manga.name || 'manga')}.cbz`, mimeType: 'application/vnd.comicbook+zip' };
        }

        /**
         * Строит ComicInfo.xml; для архива из одной главы добавляет её номер, том и название.
         * @param {object} manga - Нормализованные метаданные тайтла.
         * @param {object[]} chapters - Главы архива.
         * @param {number} pageCount - Общее число страниц.
         * @returns {string} XML-документ.
         */
        _buildComicInfo(manga, chapters, pageCount) {
            const e = s => this.escapeXml(String(s || ''));
            const series = manga.seriesName || manga.name;
            const lines = [
                '<?xml version="1.0" encoding="utf-8"?>',
                '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
                '           xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
            ];

            lines.push(`  <Title>${e(manga.name)}</Title>`);
            lines.push(`  <Series>${e(series)}</Series>`);

            if (chapters.length === 1) {
                const [ch] = chapters;
                if (ch.number != null) lines.push(`  <Number>${e(ch.number)}</Number>`);
                if (ch.volume != null) lines.push(`  <Volume>${e(ch.volume)}</Volume>`);
            }

            const authors = (manga.authors || []).filter(Boolean);
            if (authors.length)
                lines.push(`  <Writer>${e(authors.join(', '))}</Writer>`);

            if (manga.summary)
                lines.push(`  <Summary>${e(manga.summary)}</Summary>`);

            const year = /\d{4}/.exec(String(manga.releaseDate || ''));
            if (year)
                lines.push(`  <Year>${year[0]}</Year>`);

            const genres = (manga.genres || []).filter(Boolean);
            if (genres.length)
                lines.push(`  <Genre>${e(genres.join(', '))}</Genre>`);

            const tags = (manga.tags || []).filter(Boolean);
            if (tags.length)
                lines.push(`  <Tags>${e(tags.join(', '))}</Tags>`);

            if (manga.rating)
                lines.push(`  <AgeRating>${e(manga.rating)}</AgeRating>`);

            lines.push(`  <PageCount>${pageCount}</PageCount>`);
            lines.push('  <LanguageISO>ru</LanguageISO>');
            lines.push('  <Manga>YesAndRightToLeft</Manga>');
            lines.push('</ComicInfo>');
            return lines.join('\n');
        }

        /**
         * Подбирает расширение файла по MIME-типу изображения.
         * @param {string} mime - MIME-тип.
         * @returns {string} Расширение без точки.
         */
        _mimeToExt(mime) {
            if (mime.includes('png')) return 'png';
            if (mime.includes('webp')) return 'webp';
            if (mime.includes('gif')) return 'gif';
            if (mime.includes('avif')) return 'avif';
            return 'jpg';
        }

        /**
         * Очищает строку от символов, недопустимых в именах файлов.
         * @param {string} str - Исходная строка.
         * @returns {string} Безопасное имя файла.
         */
        _sanitize(str) {
            return String(str)
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // eslint-disable-line no-control-regex
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 180) || 'manga';
        }
    }

    global.CBZExporter = CBZExporter;
    if (global.ExporterRegistry)
        global.ExporterRegistry.register('cbz', CBZExporter, { label: 'CBZ' });
    console.log('[CBZExporter] Loaded');
})(typeof window !== 'undefined' ? window : self);
