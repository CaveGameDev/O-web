# `out/` — `game.js` un-bundled

`game.js` (3,161,354 bytes) is **not** minified and **not** transpiled. It is a plain
concatenation of 31 unmodified source files, each introduced by a banner comment
carrying its original path:

```js
;/*============ /js/libs/pixi.js ============*/
```

The leading `;` guards against the previous file ending mid-statement and a fixed run of
trailing newlines pads each section — that glue (and the bundle's uniform CRLF) is the
only thing the bundler added. Everything else is verbatim source, which is why the
decompilation is lossless rather than best-effort: `tools/build.js` reproduces
`game.js` **byte-for-byte**, and `tools/split.js` asserts that round trip on every run.

```
source      : game.js (3161354 bytes)
sections    : 31
round trip  : byte-identical OK
```

## Layout

| # | File | Role | `game.js` lines |
|---|------|------|-----------------|
| 1 | `site/fz.js` | Host error plumbing: hidden `#consolearea` / `#ErrorPrinter` divs | 1–18 |
| 2 | `site/14.js` | Desktop/native bridge: `STEAM_KEY`, Tauri detection, window wrapper | 19–296 |
| 3 | `site/yp.js` | CDN rewriter: `__CDN_BASE` from `base.ini`; prefixes `js/`, `movies/`, `fonts/`, repoints the `GameFont` face | 297–458 |
| 4 | `site/s6.js` | `Buffer` polyfill (`Uint8Array` subclass) | 459–1001 |
| 5 | `site/o1.js` | `WOClient` persistence (IndexedDB runtime FS); no-op under Tauri | 1002–1079 |
| 6 | `site/75.js` | NW.js shims: fake `window.process` / `window.chrome` | 1080–1123 |
| 7 | `js/libs/fpsmeter.js` | FPS meter overlay | 1124–1142 |
| 8 | `js/libs/pixi.js` | PIXI.js v4.8.9 renderer | 1143–43194 |
| 9 | `js/libs/pixi-tilemap.js` | PIXI tilemap plugin | 43195–44084 |
| 10 | `js/libs/pixi-picture.js` | PIXI picture plugin | 44085–44515 |
| 11 | `js/libs/lz-string.js` | LZString compression (save data) | 44516–44520 |
| 12 | `js/libs/iphone-inline-video.browser.js` | iOS inline-video workaround | 44521–44526 |
| 13 | `js/rpg_core.js` | RPG Maker MV core (`Graphics`, `SceneManager`, `Input`, `Bitmap`) | 44527–53871 |
| 14 | `js/rpg_managers.js` | RPG Maker MV managers; hosts `PluginManager` | 53872–56801 |
| 15 | `js/rpg_objects.js` | RPG Maker MV game objects (`$gameParty`, `$gameMap`, …) | 56802–67672 |
| 16 | `js/rpg_scenes.js` | RPG Maker MV scenes (`Scene_Boot` … `Scene_Gameover`) | 67673–70365 |
| 17 | `js/rpg_sprites.js` | RPG Maker MV sprites | 70366–73060 |
| 18 | `js/rpg_windows.js` | RPG Maker MV windows | 73061–79091 |
| 19 | `site/fflate.js` | fflate — zip inflate used by ZipLoader | 79092–79095 |
| 20 | `js/zip_loader.js` | `ZipLoader`: range-fetches the pack parts, builds the in-memory VFS, applies `base.ini` | 79096–81652 |
| 21 | `site/vfs_bridge.js` | `window.OVFS` — merged VFS view over archive + runtime store + localStorage | 81653–82186 |
| 22 | `site/fast-json-patch.js` | fast-json-patch 3.1.1 (`jsonpatch`) for mod deltas | 82187–82203 |
| 23 | `site/imagediff2.js` | wasm-bindgen glue for `imagediff2_bg.wasm` | 82204–82373 |
| 24 | `site/modloader.js` | `window.ModLoader` — OneLoader-compatible mod engine and boot gate | 82374–84550 |
| 25 | `site/wc.js` | Data-usage consent gate (1.6 GB notice) + Tauri fast path | 84551–84601 |
| 26 | `site/yl.js` | Save import/export: `handleSaveUpload`, `handleSaveExport` | 84602–84721 |
| 27 | `js/plugins.js` | RPG Maker-generated `$plugins` array (the plugin list) | 84722–84904 |
| 28 | `js/main.js` | Entry point: `window.onload` → boot → `PluginManager.setup` → `SceneManager.run` | 84905–84948 |
| 29 | `site/bd.js` | Host boot gate: stashes `window.onload` as `window.__resumeBoot` | 84949–84961 |
| 30 | `site/c5.js` | Mobile/touch detection and fullscreen canvas fill | 84962–85284 |
| 31 | `site/textquality.js` | Fullscreen crisp-text pass (2x window bitmaps); `QUALITY = 1` disables | 85285–85453 |

`site/` code is the **host wrapper** (CDN path shims, Steam/Tauri bridge, consent gate,
mobile input, save plumbing). `js/` is RPG Maker MV plus the web-port layer. Neither was
authored as a unit with the other; the bundle flattened both into one file.

## The loading logic

`index.html` loads exactly one script — `<script src="game.js"></script>` — so the
concatenation order **is** the runtime order. It is not alphabetical and not grouped by
directory; it matters in two specific places:

- `site/bd.js` (#29) loads **after** `js/main.js` (#28) on purpose. `main.js` assigns
  `window.onload`; `bd.js` captures that function as `window.__resumeBoot` and replaces
  `window.onload` with a no-op, so the consent gate (#25) can hold the boot. Run it
  earlier and the game boots before consent is given.
- `site/yp.js` (#3) rewrites `js/`, `movies/` and `fonts/` URLs, so it must precede
  anything that requests those paths.

### Static order → runtime boot

```
index.html
├─ inline boot check (required globals: fflate, LZString, PIXI, ZipLoader) + sw.js registration
└─ the 31 files above, in order
   ├─ site/* prelude .................. CDN base, Buffer, WOClient, process/chrome shims
   ├─ PIXI + rpg_* ................... engine
   ├─ fflate → zip_loader.js ......... window.ZipLoader
   ├─ vfs_bridge → OVFS ............. window.OVFS
   ├─ modloader ..................... window.ModLoader
   ├─ wc.js ......................... consent gate → ZipLoader.hasCachedArchives()
   ├─ plugins.js + main.js .......... $plugins, window.onload
   ├─ bd.js ......................... defers window.onload into __resumeBoot
   └─ c5.js / textquality.js ........ input + fullscreen polish

LAUNCH
└─ ModLoader.boot(startGame)          (js/main.js)
   └─ PluginManager.setup($plugins)   fetches js/plugins/*.js, in $plugins order
      └─ SceneManager.run(Scene_Boot)
         └─ Graphics.initialize()     ← the canvas appears here
```

`ZipLoader.init()` resolves *before* LAUNCH is offered; the player's click is the gate.
Everything between the click and `Graphics.initialize()` — mod application, plugin
scripts, canvas creation — is the post-processing window the startup loading bar covers.

### Not in this bundle (loaded at runtime)

- `js/plugins/*.js` — 173 files, fetched by `PluginManager` from the `$plugins` list in
  `js/plugins.js`. The list is in the bundle; the plugin bodies are not.
- `img_pack/` + `aud_pack/` (168 parts, ~1.5 GB) and the CDN archives (`data.zip`,
  `maps.zip`, `languages.zip`) — fetched by `ZipLoader`, resolved against the page
  directory and `base.ini`'s `baseUrl`.
- `base.ini`, `sw.js`, `imagediff2_bg.wasm`, `fonts/`, `icon/`, `movies/`, `MOD/`.

## Using it

```bash
node out/tools/split.js      # game.js  -> out/**  (regenerates manifest.json)
node out/tools/build.js      # out/**   -> game.js (byte-identical)
node out/tools/build.js --check          # verify without writing
node out/tools/devpage.js    # index.html -> dev.html (one script tag per source file)
```

Serve the **project root** and open `/dev.html` to run the split sources instead of the
bundle. `dev.html` is generated at the root rather than inside `out/` for a concrete
reason: the game resolves the media packs against `window.location.href`, `base.ini`
against the document URL, and `imagediff2_bg.wasm` against `document.currentScript.src`.
A page served from `out/` would look for `/out/img_pack/`, `/out/base.ini` and
`/out/site/imagediff2_bg.wasm`, and 404. From the root every asset path is identical to
the shipped page, so the two behave the same — `dev.html` just trades one 3 MB script for
31 requests you can edit and reload individually.

### Caveats

- **Line endings.** `out/**` is LF; the bundle is CRLF. `build.js` converts back, so an
  edited file must keep `\n` endings to stay byte-exact. All six files that also exist
  under `js/libs/` match those copies byte-for-byte, except that `pixi-tilemap.js`,
  `pixi-picture.js` and `iphone-inline-video.browser.js` have no trailing newline on disk
  and one here.
- **Separate scripts vs one script.** Loading 31 `<script>` tags gives the browser a
  chance to run microtasks between files, which a single concatenated script does not.
  `site/wc.js` is the only file that could notice (it calls `window.__resumeBoot` from a
  promise callback); if an argument is ever made for it, the failure mode is a no-op
  resume that falls back to the plain `window.onload` path, not a hang.
- **`trailingNewlines`** in `manifest.json` is per file (4 for most, 3 for six of them, 0
  for the last). It is what makes the rebuild byte-exact, so do not hand-edit it.
- Third-party files remain under their own licences (PIXI MIT, fflate MIT,
  fast-json-patch MIT, LZString MIT, and the RPG Maker MV runtime).
