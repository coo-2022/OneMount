'use strict';
const crypto = require('node:crypto');
const {rc, delay} = require('./processes.cjs');
const {safeName} = require('./manager.cjs');
const {appendAuthLog, errorDetails} = require('./auth-log.cjs');
const {authorizeBaidu} = require('./baidu-auth.cjs');
const {authorize115} = require('./cloud115-auth.cjs');

const TEMPLATE = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>云屿 · 账号连接</title><body style="font:16px system-ui;background:#f5f7fa;text-align:center;padding:15vh 20px;color:#253044"><h1>{{if .OK}}已收到登录回调{{else}}授权未完成{{end}}</h1><p>{{if .OK}}请返回云屿，等待账户验证并完成网盘选择。最终连接结果以云屿窗口为准。{{else}}请返回云屿，重新尝试连接。{{end}}</p></body></html>';
const labels = {config_type: '选择账户类型', config_driveid: '选择要连接的磁盘', config_drive_id: '选择要连接的磁盘', drive_id: '选择要连接的磁盘', config_driveok: '确认连接这个磁盘？', config_team_drive: '是否连接共享云端硬盘？', config_team_drive_id: '选择共享云端硬盘', config_site: '选择站点', config_site_url: '输入站点地址', config_region: '选择账户所在区域'};
const scrub = s => String(s || '').replace(/rclone|juicefs/ig, '云屿');

// Map known errors to fixed user messages. Never expose raw provider responses,
// authorization URLs, codes or tokens to the renderer.
function authErrorMessage(error) {
  const raw = String(error?.message || '');
  if (/cloud115_auth|cloud115:/.test(raw)) {
    if (/expired_token/.test(raw)) return '115 授权二维码已过期，请返回后重新连接。';
    if (/access_denied/.test(raw)) return '115 授权已取消，请返回后重新扫码。';
    if (/invalid_client/.test(raw)) return '115 应用尚未配置有效的 App ID，请检查开放平台应用配置。';
    if (/authorization/.test(raw)) return '115 登录授权已失效，请重新连接账号。';
    return '暂时无法连接 115，请检查网络及开放平台应用权限后重试。';
  }
  if (/baidu_auth/.test(raw)) {
    if (/invalid_client/.test(raw)) return '百度应用身份验证未通过，请检查应用的 AppKey 和 SecretKey。';
    if (/expired_token|invalid_grant/.test(raw)) return '百度授权码已过期，请返回后重新连接。';
    if (/access_denied|authorization_declined/.test(raw)) return '百度网盘授权未获同意，请返回后重新授权。';
    if (/invalid_scope/.test(raw)) return '百度应用尚未获得网盘访问权限，请检查应用设置。';
    return '暂时无法完成百度授权，请检查网络和百度应用配置后重试。';
  }
  const code = raw.match(/\bAADSTS\d+\b/)?.[0];
  const suffix = code ? `（${code}）` : '';
  if (code === 'AADSTS7000218') return '微软应用要求客户端凭据，当前桌面登录配置不匹配。请检查应用注册中的“移动和桌面应用”及公共客户端设置。' + suffix;
  if (code === 'AADSTS50011') return '微软应用的回调地址不匹配，请检查是否已注册 http://localhost:53682/。' + suffix;
  if (code === 'AADSTS700016') return '微软未找到当前应用，请检查应用 ID 和允许登录的账户类型。' + suffix;
  if (['AADSTS9002325', 'AADSTS9002326', 'AADSTS9002327'].includes(code)) return '微软应用的登录平台与桌面程序不匹配，请检查应用注册中的平台配置。' + suffix;
  if (/invalid_client/i.test(raw)) return '微软应用身份验证未通过，请检查应用注册及客户端配置。' + suffix;
  if (/invalid_grant|expired.*code|code.*expired/i.test(raw)) return '登录凭据已失效或无法使用，请取消本次连接后重新登录。' + suffix;
  if (/access_denied|authorization_requestdenied|insufficient.*permission/i.test(raw)) return '账户未授予所需访问权限，请检查授权或联系组织管理员。' + suffix;
  if (/timeout|timed out|fetch failed|connectex|ECONN|ENOTFOUND|no such host|TLS handshake/i.test(raw)) return '连接身份服务或网盘时网络请求失败，请检查网络或代理后重试。' + suffix;
  if (/failed to get token/i.test(raw)) return '已收到登录回调，但未能取得访问凭据。请检查微软应用的桌面登录配置后重试。' + suffix;
  return '连接未完成，请检查账号、服务地址或网络后重试。' + suffix;
}

