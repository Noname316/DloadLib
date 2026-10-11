/**
 * DownloadLib core module
 * Saves downloaded files into a folder chosen by the user
 * @module core/FileSaver
 * @license MIT
 * @author ivanvit
 * @version 1.1.0
 */

'use strict';

(function(global) {
    console.log('[FileSaver] Loading...');

    /**
     * Очищает строку от символов, недопустимых в именах файлов и папок
     * (Windows накладывает самые строгие ограничения, поэтому ориентируемся на неё).
     * @param {string} name - Исходное имя.
     * @param {string} [fallback='file'] - Имя, если после очистки ничего не осталось.
     * @returns {string} Безопасное имя.
     */
    function sanitizeFileName(name, fallback = 'file') {
        const clean = String(name || '')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // eslint-disable-line no-control-regex
            .replace(/\s+/g, ' ')
            .replace(/[. ]+$/, '')
            .trim()
            .substring(0, 180);
        return clean || fallback;
    }

    /**
     * Сохраняет файлы загрузки в папку, выбранную пользователем.
     *
     * Два режима:
     * - 'directory' — настоящая папка, выбранная через File System Access API
     *   (showDirectoryPicker; Chrome/Edge/Opera). Файлы пишутся напрямую в неё.
     * - 'downloads' — запасной вариант для браузеров без этого API (Firefox):
     *   файлы сохраняются через downloads API в подпапку папки «Загрузки».
     */
    class FileSaver {
        /**
         * @param {{type: 'directory', handle: FileSystemDirectoryHandle}|
         * {type: 'downloads', subfolder?: string}} target - Куда сохранять файлы.
         */
        constructor(target) {
            this.target = target;
        }

        /**
         * Доступен ли выбор произвольной папки через системный диалог.
         * @returns {boolean} true, если браузер поддерживает showDirectoryPicker.
         */
        static supportsDirectoryPicker() {
            return typeof global.showDirectoryPicker === 'function';
        }

        /**
         * Открывает системный диалог выбора папки. Должен вызываться из обработчика
         * действия пользователя (клика), иначе браузер его заблокирует.
         * @returns {Promise<FileSaver>} Сохранитель, пишущий в выбранную папку.
         * @throws {Error} С полем cancelled=true, если пользователь закрыл диалог.
         */
        static async pickDirectory() {
            let handle;
            try {
                handle = await global.showDirectoryPicker({ id: 'downloadlib', mode: 'readwrite' });
            } catch (e) {
                if (e?.name === 'AbortError') {
                    const err = new Error('Папка для сохранения не выбрана');
                    err.cancelled = true;
                    throw err;
                }
                throw new Error(`Не удалось открыть выбор папки: ${e?.message || e}`);
            }

            if (typeof handle.requestPermission === 'function') {
                const state = await handle.requestPermission({ mode: 'readwrite' });
                if (state !== 'granted') throw new Error('Нет разрешения на запись в выбранную папку');
            }
            return new FileSaver({ type: 'directory', handle });
        }

        /**
         * Создаёт сохранитель в подпапку папки «Загрузки» (через downloads API).
         * @param {string} [subfolder] - Имя подпапки; пустое — сохранять в корень «Загрузок».
         * @returns {FileSaver} Сохранитель.
         */
        static forDownloads(subfolder) {
            const parts = String(subfolder || '')
                .split(/[\\/]+/)
                .map(p => sanitizeFileName(p, ''))
                .filter(p => p && p !== '.' && p !== '..');
            return new FileSaver({ type: 'downloads', subfolder: parts.join('/') });
        }

        /**
         * Возвращает сохранитель в подпапку текущей папки (создаёт её, если её нет;
         * существующая папка используется как есть). Нужен, чтобы сложить главы тайтла
         * в отдельную папку с его названием.
         * @param {string} name - Имя подпапки (недопустимые символы заменяются).
         * @returns {Promise<FileSaver>} Сохранитель подпапки.
         * @throws {Error} Если создать папку не удалось.
         */
        async subfolder(name) {
            const safe = sanitizeFileName(name, 'manga');
            if (this.target.type === 'directory') {
                let handle;
                try {
                    handle = await this.target.handle.getDirectoryHandle(safe, { create: true });
                } catch (e) {
                    throw new Error(`Не удалось создать папку «${safe}» в «${this.describe()}»: ${e?.message || e}`);
                }
                const path = `${this.target.path || this.target.handle.name}/${safe}`;
                return new FileSaver({ type: 'directory', handle, path });
            }
            const parent = this.target.subfolder;
            return new FileSaver({ type: 'downloads', subfolder: parent ? `${parent}/${safe}` : safe });
        }

        /**
         * Человекочитаемое описание места сохранения (для панели информации).
         * @returns {string} Название папки.
         */
        describe() {
            if (this.target.type === 'directory') return this.target.path || this.target.handle.name;
            return this.target.subfolder ? `Загрузки/${this.target.subfolder}` : 'Загрузки';
        }

        /**
         * Сохраняет один файл в целевую папку (существующий файл с тем же именем
         * перезаписывается в режиме 'directory' и переименовывается в режиме 'downloads').
         * @param {Blob} blob - Содержимое файла.
         * @param {string} filename - Имя файла.
         * @returns {Promise<void>}
         * @throws {Error} Если записать файл не удалось.
         */
        async save(blob, filename) {
            const name = sanitizeFileName(filename);
            if (this.target.type === 'directory') return this._saveToDirectory(blob, name);
            return this._saveViaDownloads(blob, name);
        }

        /**
         * Записывает файл в папку, выбранную через File System Access API.
         * @param {Blob} blob - Содержимое файла.
         * @param {string} name - Безопасное имя файла.
         * @returns {Promise<void>}
         */
        async _saveToDirectory(blob, name) {
            try {
                const fileHandle = await this.target.handle.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();
                try {
                    await writable.write(blob);
                } finally {
                    await writable.close();
                }
            } catch (e) {
                throw new Error(`Не удалось записать файл «${name}» в папку «${this.target.handle.name}»: ${e?.message || e}`);
            }
        }

        /**
         * Сохраняет файл через downloads API в подпапку «Загрузок» и дожидается
         * окончания записи, чтобы ошибка сохранения не прошла незамеченной.
         * @param {Blob} blob - Содержимое файла.
         * @param {string} name - Безопасное имя файла.
         * @returns {Promise<void>}
         */
        async _saveViaDownloads(blob, name) {
            const api = typeof global.getExtensionApi === 'function' ? global.getExtensionApi() : null;
            const filename = this.target.subfolder ? `${this.target.subfolder}/${name}` : name;
            const url = URL.createObjectURL(blob);

            if (!api?.downloads?.download) {
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
                return;
            }

            let downloadId;
            try {
                downloadId = await api.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
            } catch (e) {
                URL.revokeObjectURL(url);
                throw new Error(`Не удалось сохранить файл «${filename}»: ${e?.message || e}`);
            }

            await this._waitForDownload(api, downloadId, filename);
            URL.revokeObjectURL(url);
        }

        /**
         * Ждёт завершения загрузки по её id (или 2 минуты, если onChanged недоступен).
         * @param {object} api - API расширения.
         * @param {number} downloadId - id загрузки.
         * @param {string} filename - Имя файла (для текста ошибки).
         * @returns {Promise<void>}
         * @throws {Error} Если загрузка была прервана.
         */
        _waitForDownload(api, downloadId, filename) {
            const {onChanged} = api.downloads;
            if (!onChanged?.addListener || downloadId == null)
                return new Promise(resolve => setTimeout(resolve, 2000));

            return new Promise((resolve, reject) => {
                const timer = setTimeout(done, 120000);

                function done(error) {
                    clearTimeout(timer);
                    onChanged.removeListener(listener);
                    if (error) reject(error);
                    else resolve();
                }

                function listener(delta) {
                    if (delta.id !== downloadId || !delta.state) return;
                    if (delta.state.current === 'complete') done();
                    else if (delta.state.current === 'interrupted') {
                        const reason = delta.error?.current || 'загрузка прервана';
                        done(new Error(`Не удалось сохранить файл «${filename}»: ${reason}`));
                    }
                }

                onChanged.addListener(listener);
            });
        }
    }

    global.FileSaver = FileSaver;
    global.sanitizeFileName = sanitizeFileName;
    console.log('[FileSaver] Loaded');
})(typeof window !== 'undefined' ? window : self);
