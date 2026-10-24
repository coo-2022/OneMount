'use strict';
// Real NSIS installation/upgrade in an isolated installation identity and profile.
// The input manifest must describe TWO differently versioned test-only installers.
// Never point this harness at the release installer: /D alone does not isolate
// NSIS registry keys or shortcuts. No cloud account or filesystem mount is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function assertManifest(m, manifestPath) {
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.purpose, 'onemount-installer-smoke');
  assert.match(m.appId, /^com\.onemount\.install-test\.[a-z0-9-]+$/i, 'Require an isolated test App ID');
  assert.match(m.nsisGuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.match(m.productName, /^OneMount Install-Test [a-z0-9-]+$/i);
  assert.match(m.executableName, /^OneMount-install-test-[a-z0-9-]+$/i);
  const versions = [];
  for (const label of ['installerV1', 'installerV2']) {
    const fixture = m[label];
    assert.match(fixture.version, /^\d+\.\d+\.\d+$/);
    versions.push(fixture.version.split('.').map(Number));
    fixture.path = path.resolve(path.dirname(manifestPath), fixture.path);
    assert.equal(path.extname(fixture.path).toLowerCase(), '.exe');
    assert.match(fixture.sha256, /^[a-f0-9]{64}$/i);
    assert.equal(digest(fixture.path), fixture.sha256.toLowerCase(), 'Installer differs from its test manifest');
  }
  const differing = versions[1].findIndex((n, i) => n !== versions[0][i]);
  assert.ok(differing >= 0 && versions[1][differing] > versions[0][differing], 'Upgrade must use a newer version, not same-version reinstall');
  return m;
}

async function run(file, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    // NSIS explicitly requires the trailing /D= or _?= path to be unquoted,
    // including paths containing spaces. No shell is involved here.
    const proc = spawn(file, args, {windowsHide: true, windowsVerbatimArguments: true,
      argv0: '"' + file + '"', stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    const timer = setTimeout(() => {
      // Do not terminate an installer while it might be replacing application files.
      reject(new Error('Installer operation timed out; its isolated process was left intact: ' + proc.pid));
    }, timeout);
    proc.stdout.on('data', data => {output += data;});
    proc.stderr.on('data', data => {output += data;});
    proc.once('error', error => {clearTimeout(timer); reject(error);});
    proc.once('exit', code => {clearTimeout(timer); resolve({code, output});});
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {if (await fn()) return; await delay(100);}
  throw new Error('Timed out waiting for the isolated application');
}
function registry(key) {
  // reg.exe writes localized OEM text; use a structured, UTF-8 registry read so
  // absence is distinguishable from a denied read on every Windows language.
  const source = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "$hive=if($env:ONEMOUNT_TEST_REGISTRY_HIVE -eq 'HKCU'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}; " +
    "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,[Microsoft.Win32.RegistryView]::Registry64); " +
    "try {$key=$base.OpenSubKey($env:ONEMOUNT_TEST_REGISTRY_KEY,$false); if($null -eq $key){'null'}else{try {$values=@($key.GetValueNames() | ForEach-Object {[string]$key.GetValue($_)}); ConvertTo-Json -InputObject $values -Compress} finally {$key.Dispose()}}}finally{$base.Dispose()}";
  const result = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    windowsHide: true, encoding: 'utf8', env: {...process.env, ONEMOUNT_TEST_REGISTRY_HIVE: key.slice(0, 4), ONEMOUNT_TEST_REGISTRY_KEY: key.slice(5)}});
  assert.equal(result.status, 0, result.stderr || 'Cannot query installer registry');
  const values = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  return values === null ? null : values.join('\n');
}

