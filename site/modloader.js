/* ============================================================================
 * OneLoader-compatible mod engine for the OMORI browser port.
 *
 * The desktop OneLoader (www/modloader/*) parses mods authored against the
 * OneLoader manifest-v1 format (mod.json + files/assets/deltas/plugins) and
 * overlays them onto a virtual filesystem. This file is a faithful browser
 * reimplementation of that pipeline, adapted to the browser VFS (ZipLoader)
 * which already stores *decrypted* game data (data/*.json, maps/*.json,
 * languages/en/*.yaml, img/.../*.png, audio/.../*.ogg, js/plugins/*.js).
 *
 * Features:
 *   - manifest-v1 parsing (assets/raw/data/text/maps/plugins + *_delta)
 *   - RFC 6902 JSON patches (fast-json-patch) and YAML deltas
 *   - plugin .jsd append deltas and .mjs ES-module plugins (rollup)
 *   - OLID image deltas (imagediff2 wasm)
 *   - Steam-encrypted (.kel/.hero/.aubrey/.omori/.pluto) passthrough via
 *     WebCrypto AES-256-CTR decryption
 *   - priority ordering, conflict resolution, excludes/requires/satisfies
 *   - asyncExec lifecycle hooks and the $modLoader API surface
 *   - multi-file upload + staged-mod list shown before LAUNCH
 * ========================================================================= */
