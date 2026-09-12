(function() {
    'use strict';

    var fflate = window.fflate;
    if (!fflate || typeof fflate.unzip !== 'function') {
        throw new Error('ZipLoader requires fflate.js to be loaded first.');
    }

    var _vfs = Object.create(null);
    // ZIP entries preserve their original case, while RPG Maker's old NW.js
    // filesystem was commonly case-insensitive. Keep a second lookup table so
    // saves/plugins requesting AMB_FOREST.ogg can still resolve the archived
    // audio entry AMB_forest.ogg (and leaf.png vs Leaf.png).
    var _vfsInsensitive = Object.create(null);
    var _blobUrls = Object.create(null);
    var _archivePromises = Object.create(null);
    var _configPromise = null;
    var _xhrQueue = [];
    var _ready = false;
    var _launched = false;
    var _initPromise = null;
    var _launchPromise = null;
    var _resolveLaunch = null;
    var _error = null;
    var _origFetch = window.fetch ? window.fetch.bind(window) : null;

    // Mobile networks (cellular hand-offs, WiFi->cellular switches, aggressive
    // background throttling) far more commonly leave a TCP connection open but
    // silently dead than desktop connections do: no error, no close event ever
    // reaches fetch(), the returned promise just never settles. None of the
    // media-loading code below had a timeout, so a single stalled request among
    // the many concurrent part/index fetches during boot would hang the whole
    // Promise.all() chain forever with no console error — exactly a stuck
    // loading screen. This wraps fetch with a hard timeout plus a couple of
    // quick retries so a stalled request fails fast and gets another shot
    // instead of freezing boot indefinitely.
    var FETCH_TIMEOUT_MS = 15000;
    var FETCH_RETRIES = 2;

    // Races an arbitrary promise (e.g. response.blob()/response.arrayBuffer(),
    // which read the body internally and can stall mid-transfer on mobile even
    // after the initial fetch() has already resolved) against a timeout.
    function withTimeout(promise, timeoutMs, message) {
        timeoutMs = timeoutMs || FETCH_TIMEOUT_MS;
        return new Promise(function(resolve, reject) {
            var settled = false;
            var timer = setTimeout(function() {
                if (settled) return;
                settled = true;
                reject(new Error(message || ('ZipLoader: operation timed out after ' + timeoutMs + 'ms')));
            }, timeoutMs);
            promise.then(function(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }, function(err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    function fetchWithTimeout(url, options, timeoutMs, attemptsLeft) {
        if (!_origFetch) return Promise.reject(new Error('Fetch is unavailable.'));
        timeoutMs = timeoutMs || FETCH_TIMEOUT_MS;
        attemptsLeft = (attemptsLeft === undefined) ? FETCH_RETRIES : attemptsLeft;

        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var opts = options ? Object.assign({}, options) : {};
        if (controller) opts.signal = controller.signal;

        var timedOut = false;
        var timer = setTimeout(function() {
            timedOut = true;
            if (controller) controller.abort();
        }, timeoutMs);

        return _origFetch(url, opts).then(function(response) {
            clearTimeout(timer);
            return response;
        }, function(err) {
            clearTimeout(timer);
            if (timedOut) err = new Error('ZipLoader: request timed out after ' + timeoutMs + 'ms: ' + url);
            if (attemptsLeft > 0) {
                return fetchWithTimeout(url, options, timeoutMs, attemptsLeft - 1);
            }
            throw err;
        });
    }

    var _origOpen = XMLHttpRequest.prototype.open;
    var _origSend = XMLHttpRequest.prototype.send;
    var _bitmapHookPrototype = null;
    var _graphicsHookTarget = null;
    // Lazy media (img/ + audio/) store. Instead of decompressing the ~1.6 GB of
    // image/audio archives into RAM at boot, we parse each archive's central
    // directory once and keep only { path -> zip entry } metadata here. A file's
    // bytes are materialised on demand from the cached archive Blob (which
    // Chrome/Edge can spill to disk), so boot peak memory stays a small fraction
    // of the old eager path.
    var _mediaFiles = Object.create(null);       // normalized path -> { archive, lhOff, csize, usize, method }
    var _mediaInsensitive = Object.create(null); // lowercased path -> normalized path
    var _mediaBlobs = Object.create(null);       // archive name -> Blob (full archive, optional; unused by the
                                                  // lazy path below, kept only for readMediaBytes()'s branch)
    var _mediaPartMap = Object.create(null);    // archive name -> [{start, end, index}]
    // Bounded LRU cache of individual (compressed) zip parts, each a few MB.
    // We never assemble or retain a full media archive: images/audio are
    // indexed from just their EOCD + central directory, and file bytes are
    // read from only the 1-2 parts that actually contain them. This cache
    // just keeps recently-touched parts warm (for the current part + a
    // small one-part readahead) and evicts the oldest once the budget is
    // exceeded, so total resident zip-part memory stays bounded regardless
    // of how long a session runs or how large the source archives are.
    var _mediaPartCache = Object.create(null);  // archive name -> { index -> Blob }
    var _partCacheOrder = [];                   // "archive\u0000index" keys, oldest first
    var _partFetchPromises = Object.create(null); // "archive\u0000index" -> in-flight part fetch
    var _partCacheBytes = 0;
    var PART_CACHE_MAX_BYTES = 180 * 1024 * 1024; // ~180 MB of raw parts resident at once
    // Prefetch planning: how many whole parts may be in flight at once, and
    // how many files may be materialised (locally sliced) at once.
    var PREFETCH_PART_CONCURRENCY = 4;
    var PREFETCH_FILE_CONCURRENCY = 8;
    // A fully transparent 48x48 PNG used as a stand-in when a referenced image
    // is absent from the asset pack. Loading this instead of failing keeps the
    // bitmap in a completed state, so a missing sprite renders as invisible
    // rather than leaving a scene stuck on a black screen.
    var TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAH0lEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAALwYkMAABdG+8JQAAAABJRU5ErkJggg==';

    // ---- config / account ---------------------------------------------------
    var CONCURRENCY = 6;
    var _cacheEnabled = true;
    var _config = { baseUrl: '', useRemoteParts: false, accountId: '', concurrency: '6', cacheEnabled: true };
    var _accountId = 'default';
    var _manifest; // undefined = not loaded yet, null = unavailable, object = parsed
    // Native desktop shell (Tauri). External asset part folders are read from
    // next to the executable through the IPC bridge (see fetchExternalPart).
    var _isTauri = typeof window.__TAURI__ !== 'undefined' && !!window.__TAURI__;

    // Route progress to a per-asset bar so concurrent image/audio downloads
    // don't fight over one fill width + label. Channels: 'main' (data/maps/
    // languages/boot), 'images', 'audio'.
    var PROGRESS_IDS = {
        main:   ['zipProgressFill', 'zipProgressLabel'],
        images: ['zipProgressImageFill', 'zipProgressImageLabel'],
        audio:  ['zipProgressAudioFill', 'zipProgressAudioLabel']
    };

    function progress(percent, label) {
        progressChannel('main', percent, label);
    }

    function progressChannel(channel, percent, label) {
        var ids = PROGRESS_IDS[channel] || PROGRESS_IDS.main;
        var fill = document.getElementById(ids[0]);
        var text = document.getElementById(ids[1]);
        if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(percent))) + '%';
        if (text) text.textContent = label || '';
    }

    function showProgress() {
        var bar = document.getElementById('zipProgress');
        if (bar) bar.style.display = 'flex';
    }

    function hideProgress() {
        var bar = document.getElementById('zipProgress');
        if (bar) bar.style.display = 'none';
    }

    // Once every archive is ready, hide the loading bars/labels and leave only
    // the LAUNCH button and the mod uploader visible.
    function hideProgressBars() {
        ['zipProgressHeader', 'zipProgressMainBar', 'zipProgressLabel',
            'zipProgressImages', 'zipProgressAudio'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }

    // The save panel lives inside the launcher box until the game starts.
    // On launch, reparent it to the document and glide it up to the top-right
    // corner with a FLIP animation (measure -> relocate -> invert -> play).
    // Multiplies every CSS length inside a value by `factor` (e.g. '10px 12px'
    // -> '5px 6px', '11px 24px' -> '5.5px 12px'). Non-length strings pass
    // through untouched, so it is safe to feed unset properties through it.
    function scaleCssLength(value, factor) {
        if (!value) return value;
        return String(value).replace(/(-?\d*\.?\d+)([a-z%]*)/gi, function (match, num, unit) {
            return (Math.round(parseFloat(num) * factor * 100) / 100) + unit;
        });
    }

    function relocateSavePanelToCorner() {
        var panel = document.getElementById('saveUploader');
        if (!panel) return;
        var first = panel.getBoundingClientRect();
        var title = document.getElementById('saveUploaderTitle');
        var divider = document.getElementById('saveUploaderDivider');
        var buttons = document.getElementById('saveUploaderButtons');
        document.body.appendChild(panel);
        panel.style.position = 'fixed';
        panel.style.top = '8px';
        panel.style.right = '8px';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.margin = '0';
        panel.style.width = 'auto';
        panel.style.maxWidth = 'none';
        panel.style.background = '#000';
        panel.style.border = '2px solid #fff';
        panel.style.padding = '10px 12px';
        panel.style.boxSizing = 'border-box';
        panel.style.alignItems = 'stretch';
        panel.style.zIndex = '2147483647';
        panel.style.transition = 'none';
        panel.style.pointerEvents = 'none';
        if (title) title.style.display = 'none';
        if (divider) divider.style.display = 'none';
        if (buttons) buttons.style.flexDirection = 'column';

        // Phones and tablets have far less room than a desktop window, and the
        // corner panel sits on top of the play area, so scale it to roughly half
        // size there. Every value is derived from the element's own inline
        // styling (the panel's or index.html's), so it keeps tracking the
        // full-size layout instead of duplicating a pile of magic numbers.
        var isCompact = (typeof Utils !== 'undefined' && Utils.isMobileDevice && Utils.isMobileDevice()) ||
            (navigator.maxTouchPoints > 0 && !!window.matchMedia &&
             window.matchMedia('(pointer: coarse)').matches);
        if (isCompact) {
            var factor = 0.5;
            panel.style.padding = scaleCssLength(panel.style.padding, factor);
            panel.style.gap = scaleCssLength(panel.style.gap, factor);
            // Fallback matches the 2px border this same function sets above, in
            // case the inline shorthand was not expanded into a longhand.
            panel.style.borderWidth = scaleCssLength(panel.style.borderWidth || '2px', factor);
            var status = document.getElementById('saveUploadStatus');
            if (status) {
                status.style.fontSize = scaleCssLength(status.style.fontSize, factor);
                status.style.letterSpacing = scaleCssLength(status.style.letterSpacing, factor);
                status.style.minHeight = scaleCssLength(status.style.minHeight, factor);
            }
            if (buttons) {
                buttons.style.gap = scaleCssLength(buttons.style.gap, factor);
                for (var i = 0; i < buttons.children.length; i++) {
                    var btn = buttons.children[i];
                    btn.style.padding = scaleCssLength(btn.style.padding, factor);
                    btn.style.fontSize = scaleCssLength(btn.style.fontSize, factor);
                    btn.style.letterSpacing = scaleCssLength(btn.style.letterSpacing, factor);
                    btn.style.borderWidth = scaleCssLength(btn.style.borderWidth, factor);
                }
            }
            // The "refresh after uploading" note is the panel's last element
            // child (the hidden file input sits just before it).
            var note = panel.lastElementChild;
            if (note && note !== buttons && note.tagName === 'DIV') {
                note.style.fontSize = scaleCssLength(note.style.fontSize, factor);
                note.style.marginTop = scaleCssLength(note.style.marginTop, factor);
                note.style.letterSpacing = scaleCssLength(note.style.letterSpacing, factor);
            }
        }
        var last = panel.getBoundingClientRect();
        var dx = first.left - last.left;
        var dy = first.top - last.top;
        panel.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        void panel.offsetWidth; // force reflow so the inverse transform sticks
        panel.style.transition = 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)';
        panel.style.transform = 'translate(0,0)';
        setTimeout(function() {
            panel.style.transition = '';
            panel.style.transform = '';
            panel.style.pointerEvents = 'auto';
        }, 600);
    }

    function showLaunchButton() {
        var button = document.getElementById('zipLaunchButton');
        if (!button || button.__zipLaunchBound) return;
        button.__zipLaunchBound = true;
        button.style.display = 'block';
        button.disabled = false;
        button.addEventListener('click', function() {
            if (!_ready || _launched) return;
            _launched = true;
            button.disabled = true;
            button.style.display = 'none';
            relocateSavePanelToCorner();
            hideProgress();
            if (_resolveLaunch) {
                var resolve = _resolveLaunch;
                _resolveLaunch = null;
                resolve(true);
            }
        });
    }

    function waitForLaunch() {
        if (_launched) return Promise.resolve(true);
        if (!_launchPromise) {
            _launchPromise = new Promise(function(resolve) {
                _resolveLaunch = resolve;
            });
        }
        if (_ready) showLaunchButton();
        return _launchPromise;
    }

    function normalizePath(url) {
        var value = String(url || '').replace(/\\/g, '/');
        try {
            var parsed = new URL(value, window.location.href);
            var root = new URL('./', window.location.href).pathname;
            if (parsed.pathname.indexOf(root) === 0) {
                value = parsed.pathname.slice(root.length);
            } else {
                value = parsed.pathname.replace(/^\/+/, '');
            }
        } catch (e) {
            value = value.replace(/^https?:\/\/[^/]+/i, '');
            value = value.replace(/^\.\//, '').replace(/^\/+/, '');
        }
        return value.split('?')[0].split('#')[0].replace(/^\/+/, '');
    }

    function isVfsPath(url) {
        var path = normalizePath(url);
        return path.indexOf('data/') === 0 ||
            path.indexOf('maps/') === 0 ||
            path.indexOf('img/') === 0 ||
            path.indexOf('audio/') === 0;
    }

    function mimeType(path) {
        var value = path.toLowerCase();
        if (value.endsWith('.png')) return 'image/png';
        if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg';
        if (value.endsWith('.ogg')) return 'audio/ogg';
        if (value.endsWith('.m4a')) return 'audio/mp4';
        if (value.endsWith('.json')) return 'application/json';
        if (value.endsWith('.yaml')) return 'text/yaml';
        if (value.endsWith('.webm')) return 'video/webm';
        return 'application/octet-stream';
    }

    function updateByteProgress(done, total, start, span, label, channel) {
        var fraction = total > 0 ? Math.min(1, done / total) : 0;
        progressChannel(channel, start + fraction * span, label + ' (' +
            Math.round(done / 1048576 * 10) / 10 + ' MB)');
    }

    // Native desktop build (Tauri v2): external img_pack/aud_pack parts are
    // served as raw bytes over a custom `omori://` URI scheme, which WebView2
    // accepts through fetch(). The base64 IPC command is kept only as a
    // fallback for WebView builds where the custom scheme is unavailable.
    var ASSET_SCHEME = 'omori';

    function isExternalPartUrl(url) {
        var p = normalizePath(url);
        return p.indexOf('img_pack/') === 0 || p.indexOf('aud_pack/') === 0;
    }

    function externalPartUrl(url) {
        return ASSET_SCHEME + '://localhost/' + normalizePath(url);
    }

    var _assetTransportWarned = false;
    function fetchExternalPart(url, start, span, label, channel) {
        var rel = normalizePath(url);
        var finish = function(bytes) {
            updateByteProgress(bytes.length, bytes.length, start, span, label, channel);
            return bytes;
        };
        return _origFetch(externalPartUrl(url)).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + rel);
            return response.arrayBuffer();
        }).then(function(buffer) {
            return finish(new Uint8Array(buffer));
        }).catch(function(schemeError) {
            if (!_assetTransportWarned) {
                _assetTransportWarned = true;
                console.warn('ZipLoader: custom scheme fetch failed (' + (schemeError && schemeError.message) +
                    '); falling back to base64 IPC — asset loading will be slower.');
            }
            // Fallback: base64 over IPC (slower but universally available).
            return window.__TAURI__.core.invoke('read_asset_file', { path: rel }).then(function(b64) {
                if (typeof b64 !== 'string' || !b64) {
                    throw schemeError || new Error('empty asset response for ' + rel);
                }
                var bin = atob(b64);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return finish(bytes);
            });
        });
    }

    // NOTE: no cache:'no-store' here. When the server sends cache headers the
    // browser HTTP cache can serve parts directly; correctness of the asset
    // version is handled by manifest.json (or per-part HEAD verification).
    function fetchBytes(url, start, span, label, channel) {
        if (_isTauri && isExternalPartUrl(url)) {
            return fetchExternalPart(url, start, span, label, channel);
        }
        if (!_origFetch) return Promise.reject(new Error('Fetch is unavailable.'));
        return fetchWithTimeout(url).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
            var total = Number(response.headers.get('content-length')) || 0;
            if (!response.body || !response.body.getReader) {
                return response.arrayBuffer().then(function(buffer) {
                    updateByteProgress(buffer.byteLength, total || buffer.byteLength, start, span, label, channel);
                    return new Uint8Array(buffer);
                });
            }
            var reader = response.body.getReader();
            var chunks = [];
            var loaded = 0;
            // A resolved fetch() only proves the connection opened; on flaky
            // mobile connections the byte stream itself can stall mid-transfer
            // with no error ever firing on reader.read(). Race each chunk read
            // against a watchdog so a dead stream fails loudly instead of
            // hanging the whole boot sequence forever.
            function readChunkWithWatchdog() {
                var timedOut = false;
                var timer = setTimeout(function() {
                    timedOut = true;
                    if (reader.cancel) reader.cancel('stall watchdog').catch(function() {});
                }, FETCH_TIMEOUT_MS);
                return reader.read().then(function(part) {
                    clearTimeout(timer);
                    return part;
                }, function(err) {
                    clearTimeout(timer);
                    if (timedOut) throw new Error('ZipLoader: stream stalled for ' + url);
                    throw err;
                });
            }
            function read() {
                return readChunkWithWatchdog().then(function(part) {
                    if (part.done) {
                        var result = new Uint8Array(loaded);
                        var offset = 0;
                        chunks.forEach(function(chunk) {
                            result.set(chunk, offset);
                            offset += chunk.length;
                        });
                        updateByteProgress(loaded, total || loaded, start, span, label, channel);
                        return result;
                    }
                    chunks.push(part.value);
                    loaded += part.value.byteLength;
                    updateByteProgress(loaded, total, start, span, label, channel);
                    return read();
                });
            }
            return read();
        });
    }

    // Bounded-concurrency fetch queue. Resolves with results in request order.
    function fetchQueue(items) {
        var results = new Array(items.length);
        var index = 0;
        var active = 0;
        return new Promise(function(resolve, reject) {
            function pump() {
                while (active < CONCURRENCY && index < items.length) {
                    (function(i) {
                        active++;
                        fetchBytes(items[i].url, items[i].start, items[i].span, items[i].label, items[i].channel).then(function(bytes) {
                            results[i] = bytes;
                            active--;
                            if (index < items.length) pump();
                            else if (active === 0) resolve(results);
                        }, function(err) {
                            active--;
                            reject(err);
                        });
                    })(index++);
                }
            }
            pump();
        });
    }

    // Download media parts as Blob objects instead of retaining every part as a
    // Uint8Array. Browsers can keep Blob data disk-backed; retaining the full
    // 1.07 GB audio archive as live JS arrays is what makes low-memory machines
    // thrash or crash before the lazy index is built.
    // Coerces whatever a fetch path handed back (native Blob, ArrayBuffer,
    // Uint8Array/typed array, or a Response-like object) into a real Blob so
    // that everything downstream (blobRange, touchPartCache, assembleBlobFromParts)
    // can rely on a single, consistent shape.
    function normalizeMediaBlob(value) {
        if (value instanceof Blob) {
            return Promise.resolve(value);
        }
        if (value instanceof ArrayBuffer) {
            return Promise.resolve(new Blob([value], { type: 'application/octet-stream' }));
        }
        if (value instanceof Uint8Array) {
            return Promise.resolve(new Blob([value], { type: 'application/octet-stream' }));
        }
        if (ArrayBuffer.isView(value)) {
            return Promise.resolve(new Blob(
                [new Uint8Array(value.buffer, value.byteOffset, value.byteLength)],
                { type: 'application/octet-stream' }
            ));
        }
        // Some custom fetch/IPC implementations may hand back a Response-like object.
        if (value && typeof value.arrayBuffer === 'function') {
            return value.arrayBuffer().then(function(buffer) {
                return new Blob([buffer], { type: 'application/octet-stream' });
            });
        }
        return Promise.reject(new TypeError(
            'ZipLoader: expected media Blob/bytes, got ' + Object.prototype.toString.call(value)
        ));
    }

    function fetchBlob(url, start, span, label, channel) {
        if (_isTauri && isExternalPartUrl(url)) {
            return fetchExternalPart(url, start, span, label, channel).then(function(bytes) {
                return new Blob([bytes], { type: 'application/octet-stream' });
            });
        }
        if (!_origFetch) return Promise.reject(new Error('Fetch is unavailable.'));
        return fetchWithTimeout(url).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
            var bodyPromise = (typeof response.blob === 'function')
                ? response.blob()
                : response.arrayBuffer();
            return withTimeout(bodyPromise, FETCH_TIMEOUT_MS, 'ZipLoader: body read stalled for ' + url);
        }).then(normalizeMediaBlob).then(function(blob) {
            updateByteProgress(blob.size, blob.size, start, span, label, channel);
            return blob;
        });
    }

    function fetchBlobQueue(items) {
        var results = new Array(items.length);
        var index = 0;
        var active = 0;
        return new Promise(function(resolve, reject) {
            function pump() {
                while (active < CONCURRENCY && index < items.length) {
                    (function(i) {
                        active++;
                        fetchBlob(items[i].url, items[i].start, items[i].span, items[i].label, items[i].channel).then(function(blob) {
                            results[i] = blob;
                            active--;
                            if (index < items.length) pump();
                            else if (active === 0) resolve(results);
                        }, function(err) {
                            active--;
                            reject(err);
                        });
                    })(index++);
                }
            }
            pump();
        });
    }

    // ---- base.ini -----------------------------------------------------------
    function parseBaseIni(text) {
        var config = { baseUrl: '', useRemoteParts: false, accountId: '', concurrency: '6', cacheEnabled: true };
        String(text || '').split(/\r?\n/).forEach(function(line) {
            line = line.trim();
            if (!line || line[0] === ';' || line[0] === '#') return;
            var separator = line.indexOf('=');
            if (separator < 0) return;
            var key = line.slice(0, separator).trim();
            var value = line.slice(separator + 1).trim();
            if (key === 'baseUrl') config.baseUrl = value;
            if (key === 'useRemoteParts') config.useRemoteParts = value.toLowerCase() === 'true';
            if (key === 'accountId') config.accountId = value;
            if (key === 'concurrency') config.concurrency = value;
            if (key === 'cacheEnabled') config.cacheEnabled = value.toLowerCase() !== 'false';
        });
        return config;
    }

    function loadConfig() {
        if (_configPromise) return _configPromise;
        _configPromise = fetchWithTimeout('base.ini')
            .then(function(response) {
                if (!response.ok) return '';
                return response.text();
            })
            .then(function(text) { return parseBaseIni(text); })
            .catch(function() { return { baseUrl: '', useRemoteParts: false, accountId: '', concurrency: '6', cacheEnabled: true }; });
        return _configPromise;
    }

    function applyConfig(config) {
        _config = config || _config;
        var c = parseInt(_config.concurrency, 10);
        if (c >= 1 && c <= 32) CONCURRENCY = c;
        else if (_isTauri) CONCURRENCY = 16; // local disk reads parallelize well
        _cacheEnabled = _config.cacheEnabled !== false;
        // Mirror the base.ini baseUrl into the CDN rewriter so js/, movies/
        // and fonts/ requests follow the same origin as the zips.
        if (typeof window.__applyCdnBase === 'function') window.__applyCdnBase(_config.baseUrl);
        // Native build: img/audio parts are local files read straight off the
        // disk through the custom protocol, so mirroring them into IndexedDB
        // would just duplicate ~1.6 GB of data for no benefit.
        if (_isTauri) _cacheEnabled = false;
    }

    function resolveAccountId() {
        var id = null;
        try {
            var params = new URLSearchParams(window.location.search);
            id = params.get('account');
        } catch (e) {}
        if (!id) {
            try { id = window.localStorage.getItem('wo.accountId'); } catch (e) {}
        }
        if (!id) id = _config.accountId;
        return id || 'default';
    }

    // ---- IndexedDB archive cache ---------------------------------------------
    var IDB_NAME = 'WO_Assets';
    var _idbPromise = null;

    function idbOpen() {
        if (typeof indexedDB === 'undefined') {
            return Promise.reject(new Error('indexedDB unavailable'));
        }
        return new Promise(function(resolve, reject) {
            var req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('archives')) {
                    db.createObjectStore('archives', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            req.onsuccess = function(e) { resolve(e.target.result); };
            req.onerror = function(e) { reject(e.target.error); };
        });
    }

    function idb() {
        if (!_idbPromise) _idbPromise = idbOpen();
        return _idbPromise;
    }

    function idbGet(store, key) {
        return idb().then(function(db) {
            return new Promise(function(resolve) {
                try {
                    var tx = db.transaction(store, 'readonly');
                    var req = tx.objectStore(store).get(key);
                    req.onsuccess = function() { resolve(req.result ? req.result.value : null); };
                    req.onerror = function() { resolve(null); };
                } catch (e) { resolve(null); }
            });
        }).catch(function() { return null; });
    }

    function idbPut(store, key, value) {
        return idb().then(function(db) {
            return new Promise(function(resolve) {
                try {
                    var tx = db.transaction(store, 'readwrite');
                    tx.objectStore(store).put({ key: key, value: value });
                    tx.oncomplete = function() { resolve(true); };
                    tx.onerror = function() { resolve(false); };
                    tx.onabort = function() { resolve(false); };
                } catch (e) { resolve(false); }
            });
        }).catch(function() { return false; });
    }

    function cacheGetArchive(name) {
        return idbGet('archives', 'archive:' + name).then(function(blob) {
            if (!blob) return null;
            if (typeof blob.arrayBuffer === 'function') {
                return blob.arrayBuffer().then(function(ab) { return new Uint8Array(ab); });
            }
            if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
            if (blob && blob.buffer) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
            return null;
        });
    }

    // Same store, but returns the Blob handle without materialising its bytes.
    // The lazy media index slices straight out of this handle.
    function cacheGetArchiveBlob(name) {
        return idbGet('archives', 'archive:' + name);
    }

    function cachePutArchiveBlob(name, blob) {
        try {
            return idbPut('archives', 'archive:' + name, blob);
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    // Lightweight presence check: unlike cacheGetArchive() this never
    // materializes the blob into memory, so a 500 MB archive can be verified
    // by its stored size alone. Returns the stored size (0 if missing/empty).
    function cacheHasArchive(name) {
        return idbGet('archives', 'archive:' + name).then(function(blob) {
            return blob ? blob.size : 0;
        }).catch(function() { return 0; });
    }

    // Store as a Blob so Chrome/Edge can spill large archives to disk.
    function cachePutArchive(name, bytes) {
        try {
            var blob = new Blob([bytes]);
            return idbPut('archives', 'archive:' + name, blob);
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    function cacheGetMeta(name) {
        return idbGet('meta', 'meta:' + name);
    }

    function cachePutMeta(name, meta) {
        return idbPut('meta', 'meta:' + name, meta);
    }

    // ---- archive metadata (manifest first, HEAD fallback) ---------------------
    // The manifest describes the archives that live at baseUrl, so when a
    // baseUrl is configured it is fetched from there first; the local file is
    // only a fallback (or the sole source when hosting everything locally).
    function loadManifest() {
        if (_manifest !== undefined) return Promise.resolve(_manifest);
        var base = String(_config.baseUrl || '').replace(/\/+$/, '');
        var remoteFirst = base
            ? fetchWithTimeout(base + '/manifest.json').then(function(response) {
                if (!response.ok) throw new Error('no remote manifest');
                return response.json().then(function(json) {
                    if (!json || typeof json !== 'object') throw new Error('bad remote manifest');
                    return json;
                });
            })
            : Promise.reject(new Error('no baseUrl configured'));
        return remoteFirst.then(function(json) {
            _manifest = json || null;
            return _manifest;
        }).catch(function() {
            return fetchWithTimeout('manifest.json').then(function(response) {
                if (!response.ok) { _manifest = null; return null; }
                return response.json().then(function(json) {
                    _manifest = json || null;
                    return _manifest;
                }, function() { _manifest = null; return null; });
            }).catch(function() { _manifest = null; return null; });
        });
    }

    function archiveBaseUrl(desc) {
        var base = _config.baseUrl.replace(/\/+$/, '');
        if (!_config.useRemoteParts || !desc.folder) return base;
        return base + '/' + desc.folder;
    }

    // Resolves the directory that holds an archive's part files. The part-URL
    // builders used to append desc.folder on top of archiveBaseUrl(), which
    // already appends it for remote parts — producing doubled paths like
    // img_pack/img_pack/img_repk.zip.partNN (404s -> 'body read stalled' ->
    // 'image missing, using placeholder'). If the base already ends with the
    // pack folder it is returned as-is; otherwise the folder is appended,
    // preserving the local, non-remote layout.
    function archiveFolderUrl(desc) {
        // Media packs are bundled in the local workspace next to index.html;
        // everything else (data/maps/languages) still comes from the
        // configured CDN base. The bundled packs resolve against the page's
        // own directory (not the origin root) so subdirectory hosts like
        // WebSim — which serves the site at /p/<id>/ — find the parts
        // instead of 404ing on an absolute /img_pack path.
        if (desc.folder === 'img_pack' || desc.folder === 'aud_pack') {
            try {
                // Resolve against the page's own directory so subdirectory
                // hosts (WebSim) find the bundled parts, and strip the
                // trailing slash — every caller appends '/' itself
                // (folder + '/' + fileName), so keeping one would produce
                // img_pack//img_repk.zip.partNN and 404.
                var pageDir = new URL('./', window.location.href);
                return new URL(desc.folder + '/', pageDir).href.replace(/\/+$/, '');
            } catch (e) {
                return desc.folder;
            }
        }
        var base = archiveBaseUrl(desc);
        if (!desc.folder) return base;
        var suffix = '/' + desc.folder;
        return base.slice(-suffix.length) === suffix ? base : base + suffix;
    }

    function headFetch(url) {
        return fetchWithTimeout(url, { method: 'HEAD' }).then(function(response) {
            return { size: Number(response.headers.get('content-length')) || 0 };
        });
    }

    function headQueue(urls) {
        var results = new Array(urls.length);
        var index = 0;
        var active = 0;
        return new Promise(function(resolve, reject) {
            function pump() {
                while (active < CONCURRENCY && index < urls.length) {
                    (function(i) {
                        active++;
                        headFetch(urls[i]).then(function(info) {
                            results[i] = info;
                            active--;
                            if (index < urls.length) pump();
                            else if (active === 0) resolve(results);
                        }, function(err) {
                            active--;
                            reject(err);
                        });
                    })(index++);
                }
            }
            pump();
        });
    }

    function headMeta(desc) {
        var folder = archiveFolderUrl(desc);
        var urls = [];
        for (var i = 0; i < desc.count; i++) {
            var suffix = desc.pad ? String(i + 1).padStart(desc.pad, '0') : '';
            var fileName = desc.name + (desc.pad ? '.part' + suffix : '');
            urls.push(folder ? folder + '/' + fileName : fileName);
        }
        return headQueue(urls).then(function(infos) {
            var parts = infos.map(function(info, idx) {
                return { name: urls[idx].split('/').pop(), size: info.size };
            });
            var totalSize = 0;
            parts.forEach(function(p) { totalSize += p.size; });
            return {
                version: 'head:' + parts.map(function(p) { return p.name + ':' + p.size; }).join(','),
                totalSize: totalSize,
                parts: parts
            };
        }).catch(function() { return null; });
    }

    // Returns the expected metadata for an archive, or null if it cannot be
    // determined (in which case the archive is simply downloaded uncached).
    function ensureMeta(desc) {
        return loadManifest().then(function(manifest) {
            if (manifest && manifest.archives && manifest.archives[desc.name]) {
                var m = manifest.archives[desc.name];
                return {
                    version: String(manifest.version || '1'),
                    totalSize: m.totalSize || 0,
                    parts: m.parts || []
                };
            }
            return headMeta(desc);
        });
    }

    // Prefer manifest-declared part counts/padding over the local defaults so
    // remote deployments can re-split archives without touching this file.
    function descWithManifest(desc) {
        if (_manifest && _manifest.archives && _manifest.archives[desc.name]) {
            var m = _manifest.archives[desc.name];
            return {
                name: desc.name,
                folder: typeof m.folder === 'string' ? m.folder : desc.folder,
                count: m.count || desc.count,
                pad: typeof m.pad === 'number' ? m.pad : desc.pad,
                parts: Array.isArray(m.parts) ? m.parts : []
            };
        }
        return desc;
    }

    // ---- VFS population -------------------------------------------------------
    function combinePieces(pieces) {
        var total = 0;
        for (var i = 0; i < pieces.length; i++) total += pieces[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < pieces.length; j++) {
            out.set(pieces[j], off);
            off += pieces[j].length;
        }
        return out;
    }

    // Stream an archive through fflate.Unzip, feeding each downloaded part in
    // order. This avoids concatenating all parts into one ~1.6 GB buffer and
    // building a full decompressed `files` object: each file is committed to the
    // VFS as soon as it's extracted, so peak memory (and GC pauses) stay far
    // lower than the one-shot fflate.unzip path.
    function addZipFilesPieces(pieces, label) {
        return new Promise(function(resolve, reject) {
            var pending = 0;
            var finished = false;
            var count = 0;
            var firstError = null;
            function maybeDone() {
                if (!finished || pending > 0) return;
                if (firstError) {
                    reject(new Error('Could not unzip ' + label + ': ' + (firstError.message || firstError)));
                } else {
                    console.log('ZipLoader: extracted ' + count + ' files from ' + label);
                    resolve(count);
                }
            }
            var unzipper = new fflate.Unzip(function(file) {
                if (!file.name || /\/$/.test(file.name)) {
                    // Directory entry: consume it so the decoder advances, but
                    // store nothing.
                    file.ondata = function() {};
                    file.start();
                    return;
                }
                pending++;
                var normalized = normalizePath(file.name);
                var chunks = [];
                var total = 0;
                var done = false;
                file.ondata = function(err, data, final) {
                    if (done) return;
                    if (err && !firstError) firstError = err;
                    if (data && data.length && !firstError) {
                        chunks.push(data);
                        total += data.length;
                    }
                    if (final || err) {
                        done = true;
                        if (!firstError) {
                            var out = new Uint8Array(total);
                            var off = 0;
                            for (var i = 0; i < chunks.length; i++) {
                                out.set(chunks[i], off);
                                off += chunks[i].length;
                            }
                            _vfs[normalized] = out;
                            // Same decoded/case-folded key as bytesFor() so
                            // encoded names resolve identically.
                            _vfsInsensitive[lookupPath(normalized).insensitive] = normalized;
                            count++;
                        }
                        pending--;
                        maybeDone();
                    }
                };
                file.start();
            });
            // fflate.Unzip only pre-registers the STORED decoder; register the
            // DEFLATE decoder too (sync for small entries, worker for large).
            unzipper.register(fflate.AsyncUnzipInflate);
            try {
                for (var i = 0; i < pieces.length; i++) unzipper.push(pieces[i], false);
                unzipper.push(new Uint8Array(0), true);
            } catch (e) {
                if (!firstError) firstError = e;
            }
            finished = true;
            maybeDone();
        });
    }

    function addZipFiles(bytes, label) {
        return addZipFilesPieces([bytes], label);
    }

    // ---- lazy media extraction -----------------------------------------------
    // Reads a byte range from a (disk-backed) archive Blob without ever
    // materialising the whole archive in memory.
    function blobRange(blob, start, length) {
        start = Math.max(0, Number(start) || 0);
        length = Math.max(0, Number(length) || 0);

        // Native Blob (the expected, common case).
        if (blob && typeof blob.slice === 'function' && typeof blob.arrayBuffer === 'function') {
            return blob.slice(start, start + length).arrayBuffer().then(function(ab) {
                return new Uint8Array(ab);
            });
        }

        // ArrayBuffer.
        if (blob instanceof ArrayBuffer) {
            var abLen = Math.min(length, Math.max(0, blob.byteLength - start));
            return Promise.resolve(new Uint8Array(blob, start, abLen));
        }

        // Uint8Array (or other typed array / view).
        if (ArrayBuffer.isView(blob)) {
            var bytes = (blob instanceof Uint8Array)
                ? blob
                : new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
            var end = Math.min(bytes.byteLength, start + length);
            return Promise.resolve(bytes.slice(start, end));
        }

        return Promise.reject(new TypeError(
            'ZipLoader: blobRange received unsupported value: ' +
            Object.prototype.toString.call(blob)
        ));
    }

    function readU16(bytes, off) {
        return bytes[off] | (bytes[off + 1] << 8);
    }

    function readU32(bytes, off) {
        return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    }

    function isMediaPath(path) {
        return path.indexOf('img/') === 0 || path.indexOf('audio/') === 0;
    }

    // Parse the zip End Of Central Directory + central directory held in a Blob.
    // Only the archive tail and the central directory bytes are read; entry
    // payloads stay compressed inside the archive for on-demand extraction.
    // Read [offset, offset+length) of a *logical* (unsplit) archive without
    // ever touching more of it than that range requires. Resolves which of
    // the on-disk parts overlap the range, fetches only those (through the
    // shared LRU part cache), and slices the exact bytes out of them.
    function readArchiveRange(archive, desc, offset, length) {
        var partIndices = mediaPartsToFetch(archive, offset, offset + length);
        return fetchMediaParts(archive, partIndices, desc).then(function(parts) {
            var blob = assembleBlobFromParts(parts, _mediaPartMap[archive], partIndices);
            var localStart = offset - _mediaPartMap[archive][partIndices[0]].start;
            return blobRange(blob, localStart, length);
        });
    }

    // Build the per-file index for a media archive (img_repk.zip /
    // audio_repk.zip) by reading only its End-Of-Central-Directory record and
    // central directory — both of which live in the last part or two — via
    // readArchiveRange(). This never downloads, combines, or caches the whole
    // archive: total network traffic for indexing a multi-hundred-MB archive
    // is typically a couple of small parts (a few MB), not the archive itself.
    // Actual file bytes are fetched later, per request, by readMediaBytes().
    async function buildMediaIndexLazy(desc, label, channel) {
        var expected = await ensureMeta(desc);
        if (!expected || !expected.totalSize) {
            throw new Error('Could not determine the size of ' + label + '; cannot build a lazy index.');
        }

        // Building an accurate offset map requires each part's real byte
        // size. Manifests commonly record only count/pad/totalSize (uniform
        // part sizing) rather than a full per-part size list, in which case
        // desc.parts/expected.parts come back empty — treating that as "zero
        // bytes per part" (as opposed to "unknown, go find out") silently
        // produces a broken map, since every offset then falls outside every
        // part's [0,0) range. Fall back to HEAD requests (headers only, no
        // bodies — cheap even for 100+ parts) whenever real sizes aren't
        // already in hand.
        var partSizes = (desc.parts && desc.parts.length) ? desc.parts
            : (expected.parts && expected.parts.length) ? expected.parts
            : null;
        if (!partSizes) {
            var headed = await headMeta(desc);
            if (!headed || !headed.parts || !headed.parts.length) {
                throw new Error('Could not determine part sizes for ' + label + '.');
            }
            partSizes = headed.parts;
            if (!expected.totalSize) expected.totalSize = headed.totalSize;
        }

        var descWithSizes = {
            name: desc.name,
            folder: desc.folder,
            count: desc.count,
            pad: desc.pad,
            parts: partSizes
        };
        _mediaPartMap[desc.name] = buildMediaPartMap(descWithSizes);

        var total = expected.totalSize;
        var tailLen = Math.min(65557, total);
        progressChannel(channel, 10, label + ' locating index...');
        var tail = await readArchiveRange(desc.name, descWithSizes, total - tailLen, tailLen);
        var eocd = -1;
        for (var i = tail.length - 4; i >= 0; i--) {
            if (readU32(tail, i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('zip EOCD not found in ' + label);
        var count = readU16(tail, eocd + 10);
        var cdSize = readU32(tail, eocd + 12);
        var cdOff = readU32(tail, eocd + 16);
        progressChannel(channel, 40, label + ' reading directory...');
        var cd = await readArchiveRange(desc.name, descWithSizes, cdOff, cdSize);
        var decoder = new TextDecoder('utf-8');
        var off = 0;
        var added = 0;
        for (var n = 0; n < count; n++) {
            if (off + 46 > cd.length) break;
            if (readU32(cd, off) !== 0x02014b50) break;
            var method = readU16(cd, off + 10);
            var csize = readU32(cd, off + 20);
            var usize = readU32(cd, off + 24);
            var nameLen = readU16(cd, off + 28);
            var extraLen = readU16(cd, off + 30);
            var commentLen = readU16(cd, off + 32);
            var lhOff = readU32(cd, off + 42);
            var entryName = decoder.decode(cd.subarray(off + 46, off + 46 + nameLen));
            off += 46 + nameLen + extraLen + commentLen;
            var normalized = normalizePath(entryName);
            if (!normalized || /\/$/.test(normalized)) continue;
            _mediaFiles[normalized] = {
                archive: desc.name,
                lhOff: lhOff,
                csize: csize,
                usize: usize,
                method: method
            };
            _mediaInsensitive[lookupPath(normalized).insensitive] = normalized;
            added++;
        }
        // Deliberately NOT setting _mediaBlobs[desc.name] here: leaving it
        // unset means readMediaBytes() always takes the on-demand per-file
        // path below, which fetches only the 1-2 parts that actually contain
        // a requested file.
        progressChannel(channel, 100, label + ' ready (' + added + ' files indexed)');
        console.log('ZipLoader: indexed ' + added + ' files from ' + label +
            ' without downloading the archive (~' +
            ((tailLen + cdSize) / 1024).toFixed(0) + ' KB fetched for the index)');
        return added;
    }

    function parseLocalHeader(lh, archive) {
        if (lh.length < 30 || readU32(lh, 0) !== 0x04034b50) {
            throw new Error('bad zip local header in ' + archive);
        }
        var nameLen = readU16(lh, 26);
        var extraLen = readU16(lh, 28);
        var method = readU16(lh, 8);
        var csize = readU32(lh, 18);
        var usize = readU32(lh, 22);
        return { nameLen: nameLen, extraLen: extraLen, method: method, csize: csize, usize: usize };
    }

    function readLocalHeaderFromParts(parts, partMap, archive, lhOff) {
        var firstIdx = archivePartForOffset(archive, lhOff);
        var part = parts[firstIdx];
        if (!part) throw new Error('media part not available: ' + archive + ' part ' + (firstIdx + 1));
        var localBlobStart = partMap[firstIdx].start;
        var sliceStart = lhOff - localBlobStart;
        var sliceLen = Math.min(30, part.size - sliceStart);
        if (sliceLen < 30) throw new Error('local header crosses part boundary in ' + archive);
        return blobRange(part, sliceStart, sliceLen).then(function(lh) {
            return parseLocalHeader(lh, archive);
        });
    }
    function mediaEntryFor(path) {
        var insensitive = lookupPath(path).insensitive;
        var normalized = _mediaInsensitive[insensitive];
        return normalized ? (_mediaFiles[normalized] || null) : null;
    }

    // ---- byte-range maps (img_repkmap.txt / audio_repkmap.txt) ---------------
    // Precomputed maps of every file's exact byte location inside the split
    // part archives (generated offline by tools/build_media_maps.js and pasted
    // next to index.html). With a map in hand, no boot-time zip indexing is
    // needed at all, and each file's bytes arrive via one or two tiny HTTP
    // Range requests straight out of the parts that contain them — micro-range
    // loads measured in KB instead of whole ~9 MB part downloads.
    var RANGE_MAP_FILES = {
        'img_repk.zip': 'img_repkmap.txt',
        'audio_repk.zip': 'audio_repkmap.txt'
    };
    var RANGE_MAP_FOLDERS = {
        'img_repk.zip': 'img_pack',
        'audio_repk.zip': 'aud_pack'
    };
    var _rangeMaps = Object.create(null);
    var _rangeMapsPromise = null;

    function mapUrl(name) {
        // repk maps ship locally alongside the media packs.
        return name;
    }

    function parseMediaMap(text) {
        var map = { parts: [], files: [], byLhOff: new Map() };
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r$/, '');
            if (!line || line.charAt(0) === '#') {
                if (line.indexOf('#PART ') === 0) {
                    var seg = line.split(' ');
                    var start = Number(seg[2]), size = Number(seg[3]);
                    if (isFinite(start) && isFinite(size)) {
                        map.parts[Number(seg[1])] = { index: Number(seg[1]), start: start, size: size, end: start + size, name: seg[4] };
                    }
                }
                continue;
            }
            var f = line.split('|');
            if (f.length < 8) continue;
            var entry = {
                name: f[0],
                method: Number(f[1]),
                csize: Number(f[2]),
                usize: Number(f[3]),
                lhOff: Number(f[4]),
                dataOff: Number(f[5]),
                dataEnd: Number(f[6])
            };
            // The map's last column is the file's part span ("5-5", "8-9").
            // Knowing it up front lets a prefetch plan group files by the part
            // they live in without scanning the whole part table per file.
            var span = String(f[7] || '').split('-');
            if (span.length === 2 && isFinite(Number(span[0])) && isFinite(Number(span[1]))) {
                entry.partFirst = Number(span[0]);
                entry.partLast = Number(span[1]);
            }
            if (!isFinite(entry.lhOff) || !isFinite(entry.dataOff)) continue;
            map.files.push(entry);
            map.byLhOff.set(entry.lhOff, entry);
        }
        return map;
    }

    function ensureRangeMaps() {
        if (_rangeMapsPromise) return _rangeMapsPromise;
        _rangeMapsPromise = Promise.all(Object.keys(RANGE_MAP_FILES).map(function(archive) {
            return fetchWithTimeout(mapUrl(RANGE_MAP_FILES[archive]))
                .then(function(response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.text();
                })
                .then(function(text) {
                    _rangeMaps[archive] = parseMediaMap(text);
                    console.log('ZipLoader: range map loaded — ' + _rangeMaps[archive].files.length +
                        ' files from ' + RANGE_MAP_FILES[archive]);
                })
                .catch(function(error) {
                    console.warn('ZipLoader: range map unavailable (' + RANGE_MAP_FILES[archive] + '): ' +
                        error.message + ' — falling back to network zip indexing');
                });
        }));
        return _rangeMapsPromise;
    }

    // ---- range support detection --------------------------------------------
    // Whether the host honours HTTP Range requests decides the unit of work for
    // every media read. Hosts that do (plain static hosting, GitHub Pages,
    // Tauri's omori:// protocol) can serve a single file out of a part with a
    // few KB of traffic. Hosts that do not (WebSim's CDN answers 200 with the
    // whole body) silently turn every per-file "range" read into a full ~9 MB
    // part download, so there the only sane unit of work is the part itself:
    // fetch each part once, then slice every requested file out of it locally.
    //
    // One probe decides this for the session. It is a 16-byte Range request for
    // the first image part; when the host ignores it we keep the whole body as
    // the cached part (we need that part anyway) instead of throwing it away.
    var _rangeMode = null; // null = unknown, 'range' = honoured, 'part' = ignored
    var _rangeModePromise = null;

    function detectRangeMode() {
        if (_rangeModePromise) return _rangeModePromise;
        _rangeModePromise = ensureRangeMaps().then(function() {
            if (_isTauri) { _rangeMode = 'range'; return _rangeMode; }
            var archive = 'img_repk.zip';
            var map = _rangeMaps[archive];
            var part = (map && map.parts.length) ? map.parts[0] : null;
            if (!part) { _rangeMode = 'range'; return _rangeMode; }
            var folder = archiveFolderUrl({ name: archive, folder: RANGE_MAP_FOLDERS[archive] });
            var url = folder ? folder + '/' + part.name : part.name;
            return fetchWithTimeout(url, { headers: { Range: 'bytes=0-15' } }).then(function(response) {
                if (response.status === 206 || response.status === 416) {
                    _rangeMode = 'range';
                    console.log('ZipLoader: host honours Range requests — media reads stay per-file');
                    return _rangeMode;
                }
                _rangeMode = 'part';
                console.log('ZipLoader: host ignored HTTP Range (HTTP ' + response.status + ' for a 16-byte range) — ' +
                    'switching to part-level batching: each part is fetched once and files are sliced out of it locally');
                return withTimeout(response.blob(), FETCH_TIMEOUT_MS, 'ZipLoader: body read stalled for ' + url)
                    .then(normalizeMediaBlob)
                    .then(function(blob) {
                        touchPartCache(archive, part.index, blob);
                        console.log('ZipLoader: kept the probe response as a cached part (' +
                            (blob.size / 1048576).toFixed(1) + ' MB)');
                        return _rangeMode;
                    }, function() { return _rangeMode; });
            }, function(error) {
                // A failed probe must not change behaviour: fall back to ranges.
                console.warn('ZipLoader: range probe failed (' + (error && error.message) + '); using per-file ranges');
                _rangeMode = 'range';
                return _rangeMode;
            });
        });
        return _rangeModePromise;
    }

    // Populate _mediaFiles straight from a range map, skipping
    // buildMediaIndexLazy's EOCD + central-directory network reads entirely.
    // Returns true when the archive was indexed from its map.
    function populateMediaIndexFromMap(archive) {
        var map = _rangeMaps[archive];
        if (!map || !map.files.length) return false;
        var added = 0;
        for (var i = 0; i < map.files.length; i++) {
            var f = map.files[i];
            var normalized = normalizePath(f.name);
            if (!normalized || /\/$/.test(normalized)) continue;
            _mediaFiles[normalized] = {
                archive: archive,
                lhOff: f.lhOff,
                csize: f.csize,
                usize: f.usize,
                method: f.method
            };
            _mediaInsensitive[lookupPath(normalized).insensitive] = normalized;
            added++;
        }
        console.log('ZipLoader: indexed ' + added + ' files from ' + archive + ' via range map (zero zip reads)');
        return added > 0;
    }

    // Fetch exactly [lo, hi] (part-local, inclusive) of one part via HTTP
    // Range. Servers that ignore Range answer 200 with the whole body; those
    // bytes are then cached as the full part (identical to the legacy path)
    // and sliced down to the wanted window.
    function fetchByteRangeSegment(archive, part, url, lo, hi) {
        return fetchWithTimeout(url, { headers: { Range: 'bytes=' + lo + '-' + hi } }).then(function(response) {
            if (response.status === 200) {
                // The host ignored the Range header and answered 200 with the
                // whole part. Those bytes *are* the part, so keep them and slice
                // the wanted window out locally. The old code dropped this body
                // and re-fetched the same part through fetchBlob(), doubling the
                // transfer for every file read — with 150+ media reads during a
                // boot that was the multi-minute stall on WebSim.
                _rangeMode = 'part';
                return withTimeout(response.blob(), FETCH_TIMEOUT_MS, 'ZipLoader: body read stalled for ' + url)
                    .then(normalizeMediaBlob)
                    .then(function(blob) {
                        touchPartCache(archive, part.index, blob);
                        return blobRange(blob, lo, hi - lo + 1);
                    });
            }
            if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
            if (_rangeMode === null) _rangeMode = 'range';
            return withTimeout(response.arrayBuffer(), FETCH_TIMEOUT_MS, 'ZipLoader: range read stalled for ' + url)
                .then(function(buffer) { return new Uint8Array(buffer); });
        });
    }

    // Which parts of a split archive hold a file's compressed bytes. The range
    // map records this directly (the "partFirst-partLast" column); older maps
    // without it fall back to scanning the part table.
    function partsForEntry(rangeMap, meta) {
        var out = [];
        if (isFinite(meta.partFirst) && isFinite(meta.partLast)) {
            for (var i = meta.partFirst; i <= meta.partLast; i++) out.push(i);
            return out;
        }
        for (var j = 0; j < rangeMap.parts.length; j++) {
            var part = rangeMap.parts[j];
            if (part && part.start < meta.dataEnd && part.end > meta.dataOff) out.push(j);
        }
        return out;
    }

    // Concatenate the compressed slices of a file and undo its zip entry's
    // compression (stored entries come back as-is, deflated ones get inflated).
    function finishMediaChunks(meta, chunks) {
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var compressed = new Uint8Array(total);
        var at = 0;
        for (i = 0; i < chunks.length; i++) { compressed.set(chunks[i], at); at += chunks[i].length; }
        if (meta.method === 0) return compressed;
        if (meta.method === 8) {
            var out = new Uint8Array(meta.usize);
            window.fflate.inflateSync(compressed, { out: out });
            return out;
        }
        throw new Error('unsupported zip compression method ' + meta.method + ' for ' + meta.name);
    }

    // Fetch a whole media part at most once per session and hand back its cached
    // Blob. In-flight fetches are shared, so N files that live in the same part
    // cost exactly one download between them instead of N.
    function partBytesFor(archive, part, folder) {
        var bucket = _mediaPartCache[archive];
        if (bucket && bucket[part.index]) {
            touchPartCache(archive, part.index, bucket[part.index]);
            return Promise.resolve(bucket[part.index]);
        }
        var key = partCacheKey(archive, part.index);
        if (_partFetchPromises[key]) return _partFetchPromises[key];
        if (folder === undefined) {
            folder = archiveFolderUrl({ name: archive, folder: RANGE_MAP_FOLDERS[archive] });
        }
        var url = folder ? folder + '/' + part.name : part.name;
        var promise = fetchBlob(url, 0, 100, 'media ' + archive + ' part ' + (part.index + 1), 'media')
            .then(function(blob) {
                delete _partFetchPromises[key];
                touchPartCache(archive, part.index, blob);
                return blob;
            }, function(error) {
                delete _partFetchPromises[key];
                throw error;
            });
        _partFetchPromises[key] = promise;
        return promise;
    }

    // Slice one file's window out of a part: from the LRU cache when the part is
    // resident, otherwise over the wire (Range request, whole-part fallback).
    function sliceSegment(archive, part, folder, lo, length) {
        var bucket = _mediaPartCache[archive];
        if (bucket && bucket[part.index]) {
            var cached = bucket[part.index];
            touchPartCache(archive, part.index, cached);
            return blobRange(cached, lo, length);
        }
        var url = folder ? folder + '/' + part.name : part.name;
        return fetchByteRangeSegment(archive, part, url, lo, lo + length - 1);
    }

    // The [lo, hi) window of a part that a given file occupies, or null when the
    // file does not use this part. `wholePart` selects the WebSim strategy: pull
    // the entire part once (shared via the cache) and slice locally, instead of
    // asking for the window and paying for the whole part anyway.
    function entrySegment(archive, part, folder, meta, wholePart) {
        var lo = Math.max(part.start, meta.dataOff) - part.start;
        var hi = Math.min(part.end, meta.dataEnd) - part.start; // exclusive
        if (hi <= lo) return null;
        if (!wholePart) return sliceSegment(archive, part, folder, lo, hi - lo);
        return partBytesFor(archive, part, folder).then(function(blob) {
            return blobRange(blob, lo, hi - lo);
        });
    }

    function readEntryChunks(rangeMap, entry, wholePart) {
        var meta = rangeMap.byLhOff.get(entry.lhOff);
        if (!meta) return Promise.reject(new Error('range map missing entry for lhOff ' + entry.lhOff + ' in ' + entry.archive));
        var folder = archiveFolderUrl({ name: entry.archive, folder: RANGE_MAP_FOLDERS[entry.archive] });
        var indices = partsForEntry(rangeMap, meta);
        var segments = [];
        for (var i = 0; i < indices.length; i++) {
            var part = rangeMap.parts[indices[i]];
            if (!part) continue;
            var segment = entrySegment(entry.archive, part, folder, meta, wholePart);
            if (segment) segments.push(segment);
        }
        if (!segments.length) return Promise.reject(new Error('no parts overlap ' + meta.name));
        return Promise.all(segments).then(function(chunks) { return finishMediaChunks(meta, chunks); });
    }

    // Whole-part materialisation of one media file: every part it needs is
    // fetched once (and shared with every other file in that part), then the
    // file's bytes are sliced out of the parts.
    function readEntryFromParts(rangeMap, entry) {
        return readEntryChunks(rangeMap, entry, true);
    }

    // Range-map reads go through whichever unit of work the host actually
    // honours: per-file byte ranges when Range works, whole parts when it does
    // not (detectRangeMode() decides once, up front).
    function readMediaBytesViaRangeMap(rangeMap, entry) {
        return detectRangeMode().then(function(mode) {
            return mode === 'part' ? readEntryFromParts(rangeMap, entry) : readMediaBytesMicroRange(rangeMap, entry);
        });
    }

    // Micro-range materialisation of one media file: 1-2 small Range requests
    // covering only the bytes the file actually occupies, instead of whole
    // 9 MB part downloads. Stored entries (method 0) come back ready to serve;
    // deflated ones (method 8) get a cheap inflateSync. Parts already resident
    // in the LRU cache are sliced locally rather than re-requested.
    function readMediaBytesMicroRange(rangeMap, entry) {
        return readEntryChunks(rangeMap, entry, false);
    }

    // Materialise a single media file: read its local header to find the data
    // offset, slice only that entry's compressed bytes out of the archive, then
    // inflate them. Nothing else from the archive is touched.
    function readMediaBytes(entry) {
        var blob = _mediaBlobs[entry.archive];
        if (blob) return readMediaBytesFromBlob(blob, entry);
        return readMediaBytesOnDemand(entry);
    }

    function readMediaBytesFromBlob(blob, entry) {
        return blobRange(blob, entry.lhOff, 30).then(function(lh) {
            if (readU32(lh, 0) !== 0x04034b50) throw new Error('bad zip local header in ' + entry.archive);
            var nameLen = readU16(lh, 26);
            var extraLen = readU16(lh, 28);
            var dataStart = entry.lhOff + 30 + nameLen + extraLen;
            return blobRange(blob, dataStart, entry.csize).then(function(compressed) {
                if (entry.method === 0) return compressed;
                if (entry.method === 8) {
                    var out = new Uint8Array(entry.usize);
                    return window.fflate.inflateSync(compressed, { out: out });
                }
                throw new Error('unsupported zip compression method ' + entry.method + ' in ' + entry.archive);
            });
        });
    }

    function readMediaBytesOnDemand(entry) {
        var archive = entry.archive;
        // Preferred path: exact byte ranges out of the part archives via the
        // precomputed map (skips whole-part downloads entirely). Falls through
        // to the legacy part-assembly path when no map/entry is available or
        // on the native build (whose omori:// transport has no Range support).
        var rangeMap = _rangeMaps[archive];
        if (rangeMap && !_isTauri && rangeMap.byLhOff.get(entry.lhOff)) {
            return readMediaBytesViaRangeMap(rangeMap, entry);
        }
        if (!_manifest || !_manifest.archives || !_manifest.archives[archive]) {
            return Promise.reject(new Error('media archive not available: ' + archive));
        }
        var m = _manifest.archives[archive];
        var desc = {
            name: archive,
            folder: m.folder || '',
            count: m.count || 0,
            pad: m.pad || 0,
            parts: m.parts || []
        };
        if (!_mediaPartMap[archive]) _mediaPartMap[archive] = buildMediaPartMap(desc);
        var entryEnd = entry.lhOff + 30 + entry.csize;
        var partIndices = mediaPartsToFetch(archive, entry.lhOff, entryEnd);
        return fetchMediaParts(archive, partIndices, desc).then(function(parts) {
            var blob = assembleBlobFromParts(parts, _mediaPartMap[archive], partIndices);
            prefetchNextPart(archive, desc, partIndices[partIndices.length - 1]);
            // entry.lhOff/csize are absolute offsets into the *logical* (unsplit)
            // archive, but `blob` here only contains the fetched parts starting at
            // partIndices[0]. Rebase lhOff to be local to that assembled blob —
            // the same adjustment readArchiveRange() already makes — otherwise any
            // entry that doesn't live in the very first part reads garbage and
            // fails the local-header magic-number check.
            var localBase = _mediaPartMap[archive][partIndices[0]].start;
            var localEntry = (localBase === 0) ? entry : Object.assign({}, entry, {
                lhOff: entry.lhOff - localBase
            });
            return readMediaBytesFromBlob(blob, localEntry);
        });
    }

    function lookupPath(path) {
        var normalized = normalizePath(path);
        var decoded = normalized;
        try {
            decoded = decodeURIComponent(normalized);
        } catch (e) {
            // Keep the original normalized path if a malformed escape is used.
        }
        return {
            exact: normalized,
            insensitive: decoded.toLowerCase()
        };
    }

    function bytesFor(path) {
        var lookup = lookupPath(path);
        var exact = _vfs[lookup.exact];
        if (exact) return exact;
        var archivedPath = _vfsInsensitive[lookup.insensitive];
        return archivedPath ? (_vfs[archivedPath] || null) : null;
    }

    function textFor(path) {
        var bytes = bytesFor(path);
        if (!bytes) return null;
        return new TextDecoder('utf-8').decode(bytes);
    }

    function blobUrlFor(path) {
        path = normalizePath(path);
        if (_blobUrls[path]) return Promise.resolve(_blobUrls[path]);
        return ensureArchiveForPath(path).then(function() {
            var bytes = bytesFor(path);
            if (bytes) {
                _blobUrls[path] = URL.createObjectURL(new Blob([bytes], { type: mimeType(path) }));
                return _blobUrls[path];
            }
            if (isMediaPath(path)) {
                var entry = mediaEntryFor(path);
                if (entry) {
                    return readMediaBytes(entry).then(function(mediaBytes) {
                        _blobUrls[path] = URL.createObjectURL(new Blob([mediaBytes], { type: mimeType(path) }));
                        return _blobUrls[path];
                    });
                }
            }
            throw new Error('VFS file not found: ' + path);
        });
    }

    // ---- writable VFS (modding) ---------------------------------------------
    // Mods overlay the read-only archive contents by writing (or overwriting)
    // files here before the game boots. Writes are resolved case-insensitively
    // like reads: if a base archive file already occupies the same
    // case-insensitive path, the base entry is overwritten in place so the
    // game's exact-case lookups (data/Map168.json, img/...) keep hitting the
    // modded bytes instead of the stale base copy.

    function invalidateBlobUrl(path) {
        var insensitive = lookupPath(path).insensitive;
        Object.keys(_blobUrls).forEach(function(key) {
            if (key === path || lookupPath(key).insensitive === insensitive) {
                try { URL.revokeObjectURL(_blobUrls[key]); } catch (e) {}
                delete _blobUrls[key];
            }
        });
    }

    function putFile(path, bytes) {
        var normalized = normalizePath(path);
        var lookup = lookupPath(normalized);
        var existing = _vfsInsensitive[lookup.insensitive];
        var key;
        if (existing && _vfs[existing] !== undefined && _vfs[existing] !== null) {
            key = existing;
        } else {
            key = normalized;
            _vfsInsensitive[lookup.insensitive] = normalized;
        }
        _vfs[key] = bytes;
        invalidateBlobUrl(key);
        return true;
    }

    function putText(path, text) {
        return putFile(path, new TextEncoder().encode(String(text == null ? '' : text)));
    }

    function removeFile(path) {
        var normalized = normalizePath(path);
        var lookup = lookupPath(normalized);
        var existing = _vfsInsensitive[lookup.insensitive];
        if (existing) {
            delete _vfs[existing];
            delete _vfsInsensitive[lookup.insensitive];
            invalidateBlobUrl(existing);
        }
        delete _vfs[normalized];
        // A mod can also mask a base archive file that lives only in the lazy
        // media index (img/ + audio/); dropping it there makes removeFile() a
        // real removal rather than a no-op that still resolves the base bytes.
        var mediaNormalized = _mediaInsensitive[lookup.insensitive];
        if (mediaNormalized) {
            delete _mediaFiles[mediaNormalized];
            delete _mediaInsensitive[lookup.insensitive];
        }
        invalidateBlobUrl(normalized);
        return true;
    }

    function hasFile(path) {
        if (bytesFor(path) != null) return true;
        if (isMediaPath(normalizePath(path))) return !!mediaEntryFor(path);
        return false;
    }

    function listFiles(prefix) {
        var seen = Object.create(null);
        var out = [];
        var keys = Object.keys(_vfs).concat(Object.keys(_mediaFiles));
        for (var i = 0; i < keys.length; i++) {
            if (seen[keys[i]]) continue;
            seen[keys[i]] = true;
            out.push(keys[i]);
        }
        if (prefix) {
            var p = normalizePath(prefix).toLowerCase();
            out = out.filter(function(name) { return name.toLowerCase().indexOf(p) === 0; });
        }
        return out.sort();
    }

    // ---- download / cache orchestration --------------------------------------
    function downloadArchive(desc, start, span, label, expected, channel) {
        var folder = archiveFolderUrl(desc);
        var items = [];
        for (var i = 0; i < desc.count; i++) {
            var suffix = desc.pad ? String(i + 1).padStart(desc.pad, '0') : '';
            var fileName = desc.name + (desc.pad ? '.part' + suffix : '');
            items.push({
                url: folder ? folder + '/' + fileName : fileName,
                start: start + span * (i / desc.count),
                span: span / desc.count,
                label: label + ' part ' + (i + 1) + '/' + desc.count,
                channel: channel
            });
        }
        var t0 = performance.now();
        return fetchQueue(items).then(function(pieces) {
            // Sanity-check downloaded sizes against the expected metadata, but
            // never fail boot over it: embedded/bundled assets are served from
            // whatever the binary actually contains, so use those bytes and only
            // warn when the manifest's declared sizes are stale.
            if (expected && expected.parts && expected.parts.length === pieces.length) {
                for (var j = 0; j < pieces.length; j++) {
                    if (expected.parts[j].size && pieces[j].length !== expected.parts[j].size) {
                        console.warn('ZipLoader: ' + label + ' part ' + (j + 1) + ' size differs from manifest (' +
                            pieces[j].length + ' != ' + expected.parts[j].size + '); using the fetched bytes.');
                    }
                }
            }
            var total = 0;
            pieces.forEach(function(p) { total += p.length; });
            console.log('ZipLoader: [' + label + '] downloaded ' + (total / 1048576).toFixed(1) +
                ' MB in ' + (performance.now() - t0).toFixed(0) + ' ms');
            // Stream the parts straight into the unzip decoder (no full
            // concatenation). A combined buffer is only assembled for the
            // IndexedDB cache, which the native build never uses.
            return addZipFilesPieces(pieces, label).then(function() {
                progressChannel(channel, start + span, label + ' ready');
                if (_cacheEnabled) {
                    cachePutArchive(desc.name, combinePieces(pieces));
                    if (expected) cachePutMeta(desc.name, expected);
                }
                return true;
            });
        });
    }

    function loadArchiveCached(desc, start, span, label, channel) {
        return ensureMeta(desc).then(function(expected) {
            if (!_cacheEnabled || !expected) {
                return downloadArchive(desc, start, span, label, expected, channel);
            }
            var t0 = performance.now();
            return cacheGetMeta(desc.name).then(function(cached) {
                if (cached && cached.version === expected.version &&
                    cached.totalSize === expected.totalSize) {
                    return cacheGetArchive(desc.name).then(function(bytes) {
                        if (bytes) {
                            console.log('ZipLoader: [' + label + '] cache hit (' +
                                (bytes.length / 1048576).toFixed(1) + ' MB, v' + expected.version +
                                ', read in ' + (performance.now() - t0).toFixed(0) + ' ms)');
                            progressChannel(channel, start + span * 0.9, label + ' from cache...');
                            return addZipFiles(bytes, label + ' (cache)').then(function() {
                                progressChannel(channel, start + span, label + ' ready (cache)');
                                return true;
                            });
                        }
                        return downloadArchive(desc, start, span, label, expected, channel);
                    });
                }
                return downloadArchive(desc, start, span, label, expected, channel);
            });
        });
    }

    // Media archives (img_repk/audio_repk) are never decompressed into _vfs.
    // Download the parts, assemble them into a single disk-backed Blob (the
    // split parts form one zip), persist that Blob, then build the lazy
    // per-file index. Peak RAM is bounded by the compressed parts rather than
    // the full uncompressed image/audio payload.
    function buildMediaPartMap(desc) {
        // Compute byte-range boundaries for each part of a split archive from its
        // manifest-declared part sizes. Parts are contiguous chunks of the zip
        // file (not file-aware), so we can locate which part(s) hold a given byte
        // offset (e.g. a file's local header) without having the full archive.
        var map = [];
        var offset = 0;
        var parts = desc.parts || [];
        var count = parts.length || desc.count || 0;
        for (var i = 0; i < count; i++) {
            var size = Number(parts[i] && parts[i].size) || 0;
            map.push({ start: offset, end: offset + size, index: i });
            offset += size;
        }
        return map;
    }

    function archivePartForOffset(archive, offset) {
        // Return the part index whose range contains `offset`, or the nearest
        // part if `offset` lands exactly on a boundary (belongs to the part that
        // starts there).
        var parts = _mediaPartMap[archive];
        if (!parts) return 0;
        for (var i = 0; i < parts.length; i++) {
            if (offset >= parts[i].start && offset < parts[i].end) return i;
        }
        return parts.length - 1;
    }

    function mediaPartsToFetch(archive, lhOff, entryEnd) {
        // Decide which part indices must be downloaded to read a media entry.
        // The local header (30 bytes + name + extra) lives at lhOff; the entry
        // data starts after the header and spans entry.csize bytes. Because parts
        // are contiguous byte ranges, up to two parts can be involved. We fetch
        // the minimal set so we never hold the whole archive in RAM.
        var first = archivePartForOffset(archive, lhOff);
        var last = archivePartForOffset(archive, entryEnd - 1);
        if (last < first) last = first;
        var out = [];
        for (var i = first; i <= last; i++) out.push(i);
        return out;
    }

    // ---- bounded LRU cache for individual (compressed) zip parts -------------
    function partCacheKey(archive, idx) { return archive + '\u0000' + idx; }

    function touchPartCache(archive, idx, blob) {
        var key = partCacheKey(archive, idx);
        if (!blob || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') {
            throw new TypeError(
                'ZipLoader: refusing to cache non-Blob media part ' + archive +
                ' part ' + (idx + 1) + ': ' + Object.prototype.toString.call(blob)
            );
        }
        if (!_mediaPartCache[archive]) _mediaPartCache[archive] = Object.create(null);
        if (_mediaPartCache[archive][idx]) {
            var pos = _partCacheOrder.indexOf(key);
            if (pos >= 0) _partCacheOrder.splice(pos, 1);
            _partCacheOrder.push(key);
            return;
        }
        _mediaPartCache[archive][idx] = blob;
        _partCacheBytes += blob.size;
        _partCacheOrder.push(key);
        evictPartCacheIfNeeded();
    }

    function evictPartCacheIfNeeded() {
        while (_partCacheBytes > PART_CACHE_MAX_BYTES && _partCacheOrder.length > 1) {
            var oldestKey = _partCacheOrder.shift();
            var sep = oldestKey.indexOf('\u0000');
            var archive = oldestKey.slice(0, sep);
            var idx = Number(oldestKey.slice(sep + 1));
            var bucket = _mediaPartCache[archive];
            var blob = bucket && bucket[idx];
            if (blob) {
                _partCacheBytes -= blob.size;
                delete bucket[idx];
            }
        }
    }

    function fetchMediaParts(archive, partIndices, desc) {
        var folder = archiveFolderUrl(desc);
        var items = [];
        for (var i = 0; i < partIndices.length; i++) {
            var idx = partIndices[i];
            var suffix = desc.pad ? String(idx + 1).padStart(desc.pad, '0') : '';
            var fileName = desc.name + (desc.pad ? '.part' + suffix : '');
            if (_mediaPartCache[archive] && _mediaPartCache[archive][idx]) {
                touchPartCache(archive, idx, _mediaPartCache[archive][idx]);
                items.push(Promise.resolve(_mediaPartCache[archive][idx]));
                continue;
            }
            items.push(fetchBlob(
                folder ? folder + '/' + fileName : fileName,
                0, 100 / partIndices.length,
                'media ' + archive + ' part ' + (idx + 1) + '/' + desc.count,
                'media'
            ).then(function(idx, archive, blob) {
                touchPartCache(archive, idx, blob);
                return blob;
            }.bind(null, idx, archive)));
        }
        return Promise.all(items);
    }

    // Warm exactly one part past what was just used, and only if we're not
    // already at the memory budget. Sequentially-packed archives often place
    // related assets (a battler and its shadow, a BGM and its loop tail) next
    // to each other, so this small, capped readahead helps the *next*
    // request land warm without ever pulling in more than one extra part.
    function prefetchNextPart(archive, desc, lastIdx) {
        var nextIdx = lastIdx + 1;
        if (nextIdx >= desc.count) return;
        if (_mediaPartCache[archive] && _mediaPartCache[archive][nextIdx]) return;
        if (_partCacheBytes >= PART_CACHE_MAX_BYTES) return;
        fetchMediaParts(archive, [nextIdx], desc).catch(function() {});
    }

    function assembleBlobFromParts(parts, partMap, indices) {
        // Reassemble only the requested parts into a Blob in the correct order
        // so that blobRange-style offsets (entry.lhOff, dataStart, etc.) work
        // against the assembled blob. Uses the partMap to determine the byte
        // offset of each part within the full archive.
        if (parts.length === 1) return parts[0];
        var buffers = [];
        for (var i = 0; i < parts.length; i++) {
            var idx = indices[i];
            var part = parts[i];
            var offset = 0;
            for (var j = 0; j < idx; j++) {
                offset += partMap[j].end - partMap[j].start;
            }
            buffers.push({ blob: part, offset: offset });
        }
        buffers.sort(function(a, b) { return a.offset - b.offset; });
        var sortedParts = buffers.map(function(b) { return b.blob; });
        return new Blob(sortedParts, { type: 'application/octet-stream' });
    }

    // NOTE: media archives (img_repk.zip / audio_repk.zip) are never
    // downloaded, combined, or cached as a whole anymore. See
    // buildMediaIndexLazy() above for indexing and readMediaBytesOnDemand()
    // below for per-file reads — both work purely in terms of the small
    // number of parts a given operation actually needs, bounded by the LRU
    // part cache (PART_CACHE_MAX_BYTES). The old downloadMediaArchive() /
    // loadMediaArchive() full-archive-Blob-then-IndexedDB path was the source
    // of the ~1 GB in-memory Blob + IndexedDB write that OOM'd low-memory
    // (especially mobile) browsers during boot; it has been removed rather
    // than gated off, so it can't get called by accident.

    // Native desktop: img/ and audio/ files are served lazily file-by-file
    // from the Rust backend (omori:// random access into the part archives), so
    // boot no longer downloads and unzips ~1.5 GB. data/maps/languages stay
    // eager (they're small and read synchronously). If a lazy fetch fails
    // (missing parts / older layout), fall back to downloading + indexing the
    // media archives like the web build.
    function ensureNativeFile(path) {
        var normalized = normalizePath(path);
        if (bytesFor(normalized)) return Promise.resolve(true);
        return _origFetch(ASSET_SCHEME + '://localhost/' + normalized).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + normalized);
            return response.arrayBuffer();
        }).then(function(buffer) {
            _vfs[normalized] = new Uint8Array(buffer);
            _vfsInsensitive[lookupPath(normalized).insensitive] = normalized;
            return true;
        });
    }

    function ensureArchiveForPath(path) {
        var normalized = normalizePath(path);
        if (_isTauri && (normalized.indexOf('img/') === 0 || normalized.indexOf('audio/') === 0)) {
            if (bytesFor(normalized)) return Promise.resolve(true);
            var isImage = normalized.indexOf('img/') === 0;
            return ensureNativeFile(normalized).catch(function() {
                return isImage ? loadImageMediaOnDemand() : loadAudioMedia();
            });
        }
        if (normalized.indexOf('img/') === 0) {
            // Image requests trigger on-demand loading of the archive. The full
            // archive is not downloaded at boot. We wait for the index to be built
            // before returning, so subsequent calls to mediaEntryFor() will find
            // the file.
            return loadImageMediaOnDemand();
        }
        return init();
    }

    // Materialise a single media file into _vfs so synchronous getFile()
    // consumers (mod image deltas) can read the bytes immediately. Media
    // bytes are fetched through the byte-range loader (micro-range requests
    // out of the split parts); non-media paths just wait on core boot.
    // Materialise decoded media bytes into the synchronous VFS, preserving the
    // case-insensitive lookup table the game's exact-case reads rely on.
    function putMediaBytes(path, bytes) {
        var normalized = normalizePath(path);
        _vfs[normalized] = bytes;
        _vfsInsensitive[lookupPath(normalized).insensitive] = normalized;
        return true;
    }

    function ensureMediaFile(path) {
        var normalized = normalizePath(path);
        if (isMediaPath(normalized)) {
            return ensureArchiveForPath(normalized).then(function() {
                if (bytesFor(normalized)) return true;
                var entry = mediaEntryFor(normalized);
                if (!entry) throw new Error('media file not found: ' + normalized);
                return readMediaBytes(entry).then(function(bytes) {
                    return putMediaBytes(normalized, bytes);
                });
            });
        }
        return init();
    }

    // Runs `worker` over `items` with at most `limit` in flight, preserving
    // result order. Worker failures become null results rather than rejections:
    // this drives prefetching, where one bad file must not sink the batch.
    function runLimited(items, limit, worker) {
        var results = new Array(items.length);
        var index = 0;
        var active = 0;
        return new Promise(function(resolve) {
            if (!items.length) { resolve(results); return; }
            function pump() {
                while (active < limit && index < items.length) {
                    (function(i) {
                        active++;
                        Promise.resolve().then(function() { return worker(items[i], i); }).then(function(value) {
                            results[i] = value;
                            active--;
                            pump();
                        }, function(error) {
                            results[i] = null;
                            console.warn('ZipLoader: prefetch task failed: ' + (error && error.message));
                            active--;
                            pump();
                        });
                    })(index++);
                }
                if (active === 0 && index >= items.length) resolve(results);
            }
            pump();
        });
    }

    // Boot-time batch materialisation of media files into the VFS.
    //
    // The batch is planned at *part* granularity, not file granularity: the
    // files are grouped by the parts that contain them, each part is fetched at
    // most once (bounded concurrency, shared in-flight fetches), and every file
    // is sliced out of the cached part bytes as soon as its parts are resident.
    //
    // That planning is what makes this viable on hosts that ignore Range
    // headers. On WebSim a per-file "range" read costs a whole ~9.4 MB part, so
    // the old file-by-file loop re-downloaded the same handful of parts over
    // and over — 152 delta targets pulled the image pack dozens of times for a
    // multi-minute stall before the game could boot. Planned by part, the same
    // batch costs one download per distinct part.
    function prefetchMedia(paths) {
        var seen = Object.create(null);
        var list = [];
        (Array.isArray(paths) ? paths : [paths]).forEach(function(path) {
            var normalized = normalizePath(path);
            if (!isMediaPath(normalized) || seen[normalized]) return;
            seen[normalized] = true;
            list.push(normalized);
        });
        if (!list.length) return Promise.resolve(0);

        // The media index for each archive must exist before paths can be
        // mapped to parts (image and audio indices are built independently).
        var hasImages = false;
        var hasAudio = false;
        list.forEach(function(path) {
            if (path.indexOf('img/') === 0) hasImages = true;
            else if (path.indexOf('audio/') === 0) hasAudio = true;
        });
        var indexing = [];
        if (hasImages) indexing.push(loadImageMediaOnDemand());
        if (hasAudio) indexing.push(loadAudioMedia());

        return Promise.all(indexing)
            .then(function() { return detectRangeMode(); })
            .then(function(mode) {
                return mode === 'part' ? prefetchByPart(list) : prefetchPerFile(list);
            });
    }

    // Range honoured: per-file reads are already cheap, so just bound them.
    function prefetchPerFile(list) {
        var t0 = performance.now();
        return runLimited(list, PREFETCH_FILE_CONCURRENCY, function(path) {
            return ensureMediaFile(path).then(function() { return true; }, function(error) {
                console.warn('ZipLoader: prefetch failed for ' + path + ': ' + (error && error.message));
                return false;
            });
        }).then(function(results) {
            var ok = results.filter(Boolean).length;
            console.log('ZipLoader: prefetch materialised ' + ok + '/' + list.length +
                ' file(s) (per-file ranges) in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
            return ok;
        });
    }

    // Range ignored (WebSim): plan by part. Fetch each distinct part once, and
    // materialise every file whose parts have all landed the moment the last of
    // them arrives — so a part can never be evicted between its download and
    // the files that need it being sliced out.
    function prefetchByPart(list) {
        var plan = [];      // { path, entry, map, meta, remaining }
        var partJobs = [];  // { archive, index, key }
        var seenPart = Object.create(null);
        var waiters = Object.create(null); // part key -> [plan items]
        var unmapped = [];

        list.forEach(function(path) {
            var entry = mediaEntryFor(path);
            var map = entry && _rangeMaps[entry.archive];
            var meta = map && map.byLhOff.get(entry.lhOff);
            if (!entry || !map || !meta) { unmapped.push(path); return; }
            var item = { path: path, entry: entry, map: map, meta: meta, remaining: 0 };
            plan.push(item);
            partsForEntry(map, meta).forEach(function(index) {
                var key = partCacheKey(entry.archive, index);
                item.remaining++;
                if (!waiters[key]) waiters[key] = [];
                waiters[key].push(item);
                if (seenPart[key]) return;
                seenPart[key] = true;
                partJobs.push({ archive: entry.archive, index: index, key: key });
            });
        });

        var partsLoaded = 0;
        var bytesLoaded = 0;
        var t0 = performance.now();
        if (partJobs.length) {
            console.log('ZipLoader: prefetch plan — ' + plan.length + ' file(s) across ' + partJobs.length +
                ' part(s) of ' + (unmapped.length ? (unmapped.length + ' unmapped file(s), ') : '') + 'part-batched reads');
        }

        var jobs = runLimited(partJobs, PREFETCH_PART_CONCURRENCY, function(job) {
            var map = _rangeMaps[job.archive];
            var part = map && map.parts[job.index];
            if (!part) return null;
            return partBytesFor(job.archive, part).then(function(blob) {
                partsLoaded++;
                bytesLoaded += blob.size;
                // Visible progress: on a Range-ignoring host this batch is the
                // whole transfer, so a silent multi-second gap looks like a hang.
                if (partsLoaded === partJobs.length || partsLoaded % 8 === 0) {
                    console.log('ZipLoader: prefetch progress ' + partsLoaded + '/' + partJobs.length +
                        ' part(s) (' + (bytesLoaded / 1048576).toFixed(1) + ' MB)');
                }
                // Every file whose parts are now all resident can be sliced out.
                var ready = waiters[job.key] || [];
                return Promise.all(ready.map(function(item) {
                    item.remaining--;
                    return item.remaining > 0 ? null : materialisePlanItem(item);
                }));
            }, function(error) {
                console.warn('ZipLoader: could not fetch ' + job.archive + ' part ' + (job.index + 1) + ': ' +
                    (error && error.message));
                var doomed = waiters[job.key] || [];
                return Promise.all(doomed.map(function(item) {
                    item.remaining--;
                    return item.remaining > 0 ? null : materialisePlanItem(item);
                }));
            });
        });

        return jobs.then(function() {
            return runLimited(plan, PREFETCH_FILE_CONCURRENCY, function(item) {
                return item.remaining === 0 ? true : materialisePlanItem(item);
            });
        }).then(function() {
            return runLimited(unmapped, PREFETCH_FILE_CONCURRENCY, function(path) {
                return ensureMediaFile(path).then(function() { return true; }, function(error) {
                    console.warn('ZipLoader: prefetch failed for ' + path + ': ' + (error && error.message));
                    return false;
                });
            });
        }).then(function() {
            var ok = list.filter(function(path) { return !!bytesFor(path); }).length;
            console.log('ZipLoader: prefetch materialised ' + ok + '/' + list.length +
                ' file(s) from ' + partsLoaded + '/' + partJobs.length + ' part(s) (' +
                (bytesLoaded / 1048576).toFixed(1) + ' MB fetched) in ' +
                ((performance.now() - t0) / 1000).toFixed(1) + ' s');
            return ok;
        });
    }

    // Slice one planned file out of the now-resident parts, falling back to the
    // single-file path if the plan could not serve it (bad map entry, or a part
    // evicted under memory pressure before its files were sliced).
    function materialisePlanItem(item) {
        return readEntryFromParts(item.map, item.entry).then(function(bytes) {
            return putMediaBytes(item.path, bytes);
        }, function(error) {
            return ensureMediaFile(item.path).then(function() { return true; }, function(inner) {
                console.warn('ZipLoader: prefetch failed for ' + item.path + ': ' +
                    ((inner && inner.message) || (error && error.message)));
                return false;
            });
        });
    }

    // ---- network interception --------------------------------------------------
    function replayRequest(item) {
        return blobUrlFor(item.path).then(function(blobUrl) {
            var xhr = item.xhr;
            var async = item.async === false ? true : item.async;
            _origOpen.call(xhr, item.method, blobUrl, async);
            try {
                if (item.responseType) xhr.responseType = item.responseType;
            } catch (e) {}
            return _origSend.call(xhr, item.body);
        });
    }

    function drainXhrQueue() {
        var queue = _xhrQueue.splice(0, _xhrQueue.length);
        queue.forEach(function(item) {
            replayRequest(item).catch(function(error) {
                console.error('ZipLoader: failed to serve ' + item.path, error);
                try { item.xhr.dispatchEvent(new Event('error')); } catch (e) {}
            });
        });
    }

    // Do not let database/plugin XHRs receive empty or network responses while
    // the two boot-critical archives are still being extracted.
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        this.__zipMethod = method;
        this.__zipUrl = url;
        this.__zipAsync = async;
        return _origOpen.call(this, method, url, async, user, password);
    };

    XMLHttpRequest.prototype.send = function(body) {
        var url = this.__zipUrl;
        if (isVfsPath(url)) {
            var path = normalizePath(url);

            // Native XMLHttpRequest status/responseText/readyState fields are
            // read-only, so a browser VFS cannot safely impersonate a completed
            // synchronous XHR. All synchronous game data consumers use the
            // ZipLoader.getText() bridge; leave any unknown sync request alone
            // rather than writing illegal native properties.
            if (this.__zipAsync === false) {
                console.warn('ZipLoader: synchronous VFS XHR requires ZipLoader.getText(): ' + path);
                return;
            }

            var item = {
                xhr: this,
                body: body,
                path: path,
                method: this.__zipMethod,
                async: true,
                responseType: this.responseType
            };
            _xhrQueue.push(item);
            // Hold every VFS request—not only database/maps—until all four
            // archives have finished extraction. This prevents preloaders from
            // racing the image/audio phases or observing a partial VFS.
            if (_ready) drainXhrQueue();
            return;
        }
        return _origSend.call(this, body);
    };

    if (_origFetch) {
        window.fetch = function(input, options) {
            var url = typeof input === 'string' ? input : input && input.url;
            if (!isVfsPath(url)) return _origFetch(input, options);
            var path = normalizePath(url);
            return ensureArchiveForPath(path).then(function() {
                var bytes = bytesFor(path);
                if (bytes) {
                    return new Response(bytes, {
                        status: 200,
                        headers: { 'Content-Type': mimeType(path), 'Cache-Control': 'no-store' }
                    });
                }
                if (isMediaPath(path)) {
                    var entry = mediaEntryFor(path);
                    if (entry) {
                        return readMediaBytes(entry).then(function(mediaBytes) {
                            return new Response(mediaBytes, {
                                status: 200,
                                headers: { 'Content-Type': mimeType(path), 'Cache-Control': 'no-store' }
                            });
                        }, function() { return new Response('', { status: 404 }); });
                    }
                }
                return new Response('', { status: 404 });
            });
        };
    }

    // Plugins in this project replace Bitmap and Graphics with subclasses after
    // zip_loader.js has loaded. Install the VFS hooks on the current prototypes
    // and expose refreshHooks() so the hooks are reattached after plugins finish.
    function installBitmapHook() {
        if (typeof Bitmap === 'undefined' || !Bitmap.prototype ||
            typeof Bitmap.prototype._requestImage !== 'function' ||
            _bitmapHookPrototype === Bitmap.prototype) return;
        var prototype = Bitmap.prototype;
        var originalRequest = prototype._requestImage;
        prototype._requestImage = function(url) {
            var self = this;
            var path = normalizePath(url);
            if (path.indexOf('img/') !== 0) {
                return originalRequest.call(this, url);
            }
            // Bitmap.decode() can run before the asynchronous archive/blob
            // promise settles, so _image must exist immediately.
            if (!this._image) this._image = new Image();
            this._url = url;
            this._loadingState = 'requesting';
            blobUrlFor(path).then(function(blobUrl) {
                var originalUrl = self._url;
                originalRequest.call(self, blobUrl);
                self._url = originalUrl;
            }).catch(function(error) {
                // The file is genuinely absent from the asset pack. Fall back to
                // a transparent placeholder so the bitmap still completes,
                // instead of hanging in an 'error' state that can leave a
                // cutscene (e.g. the neutral ending) stuck on a black screen.
                console.warn('ZipLoader: image missing, using placeholder', url, error && error.message);
                var originalUrl = self._url;
                originalRequest.call(self, TRANSPARENT_PNG);
                self._url = originalUrl;
            });
        };
        _bitmapHookPrototype = prototype;
    }

    function installGraphicsHook() {
        if (typeof Graphics === 'undefined' ||
            typeof Graphics.setLoadingImage !== 'function' ||
            _graphicsHookTarget === Graphics) return;
        var target = Graphics;
        var originalSetLoadingImage = target.setLoadingImage;
        target.setLoadingImage = function(src) {
            if (normalizePath(src).indexOf('img/') === 0) {
                blobUrlFor(src).then(function(blobUrl) {
                    originalSetLoadingImage.call(target, blobUrl);
                }).catch(function(error) {
                    console.error('ZipLoader: loading image failed', src, error);
                });
            } else {
                originalSetLoadingImage.call(target, src);
            }
        };
        _graphicsHookTarget = target;
    }

    function installHooks() {
        installBitmapHook();
        installGraphicsHook();
    }

    installHooks();

    // ---- boot -----------------------------------------------------------------
    var _mediaPromise = null;
    // Lazy audio load: build the per-file index for audio/ without decompressing
    // into RAM. Called at boot since audio is fine. Image loading is now on-demand
    // (first request triggers part downloads) to keep boot memory low.
    var _audioMediaPromise = null;
    function loadAudioMedia() {
        if (_audioMediaPromise) return _audioMediaPromise;
        _audioMediaPromise = ensureRangeMaps().then(function() {
            if (populateMediaIndexFromMap('audio_repk.zip')) return true;
            console.log('ZipLoader: audio range map unavailable — falling back to zip indexing');
            return buildMediaIndexLazy(
                descWithManifest({ name: 'audio_repk.zip', folder: 'aud_pack', count: 111, pad: 3 }),
                'audio', 'audio'
            ).then(function() {
                console.log('ZipLoader: audio indexed (lazy, on demand)');
                return true;
            });
        });
        return _audioMediaPromise;
    }

    // On-demand image loading: indexing reads only the EOCD + central
    // directory (a couple of parts, typically a few MB total). Actual image
    // bytes for a given file are fetched only when that file is first
    // requested, and only the 1-2 parts that contain it — see
    // readMediaBytesOnDemand(). No full archive is ever assembled.
    var _imageMediaPromise = null;
    function loadImageMediaOnDemand() {
        if (_imageMediaPromise) return _imageMediaPromise;
        _imageMediaPromise = ensureRangeMaps().then(function() {
            if (populateMediaIndexFromMap('img_repk.zip')) return true;
            console.log('ZipLoader: image range map unavailable — falling back to zip indexing');
            return buildMediaIndexLazy(
                descWithManifest({ name: 'img_repk.zip', folder: 'img_pack', count: 57, pad: 2 }),
                'images', 'images'
            ).then(function() {
                console.log('ZipLoader: images indexed (lazy, on demand)');
                return true;
            });
        });
        return _imageMediaPromise;
    }

    // Main-menu warm-up: pull the title screen's own assets through the
    // micro-range loader before the player presses LAUNCH, so the menu
    // appears instantly instead of waiting on first-request fetches.
    var MAIN_MENU_PRELOAD = [
        'audio/se/title.ogg',
        'audio/se/SE_click.ogg',
        'audio/bgm/user_title.ogg',
        'img/atlases/omori/atlas.yaml',
        'img/atlases/omori/omori_titlescreen_newatlas.png',
        'img/atlases/omori_titlescreen.png'
    ];
    function preloadMainMenuAssets() {
        MAIN_MENU_PRELOAD.forEach(function(path) {
            blobUrlFor(path).then(function() {
                console.log('ZipLoader: preloaded main-menu asset ' + path);
            }).catch(function(error) {
                console.warn('ZipLoader: main-menu preload failed for ' + path + ': ' + error.message);
            });
        });
    }

    function init() {
        if (_initPromise) return _initPromise;
        _initPromise = (async function() {
            var t0 = performance.now();
            showProgress();
            progress(0, 'Reading base.ini');
            applyConfig(await loadConfig());
            _accountId = resolveAccountId();
            // Warm the byte-range maps in parallel with the core archives:
            // loadAudioMedia()/loadImageMediaOnDemand() await them later, but
            // fetching starts immediately so the maps are ready by LAUNCH.
            ensureRangeMaps();
            await loadManifest();
            progress(1, 'Account: ' + _accountId);

            var languagesFailed = false;
            // Core data (data/maps/languages) share the main bar; images and
            // audio get their own bars so concurrent downloads don't collide.
            var jobs = [
                loadArchiveCached(descWithManifest({ name: 'data.zip', folder: '', count: 1, pad: 0 }), 0, 33, 'data.zip', 'main'),
                loadArchiveCached(descWithManifest({ name: 'maps.zip', folder: '', count: 1, pad: 0 }), 33, 33, 'maps.zip', 'main'),
                // languages.zip is extracted here, BEFORE launch, so the ~210
                // language YAML reads during plugin setup are served from the
                // VFS instead of one blocking XHR each. Failure is non-fatal
                // (older deployments without the zip still boot) but is surfaced
                // loudly so a missing upload can't hide behind the LAUNCH button.
                loadArchiveCached(descWithManifest({ name: 'languages.zip', folder: '', count: 1, pad: 0 }), 66, 34, 'languages', 'main').catch(function(error) {
                    languagesFailed = true;
                    console.error('ZipLoader: languages.zip failed to load (' + error.message + '). ' +
                        'Upload it next to the archives (project root / baseUrl); language text will be unavailable.');
                    return false;
                })
            ];
            await Promise.all(jobs);

            // Native desktop: images + audio are served lazily file-by-file from
            // the Rust backend, so boot only downloads the small core archives.
            // The web build indexes both media archives here — but indexing is
            // now just an EOCD + central-directory read (a few MB total, not
            // the archive itself; see buildMediaIndexLazy). Actual file bytes
            // for any given image or audio clip are only ever fetched, part by
            // part, when that specific file is first requested during play.
            if (!_isTauri) {
                await Promise.all([loadAudioMedia(), loadImageMediaOnDemand()]);
            }

            _ready = true;
            preloadMainMenuAssets();
            progress(100, languagesFailed
                ? 'WARNING: languages.zip missing — language text unavailable. Press LAUNCH'
                : 'Ready — press LAUNCH');
            hideProgressBars();
            drainXhrQueue();
            showLaunchButton();
            console.log('ZipLoader: core archives ready (' + Object.keys(_vfs).length +
                ' files) for account "' + _accountId + '" in ' +
                ((performance.now() - t0) / 1000).toFixed(1) + ' s' +
                ' — images and audio load on demand, part by part; press Launch');
            return true;
        })().catch(function(error) {
            _error = error;
            progress(0, 'Zip loading failed: ' + error.message);
            console.error('ZipLoader:', error);
            throw error;
        });
        return _initPromise;
    }

    window.ZipLoader = {
        init: init,
        ready: function() { return _ready ? Promise.resolve(true) : init(); },
        isReady: function() { return _ready; },
        waitForLaunch: waitForLaunch,
        isLaunched: function() { return _launched; },
        getError: function() { return _error; },
        getFile: function(path) { return bytesFor(path); },
        getText: function(path) { return textFor(path); },
        getBlobUrl: function(path) { return blobUrlFor(path); },
        ensureFile: ensureMediaFile,
        // Boot-time batch materialisation of media files through the range
        // loader (the "grab the imgs to be delta'd" step): pulls the base
        // PNGs that staged OLID image deltas will patch while the LAUNCH
        // screen is still up, so the post-launch delta pass finds every
        // target already in the VFS. The batch is planned by zip *part*, so
        // each part is fetched at most once no matter how many files it
        // holds — on hosts that ignore HTTP Range (WebSim) that is the
        // difference between one download per part and one per file.
        // Resolves with the number of files materialised; individual
        // failures are logged and skipped, never rejected.
        prefetchMedia: prefetchMedia,
        putFile: putFile,
        putText: putText,
        removeFile: removeFile,
        hasFile: hasFile,
        listFiles: listFiles,
        refreshHooks: installHooks,
        // True once the language pack's files are in the VFS. The fs polyfill
        // uses this to decide whether a missing language file means "absent"
        // (serve '' without a network request) or "pack not loaded" (fall back
        // to a real XHR, e.g. local dev with the languages/ folder on disk).
        hasLanguagePack: function() {
            for (var key in _vfs) {
                if (key.toLowerCase().indexOf('languages/') === 0) return true;
            }
            return false;
        },
        // Account plumbing for the warm-cache layer: call setAccount() from a
        // login flow before ZipLoader.init() (or pass ?account= in the URL).
        setAccount: function(id) {
            if (!id) return _accountId;
            try { window.localStorage.setItem('wo.accountId', String(id)); } catch (e) {}
            _accountId = String(id);
            return _accountId;
        },
        accountId: function() { return _accountId; },
        setCacheEnabled: function(flag) { _cacheEnabled = !!flag; return _cacheEnabled; },
        // True when every required archive is already in the IndexedDB cache
        // with metadata matching manifest.json (version + total size). Used to
        // skip the one-time data-consent screen for returning players.
        // languages.zip is deliberately excluded: it is small, its absence is
        // boot-non-fatal, and init() re-fetches it quietly behind the loading
        // screen. Any error (missing manifest, IDB unavailable) returns false
        // so the consent screen remains the safe default.
        hasCachedArchives: function() {
            return loadConfig().then(function(config) {
                applyConfig(config || _config);
                if (!_cacheEnabled) return false;
                var required = [
                    descWithManifest({ name: 'data.zip', folder: '', count: 1, pad: 0 }),
                    descWithManifest({ name: 'maps.zip', folder: '', count: 1, pad: 0 }),
                    descWithManifest({ name: 'img_repk.zip', folder: 'img_pack', count: 57, pad: 2 }),
                    descWithManifest({ name: 'audio_repk.zip', folder: 'aud_pack', count: 111, pad: 3 })
                ];
                return Promise.all(required.map(function(desc) {
                    return ensureMeta(desc).then(function(expected) {
                        if (!expected) return false;
                        return Promise.all([cacheGetMeta(desc.name), cacheHasArchive(desc.name)])
                            .then(function(pair) {
                                var meta = pair[0];
                                var size = pair[1];
                                return !!(meta && size > 0 &&
                                    meta.version === expected.version &&
                                    meta.totalSize === expected.totalSize &&
                                    size === expected.totalSize);
                            });
                    }).catch(function() { return false; });
                })).then(function(results) {
                    return results.indexOf(false) === -1;
                });
            }).catch(function() { return false; });
        }
    };
})();
