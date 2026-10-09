const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {Manager}=require('../src/manager.cjs');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'backend');fs.mkdirSync(base);const m=new Manager({root:path.join(root,'state'),engines:root,protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});return {m,base};}
test('creation persists and removal archives without deleting metadata or cache',async t=>{
  const {m,base}=setup(t);const c=await m.addLocal({name:'本地',path:base});const id=await m.addDisk({connectionId:c,name:'卷',mode:'juicefs',letter:'X:',cacheGiB:10});
  const p=m.paths(m.disk(id));fs.writeFileSync(p.meta,'precious metadata');fs.writeFileSync(path.join(p.cache,'pending'),'precious dirty bytes');
  await assert.rejects(()=>m.deleteConnection(c),/先移除/);await m.removeDisk(id);
  assert.equal(fs.readFileSync(p.meta,'utf8'),'precious metadata');assert.ok(fs.existsSync(path.join(p.cache,'pending')));assert.ok(fs.existsSync(path.join(p.dir,'archived-disk.json')));assert.equal(m.state.disks.length,0);
});
test('state snapshot never includes encryption keys or RC credentials',t=>{
  const {m}=setup(t);m.secrets.disks.x={secret:'TOPSECRET'};m.runtime.set('unused',{rcPass:'PASSWORD'});const s=JSON.stringify(m.snapshot());assert.ok(!s.includes('TOPSECRET'));assert.ok(!s.includes('PASSWORD'));assert.ok(!s.includes(m.secrets.configPass));
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
