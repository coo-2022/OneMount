'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {UpdateService, normalizeUpdatePreferences, RELEASE_URL} = require('../src/updates.cjs');

function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.calls = {check: 0, download: 0, install: [], proxy: []};
    this.netSession = {setProxy: async config => {this.calls.proxy.push(config);}};
  }
  async checkForUpdates() {this.calls.check++; this.emit('update-available', {version: '0.8.0', releaseNotes: 'PRIVATE'}); return {isUpdateAvailable: true};}
  async downloadUpdate() {this.calls.download++; this.emit('update-downloaded', {version: '0.8.0', downloadedFile: 'PRIVATE'}); return ['PRIVATE'];}
  quitAndInstall(...args) {this.calls.install.push(args);}
}
function fixture(t, options = {}) {
  const updater = new FakeUpdater();
  let shutdowns = 0, recoveries = 0;
  const service = new UpdateService({updater, currentVersion: '0.7.0', installed: true,
    prepareInstall: async () => {shutdowns++; return true;}, recoverInstall: async () => {recoveries++;}, ...options});
  t.after(() => service.dispose());
  return {updater, service, counts: () => ({shutdowns, recoveries})};
}
async function stage(service) {await service.check(); await service.download();}

test('updates never check, download, or install automatically; explicit lifecycle only', async t => {
  const {service, updater, counts} = fixture(t);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.logger, null);
  assert.deepEqual(updater.calls, {check: 0, download: 0, install: [], proxy: []});
  assert.equal(service.snapshot().status, 'idle');
  await service.check();
  assert.equal(service.snapshot().status, 'available');
  assert.equal(updater.calls.download, 0);
  await service.download();
  assert.equal(service.snapshot().status, 'downloaded');
  assert.deepEqual(updater.calls.install, []);
  await service.install();
  assert.equal(service.snapshot().status, 'installing');
  assert.deepEqual(updater.calls.install, [[false, true]]);
  assert.deepEqual(counts(), {shutdowns: 1, recoveries: 0});
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /PRIVATE/);
  assert.equal(service.snapshot().releaseUrl, RELEASE_URL);
});

test('portable and development builds cannot invoke the updater', async t => {
  const {service, updater} = fixture(t, {installed: false});
  assert.equal(service.snapshot().status, 'unsupported');
  await assert.rejects(service.check(), /安装版/);
  await assert.rejects(service.download(), /检查/);
  await assert.rejects(service.install(), /下载/);
  assert.equal(updater.calls.check, 0);
  assert.equal(service.snapshot().canCheck, false);
});

test('duplicate checks share a promise; conflicting work and preference changes are fenced', async t => {
  const {service, updater} = fixture(t), pending = deferred();
  updater.checkForUpdates = async () => {updater.calls.check++; await pending.promise; updater.emit('update-available', {version: '0.8.0'}); return {};};
  const first = service.check(), second = service.check();
  assert.equal(first, second);
  await tick();
  assert.equal(service.snapshot().status, 'checking');
  assert.equal(service.snapshot().canCheck, false);
  assert.throws(() => service.configure({allowPrerelease: true}), /正在进行/);
  pending.resolve(); await first;
  assert.equal(updater.calls.check, 1);
  const downloading = deferred();
  updater.downloadUpdate = async () => {updater.calls.download++; await downloading.promise; updater.emit('update-downloaded', {version: '0.8.0'});};
  const download = service.download();
  assert.equal(service.download(), download);
  await assert.rejects(service.check(), /正在进行/);
  downloading.resolve(); await download;
  assert.equal(updater.calls.download, 1);
});

test('unsafe shutdown never starts installer and downloaded update stays retryable', async t => {
  let allow = false, recovered = 0;
  const {service, updater} = fixture(t, {prepareInstall: async () => {if (!allow) throw new Error('PRIVATE-token pending write'); return true;}, recoverInstall: async () => {recovered++;}});
  await stage(service);
  await assert.rejects(service.install(), /暂时无法安全更新/);
  assert.equal(service.snapshot().status, 'downloaded');
  assert.equal(service.snapshot().errorCode, 'shutdown-blocked');
  assert.equal(service.snapshot().canInstall, true);
  assert.equal(updater.calls.install.length, 0);
  assert.equal(recovered, 1);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /PRIVATE/);
  allow = true; await service.install();
  assert.equal(updater.calls.install.length, 1);
  assert.equal(updater.calls.download, 1);
});

test('shutdown must explicitly confirm success; installer waits and double clicks cannot bypass it', async t => {
  const gate = deferred();
  const {service, updater} = fixture(t, {prepareInstall: () => gate.promise});
  await stage(service);
  const first = service.install();
  assert.equal(service.install(), first);
  await tick();
  assert.equal(service.snapshot().status, 'preparing');
  assert.equal(service.snapshot().canInstall, false);
  assert.equal(updater.calls.install.length, 0);
  gate.resolve(undefined);
  await assert.rejects(first, /暂时无法安全更新/);
  assert.equal(updater.calls.install.length, 0);
});

