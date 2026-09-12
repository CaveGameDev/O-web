//=============================================================================
// main.js
//=============================================================================

window.onload = function() {
    function startGame() {
        // Data/maps/assets are ready before plugin setup. Wait for every plugin
        // script to execute as well; appending script tags is asynchronous in a
        // browser, and SceneManager must not initialize input until plugins
        // such as Omori Name Input have installed their hooks.
        return Promise.resolve(PluginManager.setup($plugins)).then(function() {
            SceneManager.run(Scene_Boot);
        });
    }

    if (typeof window.ModLoader !== 'undefined' && typeof ModLoader.boot === 'function') {
        // The mod engine owns the boot gate: it waits for the player to click
        // LAUNCH, applies any staged mods into the VFS and $plugins, then
        // starts the game with the modded data already in place.
        ModLoader.boot(startGame);
        return;
    }

    if (typeof ZipLoader !== 'undefined' && ZipLoader.init) {
        // Extraction finishing only makes Launch available. The game must not
        // boot until the player explicitly clicks that button.
        ZipLoader.init()
            .then(ZipLoader.waitForLaunch)
            .then(startGame)
            .catch(function(error) {
                console.error('ZipLoader: data/maps boot failed:', error);
                // Do not start the game with missing database data.
            });
    } else {
        // The game must never boot without the zip-backed database and maps.
        // A missing loader is a deployment error, not a reason to fall back to
        // ordinary network requests that can race or return partial files.
        console.error('ZipLoader is unavailable; game boot halted.');
    }
};
