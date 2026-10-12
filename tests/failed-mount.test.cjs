'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/processes.cjs');
const {Manager} = require('../src/manager.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ci-failed-mount-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const m = new Manager({root,engines:root,protect:s=>s,unprotect:s=>s});
  const d = {id:'disk',name:'Drive',letter:path.join(root,'drive'),mode:'direct',lastError:'timeout'};
  const r = {proc:{pid:123},status:'error',everMounted:false};
  m.state.disks.push(d); m.runtime.set(d.id,r);
  const calls = [], values = {'vfs/list':{vfses:[]},'core/stats':{bytes:0,transfers:0}};
  t.mock.method(P,'alive',()=>true);
  t.mock.method(P,'waitExit',async()=>{});
  t.mock.method(P,'rc',async(_r,method)=>{calls.push(method); if(method==='mount/listmounts') throw Error('timeout'); if(values[method] instanceof Error) throw values[method]; return values[method] || {};});
  return {m,d,r,calls,values};
}

test('failed startup can safely exit despite mount-list lock; clean cache is retained',async t=>{
  const {m,d,calls}=setup(t), p=m.paths(d);
  fs.mkdirSync(path.join(p.cache,'vfsMeta'),{recursive:true});
  fs.writeFileSync(path.join(p.cache,'vfsMeta','clean'),JSON.stringify({Dirty:false}));
  await m.shutdown();
  assert.ok(calls.includes('core/quit')); assert.ok(!calls.includes('mount/listmounts'));
  assert.equal(m.runtime.size,0); assert.equal(d.lastError,'');
  assert.ok(fs.existsSync(path.join(p.cache,'vfsMeta','clean')));
});

test('active or uncertain startup state never enables the cleanup shortcut',async t=>{
  for (const kind of ['vfs','transfer','dirty','malformed-cache','missing-vfs','missing-stats','unreachable','mounted-before','unknown-history','drive-present']) await t.test(kind,async t=>{
    const {m,d,r,calls,values}=setup(t);
    if(kind==='vfs')values['vfs/list']={vfses:['remote:']};
    if(kind==='transfer')values['core/stats'].transferring=[{name:'pending'}];
    if(kind==='dirty'||kind==='malformed-cache'){
      const dir=path.join(m.paths(d).cache,'vfsMeta');fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,'pending'),kind==='dirty'?JSON.stringify({Dirty:true}):'{');
    }
    if(kind==='missing-vfs')values['vfs/list']={};
    if(kind==='missing-stats')values['core/stats']={};
    if(kind==='unreachable')values['vfs/list']=Error('offline');
    if(kind==='mounted-before')r.everMounted=true;
    if(kind==='unknown-history')delete r.everMounted;
    if(kind==='drive-present')fs.mkdirSync(d.letter+'\\');
    await assert.rejects(()=>m.shutdown());
    assert.ok(!calls.includes('core/quit')); assert.equal(m.runtime.get(d.id),r);
  });
});

test('unconfirmed engine exit keeps its session and caches for retry',async t=>{
  const {m,d,r}=setup(t);
  t.mock.method(P,'waitExit',async()=>{throw Error('still running');});
  await assert.rejects(()=>m.shutdown(),/still running/);
  assert.equal(m.runtime.get(d.id),r); assert.equal(r.status,'error');
});

test('failed startup polling does not repeatedly request nonexistent VFS statistics',async t=>{
  const {m,r,calls}=setup(t);await m.poll();assert.deepEqual(calls,[]);assert.equal(r.stats.known,false);
});
