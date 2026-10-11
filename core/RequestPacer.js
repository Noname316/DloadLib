/**
 * DownloadLib core module
 * Paces requests to the site evenly, finds the server's limit automatically
 * and backs off when the server starts refusing requests
 * @module core/RequestPacer
 * @license MIT
 * @author ivanvit
 * @version 1.2.0
 */

'use strict';

(function(global) {
    console.log('[RequestPacer] Loading...');

    const LEARNED_KEY_PREFIX = 'downloadlib_pacer_learned_';
    const LEARNED_TTL = 7 * 24 * 60 * 60 * 1000;
    const DEFAULT_PER_MINUTE = 85;
    const MIN_PER_MINUTE = 6;
    const BASE_BACKOFF_MS = 30000;
    const MAX_BACKOFF_MS = 300000;
    // Сколько всего ждать снятия ограничения подряд, прежде чем остановить загрузку:
    // сайты (HentaiLib/MangaLib) ограничивают на десятки минут, и загрузка должна это пережидать.
    const MAX_LIMIT_WAIT_MS = 60 * 60 * 1000;
    const minutes = ms => Math.round(ms / 60000);
    const STREAK_TO_FORGIVE = 10;
    const GROW_EVERY = 15;
    const CAP_DURATION_MS = 10 * 60 * 1000;

    /**
     * HTTP-статусы, которыми сервер сообщает о слишком частых запросах.
     * 403 сюда входит, потому что антифлуд-защита сайта отвечает именно им.
     */
    const THROTTLE_STATUSES = [403, 429, 503];

    /**
     * Ошибка: сервер продолжает ограничивать запросы даже после всех пауз.
     */
    class RateLimitError extends Error {
        /**
         * @param {string} message - Текст ошибки.
         * @param {number} status - Последний HTTP-статус сервера.
         */
        constructor(message, status) {
            super(message);
            this.rateLimited = true;
            this.status = status;
        }
    }

    /**
     * Регулятор одной «полосы» запросов (например, API сайта или CDN картинок).
     *
     * - Равномерный темп: запросы стартуют не чаще одного за 60000 / темп мс.
     * - Лимит одновременных запросов (withPermit).
     * - Автоподбор темпа (AIMD): каждые 15 успешных ответов подряд темп растёт на 10%
     *   от стартового (не выше потолка), при отказе 403/429/503 — падает вдвое, все
     *   запросы полосы встают на паузу (Retry-After или 30 → 60 → 120 → 240 → 300 → 300... с).
     *   Темп, на котором случился отказ, 10 минут служит потолком (90% от него).
     * - Найденный безопасный темп запоминается и используется следующей загрузкой.
     * - Если сервер не снимает ограничение за 60 минут пауз подряд — RateLimitError.
     */
    class RequestPacer {
        /**
         * @param {{name?: string, label?: string, perMinute?: number, maxPerMinute?: number,
         * concurrency?: number}} [options] - Имя полосы, подпись для UI, стартовый темп,
         * потолок автоподбора и число одновременных запросов.
         */
        constructor(options = {}) {
            this.name = options.name || 'site';
            this.label = options.label || this.name;
            this.onStatus = null;
            this.onEvent = null;
            this._gate = null;
            this._active = 0;
            this._waiters = [];
            this.configure(options);
            this.reset();
        }

        /**
         * Задаёт стартовый темп, потолок и число одновременных запросов.
         * @param {{perMinute?: number, maxPerMinute?: number, concurrency?: number}} options - Параметры.
         * @returns {void}
         */
        configure({ perMinute, maxPerMinute, concurrency } = {}) {
            const toInt = (v, def) => {
                const n = parseInt(v, 10);
                return isNaN(n) ? def : n;
            };
            this.startRate = Math.max(MIN_PER_MINUTE, toInt(perMinute, this.startRate || DEFAULT_PER_MINUTE));
            this.maxRate = Math.max(this.startRate, toInt(maxPerMinute, this.maxRate || this.startRate));
            this.concurrency = Math.max(1, toInt(concurrency, this.concurrency || 1));
        }

        /**
         * Задаёт лимит запросов в минуту (стартовый темп и потолок одновременно).
         * @param {*} perMinute - Лимит.
         * @returns {void}
         */
        setLimit(perMinute) {
            this.configure({ perMinute, maxPerMinute: perMinute });
            this._effective = this.startRate;
        }

        /**
         * Сбрасывает паузы и счётчики перед новой загрузкой. Стартовый темп берётся
         * из памяти прошлых загрузок, если она есть и подобрана при тех же настройках.
         * @returns {void}
         */
        reset() {
            this._nextSlot = 0;
            this._pausedUntil = 0;
            this._pauseStatus = null;
            this._strikes = 0;
            this._limitWaitMs = 0;
            this._successStreak = 0;
            this._stepFactor = 1;
            this._growthDisabled = false;
            this._cap = null;
            this._capUntil = 0;
            this._concurrencyNow = this.concurrency;
            this._effective = this.startRate;
            this._throttleCount = 0;

            const learned = this._loadLearned();
            if (learned) this._effective = Math.min(this.maxRate, Math.max(MIN_PER_MINUTE, learned));
        }

        /**
         * Привязывает гейт загрузки: ожидания полосы прерываются при остановке.
         * @param {?{controller: object, checkpoint: function(): Promise<void>, cancelled?: boolean}} gate - Гейт.
         * @returns {void}
         */
        setGate(gate) {
            this._gate = gate || null;
        }

        /**
         * @returns {number} Текущий темп, запросов в минуту.
         */
        get effectiveLimit() {
            return this._effective;
        }

        /**
         * Снимок состояния полосы для отладочной панели.
         * @returns {{name: string, label: string, rate: number, max: number, cap: ?number,
         * concurrency: number, active: number, pausedMs: number, throttles: number,
         * growth: boolean}} Состояние.
         */
        describe() {
            const now = Date.now();
            return {
                name: this.name,
                label: this.label,
                rate: this._effective,
                max: this.maxRate,
                cap: now < this._capUntil ? this._cap : null,
                concurrency: this._concurrencyNow,
                active: this._active,
                pausedMs: Math.max(0, this._pausedUntil - now),
                throttles: this._throttleCount,
                growth: !this._growthDisabled
            };
        }

        /**
         * Ждёт своей очереди на запрос.
         * @param {number} [cost=1] - Сколько слотов занимает операция.
         * @returns {Promise<void>}
         * @throws {Error} С полем aborted=true, если загрузка остановлена во время ожидания.
         */
        async acquire(cost = 1) {
            await this._waitPause();
            const now = Date.now();
            const start = Math.max(now, this._nextSlot);
            this._nextSlot = start + (60000 / this._effective) * cost;
            if (start > now) await this._sleep(start - now);
            await this._waitPause();
        }

        /**
         * Учитывает уже выполненный запрос без ожидания (сдвигает очередь следующих).
         * Используется, когда заранее не было известно, дойдёт ли запрос до сервера.
         * @param {number} [cost=1] - Сколько слотов занял запрос.
         * @returns {void}
         */
        charge(cost = 1) {
            this._nextSlot = Math.max(Date.now(), this._nextSlot) + (60000 / this._effective) * cost;
        }

        /**
         * Выполняет fn, не допуская больше concurrency одновременных операций полосы.
         * @param {function(): Promise<*>} fn - Операция.
         * @returns {Promise<*>} Результат fn.
         */
        async withPermit(fn) {
            while (this._active >= this._concurrencyNow)
                await new Promise(resolve => this._waiters.push(resolve));
            this._active += 1;
            try {
                return await fn();
            } finally {
                this._active -= 1;
                this._wakeWaiters();
            }
        }

        /**
         * Будит ожидающих разрешения на запрос (сколько позволяет текущий лимит).
         * @returns {void}
         */
        _wakeWaiters() {
            let free = this._concurrencyNow - this._active;
            while (free > 0 && this._waiters.length) {
                this._waiters.shift()();
                free -= 1;
            }
        }

        /**
         * Сообщает об успешном ответе: серия успехов снимает «штрафы» и разгоняет темп.
         * @returns {void}
         */
        success() {
            this._successStreak += 1;
            if (this._successStreak >= STREAK_TO_FORGIVE) {
                this._strikes = 0;
                this._limitWaitMs = 0;
            }
            if (this._successStreak % GROW_EVERY !== 0) return;

            if (this._concurrencyNow < this.concurrency) {
                this._concurrencyNow += 1;
                this._wakeWaiters();
            }
            if (this._growthDisabled) return;

            const ceiling = Date.now() < this._capUntil ? Math.min(this._cap, this.maxRate) : this.maxRate;
            if (this._effective >= ceiling) return;

            const step = Math.max(1, Math.round(this.startRate * 0.1 * this._stepFactor));
            const before = this._effective;
            this._effective = Math.min(ceiling, this._effective + step);
            this._saveLearned(this._effective);
            this._event('info', `${this.label}: темп повышен ${before} → ${this._effective}/мин`);
        }

        /**
         * Сообщает, что сервер ограничил запросы, и ждёт окончания паузы. Запросы,
         * получившие отказ во время уже идущей паузы, просто ждут её конца.
         * @param {number} status - HTTP-статус ответа (0, если статус неизвестен).
         * @param {?(number|string)} [retryAfter] - Значение заголовка Retry-After (секунды).
         * @param {?string} [reason] - Описание причины вместо «HTTP status».
         * @returns {Promise<void>} Разрешается, когда запрос можно повторить.
         * @throws {RateLimitError} Если ограничение не снято после всех пауз.
         */
        async throttled(status, retryAfter = null, reason = null) {
            if (Date.now() < this._pausedUntil) {
                await this._waitPause();
                return;
            }

            const label = reason || `HTTP ${status}`;
            this._strikes += 1;
            this._throttleCount += 1;
            this._successStreak = 0;
            if (this._limitWaitMs >= MAX_LIMIT_WAIT_MS) {
                const total = minutes(this._limitWaitMs);
                this._event('error', `${this.label}: ${label} — ограничение не снято за ${total} мин ожидания`);
                throw new RateLimitError(
                    `Сайт ограничил загрузку (${label}) и не снял ограничение за ${total} мин ожидания. ` +
                    'Скачанные главы сохранены — докачайте позже, начиная с этой главы',
                    status
                );
            }

            const retrySec = parseInt(retryAfter, 10);
            const backoff = retrySec > 0
                ? Math.min(retrySec * 1000, MAX_BACKOFF_MS)
                : Math.min(BASE_BACKOFF_MS * (2 ** Math.min(this._strikes - 1, 10)), MAX_BACKOFF_MS);
            const waitMs = Math.min(backoff, MAX_LIMIT_WAIT_MS - this._limitWaitMs);
            this._limitWaitMs += waitMs;

            // Темп, на котором сервер начал отказывать, — потолок на ближайшие 10 минут.
            const failedAt = this._effective;
            this._cap = Math.max(MIN_PER_MINUTE, Math.floor(failedAt * 0.9));
            this._capUntil = Date.now() + CAP_DURATION_MS;
            this._stepFactor = 0.5;
            // Повторный отказ без восстановления — сервер ужесточает блокировку: больше не разгоняемся.
            if (this._strikes >= 2 && !this._growthDisabled) {
                this._growthDisabled = true;
                this._event('warn', `${this.label}: повторные отказы — автоподбор темпа отключён до конца загрузки`);
            }

            this._pausedUntil = Date.now() + waitMs;
            this._pauseStatus = label;
            this._nextSlot = this._pausedUntil;
            this._effective = Math.max(MIN_PER_MINUTE, Math.floor(failedAt / 2));
            this._concurrencyNow = Math.max(1, Math.ceil(this._concurrencyNow / 2));
            this._saveLearned(Math.max(MIN_PER_MINUTE, Math.floor(failedAt * 0.75)));

            const message = `${this.label}: ${label} — пауза ${Math.round(waitMs / 1000)} с, ` +
                `темп ${failedAt} → ${this._effective}/мин, потоков ${this._concurrencyNow} ` +
                `(ожидание ${minutes(this._limitWaitMs)} из ${minutes(MAX_LIMIT_WAIT_MS)} мин)`;
            console.warn(`[RequestPacer] ${message}`);
            this._event('warn', message);
            await this._waitPause();
        }

        /**
         * Ждёт окончания текущей паузы, сообщая оставшееся время и проверяя остановку.
         * @returns {Promise<void>}
         */
        async _waitPause() {
            while (Date.now() < this._pausedUntil) {
                const left = Math.ceil((this._pausedUntil - Date.now()) / 1000);
                this._report(`Сайт ограничил запросы (${this.label}, ${this._pauseStatus}). ` +
                    `Жду: ${left} с (всего не дольше ${minutes(MAX_LIMIT_WAIT_MS)} мин, «Завершить» — остановить)`);
                await this._sleep(Math.min(1000, this._pausedUntil - Date.now()));
            }
        }

        /**
         * Пауза, прерываемая остановкой загрузки.
         * @param {number} ms - Длительность.
         * @returns {Promise<void>}
         */
        async _sleep(ms) {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (this._gate?.controller?.shouldStop() || this._gate?.cancelled) break;
                await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
            }
            if (this._gate) await this._gate.checkpoint();
        }

        /**
         * @returns {string} Ключ хранения подобранного темпа (полоса + сайт).
         */
        _learnedKey() {
            return LEARNED_KEY_PREFIX + this.name + (this.storageSuffix || '');
        }

        /**
         * @returns {?number} Темп, подобранный прошлыми загрузками, если он актуален.
         */
        _loadLearned() {
            try {
                const saved = JSON.parse(localStorage.getItem(this._learnedKey()) || 'null');
                if (!saved || saved.base !== this.startRate || saved.max !== this.maxRate) return null;
                if (Date.now() - saved.timestamp > LEARNED_TTL) return null;
                return parseInt(saved.rate, 10) || null;
            } catch (e) {
                return null;
            }
        }

        /**
         * @param {number} rate - Темп для следующих загрузок.
         * @returns {void}
         */
        _saveLearned(rate) {
            try {
                localStorage.setItem(this._learnedKey(), JSON.stringify({
                    rate, base: this.startRate, max: this.maxRate, timestamp: Date.now()
                }));
            } catch (e) { /* localStorage недоступен — память темпа не обязательна */ }
        }

        /**
         * @param {string} message - Текст статуса.
         * @returns {void}
         */
        _report(message) {
            if (typeof this.onStatus !== 'function') return;
            try { this.onStatus(message); } catch (e) { /* ignore */ }
        }

        /**
         * @param {'info'|'warn'|'error'} level - Важность события.
         * @param {string} message - Текст события.
         * @returns {void}
         */
        _event(level, message) {
            if (typeof this.onEvent !== 'function') return;
            try { this.onEvent(level, message); } catch (e) { /* ignore */ }
        }
    }

    const DEFAULT_SITE_PROFILE = { concurrency: 2 };
    const DEFAULT_IMAGES_PROFILE = { perMinute: 240, maxPerMinute: 600, concurrency: 6 };
    const lanes = {};

    /**
     * Стартовый темп API. Настройки «Запросов в минуту» больше нет: темп подбирается
     * автоматически от 85/мин (ранее сохранённое значение игнорируется).
     * @returns {number} Запросов в минуту.
     */
    function readRateSetting() {
        return DEFAULT_PER_MINUTE;
    }

    /**
     * Общий регулятор полосы запросов контекста страницы расширения.
     * - 'site'   — API сайта и открытие страниц сайта (режим DOM). Стартовый темп —
     *   настройка «Запросов в минуту», автоподбор поднимает его не выше чем вдвое.
     * - 'images' — CDN изображений: 240/мин на старте, до 600/мин, до 6 загрузок одновременно.
     * @param {'site'|'images'} [lane='site'] - Полоса.
     * @returns {RequestPacer} Регулятор полосы.
     */
    function getRequestPacer(lane = 'site') {
        if (!lanes[lane]) {
            lanes[lane] = lane === 'images'
                ? new RequestPacer({
                    name: 'images', label: 'картинки', perMinute: 240, maxPerMinute: 600, concurrency: 6
                })
                : new RequestPacer({ name: 'site', label: 'API', perMinute: readRateSetting(),
                    maxPerMinute: readRateSetting() * 2, concurrency: 2 });
        }
        return lanes[lane];
    }

    /**
     * Перечитывает настройки полос и сбрасывает их перед новой загрузкой.
     * Сервис может задать свой профиль темпа (config.pacing): например, com-x считает
     * массовые скачивания, поэтому для него темп осторожнее. Настройка «Запросов в минуту»
     * при этом всё равно ограничивает API сверху. Подобранный темп хранится отдельно для
     * каждого сайта.
     * @param {{rateLimit?: number, gate?: object, onStatus?: function, onEvent?: function,
     * profile?: ?{site?: object, images?: object}, serviceKey?: string}} options
     * Лимит API из настроек, гейт загрузки, обработчики статуса/событий, профиль темпа сервиса.
     * @returns {RequestPacer[]} Обе полосы.
     */
    function prepareRequestPacers({ rateLimit, gate = null, onStatus = null, onEvent = null,
        profile = null, serviceKey = '' } = {}) {
        const site = getRequestPacer('site');
        const images = getRequestPacer('images');
        const setting = parseInt(rateLimit, 10) || readRateSetting();

        const siteProfile = profile?.site;
        const sitePerMinute = siteProfile?.perMinute ? Math.min(setting, siteProfile.perMinute) : setting;
        site.configure({
            perMinute: sitePerMinute,
            maxPerMinute: siteProfile?.maxPerMinute
                ? Math.max(sitePerMinute, siteProfile.maxPerMinute)
                : sitePerMinute * 2,
            concurrency: siteProfile?.concurrency || DEFAULT_SITE_PROFILE.concurrency
        });
        images.configure({ ...DEFAULT_IMAGES_PROFILE, ...(profile?.images || {}) });

        const all = [site, images];
        for (const pacer of all) {
            // MangaLib — без суффикса, чтобы сохранить темп, подобранный прежними версиями.
            pacer.storageSuffix = serviceKey && serviceKey !== 'mangalib' ? `_${serviceKey}` : '';
            pacer.reset();
            pacer.setGate(gate);
            pacer.onStatus = onStatus;
            pacer.onEvent = onEvent;
        }
        return all;
    }

    global.RequestPacer = RequestPacer;
    global.RateLimitError = RateLimitError;
    global.THROTTLE_STATUSES = THROTTLE_STATUSES;
    global.getRequestPacer = getRequestPacer;
    global.prepareRequestPacers = prepareRequestPacers;
    console.log('[RequestPacer] Loaded');
})(typeof window !== 'undefined' ? window : self);
