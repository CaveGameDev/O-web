//=============================================================================
// TDS Language Processor
// Version: 1.5
//=============================================================================
// Add to Imported List
var Imported = Imported || {} ; Imported.TDS_TextLanguageProcessor = true;
// Initialize Alias Object
var _TDS_ = _TDS_ || {} ; _TDS_.TextLanguageProcessor = _TDS_.TextLanguageProcessor || {};
//=============================================================================
 /*:
 * @plugindesc
 * This plugin allows you to use YAML files for multiple language purposes.
 *
 * @author TDS
 *
 *
 * @param Default Language
 * @desc Default language of the game.
 * @default en
 *
 * @help
 * ============================================================================
 * * Script calls
 * ============================================================================
 *
 *    To manually set the current language use the following in a
 *    script call:
 * 
 *    LanguageManager.setLanguage(LANGUAGE, SAVE);
 *
 *    LANGUAGE
 *    ^ Language name string.
 *
 *    SAVE
 *    ^ true/false. If true it will save the language in the config
 *      file so it remembers it when the game is closed and reopened.
 *      (Optional. Defaults to True)
 *
 *    Examples:
 *
 *    LanguageManager.setLanguage('jp', false);
 *
 *    LanguageManager.setLanguage('en'); 
 *
 */
//=============================================================================
// Node.js path
var path = require('path');
// Get Parameters
var parameters = PluginManager.parameters("Text_Language_Processor");
// Initialize Parameters
_TDS_.TextLanguageProcessor.params = {};
_TDS_.TextLanguageProcessor.params.defaultLanguage = String(parameters['Default Language'] || 'en');

