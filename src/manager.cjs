'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const P = require('./processes.cjs');
const plan = require('./plans.cjs');
const uid = () => crypto.randomUUID();
const key = () => crypto.randomBytes(32).toString('hex');

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {mode: 0o600}); fs.renameSync(tmp, file);
}
function read(file, fallback) {return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;}
function safeName(value) {const s = String(value || '').trim(); if (!s || s.length > 48) throw new Error('请填写 1–48 个字符的名称'); return s;}
function directoryExists(p) {try {return fs.statSync(p).isDirectory();} catch {return false;}}
function containsPath(base, target) {const r = path.relative(base, target); return !r || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));}
function displayError(message) {return /rclone|juicefs|token|secret|password|Authorization|client_id|access_key/i.test(message || '') ? '连接或磁盘操作未完成。请检查网络、账号信息与磁盘驱动后重试。' : String(message || '').replace(/https?:\/\/[^\s]+/g, '[服务地址]').slice(0,500);}

class Manager extends EventEmitter {
  constructor({root, engines, protect, unprotect, oauthClients = {}, openExternal = async () => {}, platform = process.platform}) {
    super(); Object.assign(this, {root, engines, protect, unprotect, oauthClients, openExternal, platform});
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    this.file = path.join(root, 'disks.json'); this.config = path.join(root, 'accounts.conf');
    this.state = read(this.file, {version: 1, connections: [], disks: [], settings: {loginStart: false}});
    this.runtime = new Map(); this.busy = new Set(); this.polling = false;
    const secFile = path.join(root, 'credentials.json');
    this.secrets = fs.existsSync(secFile) ? JSON.parse(unprotect(read(secFile).data)) : {configPass: key(), disks: {}};
    this.saveSecrets();
    this.health = {windows: platform === 'win32', winfsp: false};
    this.auth = null; this.accountServer = null;
  }
  save() {atomic(this.file, this.state); this.emit('change');}
  saveSecrets() {atomic(path.join(this.root, 'credentials.json'), {data: this.protect(JSON.stringify(this.secrets))});}
  saveRuntime() {
    const records = [...this.runtime].map(([id, r]) => ({id, rcPort: r.rcPort, rcPass: r.rcPass, metricsPort: r.metricsPort,
      pid: r.proc?.pid, jfsPid: r.jfs?.pid, status: r.status, error: r.error, everMounted: r.everMounted}));
    atomic(path.join(this.root, 'sessions.json'), {data: this.protect(JSON.stringify(records))});
  }
  paths(d) {const dir = path.join(this.root, 'volumes', d.id); return {dir, cache: path.join(dir, 'cache'), meta: path.join(dir, 'meta.db'), log: path.join(dir, 'engine.log'), jfsLog: path.join(dir, 'volume.log')};}
  engine(name) {return path.join(this.engines, name + (this.platform === 'win32' ? '.exe' : ''));}
  disk(id) {const d = this.state.disks.find(d => d.id === id); if (!d) throw new Error('找不到此磁盘'); return d;}
  connection(id) {const c = this.state.connections.find(c => c.id === id); if (!c) throw new Error('找不到此存储连接'); return c;}
  env(extra = {}) {return {RCLONE_CONFIG_PASS: this.secrets.configPass, ...extra};}
  async locked(id, fn) {if (this.busy.has(id)) throw new Error('此磁盘正在处理上一个操作'); this.busy.add(id); try {return await fn();} finally {this.busy.delete(id); this.emit('change');}}

