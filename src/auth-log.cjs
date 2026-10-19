'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 1024 * 1024;
const BACKUPS = 3;
const OAUTH_ERRORS = ['invalid_client', 'invalid_grant', 'invalid_request', 'invalid_scope', 'unauthorized_client', 'access_denied', 'authorization_declined', 'expired_token', 'interaction_required', 'consent_required', 'login_required', 'temporarily_unavailable', 'server_error'];
const NETWORK_ERRORS = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'];

// Retain diagnostic identifiers, never arbitrary provider text. Error bodies may
// contain tokens, authorization codes, headers, account names or private URLs.
function errorDetails(error) {
  const chain=[], causeCodes=[];
  for(let e=error, i=0;e&&i<4;e=e.cause,i++) {chain.push(String(e.message||e));causeCodes.push(e.code);}
  const raw=chain.join('\n');
  const microsoftCodes=[...new Set(raw.match(/\bAADSTS\d{4,10}\b/g)||[])];
  const oauthErrors=OAUTH_ERRORS.filter(code=>new RegExp('\\b'+code+'\\b','i').test(raw));
  const networkCodes=NETWORK_ERRORS.filter(code=>raw.includes(code)||causeCodes.includes(code));
  let category='unknown';
  if (/failed to get token/i.test(raw)) category='token_exchange';
  else if (/baidu_auth|cloud115_auth/.test(raw)) category='device_authorization';
  else if (/failed to refresh token/i.test(raw)) category='authorization_callback';
  else if (/failed to query.*drive|failed to query root|failed to configure OneDrive/i.test(raw)) category='drive_discovery';
  if(category==='unknown'&&/timeout|timed out|fetch failed|connectex|no such host|TLS handshake/i.test(raw)) category='network';
  if(category==='unknown'&&/登录超时/.test(raw)) category='authorization_timeout';
  const status=raw.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?|cannot fetch token)[\s:=]+([45]\d\d)\b/i)?.[1];
  const detail={category,microsoftCodes,oauthErrors,networkCodes};
  const providerCode=raw.match(/\bcloud115(?:_auth|:)[^\n]*?\bcode=(\d{1,10})\b/)?.[1];
  if(providerCode)detail.providerCode=Number(providerCode);
  if(status)detail.httpStatus=Number(status);
  for(const [field,label] of [['traceId','Trace ID'],['correlationId','Correlation ID']]) {
    const value=raw.match(new RegExp(label+':\\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})','i'))?.[1];
    if(value)detail[field]=value;
  }
  return detail;
}

function appendAuthLog(root, record) {
  try {
    const file=path.join(root,'auth.log');
    const line=JSON.stringify({time:new Date().toISOString(),...record})+'\n';
    if(Buffer.byteLength(line)>16384)return false;
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)>MAX_BYTES) {
      fs.rmSync(file+'.'+BACKUPS,{force:true});
      for(let i=BACKUPS-1;i>=1;i--)if(fs.existsSync(file+'.'+i))fs.renameSync(file+'.'+i,file+'.'+(i+1));
      fs.renameSync(file,file+'.1');
    }
    fs.appendFileSync(file,line,{mode:0o600});
    return true;
  } catch {return false;} // Diagnostics must not abort login or safe cancellation.
}

module.exports={appendAuthLog,errorDetails,MAX_BYTES,BACKUPS};
