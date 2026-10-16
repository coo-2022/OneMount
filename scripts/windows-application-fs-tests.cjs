'use strict';
// Fresh local fixtures; bounded application workloads, not a power-loss certification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');
const repo=path.resolve(__dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function digest(file){const h=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))h.update(buf.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
const blockKey=crypto.createHash('sha256').update('OneMount bounded filesystem baseline 20261016').digest();
function block(i){const iv=Buffer.alloc(16);iv.writeUInt32BE(i,12);return crypto.createCipheriv('aes-256-ctr',blockKey,iv).update(Buffer.alloc(1024*1024));}
function writeAll(fd,b,position){let n=0;while(n<b.length){const k=fs.writeSync(fd,b,n,b.length-n,position+n);assert.ok(k>0);n+=k;}}
async function worker(){
  const [kind,folder,manifest,token,writer]=process.argv.slice(3);
  assert.equal(fs.readFileSync(path.join(folder,'.test-owner'),'utf8'),token);
  if(kind==='writer'){
    for(let i=0;i<60;i++){
      const payload=String(writer)+':'+i+':'+String(i).repeat(2000),value=JSON.stringify({writer,i,payload,digest:sha(payload)});
      const tmp=path.join(folder,'atomic-'+writer+'.tmp'),fd=fs.openSync(tmp,'w');try{writeAll(fd,Buffer.from(value),0);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(tmp,path.join(folder,'atomic.json'));await delay(1);
    }return;
  }
  if(kind==='verify'){
    const expected=JSON.parse(fs.readFileSync(manifest));
    for(const f of expected.files){const file=path.join(folder,f.name);assert.equal(fs.statSync(file).size,f.bytes);assert.equal(digest(file),f.sha256);}
    const sparse=path.join(folder,'sparse.bin'),fd=fs.openSync(sparse,'r');
    try{assert.equal(fs.fstatSync(fd).size,5*1024**3+1173);for(const offset of [1024**3,4*1024**3-1024]){const b=Buffer.alloc(1024);assert.equal(fs.readSync(fd,b,0,b.length,offset),b.length);assert.ok(b.every(v=>v===0));}const b=Buffer.alloc(4096);assert.equal(fs.readSync(fd,b,0,b.length,4*1024**3+17),b.length);assert.ok(b.every(v=>v===0x73));}finally{fs.closeSync(fd);}
    assert.ok(!fs.existsSync(path.join(folder,'removed.txt')));console.log('PASS cold file hashes, sparse holes above 4 GiB, and deletion');return;
  }
  assert.ok(['prepare','git'].includes(kind));const expected=kind==='git'?JSON.parse(fs.readFileSync(manifest)):{files:[],checks:[]};
  const remember=(name,bytes,hash)=>expected.files.push({name,bytes,sha256:hash});
  const check=name=>{expected.checks.push(name);fs.writeFileSync(manifest,JSON.stringify(expected,null,2));console.log('PASS',name);};
  if(kind==='prepare'){
  const large=path.join(folder,'large.bin'),fd=fs.openSync(large,'w+'),patches=[{at:4*1024**2-128,bytes:Buffer.alloc(256,0xa7)},{at:64*1024**2+13,bytes:Buffer.alloc(513,0x39)}];
  try{for(let i=0;i<128;i++)writeAll(fd,block(i),i*1024**2);for(const p of patches)writeAll(fd,p.bytes,p.at);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const expectedHash=crypto.createHash('sha256');
  for(let i=0;i<128;i++){const b=block(i),start=i*b.length;for(const p of patches){const lo=Math.max(start,p.at),hi=Math.min(start+b.length,p.at+p.bytes.length);if(lo<hi)p.bytes.copy(b,lo-start,lo-p.at,hi-p.at);}expectedHash.update(b);}
  const largeHash=expectedHash.digest('hex');assert.equal(digest(large),largeHash);remember('large.bin',128*1024**2,largeHash);check('128 MiB, 32 JuiceFS blocks, deterministic hash and cross-block random writes');
  const sparse=fs.openSync(path.join(folder,'sparse.bin'),'w+');try{fs.ftruncateSync(sparse,5*1024**3+1173);writeAll(sparse,Buffer.alloc(4096,0x73),4*1024**3+17);fs.fsyncSync(sparse);}finally{fs.closeSync(sparse);}check('5 GiB sparse logical size and writes above 32-bit offsets');
  for(let i=0;i<1000;i++){const name=path.join('tree',String(Math.floor(i/20)),'文件-'+i+'.txt'),file=path.join(folder,name),bytes=Buffer.from('file '+i+'\n');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);remember(name,bytes.length,sha(bytes));}
  check('1000 Unicode files across 50 directories');
  const deep=path.join(...Array.from({length:24},(_,i)=>'d'+i),'深层.txt'),deepBytes=Buffer.from('deep tree');fs.mkdirSync(path.dirname(path.join(folder,deep)),{recursive:true});fs.writeFileSync(path.join(folder,deep),deepBytes);remember(deep,deepBytes.length,sha(deepBytes));check('24-level directory tree');
  fs.writeFileSync(path.join(folder,'removed.txt'),'remove');fs.unlinkSync(path.join(folder,'removed.txt'));
  const initial=JSON.stringify({payload:'initial',digest:sha('initial')});fs.writeFileSync(path.join(folder,'atomic.json'),initial);
  let running=3,observations=0;const children=[];
  const writers=Array.from({length:3},(_,i)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename,'--worker','writer',folder,manifest,token,String(i)],{windowsHide:true,stdio:['ignore','ignore','pipe']});children.push(child);let error='';child.stderr.on('data',d=>error+=d);
    child.once('error',reject);child.once('close',code=>{running--;code===0?resolve():reject(Error(error||'writer exit '+code));});
  }));
  const complete=Promise.all(writers);complete.catch(()=>{});const until=Date.now()+60000;
  try{while(running){assert.ok(Date.now()<until,'atomic writer deadline');const value=JSON.parse(fs.readFileSync(path.join(folder,'atomic.json'),'utf8'));assert.equal(sha(value.payload),value.digest);observations++;await delay(1);}await complete;}
  finally{for(const child of children)if(child.exitCode===null)child.kill();}
  assert.ok(observations>0);const atomic=fs.readFileSync(path.join(folder,'atomic.json'));remember('atomic.json',atomic.length,sha(atomic));check('3 writers, 180 durable temporary-file replacements, '+observations+' concurrent whole-file reads');
  }
  const gitRoot=path.join(folder,'git-worktree');fs.mkdirSync(gitRoot);const hooks=path.join(gitRoot,'empty-hooks');fs.mkdirSync(hooks);
  const git=(args)=>execFileSync('git',['-c','core.autocrlf=false','-c','core.fsmonitor=false','-c','core.hooksPath='+hooks,'-c','commit.gpgsign=false','-c','maintenance.auto=false','-c','user.name=Filesystem Test','-c','user.email=filesystem-test@example.invalid',...args],{cwd:gitRoot,encoding:'utf8',windowsHide:true,timeout:60000});
  git(['init','--quiet']);fs.writeFileSync(path.join(gitRoot,'document.txt'),'version 1\n');git(['add','document.txt']);git(['commit','--quiet','-m','initial fixture']);
  fs.writeFileSync(path.join(gitRoot,'document.tmp'),'version 2\n');fs.renameSync(path.join(gitRoot,'document.tmp'),path.join(gitRoot,'document.txt'));git(['add','document.txt']);git(['commit','--quiet','-m','atomic save']);git(['fsck','--full']);assert.equal(git(['rev-list','--count','HEAD']).trim(),'2');assert.equal(git(['show','HEAD:document.txt']),'version 2\n');check('Git init/add/two commits/fsck and editor-style atomic save');
  fs.writeFileSync(manifest,JSON.stringify(expected,null,2));
}
async function main(){
  assert.equal(process.platform,'win32');const mode=process.argv[2];assert.ok(['ntfs','juicefs','juicefs-writeback'].includes(mode));
  const results=path.join(repo,'test-results');fs.mkdirSync(results,{recursive:true});
  const resume=process.argv[3];const base=resume?path.resolve(resume):fs.mkdtempSync(path.join(results,'application-fs-'+mode+'-'));
  if(resume){assert.ok(base.startsWith(path.resolve(results)+path.sep));assert.ok(path.basename(base).startsWith('application-fs-'+mode+'-'));const previous=JSON.parse(fs.readFileSync(path.join(base,'report.json')));assert.equal(previous.mode,mode);assert.equal(previous.passed,false);assert.ok(!previous.sessionsRetained);assert.ok(!fs.existsSync(path.join(base,'followup-report.json')));}
  const report={mode,started:new Date().toISOString(),fixture:path.relative(repo,base),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),runnerSha256:sha(fs.readFileSync(__filename)),stages:[]};
  const reportName=resume?'followup-report.json':'report.json';report.followup=!!resume;
  const save=()=>fs.writeFileSync(path.join(base,reportName),JSON.stringify(report,null,2));save();console.log('Fixture:',base);
  let m,id,folder,token=crypto.randomUUID();const manifest=path.join(base,'manifest.json');
  const run=async kind=>{const started=Date.now(),stage={kind,started:new Date().toISOString()};report.stages.push(stage);save();try{stage.output=await P.run(process.execPath,[__filename,'--worker',kind,folder,manifest,token],{cwd:base,timeout:300000});stage.passed=true;}catch(e){stage.passed=false;stage.error=e.message;throw e;}finally{stage.seconds=(Date.now()-started)/1000;save();}};
  try{
    if(mode==='ntfs')folder=path.join(base,'workload');
    else{
      m=new Manager({root:path.join(base,'profile'),engines:path.join(repo,'engines'),protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});await m.init();assert.ok(m.health.winfsp);
      if(resume){assert.equal(m.state.disks.length,1);id=m.state.disks[0].id;assert.equal(m.disk(id).name,'Application filesystem test');assert.ok(!fs.existsSync(m.disk(id).letter+'\\'));}
      else{const backend=path.join(base,'backend');fs.mkdirSync(backend);const connectionId=await m.addLocal({name:'Application fixture',path:backend});
        const letter=process.env.ONEMOUNT_TEST_LETTER||[...'STUVWY'].find(c=>!fs.existsSync(c+':\\'));assert.match(letter,/^[D-Z]$/);assert.ok(!fs.existsSync(letter+':\\'));
        id=await m.addDisk({connectionId,name:'Application filesystem test',mode:'juicefs',letter:letter+':',cacheGiB:1,writeback:mode==='juicefs-writeback'});}
      await m.mount(id);folder=path.join(m.disk(id).letter+'\\','workload');report.mountArguments=m.runtime.get(id).jfs.spawnargs.slice(1);save();
    }
    if(resume){token=fs.readFileSync(path.join(folder,'.test-owner'),'utf8');assert.match(token,/^[a-f0-9-]{36}$/);report.reusedChecks=JSON.parse(fs.readFileSync(manifest)).checks;await run('git');}
    else{fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'.test-owner'),token);await run('prepare');}
    if(m){
      await P.waitFor(async()=>{await m.poll();const s=m.runtime.get(id)?.stats;return s?.known&&s.pendingBlocks===0&&s.pendingBytes===0;},120000);await m.unmount(id);
      const from=path.resolve(m.paths(m.disk(id)).cache),to=from+'-preserved';for(const p of [from,to])assert.ok(p.startsWith(path.resolve(base)+path.sep));fs.renameSync(from,to);fs.mkdirSync(from);
      await m.mount(id);report.coldCache=true;save();
    }
    await run('verify');report.passed=true;
  }catch(e){report.passed=false;report.error=e.stack;}
  finally{
    if(m){try{await P.waitFor(async()=>{await m.poll();const s=m.runtime.get(id)?.stats;return !m.runtime.has(id)||(s?.known&&s.pendingBlocks===0&&s.pendingBytes===0);},120000);await m.shutdown();report.safelyUnmounted=true;}catch(e){report.shutdownError=e.message;report.sessionsRetained=true;report.passed=false;}clearInterval(m.timer);}
    report.finished=new Date().toISOString();save();console.log(JSON.stringify({report:path.relative(repo,path.join(base,reportName)),passed:report.passed,sessionsRetained:report.sessionsRetained||false}));if(!report.sessionsRetained)process.exitCode=report.passed?0:1;
  }
}
(process.argv[2]==='--worker'?worker():main()).catch(e=>{console.error(e);process.exitCode=1;});