//=============================================================================
// ** LanguageManager
//-----------------------------------------------------------------------------
// Static class used for handling Language Text Processing.
//=============================================================================
function LanguageManager() { throw new Error('This is a static class'); };
//=============================================================================
// * Object Initialization
//=============================================================================
LanguageManager.initialize = function() {
  // Current Language
  this._language = this.defaultLanguage();
  // Language Data Object
  this._data = {};
  // Load All Language Files
  this.loadAllLanguageFiles();
};
//=============================================================================
// * Get Default Language
//=============================================================================
LanguageManager.defaultLanguage = function() {  return 'en'; };
//=============================================================================
// * Get System Text
//=============================================================================
LanguageManager.setLanguage = function(language, save) { 
  // Force English language - ignore any attempts to change
  LanguageManager._language = 'en';
};
//=============================================================================
// * Get Language Data
//=============================================================================
LanguageManager.languageData = function(language) {
  // Set Default Language
  if (language === undefined) { language = this._language; }  
  // Return Language Data
  return this._data[language];
};
//=============================================================================
// * Get System Text 
//=============================================================================
LanguageManager.getSystemText = function(type, name, language) { 
  // Set Default Language
  if (language === undefined) { language = this._language; }
  // Get Data
  var data = this._data[language].text.System;
  // If Data Exists
  if (data) { return data.terms[type][name]; };
  // Return Error
  return "- ERROR -";
};
//=============================================================================
// * Get Plugin Text
//=============================================================================
LanguageManager.getPluginText = function(type, name, language = this._language) { 
  // Get Data
  var data = this._data[language].text.System
  // If Data Exists
  if (data) { return data.plugins[type][name]; };
  // Return Error
  return " - ERROR -";
};
//=============================================================================
// * Get Input Keys Table
//=============================================================================
LanguageManager.getInputKeysTable = function() { 
  // Get Data
  var data = this.languageData().text.System;
  // Return Input Keys Table
  return data.inputKeysTable ? data.inputKeysTable : []; 
};
//=============================================================================
// * Get Input Keys Table
//=============================================================================
LanguageManager.getInputName = function(type, input, language = this._language) { 
  // Get Data
  var data = this.languageData().text.System;
  // If Data Exists
  if (data) { return data.InputNames[type][input]; };
  // Return Error
  return " - ERROR -";
};
//=============================================================================
// * Get Text Data
//=============================================================================
LanguageManager.getTextData = function(file, name, language) { 
  // Set Default Language
  if (language === undefined) { language = this._language; }
  // Return undefined for incomplete or missing language data instead of
  // throwing while a plugin is resolving an optional message.
  var languageData = this._data[language];
  var textData = languageData && languageData.text;
  var fileData = textData && textData[file];
  return fileData ? fileData[name] : undefined;
};
//=============================================================================
// * Get Message Data
//=============================================================================
LanguageManager.getMessageData = function(code, language) { 
  // Set Default Language
  if (language === undefined) { language = this._language; }
  // Message codes come from event/plugin data and may be missing in older
  // saves. Resolve the separator without calling split so malformed values
  // can never produce the legacy "reading 'split'" crash.
  if (code instanceof String) { code = String(code); }
  if (typeof code !== 'string' || code.length === 0) { return undefined; }
  var separator = code.indexOf('.');
  if (separator <= 0 || separator >= code.length - 1) { return undefined; }
  // Get Data. Keep dots in the message key (some YAML files use them).
  return this.getTextData(code.slice(0, separator), code.slice(separator + 1), language);
};
LanguageManager.getDatabaseText = function(code, language) { 
  // Set Default Language
  if (language === undefined) { language = this._language; }
  // Get Data
  var data = this._data[language].text.Database;
  // If Data Exists
  if (data) { return data[code]; };
  // Return Error
  return "- ERROR -";
};
//=============================================================================
// * Load Language Files
//=============================================================================
LanguageManager.loadLanguageFiles = function(language) {
  this._data[language] = { text: {} };
  
  // Prefer ZipLoader VFS (browser mode)
  if (window.ZipLoader && window.ZipLoader.hasLanguagePack && window.ZipLoader.hasLanguagePack()) {
    var yaml;
    try { yaml = require('./js/libs/js-yaml-master'); } catch(e) {
      console.warn('LanguageManager: require(js-yaml) failed, language data unavailable');
      return;
    }
    // Use the polyfill's readdirSync to get the expected (capitalized)
    // filenames that the game code expects as lookup keys.
    var _fs = require('fs');
    var _folder = 'languages/' + language + '/';
    var _dirList = [];
    try {
      _dirList = _fs.readdirSync(_folder) || [];
    } catch(e) {
      try { _dirList = _fs.readdirSync('Languages/' + language + '/') || []; } catch(e2) {}
    }
    var fileList = _dirList.filter(function(f) { return f.endsWith('.yaml'); });
    console.log('Loading ' + fileList.length + ' language files for ' + language + ' from ZipLoader VFS');
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      // The web archive stores language files lowercased, but the game keys
      // them by their original desktop casing (XX_BLUE, System, Bestiary, …).
      // Canonicalize so getMessageData("XX_BLUE.…") lookups resolve.
      if (window.OVFS && typeof window.OVFS.canonicalLanguageFile === 'function') {
        file = window.OVFS.canonicalLanguageFile(file);
      }
      var filename = file.replace('.yaml', '');
      var filePath = 'languages/' + language + '/' + file;
      try {
        var data = window.ZipLoader.getText(filePath);
        if (data) {
          this._data[language].text[filename] = yaml.load(data);
        }
      } catch(e) {
        console.warn('Failed to load language file from VFS:', filePath, e.message);
      }
    }
    return;
  }
  
  // Fallback: Node.js / NW.js filesystem
  var path = require('path');
  var fs = require('fs');
  var yaml = require('./js/libs/js-yaml-master')
  var base = path.dirname(process.mainModule.filename);
  var folder = '/Languages/' + language + '/';
  var filePath = base + folder;
  var dirList = fs.readdirSync(filePath);
  for (var i = 0; i < dirList.length; i++) {
    var directory = dirList[i];
    var format = path.extname(dirList[i]);    
    var filename = path.basename(directory, format);
    if (format === '.yaml') {
      var data = yaml.safeLoad(fs.readFileSync(filePath + '/' + filename + format, 'utf8'));
      this._data[language].text[filename] = data;
    }
  }
};
//=============================================================================
// * Load All Language Files
//=============================================================================
LanguageManager.loadAllLanguageFiles = function() {
  // For browser, just load English by default
  // In production you might want to detect browser language
  var languages = ['en'];
  for (var i = 0; i < languages.length; i++) {
    this.loadLanguageFiles(languages[i]);
  };
};
// Initialize Language Manager
//LanguageManager.initialize();