  async init() {
    for (const n of ['rclone', 'juicefs']) if (!fs.existsSync(this.engine(n))) throw new Error('软件组件不完整，请重新解压完整安装包');
    if (!fs.existsSync(this.config)) {
      fs.writeFileSync(this.config, '', {mode: 0o600});
      const command = this.platform === 'win32' ? 'powershell.exe -NoProfile -NonInteractive -Command "[Console]::Write($env:RCLONE_CONFIG_PASS)"' : '/usr/bin/printenv RCLONE_CONFIG_PASS';
      try {await P.run(this.engine('rclone'), ['config', 'encryption', 'set', '--config', this.config, '--password-command', command], {env: this.env()});}
      catch (e) {fs.unlinkSync(this.config); throw e;}
    }
    if (this.platform === 'win32') {
      const base = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      this.health.winfsp = fs.existsSync(path.join(base, 'WinFsp', 'bin', 'winfsp-x64.dll'));
      if (!this.health.winfsp) {try {const out = await P.run('reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\WinFsp', '/v', 'InstallDir']); const m = out.match(/REG_SZ\s+(.+)/); this.health.winfsp = !!m && fs.existsSync(path.join(m[1].trim(), 'bin', 'winfsp-x64.dll'));} catch {}}
    }
    // Adopt surviving sessions after a UI crash; authenticated RC prevents adopting an unrelated service.
    const journal = read(path.join(this.root, 'sessions.json'), null);
    if (journal) for (const record of JSON.parse(this.unprotect(journal.data))) {
      if (!this.state.disks.some(d => d.id === record.id)) continue;
      if (!P.alive(record.pid) && !P.alive(record.jfsPid)) continue;
      const r = {...record, proc: record.pid ? {pid: record.pid} : null, jfs: record.jfsPid ? {pid: record.jfsPid} : null, stats: {known: false}};
      try {await P.rc(r, 'core/pid'); r.status = record.status === 'mounted' ? 'mounted' : 'error'; if (r.status === 'error') r.error = '上次操作被中断，请先安全卸载，再重新挂载';}
      catch {r.status = 'error'; r.error = '上次会话的后台进程仍在运行但暂时无法连接；已保留缓存与元数据';}
      this.runtime.set(record.id, r);
    }
    await this.poll();
    this.timer = setInterval(() => this.poll().catch(() => {}), 3000);
    this.timer.unref();
  }
  snapshot() {
    return {version: '0.1.2', health: this.health, settings: this.state.settings, root: this.root,
      services: [
        {id: 'local', name: '本地文件夹', available: true}, {id: 'webdav', name: 'WebDAV', available: true},
        {id: 's3', name: 'S3 兼容存储', available: true},
        ...['onedrive', 'drive', 'dropbox'].map(id => ({id, name: {onedrive: 'OneDrive', drive: 'Google Drive', dropbox: 'Dropbox'}[id], available: !!this.oauthClients[id]?.clientId}))],
      connections: this.state.connections.map(c => ({id: c.id, name: c.name, type: c.type, folder: c.folder || '/', localPath: c.type === 'local' ? c.source : undefined})),
      disks: this.state.disks.map(d => {const r = this.runtime.get(d.id); return {...d, lastError: displayError(d.lastError), paths: this.paths(d), status: r?.status || 'unmounted', error: displayError(r?.error), stats: r?.stats || null, busy: this.busy.has(d.id)};}),
      auth: this.auth ? {id: this.auth.id, status: this.auth.status, service: this.auth.type, question: this.auth.question, error: this.auth.error} : null};
  }
  async addLocal(input) {
    const name = safeName(input.name), source = path.resolve(String(input.path || ''));
    if (!input.path || !directoryExists(source)) throw new Error('请选择一个已存在的本地文件夹');
    if (containsPath(this.root, source) || containsPath(source, this.root)) throw new Error('请选择不包含软件数据目录的独立文件夹');
    const c = {id: uid(), name, type: 'local', source}; this.state.connections.push(c); this.save(); return c.id;
  }
  async deleteConnection(id) {
    if (this.state.disks.some(d => d.connectionId === id)) throw new Error('请先移除使用此连接的磁盘');
    const c = this.connection(id);
    if (c.type !== 'local') {const r = await this.accounts(); await P.rc(r, 'config/delete', {name: c.remote});}
    this.state.connections = this.state.connections.filter(c => c.id !== id); this.save();
  }
  async listFolders(id, relative = '') {
    const c = this.connection(id);
    if (typeof relative !== 'string' || relative.split(/[\\/]/).includes('..') || /^[\\/]/.test(relative)) throw new Error('无效文件夹路径');
    const r = await this.accounts();
    const result = await P.rc(r, 'operations/list', {fs: c.type === 'local' ? c.source : c.remote + ':', remote: relative, opt: {dirsOnly: true}}, 30000);
    return (result.list || []).map(x => ({name: x.Name, path: x.Path}));
  }
  async setFolder(id, relative) {
    const c = this.connection(id);
    if (this.state.disks.some(d => d.connectionId === id)) throw new Error('连接已用于磁盘，请在添加磁盘前选择目录');
    if (c.type === 'local') throw new Error('本地目录请重新选择文件夹');
    if (typeof relative !== 'string' || relative.split(/[\\/]/).includes('..') || /^[\\/]/.test(relative)) throw new Error('无效文件夹路径');
    c.folder = relative; c.source = c.remote + ':' + relative; this.save();
  }
  async testConnection(id) {
    const c = this.connection(id), r = await this.accounts();
    await P.rc(r, 'operations/list', {fs: c.source, remote: '', opt: {dirsOnly: true}}, 30000);
    return true;
  }
  async addDisk(input) {
    this.connection(input.connectionId);
    const d = {id: uid(), ...plan.validateDisk(input, this.state.disks), connectionId: input.connectionId, initialized: false};
    const paths = this.paths(d); fs.mkdirSync(paths.cache, {recursive: true, mode: 0o700});
    this.state.disks.push(d); this.save(); return d.id;
  }
  async updateDisk(id, input) {
    const d = this.disk(id); if (this.runtime.has(id)) throw new Error('请先卸载磁盘再调整设置');
    if (typeof input.autoMount === 'boolean') d.autoMount = input.autoMount;
    if (input.cacheGiB !== undefined) d.cacheGiB = plan.validateDisk({...d, cacheGiB: input.cacheGiB}, []).cacheGiB;
    this.save();
  }
  async removeDisk(id) {
    if (this.runtime.has(id) || this.busy.has(id)) throw new Error('请先安全卸载磁盘');
    const d = this.disk(id);
    // Archive only. Never delete metadata, staging cache, or remote objects through the UI.
    atomic(path.join(this.paths(d).dir, 'archived-disk.json'), d);
    this.state.disks = this.state.disks.filter(x => x.id !== id); this.save();
  }
  async mount(id) {
    return this.locked(id, async () => {
      const d = this.disk(id), c = this.connection(d.connectionId), p = this.paths(d);
      if (this.runtime.has(id)) throw new Error('此磁盘已有后台会话，请先安全卸载');
      if (this.platform !== 'win32') throw new Error('此发行版仅支持 Windows 挂载');
      if (!this.health.winfsp) throw new Error('请先安装磁盘驱动，然后重新打开云屿');
      if (fs.existsSync(d.letter + '\\')) throw new Error('此盘符已被占用，请使用其他盘符');
      // Prevent two writable direct mounts from using independent caches against the same source.
      if (d.mode === 'direct' && [...this.runtime.keys()].some(i => {const other = this.disk(i); return other.mode === 'direct' && this.connection(other.connectionId).source === c.source;})) throw new Error('这个存储目录已经挂载，请使用已有磁盘');
      const r = {status: 'starting', rcPort: await P.freePort(), rcPass: key(), stats: {known: false}, everMounted: false};
      this.runtime.set(id, r); this.emit('change');
      try {
        fs.mkdirSync(p.cache, {recursive: true, mode: 0o700});
        if (d.mode === 'direct') {
          r.proc = this.spawn(id, 'rclone', ['rcd', '--rc-addr', `127.0.0.1:${r.rcPort}`, '--rc-user', 'cloud-island', '--config', this.config, '--cache-dir', p.cache, '--log-level', 'INFO'], p.log, this.env({RCLONE_RC_PASS: r.rcPass}));
          this.saveRuntime(); await P.waitFor(async () => {await P.rc(r, 'core/pid'); return true;});
          await P.rc(r, 'mount/mount', plan.directMountBody(d, c), 60000);
          r.everMounted = true;
        } else {
          if (d.gatewayPort) await P.freePort(d.gatewayPort); else {d.gatewayPort = await P.freePort(); this.save();}
          r.metricsPort = await P.freePort();
          if (!this.secrets.disks[id]) {this.secrets.disks[id] = {access: 'ci' + id.replaceAll('-', '').slice(0, 18), secret: key()}; this.saveSecrets();}
          const credentials = this.secrets.disks[id], root = plan.backendRoot(c, id);
          if (c.type === 'local') fs.mkdirSync(root, {recursive: true});
          r.proc = this.spawn(id, 'rclone', plan.gatewayArgs(root, d.gatewayPort, r.rcPort, path.join(p.dir, 'gateway-cache'), this.config), p.log,
            this.env({RCLONE_RC_PASS: r.rcPass, RCLONE_AUTH_KEY: `"${credentials.access},${credentials.secret}"`}));
          this.saveRuntime();
          await P.waitFor(async () => {await P.rc(r, 'core/pid'); const s = await fetch(`http://127.0.0.1:${d.gatewayPort}/`, {signal: AbortSignal.timeout(1500)}); return [400,401,403].includes(s.status) && /<Code>(UnsupportedAlgorithm|AccessDenied)<\/Code>/.test(await s.text());});
          if (!d.initialized) {
            if (fs.existsSync(p.meta)) throw new Error('发现已有元数据但初始化记录不完整，已停止自动操作。请保留数据目录并检查。');
            await P.run(this.engine('juicefs'), plan.formatArgs(d.gatewayPort, 'ci' + id.replaceAll('-', '').slice(0, 20)), {cwd: p.dir,
              env: {ACCESS_KEY: credentials.access, SECRET_KEY: credentials.secret}, timeout: 120000});
            d.initialized = true; this.save();
          } else if (!fs.existsSync(p.meta)) throw new Error('卷的元数据文件丢失，不能自动新建覆盖');
          r.jfs = this.spawn(id, 'juicefs', plan.juiceMountArgs(d, p, r.metricsPort), p.jfsLog, {}, true);
          this.saveRuntime();
          await P.waitFor(() => fs.existsSync(d.letter + '\\.config') && P.alive(r.jfs.pid), 45000);
          r.everMounted = true;
        }
        r.status = 'mounted'; r.error = ''; d.lastError = ''; this.save(); this.saveRuntime(); await this.poll();
      } catch (e) {
        r.status = 'error'; r.error = e.message;
        // A partially created mount may still own data. Never kill a mount on a timeout.
        if (!r.jfs && !r.everMounted) {
          let hasMount = true;
          try {const list = await P.rc(r, 'mount/listmounts'); hasMount = (list.mountPoints || []).length > 0;} catch {}
          if (!hasMount) {try {await P.rc(r, 'core/quit'); await P.waitExit(r.proc, 10000); this.runtime.delete(id);} catch {}}
        }
        d.lastError = e.message; this.save(); this.saveRuntime(); throw e;
      }
    });
  }
  spawn(id, name, args, logfile, env, jfs = false) {
    const d = this.disk(id), r = this.runtime.get(id);
    return P.launch(this.engine(name), args, {cwd: this.paths(d).dir, env, logfile, secrets: [r.rcPass, this.secrets.configPass, this.secrets.disks[id]?.secret], onExit: code => {
      if (!['stopping', 'unmounted'].includes(r.status)) {r.status = 'error'; r.error = jfs ? '磁盘服务已退出。缓存与元数据已保留，可尝试安全卸载后重新挂载。' : '存储连接已中断。请先停止文件写入，再检查连接。'; this.emit('change');}
    }});
  }
  async poll() {
    if (this.polling || this.runtime.size === 0) return; this.polling = true;
    try {await Promise.allSettled([...this.runtime].map(async ([id, r]) => {
      if (!['mounted', 'error'].includes(r.status)) return;
      const d = this.disk(id);
      try {
        const core = await P.rc(r, 'core/stats');
        if (d.mode === 'direct') {
          const [vfs, result] = await Promise.all([P.rc(r, 'vfs/stats'), P.rc(r, 'vfs/queue')]);
          const queue = result.queue || [];
          r.stats = {known: true, checkedAt: Date.now(), speed: core.speed || 0, transferring: core.transferring || [], cacheBytes: vfs.diskCache?.bytesUsed ?? null,
            pendingFiles: queue.length, queuedBytes: queue.reduce((n, x) => n + x.size, 0), queue, vfs, errors: core.errors || 0};
        } else {
          if (!P.alive(r.jfs?.pid)) throw new Error('磁盘服务已停止');
          const response = await fetch(`http://127.0.0.1:${r.metricsPort}/metrics`, {signal: AbortSignal.timeout(3500)});
          if (!response.ok) throw new Error('暂时无法读取磁盘状态');
          const m = plan.parseMetrics(await response.text());
          r.stats = {known: m.pendingBlocks !== null && m.pendingBytes !== null, checkedAt: Date.now(), speed: core.speed || 0, ...m, raw: undefined};
        }
        if (r.status === 'mounted') r.error = '';
      } catch (e) {r.stats = {...r.stats, known: false}; if (r.status === 'mounted') {r.error = '暂时无法读取实时状态，请检查连接';}}
    })); this.emit('change');} finally {this.polling = false;}
  }
  async dirtyMetadata(dir) {
    let dirty = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const e of await fsp.readdir(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error('缓存目录结构异常，已停止卸载');
      if (e.isDirectory()) dirty += await this.dirtyMetadata(p);
      else {let v; try {v = JSON.parse(await fsp.readFile(p, 'utf8'));} catch (err) {if (err.code === 'ENOENT') continue; throw new Error('暂时无法确认缓存状态，请稍后重试');} if (v.Dirty) dirty++;}
    }
    return dirty;
  }
  async unmount(id) {
    return this.locked(id, async () => {
      const d = this.disk(id), r = this.runtime.get(id); if (!r) return;
      const p = this.paths(d);
      // Fresh checks, not UI snapshots. The user is asked to close applications before this action.
      if (d.mode === 'direct' && P.alive(r.proc?.pid)) {
        const mounts = await P.rc(r, 'mount/listmounts');
        if ((mounts.mountPoints || []).some(m => m.MountPoint === d.letter || m.mountPoint === d.letter)) {
          for (let i = 0; i < 2; i++) {
            const [stats, queue] = await Promise.all([P.rc(r, 'vfs/stats'), P.rc(r, 'vfs/queue')]);
            const pending = plan.pendingDirect(stats, queue.queue || []);
            if (!pending.known || pending.pending || await this.dirtyMetadata(path.join(p.cache, 'vfsMeta'))) throw new Error('还有未完成的上传或文件正在写入。请关闭使用此磁盘的程序，等待上传完成后重试。');
            if (i === 0) await P.delay(1000);
          }
          r.status = 'stopping'; this.emit('change');
          try {await P.rc(r, 'mount/unmount', {mountPoint: d.letter}, 45000);} catch (e) {r.status = 'error'; r.error = '磁盘仍在使用，未强制结束进程'; throw e;}
        }
      } else if (d.mode === 'juicefs' && P.alive(r.jfs?.pid)) {
        r.status = 'stopping'; this.emit('change');
        try {await P.run(this.engine('juicefs'), ['umount', '--flush', d.letter], {cwd: p.dir, timeout: 120000}); await P.waitExit(r.jfs, 60000);}
        catch (e) {r.status = 'error'; r.error = '卸载未完成，存储连接仍在运行。请关闭文件并等待上传结束。'; throw e;}
      }
      r.status = 'stopping';
      if (P.alive(r.proc?.pid)) {await P.rc(r, 'core/quit'); await P.waitExit(r.proc, 15000);}
      r.status = 'unmounted'; this.runtime.delete(id); d.lastError = ''; this.save(); this.saveRuntime();
    });
  }
  async shutdown() {
    if (this.busy.size) throw new Error('还有操作正在进行，请稍后退出');
    if (this.auth) throw new Error('请先完成或取消账号连接');
    for (const id of [...this.runtime.keys()]) await this.unmount(id);
    if (this.accountServer) {await P.rc(this.accountServer, 'core/quit'); await P.waitExit(this.accountServer.proc, 10000); this.accountServer = null;}
    clearInterval(this.timer);
  }
  async accounts() {
    if (this.accountServer) return this.accountServer;
    if (this.accountsStarting) return this.accountsStarting;
    this.accountsStarting = (async () => {
      const journal = read(path.join(this.root, 'account-session.json'), null);
      if (journal) {
        const saved = JSON.parse(this.unprotect(journal.data));
        if (P.alive(saved.pid)) {
          const previous = {...saved, proc: {pid: saved.pid}};
          try {await P.rc(previous, 'core/pid'); await P.rc(previous, 'config/oauthstop').catch(() => {}); this.accountServer = previous; return previous;} catch {}
        }
      }
      const r = {rcPort: await P.freePort(), rcPass: key()};
      r.proc = P.launch(this.engine('rclone'), ['rcd', '--rc-addr', `127.0.0.1:${r.rcPort}`, '--rc-user', 'cloud-island', '--config', this.config, '--log-level', 'ERROR'],
        {cwd: this.root, env: this.env({RCLONE_RC_PASS: r.rcPass}), logfile: path.join(this.root, 'accounts.log'), secrets: [r.rcPass, this.secrets.configPass], onExit: () => {this.accountServer = null;}});
      atomic(path.join(this.root, 'account-session.json'), {data: this.protect(JSON.stringify({pid: r.proc.pid, rcPort: r.rcPort, rcPass: r.rcPass}))});
      await P.waitFor(async () => {await P.rc(r, 'core/pid'); return true;}); this.accountServer = r; return r;
    })();
    try {return await this.accountsStarting;} finally {this.accountsStarting = null;}
  }
}

module.exports = {Manager, atomic, read, safeName};
