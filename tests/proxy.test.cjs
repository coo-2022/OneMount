'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {normalizeProxy, proxyEnv} = require('../src/proxy.cjs');
const P = require('../src/processes.cjs');
const {Manager} = require('../src/manager.cjs');

test('proxy validation rejects credentials and URL payloads without echoing them', () => {
  for (const url of ['localhost:7892', 'ftp://localhost:21', 'http://user:PRIVATE@localhost:1', 'http://localhost/path', 'http://localhost/?key=PRIVATE', 'http://localhost/#PRIVATE', 'http://localhost:99999', 'http://local host:80']) {
    assert.throws(() => normalizeProxy({mode:'manual', url}), e => !e.message.includes('PRIVATE'));
  }
  assert.throws(() => normalizeProxy({mode:'unknown'}));
  for (const url of ['http://127.0.0.1:7892', 'https://proxy.example:8443', 'socks5://[::1]:1080']) assert.equal(normalizeProxy({mode:'manual', url:' '+url+'/ '}).url, url);
});

test('manual and direct modes override inherited bypasses and proxy aliases', async t => {
  const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
  const saved = {...process.env};
  t.after(() => {for (const key of keys) delete process.env[key]; for (const key of keys) if (saved[key] !== undefined) process.env[key] = saved[key];});
  process.env.http_proxy = 'http://wrong.invalid:1'; process.env.HTTPS_PROXY = 'http://wrong.invalid:2';
  process.env.ALL_PROXY = 'socks5://wrong.invalid:3'; process.env.NO_PROXY = '*';
  const manual = proxyEnv({mode:'manual',url:'http://127.0.0.1:7892'});
  const actual = JSON.parse(await P.run(process.execPath, ['-e', 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)))))'], {env:manual}));
  assert.equal(actual.HTTP_PROXY, manual.HTTP_PROXY); assert.equal(actual.HTTPS_PROXY, manual.HTTPS_PROXY);
  assert.equal(actual.NO_PROXY, 'localhost,127.0.0.1,::1'); assert.ok(!actual.ALL_PROXY);
  assert.equal(Object.keys(actual).filter(k => k.toLowerCase() === 'http_proxy').length, 1);
  const direct = P.cleanEnv(proxyEnv({mode:'direct'}));
  assert.equal(direct.HTTP_PROXY, ''); assert.equal(direct.HTTPS_PROXY, ''); assert.equal(direct.ALL_PROXY, '');
  assert.equal(direct.http_proxy, undefined);
  assert.equal(process.env.NO_PROXY, '*', 'must not alter the UI process environment');
});

test('new and legacy default settings explicitly use direct access', () => {
  const direct = {HTTP_PROXY:'', HTTPS_PROXY:'', ALL_PROXY:'', NO_PROXY:'localhost,127.0.0.1,::1'};
  assert.deepEqual(normalizeProxy(), {mode:'direct',url:''});
  assert.deepEqual(normalizeProxy({mode:'inherit'}), {mode:'direct',url:''});
  assert.deepEqual(proxyEnv(), direct);
  assert.deepEqual(proxyEnv({mode:'inherit'}), direct);
});

test('settings persist across restart, preserve login setting and never change running engines', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-proxy-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const options = {root, engines:root, providerConfig: {enabledProviders: []}, protect:s=>s, unprotect:s=>s};
  const m = new Manager(options);
  assert.equal(m.snapshot().settings.proxy.mode, 'direct');
  m.updateSettings({loginStart:true});
  const before = m.env();
  m.updateSettings({proxy:{mode:'manual',url:'http://127.0.0.1:7892'}});
  assert.equal(m.snapshot().proxyRestartRequired, true);
  assert.equal(m.state.settings.loginStart, true);
  assert.deepEqual(m.env(), before);
  const disk = fs.readFileSync(m.file, 'utf8');
  assert.throws(() => m.updateSettings({loginStart:false,proxy:{mode:'manual',url:'bad'}}));
  assert.equal(fs.readFileSync(m.file, 'utf8'), disk); assert.equal(m.state.settings.loginStart, true);
  const restarted = new Manager(options);
  assert.equal(restarted.snapshot().proxyRestartRequired, false);
  assert.equal(restarted.env().HTTPS_PROXY, 'http://127.0.0.1:7892');
  restarted.updateSettings({loginStart:false});
  assert.equal(restarted.state.settings.proxy.mode, 'manual');
  restarted.updateSettings({proxy:{mode:'direct'}});
  assert.equal(restarted.snapshot().proxyRestartRequired, true);
  const direct = new Manager(options);
  assert.equal(direct.env().HTTPS_PROXY, '');
  assert.ok(direct.env({RCLONE_RC_PASS:'test'}).RCLONE_CONFIG_PASS);
  assert.equal(direct.env({RCLONE_RC_PASS:'test'}).RCLONE_RC_PASS, 'test');
  const legacy = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  legacy.settings.proxy = {mode:'inherit',url:''};
  fs.writeFileSync(m.file, JSON.stringify(legacy));
  const migrated = new Manager(options);
  assert.equal(migrated.snapshot().settings.proxy.mode, 'direct');
  assert.equal(migrated.env().HTTPS_PROXY, '');
  assert.equal(migrated.snapshot().proxyRestartRequired, false);
});
