        (function() {
            if (window.__resumeBoot) return;
            var realBoot = window.onload;
            window.onload = function() {};
            window.__resumeBoot = function() {
                window.__resumeBoot = function() {};
                if (typeof realBoot === 'function') realBoot();
            };
        })();
