const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/plans.cjs');
const d = {id: 'bb621c14-0870-4dd8-89af-83bf3ce17dca', name: '资料', letter: 'X:', mode: 'juicefs', cacheGiB: 10, writeback: false};
test('drive input and duplicates rejected', () => {
  assert.equal(p.validateDisk(d, []).letter, 'X:');
  for (const patch of [{letter:'C:'},{letter:'X: & cmd.exe'},{cacheGiB:0},{cacheGiB:NaN},{mode:'shell'},{name:''}]) assert.throws(()=>p.validateDisk({...d,...patch},[]));
  assert.throws(()=>p.validateDisk(d,[d]));
});
test('each volume gets an isolated backend prefix',()=>{
  assert.equal(p.backendRoot({type:'s3',source:'cloud:bucket'},d.id),`cloud:bucket/.cloud-island/${d.id}`);
  assert.equal(p.backendRoot({type:'webdav',source:'cloud:'},d.id),`cloud:.cloud-island/${d.id}`);
  assert.throws(()=>p.backendRoot({type:'local',source:'/tmp'},'../delete'));
});
test('S3 gateway is local and never has an asynchronous VFS write cache',()=>{
  const a=p.gatewayArgs('/tmp/a b',1234,4567,'/tmp/cache','/tmp/cfg');
  assert.equal(a[a.indexOf('--addr')+1],'127.0.0.1:1234');
  assert.equal(a[a.indexOf('--vfs-cache-mode')+1],'off');
  assert.ok(!a.includes('--auth-key'));
});
test('Windows ownership maps root to the current SID without a fixed user SID',()=>{
  const a=p.juiceMountArgs(d,{cache:'C:\\cache'},1234,'S-1-5-21-1-2-3-1001');
  assert.ok(a.includes('--no-usage-report'));assert.ok(a.includes('--as-root'));
  assert.ok(!a.includes('--umask'), 'Windows JuiceFS rejects the Unix-only umask flag');
  assert.equal(a[a.indexOf('-o')+1],'uid=0,gid=0,uidmap=0:S-1-5-21-1-2-3-1001');
  assert.ok(!a.includes('--writeback'));assert.ok(p.juiceMountArgs({...d,writeback:true},{cache:'C:\\cache'},1234,'S-1-5-21-2').includes('--writeback'));
  assert.throws(()=>p.juiceMountArgs(d,{cache:''},1234,'evil,allow_other'));
  assert.ok(p.formatArgs(1234,'test').includes('--no-update'));
});
test('direct mount uses full cache and the actual typed RC units',()=>{
  const b=p.directMountBody(d,{source:'drive:'});assert.equal(b.vfsOpt.CacheMode,3);assert.equal(b.vfsOpt.WriteBack,5e9);assert.equal(b.mountType,'cmount');assert.equal(b.fs,'drive:');
});
test('missing metrics are unknown, not zero',()=>{
  assert.equal(p.parseMetrics('').pendingBlocks,null);
  const m=p.parseMetrics('# HELP ignored\njuicefs_staging_blocks{volume="x"} 2\njuicefs_staging_block_bytes{volume="x"} 4096\njuicefs_blockcache_bytes 123\n');
  assert.equal(m.pendingBlocks,2);assert.equal(m.pendingBytes,4096);assert.equal(m.cacheBytes,123);
});
test('unmount considers all queue and cache error indicators',()=>{
  assert.equal(p.pendingDirect(null,[]).known,false);
  assert.equal(p.pendingDirect({diskCache:{}},[]).pending,false);
  for(const diskCache of [{uploadsQueued:1},{uploadsInProgress:1},{erroredFiles:1}])assert.equal(p.pendingDirect({diskCache},[]).pending,true);
  assert.equal(p.pendingDirect({diskCache:{}},[{name:'x'}]).pending,true);
});
