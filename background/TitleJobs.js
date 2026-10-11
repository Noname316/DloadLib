/**
 * DownloadLib background module
 * Loads title data (metadata and chapter list) in the background, so closing the
 * toolbar popup (e.g. when switching tabs) does not interrupt it
 * @module background/TitleJobs
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[TitleJobs] Loading...');

    const RESULT_TTL_MS = 10 * 60 * 1000;
    const ERROR_RETRY_AFTER_MS = 5000;
    const CACHE_STORAGE_KEY = 'titleJobsCache';
    const KEEP_ALIVE_MS = 20000;

    const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : null;

    /** @type {Map<string, object>} Задания по ключу «сервис|способ|slug». */
    const jobs = new Map();

    /**
     * @param {{serviceKey: string, mode: string, slug: string}} params - Параметры задания.
     * @returns {string} Ключ задания.
     */
    function jobKey({ serviceKey, mode, slug }) {
        return `${serviceKey}|${mode === 'dom' ? 'dom' : 'api'}|${slug}`;
    }

    /**
     * Читает сохранённый результат (переживает выгрузку service worker'а).
     * @param {string} key - Ключ задания.
     * @returns {Promise<?object>} Результат, если он не устарел.
     */
    async function readCached(key) {
        try {
            const stored = (await api.storage.local.get(CACHE_STORAGE_KEY))?.[CACHE_STORAGE_KEY] || {};
            const entry = stored[key];
            if (entry && Date.now() - entry.timestamp < RESULT_TTL_MS) return entry.result;
        } catch (e) { /* storage недоступен */ }
        return null;
    }

    /**
     * Сохраняет результат и удаляет устаревшие записи.
     * @param {string} key - Ключ задания.
     * @param {object} result - Данные тайтла.
     * @returns {Promise<void>}
     */
    async function writeCached(key, result) {
        try {
            const stored = (await api.storage.local.get(CACHE_STORAGE_KEY))?.[CACHE_STORAGE_KEY] || {};
            const now = Date.now();
            for (const [k, entry] of Object.entries(stored))
                if (now - entry.timestamp >= RESULT_TTL_MS) delete stored[k];
            stored[key] = { timestamp: now, result };
            await api.storage.local.set({ [CACHE_STORAGE_KEY]: stored });
        } catch (e) {
            console.warn('[TitleJobs] Failed to cache result:', e?.message || e);
        }
    }

    /**
     * Не даёт Chrome выгрузить service worker во время долгого задания: пока идут
     * паузы (например, после ответа 403), других вызовов API расширения может не быть.
     * @returns {function(): void} Функция остановки.
     */
    function keepAlive() {
        const timer = setInterval(() => {
            try {
                if (global.chrome?.runtime?.getPlatformInfo) global.chrome.runtime.getPlatformInfo(() => {});
            } catch (e) { /* ignore */ }
        }, KEEP_ALIVE_MS);
        return () => clearInterval(timer);
    }

    /**
     * Выполняет задание: метаданные и список глав тайтла через сервис (API или DOM).
     * @param {object} job - Задание.
     * @param {{serviceKey: string, slug: string, mode: string, authToken?: string}} params - Параметры.
     * @returns {Promise<void>}
     */
    async function runJob(job, { serviceKey, slug, mode, authToken }) {
        const stopKeepAlive = keepAlive();
        let service = null;
        try {
            service = global.serviceRegistry?.createService(serviceKey);
            if (!service) throw new Error(`Неизвестный сервис: ${serviceKey}`);
            if (authToken)
                service.config.headers = { ...service.config.headers, 'Authorization': `Bearer ${authToken}` };
            // В фоне служебную вкладку охраняет само задание (dispose в finally).
            service.domScraperOptions = { guardTab: false };
            if (typeof service.setSourceMode === 'function') service.setSourceMode(mode);
            service.onStatus = message => { job.progress = message; };

            job.progress = 'Загрузка информации о тайтле...';
            const metadata = await service.fetchMangaMetadata(slug);
            job.progress = 'Загрузка списка глав...';
            const chapters = await service.fetchChaptersList(slug);

            job.result = { metadata, chapters };
            job.status = 'done';
            job.progress = 'Готово';
            await writeCached(job.key, job.result);
        } catch (e) {
            console.error('[TitleJobs] Job failed:', job.key, e);
            job.status = 'error';
            job.error = e?.message || String(e);
        } finally {
            job.finishedAt = Date.now();
            stopKeepAlive();
            if (service) {
                service.onStatus = null;
                if (typeof service.dispose === 'function')
                    try { await service.dispose(); } catch (e) { /* ignore */ }
            }
        }
    }

    /**
     * Возвращает состояние задания, при необходимости запуская его.
     * @param {{serviceKey: string, slug: string, mode: string, authToken?: string}} params - Параметры.
     * @returns {Promise<object>} Ответ для страницы расширения.
     */
    async function load(params) {
        const key = jobKey(params);
        let job = jobs.get(key);

        const stale = job && (
            (job.status === 'done' && Date.now() - job.finishedAt >= RESULT_TTL_MS) ||
            (job.status === 'error' && Date.now() - job.finishedAt >= ERROR_RETRY_AFTER_MS)
        );
        if (stale) {
            jobs.delete(key);
            job = null;
        }

        if (!job) {
            const cached = await readCached(key);
            if (cached) return { ok: true, status: 'done', result: cached };

            job = { key, status: 'running', progress: 'Запуск...', startedAt: Date.now(), finishedAt: 0 };
            jobs.set(key, job);
            runJob(job, params);
        }

        if (job.status === 'done') return { ok: true, status: 'done', result: job.result };
        if (job.status === 'error') return { ok: true, status: 'error', error: job.error };
        return { ok: true, status: 'running', progress: job.progress, elapsedMs: Date.now() - job.startedAt };
    }

    if (api?.runtime?.onMessage) {
        api.runtime.onMessage.addListener((message, _sender, respond) => {
            if (message?.action !== 'titleJob:load') return false;
            load(message)
                .then(respond)
                .catch(e => respond({ ok: false, error: e?.message || String(e) }));
            return true;
        });
    }

    global.TitleJobs = { load, jobKey };
    console.log('[TitleJobs] Loaded');
})(typeof window !== 'undefined' ? window : self);
