'use strict';
// Opt-in upstream conformance run through the real Manager/WinFsp/S3 path.
// Run using Electron. Cloud profiles and raw logs stay under ignored test-results.
const {app,safeStorage}=require('electron');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');
const providerConfig=require('./cloud-test-providers.cjs').juicefsUpstreamProviders();
const repo=path.resolve(__dirname,'..'),manifest=require('./juicefs-upstream-tests.json');
const tools=path.join(repo,manifest.directory);
const python=process.env.ONEMOUNT_TEST_PYTHON;
assert.equal(process.platform,'win32');assert.ok(python&&fs.existsSync(python),'ONEMOUNT_TEST_PYTHON required');
const hashes=Object.fromEntries(manifest.files.map(f=>[f.name,f.sha256]));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
for(const [name,expected] of Object.entries(hashes))assert.equal(hash(fs.readFileSync(path.join(tools,name))),expected,name+' changed');
const profile=fs.mkdtempSync(path.join(repo,'test-results/juicefs-upstream-run-'));
const original=process.env.ONEMOUNT_LIVE_PROFILE;
if(original)for(const file of ['Local State','credentials.json','accounts.conf'])fs.copyFileSync(path.join(original,file),path.join(profile,file));
app.setPath('userData',profile);
const report={started:new Date().toISOString(),upstreamCommit:manifest.commit,
  platform:process.platform,profile,coordinatorPid:process.pid,toolHashes:hashes,runnerSha256:hash(fs.readFileSync(__filename)),results:[]};
