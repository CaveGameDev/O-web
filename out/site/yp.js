//Simply put, CDN path call patches because I'm lazy asf :>
(function() {
        'use strict';
        
        // The CDN base comes from base.ini (baseUrl=). It is resolved
        // asynchronously below (and re-applied by ZipLoader.applyConfig) so
        // every js/, movies/ and fonts/ request can be prefixed with it; it
        // stays empty until then, or permanently when base.ini has no baseUrl.
        window.__CDN_BASE = '';

        function cdnBase() {
            var base = String(window.__CDN_BASE || '').replace(/\/+$/, '');
            return base ? base + '/' : '';
        }

        // Adopt the base.ini baseUrl as the origin for js/movies/fonts and
        // point the GameFont @font-face at it too — the CSS-declared font URL
        // cannot be caught by the XHR/script hooks below, so it is rewritten
        // here once the base is known.
        window.__applyCdnBase = function(baseUrl) {
            window.__CDN_BASE = String(baseUrl || '');
            var base = cdnBase();
            try {
                for (var s = 0; s < document.styleSheets.length; s++) {
                    var rules;
                    try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
                    if (!rules) continue;
                    for (var r = 0; r < rules.length; r++) {
                        var rule = rules[r];
                        if (!rule || rule.type !== 5 || !rule.style) continue; // CSSFontFaceRule
                        if (String(rule.style.getPropertyValue('font-family') || '').indexOf('GameFont') < 0) continue;
                        rule.style.setProperty('src', 'url("' + base + 'fonts/OMORI_GAME2.ttf")');
                    }
                }
            } catch (e) {}
        };

        // Fetch base.ini early (a few hundred bytes) so the CDN base is in
        // place before any plugin script, movie or font URL is built.
        if (typeof window.fetch === 'function') {
            window.fetch('base.ini').then(function(response) {
                return response.ok ? response.text() : '';
            }).then(function(text) {
                var match = String(text).match(/^\s*baseUrl\s*=\s*(.+)$/im);
                if (match) window.__applyCdnBase(match[1].trim());
            }).catch(function() {});
        }
        
        function removeDuplicatePackPaths(url) {
            if (typeof url !== 'string') return url;
            var regex = /(aud_pack|img_pack)\/\1\//gi;
            var previous;
            do {
                previous = url;
                url = url.replace(regex, '$1/');
            } while (url !== previous);
            return url;
        }

        function stripSdcardPath(path) {
            if (!path || typeof path !== 'string') return path;
            var prefix = '/sdcard/OMORI/';
            if (path.indexOf(prefix) === 0) return path.substring(prefix.length);
            if (path.indexOf('sdcard/OMORI/') === 0) return path.substring(13);
            return path;
        }

        function rewriteToCDN(url) {
            if (!url || typeof url !== 'string') return url;

            if (/^(https?:)?\/\//i.test(url)) return url;
            if (/^data:/i.test(url)) return url;
            if (/^blob:/i.test(url)) return url;        
            var p = url.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
            if (p.indexOf('movies/') === 0 || p.indexOf('fonts/') === 0) {
                return cdnBase() + p;
            }
            return url;
        }

        window.stripSdcardPath = function(path) {
            return removeDuplicatePackPaths(stripSdcardPath(path));
        };
        window.rewriteToCDN = function(url) {
            return removeDuplicatePackPaths(rewriteToCDN(url));
        };

        var origXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            if (typeof url === 'string') {
                url = removeDuplicatePackPaths(stripSdcardPath(url));
                url = removeDuplicatePackPaths(rewriteToCDN(url));
            }
            return origXHROpen.call(this, method, url, async !== false, user, password);
        };

        if (typeof window.fetch !== 'undefined') {
            var origFetch = window.fetch;
            window.fetch = function(input, init) {
                var url;
                if (typeof input === 'string') {
                    url = input;
                } else if (input instanceof Request) {
                    url = input.url;
                } else {
                    return origFetch.call(this, input, init);
                }
                var cleaned = removeDuplicatePackPaths(url);
                if (cleaned !== url) {
                    if (typeof input === 'string') {
                        return origFetch.call(this, cleaned, init);
                    } else {
                        var newReq = new Request(cleaned, input);
                        return origFetch.call(this, newReq, init);
                    }
                }
                return origFetch.call(this, input, init);
            };
        }
        var origSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
        if (origSrcDesc && origSrcDesc.set) {
            Object.defineProperty(HTMLScriptElement.prototype, 'src', {
                get: origSrcDesc.get,
                set: function(url) {
                    if (typeof url === 'string') {
                        url = removeDuplicatePackPaths(stripSdcardPath(url));
                        url = removeDuplicatePackPaths(rewriteToCDN(url));
                    }
                    origSrcDesc.set.call(this, url);
                },
                configurable: true
            });
        }

        // Movies: Graphics._playVideo and the YSP VideoPlayer assign <video>
        // src directly (no XHR), so hook the media element src setter the same
        // way as script src. Cross-origin video sources get crossOrigin=anonymous
        // so PIXI can upload them as WebGL textures — the base.ini host must be
        // CORS-enabled anyway, since the zips are fetched with fetch().
        var mediaSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (mediaSrcDesc && mediaSrcDesc.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                get: mediaSrcDesc.get,
                set: function(url) {
                    if (typeof url === 'string') {
                        url = removeDuplicatePackPaths(stripSdcardPath(url));
                        var cleaned = removeDuplicatePackPaths(rewriteToCDN(url));
                        if (cleaned !== url && this.tagName === 'VIDEO' && /^https?:\/\//i.test(cleaned)) {
                            try { this.crossOrigin = 'anonymous'; } catch (e) {}
                        }
                        url = cleaned;
                    }
                    mediaSrcDesc.set.call(this, url);
                },
                configurable: true
            });
        }
    })();
