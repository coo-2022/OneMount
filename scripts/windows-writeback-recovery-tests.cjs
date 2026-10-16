'use strict';
// All faults affect only a newly created local S3 endpoint and this runner's own mount.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),P=require('../src/processes.cjs');
const repo=path.resolve(__dirname,'..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const direct={HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'};
function staged(cache){if(!fs.existsSync(cache))return 0;let count=0;for(const volume of fs.readdirSync(cache,{withFileTypes:true}))if(volume.isDirectory()){const dir=path.join(cache,volume.name,'rawstaging');if(fs.existsSync(dir))for(const p of fs.readdirSync(dir,{recursive:true,withFileTypes:true}))if(p.isFile())count++;}return count;}
async function worker(){
  const [kind,folder,manifest,token]=process.argv.slice(3);assert.equal(fs.readFileSync(path.join(folder,'.test-owner'),'utf8'),token);
  if(kind==='verify'){const expected=JSON.parse(fs.readFileSync(manifest));for(const f of expected){assert.equal(hash(fs.readFileSync(path.join(folder,f.name))),f.sha256);assert.equal(fs.statSync(path.join(folder,f.name)).size,f.bytes);}assert.ok(!fs.existsSync(path.join(folder,'old.bin')));console.log('PASS cold hashes and rename/delete/recreate');return;}
  assert.equal(kind,'write');const expected=[];
  function write(name,b){const fd=fs.openSync(path.join(folder,name),'w');try{let off=0;while(off<b.length)off+=fs.writeSync(fd,b,off,b.length-off,off);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  const large=crypto.randomBytes(5*1024**2+137);write('old.bin',large);fs.renameSync(path.join(folder,'old.bin'),path.join(folder,'renamed.bin'));
  const fd=fs.openSync(path.join(folder,'renamed.bin'),'r+');try{const patch=Buffer.alloc(4096,0x43);fs.writeSync(fd,patch,0,patch.length,4*1024**2-128);patch.copy(large,4*1024**2-128);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  expected.push({name:'renamed.bin',bytes:large.length,sha256:hash(large)});
  write('recreated.bin',crypto.randomBytes(1024**2));fs.unlinkSync(path.join(folder,'recreated.bin'));const recreated=crypto.randomBytes(3*1024**2+13);write('recreated.bin',recreated);expected.push({name:'recreated.bin',bytes:recreated.length,sha256:hash(recreated)});
  fs.writeFileSync(manifest,JSON.stringify(expected));console.log('PASS fsync/close with pending replacement, rename and delete/recreate');
}
async function main(){
  assert.equal(process.platform,'win32');const results=path.join(repo,'test-results');fs.mkdirSync(results,{recursive:true});const base=fs.mkdtempSync(path.join(results,'writeback-recovery-'));
  const exe=path.join(repo,'engines/juicefs.exe'),rclone=path.join(repo,'engines/rclone.exe');
  const report={started:new Date().toISOString(),fixture:path.relative(repo,base),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),runnerSha256:hash(fs.readFileSync(__filename)),engineSha256:hash(fs.readFileSync(exe)),rcloneSha256:hash(fs.readFileSync(rclone)),limits:['Local fault proxy only, not a real cloud disconnection','Process termination after fsync/close, not host power loss or volatile-memory writes','Uses the real bundled JuiceFS/rclone with SQLite and --writeback; application session adoption is not tested'],cases:[]};
  const save=()=>fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2));save();console.log('Fixture:',base);
  for(const scenario of ['unavailable-then-recover','lost-upload-response','client-crash-after-fsync']){
    const dir=path.join(base,scenario);fs.mkdirSync(dir);const backend=path.join(dir,'backend');fs.mkdirSync(backend);const cache=path.join(dir,'cache');
    const entry={scenario,started:new Date().toISOString(),faultRequests:0,putRequests:0,droppedResponses:0};report.cases.push(entry);save();
    let gateway,jfs,proxy,mode='pass',emergency;const letter=process.env.ONEMOUNT_TEST_LETTER||[...'UVWY'].find(c=>!fs.existsSync(c+':\\'));assert.match(letter,/^[D-Z]$/);assert.ok(!fs.existsSync(letter+':\\'));
    const mount=letter+':',folder=path.join(mount+'\\','recovery'),manifest=path.join(dir,'expected.json'),token=crypto.randomUUID();
    const runWorker=async kind=>{entry[kind+'Output']=await P.run(process.execPath,[__filename,'--worker',kind,folder,manifest,token],{cwd:dir,env:direct,timeout:120000});save();};
    try{
      const port=await P.freePort();gateway=P.launch(rclone,['serve','s3',backend,'--addr','127.0.0.1:'+port,'--vfs-cache-mode','off','--no-cleanup','--log-level','INFO'],{cwd:dir,env:direct,logfile:path.join(dir,'gateway.log')});entry.gatewayPid=gateway.pid;
      await P.waitFor(async()=>{await fetch('http://127.0.0.1:'+port);return true;});
      proxy=http.createServer((req,res)=>{const body=[];req.on('data',d=>body.push(d));req.on('end',()=>{
        const chunkPut=req.method==='PUT'&&req.url.includes('/chunks/');if(chunkPut)entry.putRequests++;
        if(chunkPut&&mode==='unavailable'){entry.faultRequests++;save();res.writeHead(503,{'Content-Type':'application/xml'});res.end('<Error><Code>ServiceUnavailable</Code></Error>');return;}
        const lose=chunkPut&&mode==='lose-once'&&entry.droppedResponses===0;
        if(lose)mode='pass';
        const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},r=>{
          if(lose&&r.statusCode>=200&&r.statusCode<300){r.resume();r.once('end',()=>{entry.droppedResponses++;save();res.destroy();});}
          else{res.writeHead(r.statusCode,r.headers);r.pipe(res);}
        });upstream.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end();}});upstream.end(Buffer.concat(body));
      });});
      await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyPort=proxy.address().port;
      await P.run(exe,['format','--no-update','--storage','s3','--bucket',`http://127.0.0.1:${proxyPort}/jfs`,'sqlite3://meta.db','recovery'],{cwd:dir,env:{...direct,ACCESS_KEY:'isolated-test',SECRET_KEY:'isolated-local-test'}});
      const start=async()=>{const metrics=await P.freePort();const args=['mount','--no-usage-report','--as-root','--attr-cache','0','--no-bgjob','--writeback','--metrics','127.0.0.1:'+metrics,'--cache-dir',cache,'sqlite3://meta.db',mount];jfs=P.launch(exe,args,{cwd:dir,env:direct,logfile:path.join(dir,'volume.log')});entry.clientPids=(entry.clientPids||[]).concat(jfs.pid);entry.mountArguments=args;save();await P.waitFor(()=>fs.existsSync(mount+'\\.config'),45000);};
      const stop=async()=>{await P.run(exe,['umount','--flush',mount],{cwd:dir,env:direct,timeout:120000});await P.waitExit(jfs);jfs=null;};
      await start();fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'.test-owner'),token);
      mode=scenario==='lost-upload-response'?'lose-once':'unavailable';entry.faultStarted=new Date().toISOString();save();
      emergency=setTimeout(()=>{mode='pass';entry.safetyDeadline=true;save();},180000);
      await runWorker('write');entry.stagedAfterClose=staged(cache);save();
      if(scenario==='lost-upload-response')await P.waitFor(()=>entry.droppedResponses===1,60000);
      else{
        assert.ok(entry.stagedAfterClose>0,'pending data must exist before recovery');await P.waitFor(()=>entry.faultRequests>0,30000);
        if(scenario==='client-crash-after-fsync'){
          assert.ok(jfs&&entry.clientPids.includes(jfs.pid)&&P.alive(jfs.pid));entry.terminatedOwnedClientPid=jfs.pid;save();jfs.kill();await P.waitExit(jfs);jfs=null;await P.waitFor(()=>!fs.existsSync(mount+'\\'),30000);
          entry.stagedAfterCrash=staged(cache);assert.ok(entry.stagedAfterCrash>0);mode='pass';await start();
        }else{await P.delay(8000);mode='pass';}
      }
      entry.recoveryStarted=new Date().toISOString();save();await P.waitFor(()=>staged(cache)===0,120000);await stop();
      const from=path.resolve(cache),to=from+'-preserved';for(const p of [from,to])assert.ok(p.startsWith(path.resolve(dir)+path.sep));fs.renameSync(from,to);fs.mkdirSync(from);
      await start();await runWorker('verify');await stop();entry.coldReadPassed=true;entry.passed=!entry.safetyDeadline;console.log('PASS',scenario);
    }catch(e){entry.passed=false;entry.error=e.stack;console.log('FAIL',scenario,e.message);}
    finally{
      clearTimeout(emergency);mode='pass';
      if(jfs){try{await P.run(exe,['umount','--flush',mount],{cwd:dir,env:direct,timeout:120000});await P.waitExit(jfs);jfs=null;}catch(e){entry.shutdownError=e.message;entry.sessionsRetained=true;}}
      if(!jfs){if(gateway){gateway.kill();await P.waitExit(gateway);}if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}entry.safelyStopped=true;}
      entry.finished=new Date().toISOString();save();
    }
    if(entry.sessionsRetained)break;
  }
  report.finished=new Date().toISOString();report.passed=report.cases.length===3&&report.cases.every(c=>c.passed&&c.safelyStopped);save();console.log(JSON.stringify({report:path.relative(repo,path.join(base,'report.json')),passed:report.passed}));if(!report.cases.some(c=>c.sessionsRetained))process.exitCode=report.passed?0:1;
}
(process.argv[2]==='--worker'?worker():main()).catch(e=>{console.error(e);process.exitCode=1;});
