'use strict';
const fs = require('node:fs');
const path = require('node:path');

function isInstalled({packaged, platform = process.platform, resourcesPath, executablePath = process.execPath}) {
  if (!packaged || platform !== 'win32') return false;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'install-mode.json'), 'utf8'));
    const executableName = path.basename(executablePath, path.extname(executablePath));
    return marker.kind === 'nsis' && fs.statSync(path.join(path.dirname(executablePath), `Uninstall ${executableName}.exe`)).isFile();
  } catch {return false;}
}

module.exports = {isInstalled};
