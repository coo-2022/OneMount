'use strict';
// Diagnostic only: completed/exit 0 means the run finished, not that truncation passed.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const P=require('../src/processes.cjs');
const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
fs.mkdirSync(results,{recursive:true});
const base=fs.mkdtempSync(path.join(results,'juicefs-truncate-fault-'));
const exe=path.join(root,'engines/juicefs.exe'),rclone=path.join(root,'engines/rclone.exe');
const faultEnabled=process.env.ONEMOUNT_FAULT!=='off';
const report={started:new Date().toISOString(),base,pid:process.pid,faultEnabled,engineSha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),events:[],snapshots:[]};
const save=()=>fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2));
const event=(name,data={})=>{report.events.push({name,time:new Date().toISOString(),...data});save();};
let gateway,jfs,proxy,worker,armed=false,blocked=[],letter,guard;
const backend=path.join(base,'backend');fs.mkdirSync(backend);
function metadata(label){
 const db=new DatabaseSync(path.join(base,'meta.db'),{readOnly:true});
 try {const row=db.prepare("SELECT n.inode,n.length,hex(c.slices) AS slices FROM jfs_node n JOIN jfs_edge e ON n.inode=e.inode LEFT JOIN jfs_chunk c ON n.inode=c.inode WHERE cast(e.name as text)='fault.bin'").get();report.snapshots.push({label,time:new Date().toISOString(),...row});save();}finally{db.close();}
}
async function snapshot(label){const b=await fsp.readFile(letter+'\\fault.bin');report.snapshots.push({label,time:new Date().toISOString(),size:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});await fsp.writeFile(path.join(base,label+'.bin'),b);save();}
function release(){armed=false;for(const send of blocked.splice(0))send();event('fault_released');}
(async()=>{
 letter=[...'QRSTUVWY'].find(c=>!fs.existsSync(c+':\\'))+':';if(letter==='undefined:')throw Error('No free test letter');report.letter=letter;
 const port=await P.freePort();gateway=P.launch(rclone,['serve','s3',backend,'--addr','127.0.0.1:'+port,'--vfs-cache-mode','off','--no-cleanup','--log-level','DEBUG'],{cwd:base,logfile:path.join(base,'gateway.log')});
 await P.waitFor(async()=>{await fetch('http://127.0.0.1:'+port);return true;});
 proxy=http.createServer((req,res)=>{
  const body=[];req.on('data',d=>body.push(d));req.on('end',()=>{
   const send=()=>{if(res.destroyed)return;const u=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});u.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end();}});u.end(Buffer.concat(body));};
   if(armed&&req.method==='PUT'&&req.url.includes('/chunks/')){event('put_held',{object:req.url.split('?')[0],bytes:Buffer.concat(body).length});blocked.push(send);}else send();
  });
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const proxyPort=proxy.address().port;
 const env={ACCESS_KEY:'isolated-test',SECRET_KEY:'isolated-local-test'};
 await P.run(exe,['format','--no-update','--storage','s3','--bucket',`http://127.0.0.1:${proxyPort}/jfs`,'sqlite3://meta.db','faulttest'],{cwd:base,env});
 const mount=async()=>{const metrics=await P.freePort();jfs=P.launch(exe,['mount','--no-usage-report','--as-root','--attr-cache','0','--no-bgjob','--debug','--metrics','127.0.0.1:'+metrics,'--cache-dir',path.join(base,'cache'),'sqlite3://meta.db',letter],{cwd:base,logfile:path.join(base,'volume.log')});await P.waitFor(()=>fs.existsSync(letter+'\\.config'),45000);};
 const unmount=async()=>{await P.run(exe,['umount','--flush',letter],{cwd:base,timeout:120000});await P.waitExit(jfs);jfs=null;};
 await mount();event('mounted');
 worker=spawn(process.env.ONEMOUNT_TEST_PYTHON,[path.join(__dirname,'juicefs-truncate-worker.py'),letter+'\\fault.bin'],{cwd:base,env:P.cleanEnv({PYTHONUTF8:'1'}),windowsHide:true,stdio:['pipe','pipe','pipe']});
 report.workerPid=worker.pid;save();
 guard=setTimeout(()=>{event('safety_deadline');release();worker.stdin.write('\n');},390000);
 let queue=Promise.resolve(),out='';
 worker.stdout.on('data',d=>{out+=d;let i;while((i=out.indexOf('\n'))>=0){const line=out.slice(0,i);out=out.slice(i+1);queue=queue.then(async()=>{const e=JSON.parse(line);event(e.event,e);if(e.event==='baseline'){metadata('baseline');armed=faultEnabled;event(faultEnabled?'fault_armed':'fault_bypassed');worker.stdin.write('\n');}if(e.event==='truncate_returned'||e.event==='truncate_failed'){metadata('truncate_before_release');release();worker.stdin.write('\n');}});}});
 worker.stderr.on('data',d=>fs.appendFileSync(path.join(base,'worker.log'),d));
 const code=await new Promise(resolve=>worker.on('close',resolve));await queue;clearTimeout(guard);report.workerExit=code;event('worker_exited');
 metadata('after_close');await snapshot('warm');await unmount();metadata('after_unmount');
 await fsp.rename(path.join(base,'cache'),path.join(base,'cache-warm'));await mount();await snapshot('cold');await unmount();
 report.completed=true;
})().catch(e=>{report.failure=e.stack;process.exitCode=1;}).finally(async()=>{
 clearTimeout(guard);if(armed)release();
 if(jfs){try{await P.run(exe,['umount','--flush',letter],{cwd:base,timeout:120000});await P.waitExit(jfs);jfs=null;}catch(e){report.shutdownError=e.message;}}
 if(!jfs){if(gateway){gateway.kill();await P.waitExit(gateway);}if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}}
 report.finished=new Date().toISOString();save();console.log(base);
});