async function main() {
  assert.equal(process.platform, 'win32', 'Windows installer smoke requires Windows');
  const manifestPath = path.resolve(process.env.ONEMOUNT_INSTALL_TEST_MANIFEST || 'test-results/install-test-fixtures/manifest.json');
  const manifest = assertManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifestPath);
  const {_electron} = require(process.env.ONEMOUNT_PLAYWRIGHT);
  const evidence = path.resolve(__dirname, '../test-results'); fs.mkdirSync(evidence, {recursive: true});
  const base = fs.mkdtempSync(path.join(evidence, 'onemount-install-test-'));
  const installDir = path.join(base, 'application');
  const profile = path.join(base, 'profile');
  const backend = path.join(base, 'backend');
  fs.mkdirSync(profile); fs.mkdirSync(backend);
  const exe = path.join(installDir, manifest.executableName + '.exe');
  const keySuffix = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + manifest.nsisGuid;
  const userKey = 'HKCU\\' + keySuffix, machineKey = 'HKLM\\' + keySuffix;
  assert.equal(registry(userKey), null, 'Test identity already installed; generate fresh fixtures');
  assert.equal(registry(machineKey), null, 'Test identity must not replace a machine-wide installation');
  const report = {status: 'running', identity: {appId: manifest.appId, guid: manifest.nsisGuid}, versions: [manifest.installerV1.version, manifest.installerV2.version], base, checks: [], pageErrors: [], limits: ['No real cloud traffic or filesystem mounts', 'Updater UI uses injected update events; actual NSIS version upgrade is tested separately', 'No code-signing or public release CDN validation']};
  const pass = message => {report.checks.push(message); console.log('PASS ' + message);};
  let app, page;
  const invoke = (method, ...args) => page.evaluate(([m, a]) => window.island.invoke(m, ...a), [method, args]);
  async function launch(version) {
    app = await _electron.launch({executablePath: exe, args: ['--user-data-dir=' + profile, '--hidden', '--disable-gpu'], cwd: installDir, chromiumSandbox: true, timeout: 60000});
    page = await app.firstWindow({timeout: 60000});
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '我的磁盘', null, {polling: 100});
    const info = await app.evaluate(({app}) => ({version: app.getVersion(), root: app.getPath('userData')}));
    assert.equal(info.root, profile);
    assert.equal(info.version, version);
    assert.equal((await invoke('snapshot')).settings.loginStart, false);
  }
  async function quit() {
    if (!app) return;
    const closed = page.waitForEvent('close', {timeout: 30000});
    await invoke('quit').catch(error => {if (!page.isClosed()) throw error;});
    await closed;
    await app.close(); app = null; page = null;
  }
  async function install(fixture) {
    assert.ok(inside(base, installDir));
    const result = await run(fixture.path, ['/S', '/D=' + installDir]);
    assert.equal(result.code, 0, result.output);
    assert.ok(fs.existsSync(exe));
    const reg = registry(userKey);
    assert.ok(reg?.includes(installDir), 'HKCU uninstall entry must point to the isolated directory');
    assert.ok(reg?.includes(fixture.version), 'Uninstall entry must carry the installed version');
    assert.equal(registry(machineKey), null, 'Per-user install must not write a machine-wide uninstall key');
  }
  async function uninstall() {
    const candidates = fs.readdirSync(installDir).filter(name => /^Uninstall .*\.exe$/i.test(name));
    assert.equal(candidates.length, 1);
    const uninstaller = path.join(installDir, candidates[0]);
    assert.ok(inside(base, uninstaller));
    // NSIS _?= avoids a copied uninstaller returning before removal has finished.
    const result = await run(uninstaller, ['/S', '_?=' + installDir]);
    assert.equal(result.code, 0, result.output);
    await waitFor(() => !fs.existsSync(exe) && registry(userKey) === null);
  }
  try {
    await install(manifest.installerV1);
    pass('Fresh per-user NSIS installation creates only the isolated installation and HKCU entry');
    const configFile = path.join(installDir, 'provider-config.json');
    const override = JSON.stringify({enabledProviders: ['local']}, null, 2) + '\n';
    fs.writeFileSync(configFile, override);
    const oauthFile = path.join(installDir, 'oauth-clients.json');
    // Public, deliberately non-working fixture IDs only; never use local developer
    // credentials in the installation test artifacts or evidence.
    const oauthOverride = JSON.stringify(Object.fromEntries(['onedrive', 'drive', 'baidu', 'dropbox'].map(id => [id, {clientId: 'installer-preservation-fixture', clientSecret: ''}])), null, 2) + '\n';
    fs.writeFileSync(oauthFile, oauthOverride);
    await launch(manifest.installerV1.version);
    const cid = await invoke('addLocal', {name: 'installation fixture', path: backend});
    const did = await invoke('addDisk', {connectionId: cid, name: 'preserved disk', mode: 'direct', letter: 'Z:', cacheGiB: 1});
    const disk = (await invoke('snapshot')).disks.find(d => d.id === did);
    assert.equal(disk.status, 'unmounted');
    const sentinels = [path.join(profile, 'retained-user-data.txt'), path.join(disk.paths.cache, 'retained-pending-bytes.test'), path.join(disk.paths.dir, 'retained-metadata.test')];
    for (const file of sentinels) {assert.ok(inside(profile, file)); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, crypto.randomBytes(1024));}
    const sentinelHashes = sentinels.map(digest);
    const accountsHash = digest(path.join(profile, 'accounts.conf'));
    const appHash = digest(path.join(installDir, 'resources', 'app.asar'));
    assert.match(fs.readFileSync(path.join(profile, 'accounts.conf'), 'utf8'), /RCLONE_ENCRYPT_V0/);
    pass('Installed application opens an explicit isolated DPAPI profile and creates unmounted fixture records');

    const busyUpgrade = await run(manifest.installerV2.path, ['/S', '/D=' + installDir]);
    assert.notEqual(busyUpgrade.code, 0, 'Installer must refuse replacement while its app is running');
    assert.equal(digest(path.join(installDir, 'resources', 'app.asar')), appHash);
    assert.equal((await invoke('snapshot')).disks[0].id, did);
    pass('Upgrade refuses a running application without killing it or replacing its files');

    const uninstallerName = fs.readdirSync(installDir).find(name => /^Uninstall .*\.exe$/i.test(name));
    assert.ok(uninstallerName);
    const busyUninstall = await run(path.join(installDir, uninstallerName), ['/S', '_?=' + installDir]);
    assert.notEqual(busyUninstall.code, 0, 'Uninstaller must refuse removal while its app is running');
    assert.equal(digest(path.join(installDir, 'resources', 'app.asar')), appHash);
    assert.equal((await invoke('snapshot')).disks[0].id, did);
    pass('Uninstall also refuses a running application and retains its files');

    await quit();
    const migratedDir = path.join(base, 'different-application-directory');
    const movedUpgrade = await run(manifest.installerV2.path, ['/S', '/D=' + migratedDir]);
    assert.notEqual(movedUpgrade.code, 0, 'An upgrade must not move an existing installation and lose deployment overrides');
    assert.equal(digest(path.join(installDir, 'resources', 'app.asar')), appHash);
    assert.equal(fs.existsSync(path.join(migratedDir, manifest.executableName + '.exe')), false);
    pass('Upgrade refuses changing the registered install directory before replacing files');
    await install(manifest.installerV2);
    assert.notEqual(digest(path.join(installDir, 'resources', 'app.asar')), appHash, 'New version payload must actually replace the old application');
    assert.equal(fs.readFileSync(configFile, 'utf8'), override, 'Provider edition override must survive upgrade');
    assert.equal(fs.readFileSync(oauthFile, 'utf8'), oauthOverride, 'OAuth deployment override must survive upgrade');
    assert.equal(digest(path.join(profile, 'accounts.conf')), accountsHash);
    assert.deepEqual(sentinels.map(digest), sentinelHashes);
    await launch(manifest.installerV2.version);
    const state = await invoke('snapshot');
    assert.equal(state.connections.find(c => c.id === cid)?.name, 'installation fixture');
    assert.equal(state.disks.find(d => d.id === did)?.name, 'preserved disk');
    assert.deepEqual(state.services.map(s => s.id), ['local']);
    pass('Actual newer-version NSIS upgrade preserves encrypted accounts, disk records, provider/OAuth override bytes and cache/metadata sentinels');
    await checkUpdaterUI({app, page, invoke, pass, evidence});
    await quit();
    await uninstall();
    assert.equal(digest(path.join(profile, 'accounts.conf')), accountsHash);
    assert.deepEqual(sentinels.map(digest), sentinelHashes);
    assert.ok(fs.existsSync(path.join(profile, 'credentials.json')));
    pass('Uninstall removes its application and registry entry while retaining user data and cached bytes');
    assert.deepEqual(report.pageErrors, [], 'Renderer must not raise uncaught errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; throw error;
  } finally {
    // No taskkill, global registry cleanup, recursive install-directory deletion or
    // automatic uninstall-on-failure: preserve the isolated evidence for diagnosis.
    if (app && page && !page.isClosed()) await quit().catch(error => {report.cleanupError = error.message;});
    fs.writeFileSync(path.join(evidence, 'windows-install-update-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

async function checkUpdaterUI({app, page, invoke, pass, evidence}) {
  // Dependency replacement occurs through Playwright's main-process debugger in
  // THIS isolated process. Production IPC never accepts a feed URL or executable.
  await app.evaluate(({app}) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const path = require('node:path');
    const {NsisUpdater} = require(path.join(app.getAppPath(), 'node_modules/electron-updater'));
    const {Manager} = require(path.join(app.getAppPath(), 'src/manager.cjs'));
    const original = {check: NsisUpdater.prototype.checkForUpdates, download: NsisUpdater.prototype.downloadUpdate, install: NsisUpdater.prototype.quitAndInstall, spawn: NsisUpdater.prototype.spawnLog, shutdown: Manager.prototype.shutdown};
    const fixture = {events: [], original, updater: null}; globalThis.__onemountInstallTest = fixture;
    NsisUpdater.prototype.checkForUpdates = async function () {
      fixture.updater = this;
      this.emit('checking-for-update');
      const info = {version: '99.0.0', releaseName: 'Isolated update fixture', releaseDate: '2026-10-23T00:00:00Z', files: []};
      this.emit('update-available', info); return {updateInfo: info};
    };
    NsisUpdater.prototype.downloadUpdate = async function () {
      this.emit('download-progress', {percent: 50, bytesPerSecond: 1024, transferred: 1024, total: 2048});
      this.downloadedUpdateHelper = {file: 'not-an-executable', downloadedFileInfo: {isAdminRightsRequired: false}};
      this.emit('update-downloaded', {version: '99.0.0', downloadedFile: 'not-an-executable'}); return [];
    };
    NsisUpdater.prototype.quitAndInstall = function () {fixture.events.push('installer');};
    Manager.prototype.shutdown = async function () {fixture.events.push('shutdown-blocked'); throw new Error('测试待上传数据：暂时不能安全退出');};
  });
  try {
    await page.locator('.ir-nav [data-nav="settings"]').dispatchEvent('click');
    await page.locator('[data-action="check-update"]').dispatchEvent('click');
    await waitFor(async () => (await invoke('snapshot')).update.canDownload);
    assert.ok((await page.locator('body').innerText()).includes('99.0.0'));
    await page.locator('[data-action="download-update"]').dispatchEvent('click');
    await waitFor(async () => (await invoke('snapshot')).update.canInstall);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Settings must not overflow horizontally');
    await page.locator('#update-settings').evaluate(node => node.scrollIntoView({block: 'center'}));
    // Hidden Windows WebContents can stop drawing even with capturePage's
    // stayAwake flag. Show only THIS isolated fixture briefly for visual QA.
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].show());
    try {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({path: path.join(evidence, 'installation-update-settings.png')});
    }
    finally {await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide());}
    await page.locator('[data-action="install-update-confirm"]').dispatchEvent('click');
    await page.locator('[data-action="install-update"]').dispatchEvent('click');
    await waitFor(async () => {const s = (await invoke('snapshot')).update; return s.errorCode === 'shutdown-blocked' && s.canInstall;});
    assert.deepEqual(await app.evaluate(() => globalThis.__onemountInstallTest.events), ['shutdown-blocked']);
    assert.equal(page.isClosed(), false);
    pass('Settings checks/downloads update via injected events; blocked safe exit never invokes the installer');
    await app.evaluate(({app}) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const {NsisUpdater} = require(path.join(app.getAppPath(), 'node_modules/electron-updater'));
      const {Manager} = require(path.join(app.getAppPath(), 'src/manager.cjs'));
      const fixture = globalThis.__onemountInstallTest;
      Manager.prototype.shutdown = async function () {await fixture.original.shutdown.call(this); fixture.events.push('shutdown-ok');};
      NsisUpdater.prototype.quitAndInstall = fixture.original.install;
      NsisUpdater.prototype.spawnLog = async function () {
        fixture.events.push('installer-launch-error');
        throw Object.assign(new Error('fixture install launch refused'), {code: 'EIO'});
      };
    });
    await invoke('installUpdate').catch(() => {});
    await waitFor(async () => {const s = (await invoke('snapshot')).update; return s.errorCode === 'install-failed' && s.canInstall;});
    await delay(300);
    assert.equal(page.isClosed(), false);
    assert.deepEqual(await app.evaluate(() => globalThis.__onemountInstallTest.events), ['shutdown-blocked', 'shutdown-ok', 'installer-launch-error']);
    assert.equal(await app.evaluate(() => globalThis.__onemountInstallTest.updater.quitAndInstallCalled), false);
    await invoke('installUpdate').catch(() => {});
    await waitFor(async () => {const events = await app.evaluate(() => globalThis.__onemountInstallTest.events); return events.filter(e => e === 'installer-launch-error').length === 2 && (await invoke('snapshot')).update.canInstall;});
    await delay(300);
    assert.equal(page.isClosed(), false);
    assert.equal(await app.evaluate(() => globalThis.__onemountInstallTest.updater.quitAndInstallCalled), false);
    pass('Real updater installation lifecycle recovers from asynchronous spawn failure, suppresses queued quit and permits a second attempt');
  } finally {
    await app.evaluate(({app}) => {
      const require = process.mainModule.require.bind(process.mainModule);
      const path = require('node:path');
      const {NsisUpdater} = require(path.join(app.getAppPath(), 'node_modules/electron-updater'));
      const {Manager} = require(path.join(app.getAppPath(), 'src/manager.cjs'));
      const {original} = globalThis.__onemountInstallTest;
      NsisUpdater.prototype.checkForUpdates = original.check;
      NsisUpdater.prototype.downloadUpdate = original.download;
      NsisUpdater.prototype.quitAndInstall = original.install;
      NsisUpdater.prototype.spawnLog = original.spawn;
      Manager.prototype.shutdown = original.shutdown;
      delete globalThis.__onemountInstallTest;
    });
  }
}

if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {assertManifest, inside};
