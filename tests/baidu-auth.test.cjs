const test = require('node:test');
const assert = require('node:assert/strict');
const {authorizeBaidu} = require('../src/baidu-auth.cjs');
function fixture(responses) {
  const controller = new AbortController(), calls = [], delays = []; let clock = 0, code;
  return {controller, calls, delays, get code(){return code;}, options: {
    clientId: 'APP', clientSecret: 'PRIVATE_SECRET', signal: controller.signal, now: () => clock,
    onCode: async v => {code = v;},
    wait: async ms => {delays.push(ms); clock += ms;},
    fetcher: async (url, init) => {calls.push({url, init}); return {ok: true, json: async () => responses.shift()};},
  }};
}
const device = {device_code: 'PRIVATE_DEVICE', user_code: 'ABCD1234', verification_url: 'https://openapi.baidu.com/device', expires_in: 600, interval: 5};
const token = {access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600};
test('Baidu device login handles pending and slow_down, hides device code, posts credentials', async () => {
  const f = fixture([device, {error:'authorization_pending'}, {error:'slow_down'}, token]);
  const result = await authorizeBaidu(f.options);
  assert.deepEqual(f.delays, [5000,5000,10000]);
  assert.deepEqual(f.code, {userCode:'ABCD1234', verificationUrl:'https://openapi.baidu.com/device'});
  assert.equal(result.access_token, token.access_token); assert.equal(result.expiry, new Date(3620000).toISOString());
  for(const call of f.calls.slice(1)) {assert.equal(call.init.method,'POST'); assert.equal(call.init.body.get('client_secret'),'PRIVATE_SECRET'); assert.ok(!call.url.includes('PRIVATE_'));}
});
test('cancelling while awaiting authorization never exchanges a token', async () => {
  const f = fixture([device,token]); f.options.wait = async () => f.controller.abort();
  await assert.rejects(authorizeBaidu(f.options), {name:'AbortError'}); assert.equal(f.calls.length,1);
});
test('expired, rejected, malformed and untrusted provider responses fail without revealing payloads', async () => {
  for(const response of [{error:'access_denied',error_description:'PRIVATE_SECRET'}, {error:'evil_PRIVATE_DEVICE'}, {access_token:'PRIVATE_ACCESS'}]) {
    const f = fixture([device,response]);
    await assert.rejects(authorizeBaidu(f.options), error => !/PRIVATE_/.test(error.message));
  }
  for(const verification_url of ['http://openapi.baidu.com/device','https://example.com/device','https://user:PRIVATE_SECRET@openapi.baidu.com/device']) {
    const f = fixture([{...device,verification_url}]); await assert.rejects(authorizeBaidu(f.options),/invalid_response/); assert.equal(f.code,undefined);
  }
  const f = fixture([{...device,expires_in:5},token]); await assert.rejects(authorizeBaidu(f.options),/expired_token/); assert.equal(f.calls.length,1);
});