(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     *  Constants / configuration
     * ------------------------------------------------------------------ */
    var STEAM_KEY = '6bdb2e585882fbd48826ef9cffd4c511'; // matches site/14.js
    var MAX_MANIFEST_VERSION = 1;
    var ID_BLACKLIST = ['gomori'];
    var DEFAULT_LANGUAGE = 'en';

    // Browser VFS stores decrypted files, so every "encrypted" target maps to
    // its decrypted extension and "encryption" is a no-op except for
    // pre-encrypted source files (.kel/.hero/.aubrey/.omori/.pluto) which we
    // decrypt with the Steam key at load time.
    var EXTENSION_RULES = {
        png: { target_extension: 'png', encrypt: false, raw: ['img/system/window.png', 'img/system/loading.png'] },
        ogg: { target_extension: 'ogg', encrypt: false }
    };

    var DATA_RULES = [
        {
            jsonKeys: ['data', 'data_delta', 'data_pluto', 'data_pluto_delta'],
            formatMap: {
                json:  { target: 'json', delta: false },
                jsond: { target: 'json', delta: true,  delta_method: 'json' },
                kel:   { target: 'json', delta: false, encrypted: true },
                yml:   { target: 'yaml', delta: false },
                yaml:  { target: 'yaml', delta: false },
                ymld:  { target: 'yaml', delta: true,  delta_method: 'yaml' },
                yamld: { target: 'yaml', delta: true,  delta_method: 'yaml' },
                pluto: { target: 'yaml', delta: false, encrypted: true }
            },
            mountPoint: 'data'
        },
        {
            jsonKeys: ['text', 'text_delta'],
            formatMap: {
                yml:   { target: 'yaml', delta: false },
                yaml:  { target: 'yaml', delta: false },
                ymld:  { target: 'yaml', delta: true,  delta_method: 'yaml' },
                yamld: { target: 'yaml', delta: true,  delta_method: 'yaml' },
                hero:  { target: 'yaml', delta: false, encrypted: true }
            },
            mountPoint: 'languages/' + DEFAULT_LANGUAGE
        },
        {
            jsonKeys: ['maps', 'maps_delta'],
            formatMap: {
                json:   { target: 'json', delta: false },
                jsond:  { target: 'json', delta: true,  delta_method: 'json' },
                aubrey: { target: 'json', delta: false, encrypted: true }
            },
            mountPoint: 'maps'
        },
        {
            jsonKeys: ['plugins', 'plugins_delta'],
            formatMap: {
                js:    { target: 'js', delta: false },
                jsd:   { target: 'js', delta: true,  delta_method: 'append' },
                mjs:   { target: 'js', delta: false, parser: 'esm' },
                omori: { target: 'js', delta: false, encrypted: true }
            },
            mountPoint: 'js/plugins',
            pluginList: true
        }
    ];

    window.$ONELOADER_CONFIG = {
        MAX_MANIFEST_VERSION: MAX_MANIFEST_VERSION,
        ID_BLACKLIST: ID_BLACKLIST,
        EXTENSION_RULES: EXTENSION_RULES,
        DATA_RULES: DATA_RULES
    };

    /* ------------------------------------------------------------------ *
     *  Utilities
     * ------------------------------------------------------------------ */
    function decode(bytes) {
        return new TextDecoder('utf-8').decode(bytes);
    }
    function encode(text) {
        return new TextEncoder().encode(text);
    }
    function normPath(p) {
        return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    }
    function fileName(p) {
        p = String(p).replace(/\/$/, '');
        var i = p.lastIndexOf('/');
        return i >= 0 ? p.slice(i + 1) : p;
    }
    function extOf(p) {
        var n = fileName(p);
        var i = n.lastIndexOf('.');
        return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
    }
    function baseNameLower(p) {
        var n = fileName(p).toLowerCase();
        return n.replace(/\.[a-z0-9]*$/, '');
    }
    function randomString() {
        var arr = new Uint8Array(16);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
        else for (var i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
        var out = '';
        for (var j = 0; j < arr.length; j++) out += ('0' + arr[j].toString(16)).slice(-2);
        return out;
    }
    function escapeRegExp(input) {
        return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function log() {
        if (typeof console !== 'undefined') console.log.apply(console, ['[ModLoader]'].concat([].slice.call(arguments)));
    }
    function warn() {
        if (typeof console !== 'undefined') console.warn.apply(console, ['[ModLoader]'].concat([].slice.call(arguments)));
    }

    var SCRIPT_BASE = (function () {
        try {
            var s = document.currentScript;
            if (s && s.src) return s.src.replace(/[^\/]*$/, '');
        } catch (e) {}
        return './';
    })();

    /* ------------------------------------------------------------------ *
     *  JSON patch (fast-json-patch, RFC 6902, with a built-in fallback)
     * ------------------------------------------------------------------ */
    function applyJsonPatch(doc, patches, validate) {
        if (window.jsonpatch && typeof jsonpatch.applyPatch === 'function') {
            return jsonpatch.applyPatch(doc, patches, validate !== false, true).newDocument;
        }
        return applyJsonPatchFallback(doc, patches);
    }

    function resolvePatchPath(obj, path, create) {
        var parts = String(path).replace(/^\//, '').split('/').map(function (p) {
            return p.replace(/~1/g, '/').replace(/~0/g, '~');
        });
        var container = obj;
        for (var i = 0; i < parts.length - 1; i++) {
            var key = parts[i];
            var next = parts[i + 1];
            if (container[key] === undefined || container[key] === null) {
                if (create) container[key] = /^\d+$/.test(next) ? [] : {};
                else return { container: container, key: key, missing: true };
            }
            container = container[key];
        }
        return { container: container, key: parts[parts.length - 1] };
    }

    function applyJsonPatchFallback(obj, patches) {
        for (var i = 0; i < patches.length; i++) {
            var p = patches[i];
            if (p.op === 'test') {
                var t = resolvePatchPath(obj, p.path, false);
                if (t.missing || t.container[t.key] !== p.value) throw new Error('patch test failed at ' + p.path);
                continue;
            }
            var resolved = resolvePatchPath(obj, p.path, p.op === 'add');
            if (resolved.missing) {
                warn('patch target not found:', p.path);
                continue;
            }
            var container = resolved.container;
            var key = resolved.key;
            var idx = /^\d+$/.test(key) ? parseInt(key, 10) : null;
            switch (p.op) {
                case 'replace': container[key] = p.value; break;
                case 'add':
                    if (idx !== null && Array.isArray(container)) container.splice(idx, 0, p.value);
                    else container[key] = p.value;
                    break;
                case 'remove':
                    if (idx !== null && Array.isArray(container)) container.splice(idx, 1);
                    else delete container[key];
                    break;
                case 'move': {
                    var src = resolvePatchPath(obj, p.from, false);
                    if (!src.missing) {
                        var v = src.container[src.key];
                        delete src.container[src.key];
                        container[key] = v;
                    }
                    break;
                }
                case 'copy': {
                    var s2 = resolvePatchPath(obj, p.from, false);
                    if (!s2.missing) container[key] = s2.container[s2.key];
                    break;
                }
            }
        }
        return obj;
    }

    /* ------------------------------------------------------------------ *
     *  YAML (parse via the game's own js-yaml shim when present, with a
     *  self-contained fallback; emit block-style YAML both can re-read)
     * ------------------------------------------------------------------ */
    function parseYaml(text) {
        text = String(text == null ? '' : text);
        if (typeof window.require === 'function') {
            try {
                var y = window.require('js-yaml');
                if (y && typeof y.safeLoad === 'function') return y.safeLoad(text);
                if (y && typeof y.load === 'function') return y.load(text);
            } catch (e) {}
        }
        return parseYamlMini(text);
    }

    function stripYamlComment(val) {
        var inQ = false, qCh = '';
        for (var i = 0; i < val.length; i++) {
            var ch = val[i];
            if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qCh = ch; continue; }
            if (inQ && ch === qCh) { inQ = false; qCh = ''; continue; }
            if (!inQ && ch === '#') return val.substring(0, i);
        }
        return val;
    }

    function yamlScalar(val) {
        val = stripYamlComment(val).trim();
        if (val === '' || val === '~') return null;
        if (val === 'null' || val === 'Null' || val === 'NULL') return null;
        if (val === 'true' || val === 'True' || val === 'TRUE') return true;
        if (val === 'false' || val === 'False' || val === 'FALSE') return false;
        if (val[0] === '"' && val[val.length - 1] === '"') {
            // The game's custom YAML parser does no escape processing inside
            // quoted scalars; it just strips the outer quotes. Mirror that so
            // message codes like \n[3] / \c[13] survive a round-trip intact.
            return val.slice(1, -1);
        }
        if (val[0] === "'" && val[val.length - 1] === "'") return val.slice(1, -1);
        if (val[0] === '{' || val[0] === '[') return parseYamlFlow(val);
        if (val !== '' && !isNaN(val)) return Number(val);
        return val;
    }

    function splitYamlFlow(str, sep) {
        var parts = [], cur = '', depth = 0, inQ = false, qCh = '';
        for (var i = 0; i < str.length; i++) {
            var ch = str[i];
            if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qCh = ch; cur += ch; continue; }
            if (inQ && ch === qCh) { inQ = false; qCh = ''; cur += ch; continue; }
            if (!inQ) {
                if (ch === '[' || ch === '{') { depth++; cur += ch; continue; }
                if (ch === ']' || ch === '}') { depth--; cur += ch; continue; }
                if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
            }
            cur += ch;
        }
        parts.push(cur);
        return parts;
    }

    function parseYamlFlow(val) {
        val = val.trim();
        if (val[0] === '{' && val[val.length - 1] === '}') {
            var inner = val.slice(1, -1);
            var result = {};
            var mParts = splitYamlFlow(inner, ',');
            for (var i = 0; i < mParts.length; i++) {
                var part = mParts[i].trim();
                if (!part) continue;
                var kv = splitYamlFlow(part, ':');
                if (kv.length < 2) continue;
                var key = yamlScalar(stripYamlComment(kv[0].trim()));
                result[key] = yamlScalar(kv.slice(1).join(':').trim());
            }
            return result;
        }
        if (val[0] === '[' && val[val.length - 1] === ']') {
            var sInner = val.slice(1, -1);
            var sResult = [];
            var sParts = splitYamlFlow(sInner, ',');
            for (var j = 0; j < sParts.length; j++) {
                if (!sParts[j].trim()) continue;
                sResult.push(yamlScalar(sParts[j].trim()));
            }
            return sResult;
        }
        return yamlScalar(val);
    }

    function parseYamlMini(text) {
        var lines = text.split(/\r?\n/);
        var root = {};
        var stack = [{ obj: root, indent: -1, key: null }];
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            var trimmed = line.trim();
            if (!trimmed || trimmed[0] === '#') continue;
            var indent = line.search(/\S|$/);
            while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
            var ctx = stack[stack.length - 1].obj;

            var seqMatch = trimmed.match(/^-\s+(.*)$/);
            if (seqMatch) {
                var seqVal = seqMatch[1];
                if (!Array.isArray(ctx)) {
                    var entry = stack[stack.length - 1];
                    var arr = [];
                    if (entry.parent && entry.key != null) entry.parent[entry.key] = arr;
                    entry.obj = arr;
                    ctx = arr;
                }
                if (seqVal[0] === '{' || seqVal[0] === '[') {
                    ctx.push(parseYamlFlow(seqVal));
                    continue;
                }
                var seqVm = seqVal.match(/^([^:]+):\s*(.*)$/);
                if (seqVm) {
                    var seqKey = yamlScalar(seqVm[1]);
                    var seqValue = seqVm[2];
                    var newObj = {};
                    if (seqValue === '') {
                        newObj[seqKey] = {};
                        ctx.push(newObj);
                        stack.push({ obj: newObj[seqKey], indent: indent, parent: newObj, key: seqKey });
                    } else {
                        newObj[seqKey] = yamlScalar(seqValue);
                        ctx.push(newObj);
                    }
                } else {
                    ctx.push(yamlScalar(seqVal));
                }
                continue;
            }

            var vm = trimmed.match(/^([^:]+):\s*(.*)$/);
            if (!vm) continue;
            var key = yamlScalar(vm[1]);
            var val = vm[2];
            if (val === '') {
                ctx[key] = {};
                stack.push({ obj: ctx[key], indent: indent, parent: ctx, key: key });
            } else {
                ctx[key] = yamlScalar(val);
            }
        }
        return root;
    }

    function yamlQuote(s) {
        // Wrap verbatim. The custom parser (s6.js) performs no unescaping, so
        // adding backslash escapes would corrupt RPG Maker message codes
        // (\n[3], \c[13], \!...) which rely on single literal backslashes.
        return '"' + s + '"';
    }

    function yamlPlainSafe(s) {
        if (typeof s !== 'string' || s === '') return false;
        if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return false;
        if (!isNaN(s) && /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(s.trim())) return false;
        if (/^[!&*\-?|>%@`"'#{}[\],]/.test(s)) return false;
        if (/^\s|\s$/.test(s)) return false;
        if (/[\n\r\t]/.test(s)) return false;
        // A '#' is only safe unquoted when the custom parser's quote tracking
        // (which toggles on '"' / "'") keeps it "inside quotes" — exactly how
        // the vanilla files protect message codes like \"#1 MOM\". Simulate it.
        if (stripYamlComment(s) !== s) return false;
        return true;
    }

    function yamlScalarOut(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'string') return yamlPlainSafe(v) ? v : yamlQuote(v);
        return yamlQuote(String(v));
    }

    function yamlFlowOut(v) {
        if (Array.isArray(v)) return '[' + v.map(yamlFlowOut).join(', ') + ']';
        if (v !== null && typeof v === 'object') {
            return '{' + Object.keys(v).map(function (k) {
                return yamlKeyOut(k) + ': ' + yamlFlowOut(v[k]);
            }).join(', ') + '}';
        }
        return yamlScalarOut(v);
    }

    function yamlKeyOut(k) {
        // The custom parser keeps mapping keys verbatim (it never strips
        // quotes from keys), so numeric keys like "0" MUST stay unquoted or
        // they come back as the literal string "\"0\"". Emit raw whenever the
        // key can't break the "key: value" split.
        k = String(k);
        if (k === '') return '""';
        if (/[:#\n\r]/.test(k) || /^\s|\s$/.test(k)) return '"' + k + '"';
        return k;
    }

    function yamlEmit(v, indent) {
        var pad = new Array(indent + 1).join(' ');
        if (Array.isArray(v)) {
            if (v.length === 0) return [pad + '[]'];
            var lines = [];
            for (var i = 0; i < v.length; i++) {
                var item = v[i];
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                    var keys = Object.keys(item);
                    if (keys.length === 0) { lines.push(pad + '- {}'); continue; }
                    var sub = yamlEmit(item, indent + 2);
                    lines.push(pad + '- ' + sub[0].replace(/^\s+/, ''));
                    for (var j = 1; j < sub.length; j++) lines.push(sub[j]);
                } else if (Array.isArray(item) && item.length > 0) {
                    // The custom parser cannot parse nested block sequences
                    // ("- - 90"), so nested arrays use inline flow notation.
                    lines.push(pad + '- ' + yamlFlowOut(item));
                } else if (Array.isArray(item) && item.length === 0) {
                    lines.push(pad + '- []');
                } else {
                    lines.push(pad + '- ' + yamlScalarOut(item));
                }
            }
            return lines;
        }
        if (v !== null && typeof v === 'object') {
            var keys = Object.keys(v);
            if (keys.length === 0) return [pad + '{}'];
            var out = [];
            for (var m = 0; m < keys.length; m++) {
                var key = keys[m];
                var val = v[key];
                if (val !== null && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0) {
                    out.push(pad + yamlKeyOut(key) + ':');
                    out = out.concat(yamlEmit(val, indent + 2));
                } else if (Array.isArray(val) && val.length > 0) {
                    out.push(pad + yamlKeyOut(key) + ':');
                    out = out.concat(yamlEmit(val, indent + 2));
                } else if (Array.isArray(val) && val.length === 0) {
                    out.push(pad + yamlKeyOut(key) + ': []');
                } else if (val !== null && typeof val === 'object' && Object.keys(val).length === 0) {
                    out.push(pad + yamlKeyOut(key) + ': {}');
                } else {
                    out.push(pad + yamlKeyOut(key) + ': ' + yamlScalarOut(val));
                }
            }
            return out;
        }
        return [pad + yamlScalarOut(v)];
    }

    function dumpYaml(v) {
        return yamlEmit(v, 0).join('\n') + '\n';
    }

    /* ------------------------------------------------------------------ *
     *  Steam-encrypted source decryption (WebCrypto AES-256-CTR)
     * ------------------------------------------------------------------ */
    var _steamKeyPromise = null;
    function getSteamKey() {
        if (!_steamKeyPromise) {
            if (window.crypto && crypto.subtle) {
                _steamKeyPromise = crypto.subtle.importKey(
                    'raw', encode(STEAM_KEY), { name: 'AES-CTR' }, false, ['decrypt']
                );
            } else {
                _steamKeyPromise = Promise.reject(new Error('WebCrypto unavailable'));
            }
        }
        return _steamKeyPromise;
    }

    async function decryptSteam(bytes) {
        if (!bytes || bytes.length < 17) return bytes;
        var iv = bytes.slice(0, 16);
        var data = bytes.slice(16);
        try {
            var key = await getSteamKey();
            var plain = await crypto.subtle.decrypt(
                { name: 'AES-CTR', counter: iv, length: 128 }, key, data
            );
            return new Uint8Array(plain);
        } catch (e) {
            warn('Steam decrypt failed:', e && e.message);
            return bytes;
        }
    }

    /* ------------------------------------------------------------------ *
     *  Rollup (ES-module plugins, .mjs) — loaded lazily
     * ------------------------------------------------------------------ */
    var _rollupPromise = null;
    function loadRollup() {
        if (!_rollupPromise) {
            var url = SCRIPT_BASE + 'rollup.browser.js';
            _rollupPromise = import(url).then(function (m) { return m && m.rollup; });
        }
        return _rollupPromise;
    }

    async function bundleEsm(code, filename, fileMap) {
        // Most OMORI ".mjs" plugins are plain scripts in disguise. If there are
        // no import/export statements, wrap directly and skip rollup entirely.
        if (!/(^|[^\w.])import\s|(^|[^\w.])export\s/.test(code)) {
            return '(function(){\n' + code + '\n})();';
        }
        var rollup = await loadRollup();
        if (!rollup) throw new Error('rollup unavailable for ES module plugin');
        var entryId = 'mod:/' + normPath(filename);
        var plugins = [{
            name: 'ModLoaderResolver',
            resolveId: function (id, importer) {
                if (!importer && id === entryId) return entryId;
                if (importer && importer.indexOf('mod:/') === 0) {
                    var base = importer.slice('mod:/'.length);
                    var dir = base.indexOf('/') >= 0 ? base.slice(0, base.lastIndexOf('/') + 1) : '';
                    return 'mod:/' + normPath(dir + id);
                }
                return null;
            },
            load: function (id) {
                if (id.indexOf('mod:/') !== 0) return null;
                var p = id.slice('mod:/'.length);
                var bytes = fileMap[p] || fileMap[p.toLowerCase()];
                return bytes ? decode(bytes) : null;
            }
        }];
        var bundle = await rollup({ input: entryId, plugins: plugins });
        var generated = await bundle.generate({ format: 'iife' });
        return '(function(){\n' + generated.output[0].code + '\n})();';
    }

    /* ------------------------------------------------------------------ *
     *  $modLoader shim — the API surface mods expect from OneLoader
     * ------------------------------------------------------------------ */
    function makeModLoader() {
        var ml = {
            $log: function (msg) { log(msg); },
            $execScripts: {
                pre_stage_2: [], post_stage_2: [], pre_game_start: [],
                pre_plugin_injection: [], pre_window_onload: [],
                when_discovered_2: [], when_discovered_3: [],
                exclusion_processor: [], exclusion_processor2: []
            },
            mods: new Map(),
            allMods: new Map(),
            knownMods: new Map(),
            config: {},
            overlayFS: {},
            shadowFS: {},
            pluginOrderingRules: new Map(),
            pluginLocks: new Set(),
            isInTestMode: false,
            $packageJsonPatchset: [],
            $parsers: new Map(),
            $rollup: null,
            syncConfig: function () {
                try {
                    window.localStorage.setItem('omori.mods.config', JSON.stringify(ml.config || {}));
                } catch (e) {}
            },
            $runEval: async function (data, params) {
                var fn = new Function('params', 'modLoader', '"use strict";\n' + data);
                return fn(params || {}, ml);
            },
            $runRequire: async function (data, params) {
                // Browser runtime: no Node require(). Execute as an ordinary
                // script with the same parameter convention.
                return ml.$runEval(data, params);
            },
            $runScripts: async function (place, params) {
                var list = ml.$execScripts[place] || [];
                for (var i = 0; i < list.length; i++) {
                    var s = list[i];
                    try {
                        if (s && s.req) await ml.$runRequire(s.data, params);
                        else if (s) await ml.$runEval(s.data, params);
                    } catch (e) {
                        warn('script @' + place + ' failed:', e && e.message);
                    }
                }
            },
            $vfsTrace: function () {}
        };
        try {
            var saved = window.localStorage.getItem('omori.mods.config');
            if (saved) ml.config = JSON.parse(saved) || {};
        } catch (e) {}
        return ml;
    }

    var $modLoader = makeModLoader();
    window.$modLoader = $modLoader;

    if (!window.Snek) window.Snek = {};
    if (!window.Snek.ModConfigs) {
        window.Snek.ModConfigs = {
            _configs: [],
            addConfig: function (cfg) { this._configs.push(cfg); }
        };
    }

    // Node-style VFS helpers some mod scripts rely on.
    window._vfs_resolve_file = async function (path) {
        if (window.ZipLoader && typeof ZipLoader.ensureFile === 'function') {
            try { await ZipLoader.ensureFile(path); } catch (e) {}
        }
        var bytes = window.ZipLoader && ZipLoader.getFile ? ZipLoader.getFile(path) : null;
        return bytes || new Uint8Array(0);
    };
    window._read_file = async function (dataSource) {
        if (dataSource && dataSource.type === 'memory') return dataSource.bytes;
        if (dataSource && dataSource.type === 'bytes') return dataSource.bytes;
        return new Uint8Array(0);
    };

    /* ------------------------------------------------------------------ *
     *  Mod model (ZipMod backed by in-memory fflate output)
     * ------------------------------------------------------------------ */
    function ZipMod(zipName, files) {
        this.zipName = zipName;
        this.files = files; // { path: Uint8Array }
        this.json = {};
        this.rootPath = '';
        this.priority = 0;
        this.entries = [];
        this.plugins = [];        // full plugin injection points
        this.pluginsDelta = [];   // .jsd append-delta injection points
        this.imageDelta = [];     // { target, path, bytes }
        this.asyncExec = [];      // { data, runat, req }
        this.errors = [];
    }

    ZipMod.prototype.entryList = function () {
        if (!this._entryCache) this._entryCache = Object.keys(this.files);
        return this._entryCache;
    };

    // Building a { normalizedLowercasePath -> originalKey } map (plus the set
    // of directory paths implied by every file's ancestors) once, up front,
    // turns readFile()/isDir() from an O(n) scan per call into an O(1) lookup.
    // Without this, filesInDir() — used whenever a mod declares a whole
    // directory like "img/" in its file list — calls isDir() once per entry
    // found by readDir(), which itself scans every file: that's effectively
    // O(n^2) string comparisons per declared directory, and mods with several
    // thousand files (a realistic size for an image/audio-heavy asset pack)
    // turn that into tens of millions of normPath()/toLowerCase() allocations,
    // pegging a CPU core and stalling the rest of boot indefinitely.
    ZipMod.prototype._pathIndex = function () {
        if (this._pathIdx) return this._pathIdx;
        var byPath = Object.create(null);
        var dirSet = Object.create(null);
        var keys = this.entryList();
        for (var i = 0; i < keys.length; i++) {
            var raw = keys[i];
            var norm = normPath(raw);
            if (!norm) continue;
            byPath[norm.toLowerCase()] = raw;
            var segs = norm.split('/');
            var acc = '';
            for (var s = 0; s < segs.length - 1; s++) {
                if (!segs[s]) continue;
                acc = acc ? acc + '/' + segs[s] : segs[s];
                dirSet[acc.toLowerCase()] = true;
            }
        }
        this._pathIdx = { byPath: byPath, dirSet: dirSet };
        return this._pathIdx;
    };

    ZipMod.prototype.readFile = function (p) {
        p = normPath(p).toLowerCase();
        var key = this._pathIndex().byPath[p];
        return key !== undefined ? this.files[key] : null;
    };

    ZipMod.prototype.readDir = function (dir) {
        dir = normPath(dir).toLowerCase();
        var prefix = dir === '' ? '' : dir + '/';
        var out = [];
        var seen = {};
        var keys = this.entryList();
        for (var i = 0; i < keys.length; i++) {
            var n = normPath(keys[i]);
            if (!n) continue;
            var lower = n.toLowerCase();
            if (prefix && lower.indexOf(prefix) !== 0) continue;
            var rest = n.slice(prefix.length);
            if (!rest) continue;
            var seg = rest.split('/')[0];
            if (seg && !seen[seg.toLowerCase()]) { seen[seg.toLowerCase()] = true; out.push(seg); }
        }
        return out;
    };

    ZipMod.prototype.isDir = function (p) {
        p = normPath(p).toLowerCase();
        return !!this._pathIndex().dirSet[p];
    };

    ZipMod.prototype.locateModJson = function () {
        var keys = this.entryList();
        for (var i = 0; i < keys.length; i++) {
            if (/mod\.json$/i.test(normPath(keys[i]))) {
                var b = this.files[keys[i]];
                if (b) {
                    this.json = JSON.parse(decode(b));
                    this.rootPath = normPath(keys[i]).replace(/mod\.json$/i, '').replace(/\/$/, '');
                    if (this.rootPath) this.rootPath += '/';
                    if (!this.json.manifestVersion) this.json.manifestVersion = 1;
                    if (!this.json._flags) this.json._flags = [];
                    if (!this.json.files) this.json.files = {};
                    if (!this.json.plugins_ordered) this.json.plugins_ordered = {};
                    if (this.json.priority) this.priority = parseInt(this.json.priority, 10) || 0;
                    return;
                }
            }
        }
        throw new Error('mod.json not found in ' + this.zipName);
    };

    ZipMod.prototype.filesInDir = function (dir) {
        var real = [];
        var items = this.readDir(this.rootPath + dir);
        for (var i = 0; i < items.length; i++) {
            if (!this.isDir(this.rootPath + dir + items[i])) real.push(items[i]);
        }
        return real;
    };

    ZipMod.prototype.processListEntryV1 = function (entry) {
        if (/\/$/.test(entry)) {
            var files = this.filesInDir(entry);
            return files.map(function (a) { return { base: entry, file: a }; });
        }
        var split = entry.split('/');
        var file = split.pop();
        return [{ base: split.join('/'), file: file }];
    };

    ZipMod.prototype.sourceBytes = function (base, file) {
        return this.readFile(this.rootPath + normPath((base ? base + '/' : '') + file));
    };

    ZipMod.prototype.processAssetsV1 = function (list) {
        var self = this;
        for (var i = 0; i < list.length; i++) {
            var decls = this.processListEntryV1(list[i]);
            decls.forEach(function (d) {
                try { self.entries.push(self.buildAsset(d)); } catch (e) { self.errors.push(e); }
            });
        }
    };

    ZipMod.prototype.processRawV1 = function (list) {
        var self = this;
        for (var i = 0; i < list.length; i++) {
            var decls = this.processListEntryV1(list[i]);
            decls.forEach(function (d) {
                try { self.entries.push(self.buildRaw(d)); } catch (e) { self.errors.push(e); }
            });
        }
    };

    ZipMod.prototype.buildAsset = function (decl) {
        var srcExt = extOf(decl.file);
        var rule = EXTENSION_RULES[srcExt] || null;
        var fullPath = normPath(decl.base + '/' + decl.file).toLowerCase();
        if (rule && rule.raw && rule.raw.indexOf(fullPath) >= 0) rule = null;
        var targetExt = rule ? rule.target_extension : srcExt;
        var bytes = this.sourceBytes(decl.base, decl.file);
        if (!bytes) throw new Error('missing asset ' + decl.file);
        return {
            injectionPoint: (normPath(decl.base + '/' + fileName(decl.file).replace(/\.[^.]+$/, '')) + '.' + targetExt).toLowerCase(),
            ogName: fileName(decl.file),
            mode: 'pass',
            bytes: bytes,
            delta: false,
            mod: this
        };
    };

    ZipMod.prototype.buildRaw = function (decl) {
        var bytes = this.sourceBytes(decl.base, decl.file);
        if (!bytes) throw new Error('missing raw file ' + decl.file);
        return {
            injectionPoint: normPath(decl.base + '/' + decl.file).toLowerCase(),
            ogName: fileName(decl.file),
            mode: 'pass',
            bytes: bytes,
            delta: false,
            mod: this
        };
    };

    ZipMod.prototype.processDataRulesV1 = function (rule) {
        var allEntries = [];
        var seen = {};
        for (var i = 0; i < rule.jsonKeys.length; i++) {
            var k = rule.jsonKeys[i];
            var list = this.json.files[k];
            if (!list) continue;
            (Array.isArray(list) ? list : [list]).forEach(function (entry) {
                var key = String(entry);
                if (!seen[key]) { seen[key] = true; allEntries.push(entry); }
            });
        }
        for (var j = 0; j < allEntries.length; j++) {
            var decls = this.processListEntryV1(allEntries[j]);
            for (var d = 0; d < decls.length; d++) {
                try { this.buildModFile(decls[d], rule); } catch (e) { this.errors.push(e); }
            }
        }
    };

    ZipMod.prototype.buildModFile = function (decl, rule) {
        var srcExt = extOf(decl.file);
        var format = rule.formatMap[srcExt];
        if (!format) { warn(this.json.id + ': unknown extension .' + srcExt + ' in ' + decl.file); return; }

        var destFileName = fileName(decl.file).replace(/\.[^.]+$/, '');
        if (rule.pluginList && this.json._flags.indexOf('randomize_plugin_name') >= 0) {
            destFileName = randomString();
        }
        var injectionPoint = normPath(rule.mountPoint + '/' + destFileName.toLowerCase() + '.' + format.target).toLowerCase();

        var bytes = this.sourceBytes(decl.base, decl.file);
        if (!bytes) throw new Error('missing file ' + decl.file);

        var fileData = {
            injectionPoint: injectionPoint,
            ogName: destFileName + '.' + format.target,
            mode: format.encrypted ? 'steam' : 'pass',
            bytes: bytes,
            delta: !!format.delta,
            delta_method: format.delta_method,
            srcExtension: srcExt,
            parser: format.parser,
            pluginList: !!rule.pluginList,
            mod: this
        };
        this.entries.push(fileData);

        if (rule.pluginList) {
            if (fileData.delta) this.pluginsDelta.push(injectionPoint);
            else this.plugins.push(injectionPoint);
        }
    };

    ZipMod.prototype.processAsyncExecV1 = function () {
        var self = this;
        if (!this.json.asyncExec) return;
        this.json.asyncExec.forEach(function (item) {
            var bytes = self.readFile(self.rootPath + normPath(item.file));
            if (!bytes) { self.errors.push(new Error('asyncExec missing ' + item.file)); return; }
            var data = decode(bytes);
            var runat = item.runat || 'pre_game_start';
            var req = /_require$/.test(runat);
            if (req) runat = runat.replace(/_require$/, '');
            if (runat === 'when_discovered') {
                try {
                    var fn = new Function('params', 'modLoader', '"use strict";\n' + data);
                    fn({ mod: self }, $modLoader);
                } catch (e) {
                    warn(self.json.id + ': when_discovered script failed:', e && e.message);
                }
            } else {
                $modLoader.$execScripts[runat] = $modLoader.$execScripts[runat] || [];
                $modLoader.$execScripts[runat].push({ data: data, req: req });
            }
        });
    };

    ZipMod.prototype.processImageDeltas = function () {
        var self = this;
        if (!this.json.image_deltas) return;
        this.json.image_deltas.forEach(function (decl) {
            var patch = normPath(decl.patch) + '/';
            var withDir = normPath(decl.with) + '/';
            if (decl.dir) {
                var files = self.filesInDir(normPath(decl.with));
                files.forEach(function (f) {
                    var bytes = self.readFile(self.rootPath + withDir + f);
                    if (bytes) {
                        self.imageDelta.push({
                            target: normPath(patch + f.replace(/\.olid$/i, '.png')),
                            path: withDir + f,
                            bytes: bytes
                        });
                    }
                });
            } else {
                var bytes = self.readFile(self.rootPath + normPath(decl.with));
                if (bytes) {
                    self.imageDelta.push({
                        target: normPath(decl.patch),
                        path: normPath(decl.with),
                        bytes: bytes
                    });
                }
            }
        });
    };

    ZipMod.prototype.processMod = async function () {
        if (this.json.manifestVersion > MAX_MANIFEST_VERSION) {
            throw new Error(this.json.id + ': manifest version ' + this.json.manifestVersion + ' too new');
        }
        if (this.json.exec && this.json.exec.length > 0) {
            throw new Error(this.json.id + ': uses the unsupported "exec" feature');
        }
        if (this.json._flags.indexOf('randomize_plugin_name') >= 0 && this.json.plugins_ordered &&
            Object.keys(this.json.plugins_ordered).length > 0) {
            throw new Error(this.json.id + ': randomize_plugin_name and plugins_ordered are mutually exclusive');
        }
        if (this.json._flags.indexOf('package_json_editing') >= 0) {
            warn(this.json.id + ': package.json editing has no effect in the browser build; ignoring.');
        }

        this.processAsyncExecV1();
        if (this.json.files.assets) this.processAssetsV1(this.json.files.assets);
        if (this.json.files.raw) this.processRawV1(this.json.files.raw);
        await $modLoader.$runScripts('when_discovered_2', { mod: this });
        for (var i = 0; i < DATA_RULES.length; i++) this.processDataRulesV1(DATA_RULES[i]);
        if (this.json._flags.indexOf('do_olid') >= 0) this.processImageDeltas();
        await $modLoader.$runScripts('when_discovered_3', { mod: this });
    };

    ZipMod.prototype.entry = function () {
        return {
            type: 'zip',
            json: this.json,
            files: this.entries,
            plugins: this.plugins,
            pluginsDelta: this.pluginsDelta,
            imageDelta: this.imageDelta,
            _raw: this
        };
    };

    async function parseMod(zipName, files) {
        var mod = new ZipMod(zipName, files);
        mod.locateModJson();
        await mod.processMod();
        return mod;
    }

    /* ------------------------------------------------------------------ *
     *  Image deltas (.olid) via imagediff2 wasm
     * ------------------------------------------------------------------ */
    var _imagediffReady = false;
    async function ensureImagediff() {
        if (_imagediffReady) return;
        if (typeof wasm_bindgen === 'undefined') throw new Error('imagediff2 wasm loader missing');
        // wasm_bindgen is Object.assign(init, exports): call the init function
        // directly (matching reference early_loader.js), not a .init method.
        await wasm_bindgen(SCRIPT_BASE + 'imagediff2_bg.wasm');
        _imagediffReady = true;
    }

    function pngBytesToCanvas(bytes) {
        return new Promise(function (resolve, reject) {
            var blob = new Blob([bytes], { type: 'image/png' });
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                resolve(canvas);
            };
            img.onerror = function (e) {
                URL.revokeObjectURL(url);
                reject(new Error('failed to decode PNG'));
            };
            img.src = url;
        });
    }

    function canvasToPngBytes(canvas) {
        return new Promise(function (resolve) {
            canvas.toBlob(function (blob) {
                if (!blob) { resolve(new Uint8Array(0)); return; }
                var reader = new FileReader();
                reader.onload = function () { resolve(new Uint8Array(reader.result)); };
                reader.readAsArrayBuffer(blob);
            }, 'image/png');
        });
    }

    async function applyImageDeltas(imageDeltaMap) {
        // imageDeltaMap is a Map; Object.keys() would always be empty and the
        // wasm would initialize but never actually decode anything.
        var targets = Array.from(imageDeltaMap.keys());
        if (!targets.length) return;
        await ensureImagediff();
        var tileSize = wasm_bindgen.tile_size();

        // Native build: base images are lazy-loaded file-by-file. Fetch every
        // target in parallel once, so the per-image decode loop below never
        // waits on one fetch at a time (serial fetches made mod parsing slow).
        if (window.ZipLoader && typeof window.ZipLoader.ensureFile === 'function') {
            await Promise.all(targets.map(function (image) {
                return Promise.resolve(window.ZipLoader.ensureFile(image)).catch(function () {});
            }));
        }

        for (var t = 0; t < targets.length; t++) {
            var image = targets[t];
            var deltas = imageDeltaMap.get(image);
            var baseBytes = window.ZipLoader.getFile(image);
            if (!baseBytes) { warn('image delta target missing from VFS:', image); continue; }

            try {
                var sourceCanvas = await pngBytesToCanvas(baseBytes);
                var tw = 0, th = 0;
                var parsed = [];
                for (var d = 0; d < deltas.length; d++) {
                    var ab = deltas[d].bytes;
                    var dv = new DataView(ab.buffer, ab.byteOffset, ab.byteLength);
                    // Reference imagedelta_applier.js rejects only when BOTH
                    // magic words are wrong (&&). The old || rejected every
                    // valid olid (second magic is 4-byte BE 0xDD210000).
                    if (ab.length < 26 || (dv.getUint32(0) !== 0xFEFFD808 && dv.getUint32(4) !== 0xDD210000)) {
                        warn('invalid olid in', deltas[d].path);
                        continue;
                    }
                    tw = Math.max(tw, dv.getUint32(6));
                    th = Math.max(th, dv.getUint32(10));
                    parsed.push({ salt: ab.slice(14, 22), bitstream: ab.slice(26) });
                }
                if (!parsed.length) continue;

                var targetCanvas = document.createElement('canvas');
                targetCanvas.width = Math.ceil(tw / tileSize) * tileSize;
                targetCanvas.height = Math.ceil(th / tileSize) * tileSize;
                var targetCtx = targetCanvas.getContext('2d');
                targetCtx.drawImage(sourceCanvas, 0, 0);

                for (var p = 0; p < parsed.length; p++) {
                    var inflated = (window.fflate && fflate.unzlibSync)
                        ? fflate.unzlibSync(parsed[p].bitstream)
                        : parsed[p].bitstream;
                    var stream = new Uint8Array(inflated);
                    var sv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
                    var ptr = 0;
                    while (ptr < stream.byteLength) {
                        // Tile headers are big-endian in the reference
                        // (DataView defaults); LE reads produced garbage tiles.
                        var tileX = sv.getUint16(ptr);
                        var tileY = sv.getUint16(ptr + 2);
                        var len = sv.getUint32(ptr + 4);
                        ptr += 8;
                        var tileStream = stream.slice(ptr, ptr + len);
                        ptr += len;

                        var srcBitmap;
                        if (sourceCanvas.width < (tileX + 1) * tileSize || sourceCanvas.height < (tileY + 1) * tileSize) {
                            srcBitmap = new ArrayBuffer(tileSize * tileSize * 4);
                        } else {
                            srcBitmap = targetCtx.getImageData(tileX * tileSize, tileY * tileSize, tileSize, tileSize).data.buffer;
                        }
                        var patched = wasm_bindgen.apply_diff(new Uint32Array(srcBitmap), tileStream);
                        targetCtx.putImageData(new ImageData(new Uint8ClampedArray(patched.buffer), tileSize, tileSize), tileX * tileSize, tileY * tileSize);
                    }
                }

                if (targetCanvas.width !== tw || targetCanvas.height !== th) {
                    var fc = document.createElement('canvas');
                    fc.width = tw; fc.height = th;
                    fc.getContext('2d').drawImage(targetCanvas, 0, 0);
                    targetCanvas = fc;
                }
                var png = await canvasToPngBytes(targetCanvas);
                if (png.length) window.ZipLoader.putFile(image, png);
            } catch (e) {
                warn('image delta failed for', image, ':', e && e.message);
            }
        }
    }

    /* ------------------------------------------------------------------ *
     *  Core pipeline: parse -> resolve -> delta -> inject -> plugins
     * ------------------------------------------------------------------ */
    function computeCompat(knownMods) {
        var satisfaction = new Map();
        var skipChecks = new Map();
        knownMods.forEach(function (mod) {
            var id = mod.json.id;
            var l = id.toLowerCase();
            if (!satisfaction.has(l)) satisfaction.set(l, []);
            satisfaction.get(l).push(mod.json.name);
            (mod.json.satisfies || []).forEach(function (s) {
                var sl = s.toLowerCase();
                if (!satisfaction.has(sl)) satisfaction.set(sl, []);
                satisfaction.get(sl).push(mod.json.name);
            });
            if (mod.json.skip_checks) {
                for (var victim in mod.json.skip_checks) {
                    var vl = victim.toLowerCase();
                    if (!skipChecks.has(vl)) skipChecks.set(vl, new Set());
                    (mod.json.skip_checks[victim] || []).forEach(function (x) { skipChecks.get(vl).add(x.toLowerCase()); });
                }
            }
        });

        var exclusions = new Map();
        var requirements = new Map();
        knownMods.forEach(function (mod) {
            var skips = new Set();
            var sl = mod.json.id.toLowerCase();
            if (skipChecks.has(sl)) skipChecks.get(sl).forEach(function (x) { skips.add(x); });
            (mod.json.satisfies || []).forEach(function (s) {
                var sl2 = s.toLowerCase();
                if (skipChecks.has(sl2)) skipChecks.get(sl2).forEach(function (x) { skips.add(x); });
            });
            (mod.json.excludes || []).forEach(function (e) {
                var el = e.toLowerCase();
                if (skips.has(el)) return;
                if (!exclusions.has(el)) exclusions.set(el, []);
                exclusions.get(el).push(mod.json.name);
            });
            (mod.json.requires || []).forEach(function (r) {
                var rl = r.toLowerCase();
                if (skips.has(rl)) return;
                if (!requirements.has(rl)) requirements.set(rl, []);
                requirements.get(rl).push(mod.json.name);
            });
        });

        var exclusionFailures = [];
        var requirementFailures = [];
        exclusions.forEach(function (value, key) {
            if (satisfaction.has(key)) exclusionFailures.push(satisfaction.get(key).join(', ') + ' excluded by ' + value.join(', '));
        });
        requirements.forEach(function (value, key) {
            if (!satisfaction.has(key)) requirementFailures.push(value.join(', ') + ' require(s) ' + key + ' which is not installed.');
        });
        return { satisfaction: satisfaction, exclusions: exclusions, requirements: requirements, exclusionFailures: exclusionFailures, requirementFailures: requirementFailures };
    }

    async function applyAllMods(mods) {
        // Sort ascending by priority; later entries (higher priority) win conflicts.
        var sorted = mods.slice().sort(function (a, b) { return a.priority - b.priority; });
        $modLoader.knownMods = new Map();
        $modLoader.allMods = new Map();
        $modLoader.mods = new Map();
        sorted.forEach(function (mod) {
            $modLoader.knownMods.set(mod.json.id, mod.entry());
            $modLoader.allMods.set(mod.json.id, mod.json);
            $modLoader.mods.set(mod.json.id, { enabled: true, meta: mod.json, id: mod.json.id });
        });

        await $modLoader.$runScripts('pre_stage_2', { knownMods: $modLoader.knownMods, $modLoader: $modLoader });

        var compat = computeCompat($modLoader.knownMods);
        await $modLoader.$runScripts('exclusion_processor', { exclusions: compat.exclusions, requirements: compat.requirements });
        await $modLoader.$runScripts('exclusion_processor2', { exclusions: compat.exclusions, requirements: compat.requirements, exclusionFailures: compat.exclusionFailures, requirementFailures: compat.requirementFailures });
        compat.exclusionFailures.forEach(function (f) { warn('conflict:', f); });
        compat.requirementFailures.forEach(function (f) { warn('missing requirement:', f); });

        // Collect full replacements and deltas.
        var fullFiles = new Map();  // injectionPoint -> array (priority order)
        var deltaFiles = new Map(); // injectionPoint -> array (priority order)
        sorted.forEach(function (mod) {
            mod.entries.forEach(function (file) {
                if (file.delta) {
                    if (!deltaFiles.has(file.injectionPoint)) deltaFiles.set(file.injectionPoint, []);
                    deltaFiles.get(file.injectionPoint).push(file);
                } else {
                    if (!fullFiles.has(file.injectionPoint)) fullFiles.set(file.injectionPoint, []);
                    fullFiles.get(file.injectionPoint).push(file);
                }
            });
        });

        // image deltas: collect by target png path
        var imageDeltaMap = new Map();
        sorted.forEach(function (mod) {
            mod.imageDelta.forEach(function (d) {
                var key = d.target.toLowerCase();
                if (!imageDeltaMap.has(key)) imageDeltaMap.set(key, []);
                imageDeltaMap.get(key).push(d);
            });
        });

        // Apply deltas on top of the base VFS.
        var deltaOutput = new Map();
        for (var key of deltaFiles.keys()) {
            var files = deltaFiles.get(key);
            var method = files[0].delta_method;
            try {
                var base = window.ZipLoader.getFile(key);
                // Plugin append deltas (.jsd) target on-disk plugins that are
                // not inside any archive, so fetch their source over HTTP when
                // the VFS doesn't already have them.
                if (!base && method === 'append') {
                    try {
                        var resp = await window.fetch(key);
                        if (resp && resp.ok) base = new Uint8Array(await resp.arrayBuffer());
                    } catch (e) {}
                }
                if (!base) throw new Error('base file not found');
                var fin;
                if (method === 'json') {
                    var doc = JSON.parse(decode(base));
                    for (var i = 0; i < files.length; i++) {
                        var patches = JSON.parse(decode(files[i].bytes));
                        doc = applyJsonPatch(doc, patches, true);
                    }
                    fin = encode(JSON.stringify(doc));
                } else if (method === 'yaml') {
                    var ydoc = parseYaml(decode(base));
                    for (var j = 0; j < files.length; j++) {
                        var ypatches = JSON.parse(decode(files[j].bytes));
                        ydoc = applyJsonPatch(ydoc, ypatches, true);
                    }
                    fin = encode(dumpYaml(ydoc));
                } else if (method === 'append') {
                    var code = decode(base);
                    for (var k = 0; k < files.length; k++) code = code + '\n' + decode(files[k].bytes) + '\n';
                    fin = encode(code);
                } else {
                    throw new Error('unknown delta method ' + method);
                }
                deltaOutput.set(key, fin);
                log('delta applied:', key, '(' + files.length + ' patch' + (files.length > 1 ? 'es' : '') + ')');
            } catch (e) {
                warn('delta patch skipped for', key, ':', e && e.message);
            }
        }

        // Resolve full replacements (last / highest priority wins) and merge with deltas.
        var overlay = new Map();
        fullFiles.forEach(function (list, key) {
            var winner = list[list.length - 1];
            var maxDeltaPriority = -1;
            if (deltaFiles.has(key)) {
                deltaFiles.get(key).forEach(function (f) { maxDeltaPriority = Math.max(maxDeltaPriority, f.mod.priority); });
            }
            if (deltaOutput.has(key) && winner.mod.priority < maxDeltaPriority) {
                // deltas win
                overlay.set(key, deltaOutput.get(key));
            } else {
                overlay.set(key, winner);
            }
            if (list.length > 1) {
                warn('conflict on', key, ':', list.map(function (f) { return f.mod.json.name; }).join(' vs '), '->', winner.mod.json.name);
            }
        });
        deltaFiles.forEach(function (list, key) {
            if (!overlay.has(key) && deltaOutput.has(key)) overlay.set(key, deltaOutput.get(key));
        });

        // Write every overlay entry into the VFS.
        var injected = 0;
        for (var okey of overlay.keys()) {
            var entry = overlay.get(okey);
            if (entry instanceof Uint8Array) {
                window.ZipLoader.putFile(okey, entry);
            } else if (entry && entry.bytes) {
                var bytes = entry.bytes;
                if (entry.mode === 'steam') bytes = await decryptSteam(bytes);
                if (entry.parser === 'esm') {
                    var fileMap = {};
                    if (entry.mod && entry.mod.files) {
                        Object.keys(entry.mod.files).forEach(function (p) {
                            fileMap[normPath(p).toLowerCase()] = entry.mod.files[p];
                        });
                    }
                    bytes = encode(await bundleEsm(decode(bytes), entry.ogName, fileMap));
                }
                window.ZipLoader.putFile(okey, bytes);
            }
            injected++;
        }
        log('injected', injected, 'file(s)');

        // image deltas (patched PNGs are written straight into the VFS).
        // NEVER let a decoder failure abort the rest of the pipeline: if the
        // wasm is unavailable or a target fails, the already-applied data
        // deltas and plugin files must still inject.
        try {
            await applyImageDeltas(imageDeltaMap);
        } catch (e) {
            warn('image delta pipeline failed; continuing without image patches:', e && e.message);
        }

        // Plugin ordering & injection into $plugins.
        await injectPlugins();

        await $modLoader.$runScripts('post_stage_2', { knownMods: $modLoader.knownMods, $modLoader: $modLoader, overlayFS: $modLoader.overlayFS });
        return injected;
    }

    async function injectPlugins() {
        if (typeof $plugins === 'undefined') { warn('$plugins not defined yet; skipping plugin injection'); return; }
        if ($modLoader.knownMods.size === 0) return;

        try {
            if (typeof PluginManager !== 'undefined' && PluginManager._parameters && typeof $plugins !== 'undefined') {
                var debuggerPlugin = $plugins.filter(function (a) { return a.name.toLowerCase() === 'yep_debugger'; })[0];
                if (debuggerPlugin) PluginManager._parameters['yep_debugger'] = debuggerPlugin.parameters;
            }
        } catch (e) {}

        await $modLoader.$runScripts('pre_plugin_injection', {
            PluginManager: (typeof PluginManager !== 'undefined' ? PluginManager : undefined),
            $plugins: $plugins
        });

        var gameSupplied = $plugins.map(function (a) { return a.name.toLowerCase(); });
        var pluginLocks = new Set();
        var pluginOrderingRules = new Map();

        $modLoader.knownMods.forEach(function (entry) {
            entry.pluginsDelta.forEach(function (p) {
                var fn = baseNameLower(p);
                pluginLocks.add(fn);
                pluginOrderingRules.set(fn, { culprit: entry, rule: { at: -1 } });
            });
        });
        $modLoader.knownMods.forEach(function (entry) {
            entry.plugins.forEach(function (p) {
                var fn = baseNameLower(p);
                var rule = (entry.json.plugins_ordered && entry.json.plugins_ordered[fn]) || { at: -1 };
                pluginOrderingRules.set(fn, { culprit: entry, rule: rule });
                if (pluginLocks.has(fn)) {
                    warn('plugin conflict on', fn, '(already locked)');
                }
                pluginLocks.add(fn);
            });
        });
        $modLoader.pluginOrderingRules = pluginOrderingRules;
        $modLoader.pluginLocks = pluginLocks;

        var injections = [];
        for (var i = 0; i < $plugins.length + 1; i++) injections.push([]);

        pluginOrderingRules.forEach(function (value, name) {
            var rule = value.rule || {};
            if (rule.after) {
                var anchor = $plugins.findIndex(function (a) { return a.name.toLowerCase() === rule.after.toLowerCase(); });
                rule.at = anchor >= 0 ? anchor + 1 : rule.at;
            }
            var at = rule.at == null ? -1 : rule.at;
            if (at < 0) return;
            if (at >= injections.length) at = injections.length - 1;
            injections[at].push({
                name: name,
                status: true,
                description: 'Modded plugin',
                parameters: {},
                _w: rule.weight || 0
            });
        });

        for (var j = injections.length - 1; j >= 0; j--) {
            if (!injections[j].length) continue;
            injections[j].sort(function (a, b) { return b._w - a._w; });
            $plugins.splice.apply($plugins, [j, 0].concat(injections[j]));
        }

        var postNeg = [], post = [], postPos = [];
        pluginLocks.forEach(function (name) {
            var orderingRule = pluginOrderingRules.get(name);
            var rule = (orderingRule && orderingRule.rule) || {};
            if (gameSupplied.indexOf(name) !== -1) return;
            if (rule.at != null && rule.at >= 0) return;
            var w = rule.weight || 0;
            if (w < 0) postNeg.push({ name: name, status: true, description: 'Modded plugin', parameters: {}, _w: w });
            else if (w > 0) postPos.push({ name: name, status: true, description: 'Modded plugin', parameters: {}, _w: w });
            else post.push({ name: name, status: true, description: 'Modded plugin', parameters: {} });
            log('injected plugin:', name);
        });
        postNeg.sort(function (a, b) { return b._w - a._w; });
        postPos.sort(function (a, b) { return b._w - a._w; });
        $plugins.push.apply($plugins, postPos.concat(post).concat(postNeg));

        // plugin_parameters patches
        $modLoader.knownMods.forEach(function (entry) {
            if (!entry.json.plugin_parameters) return;
            for (var plugin in entry.json.plugin_parameters) {
                var found = $plugins.filter(function (a) { return a.name.toLowerCase() === plugin.toLowerCase(); })[0];
                if (!found) { warn('plugin_parameters: no plugin named', plugin); continue; }
                found.parameters = applyJsonPatch(found.parameters, entry.json.plugin_parameters[plugin], true);
            }
        });
    }

    /* ------------------------------------------------------------------ *
     *  Native IPC bridge.
     *
     *  Mods are NOT persisted anywhere. They are loaded fresh from the
     *  external MOD/modlist.json next to the executable on every launch, so
     *  deleting the MOD/ folder deletes the mods — no cache can resurrect
     *  them. Manual uploads live only for the current session.
     * ------------------------------------------------------------------ */
    var tauriInvoke = (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__ &&
        window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function')
        ? window.__TAURI__.core.invoke
        : null;

    /* ------------------------------------------------------------------ *
     *  Staged mods & upload UI
     * ------------------------------------------------------------------ */
    var stagedMods = []; // { name, size, files, modName, manifest }

    function el(id) { return document.getElementById(id); }

    function modStatus(text, isError) {
        var overlay = el('modStatusOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'modStatusOverlay';
            overlay.style.cssText = 'display:none;flex-direction:column;justify-content:center;align-items:center;' +
                'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.94);' +
                'z-index:2147483646;font-family:GameFont,monospace;color:#fff;text-align:center;padding:24px;box-sizing:border-box;';
            var label = document.createElement('div');
            label.id = 'modStatusLabel';
            label.style.cssText = 'font-size:14px;letter-spacing:2px;max-width:520px;line-height:1.7;';
            overlay.appendChild(label);
            document.body.appendChild(overlay);
        }
        if (!text) { overlay.style.display = 'none'; return; }
        overlay.style.display = 'flex';
        var l = el('modStatusLabel');
        if (l) {
            l.textContent = text;
            l.style.color = isError ? '#f88' : '#fff';
        }
    }

    function renderModList() {
        var list = el('modList');
        var info = el('modInfo');
        var launch = el('zipLaunchButton');
        if (!list) return;
        list.innerHTML = '';
        var totalPlugins = 0, totalFiles = 0;
        stagedMods.forEach(function (m, i) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;' +
                'width:100%;margin:0 0 6px;box-sizing:border-box;' +
                'padding:8px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);border-radius:4px;';
            var label = document.createElement('span');
            label.style.cssText = 'color:#eee;font-size:clamp(13px, 1.8vw, 17px);flex:1;text-align:left;line-height:1.4;';
            var name = m.modName || m.name;
            if (m.manifest) {
                name = (m.manifest.name || m.modName || m.name) +
                    (m.manifest.version ? ' v' + m.manifest.version : '') +
                    (m.manifest.id ? ' [' + m.manifest.id + ']' : '');
                totalPlugins += (m.plugins || []).length;
                totalFiles += m.fileCount || 0;
            }
            label.textContent = name;
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '\u00d7';
            rm.title = 'Remove';
            rm.style.cssText = 'background:rgba(255,255,255,0.12);color:#faa;border:1px solid rgba(255,255,255,0.3);' +
                'border-radius:3px;width:30px;height:30px;line-height:1;cursor:pointer;font:inherit;font-size:16px;';
            rm.onclick = function () { removeStagedMod(i); };
            row.appendChild(label);
            row.appendChild(rm);
            list.appendChild(row);
        });
        if (info) {
            info.textContent = stagedMods.length
                ? stagedMods.length + ' mod(s) staged' + (totalPlugins ? ', ' + totalPlugins + ' plugin(s)' : '') + (totalFiles ? ', ' + totalFiles + ' file(s)' : '')
                : 'No mods. Upload OneLoader .zip mods to enable them.';
        }
        if (launch) {
            launch.textContent = stagedMods.length ? 'LAUNCH (' + stagedMods.length + ' MOD' + (stagedMods.length > 1 ? 'S' : '') + ')' : 'LAUNCH';
        }
    }

    function removeStagedMod(index) {
        stagedMods.splice(index, 1);
        renderModList();
    }

    /* Streaming, worker-free replacement for fflate.unzip() when importing mod
     * archives. fflate.unzip() decides per-entry whether to inflate on the
     * main thread or spin up a brand-new dedicated Worker (its threshold is
     * ~512KB compressed), and does this in an unthrottled loop over every
     * entry in the central directory. A mod built from 4K art/audio (any
     * entry over that threshold) blows that loop wide open: dozens or
     * hundreds of Workers get created at once, each duplicating fflate's
     * bootstrap code and paying a postMessage copy in and out, so actual peak
     * RAM ends up a large multiple of the ~2GB of asset data itself. That's
     * why this hangs/crashes well under 32GB in a normal browser tab while
     * Tauri (with a very different memory ceiling) shrugs it off.
     *
     * Fix: decode with fflate.Unzip's streaming API (the same class the boot
     * loader already uses safely) and register ONLY fflate.UnzipInflate, the
     * synchronous decompressor, so no Worker is ever spawned regardless of
     * entry size. Bytes are fed in slices (plain subarray views, not copies)
     * with a setTimeout(0) between each so the event loop — and the status
     * UI — stays responsive across a long import instead of the tab
     * appearing to freeze for the whole 2GB.
     */
    function unzipModArchive(bytes, onProgress, cb) {
        if (!window.fflate || typeof window.fflate.Unzip !== 'function' ||
            typeof window.fflate.UnzipInflate !== 'function') {
            cb(new Error('fflate.Unzip unavailable'), null);
            return;
        }

        var filesObj = Object.create(null);
        var pending = 0;
        var pushedAll = false;
        var firstError = null;
        var settled = false;

        function finishIfReady() {
            if (settled || !pushedAll || pending > 0) return;
            settled = true;
            if (firstError) cb(firstError, null);
            else cb(null, filesObj);
        }

        var unzipper = new fflate.Unzip(function (file) {
            if (!file.name || /\/$/.test(file.name)) {
                // Directory entry: consume it so the decoder advances, but
                // store nothing.
                file.ondata = function () {};
                file.start();
                return;
            }
            pending++;
            var chunks = [];
            var total = 0;
            var done = false;
            file.ondata = function (err, data, final) {
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
                        filesObj[file.name] = out;
                    }
                    pending--;
                    finishIfReady();
                }
            };
            file.start();
        });
        // Sync-only decompressor: guarantees zero Worker creation no matter
        // how large an individual entry is.
        unzipper.register(fflate.UnzipInflate);

        var CHUNK = 8 * 1024 * 1024; // 8MB feed slices — views, not copies
        var offset = 0;
        var total = bytes.length;

        function pump() {
            if (firstError) { pushedAll = true; finishIfReady(); return; }
            var end = Math.min(offset + CHUNK, total);
            var last = end >= total;
            try {
                unzipper.push(bytes.subarray(offset, end), last);
            } catch (e) {
                if (!firstError) firstError = e;
            }
            offset = end;
            if (onProgress) onProgress(offset, total);
            if (last || firstError) {
                pushedAll = true;
                finishIfReady();
                return;
            }
            setTimeout(pump, 0);
        }
        pump();
    }

    // Cheap pre-scan of a staged mod's OLID image deltas (same semantics as
    // ZipMod.processImageDeltas, without parsing the whole mod): returns the
    // base PNG paths the delta pass will need materialised in the VFS, so
    // boot can prefetch them through the range loader while the LAUNCH
    // screen is still up.
    function collectImageDeltaTargets(manifest, filesObj) {
        var targets = [];
        if (!manifest || !manifest._flags || manifest._flags.indexOf('do_olid') < 0) return targets;
        var deltas = manifest.image_deltas;
        if (!Array.isArray(deltas)) return targets;
        // Derive the mod's root folder from its mod.json location, mirroring
        // ZipMod.locateModJson(), so with-dir scans hit the right keys.
        var root = '';
        for (var n in filesObj) {
            if (/mod\.json$/i.test(normPath(n))) {
                var r = normPath(n).replace(/mod\.json$/i, '').replace(/\/$/, '');
                root = r ? r + '/' : '';
                break;
            }
        }
        var seen = Object.create(null);
        deltas.forEach(function(decl) {
            if (!decl || typeof decl !== 'object') return;
            var patch = normPath(decl.patch);
            if (decl.dir) {
                var prefix = normPath(root + normPath(decl.with));
                prefix = prefix ? prefix + '/' : '';
                var lowerPrefix = prefix.toLowerCase();
                for (var n2 in filesObj) {
                    var norm = normPath(n2);
                    var lower = norm.toLowerCase();
                    if (!lowerPrefix || lower.indexOf(lowerPrefix) !== 0) continue;
                    var rel = norm.slice(prefix.length);
                    if (!rel || rel.indexOf('/') >= 0) continue; // direct children only (like filesInDir)
                    var target = normPath(patch + '/' + rel.replace(/\.olid$/i, '.png'));
                    if (target && !seen[target.toLowerCase()]) {
                        seen[target.toLowerCase()] = true;
                        targets.push(target);
                    }
                }
            } else {
                var t = patch;
                if (t && !seen[t.toLowerCase()]) {
                    seen[t.toLowerCase()] = true;
                    targets.push(t);
                }
            }
        });
        return targets;
    }

    /* Shared entry point: unzip a mod archive's bytes and append it to the
     * staged list. Used by both the manual upload flow and the external
     * MOD/ folder preset so the two stay in sync. */
    function ingestZipBytes(name, bytes, size, onDone) {
        var warnEl = el('modWarn');
        unzipModArchive(bytes, function (done, total) {
            var info = el('modInfo');
            if (info) {
                var pct = total ? Math.round(done / total * 100) : 0;
                info.textContent = 'Unzipping ' + name + '\u2026 ' + pct + '%';
            }
        }, function (err, filesObj) {
            if (err) {
                if (warnEl) warnEl.textContent += name + ': ' + err.message + '; ';
            } else {
                var manifest = null;
                for (var n in filesObj) {
                    if (/mod\.json$/i.test(n)) {
                        try { manifest = JSON.parse(decode(filesObj[n])); } catch (e) {}
                        break;
                    }
                }
                var mod = manifest ? { manifest: manifest, plugins: [], fileCount: 0 } : null;
                if (manifest) {
                    // light pre-scan for status display only
                    var pluginSet = [];
                    var fCount = 0;
                    for (var p in filesObj) { if (!/\/$/.test(p)) fCount++; }
                    ['plugins', 'plugins_delta'].forEach(function (k) {
                        (manifest.files && manifest.files[k] || []).forEach(function (e) { pluginSet.push(String(e)); });
                    });
                    mod.plugins = pluginSet;
                    mod.fileCount = fCount;
                    mod.deltaTargets = collectImageDeltaTargets(manifest, filesObj);
                }
                stagedMods.push({
                    name: name, size: size, files: filesObj, modName: name,
                    manifest: manifest,
                    deltaTargets: mod ? mod.deltaTargets : []
                });
            }
            if (onDone) onDone();
        });
    }

    function addStagedFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        var warnEl = el('modWarn');
        if (warnEl) warnEl.textContent = '';
        var pending = files.length;
        if (!pending) return;
        files.forEach(function (file) {
            if (!/\.(zip|omod)$/i.test(file.name)) {
                if (warnEl) warnEl.textContent += file.name + ': not a .zip; skipped. ';
                pending--;
                if (!pending) renderModList();
                return;
            }
            var reader = new FileReader();
            reader.onload = function () {
                ingestZipBytes(file.name, new Uint8Array(reader.result), file.size, function () {
                    pending--;
                    if (!pending) renderModList();
                });
            };
            reader.readAsArrayBuffer(file);
        });
    }    /* Auto-preset every mod in the external MOD/ folder. In the native build
     * the folder lives next to the executable (never baked into the binary);
     * the Rust `read_modlist` command reads MOD/modlist.json straight from
     * there, and an error means no MOD folder / no list next to the exe, so we
     * stay manual-upload-only. On the web it resolves relative to the host.
     * Each listed zip is then fetched at run and staged, so the uploader
     * starts pre-populated. Resolves once all fetches settle. */
    var _presetPromise = null;
    var _presetSources = Object.create(null);
    function modBaseUrl() {
        return (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__)
            ? 'omori://localhost/MOD'
            : 'MOD';
    }
    // Returns the parsed modlist ({ mods: [...] }) or null when there is no
    // MOD/modlist.json to read (folder missing or list missing).
    function readModlist() {
        if (tauriInvoke) {
            return tauriInvoke('read_modlist').then(function (content) {
                return JSON.parse(content);
            }).catch(function (err) {
                log('preset mods: no MOD/modlist.json next to the executable (' + (err && err.message) + ')');
                return null;
            });
        }
        return fetch('MOD/modlist.json').then(function (r) {
            if (!r.ok) return null;
            return r.json();
        }).catch(function (err) {
            log('preset mods: no MOD/modlist.json (' + (err && err.message) + ')');
            return null;
        });
    }
    // Read one mod zip's bytes. Native build reads straight from MOD/ next to
    // the executable over IPC (no custom-scheme fetch, which WebView2 rejects
    // for arbitrary paths); web fetches relative to the host.
    function loadModZip(clean) {
        if (tauriInvoke) {
            return tauriInvoke('read_asset_file', { path: 'MOD/' + clean }).then(function (b64) {
                if (typeof b64 !== 'string' || !b64) throw new Error('empty response for ' + clean);
                var bin = atob(b64);
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            });
        }
        return fetch(modBaseUrl() + '/' + encodeURIComponent(clean)).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.arrayBuffer();
        }).then(function (buf) { return new Uint8Array(buf); });
    }
    function presetBundledMods() {
        if (_presetPromise) return _presetPromise;
        _presetPromise = readModlist().then(function (list) {
            var mods = (list && list.mods) || [];
            var pending = mods.length;
            if (!pending) { renderModList(); return; }
            return new Promise(function (resolve) {
                var done = function () {
                    pending--;
                    if (pending <= 0) { renderModList(); resolve(); }
                };
mods.forEach(function (name) {
                    var clean = String(name).replace(/^\.\/+/, '');
                    if (_presetSources[clean]) { done(); return; }
                    var fetchPromise = /^https?:\/\//i.test(clean)
                        ? fetch(clean).then(function (resp) {
                            if (!resp.ok) throw new Error('HTTP ' + resp.status);
                            return resp.arrayBuffer();
                        }).then(function (buf) { return new Uint8Array(buf); })
                        : loadModZip(clean);
                    fetchPromise.then(function (bytes) {
                        _presetSources[clean] = true;
                        ingestZipBytes(clean, bytes, bytes.byteLength, done);
                    }).catch(function (err) {
                        var warnEl = el('modWarn');
                        if (warnEl) warnEl.textContent += 'Preset ' + clean + ': ' + err.message + '; ';
                        done();
                    });
                });
            });
        });
        return _presetPromise;
    }

    function handleModUpload(event) {
        addStagedFiles(event.target.files);
        event.target.value = '';
    }

    function setupUI() {
        var input = el('modFileInput');
        if (input) input.addEventListener('change', handleModUpload);

        // Surface the uploader + saves panel when the LAUNCH button becomes visible.
        var timer = setInterval(function () {
            var launch = el('zipLaunchButton');
            var uploader = el('modUploader');
            var saves = el('saveUploader');
            if (launch && uploader && launch.style.display !== 'none') {
                uploader.style.display = 'block';
                if (saves) saves.style.display = 'flex';
                clearInterval(timer);
            }
        }, 250);

        renderModList();

        // Start fetching the bundled MOD/ folder mods immediately so they
        // appear in the list while assets are still downloading.
        presetBundledMods();
    }

    /* ------------------------------------------------------------------ *
     *  Boot integration
     * ------------------------------------------------------------------ */
    function hideProgress() {
        var bar = el('zipProgress');
        if (bar) bar.style.display = 'none';
    }

    /* ------------------------------------------------------------------ *
     *  Post-launch startup screen
     *
     *  Clicking LAUNCH tears the launcher down instantly, but the game is
     *  not on screen yet: staged mods still have to be parsed and applied,
     *  the mod lifecycle scripts run, the enabled plugins load in order, and
     *  SceneManager finally builds the canvas and renderer. That stretch used
     *  to be a black screen; this overlay keeps a progress bar up for exactly
     *  that window and tears itself down the moment Graphics.initialize()
     *  has created the canvas.
     * ------------------------------------------------------------------ */
    var PP_STAGES = {
        launch:   { label: 'Preparing…',          ceiling: 6  },
        mods:     { label: 'Installing mods',     ceiling: 22 },
        scripts:  { label: 'Running mod scripts', ceiling: 32 },
        plugins:  { label: 'Loading plugins',     ceiling: 84 },
        renderer: { label: 'Building renderer',   ceiling: 99 }
    };

    var _pp = null;           // { overlay, fill, label, pct }
    var _ppShown = 0;         // percent currently painted
    var _ppCeiling = 0;       // percent the current stage may creep toward
    var _ppStage = null;
    var _ppTimer = null;
    var _ppDone = false;
    var _ppPluginsSeen = 0;
    var _ppPluginsTotal = 0;

    // Inline z-index is wiped by Graphics._modifyExistingElements() (it zeroes
    // every element with a positive inline z-index), so the overlay's stacking
    // is declared in a stylesheet instead and survives until we remove it.
    function ppEnsureStyle() {
        if (document.getElementById('postProcessStyle')) return;
        var style = document.createElement('style');
        style.id = 'postProcessStyle';
        style.textContent = '#postProcess{z-index:2147483647;}';
        document.head.appendChild(style);
    }

    function ppCreate() {
        ppEnsureStyle();
        var overlay = document.createElement('div');
        overlay.id = 'postProcess';
        overlay.style.cssText = 'display:none;flex-direction:column;justify-content:center;align-items:center;' +
            'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;font-family:GameFont,monospace;' +
            'color:#fff;text-align:center;padding:24px;box-sizing:border-box;';

        var box = document.createElement('div');
        box.style.cssText = 'width:min(460px,86vw);display:flex;flex-direction:column;align-items:center;' +
            'border:2px solid #fff;padding:26px 22px 30px;box-sizing:border-box;';

        var title = document.createElement('div');
        title.textContent = 'STARTING UP';
        title.style.cssText = 'font-size:clamp(15px,2.6vw,21px);letter-spacing:4px;color:#ccc;margin-bottom:18px;';

        var track = document.createElement('div');
        track.style.cssText = 'width:100%;height:8px;background:#222;border:1px solid #444;' +
            'border-radius:4px;overflow:hidden;';

        var fill = document.createElement('div');
        fill.style.cssText = 'width:0%;height:100%;border-radius:4px;' +
            'background:linear-gradient(90deg,#6a5acd,#b19cd9);transition:width .25s ease;';
        track.appendChild(fill);

        var label = document.createElement('div');
        label.style.cssText = 'font-size:12px;letter-spacing:1px;color:#aaa;margin-top:12px;min-height:15px;';

        var pct = document.createElement('div');
        pct.style.cssText = 'font-size:11px;letter-spacing:2px;color:#777;margin-top:6px;';

        // Long mod/plugin stages can sit on one step for a while; make it clear
        // that a stalled-looking bar is expected and that reloading would throw
        // the whole download away.
        var note = document.createElement('div');
        note.id = 'postProcessNote';
        note.textContent = 'Do not close or reload this page; startup can take a while, or the bar may pause before it moves again.';
        note.style.cssText = 'font-size:22px;line-height:1.6;color:#888;margin-top:16px;max-width:330px;';

        box.appendChild(title);
        box.appendChild(track);
        box.appendChild(label);
        box.appendChild(pct);
        box.appendChild(note);
        overlay.appendChild(box);
        _pp = { overlay: overlay, fill: fill, label: label, pct: pct, note: note };
    }

    function ppPaint() {
        if (!_pp) return;
        var stage = PP_STAGES[_ppStage] || PP_STAGES.launch;
        _pp.label.textContent = stage.label;
        _pp.fill.style.width = Math.round(_ppShown) + '%';
        _pp.pct.textContent = Math.round(_ppShown) + '%';
    }

    // Creep toward the stage ceiling so the bar keeps moving during stages
    // whose length cannot be measured (mod parsing, mod script execution).
    function ppTick() {
        if (_ppDone || !_pp) return;
        if (_ppShown < _ppCeiling) {
            _ppShown = Math.min(_ppCeiling, _ppShown + Math.max(0.2, (_ppCeiling - _ppShown) * 0.07));
            ppPaint();
        }
    }

    function postProcessBegin() {
        if (_ppDone) return;
        if (!_pp) ppCreate();
        // Re-append so the overlay paints over the save panel that this same
        // click relocated to the corner.
        document.body.appendChild(_pp.overlay);
        _pp.overlay.style.display = 'flex';
        _ppStage = 'launch';
        _ppCeiling = PP_STAGES.launch.ceiling;
        _ppShown = 0;
        ppPaint();
        if (!_ppTimer) _ppTimer = setInterval(ppTick, 120);
    }

    function postProcessStage(name) {
        if (_ppDone || !_pp || !PP_STAGES[name]) return;
        _ppStage = name;
        _ppCeiling = Math.max(_ppCeiling, PP_STAGES[name].ceiling);
        if (name === 'plugins') {
            _ppPluginsSeen = 0;
            _ppPluginsTotal = 0;
            if (typeof $plugins !== 'undefined' && $plugins && $plugins.length) {
                for (var i = 0; i < $plugins.length; i++) {
                    if ($plugins[i].status) _ppPluginsTotal++;
                }
            }
        }
        ppPaint();
    }

    // Called from the PluginManager.loadScript hook: plugin loading is the
    // longest stage, so real script loads drive the bar instead of the creep.
    function postProcessPluginLoaded() {
        if (_ppDone || !_pp || _ppStage !== 'plugins' || !_ppPluginsTotal) return;
        _ppPluginsSeen++;
        var base = PP_STAGES.scripts.ceiling;
        var span = PP_STAGES.plugins.ceiling - base;
        _ppCeiling = Math.max(_ppCeiling, base + Math.min(1, _ppPluginsSeen / _ppPluginsTotal) * span);
    }

    function postProcessDetail(text) {
        if (_ppDone || !_pp) return;
        _pp.label.textContent = text;
    }

    function postProcessFinish() {
        if (_ppDone) return;
        _ppDone = true;
        if (_ppTimer) { clearInterval(_ppTimer); _ppTimer = null; }
        if (!_pp) return;
        // Snap the bar full and crossfade into the freshly built canvas rather
        // than yanking the overlay away mid-creep.
        var overlay = _pp.overlay;
        _pp.fill.style.width = '100%';
        _pp.pct.textContent = '100%';
        _pp.label.textContent = 'Ready';
        _pp = null;
        overlay.style.transition = 'opacity .3s ease';
        void overlay.offsetWidth;
        overlay.style.opacity = '0';
        setTimeout(function () {
            overlay.style.display = 'none';
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 340);
    }

    function postProcessFail(message) {
        if (_ppDone || !_pp) return;
        _ppDone = true;
        if (_ppTimer) { clearInterval(_ppTimer); _ppTimer = null; }
        _pp.label.textContent = message ? ('Startup failed: ' + message) : 'Startup failed';
        _pp.label.style.color = '#f88';
        if (_pp.note) _pp.note.style.display = 'none';
        _pp.pct.textContent = '';
    }

    // The canvas and renderer are built inside Graphics.initialize(), and no
    // plugin overrides that call, so wrapping it marks the exact end of the
    // startup window the player is waiting on.
    (function installStartupHooks() {
        if (typeof Graphics !== 'undefined' && typeof Graphics.initialize === 'function') {
            var _origGraphicsInitialize = Graphics.initialize;
            Graphics.initialize = function () {
                postProcessStage('renderer');
                var result = _origGraphicsInitialize.apply(this, arguments);
                postProcessFinish();
                return result;
            };
        }
        if (typeof PluginManager !== 'undefined' && typeof PluginManager.loadScript === 'function') {
            var _origLoadScript = PluginManager.loadScript;
            PluginManager.loadScript = function () {
                postProcessPluginLoaded();
                return _origLoadScript.apply(this, arguments);
            };
        }
    })();

    var _applied = false;
    async function applyStagedMods() {
        if (_applied || !stagedMods.length) return 0;
        _applied = true;
        modStatus('Applying ' + stagedMods.length + ' mod(s)...');
        postProcessDetail('Installing mods…');
        var mods = [];
        for (var i = 0; i < stagedMods.length; i++) {
            var s = stagedMods[i];
            modStatus('Parsing ' + s.name + '...');
            postProcessDetail('Installing ' + s.name + '…');
            try {
                var mod = await parseMod(s.name, s.files);
                mods.push(mod);
                log('parsed', mod.json.id || s.name, 'v' + (mod.json.version || '?'), '(' + mod.entries.length + ' files, ' + mod.plugins.length + ' plugins)');
            } catch (e) {
                warn('failed to parse', s.name, ':', e && e.message);
                modStatus('Skipped ' + s.name + ': ' + (e && e.message), true);
            }
        }
        if (!mods.length) {
            modStatus('');
            return 0;
        }
        postProcessDetail('Applying mod files…');
        var injected = await applyAllMods(mods);
        modStatus('Applied ' + mods.length + ' mod(s) — ' + injected + ' file(s)');
        return injected;
    }

    // Background boot task: pull the base images that staged mods' OLID
    // image deltas patch through ZipLoader's range loader (see
    // ZipLoader.prefetchMedia) so the post-launch applyImageDeltas pass
    // finds them already in the VFS. Fire-and-forget; never blocks launch.
    function prefetchStagedDeltaTargets() {
        if (!window.ZipLoader || typeof window.ZipLoader.prefetchMedia !== 'function') return;
        var targets = [];
        var seen = Object.create(null);
        stagedMods.forEach(function (m) {
            (m.deltaTargets || []).forEach(function (t) {
                var key = t.toLowerCase();
                if (seen[key]) return;
                seen[key] = true;
                targets.push(t);
            });
        });
        if (!targets.length) return;
        log('prefetching ' + targets.length + ' base image(s) for staged image deltas');
        window.ZipLoader.prefetchMedia(targets).then(function () {
            log('image delta base prefetch finished (' + targets.length + ' target(s))');
        });
    }

    function boot(startGame) {
        var ready = (typeof ZipLoader !== 'undefined' && ZipLoader.init)
            ? ZipLoader.init().then(function () {
                // Stage the MOD/ folder mods while the loading screen is still
                // up, then start grabbing the base images their OLID deltas
                // will patch through the range loader — so by the time the
                // player presses LAUNCH the delta pass finds every target
                // already materialised in the VFS instead of stalling on
                // first-request part fetches. The prefetch itself is
                // fire-and-forget: the LAUNCH click just resolves the wait
                // below once staging has settled.
                return presetBundledMods().then(function () {
                    prefetchStagedDeltaTargets();
                });
            }).then(ZipLoader.waitForLaunch)
            : Promise.resolve(true);
        ready.then(function () {
            // Only the explicit LAUNCH hand-off leads into the startup window.
            if (typeof ZipLoader !== 'undefined' && ZipLoader.isLaunched && ZipLoader.isLaunched()) {
                postProcessBegin();
            }
            postProcessStage('mods');
            return applyStagedMods();
        }).then(function () {
            postProcessStage('scripts');
            // Lifecycle hooks asyncExec scripts register into ($modLoader.$execScripts).
            return $modLoader.$runScripts('pre_game_start', {});
        }).then(function () {
            return $modLoader.$runScripts('pre_window_onload', {});
        }).then(function () {
            modStatus('');
            hideProgress();
            postProcessStage('plugins');
            return startGame();
        }).catch(function (err) {
            console.error('[ModLoader] boot failed:', err);
            modStatus('Mod loading failed: ' + (err && err.message), true);
            postProcessFail(err && err.message);
        });
    }

    /* ------------------------------------------------------------------ *
     *  Public API
     * ------------------------------------------------------------------ */
    window.ModLoader = {
        boot: boot,
        applyStagedMods: applyStagedMods,
        handleModUpload: handleModUpload,
        addStagedFiles: addStagedFiles,
        presetBundledMods: presetBundledMods,
        removeStagedMod: removeStagedMod,
        getStagedMods: function () { return stagedMods.slice(); },
        parseMod: parseMod,
        applyAllMods: applyAllMods,
        _internals: {
            ZipMod: ZipMod,
            applyJsonPatch: applyJsonPatch,
            parseYaml: parseYaml,
            dumpYaml: dumpYaml,
            decryptSteam: decryptSteam,
            DATA_RULES: DATA_RULES
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupUI);
    else setupUI();

    log('ready');
})();
