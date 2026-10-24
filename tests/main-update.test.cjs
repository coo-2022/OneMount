'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};}

// Exercise the actual main-process IPC and quit listeners with the real update
// service. There is no Electron process, account profile, installer, or disk I/O.
async function fixture(t) {
  let handler, window, manager, updater;
  const counts = {shutdowns: 0, quits: 0, installs: 0, settingsWrites: 0};
  const timers = new Set();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, setName() {}, setAppUserModelId() {}, getPath: () => root,
    getVersion: () => '0.7.0', setLoginItemSettings() {},
    quit() {let blocked = false; app.emit('before-quit', {preventDefault() {blocked = true;}}); if (!blocked) counts.quits++;},
  });
  class Window extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = {mainFrame: {url: pathToFileURL(path.join(root, 'ui', 'index.html')).href},
        send() {}, setWindowOpenHandler() {}, on() {}, session: {setPermissionRequestHandler() {}}};
    }
    isDestroyed() {return false;}
    show() {}
    hide() {}
    async loadFile() {}
  }
  class Manager extends EventEmitter {
    constructor() {
      super(); manager = this;
      this.activeProxy = {mode: 'direct'};
      this.state = {settings: {updates: {checkOnStartup: false, allowPrerelease: false}}, disks: []};
      this.runtime = new Map();
    }
    async init() {}
    snapshot() {return {disks: []};}
    async shutdown() {counts.shutdowns++;}
    async poll() {}
    updateSettings() {counts.settingsWrites++;}
  }
  class Updater extends EventEmitter {
    constructor() {super(); updater = this; this.netSession = {setProxy: async () => {}};}
    async checkForUpdates() {this.emit('update-available', {version: '0.8.0'}); return {};}
    async downloadUpdate() {this.emit('update-downloaded', {version: '0.8.0'});}
    quitAndInstall() {counts.installs++;}
  }
  const electron = {app, BrowserWindow: Window, ipcMain: {handle(_name, callback) {handler = callback;}},
    safeStorage: {isEncryptionAvailable: () => true}, dialog: {showMessageBox: async () => {}}, shell: {}};
  const mocks = {
    electron, './manager.cjs': {Manager}, './providers.cjs': {loadProviderConfig: () => ({}), loadOAuthClients: () => ({})},
    './install-state.cjs': {isInstalled: () => true}, './accounts.cjs': {installAccounts() {}}, 'electron-updater': {NsisUpdater: Updater},
  };
  const context = {module: {exports: {}}, __dirname: path.join(root, 'src'),
    process: {...process, resourcesPath: path.join(root, 'test-results')},
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id.startsWith('./') ? path.join(root, 'src', id) : id),
    setTimeout, clearInterval, setInterval: (...args) => {const timer = setInterval(...args); timers.add(timer); return timer;}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8'), context, {filename: 'main.cjs'});
  t.after(() => {for (const timer of timers) clearInterval(timer);});
  await context.module.exports.start({headless: true});
  const call = (method, ...args) => handler({sender: window.webContents, senderFrame: window.webContents.mainFrame}, method, ...args);
  const stage = async () => {assert.equal((await call('checkUpdate')).ok, true); assert.equal((await call('downloadUpdate')).ok, true);};
  return {app, call, stage, counts, manager, updater};
}

test('main cancels the updater queued quit after asynchronous installer failure; explicit safe quit still works', async t => {
  const {app, call, stage, counts, updater} = await fixture(t);
  updater.quitAndInstall = () => {
    counts.installs++;
    queueMicrotask(() => updater.emit('error', new Error('PRIVATE launch failure')));
    // electron-updater 6.x queues this even if its asynchronous spawn fails.
    setImmediate(() => app.quit());
  };
  await stage(); await call('installUpdate'); await tick(); await tick();
  assert.equal(counts.shutdowns, 1);
  assert.equal(counts.installs, 1);
  assert.equal(counts.quits, 0, 'queued quit must not become another normal safe quit');
  const update = (await call('snapshot')).value.update;
  assert.equal(update.status, 'downloaded');
  assert.equal(update.canInstall, true);
  assert.equal(update.errorCode, 'install-failed');
  assert.doesNotMatch(update.error, /PRIVATE/);
  assert.equal((await call('quit')).ok, true);
  assert.equal(counts.quits, 1);
});

test('main update shutdown failure retains staged installer and restores explicit safe quit', async t => {
  const {call, stage, counts, manager} = await fixture(t);
  let blocked = true;
  manager.shutdown = async () => {counts.shutdowns++; if (blocked) throw new Error('PRIVATE pending uploads');};
  await stage();
  const failed = await call('installUpdate');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /暂时无法安全更新/);
  assert.equal(counts.installs, 0);
  assert.equal((await call('snapshot')).value.update.canInstall, true);
  blocked = false;
  assert.equal((await call('quit')).ok, true);
  assert.equal(counts.quits, 1);
});

test('failed update preparation cannot unlock a normal safe quit that already owns the shutdown lock', async t => {
  const {call, stage, counts, manager} = await fixture(t);
  await stage();
  const gate = deferred();
  manager.shutdown = async () => {counts.shutdowns++; await gate.promise;};
  // The update callback runs on a promise; normal quit takes its lock first.
  const install = call('installUpdate');
  const quit = call('quit');
  assert.equal((await install).ok, false);
  const change = await call('settings', {loginStart: true});
  assert.equal(change.ok, false);
  assert.match(change.error, /正在安全退出/);
  assert.equal(counts.settingsWrites, 0);
  assert.equal(counts.installs, 0);
  gate.resolve();
  assert.equal((await quit).ok, true);
  assert.equal(counts.quits, 1);
});

test('generic settings IPC cannot bypass update preference validation or lifecycle fences', async t => {
  const {call, counts} = await fixture(t);
  const result = await call('settings', {updates: {allowPrerelease: true}});
  assert.equal(result.ok, false);
  assert.match(result.error, /软件更新选项/);
  assert.equal(counts.settingsWrites, 0);
  assert.equal((await call('snapshot')).value.update.preferences.allowPrerelease, false);
});
