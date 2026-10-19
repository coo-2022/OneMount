'use strict';
// UI-only fixture: actual renderer/CSP in an isolated Electron process, with no
// real accounts or network authorization. Does not replace live provider tests.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.ONEMOUNT_PLAYWRIGHT);
const root=path.resolve(__dirname,'..'),base=fs.mkdtempSync(path.join(root,'test-results/115-ui-'));
const preload=path.join(base,'preload.cjs'),entry=path.join(base,'main.cjs');
fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('island',{invoke:(...args)=>ipcRenderer.invoke('fixture',...args),onChange:cb=>ipcRenderer.on('changed',cb)});`);
fs.writeFileSync(entry,`
const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(base,'profile'))});
global.fixture={version:'0.7.0',health:{windows:true,winfsp:true},settings:{loginStart:false,proxy:{mode:'direct',url:''}},services:[{id:'cloud115',name:'115 网盘',available:true}],connections:[],disks:[],auth:null};
app.whenReady().then(async()=>{
const image=await require(${JSON.stringify(path.join(root,'node_modules/qrcode'))}).toDataURL('https://115.com/scan/ui-fixture');
const win=new BrowserWindow({width:1180,height:810,show:false,webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
ipcMain.handle('fixture',async(_e,method,...args)=>{
if(method==='snapshot')return global.fixture;
if(method==='connect'){if(args[0].type!=='cloud115')throw Error('Unexpected provider');global.fixture.auth={id:'fixture115',service:'cloud115',status:'qr_authorizing',device:{qrImage:image}};win.webContents.send('changed');return 'fixture115';}
if(method==='cancelAuth'){global.fixture.auth=null;win.webContents.send('changed');return;}
throw Error('Unexpected UI method '+method);
});
await win.loadFile(${JSON.stringify(path.join(root,'ui/index.html'))});
});`);
const report={checks:[],limits:['UI fixture only; no live 115 account or mount'],base};
const errors=[];let app;
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};
(async()=>{
 try{
  app=await _electron.launch({executablePath:require('electron'),args:[entry,'--disable-gpu'],timeout:45000});
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>typeof state==='object');
  await page.evaluate(()=>addConnection());await page.locator('[data-service="cloud115"]').click();
  assert.match(await page.locator('#modal-content').innerText(),/115.*扫码/s);
  assert.equal(await page.locator('#connection-form input').count(),1);pass('115 form needs only a connection name; no application secrets');
  await page.locator('[data-action="submit-connection"]').click();await page.locator('.ir-auth-qr').waitFor();
  assert.match(await page.locator('.ir-auth-qr').getAttribute('src'),/^data:image\/png;base64,/);
  assert.equal(await page.evaluate(()=>document.querySelector('.ir-auth-qr').naturalWidth>0),true);
  await page.screenshot({path:path.join(base,'qr-login.png')});pass('QR renders locally under production CSP');
  await app.evaluate(({BrowserWindow})=>{global.fixture.auth.status='qr_scanned';BrowserWindow.getAllWindows()[0].webContents.send('changed');});
  await page.getByText('已扫码，请在手机上确认',{exact:true}).waitFor();pass('scanned state asks for phone confirmation');
  await page.locator('[data-action="cancel-auth"]').click();await page.waitForFunction(()=>document.querySelector('#overlay').hidden);pass('cancel closes pending login');
  await app.evaluate(({BrowserWindow})=>{global.fixture.connections=[{id:'115',type:'cloud115',name:'115 网盘',folder:'/'},{id:'local',type:'local',name:'本地测试',folder:'/'}];BrowserWindow.getAllWindows()[0].webContents.send('changed');});
  await page.waitForFunction(()=>state.connections.length===2);await page.evaluate(()=>addDisk());
  assert.equal(await page.locator('[data-mode="juicefs"]').isDisabled(),true);
  assert.equal(await page.locator('#new-disk-mode-note').isVisible(),true);
  await page.locator('[name="connectionId"]').selectOption('local');assert.equal(await page.locator('[data-mode="juicefs"]').isDisabled(),false);
  await page.locator('[data-mode="juicefs"]').click();await page.locator('[name="connectionId"]').selectOption('115');
  assert.equal(await page.locator('[data-mode="direct"]').getAttribute('aria-pressed'),'true');pass('115 stays in direct mode until live volume validation; other providers retain volume mode');
  assert.deepEqual(errors,[]);pass('no renderer exceptions');
 }finally{if(app)await app.close();fs.writeFileSync(path.join(base,'report.json'),JSON.stringify({...report,errors},null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
