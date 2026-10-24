'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {Manager} = require('../src/manager.cjs');
require('../src/accounts.cjs').installAccounts(Manager);
const {normalizeProviderConfig, loadProviderConfig, loadOAuthClients} = require('../src/providers.cjs');

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const base = fs.mkdtempSync(path.join(tempRoot, 'onemount-providers-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), tempRoot);
    assert.ok(path.basename(base).startsWith('onemount-providers-'));
    fs.rmSync(base, {recursive: true, force: true});
  });
  const make = (enabledProviders, oauthClients = {}) => new Manager({
    root: path.join(base, 'profile'), engines: base, providerConfig: {enabledProviders}, oauthClients,
    protect: s => Buffer.from(s).toString('base64'), unprotect: s => Buffer.from(s, 'base64').toString(),
  });
  return {base, make};
}

test('single-provider edition exposes only that provider and still requires OAuth credentials', t => {
  const {make} = fixture(t), m = make(['baidu']);
  assert.deepEqual(m.snapshot().services, [{id: 'baidu', name: '百度网盘', available: false}]);
  m.oauthClients.baidu = {clientId: 'PRIVATE_APP', clientSecret: 'PRIVATE_SECRET'};
  assert.equal(m.snapshot().services[0].available, true);
  assert.doesNotMatch(JSON.stringify(m.snapshot()), /PRIVATE_/);
});

test('disabled providers reject direct API calls before auth or filesystem work', async t => {
  const {base, make} = fixture(t), m = make(['baidu'], {onedrive: {clientId: 'configured'}});
  m.accounts = async () => assert.fail('Disabled providers must not start an account service');
  await assert.rejects(m.connect({type: 'onedrive', name: 'hidden'}), /未开放/);
  await assert.rejects(m.connect({type: 'webdav', name: 'hidden', url: 'https://example.com'}), /未开放/);
  await assert.rejects(m.addLocal({name: 'hidden', path: base}), /未开放/);
  assert.equal(m.auth, null);
  assert.equal(m.state.connections.length, 0);
  assert.equal(fs.existsSync(path.join(m.root, 'auth.log')), false);
});

test('enabled local storage can create a disk, closing its entry retains existing data and management', async t => {
  const {base, make} = fixture(t);
  const backend = path.join(base, 'backend'); fs.mkdirSync(backend);
  const original = make(['local']);
  const cid = await original.addLocal({name: 'existing', path: backend});
  const did = await original.addDisk({connectionId: cid, name: 'data', mode: 'direct', letter: 'Z:', cacheGiB: 10});
  const cache = path.join(original.paths(original.disk(did)).cache, 'pending'); fs.writeFileSync(cache, 'keep');
  const reopened = make([]);
  assert.deepEqual(reopened.snapshot().services, []);
  assert.equal(reopened.snapshot().connections[0].id, cid);
  assert.equal(reopened.snapshot().disks[0].id, did);
  await assert.rejects(reopened.addDisk({connectionId: cid, name: 'new', mode: 'direct', letter: 'Y:', cacheGiB: 10}), /未开放/);
  reopened.renameConnection(cid, 'retained');
  await reopened.updateDisk(did, {name: 'retained disk'});
  assert.equal(fs.readFileSync(cache, 'utf8'), 'keep');
  await reopened.removeDisk(did);
  await reopened.deleteConnection(cid);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'keep');
});

test('malformed provider config never silently opens additional providers', () => {
  for (const value of [undefined, null, [], {}, {enabledProviders: 'baidu'}, {enabledProviders: ['typo']},
    {enabledProviders: ['baidu', 'baidu']}, {enabledProviders: [null]}, {enabledProviders: [], extra: true}]) {
    assert.throws(() => normalizeProviderConfig(value), /provider-config/);
  }
  assert.deepEqual(normalizeProviderConfig({enabledProviders: []}), {enabledProviders: []});
});

test('external config replaces the bundled list; malformed override fails closed; missing override falls back', t => {
  const {base} = fixture(t), root = path.join(base, 'bundle'), executableDir = path.join(base, 'portable');
  fs.mkdirSync(root); fs.mkdirSync(executableDir);
  fs.writeFileSync(path.join(root, 'provider-config.json'), JSON.stringify({enabledProviders: ['local', 'baidu']}));
  assert.deepEqual(loadProviderConfig({root, executableDir}).enabledProviders, ['local', 'baidu']);
  const file = path.join(executableDir, 'provider-config.json');
  fs.writeFileSync(file, JSON.stringify({enabledProviders: ['baidu']}));
  assert.deepEqual(loadProviderConfig({root, executableDir}).enabledProviders, ['baidu']);
  fs.writeFileSync(file, '{bad');
  assert.throws(() => loadProviderConfig({root, executableDir}), /无法读取/);
  fs.writeFileSync(file, JSON.stringify({enabledProviders: ['typo']}));
  assert.throws(() => loadProviderConfig({root, executableDir}), /未知/);
});

test('release config writes the selected edition and rejects invalid selection before touching credentials', t => {
  const {base} = fixture(t), root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(base, 'scripts')); fs.mkdirSync(path.join(base, 'src'));
  for (const file of ['scripts/release-config.cjs', 'src/providers.cjs', 'provider-config.json']) fs.copyFileSync(path.join(root, file), path.join(base, file));
  const oauth = path.join(base, 'oauth-clients.json');
  fs.writeFileSync(oauth, JSON.stringify({baidu: {clientId: 'fixture', clientSecret: 'fixture'}}));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ONEMOUNT_OAUTH_')));
  const run = value => execFileSync(process.execPath, [path.join(base, 'scripts/release-config.cjs')], {env: {...env, ONEMOUNT_ENABLED_PROVIDERS: value}, windowsHide: true, stdio: 'pipe'});
  run('baidu,onedrive');
  assert.deepEqual(loadProviderConfig({root: base}).enabledProviders, ['baidu', 'onedrive']);
  const before = fs.readFileSync(oauth, 'utf8');
  assert.throws(() => run('baiduu'));
  assert.equal(fs.readFileSync(oauth, 'utf8'), before);
  run('');
  assert.deepEqual(loadProviderConfig({root: base}).enabledProviders, []);
});

test('external OAuth config survives bundle changes and invalid overrides fail without disclosing secrets', t => {
  const {base} = fixture(t), root = path.join(base, 'bundle'), executableDir = path.join(base, 'installed');
  fs.mkdirSync(root); fs.mkdirSync(executableDir);
  const defaults = {baidu: {clientId: '', clientSecret: ''}};
  const privateClients = {baidu: {clientId: 'PRIVATE_APP', clientSecret: 'PRIVATE_SECRET'}};
  fs.writeFileSync(path.join(root, 'oauth-clients.json'), JSON.stringify(defaults));
  assert.deepEqual(loadOAuthClients({root, executableDir}), defaults);
  const override = path.join(executableDir, 'oauth-clients.json');
  fs.writeFileSync(override, JSON.stringify(privateClients));
  assert.deepEqual(loadOAuthClients({root, executableDir}), privateClients);
  fs.writeFileSync(path.join(root, 'oauth-clients.json'), '{}');
  assert.deepEqual(loadOAuthClients({root, executableDir}), privateClients);
  for (const invalid of ['PRIVATE_SECRET invalid json', '[]', 'null', '{"baidu":{"clientId":123,"clientSecret":"PRIVATE_SECRET"}}']) {
    fs.writeFileSync(override, invalid);
    assert.throws(() => loadOAuthClients({root, executableDir}), error => {
      assert.match(error.message, /oauth-clients.json/);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    });
  }
});
