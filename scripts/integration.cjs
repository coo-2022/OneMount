'use strict';
// Headless integration: real engine binaries, real encrypted config, real S3 data, no FUSE requirement.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {Manager}=require('../src/manager.cjs');require('../src/accounts.cjs').installAccounts(Manager);
const P=require('../src/processes.cjs');const plan=require('../src/plans.cjs');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'ci-integration-'));const bin=path.join(base,'engines');fs.mkdirSync(bin);
const rclone=process.env.TEST_RCLONE,juicefs=process.env.TEST_JUICEFS;
if(!rclone||!juicefs)throw new Error('Set TEST_RCLONE and TEST_JUICEFS to absolute Linux binary paths');
fs.symlinkSync(rclone,path.join(bin,'rclone'));fs.symlinkSync(juicefs,path.join(bin,'juicefs'));
const m=new Manager({root:path.join(base,'state'),engines:bin,protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString(),platform:'linux'});
let gateway;const report=[];
const pass=s=>{report.push(s);console.log('PASS '+s);};
async function stopGateway(){if(gateway){await P.rc(gateway,'core/quit');await P.waitExit(gateway.proc,10000);gateway=null;}}
async function main(){
 await m.init();assert.match(fs.readFileSync(m.config,'utf8'),/RCLONE_ENCRYPT_V0/);pass('账户配置文件实际加密');
 const remote=path.join(base,'remote');fs.mkdirSync(path.join(remote,'jfs'),{recursive:true});
 const cid=await m.addLocal({name:'测试目录',path:remote});await m.testConnection(cid);pass('本地连接创建与访问检查');
 const port=await P.freePort();const access='test-user',secret=crypto.randomBytes(20).toString('hex');
 async function startGateway(){const r={rcPort:await P.freePort(),rcPass:crypto.randomBytes(20).toString('hex')};
   r.proc=P.launch(rclone,plan.gatewayArgs(remote,port,r.rcPort,path.join(base,'cache'),m.config),{cwd:base,env:m.env({RCLONE_RC_PASS:r.rcPass,RCLONE_AUTH_KEY:`"${access},${secret}"`}),logfile:path.join(base,'gateway.log'),secrets:[secret,r.rcPass]});gateway=r;
   await P.waitFor(async()=>{await P.rc(r,'core/pid');const s=await fetch(`http://127.0.0.1:${port}`);return [400,401,403].includes(s.status);});
 }
 await startGateway();assert.equal((await fetch(`http://127.0.0.1:${gateway.rcPort}/core/stats`,{method:'POST'})).status,401);pass('S3 与控制接口拒绝未认证请求');
 await m.connect({name:'内置授权测试',type:'s3',url:`http://127.0.0.1:${port}`,user:access,password:secret,region:'us-east-1'});
 await P.waitFor(()=>{if(m.auth?.status==='error')throw new Error(m.auth.error);return !m.auth;},20000);
 const cloud=m.state.connections.find(c=>c.type==='s3');assert.ok(cloud);await m.testConnection(cloud.id);pass('软件账户流程经 RC 创建 S3 账号并验证访问');
 const folders=await m.listFolders(cloud.id);assert.ok(folders.some(x=>x.name==='jfs'));await m.setFolder(cloud.id,'jfs');await m.testConnection(cloud.id);pass('账户目录浏览与根目录选择');
 const plain=fs.readFileSync(m.config,'utf8');assert.ok(!plain.includes(secret));assert.ok(!JSON.stringify(m.snapshot()).includes(secret));pass('密钥不出现在磁盘明文配置或界面状态');
 const volume=path.join(base,'volume');fs.mkdirSync(volume);
 await P.run(juicefs,plan.formatArgs(port,'citest'),{cwd:volume,env:{ACCESS_KEY:access,SECRET_KEY:secret},timeout:90000});pass('同一软件网关参数完成 SQLite 卷初始化');
 const input=path.join(base,'input'),output=path.join(base,'output');fs.mkdirSync(path.join(input,'中文 空格'),{recursive:true});
 for(const [name,size]of [['empty',0],['small.txt',37],['4k.bin',4096],['4m.bin',4*1024**2],['large.bin',12*1024**2+137],['中文 空格/资料.txt',5123]])fs.writeFileSync(path.join(input,name),crypto.randomBytes(size));
 const env={citest:'sqlite3://'+path.join(volume,'meta.db')};
 await P.run(juicefs,['sync','--dirs','--check-all',input+'/', 'jfs://citest/files/'],{cwd:volume,env,timeout:120000});
 await stopGateway();await startGateway();
 await P.run(juicefs,['sync','--dirs','--check-all','jfs://citest/files/',output+'/'],{cwd:volume,env,timeout:120000});
 function manifest(dir){const result={};for(const e of fs.readdirSync(dir,{recursive:true,withFileTypes:true}))if(e.isFile()){const file=path.join(e.parentPath,e.name);result[path.relative(dir,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}return result;}
 assert.deepEqual(manifest(input),manifest(output));pass('六种大小和中文路径文件，网关重启后 SHA-256 回读一致');
 fs.writeFileSync(path.join(input,'small.txt'),'updated data');fs.unlinkSync(path.join(input,'4k.bin'));
 await P.run(juicefs,['sync','--dirs','--delete-dst','--check-all',input+'/', 'jfs://citest/files/'],{cwd:volume,env,timeout:120000});
 await stopGateway();await startGateway();const output2=path.join(base,'output2');
 await P.run(juicefs,['sync','--dirs','--check-all','jfs://citest/files/',output2+'/'],{cwd:volume,env,timeout:120000});assert.deepEqual(manifest(input),manifest(output2));pass('覆盖写入、逻辑删除、再次重启回读一致');
 await m.deleteConnection(cloud.id);assert.equal(m.state.connections.filter(c=>c.type==='s3').length,0);pass('软件内移除账号，存储数据保留');
 const log=fs.readFileSync(path.join(base,'gateway.log'),'utf8');assert.ok(!log.includes(secret));pass('网关日志未泄漏认证密钥');
 fs.writeFileSync(path.join(__dirname,'../INTEGRATION-RESULTS.json'),JSON.stringify({date:new Date().toISOString(),platform:process.platform,tests:report,notTested:['Windows WinFsp actual mount','Real third-party OAuth consent']},null,2));
}
main().catch(e=>{console.error(e);console.error('Test state retained:',base);process.exitCode=1;}).finally(async()=>{await stopGateway().catch(()=>{});await m.shutdown().catch(async()=>{if(m.auth)await m.cancelAuth().catch(()=>{});await m.shutdown().catch(()=>{});});});
