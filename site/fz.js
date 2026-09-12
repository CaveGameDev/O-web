        (function() {
            if (!document.getElementById('consolearea')) {
                const consolearea = document.createElement('div');
                consolearea.id = 'consolearea';
                consolearea.style.display = 'none';
                document.body.appendChild(consolearea);
            }
            if (!document.getElementById('ErrorPrinter')) {
                const errorPrinter = document.createElement('div');
                errorPrinter.id = 'ErrorPrinter';
                errorPrinter.style.display = 'none';
                document.body.appendChild(errorPrinter);
            }
        })();
