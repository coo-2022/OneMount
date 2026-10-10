'use strict';
// Only disposable local backends. Every official test has a separate process and directory.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {Manager}=require('../src/manager.cjs');
const P=require('../src/processes.cjs');
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true')throw Error('Disposable Windows CI runner required');
const mode=process.argv[2];
if(!['ntfs','direct','juicefs','juicefs-writeback'].includes(mode))throw Error('Unknown conformance target');
const root=path.resolve(__dirname,'..'),tools=path.join(root,'test-tools');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'onemount-conformance-'));
const results=path.join(root,'test-results','conformance',mode);fs.mkdirSync(results,{recursive:true});
const report={mode,platform:os.release(),winfsp:'2.1.25156',secfsCommit:'6ac65cda46abc2be39c7b137debf9521052edbaf',startedAt:new Date().toISOString(),status:'running',catalog:[],internalOnly:[],results:[],limits:['Windows x64 on local backend; no real cloud service','External filesystem suite; WinFsp internal MEMFS/driver tests and Microsoft HLK not run','Per-case deadline: 90 seconds; stress and FSX: 300 seconds; timeout is not a pass','WinFsp --external --resilient, all optional cases; no FUSE exclusion list or case comparison relaxation']};
const reportFile=path.join(results,'report.json');
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
const bounded=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Operation timed out')),ms);})]).finally(()=>clearTimeout(timer));};
function run(exe,args,cwd,timeout=90000,extra={}) {
 return new Promise(resolve=>{
  const start=Date.now();let output='',done=false,timedOut=false;
  const p=spawn(exe,args,{cwd,env:{...process.env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const finish=(exitCode,error)=>{if(done)return;done=true;clearTimeout(timer);resolve({exitCode,error,timedOut,seconds:(Date.now()-start)/1000,output});};
  const timer=setTimeout(()=>{
   timedOut=true;
   // Only the test process tree, never unrelated user or engine processes.
   const kill=spawn('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.unref();
   setTimeout(()=>{p.stdout.destroy();p.stderr.destroy();p.unref();finish(null,'Test deadline exceeded');},5000).unref();
  },timeout);
  for(const s of [p.stdout,p.stderr])s.on('data',d=>{output=(output+d.toString()).slice(-4*1024*1024);});
  p.on('error',e=>finish(null,e.message));p.on('close',code=>finish(code));
 });
}
function tapStats(s){const plan=s.match(/^1\.\.(\d+)\s*$/m);const ok=[...s.matchAll(/^ok (\d+)\b/gm)].length,failed=[...s.matchAll(/^not ok (\d+)\b/gm)].length;return {planned:plan?Number(plan[1]):null,passed:ok,failed};}
let manager,mountRoot;
async function one(test){
 const cwd=path.join(mountRoot,String(report.results.length).padStart(3,'0')+'-'+test.id.replace(/[^a-z0-9_-]/gi,'_'));
 await bounded(fs.promises.mkdir(cwd),30000);
 const r=await run(test.exe,test.args,cwd,test.timeout||90000,test.env||{});
 const outputFile=test.id.replace(/[^a-z0-9_-]/gi,'_')+'.log';fs.writeFileSync(path.join(results,outputFile),r.output);
 const tap=test.suite==='winfstest'?tapStats(r.output):undefined;
 const signature=test.suite==='winfsp-tests'?/\.\.+ OK [\d.]+s/.test(r.output)&&r.output.includes('--- COMPLETE ---'):test.suite==='winfstest'?tap.planned>0&&tap.passed===tap.planned&&tap.failed===0:/All operations - \d+ - completed A-OK!/.test(r.output);
 const status=r.timedOut?'timeout':r.exitCode===0&&signature&&!r.error?'passed':'failed';
 report.results.push({id:test.id,suite:test.suite,status,seconds:r.seconds,exitCode:r.exitCode,error:r.error,assertions:tap,log:outputFile,command:[test.exe,...test.args],failure:r.output.split(/\r?\n/).filter(l=>/ASSERT|EXCEPTION|not ok|error|fail|mismatch/i.test(l)).slice(0,8)});save();
 console.log(`${status.toUpperCase()} ${mode} ${test.id} (${r.seconds}s)`);
}
async function main(){
 save();
 const wf=path.join(tools,'winfsp/winfsp-tests-x64.exe');
 const catalog=await run(wf,['--external','--resilient','--list','+*'],base);
 if(catalog.exitCode!==0)throw Error('Cannot list external WinFsp tests: '+catalog.output);
 const names=catalog.output.split(/\r?\n/).filter(s=>/^[a-z0-9_]+_test$/.test(s));
 if(names.length<40)throw Error('Unexpectedly incomplete external WinFsp catalog');
 const internal=await run(wf,['--list','+*'],base);
 report.internalOnly=internal.output.split(/\r?\n/).filter(s=>/^[a-z0-9_]+_test$/.test(s)&&!names.includes(s));
 const cases=names.map(name=>({id:name,suite:'winfsp-tests',exe:wf,args:['--external','--resilient','+'+name],timeout:/stress|flipflop/.test(name)?300000:90000}));
 const pyRoot=path.join(tools,'secfs/winfstest');
 for(const name of fs.readdirSync(path.join(pyRoot,'t'),{recursive:true}).filter(n=>n.endsWith('.t')).sort())cases.push({id:'winfstest-'+name.replace(/\\/g,'/'),suite:'winfstest',exe:path.join(tools,'python27/python.exe'),args:[path.join(pyRoot,'t',name)],env:{PYTHONPATH:pyRoot},timeout:90000});
 for(const variant of ['normal','mixed','stream'])cases.push({id:'fsx-'+variant,suite:'fsx',exe:path.join(tools,'secfs/fstools/src/fsx/fsx.exe'),args:[...(variant==='mixed'?['-C']:variant==='stream'?['-f','foo']:[]),'-N','5000','-S','20261010','testfile','xxxxxx'],timeout:300000});
 report.catalog=cases.map(({id,suite})=>({id,suite}));save();
 if(mode==='ntfs'){mountRoot=path.join(base,'ntfs');fs.mkdirSync(mountRoot);}
 else {
  manager=new Manager({root:path.join(base,'state'),engines:path.join(root,'engines'),protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});
  await manager.init();const backend=path.join(base,'backend');fs.mkdirSync(backend);
  const connectionId=await manager.addLocal({name:'Conformance only',path:backend});
  const letter=[...'ZYXWVUTSRQPONMLKJIHGFE'].find(c=>!fs.existsSync(c+':\\'));if(!letter)throw Error('No free test drive letter');
  const id=await manager.addDisk({name:'Conformance',mode:mode==='direct'?'direct':'juicefs',connectionId,letter:letter+':',cacheGiB:2,writeback:mode==='juicefs-writeback'});
  await manager.mount(id);mountRoot=letter+':\\';
 }
 for(const test of cases)await one(test);
 report.status=report.results.every(r=>r.status==='passed')?'passed':'failed';
}
main().catch(e=>{report.status='incomplete';report.error=e.stack;console.error(e);}).finally(async()=>{
 if(manager){try{await bounded(P.waitFor(async()=>{await manager.shutdown();return true;},180000),185000);}catch(e){report.shutdownError=e.message;report.status='incomplete';}clearInterval(manager.timer);
  for(const d of manager.state.disks)for(const [kind,file] of Object.entries(manager.paths(d)))if(['log','jfsLog'].includes(kind)&&fs.existsSync(file))fs.copyFileSync(file,path.join(results,kind+'.log'));
 }
 const attempted=new Set(report.results.map(r=>r.id));report.notRun=report.catalog.filter(t=>!attempted.has(t.id));
 report.finishedAt=new Date().toISOString();report.totals={planned:report.catalog.length,passed:report.results.filter(r=>r.status==='passed').length,failed:report.results.filter(r=>r.status==='failed').length,timeout:report.results.filter(r=>r.status==='timeout').length,notRun:report.notRun.length};save();console.log(JSON.stringify(report.totals));
 process.exit(report.status==='passed'?0:1);
});
