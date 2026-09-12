#!/usr/bin/env node
'use strict';

/**
 * out/tools/build.js — rebuild game.js from the split sources in out/.
 *
 * Reverses tools/split.js using out/manifest.json (so the file list and the
 * order come from the manifest, never a directory glob — nothing in out/tools/
 * or out/README.md can leak into the bundle).
 *
 * Per section it writes:
 *
 *     ;/*============ <path> ============*​/
 *     <file contents, LF -> CRLF, final newline removed>
 *     <trailingNewlines blank CRLF lines>
 *
 * `trailingNewlines` comes from the manifest (3 for every file the bundler
 * padded, 0 for the final one), so the output is byte-identical to the
 * original game.js rather than merely equivalent.
 *
 * Usage:
 *     node out/tools/build.js [-o path/to/game.js] [--check]
 *
 *     --check   write nothing; only report whether the rebuild is byte-identical
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(OUT_DIR, '..');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const oIndex = args.indexOf('-o');
const target = path.resolve(oIndex >= 0 ? args[oIndex + 1] : path.join(ROOT, 'game.js'));

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function build(manifest) {
    let out = '';
    for (const section of manifest.sections) {
        const file = path.join(OUT_DIR, section.path.replace(/^\//, ''));
        const content = fs.readFileSync(file, 'utf8');
        const lf = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        // 0 is a valid pad (the last file has no trailing newline at all), so
        // this must not fall back to the default on a falsy check.
        const pad = Number.isInteger(section.trailingNewlines) ? section.trailingNewlines : 3;

        out += ';/*============ ' + section.path + ' ============*/\r\n';
        out += lf.replace(/\n/g, '\r\n');
        out += '\r\n'.repeat(pad);
    }
    return out;
}

function main() {
    if (!fs.existsSync(MANIFEST)) {
        console.error('manifest.json not found — run `node out/tools/split.js` first.');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

    // Report any source file that was edited after the split, so a stale
    // manifest cannot silently produce a bundle that does not match the tree.
    const edited = [];
    for (const section of manifest.sections) {
        const file = path.join(OUT_DIR, section.path.replace(/^\//, ''));
        if (!fs.existsSync(file)) {
            console.error('missing source file: ' + section.file);
            process.exit(1);
        }
        if (sha256(fs.readFileSync(file)) !== section.sha256) edited.push(section.path);
    }

    const built = build(manifest);
    const builtBuf = Buffer.from(built, 'utf8');

    if (checkOnly) {
        if (!fs.existsSync(target)) {
            console.error('nothing to compare against: ' + target);
            process.exit(1);
        }
        const current = fs.readFileSync(target);
        const same = Buffer.compare(builtBuf, current) === 0;
        console.log('rebuild     : ' + builtBuf.length + ' bytes');
        console.log('on disk     : ' + current.length + ' bytes');
        console.log('identical   : ' + same);
        if (edited.length) console.log('edited since split: ' + edited.join(', '));
        if (!same) process.exitCode = 1;
        return;
    }

    fs.writeFileSync(target, builtBuf);
    console.log('wrote       : ' + path.relative(ROOT, target) + ' (' + builtBuf.length + ' bytes)');
    console.log('sha256      : ' + sha256(builtBuf));
    if (manifest.sourceSha256 && sha256(builtBuf) === manifest.sourceSha256) {
        console.log('matches the original game.js byte-for-byte.');
    } else if (edited.length) {
        console.log('sources changed since the split: ' + edited.join(', '));
    } else {
        console.log('WARNING: differs from the sha256 recorded at split time.');
    }
}

main();
