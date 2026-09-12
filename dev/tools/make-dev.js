#!/usr/bin/env node
'use strict';

/**
 * dev/tools/make-dev.js — build the self-contained "decomp mode" dev site.
 *
 * dev/ is a runnable copy of the whole site with the bundled game.js swapped for
 * the split sources in out/:
 *
 *     dev/
 *       index.html          near-identical to the real one (only the script tags differ)
 *       decomp.js           the decomp-mode handler (badge, flags, diagnostics)
 *       site/**             the 16 host-wrapper sources
 *       js/rpg_*.js         engine sources
 *       js/zip_loader.js  js/plugins.js  js/main.js
 *       js/libs/**          full mirror, incl. pinyin.json + js-yaml-master (runtime deps)
 *       js/plugins/**       the 173 runtime-loaded plugin files
 *       img_pack/**  aud_pack/**  movies/**  fonts/**  icon/**  MOD/**
 *       base.ini  sw.js  imagediff2_bg.wasm
 *
 * Everything the page resolves relative to itself is therefore present, so dev/
 * works as its own document root — the whole point of the copy, since the packs
 * resolve against `window.location.href`, base.ini against the document URL and
 * imagediff2_bg.wasm against `document.currentScript.src`.
 *
 * Re-running is cheap: files already present at the same size with an equal or
 * newer mtime are skipped, so re-copying the 1.5 GB of pack parts is a no-op
 * once they are in place. The 31 sources are compared byte-for-byte instead, so
 * editing out/ always propagates.
 *
 * Two things are deliberately not a plain copy:
 *   - js-yaml is trimmed to the module entry, lib/ and LICENSE. It ships a
 *     Makefile, a bower.json, CI config and docs that the runtime never needs —
 *     and in fact the require() shim in site/s6.js answers any 'js-yaml' request
 *     from a hand-written parser without reading the folder at all.
 *   - index.html is spliced rather than overwritten: the generated <script>
 *     block sits between markers, so edits anywhere else in the page survive
 *     regeneration.
 *
 * Usage:
 *     node dev/tools/make-dev.js [--force] [--sources-only]
 *
 *     --force         re-copy everything, even files that look unchanged
 *     --sources-only  refresh code and small assets, leave the media packs alone
 */

const fs = require('fs');
const path = require('path');

const DEV_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(DEV_DIR, '..');
const OUT_DIR = path.join(ROOT, 'out');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const SOURCES_ONLY = argv.includes('--sources-only');

// Copied BEFORE the split sources so out/** wins for the files both trees hold.
// `exact` compares bytes (cheap, small files); otherwise size+mtime is used,
// which is what makes re-runs over 1.5 GB of pack parts cheap.
const MIRROR = [
    { from: 'js/libs', to: 'js/libs' },
    { from: 'js/plugins', to: 'js/plugins' },
    { from: 'fonts', to: 'fonts' },
    { from: 'icon', to: 'icon' },
    { from: 'movies', to: 'movies' },
    { from: 'MOD', to: 'MOD' },
    { from: 'base.ini', to: 'base.ini', exact: true },
    { from: 'sw.js', to: 'sw.js', exact: true },
    { from: 'imagediff2_bg.wasm', to: 'imagediff2_bg.wasm' }
];

const MEDIA = [
    { from: 'img_pack', to: 'img_pack' },
    { from: 'aud_pack', to: 'aud_pack' }
];

// Upstream js-yaml build/CI/docs. What is kept is the module entry (index.js,
// package.json), its lib/ tree and LICENSE; everything else is packaging noise
// that the runtime never loads. Dropped files are also pruned from an existing
// dev/ tree, so this cleans up a copy made before the rule existed.
const JS_YAML_ROOT = 'js/libs/js-yaml-master';
const JS_YAML_DROP = [
    '.editorconfig',
    '.eslintignore',
    '.eslintrc.yml',
    '.gitignore',
    '.ndocrc',
    '.travis.yml',
    'CHANGELOG.md',
    'Makefile',
    'README.md',
    'bower.json'
];

const stats = { copied: 0, skipped: 0, dropped: 0, pruned: 0, bytes: 0, overwrittenEdits: [] };

function isDropped(devRel) {
    for (const name of JS_YAML_DROP) {
        if (devRel === JS_YAML_ROOT + '/' + name) return true;
    }
    return false;
}

