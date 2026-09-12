#!/usr/bin/env node
'use strict';

/**
 * out/tools/split.js — un-concatenate game.js back into source files.
 *
 * game.js is not minified or transpiled: it is a straight concatenation of 31
 * unmodified source files, each introduced by a banner comment holding its
 * original path:
 *
 *     ;/*============ /js/libs/pixi.js ============*​/
 *
 * The leading `;` and a fixed run of trailing newlines are the only glue the
 * bundler added (the `;` guards against the previous file ending mid-statement;
 * it is not part of any source file). Everything else is verbatim.
 *
 * This script therefore recovers each file exactly: for every section it takes
 * the bytes between two banners, converts the bundle's uniform CRLF back to LF,
 * and trims the glue newlines (the exact count is kept per file in
 * manifest.json as `trailingNewlines`, so nothing is lost). `tools/build.js`
 * reverses it byte-for-byte, and that round trip is asserted here on every run —
 * if the rebuilt bundle is not identical to the input, the split is not lossless
 * and this script fails.
 *
 * Usage:
 *     node out/tools/split.js [path/to/game.js]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..'); // holds game.js
const OUT_DIR = path.resolve(__dirname, '..'); // out/
const SOURCE = path.resolve(process.argv[2] || path.join(ROOT, 'game.js'));

// Banner: `;` + `/*` + 12 `=` + ` ` + path + ` ` + 12 `=` + `*/`
const BANNER = /^;\/\*={12} (\/[^\n]*?) ={12}\*\/\r?\n/gm;

/**
 * What each file is, in load order. This is the map of the loading logic:
 * the top block is the host wrapper (`/site/`), then the engine, then the
 * web-port layer the wrapper adds around RPG Maker MV.
 */
const ROLES = {
    '/site/fz.js': 'Host error plumbing: creates the hidden #consolearea and #ErrorPrinter divs.',
    '/site/14.js': 'Desktop/native bridge: STEAM_KEY, Tauri detection, browser-window wrapper.',
    '/site/yp.js': 'CDN rewriter: window.__CDN_BASE from base.ini baseUrl; prefixes js/, movies/, fonts/ and repoints the GameFont face.',
    '/site/s6.js': 'Buffer polyfill (Uint8Array subclass) so Node-style callers work in the browser.',
    '/site/o1.js': 'WOClient persistence: IndexedDB-backed runtime FS; no-op when running under Tauri.',
    '/site/75.js': 'NW.js shims: fake window.process and window.chrome.',
    '/js/libs/fpsmeter.js': 'FPS meter overlay (Commmunity_Basic dependency).',
    '/js/libs/pixi.js': 'PIXI.js v4.8.9 renderer.',
    '/js/libs/pixi-tilemap.js': 'PIXI tilemap plugin.',
    '/js/libs/pixi-picture.js': 'PIXI picture plugin.',
    '/js/libs/lz-string.js': 'LZString compression (save data).',
    '/js/libs/iphone-inline-video.browser.js': 'iOS inline-video workaround.',
    '/js/rpg_core.js': 'RPG Maker MV core (Graphics, SceneManager, Input, Utils, Bitmap).',
    '/js/rpg_managers.js': 'RPG Maker MV managers; hosts PluginManager, which loads js/plugins/*.js.',
    '/js/rpg_objects.js': 'RPG Maker MV game objects ($gameParty, $gameMap, ...).',
    '/js/rpg_scenes.js': 'RPG Maker MV scenes (Scene_Boot ... Scene_Gameover).',
    '/js/rpg_sprites.js': 'RPG Maker MV sprites.',
    '/js/rpg_windows.js': 'RPG Maker MV windows.',
    '/site/fflate.js': 'fflate — zip inflate used by ZipLoader.',
    '/js/zip_loader.js': 'ZipLoader: range-fetches the img_pack/aud_pack parts, builds the in-memory VFS, applies base.ini.',
    '/site/vfs_bridge.js': 'window.OVFS — merged VFS view over the archive, the runtime store and localStorage.',
    '/site/fast-json-patch.js': 'fast-json-patch 3.1.1 (jsonpatch) for mod deltas.',
    '/site/imagediff2.js': 'wasm-bindgen glue for imagediff2_bg.wasm (mod image diffing).',
    '/site/modloader.js': 'window.ModLoader — OneLoader-compatible mod engine and boot gate.',
    '/site/wc.js': 'Data-usage consent gate (1.6 GB notice) plus the Tauri fast path.',
    '/site/yl.js': 'Save import/export: handleSaveUpload, handleSaveExport, window._cachedTitleData.',
    '/js/plugins.js': 'RPG Maker-generated $plugins array (the plugin list, in load order).',
    '/js/main.js': 'Entry point: window.onload -> ModLoader.boot(startGame) -> PluginManager.setup -> SceneManager.run.',
    '/site/bd.js': 'Host boot gate: stashes window.onload as window.__resumeBoot so consent can hold the boot.',
    '/site/c5.js': 'Mobile/touch detection and fullscreen canvas fill.',
    '/site/textquality.js': 'Fullscreen crisp-text pass (2x window contents bitmaps); QUALITY=1 disables it.'
};

function rel(p) {
    return path.relative(ROOT, p).split(path.sep).join('/');
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Index of the byte offset of every line start, for offset -> line numbers. */
function lineIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineAt(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1; // 1-based
}

function split(raw) {
    const starts = lineIndex(raw);
    const sections = [];
    let match;
    BANNER.lastIndex = 0;
    while ((match = BANNER.exec(raw))) {
        sections.push({
            path: match[1],
            markerStart: match.index,
            bodyStart: BANNER.lastIndex
        });
    }
    if (!sections.length) throw new Error('no section banners found in ' + SOURCE);
    if (sections[0].markerStart !== 0) {
        throw new Error('unexpected content before the first banner (bytes 0..' + sections[0].markerStart + ')');
    }
    for (let i = 0; i < sections.length; i++) {
        const end = i + 1 < sections.length ? sections[i + 1].markerStart : raw.length;
        const body = raw.slice(sections[i].bodyStart, end);
        const lf = body.replace(/\r\n/g, '\n');
        const trailing = (lf.match(/\n+$/) || [''])[0].length;
        sections[i].body = body;
        sections[i].content = lf.replace(/\n+$/, '') + '\n';
        sections[i].trailing = trailing;
        sections[i].markerEndLine = lineAt(starts, end - 1);
        sections[i].startLine = lineAt(starts, sections[i].markerStart);
        sections[i].endLine = sections[i].markerEndLine;
    }
    return sections;
}

/** Reverse of split(): must reproduce `raw` exactly. */
function rebuild(sections) {
    return sections.map(function (s) {
        const marker = ';/*============ ' + s.path + ' ============*/';
        const stripped = s.content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        return marker + '\r\n' + stripped.replace(/\n/g, '\r\n') + '\r\n'.repeat(s.trailing);
    }).join('');
}

function main() {
    const raw = fs.readFileSync(SOURCE, 'utf8');
    const sections = split(raw);

    const seen = new Set();
    const pads = new Map();
    const manifest = sections.map(function (s, i) {
        if (seen.has(s.path)) throw new Error('duplicate section path: ' + s.path);
        seen.add(s.path);
        pads.set(s.trailing, (pads.get(s.trailing) || 0) + 1);

        const absolute = path.join(OUT_DIR, s.path.replace(/^\//, ''));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, s.content);

        return {
            order: i + 1,
            path: s.path,
            file: rel(absolute),
            gameJsLines: [s.startLine, s.endLine],
            bytes: Buffer.byteLength(s.content),
            lines: s.content.split('\n').length - 1,
            trailingNewlines: s.trailing,
            sha256: sha256(s.content),
            role: ROLES[s.path] || null
        };
    });

    const missingRole = manifest.filter(m => !m.role).map(m => m.path);

    // The split is lossless only if the reverse is byte-identical.
    const roundTrip = rebuild(sections);
    const identical = roundTrip === raw;

    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
        generator: 'out/tools/split.js',
        source: rel(SOURCE),
        sourceBytes: Buffer.byteLength(raw),
        sourceLines: raw.split('\n').length - 1,
        sourceSha256: sha256(raw),
        sectionCount: manifest.length,
        rebuild: {
            note: 'tools/build.js reverses this split; the output is byte-identical to source.',
            banner: ';/*============ <path> ============*/',
            lineEnding: 'crlf',
            trailingNewlines: 'per section, in trailingNewlines — each file is written to out/ with a ' +
                'single trailing LF, which the rebuild strips and replaces with that many CRLFs'
        },
        sections: manifest
    }, null, 2) + '\n');

    console.log('source      : ' + rel(SOURCE) + ' (' + Buffer.byteLength(raw) + ' bytes)');
    console.log('sections    : ' + manifest.length);
    console.log('round trip  : ' + (identical ? 'byte-identical OK' : 'MISMATCH'));
    console.log('trailing NL : ' + [...pads.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([count, files]) => count + ' x ' + files)
        .join(', ') + '  (stored per file in manifest.json)');
    if (missingRole.length) console.log('no role     : ' + missingRole.join(', '));
    for (const m of manifest) {
        console.log('  ' + String(m.order).padStart(2) + '  ' + m.path.padEnd(40) +
            String(m.bytes).padStart(9) + ' bytes  lines ' + m.gameJsLines[0] + '-' + m.gameJsLines[1]);
    }
    if (!identical) {
        process.exitCode = 1;
        console.error('\nERROR: rebuilt bundle does not match the source — split is not lossless.');
    }
}

main();
