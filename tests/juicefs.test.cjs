'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-volume-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const m=new Manager({root,engines:root,protect:s=>s,unprotect:s=>s});
  const c={id:'cloud',type:'baidu',source:'cloud:chosen/中文',name:'Cloud'};
  m.state.connections.push(c);
  const id=await m.addDisk({connectionId:c.id,name:'Volume',mode:'juicefs',letter:'Q:',cacheGiB:1});
  const d=m.disk(id),p=m.paths(d);d.gatewayPort=12345;
  const setting={Name:'ci'+id.replaceAll('-','').slice(0,20),Storage:'s3',Bucket:'http://127.0.0.1:12345/jfs',UUID:'test-uuid'};
  const calls=[];
  t.mock.method(P,'run',async(_file,args)=>{
    calls.push(args);
    if(args[0]==='format')if(!fs.existsSync(p.meta))fs.writeFileSync(p.meta,'metadata');
    return JSON.stringify({Setting:setting});
  });
  return {m,c,d,p,setting,calls};
}

test('prepare cloud volume creates ancestors inside the selected root, never on remount',async t=>{
  const {m,c,d}=await fixture(t);const calls=[];
  t.mock.method(m,'accounts',async()=>({}));
  t.mock.method(P,'rc',async(_r,method,body)=>calls.push({method,body}));
  await m.prepareVolumeBackend(d,c);
  assert.deepEqual(calls,[{method:'operations/mkdir',body:{fs:c.source,remote:'.cloud-island/'+d.id}}]);
  d.initialized=true;await m.prepareVolumeBackend(d,c);assert.equal(calls.length,1);
  await assert.rejects(m.prepareVolumeBackend({...d,id:'../outside',initialized:false},c));assert.equal(calls.length,1);
});

test('format failure retains metadata and WAL; retry validates without replacing files',async t=>{
  const {m,d,p,setting,calls}=await fixture(t);let offline=true;
  t.mock.method(P,'run',async(_file,args)=>{
    calls.push(args);
    if(args[0]==='format'){
      assert.ok(args.includes('--no-update'));assert.ok(!args.includes('--force'));
      if(!fs.existsSync(p.meta))fs.writeFileSync(p.meta,'metadata');
      if(offline)throw Error('network unavailable');
    }
    return JSON.stringify({Setting:setting});
  });
  await assert.rejects(m.initializeVolume(d,{}),/network/);
  assert.equal(d.initialized,false);assert.equal(d.initializing,true);assert.equal(fs.existsSync(p.meta),true);
  fs.writeFileSync(p.meta+'-wal','uncheckpointed');
  assert.equal(JSON.parse(fs.readFileSync(m.file)).disks[0].initializing,true);
  offline=false;await m.initializeVolume(d,{});assert.equal(fs.readFileSync(p.meta+'-wal','utf8'),'uncheckpointed');
  assert.equal(fs.readFileSync(p.meta,'utf8'),'metadata');assert.equal(d.initialized,true);assert.equal(d.initializing,undefined);
  const before=calls.length;await m.initializeVolume(d,{});assert.equal(calls.length,before,'remount never formats');
});

test('crash after formatting can recover only a matching recorded initialization',async t=>{
  const {m,d,p,calls}=await fixture(t);fs.writeFileSync(p.meta,'precious metadata');
  await assert.rejects(m.initializeVolume(d,{}),/初始化记录不完整/);assert.equal(calls.length,0);
  d.initializing=true;await m.initializeVolume(d,{});
  assert.equal(calls[0][0],'format');assert.ok(calls[0].includes('--no-update'));assert.deepEqual(calls[1],['status','sqlite3://meta.db']);assert.equal(d.initialized,true);
  assert.equal(fs.readFileSync(p.meta,'utf8'),'precious metadata');
});

test('wrong volume metadata never enables a mount',async t=>{
  for(const kind of ['name','bucket','storage'])await t.test(kind,async t=>{
    const {m,d,p,setting}=await fixture(t);
    if(kind==='name')setting.Name='different';
    if(kind==='bucket')setting.Bucket='http://127.0.0.1:54321/jfs';
    if(kind==='storage')setting.Storage='file';
    await assert.rejects(m.initializeVolume(d,{}));assert.equal(d.initialized,false);assert.equal(fs.existsSync(p.meta),true);
    assert.equal(fs.readFileSync(p.meta,'utf8'),'metadata');
  });
});

test('initialized volume with missing metadata refuses automatic formatting',async t=>{
  const {m,d,calls}=await fixture(t);d.initialized=true;
  await assert.rejects(m.initializeVolume(d,{}),/元数据文件丢失/);assert.equal(calls.length,0);
});

test('failed volume flush keeps gateway, session, metadata and pending cache',async t=>{
  const {m,d,p}=await fixture(t);const r={status:'mounted',proc:{pid:123},jfs:{pid:124}};m.runtime.set(d.id,r);
  fs.writeFileSync(p.meta,'metadata');fs.writeFileSync(path.join(p.cache,'pending'),'pending bytes');
  t.mock.method(P,'alive',()=>true);t.mock.method(P,'run',async()=>{throw Error('flush failed');});
  const quit=t.mock.method(P,'rc',async()=>{throw Error('gateway must stay alive');});
  await assert.rejects(m.unmount(d.id),/flush failed/);
  assert.equal(quit.mock.callCount(),0);assert.equal(m.runtime.get(d.id),r);assert.equal(r.status,'error');
  assert.equal(fs.readFileSync(p.meta,'utf8'),'metadata');assert.equal(fs.readFileSync(path.join(p.cache,'pending'),'utf8'),'pending bytes');
});

test('failure preparing a cloud root leaves no phantom session and allows safe exit',async t=>{
  const {m,d}=await fixture(t);m.platform='win32';m.health.winfsp=true;
  const exists=fs.existsSync;t.mock.method(fs,'existsSync',p=>p===d.letter+'\\'?false:exists(p));
  t.mock.method(P,'freePort',async()=>12345);
  t.mock.method(m,'prepareVolumeBackend',async()=>{throw Error('cloud unavailable');});
  const spawn=t.mock.method(m,'spawn',()=>{throw Error('must not start a gateway');});
  const rc=t.mock.method(P,'rc',async()=>{throw Error('no process exists');});
  await assert.rejects(m.mount(d.id),/cloud unavailable/);
  assert.equal(m.runtime.size,0);assert.equal(m.busy.size,0);assert.equal(spawn.mock.callCount(),0);assert.equal(rc.mock.callCount(),0);
  await m.shutdown();
});
