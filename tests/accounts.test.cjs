'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {authErrorMessage, installAccounts} = require('../src/accounts.cjs');

test('known Microsoft and network failures are actionable without disclosing provider payloads', () => {
  const cases = [
    ['failed to get token: invalid_client AADSTS7000218', /公共客户端/],
    ['AADSTS50011 reply URL mismatch', /回调地址不匹配/],
    ['AADSTS700016 app not found', /未找到当前应用/],
    ['AADSTS9002327 SPA token redemption', /平台.*不匹配/],
    ['failed to get token: invalid_grant', /重新登录/],
    ['Authorization_RequestDenied', /所需访问权限/],
    ['failed to get token: connectex: timeout', /网络请求失败/],
    ['failed to get token: unexpected response', /未能取得访问凭据/],
    ['unrecognized error', /连接未完成/],
  ];
  for (const [raw, expected] of cases) {
    const message=authErrorMessage(new Error(raw+' access_token=PRIVATE_TOKEN refresh_token=REFRESH_SECRET https://example.com/?code=PRIVATE_CODE'));
    assert.match(message,expected);
    assert.doesNotMatch(message,/PRIVATE_|REFRESH_SECRET|example\.com|access_token|refresh_token/);
  }
});

test('authentication failure updates only the current uncancelled attempt', () => {
  class Stub { emit(){this.events=(this.events||0)+1;} }
  installAccounts(Stub);
  const manager=new Stub();
  const attempt={status:'authorizing'};
  manager.auth=attempt;
  manager.authFailure(attempt,new Error('failed to get token: AADSTS7000218 secret=PRIVATE'));
  assert.equal(attempt.status,'error');
  assert.match(attempt.error,/AADSTS7000218/);
  assert.doesNotMatch(attempt.error,/PRIVATE/);
  assert.equal(manager.events,1);
  manager.authFailure({},new Error('timeout'));
  attempt.cancelled=true;
  manager.authFailure(attempt,new Error('timeout'));
  assert.equal(manager.events,1);
});
