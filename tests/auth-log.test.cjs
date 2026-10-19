'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http');
const {appendAuthLog,errorDetails,MAX_BYTES,BACKUPS}=require('../src/auth-log.cjs');
const {Manager}=require('../src/manager.cjs');
require('../src/accounts.cjs').installAccounts(Manager);
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'onemount-auth-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('failed async OAuth task is persisted with useful identifiers and no credentials',async t=>{
  const root=fixture(t);
  let polls=0;
  const raw='failed to get token: oauth2: cannot fetch token: 400 Bad Request invalid_client AADSTS7000218 '+
    'Trace ID: 12345678-1234-1234-1234-123456789abc '+
    'access_token=PRIVATE_ACCESS refresh_token=PRIVATE_REFRESH code=PRIVATE_CODE '+
    'Authorization: Bearer PRIVATE_BEARER https://login.microsoftonline.com/?state=PRIVATE_STATE user@private.example';
  const server=http.createServer((req,res)=>{
    req.resume();res.setHeader('Content-Type','application/json');
    const reply=req.url==='/config/create'?{jobid:27}:req.url==='/job/status'?
      (++polls===1?{finished:false}:{finished:true,success:false,error:raw}):
      {status:'running',authUrl:'http://127.0.0.1:53682/auth?state=PRIVATE_STATE'};
    res.end(JSON.stringify(reply));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const m=new Manager({root,engines:root,providerConfig:{enabledProviders:['onedrive']},
    protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString(),
    oauthClients:{onedrive:{clientId:'test-id',clientSecret:'PRIVATE_CLIENT_SECRET'}},openExternal:async()=>{}});
  m.accounts=async()=>({rcPort:server.address().port,rcPass:'PRIVATE_RC_PASSWORD'});
  const id=await m.connect({type:'onedrive',name:'PRIVATE_ACCOUNT_NAME'});
  const until=Date.now()+5000;
  while(m.auth.status!=='error'&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert.equal(m.auth.status,'error');
  const log=fs.readFileSync(path.join(root,'auth.log'),'utf8');
  const entries=log.trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.map(e=>e.event),['connection_started','configuration_started','job_started','browser_authorization_started','job_finished','connection_failed']);
  const failure=entries.at(-1);
  assert.equal(failure.attemptId,id);
  assert.equal(failure.stage,'browser_authorization');
  assert.equal(failure.jobId,27);
  assert.equal(failure.error.category,'token_exchange');
  assert.deepEqual(failure.error.microsoftCodes,['AADSTS7000218']);
  assert.deepEqual(failure.error.oauthErrors,['invalid_client']);
  assert.equal(failure.error.httpStatus,400);
  assert.equal(failure.error.traceId,'12345678-1234-1234-1234-123456789abc');
  assert.ok(entries.every(e=>!Number.isNaN(Date.parse(e.time))&&e.elapsedMs>=0));
  assert.doesNotMatch(log,/PRIVATE_|user@|private\.example|https?:\/\//);
  assert.doesNotMatch(log,new RegExp(m.secrets.configPass));
  // A fresh process can read the evidence without access to the expired job.
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'auth.log'),'utf8').trim().split('\n').at(-1)).event,'connection_failed');
});

test('error diagnostics retain nested network codes while discarding unknown payloads',()=>{
  const error=new Error('fetch failed',{cause:Object.assign(new Error('private host and password=PRIVATE'),{code:'ECONNREFUSED'})});
  assert.deepEqual(errorDetails(error).networkCodes,['ECONNREFUSED']);
  assert.equal(errorDetails(error).category,'network');
  assert.doesNotMatch(JSON.stringify(errorDetails(error)),/private|password|PRIVATE/);
  assert.deepEqual(errorDetails(new Error('arbitrary SECRET')), {category:'unknown',microsoftCodes:[],oauthErrors:[],networkCodes:[]});
});

test('log rotation bounds disk usage and keeps the most recent failure',t=>{
  const root=fixture(t), file=path.join(root,'auth.log');
  fs.writeFileSync(file,'x'.repeat(MAX_BYTES));
  for(let i=1;i<=BACKUPS;i++)fs.writeFileSync(file+'.'+i,'backup '+i);
  assert.equal(appendAuthLog(root,{event:'connection_failed'}),true);
  assert.equal(fs.statSync(file+'.1').size,MAX_BYTES);
  assert.equal(fs.readFileSync(file+'.2','utf8'),'backup 1');
  assert.equal(fs.readFileSync(file+'.3','utf8'),'backup 2');
  assert.equal(fs.existsSync(file+'.4'),false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).event,'connection_failed');
});

test('unwritable log location does not prevent reporting an authentication failure',t=>{
  const root=fixture(t), blocked=path.join(root,'file-instead-of-directory');
  fs.writeFileSync(blocked,'keep');
  assert.equal(appendAuthLog(blocked,{event:'connection_failed'}),false);
  const m=Object.create(Manager.prototype);
  m.root=blocked;m.emit=()=>{};m.auth={id:'test',type:'onedrive',started:Date.now()};
  assert.doesNotThrow(()=>m.authFailure(m.auth,new Error('AADSTS7000218')));
  assert.equal(m.auth.status,'error');
  assert.match(m.auth.error,/AADSTS7000218/);
  assert.equal(fs.readFileSync(blocked,'utf8'),'keep');
});
