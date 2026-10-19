'use strict';
const {app} = require('electron');
require('./identity.cjs').configureIdentity(app);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const main = require('./main.cjs');
  app.on('second-instance', main.activate);
  app.whenReady().then(main.start).catch(main.failStartup);
}
