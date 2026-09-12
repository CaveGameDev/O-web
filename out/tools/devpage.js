#!/usr/bin/env node
'use strict';

/**
 * out/tools/devpage.js — generate dev.html: the split-source entry point.
 *
 * index.html loads the bundle with a single `<script src="game.js">`. dev.html
 * is that same page with that one tag replaced by one tag per split file, in the
 * exact order recorded in out/manifest.json.
 *
 * It is written to the project root rather than into out/ on purpose: the game
 * resolves the media packs against `window.location.href`, base.ini against the
 * document URL and imagediff2_bg.wasm against `document.currentScript.src`, so a
 * page served from out/ would look for /out/img_pack/, /out/base.ini and
 * /out/site/imagediff2_bg.wasm and 404. From the root, every asset path is
 * byte-for-byte what the shipped page uses.
 *
 * Both pages therefore behave identically; dev.html just trades 31 HTTP requests
 * for the ability to edit and reload a single file.
 *
 * Usage:
 *     node out/tools/devpage.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(OUT_DIR, '..');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const SOURCE = path.join(ROOT, 'index.html');
const TARGET = path.join(ROOT, 'dev.html');
const BUNDLE_TAG = '<script src="game.js"></script>';

function main() {
    if (!fs.existsSync(MANIFEST)) {
        console.error('manifest.json not found — run `node out/tools/split.js` first.');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const html = fs.readFileSync(SOURCE, 'utf8');

    if (html.indexOf(BUNDLE_TAG) < 0) {
        console.error('could not find ' + BUNDLE_TAG + ' in ' + path.relative(ROOT, SOURCE) +
            ' — did the entry point change?');
        process.exit(1);
    }

    const tags = manifest.sections
        .map(s => '<script src="out' + s.path + '"></script>')
        .join('\n');
    const out = html.replace(BUNDLE_TAG, tags);

    fs.writeFileSync(TARGET, out);
    console.log('wrote       : dev.html (' + Buffer.byteLength(out) + ' bytes)');
    console.log('script tags : ' + manifest.sections.length + ', in manifest order');
    console.log('load order  :');
    for (const s of manifest.sections) {
        console.log('  ' + String(s.order).padStart(2) + '  out' + s.path);
    }
    console.log('\nserve the project root and open /dev.html (see out/README.md).');
}

main();
