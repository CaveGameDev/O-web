'use strict';

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
