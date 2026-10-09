'use strict';
const crypto = require('node:crypto');
const {rc, delay} = require('./processes.cjs');
const {safeName} = require('./manager.cjs');

const TEMPLATE = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>云屿 · 账号连接</title><body style="font:16px system-ui;background:#f5f7fa;text-align:center;padding:15vh 20px;color:#253044"><h1>{{if .OK}}已完成授权{{else}}授权未完成{{end}}</h1><p>{{if .OK}}请返回云屿，继续连接你的存储。{{else}}请返回云屿，重新尝试连接。{{end}}</p></body></html>';
const labels = {config_type: '选择账户类型', config_driveid: '选择要连接的磁盘', config_drive_id: '选择要连接的磁盘', drive_id: '选择要连接的磁盘', config_driveok: '确认连接这个磁盘？', config_team_drive: '是否连接共享云端硬盘？', config_team_drive_id: '选择共享云端硬盘', config_site: '选择站点', config_site_url: '输入站点地址', config_region: '选择账户所在区域'};
const scrub = s => String(s || '').replace(/rclone|juicefs/ig, '云屿');

function installAccounts(Manager) {
  Manager.prototype.connect = async function(input) {
    if (this.auth) throw new Error('请先完成或取消当前连接');
    const name = safeName(input.name), type = input.type;
    if (!['webdav', 's3', 'onedrive', 'drive', 'dropbox'].includes(type)) throw new Error('暂不支持这个服务');
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
      Object.assign(parameters, {client_id: app.clientId, client_secret: app.clientSecret || ''});
      if (type === 'drive') parameters.scope = 'drive';
    }
    const a = {id: crypto.randomUUID(), name, type, remote: 'ci_' + crypto.randomBytes(10).toString('hex'), status: 'connecting', parameters, started: Date.now()};
    this.auth = a; this.emit('change');
    this.advanceAuth(a, 'config/create', {name: a.remote, type, parameters, opt: {nonInteractive: true, obscure: true}}).catch(e => this.authFailure(a, e));
    return a.id;
  };
  Manager.prototype.authFailure = function(a, error) {
    if (this.auth !== a || a.cancelled) return;
    a.status = 'error'; a.error = '连接未完成。请检查账号、服务地址或网络，再重新尝试。';
    // Credentials and authorization URLs intentionally never enter logs or snapshots.
    this.emit('change');
  };
  Manager.prototype.advanceAuth = async function(a, method, body) {
    const r = await this.accounts(); if (this.auth !== a || a.cancelled) return;
    const job = await (a.launching = rc(r, method, {...body, _async: true})); a.launching = null; a.jobId = job.jobid;
    let result;
    for (;;) {
      if (a.cancelled) return;
      if (Date.now() - a.started > 10 * 60 * 1000) {await rc(r, 'config/oauthstop').catch(() => {}); throw new Error('登录超时');}
      const status = await rc(r, 'job/status', {jobid: a.jobId});
      if (status.finished) {if (!status.success) throw new Error(status.error); result = status.output || {}; break;}
      const oauth = await rc(r, 'config/oauthstatus');
      if (oauth.status === 'running' && oauth.authUrl && oauth.authUrl !== a.openedUrl) {
        const url = new URL(oauth.authUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '53682' || url.pathname !== '/auth') throw new Error('登录回调地址异常');
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
      a.state = result.State;
      if (option.Name === 'config_is_local') return this.advanceAuth(a, 'config/update', {name: a.remote, parameters: a.parameters, opt: {nonInteractive: true, continue: true, state: a.state, result: 'true'}});
      if (['config_token', 'config_verification_code'].includes(option.Name)) throw new Error('此服务的登录方式暂不支持');
      a.status = 'question'; a.error = result.Error ? '上一步未通过，请重新选择。' : '';
      a.option = option;
      a.question = {label: labels[option.Name] || '完成账户设置', required: !!option.Required, password: !!option.IsPassword, type: option.Type,
        value: String(option.Default ?? ''), exclusive: !!option.Exclusive,
        choices: (option.Examples || []).map(v => ({value: String(v.Value), label: scrub(v.Help || v.Value)}))};
      this.emit('change'); return;
    }
    a.status = 'checking'; this.emit('change');
    await rc(r, 'operations/list', {fs: a.remote + ':', remote: '', opt: {dirsOnly: true}}, 45000);
    if (a.cancelled || this.auth !== a) return;
    this.state.connections.push({id: a.id, name: a.name, type: a.type, remote: a.remote, source: a.remote + ':', folder: ''});
    this.auth = null; this.save();
  };
  Manager.prototype.answerAuth = async function(id, value) {
    const a = this.auth;
    if (!a || a.id !== id || a.status !== 'question') throw new Error('连接步骤已经改变，请重新打开');
    if (typeof value !== 'string' || value.length > 4096 || (a.question.required && !value)) throw new Error('请填写有效内容');
    if (a.question.exclusive && a.question.choices.length && !a.question.choices.some(v => v.value === value)) throw new Error('请选择提供的选项');
    a.status = 'connecting'; a.question = null; this.emit('change');
    this.advanceAuth(a, 'config/update', {name: a.remote, parameters: a.parameters, opt: {nonInteractive: true, continue: true, state: a.state, result: value}}).catch(e => this.authFailure(a, e));
  };
  Manager.prototype.cancelAuth = async function() {
    const a = this.auth; if (!a) return;
    a.cancelled = true; const r = await this.accounts();
    if (a.launching) {const job = await a.launching.catch(() => null); if (job) a.jobId = job.jobid;}
    await rc(r, 'config/oauthstop').catch(() => {});
    if (a.jobId) {
      await rc(r, 'job/stop', {jobid: a.jobId}).catch(() => {});
      for (let i = 0; i < 30; i++) {const status = await rc(r, 'job/status', {jobid: a.jobId}); if (status.finished) break; await delay(200); if (i === 29) {a.cancelled = false; throw new Error('正在结束登录，请稍后重试');}}
    }
    await rc(r, 'config/delete', {name: a.remote}); this.auth = null; this.emit('change');
  };
}
module.exports = {installAccounts, TEMPLATE};
