'use strict';
// Supplemental coverage on fresh local fixtures only. Never point this at a user mount.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');
const root=path.resolve(__dirname,'..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const target=process.argv[2];
assert.equal(process.platform,'win32');
assert.ok(['ntfs','juicefs','juicefs-writeback'].includes(target),'Explicit isolated target required');
const results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
const base=fs.mkdtempSync(path.join(results,'filesystem-gaps-'+target+'-'));
const exe=path.join(root,'engines/juicefs.exe');
const manifest=require('./juicefs-upstream-tests.json'),tools=path.join(root,manifest.directory);
const wf=path.join(tools,'winfsp-tests-x64.exe');
assert.equal(hash(fs.readFileSync(wf)),manifest.files.find(f=>f.name==='winfsp-tests-x64.exe').sha256);
const matrix=JSON.parse(fs.readFileSync(path.join(root,'docs/FILESYSTEM-TEST-MATRIX.json')));
const optional=matrix.rows.filter(r=>r.id.startsWith('WFP-OPT-'));
assert.equal(optional.length,37);
const report={schema:1,target,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),
  started:new Date().toISOString(),fixture:path.relative(root,base),coordinatorPid:process.pid,
  runnerSha256:hash(fs.readFileSync(__filename)),engineSha256:hash(fs.readFileSync(exe)),
  rcloneSha256:hash(fs.readFileSync(path.join(root,'engines/rclone.exe'))),nativeToolSha256:hash(fs.readFileSync(wf)),
  limits:['Local backend only; historical cloud tests reused separately','Fork optional cases use --external; --fuse-external suppresses some cases even with +*','Historical official assertions are unchanged; supplementary CLI checks use SQLite instead of Redis'],cases:[]};
