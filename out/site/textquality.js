// ---------------------------------------------------------------------------
// Fullscreen text quality (crisp text only; images/sprites are untouched)
// ---------------------------------------------------------------------------
// The whole game renders into a fixed 816x624 canvas and that canvas is then
// stretched in fullscreen. Text glyphs are rasterized once at 816x624, so the
// stretch makes text soft/blurry while smooth images survive fine.
//
// Fix: while fullscreen, each window's "contents" bitmap (the canvas that holds
// the text) is rasterized at 2x resolution and laid out back at its logical
// size. PIXI's BaseTexture.resolution does the layout part natively, so every
// frame/coordinate in the engine stays in logical (1x) units and nothing needs
// sprite scaling. Images, windowskins, tiles and sprites are left alone.
//
// Set QUALITY to 1 to disable the feature.
// ---------------------------------------------------------------------------
(function () {
    'use strict';

    var QUALITY = 2; // text supersample factor while fullscreen

    window.TextQuality = window.TextQuality || { scale: 1 };

    function isFullscreen() {
        return !!(document.fullscreenElement ||
                  document.webkitFullscreenElement ||
                  document.msFullscreenElement);
    }

    // --- Bitmap.width / height keep reporting logical (1x) dimensions ------
    // Plugins use contents.width / contents.height for layout math, so a 2x
    // contents canvas must still report its 1x size. Capture the original
    // getters and only divide when this bitmap has been supersampled.
    var _bitmapWidth = Object.getOwnPropertyDescriptor(Bitmap.prototype, 'width').get;
    var _bitmapHeight = Object.getOwnPropertyDescriptor(Bitmap.prototype, 'height').get;

    Object.defineProperty(Bitmap.prototype, 'width', {
        configurable: true,
        get: function () {
            var w = _bitmapWidth.call(this);
            var q = this.__textScale;
            return (q && q !== 1) ? Math.round(w / q) : w;
        }
    });

    Object.defineProperty(Bitmap.prototype, 'height', {
        configurable: true,
        get: function () {
            var h = _bitmapHeight.call(this);
            var q = this.__textScale;
            return (q && q !== 1) ? Math.round(h / q) : h;
        }
    });

    // --- Text measurement stays in logical units ---------------------------
    // The context has a 2x transform applied (see scaleBitmap), so measure in
    // an identity transform and report the true 1x advance width. Without this
    // fix, centering / wrapping math would see 2x widths.
    Bitmap.prototype.measureTextWidth = function (text) {
        var context = this._context;
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.font = this._makeFontNameText();
        var width = context.measureText(text).width;
        context.restore();
        return width;
    };

    // --- Rescale one contents bitmap to qx ---------------------------------
    function scaleBitmap(bitmap, q) {
        if (!bitmap || !bitmap.__canvas) return;
        var oldQ = bitmap.__textScale || 1;
        if (oldQ === q) return;

        var canvas = bitmap.__canvas;
        var oldW = canvas.width;
        var oldH = canvas.height;
        var logicalW = Math.max(1, Math.round(oldW / oldQ));
        var logicalH = Math.max(1, Math.round(oldH / oldQ));

        // Preserve whatever is already drawn so a live fullscreen toggle never
        // blanks an open window (the window refreshes itself right after).
        var tmp = document.createElement('canvas');
        tmp.width = oldW;
        tmp.height = oldH;
        tmp.getContext('2d').drawImage(canvas, 0, 0);

        // Resizing resets the 2d context state, so this must happen before the
        // transform below.
        canvas.width = Math.max(1, logicalW * q);
        canvas.height = Math.max(1, logicalH * q);
        bitmap.__textScale = q;

        // PIXI: keep the full-resolution canvas on the GPU but report logical
        // width/height (realWidth / resolution) so sprites render it at 1x
        // size with 2x pixel density. This keeps every frame coordinate in the
        // engine's normal logical space -- no sprite scaling, no frame math.
        var bt = bitmap._baseTexture;
        bt.resolution = q;
        bt.realWidth = canvas.width;
        bt.realHeight = canvas.height;
        bt.width = canvas.width / q;
        bt.height = canvas.height / q;

        // Downscale with bilinear filtering: averaging the 2x samples is what
        // turns the "big" raster into smooth, antialiased text. Nearest
        // filtering would just drop every other pixel and leave jaggies.
        bitmap.smooth = (q > 1);

        var ctx = canvas.getContext('2d');
        ctx.setTransform(q, 0, 0, q, 0, 0);
        ctx.drawImage(tmp, 0, 0, logicalW, logicalH);

        bitmap._setDirty();
    }

    // --- Walk a scene graph for windows ------------------------------------
    function walkWindows(node, cb) {
        if (!node) return;
        if (node._windowContentsSprite && node.contents) cb(node);
        var children = node.children;
        if (children) {
            for (var i = 0; i < children.length; i++) {
                walkWindows(children[i], cb);
            }
        }
    }

    function rescaleAll(q) {
        if (!window.SceneManager) return;
        var scenes = [];
        if (SceneManager._scene) scenes.push(SceneManager._scene);
        if (SceneManager._stack) scenes = scenes.concat(SceneManager._stack);
        for (var i = 0; i < scenes.length; i++) {
            walkWindows(scenes[i], function (win) {
                scaleBitmap(win.contents, q);
                if (typeof win.refresh === 'function') {
                    try { win.refresh(); } catch (e) {}
                }
            });
        }
    }

    function setScale(q) {
        if (q === window.TextQuality.scale) return;
        window.TextQuality.scale = q;
        rescaleAll(q);
    }

    function onFsChange() {
        setScale(isFullscreen() ? QUALITY : 1);
    }

    // --- New window contents pick up the current scale ---------------------
    var _createContents = Window_Base.prototype.createContents;
    Window_Base.prototype.createContents = function () {
        _createContents.call(this);
        scaleBitmap(this.contents, window.TextQuality.scale || 1);
    };

    // --- React to fullscreen changes ---------------------------------------
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('msfullscreenchange', onFsChange);

    if (isFullscreen()) {
        window.TextQuality.scale = QUALITY;
    }
})();