//=============================================================================
// ** ConfigManager
//-----------------------------------------------------------------------------
// The static class that manages the configuration data.
//=============================================================================
// Alias Listing
//=============================================================================
//_TDS_.TextLanguageProcessor.ConfigManager_makeData  = ConfigManager.makeData;
//_TDS_.TextLanguageProcessor.ConfigManager_applyData = ConfigManager.applyData;
//=============================================================================
// * Make Data
//=============================================================================
/*ConfigManager.makeData = function() {
  // Get Original Config Object
  var config = _TDS_.TextLanguageProcessor.ConfigManager_makeData.call(this);
  // Set Language
  config.language = LanguageManager._language;
  // Return config object
  return config;
};
//=============================================================================
// * Apply Data
//=============================================================================
ConfigManager.applyData = function(config) {
  // Run Original Function
  _TDS_.TextLanguageProcessor.ConfigManager_applyData.call(this, config);
  // Set Language
  this.language = LanguageManager._language = config.language || LanguageManager.defaultLanguage();
};*/

//=============================================================================
// ** TextManager
//-----------------------------------------------------------------------------
// The static class that handles terms and messages.
//=============================================================================
// * Get System Text 
//=============================================================================
TextManager.basic   = function(basicId)   { return LanguageManager.getSystemText('basic', basicId); };
TextManager.param   = function(paramId)   { return LanguageManager.getSystemText('param', paramId); };
TextManager.command = function(commandId) { return LanguageManager.getSystemText('command', commandId); };
TextManager.message = function(messageId) { return LanguageManager.getSystemText('message', messageId); };
TextManager.database = function(databaseId) { return LanguageManager.getDatabaseText(databaseId); };

//=============================================================================
// * Get Scene Text
//=============================================================================
TextManager.basic   = function(basicId)   { return LanguageManager.getSystemText('basic', basicId); };

