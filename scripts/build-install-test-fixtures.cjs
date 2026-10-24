'use strict';
// Build two actual NSIS releases with an isolated identity for installation tests.
// This helper does not install anything and does not publish release artifacts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {build, Platform, Arch} = require('electron-builder');
const {installerConfig} = require('./build-installer.cjs');
const {assertManifest} = require('./windows-install-update-smoke.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixtures = path.join(root, 'test-results', 'install-test-fixtures');
  fs.mkdirSync(fixtures, {recursive: true});
  const suffix = crypto.randomUUID().slice(0, 8);
  const base = fs.mkdtempSync(path.join(fixtures, suffix + '-'));
  const previousFile = path.join(fixtures, 'manifest.json');
  const refreshV2 = process.env.ONEMOUNT_INSTALL_TEST_REFRESH_V2 === '1';
  const manifest = refreshV2 ? assertManifest(JSON.parse(fs.readFileSync(previousFile, 'utf8')), previousFile) :
    {schemaVersion: 1, purpose: 'onemount-installer-smoke', appId: 'com.onemount.install-test.' + suffix,
      nsisGuid: crypto.randomUUID(), productName: 'OneMount Install-Test ' + suffix, executableName: 'OneMount-install-test-' + suffix};
  const versions = refreshV2 ? [['installerV2', manifest.installerV2.version]] : [['installerV1', '0.0.1'], ['installerV2', '0.0.2']];
  for (const [label, version] of versions) {
    const output = path.join(base, version);
    const config = installerConfig({...process.env, ONEMOUNT_INSTALLER_APP_ID: manifest.appId,
      ONEMOUNT_INSTALLER_GUID: manifest.nsisGuid, ONEMOUNT_INSTALLER_PRODUCT_NAME: manifest.productName,
      ONEMOUNT_INSTALLER_EXECUTABLE_NAME: manifest.executableName, ONEMOUNT_INSTALLER_OUT: output,
      ONEMOUNT_INSTALLER_VERSION: version});
    // Distinct embedded versions exercise NSIS's actual upgrade path. Refreshing
    // only V2 lets a final fix be tested against the previous V1 without rebuilding it.
    const built = await build({projectDir: root, config, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never'});
    const installers = built.filter(file => path.extname(file).toLowerCase() === '.exe' && path.basename(file).includes('-Setup-'));
    if (installers.length !== 1) throw new Error('Expected exactly one NSIS installer for ' + version);
    const file = path.resolve(installers[0]);
    manifest[label] = {path: file, version, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
  }
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const file = path.join(base, 'manifest.json');
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), text);
  console.log('Installer fixtures ready: ' + file);
}

if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {main};
