/**
 * DownloadLib core module
 * Collects download speed, timing and debug events for the progress panel
 * @module core/DownloadStats
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[DownloadStats] Loading...');

    const MAX_EVENTS = 60;
    const SPEED_WINDOW_MS = 5 * 60 * 1000;
    const BYTES_WINDOW_MS = 15000;
    const SPEED_LOG_EVERY_MS = 60000;
    const MIN_WINDOW_MS = 10000;

    /**
     * Статистика одной загрузки: сколько глав/страниц/байт скачано, скорость
     * (скользящее окно), прошедшее и оставшееся время и журнал событий.
     */
    class DownloadStats {
        /**
         * @param {number} [totalChapters=0] - Сколько глав нужно скачать.
         */
        constructor(totalChapters = 0) {
            this.startedAt = Date.now();
            this.finishedAt = null;
            this.totalChapters = totalChapters;
            this.chaptersDone = 0;
            this.pages = 0;
            this.cachedPages = 0;
            this.bytes = 0;
            this.prefetch = '';
            this.events = [];
            this._chapterTimes = [];
            this._byteSamples = [];
            this._lastSpeedLog = Date.now();
        }

        /**
         * @param {number} total - Сколько глав нужно скачать.
         * @returns {void}
         */
        setTotal(total) {
            this.totalChapters = total;
        }

        /**
         * Учитывает скачанную картинку.
         * @param {number} bytes - Размер картинки.
         * @param {boolean} [fromCache=false] - Получена из кэша браузера (без запроса к серверу).
         * @returns {void}
         */
        imageDone(bytes, fromCache = false) {
            this.pages += 1;
            if (fromCache) this.cachedPages += 1;
            this.bytes += bytes;
            const now = Date.now();
            this._byteSamples.push([now, bytes]);
            while (this._byteSamples.length && now - this._byteSamples[0][0] > BYTES_WINDOW_MS)
                this._byteSamples.shift();
        }

        /**
         * Учитывает сохранённую главу и раз в минуту пишет в журнал текущую скорость.
         * @param {string} [label] - Подпись главы для журнала.
         * @param {number} [fileBytes] - Размер сохранённого файла.
         * @param {number} [ms] - Сколько заняла глава.
         * @param {number} [saveMs] - Сколько заняла сборка и запись файла.
         * @returns {void}
         */
        chapterDone(label = '', fileBytes = 0, ms = 0, saveMs = 0) {
            this.chaptersDone += 1;
            const now = Date.now();
            this._chapterTimes.push(now);
            while (this._chapterTimes.length && now - this._chapterTimes[0] > SPEED_WINDOW_MS)
                this._chapterTimes.shift();

            if (label) {
                const size = fileBytes ? `, ${DownloadStats.formatBytes(fileBytes)}` : '';
                const took = ms ? `, ${(ms / 1000).toFixed(1)} с` : '';
                const save = saveMs ? ` (запись ${(saveMs / 1000).toFixed(1)} с)` : '';
                this.log('info', `Сохранено: ${label}${size}${took}${save}`);
            }

            if (now - this._lastSpeedLog >= SPEED_LOG_EVERY_MS) {
                this._lastSpeedLog = now;
                const s = this.snapshot();
                this.log('info', `Скорость: ${s.chaptersPerMin.toFixed(1)} глав/мин, ` +
                    `${Math.round(s.pagesPerMin)} стр/мин, ${DownloadStats.formatBytes(s.bytesPerSec)}/с`);
            }
        }

        /**
         * @param {string} text - Что сейчас готовится заранее (следующая глава).
         * @returns {void}
         */
        setPrefetch(text) {
            this.prefetch = text || '';
        }

        /**
         * Добавляет событие в журнал (хранятся последние 60).
         * @param {'info'|'warn'|'error'} level - Важность.
         * @param {string} message - Текст.
         * @returns {void}
         */
        log(level, message) {
            this.events.push({ time: Date.now(), level, message });
            if (this.events.length > MAX_EVENTS) this.events.shift();
        }

        /**
         * Отмечает окончание загрузки (время перестаёт идти).
         * @returns {void}
         */
        finish() {
            if (!this.finishedAt) this.finishedAt = Date.now();
        }

        /**
         * Снимок для отображения.
         * @returns {{elapsedMs: number, etaMs: ?number, chaptersDone: number, totalChapters: number,
         * pages: number, cachedPages: number, bytes: number, chaptersPerMin: number,
         * pagesPerMin: number, bytesPerSec: number, prefetch: string, finished: boolean,
         * events: object[]}} Снимок.
         */
        snapshot() {
            const now = this.finishedAt || Date.now();
            const elapsedMs = now - this.startedAt;
            // Минимальное окно 10 с: в первые секунды деление на почти ноль даёт абсурдную скорость.
            const elapsedMin = Math.max(elapsedMs, MIN_WINDOW_MS) / 60000;

            // Скорость по главам — по последним 5 минутам (в начале — по всему времени).
            const windowStart = Math.max(this.startedAt, now - SPEED_WINDOW_MS);
            const windowMin = Math.max(now - windowStart, MIN_WINDOW_MS) / 60000;
            const recent = this._chapterTimes.filter(t => t >= windowStart).length;
            const chaptersPerMin = elapsedMs < 60000 ? this.chaptersDone / elapsedMin : recent / windowMin;

            const bytesWindow = this._byteSamples.filter(([t]) => now - t <= BYTES_WINDOW_MS);
            const bytesSec = Math.max(Math.min(BYTES_WINDOW_MS, elapsedMs), MIN_WINDOW_MS / 2) / 1000;
            const bytesPerSec = this.finishedAt
                ? this.bytes / Math.max(elapsedMs / 1000, 1)
                : bytesWindow.reduce((sum, [, b]) => sum + b, 0) / bytesSec;

            const left = Math.max(0, this.totalChapters - this.chaptersDone);
            const etaMs = !this.finishedAt && chaptersPerMin > 0 && left > 0
                ? (left / chaptersPerMin) * 60000
                : null;

            return {
                elapsedMs,
                etaMs,
                chaptersDone: this.chaptersDone,
                totalChapters: this.totalChapters,
                pages: this.pages,
                cachedPages: this.cachedPages,
                bytes: this.bytes,
                chaptersPerMin,
                pagesPerMin: this.pages / elapsedMin,
                bytesPerSec,
                prefetch: this.prefetch,
                finished: !!this.finishedAt,
                events: this.events.slice()
            };
        }

        /**
         * @param {number} bytes - Размер.
         * @returns {string} Размер в КБ/МБ.
         */
        static formatBytes(bytes) {
            if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
            return `${Math.round(bytes / 1024)} КБ`;
        }

        /**
         * @param {number} ms - Длительность.
         * @returns {string} Длительность вида «1:05:09» или «05:09».
         */
        static formatDuration(ms) {
            const total = Math.max(0, Math.round(ms / 1000));
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            const pad = n => String(n).padStart(2, '0');
            return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        }
    }

    global.DownloadStats = DownloadStats;
    console.log('[DownloadStats] Loaded');
})(typeof window !== 'undefined' ? window : self);
