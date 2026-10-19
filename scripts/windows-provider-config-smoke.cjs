'use strict';
// Isolated packaged-app checks. No user profile, real cloud account or mount is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {_electron} = require(process.env.ONEMOUNT_PLAYWRIGHT);
const exe = path.resolve(process.env.ONEMOUNT_TEST_EXE || 'dist/OneMount-win32-x64/OneMount.exe');
const previousExe = process.env.ONEMOUNT_PREVIOUS_EXE;
const configFile = path.join(path.dirname(exe), 'provider-config.json');
const originalConfig = fs.readFileSync(configFile);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onemount-provider-desktop-'));
const profile = path.join(base, 'profile'), backend = path.join(base, 'backend');
fs.mkdirSync(profile); fs.mkdirSync(backend);
const report = {passed: false, checks: [], errors: [], isolatedProfile: profile};
const pass = name => {report.checks.push(name); console.log('PASS '+name);};
let app, page;
async function launch(target) {
  app = await _electron.launch({executablePath: target, args: ['--user-data-dir='+profile, '--hidden', '--disable-gpu'], cwd: path.dirname(target), chromiumSandbox: true, timeout: 45000});
  page = await app.firstWindow({timeout: 45000});
  page.on('pageerror', e => report.errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#content h1')?.textContent === '我的磁盘', null, {polling: 100});
  assert.equal(await app.evaluate(({app}) => app.getPath('userData')), profile);
}
const invoke = (method, ...args) => page.evaluate(([method, args]) => window.island.invoke(method, ...args), [method, args]);
async function quit() {
  const closed = page.waitForEvent('close');
  await invoke('quit').catch(e => {if (!page.isClosed()) throw e;});
  await closed; await app.close(); app = null;
}
(async () => {
  fs.writeFileSync(configFile, JSON.stringify({enabledProviders: ['local']}));
  await launch(previousExe || exe);
  const cid = await invoke('addLocal', {name: 'retained fixture', path: backend});
  const did = await invoke('addDisk', {connectionId: cid, name: 'retained disk', mode: 'direct', letter: 'Z:', cacheGiB: 1});
  execFileSync(exe, ['--user-data-dir='+profile, '--hidden'], {timeout: 15000, windowsHide: true, stdio: 'pipe'});
  assert.equal((await invoke('snapshot')).disks[0].id, did);
  pass('Renamed executable respects the existing single-instance profile lock');
  await quit();
  fs.writeFileSync(configFile, JSON.stringify({enabledProviders: ['baidu']}));
  await launch(exe);
  assert.equal(await app.evaluate(({app}) => app.getName()), 'OneMount');
  assert.equal(await page.title(), 'OneMount');
  assert.ok(!(await page.locator('body').innerText()).includes('云屿'));
  const state = await invoke('snapshot');
  assert.deepEqual(state.services.map(s => s.id), ['baidu']);
  assert.equal(state.connections[0].id, cid); assert.equal(state.disks[0].id, did);
  assert.equal(state.disks[0].status, 'unmounted');
  pass(previousExe ? 'Legacy executable profile and DPAPI credentials reopen in OneMount' : 'Existing connections and disks survive provider restriction and restart');
  await assert.rejects(invoke('addLocal', {name: 'blocked', path: backend}), /未开放/);
  await assert.rejects(invoke('connect', {type: 'onedrive', name: 'blocked'}), /未开放/);
  await assert.rejects(invoke('addDisk', {connectionId: cid, name: 'blocked', mode: 'direct', letter: 'Y:', cacheGiB: 1}), /未开放/);
  pass('IPC rejects disabled providers and new disks without changing existing data');
  // Hidden-window DOM event checks avoid waiting for foreground animation frames.
  await page.locator('.ir-nav [data-nav="connections"]').dispatchEvent('click');
  await page.locator('[data-action="add-connection"]').dispatchEvent('click');
  assert.deepEqual(await page.locator('[data-service]').evaluateAll(nodes => nodes.map(n => n.dataset.service)), ['baidu']);
  pass('Single-provider edition renders only Baidu');
  await quit();
  fs.writeFileSync(configFile, JSON.stringify({enabledProviders: []}));
  await launch(exe);
  await page.locator('.ir-nav [data-nav="connections"]').dispatchEvent('click');
  await page.locator('[data-action="add-connection"]').dispatchEvent('click');
  assert.equal(await page.locator('[data-service]').count(), 0);
  assert.ok(await page.getByText('此版本未开放新增存储连接。', {exact: true}).isVisible());
  pass('Empty provider list renders an explanatory empty state');
  assert.deepEqual(report.errors, []);
  await quit();
  report.passed = true;
})().catch(e => {console.error(e); process.exitCode = 1;}).finally(async () => {
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(configFile, originalConfig);
  fs.mkdirSync(path.resolve('test-results'), {recursive: true});
  fs.writeFileSync(path.resolve('test-results/onemount-provider-desktop.json'), JSON.stringify(report, null, 2)+'\n');
});
