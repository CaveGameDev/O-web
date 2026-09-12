        (function() {
            'use strict';

            const STEAM_KEY = '6bdb2e585882fbd48826ef9cffd4c511';

            const isTauri = typeof window.__TAURI__ !== 'undefined' &&
                            !!window.__TAURI__ &&
                            !!window.__TAURI__.core &&
                            typeof window.__TAURI__.core.invoke === 'function';

            function browserWindow() {
                return {
                    showDevTools: function() {},
                    enterFullscreen: function() { document.documentElement.requestFullscreen?.().catch(() => {}); },
                    leaveFullscreen: function() { document.exitFullscreen?.().catch(() => {}); },
                    focus: function() { window.focus(); },
                    on: function() { return this; },
                    close: function() { window.close(); },
                    minimize: function() {},
                    maximize: function() {},
                    isFullscreen: function() { return !!document.fullscreenElement; },
                    setResizable: function() {},
                    setPosition: function(x, y) { window.moveTo(x, y); },
                    setSize: function(w, h) { window.resizeTo(w, h); },
                    show: function() {},
                    hide: function() {},
                    reload: function() { window.location.reload(); }
                };
            }

            if (isTauri) {
                // Tauri v2 exposes each API module as a namespace on the
                // injected global: window.__TAURI__.core.invoke, .app, .window…
                var invoke = window.__TAURI__.core.invoke;
                var _fullscreen = false;
                var dataPath = '';

                // Window/app control is routed through custom Rust commands, so
                // it never depends on the v2 capability ACL for core:window.
                function ipc(name, args) {
                    try {
                        return invoke(name, args || {}).catch(function() {});
                    } catch (e) {
                        return null;
                    }
                }

                var _nativeClose = window.close;

                function quit() {
                    try {
                        ipc('quit_app');
                    } catch (e) {
                        try { _nativeClose.call(window); } catch (e2) {}
                    }
                }

                // The game quits via SceneManager.terminate() -> window.close().
                // In WebView2 that only tears down the page, leaving the Rust
                // process (the tauri.localhost shell) running. Route it through
                // quit_app so the whole shell exits with the game.
                window.close = quit;

                // Freeze the game when the window is not focused or is
                // minimized, matching browser tab-switch behaviour: stop the
                // PIXI ticker (the game loop GTP_OmoriFixes installs) so no
                // logic or rendering advances, then restart it on focus.
                var _gameHasFocus = true;
                var _gameDocHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
                var _gameFrozen = false;

                // Suspend every live AudioContext (regular WebAudio + the
                // streaming class) so BGM/SE/ME actually stop, and pause the
                // cutscene <video> element which has its own audio track.
                function _eachAudioContext(fn) {
                    var ctxs = [];
                    try { if (window.WebAudio && WebAudio._context) ctxs.push(WebAudio._context); } catch (e) {}
                    try {
                        if (window.StreamWebAudio && StreamWebAudio._context &&
                            ctxs.indexOf(StreamWebAudio._context) < 0) {
                            ctxs.push(StreamWebAudio._context);
                        }
                    } catch (e) {}
                    for (var i = 0; i < ctxs.length; i++) {
                        try { fn(ctxs[i]); } catch (e) {}
                    }
                }

                function _freezeMedia() {
                    _eachAudioContext(function(ctx) {
                        if (typeof ctx.suspend === 'function') {
                            var p = ctx.suspend();
                            if (p && p.catch) p.catch(function() {});
                        }
                    });
                    try {
                        if (window.Graphics && Graphics._video &&
                            Graphics.isVideoPlaying && Graphics.isVideoPlaying()) {
                            Graphics._video.pause();
                        }
                    } catch (e) {}
                }

                function _resumeMedia() {
                    _eachAudioContext(function(ctx) {
                        if (typeof ctx.resume === 'function') {
                            var p = ctx.resume();
                            if (p && p.catch) p.catch(function() {});
                        }
                    });
                    try {
                        if (window.Graphics && Graphics._video &&
                            Graphics.isVideoPlaying && Graphics.isVideoPlaying()) {
                            var p = Graphics._video.play();
                            if (p && p.catch) p.catch(function() {});
                        }
                    } catch (e) {}
                }

                function _syncGameFreeze() {
                    var frozen = _gameDocHidden || !_gameHasFocus;
                    if (frozen === _gameFrozen) return;
                    _gameFrozen = frozen;
                    try {
                        var sm = window.SceneManager;
                        if (sm && sm.ticker) {
                            if (frozen) {
                                sm.ticker.stop();
                                _freezeMedia();
                            } else if (!sm._stopped) {
                                sm.ticker.start();
                                _resumeMedia();
                            }
                        }
                    } catch (e) {}
                }

                function _setGameFocus(focused) {
                    _gameHasFocus = !!focused;
                    _syncGameFreeze();
                }

                window.addEventListener('blur', function() { _setGameFocus(false); });
                window.addEventListener('focus', function() { _setGameFocus(true); });
                document.addEventListener('visibilitychange', function() {
                    _gameDocHidden = (document.visibilityState === 'hidden');
                    _syncGameFreeze();
                });

                // Native focus events are authoritative on Windows/WebView2.
                if (window.__TAURI__.window && typeof window.__TAURI__.window.getCurrentWindow === 'function') {
                    try {
                        var _tw = window.__TAURI__.window.getCurrentWindow();
                        if (_tw && typeof _tw.onFocusChanged === 'function') {
                            _tw.onFocusChanged(function(ev) { _setGameFocus(!!(ev && ev.payload)); });
                        }
                    } catch (e) {}
                }

                // Safety net: document.hasFocus() covers boot-while-unfocused
                // (the ticker doesn't exist yet when the first blur fires) and
                // any platform that drops the events above.
                setInterval(function() {
                    try {
                        _gameHasFocus = document.hasFocus();
                        _gameDocHidden = (document.visibilityState === 'hidden');
                        _syncGameFreeze();
                    } catch (e) {}
                }, 750);

                function openExternal(url) {
                    try {
                        ipc('open_external', { url: String(url) });
                    } catch (e) { window.open(url, '_blank'); }
                }

                function enterFullscreen() {
                    _fullscreen = true;
                    ipc('set_fullscreen', { fullscreen: true });
                }

                function leaveFullscreen() {
                    _fullscreen = false;
                    ipc('set_fullscreen', { fullscreen: false });
                }

                window.nw = {
                    App: {
                        argv: ['nw', 'index.html', '--' + STEAM_KEY],
                        quit: quit,
                        dataPath: dataPath,
                        manifest: { name: 'OMORI', version: '1.0.0', main: 'index.html' },
                        on: function(event, callback) {
                            if (event === 'open' || event === 'ready') setTimeout(callback, 0);
                            return this;
                        },
                        getDataPath: function() { return dataPath; },
                        getManifest: function() { return { name: 'OMORI', version: '1.0.0' }; },
                        getArgv: function() { return ['nw', 'index.html', '--' + STEAM_KEY]; },
                        getFullArgv: function() { return ['nw', 'index.html', '--' + STEAM_KEY]; },
                        clearCache: function() {},
                        closeAllWindows: quit
                    },
                    Window: {
                        get: function() {
                            return {
                                showDevTools: function() {},
                                enterFullscreen: enterFullscreen,
                                leaveFullscreen: leaveFullscreen,
                                focus: function() { ipc('focus_window'); },
                                on: function() { return this; },
                                close: quit,
                                minimize: function() { ipc('minimize_window'); },
                                maximize: function() { ipc('maximize_window'); },
                                isFullscreen: function() { return _fullscreen || !!document.fullscreenElement; },
                                setResizable: function() {},
                                setPosition: function(x, y) {
                                    ipc('set_window_position', { x: Math.round(x), y: Math.round(y) });
                                },
                                setSize: function(width, height) {
                                    ipc('set_window_size', { width: Math.round(width), height: Math.round(height) });
                                },
                                show: function() {},
                                hide: function() {},
                                reload: function() { window.location.reload(); }
                            };
                        }
                    },
                    Shell: {
                        openExternal: openExternal
                    }
                };

                // Resolve the real save-folder path from the Rust backend once
                // it is available, so desktop mods/plugins that read
                // nw.App.dataPath see the native location.
                try {
                    invoke('get_data_path', {}).then(function(p) {
                        if (p) {
                            dataPath = p;
                            window.nw.App.dataPath = p;
                        }
                    }).catch(function() {});
                } catch (e) {}
            } else {
                window.nw = {
                    App: {
                        argv: ['nw', 'index.html', '--' + STEAM_KEY],
                        quit: function() { window.close(); },
                        dataPath: '/home/web/.config/omori',
                        manifest: { name: 'OMORI', version: '1.0.0', main: 'index.html' },
                        on: function(event, callback) {
                            if (event === 'open' || event === 'ready') setTimeout(callback, 0);
                            return this;
                        },
                        getDataPath: function() { return '/home/web/.config/omori'; },
                        getManifest: function() { return { name: 'OMORI', version: '1.0.0' }; },
                        getArgv: function() { return ['nw', 'index.html', '--' + STEAM_KEY]; },
                        getFullArgv: function() { return ['nw', 'index.html', '--' + STEAM_KEY]; },
                        clearCache: function() {},
                        closeAllWindows: function() { window.close(); }
                    },
                    Window: {
                        get: function() { return browserWindow(); }
                    },
                    Shell: {
                        openExternal: function(url) { window.open(url, '_blank'); }
                    }
                };
            }

            window.nw.gui = window.nw;
            window.gui = window.nw;
        })();