test('synchronous installer failure recovers once and retains the verified download', async t => {
  const {service, updater, counts} = fixture(t);
  await stage(service);
  updater.quitAndInstall = () => {updater.emit('error', new Error('PRIVATE https://example.com/?token=PRIVATE'));};
  await assert.rejects(service.install(), /未能启动/);
  assert.deepEqual(counts(), {shutdowns: 1, recoveries: 1});
  assert.equal(service.snapshot().canInstall, true);
  assert.equal(service.snapshot().errorCode, 'install-failed');
  updater.quitAndInstall = FakeUpdater.prototype.quitAndInstall;
  await service.install();
  assert.deepEqual(updater.calls.install, [[false, true]]);
});

test('updater errors during shutdown do not release the preparation lock before shutdown settles', async t => {
  const gate = deferred();
  let recoveries = 0;
  const {service, updater} = fixture(t, {prepareInstall: () => gate.promise, recoverInstall: async () => {recoveries++;}});
  await stage(service);
  const installing = service.install();
  await tick();
  updater.emit('error', new Error('PRIVATE error while shutdown is in progress'));
  await tick();
  assert.equal(recoveries, 0, 'main must retain its shutdown lock until pending preparation is settled');
  assert.equal(service.snapshot().status, 'preparing');
  assert.equal(service.snapshot().canInstall, false);
  gate.resolve(true);
  await assert.rejects(installing, /暂时无法安全更新/);
  assert.equal(recoveries, 1);
  assert.equal(updater.calls.install.length, 0);
  assert.equal(service.snapshot().canInstall, true);
});

test('asynchronous installer launch failure restores controls for a later retry', async t => {
  const {service, updater, counts} = fixture(t);
  await stage(service); await service.install();
  updater.emit('error', new Error('PRIVATE spawn failed'));
  await tick();
  assert.deepEqual(counts(), {shutdowns: 1, recoveries: 1});
  assert.equal(service.snapshot().status, 'downloaded');
  assert.equal(service.snapshot().canInstall, true);
  assert.doesNotMatch(service.snapshot().error, /PRIVATE/);
});

test('retry after asynchronous launch failure re-arms the real electron-updater 6.x installation guard', async t => {
  const fs = require('node:fs'), vm = require('node:vm'), {createRequire} = require('node:module');
  const source = require.resolve('electron-updater/out/BaseUpdater');
  const upstreamRequire = createRequire(source);
  const context = {exports: {}, setImmediate,
    require: name => name === 'electron' ? {autoUpdater: new EventEmitter()} : upstreamRequire(name)};
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context, {filename: source});
  const updater = new context.exports.BaseUpdater(undefined, {version: '0.7.0', name: 'isolated-test', isPackaged: true,
    whenReady: async () => {}, quit() {}, onQuit() {assert.fail('automatic install-on-quit must remain disabled');}});
  Object.defineProperty(updater, 'netSession', {value: {setProxy: async () => {}}});
  updater.checkForUpdates = async () => {updater.emit('update-available', {version: '0.8.0'}); return {};};
  updater.downloadUpdate = async () => {
    updater.downloadedUpdateHelper = {file: 'isolated-never-executed.exe', downloadedFileInfo: {isAdminRightsRequired: false}};
    updater.emit('update-downloaded', {version: '0.8.0'});
  };
  let launches = 0;
  updater.doInstall = () => {
    launches++;
    if (launches === 1) queueMicrotask(() => updater.dispatchError(new Error('PRIVATE simulated spawn error')));
    return true;
  };
  const service = new UpdateService({updater, installed: true, currentVersion: '0.7.0', prepareInstall: async () => true});
  t.after(() => service.dispose());
  await stage(service); await service.install(); await tick();
  assert.equal(launches, 1);
  assert.equal(updater.quitAndInstallCalled, false, 'a failed spawn must not permanently consume the upstream install guard');
  assert.equal(service.snapshot().canInstall, true);
  await service.install(); await tick();
  assert.equal(launches, 2, 'the second explicit attempt must reach the real upstream doInstall dispatch');
  assert.equal(updater.quitAndInstallCalled, true, 'successful dispatch must retain the upstream duplicate-install guard');
  await assert.rejects(service.install(), /正在安装/);
  assert.equal(launches, 2);
});

