        (function() {
            'use strict';
            
            if (typeof Buffer === 'undefined') {
                window.Buffer = class Buffer extends Uint8Array {
                    constructor(data) {
                        super(typeof data === 'string' ? new TextEncoder().encode(data) : data);
                    }
                    static from(data) { return new Uint8Array(typeof data === 'string' ? new TextEncoder().encode(data) : data); }
                    static concat(list, totalLength) {
                        if (!Array.isArray(list)) list = Array.prototype.slice.call(list);
                        var total = totalLength;
                        if (total === undefined || total === null) {
                            total = 0;
                            for (var bi = 0; bi < list.length; bi++) total += list[bi] ? list[bi].length : 0;
                        }
                        var out = new Uint8Array(total);
                        var off = 0;
                        for (var bj = 0; bj < list.length; bj++) {
                            var b = list[bj];
                            if (!b) continue;
                            out.set(b, off);
                            off += b.length;
                        }
                        return new Buffer(out);
                    }
                    toString() { return new TextDecoder('utf-8').decode(this); }
                };
            }
            
            // The unified VFS bridge (site/vfs_bridge.js) owns the shared
            // memoryFS and all fs path/persistence logic. Make sure the shared
            // store exists so o1.js can repopulate it from IndexedDB on boot.
            if (!window.__memoryFS) window.__memoryFS = {};

            window.require = function(mod) {
                const cleanMod = window.stripSdcardPath ? window.stripSdcardPath(mod) : mod;
                if (cleanMod === 'fs') {
                    return {
                        readdirSync: function(dirPath) {
                            // Delegate to the merged VFS so audio/image/language
                            // listings include both base archives and mod overrides.
                            var vfs = window.OVFS;
                            var list = vfs ? vfs.list(dirPath) : [];
                            if (list.length > 0) return list;
                            // Fallback for local dev where languages.zip isn't in
                            // the VFS: return the known English file list.
                            var normalized = (dirPath || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
                            if (normalized.includes('languages/en') || normalized.includes('languages\\en')) {
                                return ['00_Bf_Dialogue.yaml','00_template.yaml','01_cutscenes_neighbors.yaml','01_map_whitespace.yaml','02_cutscenes_hideandseek.yaml','02_cutscenes_lostball.yaml','02_map_neighborsroom.yaml','03_cutscenes_basil.yaml','04_cutscenes_blackletters.yaml','05_cutscenes_spaceboyfriend.yaml','06_cutscenes_junkyard.yaml','07_cutscenes_spaceexboyfriend.yaml','08_cutscenes_captspaceboy.yaml','09_cutscenes_hobbeez.yaml','10_cutscenes_fakeknifefight.yaml','11_cutscenes_stolenalbum_pt1.yaml','12_cutscenes_stolenalbum_pt2.yaml','13_cutscenes_dinneratbasils.yaml','14_cutscenes_sweetheartquest.yaml','15_cutscenes_herothebachelor.yaml','16_cutscenes_thewedding.yaml','17_cutscenes_pollysworry.yaml','18_cutscenes_secretlake.yaml','19_cutscenes_kelshouse.yaml','20_cutscenes_sleepover.yaml','21_cutscenes_lastresort.yaml','22_cutscenes_humphrey.yaml','23_cutscenes_slimegirls.yaml','24_cutscenes_finalboss.yaml','25_cutscenes_blackhole.yaml','26_cutscenes_aubrey.yaml','27_cutscenes_treehouse.yaml','28_cutscenes_helpbasil.yaml','29_cutscenes_basilsplea.yaml','ALBUM.yaml','ALBUM_test.yaml','Bestiary.yaml','Database.yaml','System.yaml','TEST.yaml','XX_BLUE.yaml','XX_GENERAL.yaml','XX_ITEM_GET.yaml','XX_MARI_LOCATIONS.yaml','XX_MELON.yaml','XX_OCEAN.yaml','XX_QUEST.yaml','XX_QUEST_TRACKER.yaml','XX_SKILL_GET.yaml','XX_SYSTEM.yaml','XX_TAGREJECT.yaml','art_sculpture.yaml','basils_deathtrap.yaml','basils_finalmemories.yaml','basils_memories.yaml','basils_path.yaml','battle_book.yaml','black_space_flavor_text.yaml','black_space_rev.yaml','blackjack_minigame.yaml','blackspace_intro.yaml','breaktime_chatter.yaml','bs_basils_shadow.yaml','dreamworld_extras_blackspace.yaml','dreamworld_extras_dinosdig.yaml','dreamworld_extras_doomtomb.yaml','dreamworld_extras_misc.yaml','dreamworld_extras_objectflavor.yaml','dreamworld_extras_pyrefly.yaml','dreamworld_extras_shop.yaml','dreamworld_extras_slimegirls.yaml','dreamworld_lost_forest.yaml','dreamworld_npc_dialogue.yaml','dreamworld_npc_dialogue_forgottenpier.yaml','dreamworld_npc_dialogue_frozenforest.yaml','dreamworld_npc_dialogue_lastresort.yaml','dreamworld_npc_dialogue_orangeoasis.yaml','dreamworld_npc_dialogue_otherworld.yaml','dreamworld_npc_dialogue_pinwheel.yaml','dreamworld_npc_dialogue_playground.yaml','dreamworld_npc_dialogue_pyrefly_doomtomb.yaml','dreamworld_npc_dialogue_slimegirls.yaml','dreamworld_npc_dialogue_sproutmole_sweetheart.yaml','dreamworld_npc_dialogue_sweetheart.yaml','dreamworld_npc_dialogue_whitespace.yaml','dw_boss_rush.yaml','dw_flavor_text.yaml','dw_hero_charm.yaml','dw_map_of_truth.yaml','fa_fridges.yaml','fa_map_flavor.yaml','faraway_conditional.yaml','faraway_kels_room.yaml','faraway_something_about_basil.yaml','farawaytown_day3_friends.yaml','farawaytown_dialogue_day1_day.yaml','farawaytown_dialogue_day1_sunset.yaml','farawaytown_dialogue_day2_day.yaml','farawaytown_dialogue_day2_sunset.yaml','farawaytown_dialogue_day3_day.yaml','farawaytown_dialogue_day3_sunset.yaml','farawaytown_dialogue_strangers.yaml','farawaytown_dialogue_tucker.yaml','farawaytown_extradialogue.yaml','farawaytown_extras_dailydialogue.yaml','farawaytown_extras_endings.yaml','farawaytown_extras_fears.yaml','farawaytown_extras_hardwareminigame.yaml','farawaytown_extras_marinight.yaml','farawaytown_extras_mavericks.yaml','farawaytown_extras_misc.yaml','farawaytown_extras_momsdialogue.yaml','farawaytown_extras_objectflavor.yaml','farawaytown_extras_petrock.yaml','farawaytown_extras_pizzaminigame.yaml','farawaytown_extras_shop.yaml','farawaytown_extras_supermarketminigame.yaml','gacha_minigame.yaml','hidden_library.yaml','hide_and_seek.yaml','kel_errands.yaml','menus.yaml','miscellanous_dialogues.yaml','new_npcs.yaml','npc_general.yaml','party_dialogue.yaml','pluto.yaml','sidequest_dreamworld_bed.yaml','sidequest_dreamworld_coffeemachine.yaml','sidequest_dreamworld_crowfriends.yaml','sidequest_dreamworld_deliversprout.yaml','sidequest_dreamworld_demonboy.yaml','sidequest_dreamworld_feedhumphrey.yaml','sidequest_dreamworld_fliphim.yaml','sidequest_dreamworld_flowerpuzzle.yaml','sidequest_dreamworld_ghostgathering.yaml','sidequest_dreamworld_hector.yaml','sidequest_dreamworld_hectorjr.yaml','sidequest_dreamworld_ingredients.yaml','sidequest_dreamworld_itch.yaml','sidequest_dreamworld_jash.yaml','sidequest_dreamworld_lostrarebear.yaml','sidequest_dreamworld_lostson.yaml','sidequest_dreamworld_marina.yaml','sidequest_dreamworld_medusa.yaml','sidequest_dreamworld_molly.yaml','sidequest_dreamworld_mush.yaml','sidequest_dreamworld_oragne.yaml','sidequest_dreamworld_peanutjelly.yaml','sidequest_dreamworld_perfectwind.yaml','sidequest_dreamworld_pinkbeard.yaml','sidequest_dreamworld_poolnoodle.yaml','sidequest_dreamworld_rabbitkiller.yaml','sidequest_dreamworld_recycle.yaml','sidequest_dreamworld_seasons.yaml','sidequest_dreamworld_squizzards.yaml','sidequest_dreamworld_stargazing.yaml','sidequest_dreamworld_stolen.yaml','sidequest_dreamworld_stoprain.yaml','sidequest_dreamworld_tentacle.yaml','sidequest_farawaytown_anniversarychoco.yaml','sidequest_farawaytown_anniversarypizza.yaml','sidequest_farawaytown_artist.yaml','sidequest_farawaytown_birthdaygift1.yaml','sidequest_farawaytown_birthdaygift2.yaml','sidequest_farawaytown_bringangel.yaml','sidequest_farawaytown_brushteeth.yaml','sidequest_farawaytown_claus.yaml','sidequest_farawaytown_cooking.yaml','sidequest_farawaytown_fixarcademachine.yaml','sidequest_farawaytown_fixpipe.yaml','sidequest_farawaytown_flower.yaml','sidequest_farawaytown_forgotmeat.yaml','sidequest_farawaytown_fruitwaradrian.yaml','sidequest_farawaytown_fruitwarbrayden.yaml','sidequest_farawaytown_ginohighscore.yaml','sidequest_farawaytown_ginojukebox.yaml','sidequest_farawaytown_hobbeezhighscore.yaml','sidequest_farawaytown_jackson.yaml','sidequest_farawaytown_lostlucas.yaml','sidequest_farawaytown_medication.yaml','sidequest_farawaytown_michaelslunch.yaml','sidequest_farawaytown_michaelthemusician.yaml','sidequest_farawaytown_mincy.yaml','sidequest_farawaytown_missingshears.yaml','sidequest_farawaytown_mypie.yaml','sidequest_farawaytown_oldhobo.yaml','sidequest_farawaytown_pickingpaint.yaml','sidequest_farawaytown_pickupfurniture.yaml','sidequest_farawaytown_ringinthesink.yaml','sidequest_farawaytown_seashells.yaml','sidequest_farawaytown_shutin.yaml','sidequest_farawaytown_smellyhobo.yaml','sidequest_farawaytown_sneakingoutbrent.yaml','sidequest_farawaytown_sneakingoutjoy.yaml','sidequest_farawaytown_toiletseat.yaml','sidequest_farawaytown_trashpickup.yaml','sidequest_farawaytown_tutorbrent.yaml','sidequest_farawaytown_tutorjoy.yaml','sidequest_farawaytown_wherestheremote.yaml','signs.yaml','slot_machine_minigame.yaml','snaley_tragedy.yaml','televisions.yaml','wtf.yaml','xx_battle_text.yaml','xx_cutscenes_ems.yaml','xx_map_expansion.yaml','xx_tombstones.yaml'];
                            }
                            return [];
                        },
                        readFileSync: function(path, options) {
                            var vfs = window.OVFS;
                            if (!vfs) return '';
                            var enc = typeof options === 'string' ? options : (options && options.encoding);
                            if (enc && /utf-?8/i.test(String(enc))) return vfs.readTextSync(path);
                            // No encoding requested -> Node returns a Buffer (bytes).
                            if (vfs.readBytes) {
                                var bytes = vfs.readBytes(path);
                                if (bytes && bytes.length) return typeof Buffer !== 'undefined' ? Buffer.from(bytes) : bytes;
                            }
                            return vfs.readTextSync(path);
                        },
                        existsSync: function(path) {
                            var vfs = window.OVFS;
                            return vfs ? vfs.exists(path) : false;
                        },
                        mkdirSync: function(dirPath) { return true; },
                        unlinkSync: function(path) {
                            var vfs = window.OVFS;
                            if (vfs) vfs.remove(path);
                        },
                        writeFileSync: function(path, data) {
                            var vfs = window.OVFS;
                            if (!vfs) return;
                            if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && data instanceof Buffer)) {
                                if (vfs.writeBytes) { vfs.writeBytes(path, data); return; }
                                data = new TextDecoder('utf-8').decode(data);
                            }
                            vfs.write(path, String(data));
                        },
                        writeFile: function(path, data, callback) {
                            this.writeFileSync(path, data);
                            if (typeof callback === 'function') {
                                setTimeout(function() { callback(null); }, 0);
                            }
                        },
                        readFile: function(path, options, callback) {
                            if (typeof options === 'function') {
                                callback = options;
                                options = null;
                            }
                            var content = this.readFileSync(path, options);
                            if (typeof callback === 'function') {
                                setTimeout(function() { callback(null, content); }, 0);
                            }
                        },
                        readdir: function(dirPath, callback) {
                            var list = this.readdirSync(dirPath);
                            if (typeof callback === 'function') setTimeout(function() { callback(null, list); }, 0);
                            return list;
                        },
                        statSync: function(path) {
                            var vfs = window.OVFS;
                            var isDir = !!(vfs && vfs.list && vfs.list(path).length > 0);
                            var bytes = (vfs && vfs.readBytes) ? vfs.readBytes(path) : null;
                            return {
                                isFile: function() { return !isDir; },
                                isDirectory: function() { return isDir; },
                                isSymbolicLink: function() { return false; },
                                size: bytes ? bytes.length : 0,
                                mtimeMs: Date.now(),
                                mode: 33206
                            };
                        },
                        stat: function(path, callback) {
                            var st = this.statSync(path);
                            if (typeof callback === 'function') setTimeout(function() { callback(null, st); }, 0);
                            return st;
                        },
                        lstatSync: function(path) { return this.statSync(path); },
                        lstat: function(path, callback) { return this.stat(path, callback); },
                        renameSync: function(oldPath, newPath) {
                            var vfs = window.OVFS;
                            if (!vfs) return;
                            var bytes = vfs.readBytes ? vfs.readBytes(oldPath) : null;
                            if (bytes && bytes.length) {
                                if (vfs.writeBytes) vfs.writeBytes(newPath, bytes);
                                else vfs.write(newPath, new TextDecoder('utf-8').decode(bytes));
                            } else {
                                vfs.write(newPath, vfs.readTextSync(oldPath));
                            }
                            vfs.remove(oldPath);
                        },
                        rename: function(oldPath, newPath, callback) {
                            try {
                                this.renameSync(oldPath, newPath);
                                if (typeof callback === 'function') setTimeout(function() { callback(null); }, 0);
                            } catch (e) {
                                if (typeof callback === 'function') setTimeout(function() { callback(e); }, 0);
                                else throw e;
                            }
                        },
                        appendFileSync: function(path, data) {
                            var vfs = window.OVFS;
                            if (!vfs) return;
                            var cur = vfs.readTextSync(path) || '';
                            var add = (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && data instanceof Buffer))
                                ? new TextDecoder('utf-8').decode(data) : String(data == null ? '' : data);
                            vfs.write(path, cur + add);
                        },
                        appendFile: function(path, data, callback) {
                            if (typeof data === 'function') { callback = data; data = ''; }
                            try { this.appendFileSync(path, data); if (typeof callback === 'function') setTimeout(function() { callback(null); }, 0); }
                            catch (e) { if (typeof callback === 'function') setTimeout(function() { callback(e); }, 0); else throw e; }
                        }
                    };
                }
                if (cleanMod === 'util' || cleanMod === 'node:util') {
                    return {
                        promisify: function(fn) {
                            return function() {
                                var args = [].slice.call(arguments);
                                return new Promise(function(resolve, reject) {
                                    args.push(function(err, value) {
                                        if (err) reject(err instanceof Error ? err : new Error(String(err)));
                                        else resolve(value);
                                    });
                                    try { fn.apply(this, args); } catch (e) { reject(e); }
                                });
                            };
                        },
                        callbackify: function(fn) {
                            return function() {
                                var args = [].slice.call(arguments);
                                var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
                                var out;
                                try { out = fn.apply(this, args); } catch (e) { if (cb) { cb(e); return; } throw e; }
                                if (out && typeof out.then === 'function') {
                                    out.then(function(v) { if (cb) cb(null, v); }, function(e) { if (cb) cb(e); });
                                } else if (cb) {
                                    cb(null, out);
                                }
                                return out;
                            };
                        },
                        inherits: function(ctor, superCtor) {
                            if (Object.setPrototypeOf) Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
                            else ctor.prototype = Object.create(superCtor.prototype);
                            ctor.super_ = superCtor;
                        },
                        format: function(fmt) {
                            var args = [].slice.call(arguments, 1);
                            if (typeof fmt !== 'string') return [fmt].concat(args).join(' ');
                            return String(fmt).replace(/%[sdjifoO%]/g, function(m) {
                                if (m === '%%') return '%';
                                var v = args.shift();
                                if (m === '%j') return JSON.stringify(v);
                                return String(v);
                            });
                        },
                        isArray: Array.isArray,
                        isString: function(v) { return typeof v === 'string'; },
                        isNumber: function(v) { return typeof v === 'number'; },
                        isBoolean: function(v) { return typeof v === 'boolean'; },
                        isObject: function(v) { return v !== null && typeof v === 'object'; },
                        isFunction: function(v) { return typeof v === 'function'; },
                        isNullOrUndefined: function(v) { return v === null || v === undefined; },
                        types: {}
                    };
                }
                if (cleanMod === 'zlib' || cleanMod === 'node:zlib') {
                    function zlibEngine() {
                        return window.fflate || (typeof fflate !== 'undefined' ? fflate : null);
                    }
                    function inflateBytes(buf) {
                        var z = zlibEngine();
                        var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
                        if (!z) return u8;
                        if (typeof z.unzlibSync === 'function') return z.unzlibSync(u8);
                        if (typeof z.inflateSync === 'function') return z.inflateSync(u8);
                        return u8;
                    }
                    function deflateBytes(buf, level) {
                        var z = zlibEngine();
                        var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
                        if (!z) return u8;
                        if (typeof z.zlibSync === 'function') return z.zlibSync(u8, { level: level });
                        if (typeof z.deflateSync === 'function') return z.deflateSync(u8, { level: level });
                        return u8;
                    }
                    function asyncWrap(fn) {
                        return function(buf, options, callback) {
                            if (typeof options === 'function') { callback = options; options = undefined; }
                            var out;
                            try { out = fn(buf, options); } catch (e) { if (typeof callback === 'function') setTimeout(function() { callback(e); }, 0); return out; }
                            if (typeof callback === 'function') setTimeout(function() { callback(null, out); }, 0);
                            return out;
                        };
                    }
                    return {
                        inflateSync: inflateBytes,
                        unzlibSync: inflateBytes,
                        gunzipSync: inflateBytes,
                        inflateRawSync: inflateBytes,
                        deflateSync: deflateBytes,
                        zlibSync: deflateBytes,
                        gzipSync: deflateBytes,
                        deflateRawSync: deflateBytes,
                        inflate: asyncWrap(inflateBytes),
                        unzlib: asyncWrap(inflateBytes),
                        gunzip: asyncWrap(inflateBytes),
                        deflate: asyncWrap(deflateBytes),
                        zlib: asyncWrap(deflateBytes),
                        gzip: asyncWrap(deflateBytes),
                        constants: {}
                    };
                }
                if (cleanMod === 'process' || cleanMod === 'node:process') {
                    return window.process || {};
                }
                if (cleanMod === 'path') {
                    return {
                        // FIX: Boolean).join
                        join: (...args) => args.filter(Boolean).join('/').replace(/\/+/g, '/'),
                        dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '.',
                        basename: (p, ext) => {
                            var b = String(p).split('/').filter(Boolean).pop() || '';
                            if (ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length);
                            return b;
                        },
                        extname: (p) => {
                            var b = String(p).split('/').pop() || '';
                            var i = b.lastIndexOf('.');
                            return i > 0 ? b.slice(i) : '';
                        },
                        parse: (p) => {
                            var s = String(p).replace(/\\/g, '/');
                            var isAbs = s.charAt(0) === '/';
                            var parts = s.split('/');
                            var base = parts.pop() || '';
                            var ext = '';
                            var name = base;
                            var extIdx = base.lastIndexOf('.');
                            if (extIdx > 0) { ext = base.slice(extIdx); name = base.slice(0, extIdx); }
                            var dir = parts.join('/');
                            if (isAbs) dir = '/' + dir.replace(/^\/+/, '');
                            if (dir === '') dir = isAbs ? '/' : '.';
                            return { root: isAbs ? '/' : '', dir: dir, base: base, ext: ext, name: name };
                        },
                        normalize: (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, ''),
                        resolve: (...args) => args.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+/, '/'),
                        sep: '/'
                    };
                }
                if (cleanMod === 'os' || cleanMod === 'node:os') {
                    // Minimal Node `os` shim. Desktop mods use os.platform() to
                    // branch on OS (e.g. Run in Background's macOS blur hook).
                    // Detect the real host from the UA so the same branch the
                    // user's OS would take in NW.js is taken here too.
                    var __osPlatform = 'linux';
                    try {
                        var __ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
                        if (/Mac|iPhone|iPad|iPod/i.test(__ua)) __osPlatform = 'darwin';
                        else if (/Win/i.test(__ua)) __osPlatform = 'win32';
                    } catch (e) {}
                    return {
                        platform: function () { return __osPlatform; },
                        type: function () {
                            return __osPlatform === 'darwin' ? 'Darwin' : (__osPlatform === 'win32' ? 'Windows_NT' : 'Linux');
                        },
                        arch: function () { return 'x64'; },
                        release: function () { return 'unknown'; },
                        hostname: function () { return 'localhost'; },
                        homedir: function () { return '/'; },
                        tmpdir: function () { return '/tmp'; },
                        endianness: function () { return 'LE'; },
                        EOL: '\n',
                        cpus: function () { return []; },
                        freemem: function () { return 0; },
                        totalmem: function () { return 0; },
                        uptime: function () { return 0; },
                        loadavg: function () { return [0, 0, 0]; },
                        networkInterfaces: function () { return {}; },
                        userInfo: function () { return { username: 'player', homedir: '/' }; }
                    };
                }
                if (cleanMod === 'nw.gui') return window.nw;
                if (cleanMod.includes('js-yaml')) {
                    // Robust YAML parser for browser
                    function stripInlineComment(val) {
                        var inQ = false;
                        var qCh = '';
                        for (var i = 0; i < val.length; i++) {
                            var ch = val[i];
                            if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qCh = ch; continue; }
                            if (inQ && ch === qCh) { inQ = false; qCh = ''; continue; }
                            if (!inQ && ch === '#') { return val.substring(0, i).trim(); }
                        }
                        return val.trim();
                    }
                    function parseYamlValue(val) {
                        val = stripInlineComment(val);
                        if (val === '' || val === 'null' || val === '~') return undefined;
                        if (val === 'true') return true;
                        if (val === 'false') return false;
                        if ((val.startsWith('{') && val.endsWith('}')) ||
                            (val.startsWith('[') && val.endsWith(']'))) {
                            try {
                                return parseFlow(val);
                            } catch(e) { return val; }
                        }
                        if (!isNaN(val) && val !== '') return Number(val);
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) return val.slice(1, -1);
                        return val;
                    }
                    function stripQuotes(s) {
                        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                            return s.slice(1, -1);
                        }
                        return s;
                    }
                    function splitFlowLevels(str, pos) {
                        var parts = [];
                        var cur = '';
                        var depth = 0;
                        var inQ = false;
                        var qCh = '';
                        for (var i = 0; i < str.length; i++) {
                            var ch = str[i];
                            if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qCh = ch; cur += ch; continue; }
                            if (inQ && ch === qCh) { inQ = false; qCh = ''; cur += ch; continue; }
                            if (!inQ) {
                                if (ch === '[' || ch === '{') { depth++; cur += ch; continue; }
                                if (ch === ']' || ch === '}') { depth--; cur += ch; continue; }
                                if (ch === pos && depth === 0) { parts.push(cur); cur = ''; continue; }
                            }
                            cur += ch;
                        }
                        parts.push(cur);
                        return parts;
                    }
                    function parseFlow(val) {
                        if (val.startsWith('{') && val.endsWith('}')) {
                            var mInner = val.slice(1, -1);
                            var mResult = {};
                            var mParts = splitFlowLevels(mInner, ',');
                            for (var i = 0; i < mParts.length; i++) {
                                var part = mParts[i].trim();
                                if (!part) continue;
                                var kv = splitFlowLevels(part, ':');
                                if (kv.length === 1 || part === ':') continue;
                                var key = stripQuotes(kv[0].trim());
                                var valStr = kv.slice(1).join(':').trim();
                                if (valStr === '') { mResult[key] = {}; continue; }
                                mResult[key] = parseFlowValue(valStr);
                            }
                            return mResult;
                        }
                        if (val.startsWith('[') && val.endsWith(']')) {
                            var sInner = val.slice(1, -1);
                            var sResult = [];
                            var sParts = splitFlowLevels(sInner, ',');
                            for (var j = 0; j < sParts.length; j++) {
                                var el = sParts[j].trim();
                                if (!el) continue;
                                sResult.push(parseFlowValue(el));
                            }
                            return sResult;
                        }
                        return parseFlowValue(val);
                    }
                    function parseFlowValue(val) {
                        val = stripInlineComment(val.trim());
                        if (val === '' || val === '~') return undefined;
                        if (val === 'null') return null;
                        if (val === 'true') return true;
                        if (val === 'false') return false;
                        if (!isNaN(val) && val !== '') return Number(val);
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            return val.slice(1, -1);
                        }
                        if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
                            return parseFlow(val);
                        }
                        return val;
                    }
                    return {
                        load: function(yamlString) {
                            var result = {};
                            var lines = yamlString.split('\n');
                            var stack = [{obj: result, indent: -1, parent: null, key: null}];
                            for (var li = 0; li < lines.length; li++) {
                                var line = lines[li];
                                var trimmed = line.trim();
                                if (!trimmed || trimmed.startsWith('#')) continue;
                                var indent = line.search(/\S|$/);
                                while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
                                var ctx = stack[stack.length - 1].obj;

                                // YAML sequence item: "- value" or "- key: value"
                                var seqMatch = trimmed.match(/^-\s+(.*)$/);
                                if (seqMatch) {
                                    var seqVal = seqMatch[1];
                                    // Convert ctx from object to array if it's the first sequence item
                                    if (!Array.isArray(ctx)) {
                                        var entry = stack[stack.length - 1];
                                        var arr = [];
                                        if (entry.parent && entry.key !== null) {
                                            entry.parent[entry.key] = arr;
                                        }
                                        entry.obj = arr;
                                        ctx = arr;
                                    }
                                    // FIX: When the list item value starts with { or [,
                                    // it's an inline flow object/array — parse it as a
                                    // whole value instead of splitting on the first colon.
                                    if (seqVal.charAt(0) === '{' || seqVal.charAt(0) === '[') {
                                        var parsed = parseYamlValue(seqVal);
                                        ctx.push(parsed !== undefined ? parsed : seqVal);
                                        continue;
                                    }
                                    // Check if item is a mapping: "- key: value"
                                    var seqVm = seqVal.match(/^([^:]+):\s*(.*)$/);
                                    if (seqVm) {
                                        var seqKey = seqVm[1].trim();
                                        var seqValue = seqVm[2].trim();
                                        var seqParsed = parseYamlValue(seqValue);
                                        var newObj = {};
                                        if (seqParsed === undefined) {
                                            newObj[seqKey] = {};
                                        } else {
                                            newObj[seqKey] = seqParsed;
                                        }
                                        ctx.push(newObj);
                                        stack.push({obj: newObj, indent: indent, parent: null, key: null});
                                    } else {
                                        var parsed2 = parseYamlValue(seqVal);
                                        ctx.push(parsed2 !== undefined ? parsed2 : seqVal);
                                    }
                                    continue;
                                }

                                var vm = trimmed.match(/^([^:]+):\s*(.*)$/);
                                if (!vm) continue;
                                var key = vm[1].trim();
                                var val = vm[2].trim();
                                var parsed = parseYamlValue(val);
                                if (parsed === undefined) {
                                    ctx[key] = {};
                                    stack.push({obj: ctx[key], indent: indent, parent: ctx, key: key});
                                } else {
                                    ctx[key] = parsed;
                                }
                            }
                            return result;
                        },
                        safeLoad: function(yamlString) {
                            return this.load(yamlString);
                        }
                    };
                }
                if (cleanMod === 'crypto' || cleanMod === 'node:crypto') {
                    // Browser-safe Node `crypto` stub. Desktop mods use this for
                    // decrypting encrypted plugin payloads, which aren't shipped
                    // in the browser build — return empty data instead of
                    // throwing at plugin load time.
                    function cryptoStream() {
                        return {
                            update: function() { return new Uint8Array(0); },
                            final: function() { return new Uint8Array(0); },
                            setAutoPadding: function() { return this; }
                        };
                    }
                    return {
                        createDecipheriv: cryptoStream,
                        createCipheriv: cryptoStream,
                        createDecipher: cryptoStream,
                        createCipher: cryptoStream,
                        createHash: function() {
                            return { update: function() { return this; }, digest: function() { return new Uint8Array(0); } };
                        },
                        createHmac: function() {
                            return { update: function() { return this; }, digest: function() { return new Uint8Array(0); } };
                        },
                        randomBytes: function(size) { return new Uint8Array(size | 0); },
                        randomUUID: function() { return '00000000-0000-4000-8000-000000000000'; },
                        getRandomValues: function(arr) {
                            if (window.crypto && typeof window.crypto.getRandomValues === 'function') return window.crypto.getRandomValues(arr);
                            return arr;
                        },
                        timingSafeEqual: function(a, b) { return !!(a && b && a.length === b.length); }
                    };
                }
                return {};
            };
        })();
