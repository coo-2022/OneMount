'use strict';
const {setTimeout: sleep} = require('node:timers/promises');
const BASE = 'https://openapi.baidu.com/oauth/2.0/';
const ERRORS = new Set(['authorization_pending', 'slow_down', 'access_denied', 'authorization_declined', 'expired_token', 'invalid_client', 'invalid_grant', 'invalid_scope', 'invalid_request', 'unsupported_grant_type']);

// Device codes and token responses stay in the main process. Only the short
// user code and the validated verification page may be shown to the user.
async function authorizeBaidu({clientId, clientSecret, signal, onCode, fetcher = fetch, wait = sleep, now = Date.now}) {
  const request = async (endpoint, values, post = false) => {
    signal.throwIfAborted();
    const form = new URLSearchParams(values);
    const response = await fetcher(BASE + endpoint + (post ? '' : '?' + form), {
      method: post ? 'POST' : 'GET', redirect: 'error',
      ...(post ? {body: form, headers: {'Content-Type': 'application/x-www-form-urlencoded'}} : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    let data;
    try {data = await response.json();} catch {throw new Error('baidu_auth_invalid_response');}
    if (!response.ok && !ERRORS.has(data.error)) throw new Error('baidu_auth HTTP ' + response.status);
    if (data.error && !ERRORS.has(data.error)) throw new Error('baidu_auth_provider_error');
    return data;
  };
  const device = await request('device/code', {response_type: 'device_code', client_id: clientId, scope: 'basic,netdisk'});
  if (device.error) throw new Error('baidu_auth ' + device.error);
  let url;
  try {url = new URL(device.verification_url || device.verification_uri);} catch {throw new Error('baidu_auth_invalid_response');}
  if (url.protocol !== 'https:' || url.hostname !== 'openapi.baidu.com' || url.port || url.username || url.password || url.hash) throw new Error('baidu_auth_invalid_response');
  if (typeof device.device_code !== 'string' || !device.device_code || !/^[a-zA-Z0-9-]{4,32}$/.test(device.user_code) || !Number.isFinite(device.expires_in) || device.expires_in <= 0) throw new Error('baidu_auth_invalid_response');
  const deadline = now() + Math.min(device.expires_in, 600) * 1000;
  let interval = Math.max(5, Math.min(60, Number(device.interval) || 5));
  signal.throwIfAborted();
  await onCode({userCode: device.user_code, verificationUrl: url.href});
  while (now() < deadline) {
    await wait(Math.min(interval * 1000, deadline - now()), undefined, {signal});
    signal.throwIfAborted();
    if (now() >= deadline) break;
    const data = await request('token', {grant_type: 'device_token', code: device.device_code, client_id: clientId, client_secret: clientSecret}, true);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {interval = Math.min(interval + 5, 60); continue;}
    if (data.error) throw new Error('baidu_auth ' + data.error);
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('baidu_auth_invalid_response');
    signal.throwIfAborted();
    return {access_token: data.access_token, refresh_token: data.refresh_token, token_type: 'Bearer', expiry: new Date(now() + Math.min(data.expires_in, 90 * 86400) * 1000).toISOString()};
  }
  throw new Error('baidu_auth expired_token');
}
module.exports = {authorizeBaidu};
