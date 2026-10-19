'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {authorize115} = require('../src/cloud115-auth.cjs');
const {authErrorMessage} = require('../src/accounts.cjs');
const {errorDetails} = require('../src/auth-log.cjs');
const device = {uid: 'PRIVATE_UID', sign: 'PRIVATE_SIGN', time: 12345, qrcode: 'https://115.com/scan/PRIVATE_QR'};
const token = {access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 7200};
function fixture(items) {
  const controller = new AbortController(), calls = []; let clock = 0;
  const f = {controller, calls, code: null, scanned: 0};
  f.options = {clientId: '123456', signal: controller.signal, now: () => clock,
    wait: async ms => { clock += ms; }, renderQR: async () => 'data:image/png;base64,TEST',
    onCode: async code => { f.code = code; }, onScanned: () => { f.scanned++; },
    fetcher: async (url, options) => { calls.push({url, options}); const data=items.shift(); return {ok:true,status:200,json:async()=>data?.raw || {code:0,data}}; }};
  return f;
}
test('115 PKCE QR login polls, confirms, exchanges once and only exposes the image', async () => {
  const f = fixture([device,{status:0},{status:1},{status:1},{status:2},token]);
  const result = await authorize115(f.options);
  assert.equal(f.scanned,1); assert.deepEqual(f.code,{qrImage:'data:image/png;base64,TEST'});
  assert.equal(result.access_token,token.access_token); assert.equal(result.refresh_token,token.refresh_token);
  assert.equal(result.expiry,new Date(7208000).toISOString());
  const first=f.calls[0].options.body, last=f.calls.at(-1).options.body;
  assert.equal(first.get('code_challenge_method'),'sha256');
  assert.equal(first.get('code_challenge'),crypto.createHash('sha256').update(last.get('code_verifier')).digest('base64'));
  assert.equal(last.get('uid'),device.uid); assert.match(last.get('code_verifier'),/^[\w-]{64}$/);
  assert.ok(f.calls.every(c=>c.options.redirect==='error'));
  assert.equal(f.calls.at(-1).options.method,'POST');
  assert.doesNotMatch(JSON.stringify(f.code),/PRIVATE_/);
});
test('115 cancellation before exchange never returns or persists credentials', async () => {
  const f=fixture([device,{status:2},token]); f.options.wait=async()=>f.controller.abort();
  await assert.rejects(authorize115(f.options),{name:'AbortError'}); assert.equal(f.calls.length,1);
});
test('115 expired, denied, malformed QR and provider errors fail without disclosing payloads', async () => {
  for(const [status,expected] of [[-1,/expired_token/],[-2,/access_denied/],[9,/invalid_response/]]) {
    const f=fixture([device,{status}]); await assert.rejects(authorize115(f.options),expected);
  }
  for(const qrcode of ['javascript:alert(1)','https://evil.test/PRIVATE','https://115.com.evil.test/','https://u:PRIVATE@115.com/']) {
    const f=fixture([{...device,qrcode}]); await assert.rejects(authorize115(f.options),/invalid_response/); assert.equal(f.code,null);
  }
  const f=fixture([{raw:{code:12345,message:'PRIVATE_TOKEN',data:token}}]);
  await assert.rejects(authorize115(f.options), e=>/code=12345/.test(e.message)&&!e.message.includes('PRIVATE'));
  const malformed=fixture([device,{status:2},{...token,refresh_token:''}]);
  await assert.rejects(authorize115(malformed.options),/invalid_response/);
});
test('115 authorization deadline does not exchange an expired code', async()=>{
  const f=fixture([device,token]); let first=true;
  f.options.now=()=>first?(first=false,0):300000;
  await assert.rejects(authorize115(f.options),/expired_token/); assert.equal(f.calls.length,1);
});
test('115 auth errors provide safe messages and numeric diagnostic codes',()=>{
  assert.match(authErrorMessage(new Error('cloud115_auth expired_token PRIVATE')),/二维码已过期/);
  assert.match(authErrorMessage(new Error('cloud115_auth access_denied PRIVATE')),/已取消/);
  const detail=errorDetails(new Error('cloud115_auth provider_error code=40140116 PRIVATE_TOKEN'));
  assert.equal(detail.providerCode,40140116); assert.equal(detail.category,'device_authorization');
  assert.doesNotMatch(JSON.stringify(detail),/PRIVATE/);
});

test('115 account flow passes the token only to engine configuration and logs no secrets',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {Manager}=require('../src/manager.cjs');require('../src/accounts.cjs').installAccounts(Manager);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'onemount-115-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original=global.fetch, responses=[device,{status:2},token];
  global.fetch=async()=>({ok:true,status:200,json:async()=>({code:0,data:responses.shift()})});
  t.after(()=>{global.fetch=original;});
  const m=new Manager({root,engines:root,protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString(),oauthClients:{cloud115:{clientId:'123456',clientSecret:'PRIVATE_UNUSED_SECRET'}},openExternal:async()=>assert.fail('QR login must not launch a browser')});
  const snapshots=[];m.on('change',()=>snapshots.push(m.snapshot()));
  let configured;m.advanceAuth=async(_a,method,body)=>{assert.equal(method,'config/create');configured=body;};
  await m.connect({type:'cloud115',name:'115 test'});await m.auth.deviceTask;
  assert.equal(configured.type,'cloud115');assert.equal(JSON.parse(configured.parameters.token).access_token,token.access_token);
  assert.equal(Object.hasOwn(configured.parameters,'client_secret'),false);
  assert.ok(snapshots.some(s=>s.auth?.status==='qr_authorizing'&&s.auth.device.qrImage.startsWith('data:image/png;base64,')));
  assert.doesNotMatch(JSON.stringify(snapshots),/PRIVATE_(ACCESS|REFRESH|UID|SIGN|UNUSED)|code_verifier/);
  const log=fs.readFileSync(path.join(root,'auth.log'),'utf8');assert.doesNotMatch(log,/PRIVATE_|https?:\/\//);
  assert.match(log,/qr_authorization_succeeded/);
});
