        (function() {
            'use strict';
            if (typeof window.__TAURI__ !== 'undefined' && window.__TAURI__) {
                // Native desktop build: never touch IndexedDB. All persistence
                // goes through the Rust backend (save/ folder next to the exe).
                // Provide a no-op WOClient so vfs_bridge.js / modloader.js keep
                // working without a real IndexedDB connection.
                window.WOClient = {
                    DB_NAME: 'WO_Client',
                    put: function() {},
                    remove: function() {},
                    loadAll: function() { return Promise.resolve([]); }
                };
                return;
            }
            var DB_NAME = 'WO_Client';
            var STORE = 'files';
            var dbPromise = null;
            function openDb() {
                if (dbPromise) return dbPromise;
                if (typeof indexedDB === 'undefined') {
                    dbPromise = Promise.reject(new Error('indexedDB unavailable'));
                    return dbPromise;
                }
                dbPromise = new Promise(function(resolve, reject) {
                    var req = indexedDB.open(DB_NAME, 1);
                    req.onupgradeneeded = function(e) {
                        var db = e.target.result;
                        if (!db.objectStoreNames.contains(STORE)) {
                            db.createObjectStore(STORE, { keyPath: 'path' });
                        }
                    };
                    req.onsuccess = function(e) { resolve(e.target.result); };
                    req.onerror = function(e) { reject(e.target.error); };
                });
                return dbPromise;
            }
            function put(path, data) {
                openDb().then(function(db) {
                    return new Promise(function(resolve, reject) {
                        var tx = db.transaction(STORE, 'readwrite');
                        tx.objectStore(STORE).put({ path: path, data: data });
                        tx.oncomplete = resolve;
                        tx.onerror = function() { reject(tx.error); };
                    });
                }).catch(function() {});
            }
            function remove(path) {
                openDb().then(function(db) {
                    return new Promise(function(resolve, reject) {
                        var tx = db.transaction(STORE, 'readwrite');
                        tx.objectStore(STORE).delete(path);
                        tx.oncomplete = resolve;
                        tx.onerror = function() { reject(tx.error); };
                    });
                }).catch(function() {});
            }
            function loadAll() {
                return openDb().then(function(db) {
                    return new Promise(function(resolve, reject) {
                        var tx = db.transaction(STORE, 'readonly');
                        var req = tx.objectStore(STORE).getAll();
                        req.onsuccess = function() { resolve(req.result || []); };
                        req.onerror = function() { reject(req.error); };
                    });
                }).catch(function() { return []; });
            }
            window.WOClient = { DB_NAME: DB_NAME, put: put, remove: remove, loadAll: loadAll };
            loadAll().then(function(entries) {
                if (window.__memoryFS) {
                    (entries || []).forEach(function(e) { window.__memoryFS[e.path] = e.data; });
                }
            });
        })();