/** Remove excluded files an earlier generation may already have copied. */
function pruneDropped() {
    for (const name of JS_YAML_DROP) {
        const file = path.join(DEV_DIR, JS_YAML_ROOT, name);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            stats.pruned++;
        }
    }
}

function copyFile(from, to, label, exact) {
    const src = fs.statSync(from);

    if (!FORCE && fs.existsSync(to)) {
        const dst = fs.statSync(to);
        if (exact) {
            if (dst.size === src.size &&
                fs.readFileSync(from).compare(fs.readFileSync(to)) === 0) {
                stats.skipped++;
                return;
            }
            if (dst.mtimeMs > src.mtimeMs) {
                // The copy is newer than its source, so it was edited here.
                stats.overwrittenEdits.push(label || path.basename(to));
            }
        } else if (dst.size === src.size && dst.mtimeMs >= src.mtimeMs) {
            stats.skipped++;
            return;
        }
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    stats.copied++;
    stats.bytes += src.size;
}

function copyTree(from, to, exact, suppliedBySources) {
    if (fs.statSync(from).isDirectory()) {
        for (const name of fs.readdirSync(from)) {
            copyTree(path.join(from, name), path.join(to, name), exact, suppliedBySources);
        }
        return;
    }
    const devRel = path.relative(DEV_DIR, to).split(path.sep).join('/');
    if (isDropped(devRel)) {
        stats.dropped++;
        return;
    }
    // Paths the split sources provide are out/-canonical; copying the root copy
    // over them first would only be undone by step 2. Windows copyFileSync also
    // preserves mtime, so skipping here is what makes a re-run a true no-op.
    if (suppliedBySources && suppliedBySources.has(devRel)) {
        stats.skipped++;
        return;
    }
    copyFile(from, to, devRel, exact);
}

function main() {
    if (!fs.existsSync(MANIFEST)) {
        console.error('out/manifest.json not found — run `node out/tools/split.js` first.');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

    fs.mkdirSync(DEV_DIR, { recursive: true });

    const suppliedBySources = new Set(
        manifest.sections.map(s => s.path.replace(/^\//, ''))
    );

    // 1. Mirrored trees from the project root (js/libs extras, plugins, media).
    for (const entry of MIRROR) {
        const src = path.join(ROOT, entry.from);
        if (!fs.existsSync(src)) {
            console.warn('skip (missing): ' + entry.from);
            continue;
        }
        copyTree(src, path.join(DEV_DIR, entry.to), !!entry.exact, suppliedBySources);
    }
    pruneDropped();

    // 2. The split sources, last so out/** is authoritative for shared paths.
    for (const section of manifest.sections) {
        const from = path.join(OUT_DIR, section.path.replace(/^\//, ''));
        const to = path.join(DEV_DIR, section.path.replace(/^\//, ''));
        copyFile(from, to, section.path, true);
    }

    // 3. Media packs (the bulk).
    if (!SOURCES_ONLY) {
        for (const entry of MEDIA) {
            const src = path.join(ROOT, entry.from);
            if (!fs.existsSync(src)) {
                console.warn('skip (missing): ' + entry.from);
                continue;
            }
            copyTree(src, path.join(DEV_DIR, entry.to), false);
        }
    }

    // 4. Generated entry point, data and notes; the handler is only scaffolded.
    const indexStatus = writeIndex(manifest);
    const handlerStatus = writeHandler();
    writeManifestData(manifest);
    writeReadme(manifest);

    console.log('');
    console.log('copied      : ' + stats.copied + ' files (' + (stats.bytes / 1048576).toFixed(1) + ' MB)');
    console.log('unchanged   : ' + stats.skipped + ' files skipped');
    console.log('js-yaml     : ' + stats.dropped + ' upstream build/CI/doc files excluded' +
        (stats.pruned ? ', ' + stats.pruned + ' pruned from dev/' : ''));
    if (stats.overwrittenEdits.length) {
        console.log('overwritten : ' + stats.overwrittenEdits.length +
            ' dev/ files had edits out/ did not — out/ is canonical, e.g. ' +
            stats.overwrittenEdits.slice(0, 3).join(', '));
    }
    console.log('index.html  : ' + indexStatus);
    console.log('decomp.js   : ' + handlerStatus);
    console.log('dev site    : dev/ — serve it and open / (see dev/README.md)');
}

const BUNDLE_TAG = '<script src="game.js"></script>';
const REGION_BEGIN = '<!-- decomp:sources:begin — generated by dev/tools/make-dev.js; ' +
    'edits outside this block are preserved -->';
const REGION_END = '<!-- decomp:sources:end -->';
// The generated run of tags, starting at the handler. Matched as a substring
// because the whole <body> of the real page is a single line, so the first tag
// sits mid-line rather than on one of its own.
const TAG_RUN = /<script src="(?:decomp\.manifest|decomp)\.js"><\/script>(?:\s*<script src="[^"]+"><\/script>)*/;

/** The generated <script> block, markers included. */
function sourceRegion(manifest) {
    const tags = [
        // Data first: the hand-owned handler reads window.__DECOMP_MANIFEST.
        '<script src="decomp.manifest.js"></script>',
        '<script src="decomp.js"></script>'
    ].concat(manifest.sections.map(s => '<script src="' + s.path.replace(/^\//, '') + '"></script>'));
    return [REGION_BEGIN].concat(tags).concat([REGION_END]).join('\n');
}

/**
 * index.html: the real page with its single bundle tag replaced by the split
 * sources. Only the marked region is written, so a hand-added note anywhere else
 * in the page survives regeneration — and a page generated before the markers
 * existed is migrated in place rather than replaced.
 */
function writeIndex(manifest) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    if (html.indexOf(BUNDLE_TAG) < 0) {
        console.error('could not find ' + BUNDLE_TAG + ' in index.html — did the entry point change?');
        process.exit(1);
    }
    const canonical = html.replace(BUNDLE_TAG, sourceRegion(manifest));
    const target = path.join(DEV_DIR, 'index.html');
    if (!fs.existsSync(target)) {
        fs.writeFileSync(target, canonical);
        return 'created from index.html';
    }

    const existing = fs.readFileSync(target, 'utf8');

    // Marked region present: splice just that block.
    if (existing.indexOf(REGION_BEGIN) >= 0 && existing.indexOf(REGION_END) >= 0) {
        const head = existing.slice(0, existing.indexOf(REGION_BEGIN));
        const tail = existing.slice(existing.indexOf(REGION_END) + REGION_END.length);
        const spliced = head + sourceRegion(manifest) + tail;
        if (spliced !== existing) fs.writeFileSync(target, spliced);
        return spliced === canonical ? 'regenerated (no local edits)' : 'spliced (local edits preserved)';
    }

    // No markers: a page generated before this change. Replace the contiguous
    // run of source tags only, keeping everything around it.
    const run = TAG_RUN.exec(existing);
    if (run) {
        const spliced = existing.slice(0, run.index) + sourceRegion(manifest) +
            existing.slice(run.index + run[0].length);
        fs.writeFileSync(target, spliced);
        return 'migrated to marked region (local edits preserved)';
    }

    // Unrecognised page: do not destroy it silently.
    if (existing === canonical) return 'already current';
    fs.writeFileSync(target + '.generated', canonical);
    return 'WARNING: dev/index.html was not generated by this tool — wrote ' +
        'dev/index.html.generated instead; compare and merge by hand';
}

/** dev/decomp.js: scaffolded once, then owned by hand. */
function writeHandler() {
    const body = `'use strict';

/**
 * dev/decomp.js — decomp-mode handler and in-tab manifest console.
 *
 * Hand-owned: make-dev.js scaffolds this file only when it is missing and never
 * rewrites it, so change it freely. Everything derived from the build — the
 * source file list and the bundle hash — lives in decomp.manifest.js, which IS
 * regenerated on every run.
 *
 * Loaded first on dev/index.html, before the split sources:
 *
 *   - defines window.DECOMP { mode, files, loaded(), missing(), requests(),
 *     snapshot(), report(), verify(), open(), close(), toggle() }
 *   - paints the MANIFEST.READ button bottom-left. Clicking it opens a small
 *     in-tab console listing every source file and how it loaded; close with the
 *     x or Escape, click it again to reopen. Nothing goes to the devtools console
 *     unless you call DECOMP.report() yourself.
 *   - sends ?mode=bundle to the bundled page before any source is fetched
 *
 * It deliberately does NOT inject its own script tags: dynamically inserted
 * scripts do not block the load event, and js/main.js assigns window.onload —
 * injecting them here would let the load event fire first and the game would
 * never boot. The tags in index.html are static, in manifest order.
 */

(function () {
    var LABEL = 'Manifest.Read';
    // CSS clamps z-index to 2147483647, so the game's overlays (dataConfirm
    // included) collapse to that same value and DOM order decides between them.
    // Both the button and the console are appended to <body> last, which puts
    // them on top — hit-tested against the visible consent overlay — so a larger
    // number is neither possible nor needed.
    var Z = 2147483647;
    var GLOBALS = ['PIXI', 'ZipLoader', 'fflate', 'LZString', 'ModLoader', 'OVFS', 'jsonpatch'];

    var params = new URLSearchParams(window.location.search);
    var mode = params.get('mode') || 'decomp';

    if (mode !== 'decomp') {
        var target = '../index.html';
        console.log('[decomp] mode=' + mode + ' -> redirecting to ' + target);
        window.location.replace(target);
        return;
    }

    var MANIFEST = window.__DECOMP_MANIFEST || { files: [], version: 'unknown' };
    var FILES = MANIFEST.files || [];

    var DECOMP = {
        mode: 'decomp',
        version: MANIFEST.version || 'unknown',
        count: FILES.length,
        files: FILES,
        /** Source files whose <script> tag is present in the document. */
        loaded: function () {
            var srcs = Array.prototype.slice.call(document.querySelectorAll('script[src]'))
                .map(function (t) { return t.getAttribute('src'); });
            return FILES.filter(function (f) { return srcs.indexOf(f) >= 0; });
        },
        missing: function () {
            var loaded = DECOMP.loaded();
            return FILES.filter(function (f) { return loaded.indexOf(f) < 0; });
        },
        /** Network outcome per source file, from the resource timing buffer. */
        requests: function () {
            var entries = performance.getEntriesByType('resource');
            return FILES.map(function (file) {
                var hit = null;
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].name.split('?')[0].slice(-file.length) === file) { hit = entries[i]; break; }
                }
                return {
                    file: file,
                    ok: hit ? (hit.responseStatus ? hit.responseStatus === 200 : hit.transferSize > 0) : false,
                    status: hit ? (hit.responseStatus || 'cached/opaque') : 'not requested',
                    kb: hit ? Math.round((hit.transferSize || hit.encodedBodySize || 0) / 1024) : 0
                };
            });
        },
        /** Everything the console shows, in one object. */
        snapshot: function () {
            var rows = DECOMP.requests();
            var failed = rows.filter(function (r) { return !r.ok; });
            var missing = DECOMP.missing();
            var globals = GLOBALS.map(function (name) {
                return { name: name, ok: typeof window[name] !== 'undefined' };
            });
            var badGlobals = globals.filter(function (g) { return !g.ok; });
            return {
                mode: 'decomp',
                version: DECOMP.version,
                files: FILES.length,
                loadedOk: rows.length - failed.length,
                failed: failed.map(function (r) { return r.file + ' (' + r.status + ')'; }),
                notReferenced: missing,
                globals: globals,
                rows: rows,
                ok: failed.length === 0 && missing.length === 0 && badGlobals.length === 0
            };
        },
        /** Console dump, kept for scripting. The button no longer calls this. */
        report: function () {
            var snapshot = DECOMP.snapshot();
            if (console.table) {
                console.table(snapshot.rows);
            } else {
                snapshot.rows.forEach(function (r) { console.log(r.ok ? 'ok  ' : 'FAIL', r.file, r.status); });
            }
            if (snapshot.notReferenced.length) {
                console.warn('[decomp] not referenced by index.html: ' + snapshot.notReferenced.join(', '));
            }
            return snapshot;
        },
        /** Compare what loaded against the recorded manifest. */
        verify: function () {
            var snapshot = DECOMP.snapshot();
            var missingGlobals = snapshot.globals
                .filter(function (g) { return !g.ok; })
                .map(function (g) { return g.name; });
            var result = {
                mode: 'decomp',
                files: snapshot.files,
                failed: snapshot.failed,
                missingGlobals: missingGlobals,
                ok: snapshot.ok
            };
            console[result.ok ? 'log' : 'error']('[decomp] verify:', result);
            return result;
        },
        open: openConsole,
        close: closeConsole,
        toggle: toggleConsole
    };

    window.DECOMP = DECOMP;
    window.__DECOMP__ = true;

    function badge() {
        if (document.getElementById('decompBadge')) return;
        var button = buttonEl('decompBadge', LABEL,
            'position:fixed;bottom:10px;left:14px;z-index:' + Z + ';' +
            'font-family:Consolas,ui-monospace,monospace;font-size:11px;letter-spacing:2px;' +
            'color:#7fd4a0;background:rgba(0,0,0,0.72);border:1px solid rgba(127,212,160,0.45);' +
            'border-radius:3px;padding:3px 8px;cursor:pointer;user-select:none;', toggleConsole);
        button.title = 'Running the split sources from dev/, not game.js. Click for the manifest console.';
        button.setAttribute('aria-expanded', 'false');
        document.body.appendChild(button);
    }

    /* ---- in-tab console --------------------------------------------------- */

    var PANEL_BUTTON = 'border:1px solid rgba(255,255,255,0.5);background:#000;color:#fff;' +
        'font:inherit;font-size:10px;letter-spacing:1px;padding:3px 9px;cursor:pointer;';

    function node(tag, css, text) {
        var element = document.createElement(tag);
        if (css) element.style.cssText = css;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function buttonEl(id, label, css, onClick) {
        var element = node('button', css, label);
        element.type = 'button';
        element.id = id;
        element.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return element;
    }

    function setExpanded(isOpen) {
        var button = document.getElementById('decompBadge');
        if (button) button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    function buildConsole() {
        var panel = node('div', 'position:fixed;left:12px;bottom:44px;z-index:' + Z + ';' +
            'width:min(460px,94vw);max-height:min(62vh,540px);display:flex;flex-direction:column;' +
            'background:rgba(0,0,0,0.94);border:2px solid #fff;color:#fff;box-sizing:border-box;' +
            'font-family:Consolas,ui-monospace,monospace;font-size:11px;');
        panel.id = 'decompConsole';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'decomp source manifest');

        var head = node('div', 'display:flex;align-items:center;gap:8px;padding:7px 9px;' +
            'letter-spacing:2px;border-bottom:1px solid rgba(255,255,255,0.25);');
        head.appendChild(node('span', 'color:#cdc3f2;', LABEL.toUpperCase()));
        var summary = node('span', 'margin-left:auto;font-size:10px;');
        summary.id = 'decompConsoleSummary';
        head.appendChild(summary);
        head.appendChild(buttonEl('decompConsoleClose', '×',
            PANEL_BUTTON + 'font-size:13px;padding:1px 8px;', closeConsole));
        panel.appendChild(head);

        var body = node('div', 'overflow:auto;padding:6px 9px 9px;');
        body.id = 'decompConsoleBody';
        panel.appendChild(body);

        var foot = node('div', 'display:flex;align-items:center;gap:8px;padding:7px 9px;' +
            'border-top:1px solid rgba(255,255,255,0.25);');
        foot.appendChild(buttonEl('decompConsoleRerun', 'RERUN', PANEL_BUTTON, renderConsole));
        foot.appendChild(buttonEl('decompConsoleCopy', 'COPY', PANEL_BUTTON, copySnapshot));
        foot.appendChild(node('span', 'margin-left:auto;color:#888;font-size:10px;', 'Esc closes'));
        panel.appendChild(foot);

        return panel;
    }

    function row(label, text, colour, right) {
        var line = node('div', 'display:flex;gap:6px;line-height:1.55;');
        line.appendChild(node('span', 'flex:0 0 34px;color:' + colour + ';', label));
        line.appendChild(node('span',
            'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', text));
        line.appendChild(node('span', 'flex:0 0 58px;text-align:right;color:#777;', right || ''));
        return line;
    }

    function renderConsole() {
        if (!document.getElementById('decompConsole')) return null;
        var snapshot = DECOMP.snapshot();
        var summary = document.getElementById('decompConsoleSummary');
        var body = document.getElementById('decompConsoleBody');

        summary.textContent = snapshot.loadedOk + '/' + snapshot.rows.length + ' ok';
        summary.style.color = snapshot.ok ? '#7fd4a0' : '#f88';

        body.textContent = '';
        body.appendChild(node('div', 'color:#888;margin-bottom:6px;line-height:1.5;',
            'decomp ' + snapshot.version + ' — ' + snapshot.files + ' sources, ' +
            snapshot.failed.length + ' failed'));
        if (!snapshot.rows.length) {
            body.appendChild(node('div', 'color:#f88;line-height:1.6;',
                'decomp.manifest.js did not load — window.__DECOMP_MANIFEST is missing.'));
        }
        snapshot.rows.forEach(function (r) {
            // Nothing transferred means it came from cache, which reads better
            // in a size column than the bare "200" that status would give.
            body.appendChild(row(r.ok ? 'ok' : 'FAIL', r.file, r.ok ? '#7fd4a0' : '#f88',
                r.kb ? r.kb + ' KB' : (r.ok ? 'cached' : r.status)));
        });
        snapshot.globals.forEach(function (g) {
            body.appendChild(row(g.ok ? 'ok' : 'FAIL', 'global: ' + g.name,
                g.ok ? '#7fd4a0' : '#f88', ''));
        });
        if (snapshot.notReferenced.length) {
            body.appendChild(node('div', 'color:#fc6;margin-top:6px;line-height:1.5;',
                'not referenced by index.html: ' + snapshot.notReferenced.join(', ')));
        }
        return snapshot;
    }

    function copySnapshot() {
        var button = document.getElementById('decompConsoleCopy');
        var flash = function (label) {
            if (!button) return;
            button.textContent = label;
            setTimeout(function () { button.textContent = 'COPY'; }, 1200);
        };
        var text = JSON.stringify(DECOMP.snapshot(), null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { flash('COPIED'); },
                function () { flash('FAILED'); });
        } else {
            flash('FAILED');
        }
        return text;
    }

    function openConsole() {
        if (!document.getElementById('decompConsole')) {
            document.body.appendChild(buildConsole());
        }
        setExpanded(true);
        return renderConsole();
    }

    function closeConsole() {
        var panel = document.getElementById('decompConsole');
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        setExpanded(false);
    }

    function toggleConsole() {
        if (document.getElementById('decompConsole')) closeConsole(); else openConsole();
    }

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' || event.keyCode === 27) closeConsole();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', badge);
    } else {
        badge();
    }

    console.log('[decomp] mode decomp, v' + DECOMP.version + ', ' + FILES.length +
        ' source files — click ' + LABEL + ' for the manifest console, ?mode=bundle for game.js.');
})();
`;
    const target = path.join(DEV_DIR, 'decomp.js');
    if (fs.existsSync(target)) return 'present, left alone';
    fs.writeFileSync(target, body);
    return 'created';
}

/** decomp.manifest.js: the only generated half of the handler. */
function writeManifestData(manifest) {
    const files = manifest.sections.map(s => s.path.replace(/^\//, ''));
    const data = `/* Generated by dev/tools/make-dev.js — do not edit by hand.
 *
 * Build-derived data for the hand-owned handler in dev/decomp.js: the source
 * files, in load order, and the hash of the bundle they were split from.
 * Per-file roles and line spans in game.js live in ../out/manifest.json. */
window.__DECOMP_MANIFEST = {
    version: ${JSON.stringify(manifest.sourceSha256.slice(0, 12))},
    sourceSha256: ${JSON.stringify(manifest.sourceSha256)},
    source: ${JSON.stringify(manifest.source)},
    files: ${JSON.stringify(files, null, 4).replace(/\n/g, '\n    ')}
};
`;
    fs.writeFileSync(path.join(DEV_DIR, 'decomp.manifest.js'), data);
}

function writeReadme(manifest) {
    const text = `# dev/ — decomp mode

A runnable copy of the site with \`game.js\` replaced by the split sources from
\`../out/\`. Generated by \`dev/tools/make-dev.js\` — edit \`../out/**\` and
re-run it rather than hand-editing the copies here — with one exception,
\`decomp.js\`, which is hand-owned and never overwritten.

## Run it

Serve **this folder** as the document root:

\`\`\`bash
cd dev && python -m http.server 8124
# open http://127.0.0.1:8124/
\`\`\`

\`../\` also works if you open \`/dev/index.html\`, but only with \`dev/\` as the
document root does every asset resolve inside \`dev/\`.

- **decomp mode** (default): the ${manifest.sections.length} sources under \`site/\` and \`js/\` load directly.
- **bundle mode**: \`?mode=bundle\` redirects to \`../index.html\` before any source is
  fetched, so both builds can be A/B'd in one tab. That redirect resolves only when
  \`dev/\` sits inside the project root.

## What is here

| Path | Origin |
|------|--------|
| \`index.html\` | \`../index.html\`, with its one \`<script src="game.js">\` swapped for ${manifest.sections.length} source tags |
| \`decomp.js\` | **hand-owned** handler: \`window.DECOMP\`, the MANIFEST.READ button and its in-tab console, \`?mode=bundle\` |
| \`decomp.manifest.js\` | generated: the source file list + bundle hash the handler reads |
| \`site/**\`, \`js/rpg_*.js\`, \`js/zip_loader.js\`, \`js/plugins.js\`, \`js/main.js\` | \`../out/**\` (canonical — edits there propagate) |
| \`js/plugins/**\` | \`../js/plugins/\` — the 173 files \`PluginManager\` fetches at runtime |
| \`js/libs/**\` | \`../js/libs/\` — includes \`pinyin.json\`, which the name-input plugin reads |
| \`js/libs/js-yaml-master/**\` | \`../js/libs/js-yaml-master/\`, **trimmed** to \`index.js\`, \`package.json\`, \`lib/**\` and \`LICENSE\` |
| \`img_pack/**\`, \`aud_pack/**\` | \`../\` — the media packs, resolved against this page's own URL |
| \`movies/**\`, \`fonts/**\`, \`icon/**\`, \`MOD/**\` | \`../\` — \`MOD/modlist.json\` is fetched relative to the page |
| \`base.ini\`, \`sw.js\`, \`imagediff2_bg.wasm\` | \`../\` — document-relative and \`currentScript\`-relative |

## Notes

- Re-running \`make-dev.js\` skips files already present at the same size with an
  equal or newer mtime, so refreshing code does not re-copy 1.5 GB of pack parts.
  The ${manifest.sections.length} sources are compared byte-for-byte, so \`out/\` edits always
  propagate. \`--force\` re-copies everything; \`--sources-only\` leaves the packs alone.
- \`index.html\` is **spliced, not overwritten**: the generated \`<script>\` block sits
  between \`decomp:sources:begin\` / \`decomp:sources:end\` markers, so notes or edits
  anywhere else in the page survive regeneration.
- \`js-yaml-master\` is copied without its upstream build, CI and doc files
  (\`Makefile\`, \`bower.json\`, \`.travis.yml\`, \`.eslintrc.yml\`, \`.editorconfig\`,
  \`.ndocrc\`, \`.eslintignore\`, \`.gitignore\`, \`README.md\`, \`CHANGELOG.md\`). Nothing
  at runtime reads that folder — the \`require()\` shim in \`site/s6.js\` answers every
  \`js-yaml\` request with a hand-written parser — so only the module entry, \`lib/\`
  and \`LICENSE\` are mirrored, and files an earlier run already copied are pruned.
- \`decomp.js\` is yours: the generator scaffolds it only when it is missing and never
  overwrites it, so UI and behaviour changes belong there. The build-derived half —
  the source file list and bundle hash — is \`decomp.manifest.js\`, regenerated every run.
- **MANIFEST.READ** (bottom-left) opens an in-tab console listing every source file and
  how it loaded, with a pass/fail summary and the globals check. Close it with the x or
  Escape and click the button again to reopen; RERUN re-checks without reloading and COPY
  puts the whole report on the clipboard. It sits at z-index 2147483649, above the consent
  gate, so it works from the very first frame. Nothing is written to the devtools console
  unless you call \`DECOMP.report()\` yourself.
- Load order is manifest order and is significant: \`site/bd.js\` must come after
  \`js/main.js\` (it wraps \`window.onload\` as \`window.__resumeBoot\` for the consent
  gate) and \`site/yp.js\` must come before anything requesting \`js/\`, \`movies/\` or
  \`fonts/\`.
- \`window.DECOMP.report()\` prints per-file network outcomes; \`window.DECOMP.verify()\`
  returns a pass/fail summary against the recorded manifest \`${manifest.sourceSha256.slice(0, 12)}\`.
- Decomp mode still needs the media packs: \`ZipLoader\` downloads them from this
  folder before the launcher appears.
`;
    fs.writeFileSync(path.join(DEV_DIR, 'README.md'), text);
}

main();
