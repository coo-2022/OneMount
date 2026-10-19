'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Manager} = require('../src/manager.cjs');
const {loadProviderConfig} = require('../src/providers.cjs');
const {cloudVolumeProviders, juicefsUpstreamProviders} = require('../scripts/cloud-test-providers.cjs');

test('cloud test selections allow volume creation and reload even when the edition disables clouds', async t => {
  const tempRoot = path.resolve(os.tmpdir()), base = fs.mkdtempSync(path.join(tempRoot, 'onemount-cloud-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), tempRoot);
    assert.ok(path.basename(base).startsWith('onemount-cloud-test-'));
    fs.rmSync(base, {recursive: true, force: true});
  });
  const edition = path.join(base, 'provider-config.json');
  const original = JSON.stringify({enabledProviders: ['local', 'webdav', 's3']});
  fs.writeFileSync(edition, original);
  const make = (root, providerConfig) => new Manager({root, engines: base, providerConfig, protect: s => s, unprotect: s => s});
  const product = make(path.join(base, 'product'), loadProviderConfig({root: base}));
  for (const type of ['baidu', 'onedrive', 'drive']) {
    product.state.connections.push({id: type, type, name: type, source: 'fixture:'});
    await assert.rejects(product.addDisk({connectionId: type, name: 'blocked', mode: 'juicefs', letter: 'Q:', cacheGiB: 1}), /未开放/);
  }
  for (const select of [cloudVolumeProviders, juicefsUpstreamProviders]) {
    const config = select({});
    for (const type of config.enabledProviders) {
      const root = path.join(base, select.name, type), manager = make(root, config);
      manager.state.connections.push({id: type, type, name: type, source: 'fixture:'});
      const id = await manager.addDisk({connectionId: type, name: 'test volume', mode: 'juicefs', letter: 'Q:', cacheGiB: 1});
      const reopened = make(root, select({}));
      assert.equal(reopened.disk(id).id, id);
      await reopened.addDisk({connectionId: type, name: 'after reload', mode: 'juicefs', letter: 'R:', cacheGiB: 1});
    }
  }
  assert.equal(fs.readFileSync(edition, 'utf8'), original);
  assert.deepEqual(product.snapshot().services.map(s => s.id), ['local', 'webdav', 's3']);
});

test('each cloud test runner selects only its requested backends and preserves its defaults', () => {
  assert.deepEqual(cloudVolumeProviders({}).enabledProviders, ['baidu', 'onedrive', 'drive']);
  assert.deepEqual(juicefsUpstreamProviders({}).enabledProviders, ['local', 'baidu', 'onedrive', 'drive']);
  const env = {ONEMOUNT_LIVE_TYPES: ' baidu, drive ', ONEMOUNT_UPSTREAM_TYPES: 'local', ONEMOUNT_ENABLED_PROVIDERS: 's3'};
  assert.deepEqual(cloudVolumeProviders(env).enabledProviders, ['baidu', 'drive']);
  assert.deepEqual(juicefsUpstreamProviders(env).enabledProviders, ['local']);
});

test('invalid cloud test selections fail before creating profiles or starting engines', () => {
  for (const [select, key] of [[cloudVolumeProviders, 'ONEMOUNT_LIVE_TYPES'], [juicefsUpstreamProviders, 'ONEMOUNT_UPSTREAM_TYPES']]) {
    for (const value of ['unknown', 'baidu,baidu', 'baidu,', ' ']) {
      assert.throws(() => select({[key]: value}), /未知或重复/);
    }
  }
});