test('check error events and rejected checks both release the operation lock and hide secrets', async t => {
  const {service, updater} = fixture(t);
  for (const reject of [false, true]) {
    updater.checkForUpdates = async () => {
      const error = Object.assign(new Error('PRIVATE https://example.com/?token=PRIVATE'), {code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'});
      updater.emit('error', error); if (reject) throw error; return {};
    };
    await assert.rejects(service.check(), /尚未提供/);
    assert.equal(service.snapshot().errorCode, 'release-unavailable');
    assert.equal(service.snapshot().canCheck, true);
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /PRIVATE/);
  }
  updater.checkForUpdates = FakeUpdater.prototype.checkForUpdates;
  await service.check(); assert.equal(service.snapshot().status, 'available');
});

test('partial or unverified downloads never become installable and can retry without a recheck', async t => {
  const {service, updater} = fixture(t);
  await service.check();
  for (const behavior of ['error-event', 'reject', 'missing-event', 'wrong-version']) {
    updater.downloadUpdate = async () => {
      const error = Object.assign(new Error('PRIVATE checksum path'), {code: 'ERR_CHECKSUM_MISMATCH'});
      if (behavior === 'error-event') updater.emit('error', error);
      if (behavior === 'reject') throw error;
      if (behavior === 'wrong-version') updater.emit('update-downloaded', {version: '0.9.0'});
      return ['PRIVATE'];
    };
    await assert.rejects(service.download());
    assert.equal(service.snapshot().canDownload, true);
    assert.equal(service.snapshot().canInstall, false);
    await assert.rejects(service.install(), /下载/);
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /PRIVATE/);
  }
  updater.downloadUpdate = FakeUpdater.prototype.downloadUpdate;
  await service.download(); assert.equal(service.snapshot().canInstall, true);
});

test('switching preview preference invalidates old offer, never permits downgrade or arbitrary feed', async t => {
  const {service, updater} = fixture(t);
  await service.check();
  service.configure({allowPrerelease: true});
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(service.snapshot().status, 'idle');
  await assert.rejects(service.download(), /检查/);
  for (const value of [{url: 'https://example.com'}, {channel: 'evil'}, {toString: true}, {checkOnStartup: 'true'}, [], null]) {
    assert.throws(() => service.configure(value), /有效/);
  }
  await stage(service);
  assert.throws(() => service.configure({allowPrerelease: false}), /先安装/);
  await service.check();
  assert.equal(updater.calls.check, 2, 'a check must not overwrite already staged installer metadata');
  service.configure({checkOnStartup: true});
  assert.equal(service.snapshot().canInstall, true);
  assert.deepEqual(normalizeUpdatePreferences(), {checkOnStartup: false, allowPrerelease: false});
});

test('update traffic uses its own direct/manual session and retries proxy setup failures', async t => {
  const {service, updater} = fixture(t, {proxy: {mode: 'manual', url: 'socks5://127.0.0.1:1080'}});
  let fail = true;
  updater.netSession.setProxy = async config => {if (fail) throw new Error('PRIVATE proxy secret'); updater.calls.proxy.push(config);};
  await assert.rejects(service.check(), /网络/);
  assert.equal(updater.calls.check, 0);
  fail = false; await stage(service);
  assert.deepEqual(updater.calls.proxy, [{mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080', proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]'}]);
  const direct = fixture(t); await direct.service.check();
  assert.deepEqual(direct.updater.calls.proxy, [{mode: 'direct'}]);
});

test('snapshot copies and bounds progress and ignores unsolicited provider events', async t => {
  const {service, updater} = fixture(t);
  updater.emit('update-downloaded', {version: '9.9.9'});
  assert.equal(service.snapshot().canInstall, false);
  await service.check();
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', {percent: Infinity, transferred: -100, total: 500, bytesPerSecond: NaN, url: 'PRIVATE'});
    const first = service.snapshot();
    assert.deepEqual(first.progress, {percent: 0, transferred: 0, total: 500, bytesPerSecond: 0});
    first.progress.total = 0; first.preferences.allowPrerelease = true;
    assert.equal(service.snapshot().progress.total, 500);
    assert.equal(service.snapshot().preferences.allowPrerelease, false);
    updater.emit('update-downloaded', {version: '0.8.0'});
  };
  await service.download(); assert.equal(service.snapshot().progress.percent, 100);
});

test('not available and malformed metadata have distinct safe states', async t => {
  const {service, updater} = fixture(t);
  updater.checkForUpdates = async () => {updater.emit('update-not-available', {version: '0.7.0'}); return {};};
  await service.check();
  assert.equal(service.snapshot().status, 'not-available');
  updater.checkForUpdates = async () => {updater.emit('update-available', {version: '<PRIVATE>'}); return {};};
  await assert.rejects(service.check(), /信息无效/);
  assert.equal(service.snapshot().errorCode, 'invalid-metadata');
  assert.equal(service.snapshot().canDownload, false);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /PRIVATE/);
});
