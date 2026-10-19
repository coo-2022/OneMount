'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {configureIdentity} = require('../src/identity.cjs');

test('OneMount retains the legacy profile and respects explicit isolated profiles', t => {
  const tempRoot = path.resolve(os.tmpdir()), base = fs.mkdtempSync(path.join(tempRoot, 'onemount-identity-'));
  t.after(() => {assert.equal(path.dirname(path.resolve(base)), tempRoot); assert.ok(path.basename(base).startsWith('onemount-identity-')); fs.rmSync(base, {recursive: true, force: true});});
  const legacy = path.join(base, 'CloudIsland'); fs.mkdirSync(legacy);
  const data = path.join(legacy, 'meta.db-wal'); fs.writeFileSync(data, 'existing pending state');
  let override = '', name;
  const paths = {appData: base};
  const app = {commandLine: {getSwitchValue: () => override}, getPath: key => paths[key], setPath: (key, value) => {assert.ok(fs.statSync(value).isDirectory()); paths[key] = value;}, setName: value => {name = value;}};
  configureIdentity(app);
  assert.equal(name, 'OneMount'); assert.equal(paths.userData, legacy); assert.equal(paths.sessionData, legacy);
  assert.equal(fs.readFileSync(data, 'utf8'), 'existing pending state');
  override = path.join(base, 'isolated'); configureIdentity(app);
  assert.equal(paths.userData, override); assert.equal(paths.sessionData, override);
  assert.equal(fs.readFileSync(data, 'utf8'), 'existing pending state');
});
