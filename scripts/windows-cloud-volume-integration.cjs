'use strict';
// Opt-in live tests: run with Electron, ONEMOUNT_LIVE_PROFILE pointing at an
// existing signed-in CloudIsland profile. Credentials remain in an isolated,
// ignored test-results profile. Original disks, sessions and files are untouched.
const {app,safeStorage}=require('electron');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');
if(process.platform!=='win32'||!process.env.ONEMOUNT_LIVE_PROFILE)throw Error('Windows, WinFsp and ONEMOUNT_LIVE_PROFILE are required');
const repo=path.resolve(__dirname,'..'),original=path.resolve(process.env.ONEMOUNT_LIVE_PROFILE);
const results=path.join(repo,'test-results');fs.mkdirSync(results,{recursive:true});
const profile=fs.mkdtempSync(path.join(results,'cloud-volume-'));
for(const file of ['Local State','credentials.json','accounts.conf'])fs.copyFileSync(path.join(original,file),path.join(profile,file));
app.setPath('userData',profile);
const report={started:new Date().toISOString(),profile,results:[]};
const reportFile=path.join(profile,'report.json');
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const makeManager=()=>new Manager({root:profile,engines:path.join(repo,'engines'),
  protect:s=>safeStorage.encryptString(s).toString('base64'),unprotect:s=>safeStorage.decryptString(Buffer.from(s,'base64'))});
let m;
async function coldRestart(id,round) {
  const d=m.disk(id),cache=m.paths(d).cache;
  await m.unmount(id);assert.equal(m.runtime.has(id),false);assert.equal(fs.existsSync(d.letter+'\\'),false);
  // Keep the warm cache as evidence, and never move files outside this fixture.
  const relative=path.relative(profile,cache);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  await fsp.rename(cache,cache+'-verified-'+round);
  await m.shutdown();m=makeManager();await m.init();await m.mount(id);
}
async function exercise(c,writeback) {
  const free=[...'QRSTUVWYZ'].find(letter=>!fs.existsSync(letter+':\\'));
  assert.ok(free,'a free drive letter is required');const letter=free+':',base=letter+'\\';
  const entry={type:c.type,writeback,started:new Date().toISOString()};report.results.push(entry);
  const stage=value=>{entry.stage=value;save();console.log(c.type,writeback?'background':'foreground',value);};
  stage('create');
  const id=await m.addDisk({connectionId:c.id,name:'Volume validation '+c.type,mode:'juicefs',letter,cacheGiB:1,writeback});
  entry.volumeId=id;
  stage('mount');await m.mount(id);
  const port=m.disk(id).gatewayPort;
  assert.equal(m.disk(id).initialized,true);
  await m.poll();assert.equal(m.runtime.get(id).stats.known,true,'JuiceFS metrics must be readable');
  stage('write');
  const data=crypto.randomBytes(4*1024*1024+137),folder=path.join(base,'中文 空格');
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder,'blocks.bin'),data);
  await fsp.writeFile(path.join(base,'empty'),Buffer.alloc(0));
  await fsp.writeFile(path.join(base,'truncate.txt'),'to be truncated');
  await fsp.writeFile(path.join(base,'delete.txt'),'to be deleted');
  const sparse=await fsp.open(path.join(base,'sparse.bin'),'w');await sparse.truncate(1024*1024+17);await sparse.close();
  stage('flush and cold restart');await coldRestart(id,1);
  assert.equal(m.disk(id).gatewayPort,port,'object endpoint persists across app restart');
  assert.equal(hash(await fsp.readFile(path.join(folder,'blocks.bin'))),hash(data));
  assert.equal((await fsp.stat(path.join(base,'empty'))).size,0);
  assert.deepEqual(await fsp.readFile(path.join(base,'sparse.bin')),Buffer.alloc(1024*1024+17));
  stage('random write, append, rename, truncate, delete');
  const patch=crypto.randomBytes(8192),offset=1024*1024+333;
  const handle=await fsp.open(path.join(folder,'blocks.bin'),'r+');
  const written=await handle.write(patch,0,patch.length,offset);assert.equal(written.bytesWritten,patch.length);await handle.close();patch.copy(data,offset);
  const suffix=Buffer.from('appended after cold read');await fsp.appendFile(path.join(folder,'blocks.bin'),suffix);
  await fsp.rename(path.join(folder,'blocks.bin'),path.join(base,'renamed.bin'));
  await fsp.truncate(path.join(base,'truncate.txt'),0);await fsp.unlink(path.join(base,'delete.txt'));
  stage('second cold restart');await coldRestart(id,2);
  assert.equal(hash(await fsp.readFile(path.join(base,'renamed.bin'))),hash(Buffer.concat([data,suffix])));
  assert.equal((await fsp.stat(path.join(base,'truncate.txt'))).size,0);
  assert.equal(fs.existsSync(path.join(base,'delete.txt')),false);
  assert.equal(fs.existsSync(path.join(folder,'blocks.bin')),false);
  stage('safe unmount');await m.unmount(id);
  assert.equal(fs.existsSync(base),false);assert.equal(m.runtime.has(id),false);
  // Inspect only this run's UUID prefix, to prove data objects reached the cloud.
  const r=await m.accounts();const objects=await P.rc(r,'operations/list',{
    fs:c.source,remote:'.cloud-island/'+id,opt:{recurse:true,filesOnly:true}},120000);
  const blocks=(objects.list||[]).filter(o=>o.Path.includes('/chunks/')&&o.Size>0);
  assert.ok(blocks.length>=2,'remote contains actual JuiceFS data blocks');
  entry.remoteBlocks=blocks.length;entry.passed=true;entry.finished=new Date().toISOString();stage('passed');
  await m.removeDisk(id);
}
app.whenReady().then(async()=>{
  const state=JSON.parse(fs.readFileSync(path.join(original,'disks.json'),'utf8'));
  const types=(process.env.ONEMOUNT_LIVE_TYPES||'baidu,onedrive,drive').split(',');
  const connections=types.map(type=>{const c=state.connections.find(c=>c.type===type);assert.ok(c,'signed-in '+type+' connection required');return c;});
  fs.writeFileSync(path.join(profile,'disks.json'),JSON.stringify({...state,connections,disks:[],settings:{...state.settings,loginStart:false}}));
  m=makeManager();await m.init();assert.ok(m.health.winfsp,'WinFsp is required');
  const modes=(process.env.ONEMOUNT_LIVE_WRITEBACK||'0,1').split(',');
  for(const c of connections)for(const mode of modes)await exercise(c,mode==='1');
  report.passed=true;
}).catch(e=>{
  report.passed=false;report.failure={stage:report.results.at(-1)?.stage,code:e.code||e.name};
  // Raw engine errors can contain account information; keep output diagnostic-only.
  console.error('Cloud volume validation failed at',report.failure.stage,'('+report.failure.code+'). Inspect the private volume logs.');
  process.exitCode=1;
}).finally(async()=>{
  try{await m?.shutdown();}catch{report.sessionsRetained=true;process.exitCode=1;}
  report.finished=new Date().toISOString();save();console.log('Report:',reportFile);
  if(!report.sessionsRetained)app.exit(process.exitCode||0);
  // Keep logging and allow journal adoption if safe shutdown could not finish.
});
