'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const baseConfig = require('../electron-builder.config.cjs');

function installerConfig(env = process.env) {
  const config = structuredClone(baseConfig);
  const fixture = env.ONEMOUNT_INSTALLER_APP_ID;
  if (fixture) {
    // Isolated installation tests need their own registry identity and shortcuts.
    for (const key of ['APP_ID', 'PRODUCT_NAME', 'EXECUTABLE_NAME']) {
      if (!/install-test/i.test(env[`ONEMOUNT_INSTALLER_${key}`] || '')) {
        throw new Error(`Installer test ${key} must contain install-test`);
      }
    }
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(env.ONEMOUNT_INSTALLER_GUID || '')) {
      throw new Error('Installer tests require a separate GUID');
    }
    if (env.ONEMOUNT_INSTALLER_GUID.toLowerCase() === baseConfig.nsis.guid.toLowerCase()) {
      throw new Error('Installer tests must not reuse the production GUID');
    }
    if (!/^[a-z0-9.-]+$/i.test(fixture) || !/^[a-z0-9_-]+$/i.test(env.ONEMOUNT_INSTALLER_EXECUTABLE_NAME)) {
      throw new Error('Installer test identity and executable name must be simple identifiers');
    }
    config.appId = fixture;
    config.productName = env.ONEMOUNT_INSTALLER_PRODUCT_NAME;
    config.executableName = env.ONEMOUNT_INSTALLER_EXECUTABLE_NAME;
    config.nsis.guid = env.ONEMOUNT_INSTALLER_GUID;
    config.nsis.shortcutName = config.productName;
    config.nsis.artifactName = `${config.executableName}-Setup-\${version}-\${arch}.\${ext}`;
  }
  if (env.ONEMOUNT_INSTALLER_VERSION) {
    if (!fixture) throw new Error('Version overrides are only permitted for isolated installer tests');
    config.extraMetadata = { version: env.ONEMOUNT_INSTALLER_VERSION };
  }
  if (env.ONEMOUNT_INSTALLER_OUT) config.directories.output = path.resolve(env.ONEMOUNT_INSTALLER_OUT);
  if (env.ONEMOUNT_ENGINE_DIR) config.extraResources[0].from = path.resolve(env.ONEMOUNT_ENGINE_DIR);
  if (env.ONEMOUNT_ELECTRON_DIST) config.electronDist = path.resolve(env.ONEMOUNT_ELECTRON_DIST);
  return config;
}

async function main() {
  const config = installerConfig();
  const root = path.resolve(__dirname, '..');
  for (const name of ['rclone.exe', 'juicefs.exe']) {
    if (!fs.existsSync(path.resolve(root, config.extraResources[0].from, name))) throw new Error(`Missing engine ${name}; run npm run engines:win`);
  }
  await build({ projectDir: root, config, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { installerConfig };
