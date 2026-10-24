const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {Manager}=require('../src/manager.cjs');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'backend');fs.mkdirSync(base);const m=new Manager({root:path.join(root,'state'),engines:root,providerConfig:{enabledProviders:['local']},protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});return {m,base};}
test('update preferences persist while invalid writes leave all settings unchanged', t => {
  const {m} = setup(t);
  assert.deepEqual(m.state.settings.updates, {checkOnStartup: false, allowPrerelease: false});
  m.updateSettings({updates: {checkOnStartup: true}});
  m.updateSettings({updates: {allowPrerelease: true}});
  const saved = fs.readFileSync(m.file, 'utf8');
  for (const updates of [null, [], {allowPrerelease: 'true'}, {feedURL: 'https://invalid.example'}]) {
    assert.throws(() => m.updateSettings({updates, loginStart: true}), /更新设置/);
    assert.equal(fs.readFileSync(m.file, 'utf8'), saved);
    assert.equal(m.state.settings.loginStart, false);
  }
  const restored = new Manager({root: m.root, engines: m.engines, providerConfig: {enabledProviders: ['local']}, protect: m.protect, unprotect: m.unprotect});
  assert.deepEqual(restored.state.settings.updates, {checkOnStartup: true, allowPrerelease: true});
});
test('creation persists and removal archives without deleting metadata or cache',async t=>{
  const {m,base}=setup(t);const c=await m.addLocal({name:'本地',path:base});const id=await m.addDisk({connectionId:c,name:'卷',mode:'juicefs',letter:'X:',cacheGiB:10});
  const p=m.paths(m.disk(id));fs.writeFileSync(p.meta,'precious metadata');fs.writeFileSync(path.join(p.cache,'pending'),'precious dirty bytes');
  await assert.rejects(()=>m.deleteConnection(c),/先移除/);await m.removeDisk(id);
  assert.equal(fs.readFileSync(p.meta,'utf8'),'precious metadata');assert.ok(fs.existsSync(path.join(p.cache,'pending')));assert.ok(fs.existsSync(path.join(p.dir,'archived-disk.json')));assert.equal(m.state.disks.length,0);
});
test('state snapshot never includes encryption keys or RC credentials',t=>{
  const {m}=setup(t);m.secrets.disks.x={secret:'TOPSECRET'};m.runtime.set('unused',{rcPass:'PASSWORD'});const s=JSON.stringify(m.snapshot());assert.ok(!s.includes('TOPSECRET'));assert.ok(!s.includes('PASSWORD'));assert.ok(!s.includes(m.secrets.configPass));
});

test('Baidu availability needs both application credentials and supports both disk modes',async t=>{
  const {base}=setup(t);
  const m=new Manager({root:path.join(base,'state'),engines:base,providerConfig:{enabledProviders:['local','baidu']},oauthClients:{baidu:{clientId:'PRIVATE_APP'}},protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});
  assert.equal(m.snapshot().services.find(s=>s.id==='baidu').available,false);
  m.oauthClients.baidu.clientSecret='PRIVATE_SECRET';
  assert.equal(m.snapshot().services.find(s=>s.id==='baidu').available,true);
  assert.doesNotMatch(JSON.stringify(m.snapshot()),/PRIVATE_/);
  m.state.connections.push({id:'baidu',type:'baidu',name:'百度网盘',source:'test:'});
  const volume=await m.addDisk({connectionId:'baidu',name:'卷',mode:'juicefs',letter:'Y:',cacheGiB:10});
  assert.equal(m.disk(volume).mode,'juicefs');
  const id=await m.addDisk({connectionId:'baidu',name:'百度网盘',mode:'direct',letter:'Z:',cacheGiB:10});
  assert.equal(m.disk(id).mode,'direct');
});
test('dirty cache metadata scan includes open dirty files and fails closed on malformed data',async t=>{
  const {m,base}=setup(t);const dir=path.join(base,'vfsMeta');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'dirty'),JSON.stringify({Dirty:true}));fs.writeFileSync(path.join(dir,'clean'),JSON.stringify({Dirty:false}));assert.equal(await m.dirtyMetadata(dir),1);fs.writeFileSync(path.join(dir,'bad'),'{');await assert.rejects(()=>m.dirtyMetadata(dir));
});
test('disk edits, removal, and duplicate actions are blocked while running',async t=>{
  const {m,base}=setup(t);const c=await m.addLocal({name:'本地',path:base});const id=await m.addDisk({connectionId:c,name:'卷',mode:'direct',letter:'X:',cacheGiB:10});m.runtime.set(id,{status:'mounted'});
  await assert.rejects(()=>m.removeDisk(id));await assert.rejects(()=>m.updateDisk(id,{cacheGiB:2}));m.busy.add(id);await assert.rejects(()=>m.locked(id,async()=>{}));
});
test('frontend markup injection remains escaped, CSP blocks remote code',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8');assert.ok(html.includes("script-src 'self'"));assert.ok(html.includes("connect-src 'none'"));
  const main=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');assert.ok(main.includes('nodeIntegration: false'));assert.ok(main.includes('sandbox: true'));assert.ok(main.includes('senderFrame !== win.webContents.mainFrame'));
});
test('disk rename persists without replacing disk identity, source or cached data',async t=>{
  const {m,base}=setup(t);const c=await m.addLocal({name:'本地',path:base});const id=await m.addDisk({connectionId:c,name:'旧名称',mode:'direct',letter:'X:',cacheGiB:10});
  const before={...m.disk(id)},p=m.paths(before);fs.writeFileSync(path.join(p.cache,'pending'),'preserve me');
  await m.updateDisk(id,{name:'  工作资料  ',cacheGiB:20,autoMount:true});
  assert.deepEqual(m.disk(id),{...before,name:'工作资料',cacheGiB:20,autoMount:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file,'utf8')).disks[0],m.disk(id));
  assert.deepEqual(m.paths(m.disk(id)),p);assert.equal(fs.readFileSync(path.join(p.cache,'pending'),'utf8'),'preserve me');
  const saved=fs.readFileSync(m.file,'utf8');
  for(const input of [{name:''},{name:' '.repeat(3)},{name:'x'.repeat(49)},{name:'不应保存',cacheGiB:0,autoMount:false}]){
    await assert.rejects(()=>m.updateDisk(id,input));assert.equal(m.disk(id).name,'工作资料');assert.equal(m.disk(id).autoMount,true);assert.equal(fs.readFileSync(m.file,'utf8'),saved);
  }
  m.busy.add(id);await assert.rejects(()=>m.updateDisk(id,{name:'处理中'}),/上一个操作/);m.busy.delete(id);
  m.runtime.set(id,{status:'mounted'});await assert.rejects(()=>m.updateDisk(id,{name:'运行中'}),/先卸载/);
  assert.equal(m.disk(id).name,'工作资料');
});