//=============================================================================
// ** Game_Message
//-----------------------------------------------------------------------------
// The game object class for the state of the message window that displays text
// or selections, etc.
//=============================================================================
// * Show Language Message
//=============================================================================
Game_Message.prototype.showLanguageMessage = function(code) {
  // Invalid or removed localized messages should be harmless no-ops. This is
  // especially important for quest entries saved by older game versions.
  var data = LanguageManager.getMessageData(code);
  if (!data || typeof data !== 'object') { return false; }
  var faceset = data.faceset || "";
  var faceindex = data.faceindex || 0;
  var background = data.background || 0;
  var positionType = data.position === undefined ? 2 : data.position;
  // Get Extra Faces
  var extraFaces = data.extraFaces;
  // If Data has Extra Faces
  if (extraFaces) {
    // Go Through Extra Fraces
    for (var i = 0; i < extraFaces.length; i++) {
      // Get Face Data
      var face = extraFaces[i];
      // Set Extra Face
      this.setExtraFace(i, face.faceset, face.faceindex, this.makeFaceBackgroundColor(face.faceBackgroundColor,face.faceset, face.faceindex));
    };
  };
  // Set Message Properties
  this.setFaceImage(faceset, faceindex);
  this.setBackground(background);
  this.setPositionType(positionType);
  this._faceBackgroundColor = this.makeFaceBackgroundColor(data.faceBackgroundColor, faceset, faceindex);
  if (typeof data.text !== 'string') { return false; }
  if (Imported && Imported.YEP_MessageCore) {
    this.addText(data.text);
  } else {
    this.add(data.text);
  };
  return true;
};
//=============================================================================
// * Make Face Background Color
//=============================================================================
Game_Message.prototype.makeFaceBackgroundColor = function(color, name, index) {
  // If Color Exists
  if (color) {
    if (color.match(/^rgba/)) { return color; }
    if (color.match(/^#/)) { return color; }
  };
  // If Color Is for FaceName or Color is undefined
  if (name && color === 'FaceName' || color === undefined) {
    // Switch Case Name
    switch (name) {
      case '04_HERO_OW':
        return '#52b9fc';
        break;
    };
  };
  // Return null (Clear Background)
  return null;
};


Game_Message.prototype.setLanguageLabels = function(labels) {
  if (!this._choiceLabels) this._choiceLabels = [];
  this._choiceLabels = labels;
};

//=============================================================================
// ** Game_Interpreter
//-----------------------------------------------------------------------------
// The interpreter for running event commands.
//=============================================================================
// Alias Listing
//=============================================================================
_TDS_.TextLanguageProcessor.Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
//=============================================================================
// * Plugin Command
//=============================================================================
Game_Interpreter.prototype.pluginCommand = function(command, args) {
  // Command Switch Case
  switch (command) {
  case 'ShowMessage':
    // Show Language Message
    this.commandShowLanguageMessage(args[0]);
    break;
  case 'ChangeLanguage':
    // Force English language - ignore ChangeLanguage commands
    LanguageManager._language = 'en';
    break;
  case 'AddChoice':
    this.addLanguageChoice(args[0],args[1]);
    break;
  case 'ShowChoices':
    this.commandShowLanguageChoices(args[0]);
    break;
  };
  // Return Original Function
  return _TDS_.TextLanguageProcessor.Game_Interpreter_pluginCommand.call(this, command, args);
};
//=============================================================================
// * Show Language Message
//=============================================================================
Game_Interpreter.prototype.commandShowLanguageMessage = function (code) {
  if (!$gameMessage.isBusy()) {
    // Show Language Message. If an old event references a missing code,
    // leave the event list untouched instead of waiting on a message that
    // was never queued.
    if (!$gameMessage.showLanguageMessage(code)) { return false; }
    // Next Event Code Switch Case
    switch (this.nextEventCode()) {
      case 102:
        // Show Choices
        this._index++;
        this.setupChoices(this.currentCommand().parameters);
        break;
      case 103:
        // Input Number
        this._index++;
        this.setupNumInput(this.currentCommand().parameters);
        break;
      case 104:
        // Select Item
        this._index++;
        this.setupItemChoice(this.currentCommand().parameters);
        break;
      case 356:
        var nextCommand = this._list[this._index + 1];
        var commandText = nextCommand && nextCommand.parameters && nextCommand.parameters[0];
        var commandParts = typeof commandText === 'string' ? commandText.split(' ') : [];
        var pluginCommand = commandParts[0];
        var cancelType = commandParts[1];
        if (pluginCommand === "ShowChoices") {
          this._index++;
          this.setupLanguageChoices(cancelType);
        }
        break;
    };
    // this._index++;
    this.setWaitMode('message');
  }
  return false;
};
//=============================================================================
// * Show Choice
//=============================================================================
Game_Interpreter.prototype.addLanguageChoice = function(code,label) {
  if (!this._choices) this._choices = [];
  if (!this._choiceLabels) this._choiceLabels = [];
  var data = LanguageManager.getMessageData(code);
  if (!data || typeof data.text !== 'string') { return; }
  this._choices.push(data.text);
  this._choiceLabels.push(label);
};

Game_Interpreter.prototype.commandShowLanguageChoices = function(cancelType) {
  if (!$gameMessage.isBusy()) {
      this.setupLanguageChoices(parseInt(cancelType));
      this._index++;
      this.setWaitMode('message');
  }
  return false;
};

Game_Interpreter.prototype.commandLanguageJumpTo = function(label) {
  for (var i = 0; i < this._list.length; i++) {
      var command = this._list[i];
      if (command.code === 118 && command.parameters[0] === label) {
          this.jumpTo(i);
          return;
      }
  }
  return true;
};

Game_Interpreter.prototype.setupLanguageChoices = function(cancel) {
  var choices = this._choices.clone();
  var cancelType = cancel;
  var defaultType = 0;
  var positionType = 2;
  var background = 0;
  if (cancelType >= choices.length) {
      cancelType = -2;
  }
  $gameMessage.setChoices(choices, defaultType, cancelType);
  $gameMessage.setChoiceBackground(background);
  $gameMessage.setChoicePositionType(positionType);
  $gameMessage.setLanguageLabels(this._choiceLabels.clone());
  $gameMessage.setChoiceCallback(function(n) {
    if (n >= 0) {
      this.commandLanguageJumpTo($gameMessage._choiceLabels[n]);
    } else {
    this._branch[this._indent] = n;
    }
  }.bind(this));
  this._choices = [];
  this._choiceLabels = [];
};

_TDS_.TextLanguageProcessor.Window_Base_drawTextEx = Window_Base.prototype.drawTextEx;
Window_Base.prototype.drawTextEx = function(text, x, y) {
  if (!text) _TDS_.TextLanguageProcessor.Window_Base_drawTextEx.call(this, text, x, y);
  var regex = /\{(.*?)\}/;
  var result;
  while ((result = regex.exec(text)) !== null) {
    var dbString = TextManager.database(result[1]);
    text = text.replace(result[0], dbString);
  }
  return _TDS_.TextLanguageProcessor.Window_Base_drawTextEx.call(this, text, x, y);
};

_TDS_.TextLanguageProcessor.Window_Base_drawActorName = Window_Base.prototype.drawActorName;
Window_Base.prototype.drawActorName = function(actor, x, y, width) {
  if (!actor || !actor.name()) return _TDS_.TextLanguageProcessor.Window_Base_drawActorName.call(this, actor, x, y, width);
  width = width || 168;
  this.changeTextColor(this.hpColor(actor));

  var regex = /\{(.*?)\}/;
  var result;
  var text = actor.name();
  while ((result = regex.exec(text)) !== null) {
    var dbString = TextManager.database(result[1]);
    text = text.replace(result[0], dbString);
  }

  this.drawText(text, x, y, width);
};

_TDS_.TextLanguageProcessor.Window_Base_drawActorClass = Window_Base.prototype.drawActorClass;
Window_Base.prototype.drawActorClass = function(actor, x, y, width) {
  if (!actor || !actor.currentClass().name) return _TDS_.TextLanguageProcessor.Window_Base_drawActorClass.call(this, actor,x, y, width);
  width = width || 168;
  this.resetTextColor();

  var regex = /\{(.*?)\}/;
  var result;
  var text = actor.currentClass().name;
  while ((result = regex.exec(text)) !== null) {
    var dbString = TextManager.database(result[1]);
    text = text.replace(result[0], dbString);
  }

  this.drawText(text, x, y, width);
};

_TDS_.TextLanguageProcessor.Window_Base_drawActorNickname = Window_Base.prototype.drawActorNickname;
Window_Base.prototype.drawActorNickname = function(actor, x, y, width) {
  if (!actor || !actor.nickname()) return _TDS_.Window_Base_drawActorNickname.call(this, actor, x, y, width);
  width = width || 270;
  this.resetTextColor();

  var regex = /\{(.*?)\}/;
  var result;
  var text = actor.nickname();
  while ((result = regex.exec(text)) !== null) {
    var dbString = TextManager.database(result[1]);
    text = text.replace(result[0], dbString);
  }

  this.drawText(text, x, y, width);
};

_TDS_.TextLanguageProcessor.Window_Base_drawItemName = Window_Base.prototype.drawItemName;
Window_Base.prototype.drawItemName = function(item, x, y, width) {
  if (!item || !item.name) return _TDS_.TextLanguageProcessor.Window_Base_drawItemName.call(this, item, x, y, width);
  width = width || 312;
  if (item) {
      var iconBoxWidth = Window_Base._iconWidth + 4;
      this.resetTextColor();
      this.drawIcon(item.iconIndex, x + 2, y + 2);

      var regex = /\{(.*?)\}/;
      var result;
      var text = item.name;
      while ((result = regex.exec(text)) !== null) {
        var dbString = TextManager.database(result[1]);
        text = text.replace(result[0], dbString);
      }
      this.drawText(text, x + iconBoxWidth, y, width - iconBoxWidth);
  }
};

_TDS_.TextLanguageProcessor.Game_Interpreter_requestImages = Game_Interpreter.prototype.requestImages;
Game_Interpreter.prototype.requestImages = function(list, commonList) {
  if(!list) return;

  list.forEach(function(command){
      var params = command.parameters;
      switch(command.code){
        case 231:
        var image = params[1].replace("_" + LanguageManager.defaultLanguage(), "_"  + LanguageManager._language);
        ImageManager.requestPicture(image);
        break;
      }
    });
    _TDS_.TextLanguageProcessor.Game_Interpreter_requestImages.call(this, list, commonList);
};

_TDS_.TextLanguageProcessor.Game_Interpreter_command231 = Game_Interpreter.prototype.command231;
Game_Interpreter.prototype.command231 = function() {
  var x, y;
  if (this._params[3] === 0) {  // Direct designation
      x = this._params[4];
      y = this._params[5];
  } else {  // Designation with variables
      x = $gameVariables.value(this._params[4]);
      y = $gameVariables.value(this._params[5]);
  }
  var image = this._params[1].replace("_" + LanguageManager.defaultLanguage(), "_"  + LanguageManager._language);
  $gameScreen.showPicture(this._params[0], image, this._params[2],
      x, y, this._params[6], this._params[7], this._params[8], this._params[9]);
  return true;
};