const save=()=>fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\n');
const pathKey=Object.keys(process.env).find(k=>k.toLowerCase()==='path')||'Path';
const env={[pathKey]:path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','WinFsp/bin')+path.delimiter+process.env[pathKey]};
let manager,id,mountRoot;
async function command(caseId,title,file,args,cwd,timeout=90000,accept=()=>true){
  const item={id:caseId,title,args,started:new Date().toISOString(),status:'running',log:caseId+'.log'};
  report.cases.push(item);save();let output='',stdout='';const started=Date.now();
  await new Promise(resolve=>{
    const p=spawn(file,args,{cwd,env:P.cleanEnv(env),windowsHide:true,stdio:['ignore','pipe','pipe']});
    item.pid=p.pid;save();let done=false,grace;
    const finish=code=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);item.exitCode=code;resolve();};
    const timer=setTimeout(()=>{item.timedOut=true;p.kill();grace=setTimeout(()=>{item.processStillRunning=P.alive(p.pid);p.stdout.destroy();p.stderr.destroy();p.unref();finish(null);},10000);},timeout);
    p.stdout.on('data',d=>{stdout=(stdout+d.toString()).slice(-2*1024*1024);});
    for(const stream of [p.stdout,p.stderr])stream.on('data',d=>{output=(output+d.toString()).slice(-2*1024*1024);});
    p.once('error',e=>{item.error=e.message;finish(null);});p.once('close',finish);
  });
  fs.writeFileSync(path.join(base,item.log),output);
  item.seconds=(Date.now()-started)/1000;
  try{item.status=item.timedOut?'timeout':item.exitCode===0&&!item.error&&accept(stdout)?'passed':'failed';}
  catch(e){item.status='failed';item.error=e.message;}
  if(item.status!=='passed')item.failure=output.split(/\r?\n/).filter(l=>/ASSERT|EXCEPTION|error|failed|FATAL|KO/i.test(l)).slice(0,8);
  save();console.log(item.status.toUpperCase(),target,caseId,title);
  if(item.processStillRunning)throw Error('Test process still has pending IO; remaining work stopped');
  return {item,output};
}
async function smoke(){
  const dir=path.join(mountRoot,'cli-smoke');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'hi.txt'),'hi\n');
  const summary=path.join(dir,'summary');fs.mkdirSync(summary);
  for(const name of ['1.txt','2.txt'])fs.writeFileSync(path.join(summary,name),'hi\n');
  const cwd=manager.paths(manager.disk(id)).dir;
  await command('JFS-SMOKE-01','info',exe,['info',path.join(dir,'hi.txt')],cwd,30000,s=>/inode|length|size/i.test(s));
  await command('JFS-SMOKE-02','status (SQLite adaptation)',exe,['status','sqlite3://meta.db'],cwd,30000,s=>{const d=JSON.parse(s);return !!d.Setting&&Array.isArray(d.Sessions)&&d.Sessions.length>0;});
  await command('JFS-SMOKE-03','debug',exe,['debug','--out-dir',path.join(base,'debug'),mountRoot],cwd,120000,s=>fs.existsSync(path.join(base,'debug'))&&s.length>0);
  await command('JFS-SMOKE-04','summary',exe,['summary',summary],cwd,30000,s=>/^\|\s*\/\s*\|[^|]+\|\s*1\s*\|\s*2\s*\|/m.test(s)&&s.includes('1.txt')&&s.includes('2.txt'));
  await command('JFS-SMOKE-05','stats',exe,['stats',mountRoot,'-c','5'],cwd,30000,s=>s.trim().split(/\r?\n/).length>=5);
}
async function main(){
  save();console.log('Fixture:',base);
  const flags=['--external','--resilient','--case-insensitive-cmp'];
  const catalog=(await P.run(wf,[...flags,'--list','+*'],{cwd:base,env})).split(/\r?\n/).filter(n=>/^[a-z0-9_]+_test$/.test(n));
  assert.equal(catalog.length,91);assert.ok(optional.every(r=>catalog.includes(r.locator)));
  report.catalog=optional.map(r=>({id:r.id,name:r.locator}));save();
  if(target==='ntfs'){mountRoot=path.join(base,'ntfs');fs.mkdirSync(mountRoot);}
  else {
    manager=new Manager({root:path.join(base,'profile'),engines:path.join(root,'engines'),protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});
    await manager.init();assert.ok(manager.health.winfsp);
    const backend=path.join(base,'backend');fs.mkdirSync(backend);
    const connectionId=await manager.addLocal({name:'Isolated gap tests',path:backend});
    const letter=process.env.ONEMOUNT_TEST_LETTER||[...'QRSTUVWY'].find(c=>!fs.existsSync(c+':\\'));
    assert.match(letter,/^[D-Z]$/);assert.ok(!fs.existsSync(letter+':\\'));
    id=await manager.addDisk({connectionId,name:'Gap tests',mode:'juicefs',letter:letter+':',cacheGiB:1,writeback:target==='juicefs-writeback'});
    await manager.mount(id);mountRoot=letter+':\\';report.mountArguments=manager.runtime.get(id).jfs.spawnargs.slice(1);save();
  }
  for(const r of optional){
    const cwd=path.join(mountRoot,r.id);fs.mkdirSync(cwd);
    await command(r.id,r.locator,wf,[...flags,'+'+r.locator],cwd,/stress|flipflop/.test(r.locator)?300000:90000,
      s=>s.includes('--- COMPLETE ---')&&new RegExp('^'+r.locator+'[.\\s]+OK [\\d.]+s\\r?$','m').test(s));
  }
  if(manager)await smoke();
  report.completed=true;
}
main().catch(e=>{report.error=e.stack;}).finally(async()=>{
  if(manager){
    try{await P.waitFor(async()=>{await manager.poll();const s=manager.runtime.get(id)?.stats;return s?.known&&s.pendingBlocks===0&&s.pendingBytes===0;},120000);await manager.shutdown();report.safelyUnmounted=true;}
    catch(e){report.shutdownError=e.message;report.sessionsRetained=true;}
    clearInterval(manager.timer);
  }
  report.finished=new Date().toISOString();report.totals={};for(const item of report.cases)report.totals[item.status]=(report.totals[item.status]||0)+1;
  report.passed=report.completed&&!report.sessionsRetained&&report.cases.every(r=>r.status==='passed');save();
  console.log(JSON.stringify({report:path.relative(root,path.join(base,'report.json')),totals:report.totals,sessionsRetained:report.sessionsRetained||false}));
  // Keep an unsafe shutdown alive so its gateway/cache can be recovered.
  if(!report.sessionsRetained)process.exit(report.passed?0:1);
});
