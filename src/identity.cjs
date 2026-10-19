'use strict';
const fs = require('node:fs');
const path = require('node:path');

function configureIdentity(app) {
  // Keep the existing profile and single-instance lock across the product rename.
  // Moving it would also move pending uploads, SQLite/WAL files and encrypted keys.
  const override = app.commandLine.getSwitchValue('user-data-dir');
  const profile = override ? path.resolve(override) : path.join(app.getPath('appData'), 'CloudIsland');
  fs.mkdirSync(profile, {recursive: true});
  app.setName('OneMount');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

module.exports = {configureIdentity};