function installAccounts(Manager) {
  Manager.prototype.logAuth = function(a, event, detail = {}) {
    // Every detail below is an explicitly selected diagnostic field. Never pass
    // request/response bodies, option values, connection names or OAuth URLs.
    appendAuthLog(this.root, {event, attemptId:a.id, service:a.type,
      stage:a.stage||'initializing', elapsedMs:Math.max(0,Date.now()-a.started), ...detail});
  };
  Manager.prototype.connect = async function(input) {
    if (this.auth) throw new Error('请先完成或取消当前连接');
    const name = safeName(input.name), type = input.type;
    if (!['webdav', 's3', 'onedrive', 'drive', 'dropbox', 'baidu', 'cloud115'].includes(type)) throw new Error('暂不支持这个服务');
    const parameters = {config_auth_no_browser: 'true', config_template: TEMPLATE};
    if (['webdav', 's3'].includes(type)) {
      const url = new URL(String(input.url));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写 HTTP 或 HTTPS 服务地址，不要在地址中包含密码');
      if (type === 'webdav') Object.assign(parameters, {url: url.href, vendor: 'other', user: String(input.user || ''), pass: String(input.password || '')});
      else {
        if (!input.user || !input.password) throw new Error('请填写访问密钥和密钥密码');
        Object.assign(parameters, {provider: 'Other', env_auth: 'false', endpoint: url.href, access_key_id: String(input.user), secret_access_key: String(input.password), region: String(input.region || 'us-east-1'), force_path_style: 'true'});
      }
    } else {
      const app = this.oauthClients[type];
      if (!app?.clientId) throw new Error('此服务尚未开放登录，等待发布者完成授权接入');
      if (type === 'baidu' && !app.clientSecret) throw new Error('百度网盘的应用配置尚未完成');
      Object.assign(parameters, type === 'cloud115' ? {client_id: app.clientId} : {client_id: app.clientId, client_secret: app.clientSecret || ''});
      if (type === 'drive') parameters.scope = 'drive';
    }
    const a = {id: crypto.randomUUID(), name, type, remote: 'ci_' + crypto.randomBytes(10).toString('hex'), status: 'connecting', parameters, started: Date.now()};
    this.auth = a; this.emit('change');
    this.logAuth(a, 'connection_started');
    const start = () => this.advanceAuth(a, 'config/create', {name: a.remote, type, parameters, opt: {nonInteractive: true, obscure: true}});
    if (type === 'cloud115') {
      a.controller = new AbortController(); a.stage = 'qr_authorization';
      a.deviceTask = authorize115({clientId: parameters.client_id, signal: a.controller.signal,
        onCode: async device => {
          if (this.auth !== a || a.cancelled) return;
          a.device = device; a.status = 'qr_authorizing';
          this.logAuth(a, 'qr_authorization_started'); this.emit('change');
        },
        onScanned: () => {
          if (this.auth !== a || a.cancelled) return;
          a.status = 'qr_scanned'; this.emit('change');
        },
      }).then(async token => {
        if (this.auth !== a || a.cancelled) return;
        a.device = null; parameters.token = JSON.stringify(token);
        a.status = 'connecting'; this.logAuth(a, 'qr_authorization_succeeded'); this.emit('change');
        await start();
      }).catch(e => this.authFailure(a, e));
    } else if (type === 'baidu') {
      a.controller = new AbortController(); a.stage = 'device_authorization';
      a.deviceTask = authorizeBaidu({clientId: parameters.client_id, clientSecret: parameters.client_secret, signal: a.controller.signal,
        onCode: async device => {
          if (this.auth !== a || a.cancelled) return;
          a.device = device; a.status = 'device_authorizing';
          this.logAuth(a, 'device_authorization_started'); this.emit('change');
          await this.openExternal(device.verificationUrl);
        },
      }).then(async token => {
        if (this.auth !== a || a.cancelled) return;
        a.device = null; parameters.token = JSON.stringify(token);
        a.status = 'connecting'; this.logAuth(a, 'device_authorization_succeeded'); this.emit('change');
        await start();
      }).catch(e => this.authFailure(a, e));
    } else start().catch(e => this.authFailure(a, e));
    return a.id;
  };
  Manager.prototype.authFailure = function(a, error) {
    if (this.auth !== a || a.cancelled) return;
    this.logAuth(a, 'connection_failed', {jobId:a.jobId??null, error:errorDetails(error), message:authErrorMessage(error)});
    a.status = 'error'; a.error = authErrorMessage(error);
    // Credentials and authorization URLs intentionally never enter logs or snapshots.
    this.emit('change');
  };
  Manager.prototype.advanceAuth = async function(a, method, body) {
    a.stage = method === 'config/create' ? 'create_configuration' : 'continue_configuration';
    this.logAuth(a, 'configuration_started', {method});
    const r = await this.accounts(); if (this.auth !== a || a.cancelled) return;
    const job = await (a.launching = rc(r, method, {...body, _async: true})); a.launching = null; a.jobId = job.jobid;
    this.logAuth(a, 'job_started', {jobId:a.jobId});
    let result;
    for (;;) {
      if (a.cancelled) return;
      if (Date.now() - a.started > 10 * 60 * 1000) {await rc(r, 'config/oauthstop').catch(() => {}); throw new Error('登录超时');}
      const status = await rc(r, 'job/status', {jobid: a.jobId});
      if (status.finished) {
        this.logAuth(a, 'job_finished', {jobId:a.jobId, success:!!status.success});
        if (!status.success) throw new Error(status.error); result = status.output || {}; break;
      }
      const oauth = await rc(r, 'config/oauthstatus');
      if (oauth.status === 'running' && oauth.authUrl && oauth.authUrl !== a.openedUrl) {
        const url = new URL(oauth.authUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '53682' || url.pathname !== '/auth') throw new Error('登录回调地址异常');
        a.stage = 'browser_authorization';
        this.logAuth(a, 'browser_authorization_started');
        a.openedUrl = url.href; a.status = 'authorizing'; this.emit('change'); await this.openExternal(url.href);
      }
      await delay(500);
    }
    if (a.cancelled || this.auth !== a) return;
    a.jobId = null;
    // RC returns the ConfigOut fields at the top level. No raw provider prompts reach the renderer.
    if (result.State) {
      const option = result.Option;
      if (!option) throw new Error('账户设置响应不完整');
      if(result.Error)this.logAuth(a, 'configuration_rejected', {error:errorDetails(new Error(result.Error)),message:authErrorMessage(new Error(result.Error))});
      a.state = result.State;
      if (option.Name === 'config_is_local') return this.advanceAuth(a, 'config/update', {name: a.remote, parameters: a.parameters, opt: {nonInteractive: true, continue: true, state: a.state, result: 'true'}});
      if (['config_token', 'config_verification_code'].includes(option.Name)) throw new Error('此服务的登录方式暂不支持');
      a.status = 'question'; a.error = result.Error ? '上一步未通过，请重新选择。' : '';
      a.stage = 'account_selection';
      // Only known provider field names are retained; no question/answer data.
      const optionName=Object.hasOwn(labels,option.Name)?option.Name:'other';
      this.logAuth(a, 'account_selection_required', {option:optionName});
      a.option = option;
      a.question = {label: labels[option.Name] || '完成账户设置', required: !!option.Required, password: !!option.IsPassword, type: option.Type,
        value: String(option.Default ?? ''), exclusive: !!option.Exclusive,
        choices: (option.Examples || []).map(v => ({value: String(v.Value), label: scrub(v.Help || v.Value)}))};
      this.emit('change'); return;
    }
    a.stage = 'checking_storage'; this.logAuth(a, 'storage_check_started');
    a.status = 'checking'; this.emit('change');
    await rc(r, 'operations/list', {fs: a.remote + ':', remote: '', opt: {dirsOnly: true}}, 45000);
    if (a.cancelled || this.auth !== a) return;
    this.state.connections.push({id: a.id, name: a.name, type: a.type, remote: a.remote, source: a.remote + ':', folder: ''});
    this.auth = null; this.save();
    this.logAuth(a, 'connection_succeeded');
  };
  Manager.prototype.answerAuth = async function(id, value) {
    const a = this.auth;
    if (!a || a.id !== id || a.status !== 'question') throw new Error('连接步骤已经改变，请重新打开');
    if (typeof value !== 'string' || value.length > 4096 || (a.question.required && !value)) throw new Error('请填写有效内容');
    if (a.question.exclusive && a.question.choices.length && !a.question.choices.some(v => v.value === value)) throw new Error('请选择提供的选项');
    this.logAuth(a, 'account_selection_submitted');
    a.status = 'connecting'; a.question = null; this.emit('change');
    this.advanceAuth(a, 'config/update', {name: a.remote, parameters: a.parameters, opt: {nonInteractive: true, continue: true, state: a.state, result: value}}).catch(e => this.authFailure(a, e));
  };
  Manager.prototype.cancelAuth = async function() {
    const a = this.auth; if (!a) return;
    this.logAuth(a, 'cancellation_started');
    try {
    a.cancelled = true; a.controller?.abort(); const r = await this.accounts();
    if (a.launching) {const job = await a.launching.catch(() => null); if (job) a.jobId = job.jobid;}
    await rc(r, 'config/oauthstop').catch(() => {});
    if (a.jobId) {
      await rc(r, 'job/stop', {jobid: a.jobId}).catch(() => {});
      for (let i = 0; i < 30; i++) {const status = await rc(r, 'job/status', {jobid: a.jobId}); if (status.finished) break; await delay(200); if (i === 29) {a.cancelled = false; throw new Error('正在结束登录，请稍后重试');}}
    }
    await rc(r, 'config/delete', {name: a.remote}); this.auth = null; this.emit('change');
    this.logAuth(a, 'connection_cancelled');
    } catch(error) {
      this.logAuth(a, 'cancellation_failed', {error:errorDetails(error),message:authErrorMessage(error)});
      throw error;
    }
  };
}
module.exports = {installAccounts, TEMPLATE, authErrorMessage};
