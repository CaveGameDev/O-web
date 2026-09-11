

(function($) {
    const Alias_getTextData = $.getTextData;
        $.getTextData = function(file, name, language) {
            // Set Default Language
            if (language === undefined) { language = this._language; }
            // Add null checks
            if (!this._data[language] || !this._data[language].text || !this._data[language].text[file] || !this._data[language].text[file][name])
               return {
                    faceset: "",
                    faceindex: 0,
                    background: 0,
                    position: 2,
                    text: "This message doesn't exist " + file + ' ' +  name + ' ' + language
                };

            // Return Text Data
            return Alias_getTextData.call(this, file,name, language);
        };
})(LanguageManager);


