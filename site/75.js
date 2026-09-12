        if (typeof window.process === 'undefined') {
            window.process = {
                platform: 'browser',
                versions: { node: '12.0.0', chrome: '80.0.0' },
                env: { NODE_ENV: 'production' },
                cwd: function() { return '/'; },
                nextTick: function(cb) { setTimeout(cb, 0); }
            };
        }
        if (!window.process.mainModule) {
            window.process.mainModule = { filename: '/index.html', paths: [] };
        }
        if (!window.process.argv) window.process.argv = ['nw', '/index.html'];
        if (!window.process.execPath) window.process.execPath = '/usr/bin/node';
        if (typeof window.process.chdir !== 'function') window.process.chdir = function() {};
        if (typeof window.process.exit !== 'function') window.process.exit = function() { window.close(); };
        if (!window.process.env) window.process.env = {};


        if (typeof window.chrome === 'undefined') window.chrome = {};
        if (typeof window.chrome.runtime !== 'object' || window.chrome.runtime === null) {
            window.chrome.runtime = {
                reload: function() { window.location.reload(); },
                sendMessage: function() {},
                getURL: function(p) { return p; },
                id: 'omori-web',
                onMessage: { addListener: function() {} },
                onInstalled: { addListener: function() {} }
            };
        } else {
            if (typeof window.chrome.runtime.reload !== 'function') {
                window.chrome.runtime.reload = function() { window.location.reload(); };
            }
            if (typeof window.chrome.runtime.sendMessage !== 'function') {
                window.chrome.runtime.sendMessage = function() {};
            }
            if (typeof window.chrome.runtime.getURL !== 'function') {
                window.chrome.runtime.getURL = function(p) { return p; };
            }
        }
