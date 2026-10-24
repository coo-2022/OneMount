'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {isInstalled} = require('../src/install-state.cjs');

test('only a packaged Windows install with marker and matching uninstaller allows in-place updates', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onemount-install-state-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const resourcesPath = path.join(temp, 'resources'); fs.mkdirSync(resourcesPath);
  const input = {packaged: true, platform: 'win32', resourcesPath, executablePath: path.join(temp, 'OneMount.exe')};
  assert.equal(isInstalled(input), false);
  const marker = path.join(resourcesPath, 'install-mode.json');
  fs.writeFileSync(marker, '{"kind":"nsis"}');
  assert.equal(isInstalled(input), false);
  fs.writeFileSync(path.join(temp, 'Uninstall OneMount.exe'), 'fixture');
  assert.equal(isInstalled(input), true);
  assert.equal(isInstalled({...input, packaged: false}), false);
  assert.equal(isInstalled({...input, platform: 'linux'}), false);
  assert.equal(isInstalled({...input, executablePath: path.join(temp, 'OneMountTest.exe')}), false);
  for (const content of ['invalid', '{"kind":"portable"}', 'null']) {
    fs.writeFileSync(marker, content); assert.equal(isInstalled(input), false);
  }
});
