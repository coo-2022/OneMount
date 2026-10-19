'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {transferRates,sample,History}=require('../src/telemetry.cjs');
const {Manager}=require('../src/manager.cjs');
const disks=[{id:'a',connectionId:'c',mode:'direct'},{id:'b',connectionId:'c',mode:'direct'}];
const runtime=now=>new Map([['a',{status:'mounted',stats:{known:true,checkedAt:now,uploadSpeed:10,downloadSpeed:5,speed:15}}],['b',{status:'mounted',stats:{known:true,checkedAt:now,uploadSpeed:20,downloadSpeed:7,speed:27}}]]);
test('current rates split upload/download and discard stale global averages',()=>{
  assert.deepEqual(transferRates({speed:5000,transferring:[]},[]),{totalSpeed:0,uploadSpeed:0,downloadSpeed:0});
  const core={transferring:[{name:'up',speedAvg:20,speed:100},{name:'down',speedAvg:80},{name:'stalled',speedAvg:0,speed:300}]};
  assert.deepEqual(transferRates(core,[{name:'up',uploading:true}]),{totalSpeed:100,uploadSpeed:20,downloadSpeed:80});
  assert.equal(transferRates(core).uploadSpeed,null);
});
test('aggregate multiple mounts, keep failures unknown, and zero only when unmounted',()=>{
  const r=runtime(1000);assert.equal(sample('c',disks,r,1000).upload,30);assert.equal(sample('c',disks,r,1000).download,12);
  r.get('a').stats.known=false;assert.equal(sample('c',disks,r,1000).upload,null);
  r.get('a').stats.known=true;assert.equal(sample('c',disks,r,11001).known,false);
  r.delete('a');r.delete('b');assert.equal(sample('c',disks,r,12000).total,0);
  const mixed=[...disks,{id:'j',connectionId:'c',mode:'juicefs'}];r.set('j',{status:'mounted',stats:{known:true,checkedAt:12000,speed:90}});
  assert.equal(sample('c',mixed,r,12000).upload,null);assert.equal(sample('c',mixed,r,12000).total,90);
});
test('history retains five minutes, records unknown gaps, removes deleted connections',()=>{
  const h=new History();for(let time=0;time<=600000;time+=3000)h.record([{id:'c'}],disks,runtime(time),time);
  assert.equal(h.get('c').length,101);assert.equal(h.get('c')[0].time,300000);
  const r=runtime(603000);r.get('a').status='error';h.record([{id:'c'}],disks,r,603000);assert.equal(h.get('c').at(-1).upload,null);
  h.record([{id:'c'}],disks,new Map(),606000);assert.equal(h.get('c').at(-1).upload,0);
  h.record([],disks,r,609000);assert.deepEqual(h.get('c'),[]);
});
test('renaming persists without changing remote identity and rejects invalid names',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-rename-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={root,engines:root,providerConfig:{enabledProviders:[]},protect:s=>s,unprotect:s=>s};const m=new Manager(options);
  m.state.connections.push({id:'c',name:'Old',type:'drive',remote:'remote-id',source:'remote-id:folder'});
  m.renameConnection('c',' 新名称 ');assert.equal(m.connection('c').name,'新名称');
  assert.throws(()=>m.renameConnection('c',' '));assert.throws(()=>m.renameConnection('c','x'.repeat(49)));assert.throws(()=>m.renameConnection('missing','ok'));
  const next=new Manager(options);assert.equal(next.connection('c').source,'remote-id:folder');assert.equal(next.connection('c').name,'新名称');
});
test('background polling records idle connections without mounts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const m=new Manager({root,engines:root,providerConfig:{enabledProviders:['local']},protect:s=>s,unprotect:s=>s});m.state.connections.push({id:'c',name:'Idle',type:'local',source:root});
  await m.poll();const p=m.snapshot().connections[0].performance;assert.equal(p.history.length,1);assert.equal(p.total,0);assert.equal(p.known,true);
});
