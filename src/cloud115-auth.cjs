'use strict';
const crypto = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const QRCode = require('qrcode');
const PASSPORT = 'https://passportapi.115.com/open/';
const STATUS = 'https://qrcodeapi.115.com/get/status/';

// 115's PKCE protocol uses standard base64(SHA256(verifier)), not base64url.
// The verifier, UID, signature and tokens never leave the main process.
async function authorize115({clientId, signal, onCode, onScanned = () => {}, fetcher = fetch, wait = sleep, now = Date.now, renderQR = QRCode.toDataURL}) {
  if (!/^\d{1,20}$/.test(clientId)) throw new Error('cloud115_auth invalid_client');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const deadline = now() + 5 * 60 * 1000;
  const request = async (url, values, post = true) => {
    signal.throwIfAborted();
    const form = new URLSearchParams(values);
    let response;
    try {
      response = await fetcher(url + (post ? '' : '?' + form), {
        method: post ? 'POST' : 'GET', redirect: 'error',
        ...(post ? {body: form, headers: {'Content-Type': 'application/x-www-form-urlencoded'}} : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(35000, deadline - now())))]),
      });
    } catch { signal.throwIfAborted(); throw new Error('cloud115_auth network_failed'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('cloud115_auth invalid_response'); }
    if (!response.ok) throw new Error('cloud115_auth HTTP ' + response.status);
    if (result.code || result.errno || result.error || !result.data || typeof result.data !== 'object') {
      const code = Number(result.code || result.errno);
      throw new Error('cloud115_auth provider_error' + (Number.isSafeInteger(code) ? ' code=' + code : ''));
    }
    return result.data;
  };
  const device = await request(PASSPORT + 'authDeviceCode', {
    client_id: clientId, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64'), code_challenge_method: 'sha256',
  });
  let url;
  try { url = new URL(device.qrcode); } catch { throw new Error('cloud115_auth invalid_response'); }
  if (!['https:', 'http:'].includes(url.protocol) || !(url.hostname === '115.com' || url.hostname.endsWith('.115.com')) || url.username || url.password || url.port || url.hash || url.href.length > 2048 || typeof device.uid !== 'string' || !device.uid || typeof device.sign !== 'string' || !device.sign || !Number.isSafeInteger(Number(device.time))) throw new Error('cloud115_auth invalid_response');
  const qrImage = await renderQR(url.href, {type: 'image/png', width: 256, margin: 2, errorCorrectionLevel: 'M'});
  signal.throwIfAborted();
  await onCode({qrImage});
  let scanned = false;
  while (now() < deadline) {
    await wait(Math.min(2000, deadline - now()), undefined, {signal});
    signal.throwIfAborted();
    if (now() >= deadline) break;
    const status = await request(STATUS, {uid: device.uid, time: String(device.time), sign: device.sign}, false);
    if (status.status === -1) throw new Error('cloud115_auth expired_token');
    if (status.status === -2) throw new Error('cloud115_auth access_denied');
    if (status.status === 1 && !scanned) { scanned = true; await onScanned(); }
    if ([0, 1].includes(status.status)) continue;
    if (status.status !== 2) throw new Error('cloud115_auth invalid_response');
    const token = await request(PASSPORT + 'deviceCodeToToken', {uid: device.uid, code_verifier: verifier});
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('cloud115_auth invalid_response');
    signal.throwIfAborted();
    return {access_token: token.access_token, refresh_token: token.refresh_token, token_type: 'Bearer', expiry: new Date(now() + Math.min(token.expires_in, 90 * 86400) * 1000).toISOString()};
  }
  throw new Error('cloud115_auth expired_token');
}
module.exports = {authorize115};
