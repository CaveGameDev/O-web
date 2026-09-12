    (function() {
        'use strict';

        var ua = navigator.userAgent || '';
        var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
        var hasTouch = isMobile ||
                       (('ontouchstart' in window) && (navigator.maxTouchPoints > 0));

        var _stretchBeforeFullscreen = null;

        function applyFullscreenFill(isFs) {
            var canvases = ['GameCanvas', 'GameVideo', 'UpperCanvas'];
            for (var j = 0; j < canvases.length; j++) {
                var c = document.getElementById(canvases[j]);
                if (!c) continue;
                if (isFs) {
                    c.style.position = 'absolute';
                    c.style.margin = '0';
                    c.style.transform = 'none';
                    c.style.left = '50%';
                    c.style.top = '50%';
                    c.style.imageRendering = 'auto';
                    c.style.transition = 'width 0.15s ease, height 0.15s ease';
                } else {
                    c.style.position = '';
                    c.style.margin = '';
                    c.style.transform = '';
                    c.style.left = '';
                    c.style.top = '';
                    c.style.width = '';
                    c.style.height = '';
                    c.style.imageRendering = '';
                    c.style.transition = '';
                }
            }
            if (isFs) { sizeFullscreenCanvases(); }
        }

        function sizeFullscreenCanvases() {
            var w = 0, h = 0;
            var maxW = window.innerWidth;
            var maxH = window.innerHeight;
            if ((maxW * 0.75) > maxH) {
                h = maxH;
                w = Math.floor((maxH / 3) * 4);
            } else {
                w = maxW;
                h = Math.floor((maxW / 4) * 3);
            }
            var canvases = ['GameCanvas', 'GameVideo', 'UpperCanvas'];
            for (var j = 0; j < canvases.length; j++) {
                var c = document.getElementById(canvases[j]);
                if (c) {
                    c.style.width  = w + 'px';
                    c.style.height = h + 'px';
                    c.style.marginLeft = -(w / 2) + 'px';
                    c.style.marginTop  = -(h / 2) + 'px';
                }
            }
        }

        function onFullscreenChange() {
            var isFs = !!(document.fullscreenElement ||
                          document.webkitFullscreenElement ||
                          document.msFullscreenElement);
            if (!window.Graphics) return;

            if (isFs) {
                if (_stretchBeforeFullscreen === null) {
                    _stretchBeforeFullscreen = Graphics._stretchEnabled;
                }
                Graphics._stretchEnabled = true;
            } else {
                if (_stretchBeforeFullscreen !== null) {
                    Graphics._stretchEnabled = _stretchBeforeFullscreen;
                    _stretchBeforeFullscreen = null;
                }
            }
            applyFullscreenFill(isFs);
            Graphics._updateAllElements();

            if (typeof repositionControls === 'function') {
                setTimeout(repositionControls, 80);
            }
        }

        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        document.addEventListener('msfullscreenchange', onFullscreenChange);
        window.addEventListener('resize', function() {
            if (document.fullscreenElement || document.webkitFullscreenElement ||
                document.msFullscreenElement) {
                sizeFullscreenCanvases();
            }
        });

        var _origSwitchFullScreen = null;
        function patchGraphicsFS() {
            if (!window.Graphics || !Graphics._switchFullScreen) return;
            if (Graphics._switchFullScreen === patchedSwitch) return;
            _origSwitchFullScreen = Graphics._switchFullScreen;
            Graphics._switchFullScreen = patchedSwitch;
        }
        function patchedSwitch() {
            _origSwitchFullScreen.apply(this, arguments);
        }
        var _fsPatchTries = 0;
        var _fsPatchTimer = setInterval(function() {
            _fsPatchTries++;
            patchGraphicsFS();
            if (_origSwitchFullScreen || _fsPatchTries > 100) clearInterval(_fsPatchTimer);
        }, 100);

        if (!hasTouch) return;

        (function() {
            try {
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(function() {});
                }
            } catch(_) {}
            function onOrientChange() {
                try {
                    if (screen.orientation && screen.orientation.lock) {
                        screen.orientation.lock('landscape').catch(function() {});
                    }
                } catch(_) {}
            }
            screen.orientation && screen.orientation.addEventListener('change', onOrientChange);
        })();

        var controlsEl   = document.getElementById('mobileControls');
        var toggleEl     = document.getElementById('mctrlToggle');
        if (controlsEl) controlsEl.style.display = 'flex';
        if (toggleEl)   toggleEl.style.display   = 'flex';

        var leftPanel    = document.getElementById('mctrlLeftPanel');
        var rightPanel   = document.getElementById('mctrlRightPanel');
        var controlsVisible = true;

        var btnMap = {
            mctrlDpadUp:    38,  mctrlDpadDown:  40,
            mctrlDpadLeft:  37,  mctrlDpadRight: 39,
            mctrlBtnZ:      90,  mctrlBtnX:      88,
            mctrlBtnShift:  16,  mctrlBtnQ:      81,
            mctrlBtnW:      87,  mctrlBtnA:      65
        };

        var heldKeys = {};

        function fireKey(elId, type) {
            var code = btnMap[elId];
            if (code == null) return;

            if (type === 'keydown') {
                if (heldKeys[code]) return;
                heldKeys[code] = true;
            } else {
                if (!heldKeys[code]) return;
                heldKeys[code] = false;
            }

            var ev;
            try {
                ev = new KeyboardEvent(type, { bubbles: true, cancelable: true });
            } catch(e) {
                ev = document.createEvent('KeyboardEvent');
                if (ev.initKeyboardEvent) {
                    ev.initKeyboardEvent(type, true, true, window, '', 0, '', false, '');
                } else if (ev.initKeyEvent) {
                    ev.initKeyEvent(type, true, true, window, false, false, false, false, code, 0);
                }
            }

            try {
                Object.defineProperty(ev, 'keyCode', { get: function() { return code; } });
                Object.defineProperty(ev, 'which',  { get: function() { return code; } });
            } catch(_) {}

            document.dispatchEvent(ev);
        }

        function markPressed(el, on) {
            if (on) { el.classList.add('pressed'); }
            else    { el.classList.remove('pressed'); }
        }

        Object.keys(btnMap).forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;

            el.addEventListener('pointerdown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                el.setPointerCapture(e.pointerId);
                markPressed(el, true);
                fireKey(id, 'keydown');
            });

            el.addEventListener('pointerup', function(e) {
                e.preventDefault();
                e.stopPropagation();
                markPressed(el, false);
                fireKey(id, 'keyup');
            });

            el.addEventListener('pointerleave', function(e) {
                markPressed(el, false);
                fireKey(id, 'keyup');
            });

            el.addEventListener('pointercancel', function(e) {
                markPressed(el, false);
                fireKey(id, 'keyup');
            });

            el.addEventListener('contextmenu', function(e) {
                e.preventDefault();
            });
        });

        function releaseAll() {
            Object.keys(heldKeys).forEach(function(c) {
                var code = +c;
                if (!heldKeys[code]) return;
                heldKeys[code] = false;
                try {
                    var ev = new KeyboardEvent('keyup', { bubbles: true, cancelable: true });
                    Object.defineProperty(ev, 'keyCode', { get: function() { return code; } });
                    Object.defineProperty(ev, 'which',  { get: function() { return code; } });
                    document.dispatchEvent(ev);
                } catch(_) {}
            });
            Object.keys(btnMap).forEach(function(id) {
                var el = document.getElementById(id);
                if (el) markPressed(el, false);
            });
        }

        function repositionControls() {
            if (!controlsVisible) return;

            var canvas = document.getElementById('GameCanvas');
            if (!canvas) return;

            var cRect = canvas.getBoundingClientRect();
            var vw = window.innerWidth;
            var vh = window.innerHeight;

            var leftBarWidth  = cRect.left;
            var rightBarWidth = vw - cRect.right;
            var bottomBarHeight = vh - cRect.bottom;

            var dpadSize = 150;
            var btnAreaWidth = 120;
            var minSidebar = 60;

            if (leftBarWidth >= minSidebar && rightBarWidth >= btnAreaWidth) {
                controlsEl.style.flexDirection = 'row';
                controlsEl.style.justifyContent = 'space-between';
                controlsEl.style.alignItems = 'center';
                controlsEl.style.paddingLeft  = Math.max(6, (leftBarWidth - dpadSize) / 2) + 'px';
                controlsEl.style.paddingRight = Math.max(6, (rightBarWidth - btnAreaWidth) / 2) + 'px';
                controlsEl.style.paddingTop = '0px';
                controlsEl.style.paddingBottom = '0px';
                leftPanel.style.display = '';
                rightPanel.style.display = '';
                rightPanel.style.flexDirection = 'column';
            } else if (bottomBarHeight >= 140) {
                controlsEl.style.flexDirection = 'row';
                controlsEl.style.justifyContent = 'space-between';
                controlsEl.style.alignItems = 'flex-end';
                controlsEl.style.paddingLeft = '16px';
                controlsEl.style.paddingRight = '16px';
                controlsEl.style.paddingTop = '0px';
                controlsEl.style.paddingBottom = Math.max(4, (bottomBarHeight - dpadSize) / 2) + 'px';
                leftPanel.style.display = '';
                rightPanel.style.display = '';
                rightPanel.style.flexDirection = 'column';
            } else {
                controlsEl.style.display = 'none';
                return;
            }
            controlsEl.style.display = 'flex';
        }

        window.repositionControls = repositionControls;

        window.addEventListener('resize', function() {
            setTimeout(repositionControls, 80);
        });
        window.addEventListener('orientationchange', function() {
            setTimeout(repositionControls, 300);
        });

        var _posRetries = 0;
        var _posTimer = setInterval(function() {
            _posRetries++;
            if (document.getElementById('GameCanvas') || _posRetries > 200) {
                clearInterval(_posTimer);
                repositionControls();
            }
        }, 100);

        toggleEl.addEventListener('pointerdown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            controlsVisible = !controlsVisible;
            controlsEl.style.display = controlsVisible ? 'flex' : 'none';
            toggleEl.textContent = controlsVisible ? 'Hide Controls' : 'View Controls';
            if (!controlsVisible) {
                releaseAll();
            } else {
                repositionControls();
            }
        });

        window.addEventListener('pagehide', releaseAll);
    })();