const save=()=>fs.writeFileSync(path.join(profile,'report.json'),JSON.stringify(report,null,2));
let m;
const manager=()=>{
  const instance=new Manager({root:profile,engines:path.join(repo,'engines'),providerConfig,
    protect:s=>safeStorage.encryptString(s).toString('base64'),unprotect:s=>safeStorage.decryptString(Buffer.from(s,'base64'))});
  if(process.env.ONEMOUNT_UPSTREAM_DEBUG==='1'){
    const spawn=instance.spawn.bind(instance);
    instance.spawn=(id,name,args,...rest)=>spawn(id,name,
      name==='rclone'?args.map((a,i)=>args[i-1]==='--log-level'?'DEBUG':a):args,...rest);
  }
  return instance;
};
async function command(entry,name,exe,args,{cwd,env={},timeout=600000,quiet=false}={}) {
  const item={name,started:new Date().toISOString(),args};entry.tests.push(item);
  if(!quiet)console.log(entry.type,entry.writeback?'background':'foreground',name);
  const log=path.join(profile,entry.volumeId+'-'+name+'.log');item.log=path.basename(log);save();
  await new Promise(resolve=>{
    const fd=fs.openSync(log,'w');
    const child=spawn(exe,args,{cwd,env:P.cleanEnv(env),windowsHide:true,stdio:['ignore',fd,fd]});
    item.pid=child.pid;save();
    fs.closeSync(fd);
    let settled=false,exitDeadline;
    const finish=code=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(exitDeadline);
      item.exitCode=code;item.passed=code===0&&!item.timedOut&&!item.error;resolve();};
    const timer=setTimeout(()=>{
      item.timedOut=true;item.timeoutAt=new Date().toISOString();save();child.kill();
      // Pending Windows filesystem IO can delay process termination. Stop this
      // suite after a bounded grace period instead of launching more cases.
      exitDeadline=setTimeout(()=>{item.processStillRunning=P.alive(child.pid);finish(null);},30000);
    },timeout);
    child.once('error',e=>{item.error=e.code||e.name;finish(null);});
    child.once('close',finish);
  });
  item.finished=new Date().toISOString();save();
  if(item.processStillRunning)throw new Error('Timed-out test process still has pending IO; remaining cases are not run.');
  return item;
}
async function drainAndUnmount(id) {
  // Large upstream suites create hundreds of small objects. Wait for staging
  // to drain before exercising the application's bounded flush/unmount.
  if(m.disk(id).writeback){let zero=0;
    await P.waitFor(async()=>{await m.poll();const s=m.runtime.get(id)?.stats;
      zero=s?.known&&s.pendingBlocks===0&&s.pendingBytes===0?zero+1:0;
      if(zero<3){await P.delay(1000);return false;}return true;
    },15*60*1000);
  }
  await m.unmount(id);
}
async function coldRestart(id,round) {
  const d=m.disk(id),cache=m.paths(d).cache;
  await drainAndUnmount(id);assert.equal(m.runtime.has(id),false);assert.equal(fs.existsSync(d.letter+'\\'),false);
  const relative=path.relative(profile,cache);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await fsp.rename(cache,cache+'-upstream-'+round);
  await m.shutdown();m=manager();await m.init();await m.mount(id);
}
async function exercise(c,writeback) {
  const requested=process.env.ONEMOUNT_TEST_LETTER?.replace(/:$/,'').toUpperCase();
  if(requested)assert.match(requested,/^[D-Z]$/,'valid test drive letter required');
  const free=requested||[...'QRSTUVWY'].find(letter=>!fs.existsSync(letter+':\\'));
  assert.ok(free&&!fs.existsSync(free+':\\'),'free test drive required');
  const letter=free+':',drive=letter+'\\',entry={type:c.type,writeback,tests:[],started:new Date().toISOString()};
  report.results.push(entry);entry.stage='create';save();
  const id=await m.addDisk({connectionId:c.id,name:'Upstream '+c.type,mode:'juicefs',letter,cacheGiB:1,writeback});
  entry.volumeId=id;entry.stage='mount';save();await m.mount(id);
  entry.mountArguments=m.runtime.get(id)?.jfs?.spawnargs?.slice(1);save();
  // Test root is owned by this fresh UUID, never an existing connection mount.
  const root=path.join(drive,'onemount-upstream-'+id);await fsp.mkdir(root);await fsp.writeFile(path.join(root,'owner.txt'),id);
  entry.stage='official test suites';save();
  const basic=await command(entry,'windows-python',python,[path.join(repo,'scripts/run-juicefs-windows-unittest.py'),
    path.join(tools,'wins_fs_test.py'),root,path.join(profile,id+'-python.json'),id],{env:{PYTHONUTF8:'1'}});
  const basicFile=path.join(profile,id+'-python.json');if(fs.existsSync(basicFile))basic.summary=JSON.parse(fs.readFileSync(basicFile,'utf8'));
  const tapRoot=path.join(root,'winfstest');await fsp.mkdir(tapRoot);
  const extracted=fs.readFileSync(path.join(tools,'winfstest-directory.txt'),'utf8').trim();
  assert.match(extracted,/^winfstest-[a-f0-9]{32}$/,'run fetch-juicefs-tests.ps1 first');
  const suite=path.join(tools,extracted,'TestSuite');
  const tap=await command(entry,'winfstest',python,[path.join(suite,'simpletap.py'),path.join(suite,'t'),tapRoot],
    {cwd:tapRoot,env:{PYTHONPATH:suite,PYTHONUTF8:'1'}});
  const tapLog=fs.readFileSync(path.join(profile,tap.log),'utf8');tap.summary=tapLog.split(/\r?\n/).find(l=>/^total\s/.test(l))||null;
  const nativeRoot=path.join(root,'winfsp');await fsp.mkdir(nativeRoot);
  const pathKey=Object.keys(process.env).find(k=>k.toLowerCase()==='path')||'Path';
  const winfspBin=path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','WinFsp/bin');
  const nativeEnv={[pathKey]:winfspBin+path.delimiter+process.env[pathKey]};
  const nativeExe=path.join(tools,'winfsp-tests-x64.exe');
  const nativeArgs=['--fuse-external','--resilient','--case-insensitive-cmp'];
  const catalog=await P.run(nativeExe,[...nativeArgs,'--list'],{cwd:profile,env:nativeEnv});
  const names=catalog.split(/\r?\n/).filter(n=>/^[a-z0-9_]+_test$/.test(n));assert.equal(names.length,54,'upstream Windows catalog');
  const native={name:'winfsp',catalog:names,cases:[],started:new Date().toISOString()};entry.tests.push(native);save();
  console.log(c.type,writeback?'background':'foreground','winfsp: '+names.length+' cases');
  for(const name of names){
    const cwd=path.join(nativeRoot,name);await fsp.mkdir(cwd);
    const result=await command({...entry,tests:native.cases},'winfsp-'+name,nativeExe,[...nativeArgs,'+'+name],
      {cwd,env:nativeEnv,timeout:90000,quiet:true});
    const output=fs.readFileSync(path.join(profile,result.log),'utf8');
    result.passed&&=output.includes('--- COMPLETE ---')&&/\bOK [\d.]+s/.test(output);
    result.failure=output.split(/\r?\n/).filter(l=>/ASSERT|EXCEPTION|\bKO\b/.test(l));
    if(!result.passed)console.log(c.type,writeback?'background':'foreground','FAIL',name);
  }
  native.passed=native.cases.every(t=>t.passed);native.finished=new Date().toISOString();
  native.summary={passed:native.cases.filter(t=>t.passed).length,failed:native.cases.filter(t=>!t.passed).length};save();
  const fsxRoot=path.join(root,'fsx');await fsp.mkdir(fsxRoot);
  const operations=process.env.ONEMOUNT_FSX_OPS||(writeback?'200':null);
  if(operations)assert.match(operations,/^[1-9][0-9]*$/);
  // Upstream CI uses synchronous writes and a 180-second FSX exercise.
  // The extra writeback variant is bounded to avoid queuing hours of cloud
  // uploads; it is recorded as supplementary coverage, not the CI workload.
  const fsxArgs=operations?['-N',operations,'-S','20261014','-p','100']:['-d','180','-S','20261014','-p','10000'];
  const fsx=await command(entry,'fsx',path.join(tools,'fsx-x64.exe'),[...fsxArgs,'-F','100000','fsxtest'],{cwd:fsxRoot});
  const fsxLog=fs.readFileSync(path.join(profile,fsx.log),'utf8');
  const completed=fsxLog.match(/All operations - (\d+) - completed A-OK!/);fsx.completed=!!completed;
  fsx.operations=completed?Number(completed[1]):null;fsx.passed&&=fsx.completed;
  save();
  // A terminated mmap workload is not a completed FSX output. Preserve the
  // failure and safely shut down before attempting any new writes/snapshots.
  if(!fsx.passed)throw new Error('FSX did not complete; cold verification is not run for an interrupted workload.');
  entry.stage='flush and cold restart';save();console.log(c.type,writeback?'background':'foreground',entry.stage);
  // Preserve the exact FSX output plus a cross-block random canary for cold reads.
  const canary=crypto.randomBytes(4*1024*1024+137),canaryPath=path.join(root,'cold-canary.bin');await fsp.writeFile(canaryPath,canary);
  const expected=new Map([[canaryPath,hash(canary)]]);
  const fsxPath=path.join(fsxRoot,'fsxtest');if(fs.existsSync(fsxPath))expected.set(fsxPath,hash(await fsp.readFile(fsxPath)));
  await coldRestart(id,1);
  for(const [file,digest] of expected)assert.equal(hash(await fsp.readFile(file)),digest,'cold read '+path.basename(file));
  entry.coldReadPassed=true;
  // Safe flush before fsck, then remount with a new empty cache. The gateway is
  // live for fsck; neither repair nor garbage collection is requested.
  const check=await command(entry,'fsck',path.join(repo,'engines/juicefs.exe'),['fsck','sqlite3://meta.db'],
    {cwd:m.paths(m.disk(id)).dir,timeout:600000});
  entry.fsckPassed=check.passed;entry.stage='safe unmount';save();await drainAndUnmount(id);
  assert.equal(m.runtime.has(id),false);assert.equal(fs.existsSync(drive),false);entry.safelyUnmounted=true;
  entry.passed=entry.tests.every(t=>t.passed)&&entry.coldReadPassed;entry.finished=new Date().toISOString();entry.stage='finished';save();
  await m.removeDisk(id);
}
app.whenReady().then(async()=>{
  report.engine={version:(await P.run(path.join(repo,'engines/juicefs.exe'),['version'])).trim(),
    sha256:hash(fs.readFileSync(path.join(repo,'engines/juicefs.exe'))),
    rcloneSha256:hash(fs.readFileSync(path.join(repo,'engines/rclone.exe')))};
  assert.match(report.engine.version,/1\.3\.0\+2025-07-03\.30190ca/,'tests must match the bundled JuiceFS engine');save();
  if(original){const state=JSON.parse(fs.readFileSync(path.join(original,'disks.json'),'utf8'));
    fs.writeFileSync(path.join(profile,'disks.json'),JSON.stringify({...state,disks:[],settings:{...state.settings,loginStart:false}}));}
  m=manager();await m.init();assert.ok(m.health.winfsp,'WinFsp required');
  const modes=(process.env.ONEMOUNT_LIVE_WRITEBACK||'0,1').split(',');
  for(const type of providerConfig.enabledProviders){let c;
    if(type==='local'){const backend=await fsp.mkdtemp(path.join(repo,'test-results/juicefs-upstream-backend-'));const id=await m.addLocal({name:'Upstream local control',path:backend});c=m.connection(id);}
    else c=m.state.connections.find(c=>c.type===type);
    assert.ok(c,'signed-in '+type+' connection required');for(const mode of modes)await exercise(c,mode==='1');
  }
  report.passed=report.results.every(r=>r.passed);if(!report.passed)process.exitCode=1;
}).catch(e=>{report.passed=false;report.failure={stage:report.results.at(-1)?.stage,code:e.code||e.name};
  fs.writeFileSync(path.join(profile,'failure-private.log'),e.stack||String(e));console.error('Upstream run stopped:',report.failure);process.exitCode=1;
}).finally(async()=>{
  try{await m?.shutdown();}catch{report.sessionsRetained=true;process.exitCode=1;}
  report.finished=new Date().toISOString();save();console.log('Report:',path.join(profile,'report.json'));
  if(!report.sessionsRetained)app.exit(process.exitCode||0);
});