test('volume cache settings persist across reload and preserve metadata and cached data',async t=>{
  const {m,base}=setup(t);const connectionId=await m.addLocal({name:'本地',path:base});
  const id=await m.addDisk({connectionId,name:'卷',mode:'juicefs',letter:'X:',cacheGiB:10});
  const d=m.disk(id),p=m.paths(d);assert.equal(d.writeback,true);
  fs.writeFileSync(p.meta,'metadata');fs.writeFileSync(path.join(p.cache,'read-cache'),'cached bytes');
  await m.updateDisk(id,{writeback:false,cacheGiB:20});
  const restored=new Manager({root:m.root,engines:m.engines,providerConfig:{enabledProviders:['local']},protect:m.protect,unprotect:m.unprotect});
  assert.equal(restored.disk(id).writeback,false);assert.equal(restored.disk(id).cacheGiB,20);
  await restored.updateDisk(id,{name:'改名'});assert.equal(restored.disk(id).writeback,false);
  await restored.updateDisk(id,{writeback:true});assert.equal(restored.disk(id).writeback,true);
  assert.deepEqual(restored.paths(restored.disk(id)),p);
  assert.equal(fs.readFileSync(p.meta,'utf8'),'metadata');assert.equal(fs.readFileSync(path.join(p.cache,'read-cache'),'utf8'),'cached bytes');
  restored.runtime.set(id,{status:'mounted'});
  await assert.rejects(restored.updateDisk(id,{writeback:false}),/先卸载/);
  assert.equal(restored.disk(id).writeback,true);
});

test('turning off writeback refuses leftover staging data without partially saving settings',async t=>{
  const {m,base}=setup(t);const connectionId=await m.addLocal({name:'本地',path:base});
  const id=await m.addDisk({connectionId,name:'卷',mode:'juicefs',letter:'X:',cacheGiB:10});
  const staging=path.join(m.paths(m.disk(id)).cache,'volume-uuid','rawstaging','chunks','0','0');
  fs.mkdirSync(staging,{recursive:true});const pending=path.join(staging,'1_0_100');fs.writeFileSync(pending,'pending bytes');
  const saved=fs.readFileSync(m.file,'utf8');
  await assert.rejects(m.updateDisk(id,{writeback:false,cacheGiB:20,name:'不应保存'}),/仍有待上传数据/);
  assert.equal(fs.readFileSync(m.file,'utf8'),saved);assert.equal(m.disk(id).cacheGiB,10);
  assert.equal(fs.readFileSync(pending,'utf8'),'pending bytes');
  fs.unlinkSync(pending);await m.updateDisk(id,{writeback:false});assert.equal(m.disk(id).writeback,false);
});

test('unreadable staging prevents disabling writeback and invalid values never change saved state',async t=>{
  const {m,base}=setup(t);const connectionId=await m.addLocal({name:'本地',path:base});
  const id=await m.addDisk({connectionId,name:'卷',mode:'juicefs',letter:'X:',cacheGiB:10});
  const saved=fs.readFileSync(m.file,'utf8');
  await assert.rejects(m.updateDisk(id,{writeback:'false'}),/暂存设置/);
  t.mock.method(fs.promises,'readdir',async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});});
  await assert.rejects(m.updateDisk(id,{writeback:false}),/无法确认/);
  assert.equal(m.disk(id).writeback,true);assert.equal(fs.readFileSync(m.file,'utf8'),saved);
});
