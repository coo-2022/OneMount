'use strict';
// Launch the unmodified packaged executable. Native directory picking alone is
// replaced with a deterministic fixture; mounts, IPC, DPAPI and engine processes are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {_electron} = require(process.env.ONEMOUNT_PLAYWRIGHT);
const P = require('../src/processes.cjs');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable Windows CI runner required');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onemount-packaged-'));
const results = path.resolve(__dirname, '../test-results'); fs.mkdirSync(results, {recursive:true});
const exe = path.resolve(__dirname, '../dist/CloudIsland-win32-x64/CloudIsland.exe');
const backend = path.join(base, 'backend'); fs.mkdirSync(backend);
fs.writeFileSync(path.join(backend, 'existing.txt'), 'existing backend file');
const letters = [...'ZYXWVUTSRQPONMLKJIHGFE'].filter(c=>!fs.existsSync(c+':\\')).slice(0,2).map(c=>c+':');
assert.equal(letters.length,2);
const report = {version:'0.1.2',platform:os.release(),checks:[],limits:['Native folder picker selection supplied by fixture','No real third-party cloud OAuth or remote backend','No manual Explorer shell inspection']};
let app, page, stateRoot;
const errors=[];
const pass = name => {report.checks.push(name); console.log('PASS '+name);};
const snapshot = () => page.evaluate(()=>window.island.invoke('snapshot'));
async function waitDisk(id, status) {
  await page.waitForFunction(async ({id,status})=>{
    const s=await window.island.invoke('snapshot'); const d=s.disks.find(x=>x.id===id);
    if(d?.status==='error') throw new Error(d.error||d.lastError||'Mount failed');
    return d?.status===status&&!d.busy;
  }, {id,status}, {timeout:90000});
}
async function launch() {
  app=await _electron.launch({executablePath:exe,args:['--disable-gpu'],cwd:path.dirname(exe),timeout:60000,chromiumSandbox:true});
  page=await app.firstWindow({timeout:60000}); page.setDefaultTimeout(20000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelector('#content h1')?.textContent==='我的磁盘');
  const info=await app.evaluate(({app,safeStorage,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),encryption:safeStorage.isEncryptionAvailable(),root:app.getPath('userData'),prefs:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}));
  assert.equal(info.packaged,true); assert.equal(info.version,'0.1.2'); assert.equal(info.encryption,true);
  assert.equal(info.prefs.nodeIntegration,false); assert.equal(info.prefs.contextIsolation,true); assert.equal(info.prefs.sandbox,true);
  stateRoot=info.root;
}
async function selectDisk(id) {await page.locator(`#shortcuts [data-id="${id}"]`).click();}
async function mount(id) {await selectDisk(id);await page.locator('[data-action="mount"]').click();await waitDisk(id,'mounted');}
async function drain(id) {
  await P.waitFor(async()=>{
    const s=await snapshot(),d=s.disks.find(x=>x.id===id);
    if(!d.stats?.known)return false;
    if(d.mode==='direct')return d.stats.pendingFiles===0&&d.stats.vfs.diskCache.uploadsInProgress===0&&d.stats.vfs.diskCache.uploadsQueued===0;
    return d.stats.pendingBlocks===0;
  },90000);
}
async function unmount(id) {
  await drain(id);await selectDisk(id);
  await page.locator('[data-action="unmount-confirm"]').click();
  await page.locator('[data-action="unmount"]').click();await waitDisk(id,'unmounted');
  await page.locator('#overlay').waitFor({state:'hidden'});
}
async function quit() {
  await page.locator('.ir-nav [data-nav="settings"]').click();
  await page.locator('[data-action="quit-confirm"]').click();
  const closed=page.waitForEvent('close',{timeout:30000});
  await page.locator('[data-action="quit"]').click().catch(e=>{if(!page.isClosed())throw e;});
  await closed;
  // Release Playwright's main-process inspector after the product closes its window.
  await app.close();app=null;
}
async function main(){
  await launch();assert.equal((await snapshot()).disks.length,0,'Must start with fresh CI user data');
  pass('Packaged EXE launches with production preload, renderer sandbox and Windows DPAPI');
  // Exercise the form and pick-folder button; only the OS dialog response is stubbed.
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},backend);
  await page.locator('[data-action="add-connection"]').first().click();
  await page.locator('[data-service="local"]').click();
  await page.locator('#connection-form [name="name"]').fill('Windows 验证');
  await page.locator('[data-action="pick-folder"]').click();
  await page.locator('[data-action="submit-connection"]').click();
  await page.locator('#overlay').waitFor({state:'hidden'});
  await page.locator('[data-action="test-connection"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('连接正常'));
  pass('UI creates and checks local storage connection');
  const disks=[];
  for(const [i,mode] of ['direct','juicefs'].entries()){
    await page.locator('.ir-nav [data-nav="home"]').click();
    await page.locator('[data-action="add-disk"]').first().click();
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.locator('#add-disk-form [name="name"]').fill(mode==='direct'?'网盘直连验证':'文件系统卷验证');
    await page.locator('#add-disk-form [name="letter"]').selectOption(letters[i]);
    await page.locator('#add-disk-form [name="cacheGiB"]').fill('1');
    await page.locator('[data-action="create-disk"]').click();
    await page.locator('#overlay').waitFor({state:'hidden'});
    const d=(await snapshot()).disks.find(x=>x.mode===mode);assert.ok(d);disks.push(d);
    console.log('CHECK mounting '+mode);
    await mount(d.id);
    console.log('CHECK mounted '+mode);
    if(mode==='direct')assert.equal(fs.readFileSync(d.letter+'\\existing.txt','utf8'),'existing backend file');
    else assert.ok(!fs.existsSync(d.letter+'\\existing.txt'),'Filesystem volume must stay isolated');
    const data=crypto.randomBytes(8*1024**2+73),file=d.letter+'\\大文件 验证.bin';
    fs.writeFileSync(file,data);assert.deepEqual(fs.readFileSync(file),data);
    d.hash=crypto.createHash('sha256').update(data).digest('hex');
    await P.run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Set-Content '${d.letter}\\hello.txt' 'hello juicefs + rclone'; if ((Get-Content '${d.letter}\\hello.txt' -Raw).Trim() -ne 'hello juicefs + rclone') {throw 'Read mismatch'}`]);
    console.log('CHECK waiting for uploads '+mode);
    await drain(d.id);
    console.log('CHECK uploads complete '+mode);
    await page.screenshot({path:path.join(results,mode+'-mounted.png')});
    pass(`Packaged UI creates and mounts ${mode}; existing-file semantics, PowerShell read/write, binary hash`);
  }
  await page.locator('.ir-nav [data-nav="activity"]').click();
  await page.screenshot({path:path.join(results,'activity.png')});
  assert.ok(!(await page.locator('body').innerText()).match(/rclone|juicefs/i),'UI must not expose internal engine names');
  // The real window-close handler must leave mounts and the tray process alive.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  for(const d of disks)assert.ok(fs.existsSync(d.letter+'\\hello.txt'));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  pass('Closing the window preserves mounted drives and hides to tray');
  for(const d of disks)await unmount(d.id);
  const first=(await snapshot()).disks[0];
  // Exercise settings persistence and automatic mounting on the next application launch.
  await selectDisk(first.id);await page.locator('[data-tab="advanced"]').click();
  await page.locator('#disk-settings [name="autoMount"]').check();
  await page.locator('[data-action="save-disk-settings"]').click();
  await page.waitForFunction(async id=>(await window.island.invoke('snapshot')).disks.find(d=>d.id===id).autoMount,first.id);
  const paths=(await snapshot()).disks.map(d=>d.paths.cache);
  assert.match(fs.readFileSync(path.join(stateRoot,'accounts.conf'),'utf8'),/RCLONE_ENCRYPT_V0/);
  console.log('CHECK safe exit before restart');
  await quit();
  for(const d of disks)assert.ok(!fs.existsSync(d.letter+'\\'));
  // All are clean and stopped; erase ONLY fresh CI read caches before restart.
  for(const cache of paths)fs.rmSync(cache,{recursive:true,force:true});
  console.log('CHECK restart');
  await launch();assert.equal((await snapshot()).disks.length,2);
  await waitDisk(first.id,'mounted');
  for(const d of disks){
    if(d.id!==first.id)await mount(d.id);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(d.letter+'\\大文件 验证.bin')).digest('hex'),d.hash);
  }
  pass('Safe exit and EXE restart preserve encrypted account configuration, disk records, auto-mount and cold-cache file hashes');
  await page.locator('.ir-nav [data-nav="home"]').click();
  await page.screenshot({path:path.join(results,'both-modes.png')});
  for(const d of disks)await drain(d.id);
  // Quit directly while both disks are mounted: the product must unmount them itself.
  await quit();for(const d of disks)assert.ok(!fs.existsSync(d.letter+'\\'));
  const processes=await P.run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @('rclone','juicefs') } | ForEach-Object { $_.Id }"]);
  assert.equal(processes.trim(),'','Safe exit must not leave engine processes for this test user');
  assert.deepEqual(errors,[]);pass('Safe exit with both disks mounted removes drive letters and engine processes; no renderer exceptions');
  report.status='passed';
}
main().catch(async e=>{
  report.status='failed';report.error=e.stack;console.error(e);process.exitCode=1;
  fs.writeFileSync(path.join(results,'windows-packaged-report.json'),JSON.stringify(report,null,2));
  if(page&&!page.isClosed())console.error('STATE',JSON.stringify(await snapshot().catch(()=>null)));
  if(page&&!page.isClosed())await page.screenshot({path:path.join(results,'failure.png')}).catch(()=>{});
  if(stateRoot&&fs.existsSync(path.join(stateRoot,'volumes')))for(const file of fs.readdirSync(path.join(stateRoot,'volumes'),{recursive:true}))if(/(?:engine|volume)\.log$/.test(file)){
    const text=fs.readFileSync(path.join(stateRoot,'volumes',file),'utf8');console.error(text.slice(-12000));
  }
  if(page&&!page.isClosed())await Promise.race([page.evaluate(()=>window.island.invoke('quit')).catch(()=>{}),P.delay(10000)]);
  if(app)await Promise.race([app.close().catch(()=>{}),P.delay(10000)]);
}).finally(()=>{fs.writeFileSync(path.join(results,'windows-packaged-report.json'),JSON.stringify(report,null,2));});
