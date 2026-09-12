        window._cachedTitleData = null;
        
        function handleSaveUpload(event) {
            var files = event.target.files;
            var loaded = 0;
            var statusEl = document.getElementById('saveUploadStatus');
            statusEl.textContent = 'Loading...';
            statusEl.style.color = '#ff0';
            var isTauri = !!(window.__TAURI__ && window.__TAURI__.core &&
                typeof window.__TAURI__.core.invoke === 'function');

            // On desktop, drop the file straight into the live save/ folder
            // (window.__importSave mirrors it to disk and refreshes the scene).
            // On web, keep the legacy localStorage keys.
            function importOne(name, raw, lsKey) {
                if (isTauri && window.__importSave) window.__importSave(name, raw);
                else if (lsKey) localStorage.setItem(lsKey, raw);
                else window._cachedTitleData = raw;
                loaded++;
            }

            for (var i = 0; i < files.length; i++) {
                (function(file) {
                    var reader = new FileReader();
                    reader.onload = function(e) {
                        var content = e.target.result;
                        var fileName = file.name.toLowerCase();
                        var slotMatch = fileName.match(/file(\d+)\.rpgsave/i);
                        var slotId = slotMatch ? parseInt(slotMatch[1]) : null;

                        if (slotId && slotId >= 1 && slotId <= 20) {
                            var isCompressed = /^[A-Za-z0-9+/=]+$/.test(content.trim()) && content.length > 50;
                            var storageData = isCompressed ? content : (typeof LZString !== 'undefined' ? LZString.compressToBase64(content) : content);
                            importOne('file' + slotId + '.rpgsave', storageData, 'RPG File' + slotId);
                        } else if (fileName === 'global.rpgsave') {
                            var isComp = /^[A-Za-z0-9+/=]+$/.test(content.trim()) && content.length > 50;
                            importOne('global.rpgsave', isComp ? content : (typeof LZString !== 'undefined' ? LZString.compressToBase64(content) : content), 'RPG Global');
                        } else if (fileName === 'config.rpgsave') {
                            var isC = /^[A-Za-z0-9+/=]+$/.test(content.trim()) && content.length > 50;
                            importOne('config.rpgsave', isC ? content : (typeof LZString !== 'undefined' ? LZString.compressToBase64(content) : content), 'RPG Config');
                        } else if (fileName === 'titledata') {
                            importOne('TITLEDATA', content.trim(), null);
                        }

                        if (loaded === files.length) {
                            statusEl.textContent = loaded + ' save(s) loaded!' + (isTauri ? ' (applied live)' : ' Refresh to apply.');
                            statusEl.style.color = '#5f5';
                        }
                    };
                    reader.readAsText(file);
                })(files[i]);
            }
            event.target.value = '';
        }
        
        function handleSaveExport(event) {
            var statusEl = document.getElementById('saveUploadStatus');
            statusEl.textContent = 'Zipping...';
            statusEl.style.color = '#ff0';
            setTimeout(function() {
                try {
                    var isTauri = !!(window.__TAURI__ && window.__TAURI__.core &&
                        typeof window.__TAURI__.core.invoke === 'function');
                    var files = {};
                    var mem = window.__memoryFS || {};
                    for (var i = 1; i <= 20; i++) {
                        var slot = mem['save/file' + i + '.rpgsave'] || (!isTauri && localStorage.getItem('RPG File' + i));
                        if (slot) { files['file' + i + '.rpgsave'] = slot; }
                    }
                    var g = mem['save/global.rpgsave'] || (!isTauri && localStorage.getItem('RPG Global'));
                    if (g) { files['global.rpgsave'] = g; }
                    var c = mem['save/config.rpgsave'] || (!isTauri && localStorage.getItem('RPG Config'));
                    if (c) { files['config.rpgsave'] = c; }
                    var ttd = mem['save/TITLEDATA'] || mem['/TITLEDATA'] || mem['TITLEDATA'];
                    if (ttd) { files['TITLEDATA'] = ttd; }
                    Object.keys(mem).forEach(function(k) {
                        var name = k.replace(/^save\//, '');
                        if (/\.rpgsave$/.test(name) && !files[name]) { files[name] = mem[k]; }
                    });
                    var names = Object.keys(files);
                    if (names.length === 0) {
                        statusEl.textContent = 'No saves to export.';
                        statusEl.style.color = '#f88';
                        return;
                    }
                    if (typeof fflate !== 'undefined' && fflate.zipSync) {
                        var enc = new TextEncoder();
                        var byteFiles = {};
                        Object.keys(files).forEach(function(k) { byteFiles[k] = enc.encode(files[k]); });
                        var zipBytes = fflate.zipSync(byteFiles, { level: 0 });
                        var blob = new Blob([zipBytes], { type: 'application/zip' });
                        var a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = 'WO_Client_saves_' + new Date().toISOString().replace(/[:.]/g, '-') + '.zip';
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                    } else {
                        names.forEach(function(name) {
                            var b = new Blob([files[name]], { type: 'text/plain' });
                            var el = document.createElement('a');
                            el.href = URL.createObjectURL(b);
                            el.download = name;
                            document.body.appendChild(el);
                            el.click();
                            setTimeout(function() { URL.revokeObjectURL(el.href); el.remove(); }, 1000);
                        });
                    }
                    statusEl.textContent = names.length + ' save(s) exported!';
                    statusEl.style.color = '#5f5';
                } catch (e) {
                    statusEl.textContent = 'Export failed: ' + e.message;
                    statusEl.style.color = '#f88';
                }
            }, 10);
        }
