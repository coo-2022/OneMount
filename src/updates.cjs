'use strict';

const {EventEmitter} = require('node:events');
const {normalizeProxy} = require('./proxy.cjs');

const RELEASE_URL = 'https://github.com/coo-2022/OneMount/releases';
const DEFAULT_PREFERENCES = Object.freeze({checkOnStartup: false, allowPrerelease: false});
const SAFE_ERROR = Symbol('safe-update-error');

function normalizeUpdatePreferences(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_PREFERENCES, key) || typeof input[key] !== 'boolean')) {
    throw new Error('请选择有效的更新设置');
  }
  return {...DEFAULT_PREFERENCES, ...input};
}

function versionText(value) {
  return typeof value === 'string' && value.length <= 100 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : '';
}

// Never expose the upstream message/stack, which may contain a signed URL,
// proxy credentials, an authorization header, or a private filesystem path.
function updateError(error, phase) {
  const code = String(error?.code || '');
  if (error?.[SAFE_ERROR]) return {errorCode: error[SAFE_ERROR], error: error.message};
  if (phase === 'prepare') return {errorCode: 'shutdown-blocked', error: '暂时无法安全更新。请完成或取消账号连接，关闭使用磁盘的程序，并等待上传完成后重试。'};
  if (/ERR_UPDATER_(LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND|NO_PUBLISHED_VERSIONS|NO_CHANNEL)/.test(code) ||
      (phase === 'check' && (error?.statusCode === 404 || code === '404'))) {
    return {errorCode: 'release-unavailable', error: '当前更新通道尚未提供可用的安装包或更新信息，请稍后重试。'};
  }
  if (/SHA512|CHECKSUM|SIGNATURE|INVALID_SIGNATURE/.test(code)) return {errorCode: 'verification-failed', error: '安装包验证失败，未执行安装。请重新下载。'};
  if (['ENOSPC', 'EDQUOT'].includes(code)) return {errorCode: 'disk-full', error: '下载更新的磁盘空间不足，请清理空间后重试。'};
  if (phase === 'install') return {errorCode: 'install-failed', error: '未能启动更新安装，请重试或前往发布页面下载安装包。'};
  return {errorCode: 'network-failed', error: '无法完成更新操作，请检查网络和代理设置后重试。'};
}

function safeError(code, message) {const error = new Error(message); error[SAFE_ERROR] = code; return error;}
function finite(value) {return Number.isFinite(value) ? Math.max(0, value) : 0;}

class UpdateService extends EventEmitter {
  constructor({updater = null, currentVersion, installed = false, supported = installed && !!updater,
    prepareInstall, recoverInstall = async () => {}, proxy, preferences} = {}) {
    super();
    this.updater = updater;
    this.currentVersion = versionText(currentVersion);
    this.installed = !!installed;
    this.supported = !!supported && this.installed && !!updater;
    this.prepareInstall = prepareInstall;
    this.recoverInstall = recoverInstall;
    this.proxy = normalizeProxy(proxy);
    this.preferences = normalizeUpdatePreferences(preferences);
    this.state = {status: this.supported ? 'idle' : 'unsupported', version: '', progress: null, error: '', errorCode: ''};
    this.downloaded = false;
    this.operation = null;
    this.installAttempt = null;
    this.listeners = [];
    this.disposed = false;
    if (updater) {
      // The fixed GitHub provider comes from the packaged app-update.yml. The
      // renderer has no API to replace that feed or supply a download URL.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.autoRunAppAfterInstall = true;
      updater.disableWebInstaller = true;
      // Also fail safe if the dependency is later upgraded to the v7 API.
      if ('autoInstallEvent' in updater) updater.autoInstallEvent = 'manual';
      updater.logger = null;
      this._setChannel();
      this._listen('update-available', info => {
        if (this.operation?.name !== 'check') return;
        const version = versionText(info?.version);
        if (!version) {this.operation.error = safeError('invalid-metadata', '更新信息无效，请稍后重试。'); return;}
        this._set({status: 'available', version, progress: null});
      });
      this._listen('update-not-available', () => {
        if (this.operation?.name === 'check') this._set({status: 'not-available', version: '', progress: null});
      });
      this._listen('download-progress', progress => {
        if (this.operation?.name !== 'download') return;
        this._set({progress: {percent: Math.min(100, finite(progress?.percent)), transferred: finite(progress?.transferred),
          total: finite(progress?.total), bytesPerSecond: finite(progress?.bytesPerSecond)}});
      });
      this._listen('update-downloaded', info => {
        if (this.operation?.name !== 'download') return;
        if (versionText(info?.version) !== this.state.version) {
          this.operation.error = safeError('invalid-metadata', '下载版本与检查结果不一致，请重新检查更新。');
          return;
        }
        this.downloaded = true;
        this._set({status: 'downloaded', progress: {transferred: 0, total: 0, bytesPerSecond: 0, ...(this.state.progress || {}), percent: 100}});
      });
      this._listen('error', error => {
        if (this.operation) this.operation.error = error;
        // NSIS can report a launch failure asynchronously, after quitAndInstall
        // returns. Re-open the application controls and retain the staged file.
        if (this.installAttempt?.phase === 'install') {
          void this._recover(error, this.installAttempt).catch(() => {});
        } else if (!this.operation) {
          this._set({...updateError(error, 'check'), status: this.downloaded ? 'downloaded' : 'error'});
        }
      });
    }
  }

  snapshot() {
    const busy = !!this.operation || this.state.status === 'installing' || !!this.installAttempt?.recovery;
    return {...this.state, progress: this.state.progress ? {...this.state.progress} : null,
      currentVersion: this.currentVersion, installed: this.installed, supported: this.supported,
      preferences: {...this.preferences}, releaseUrl: RELEASE_URL,
      canCheck: this.supported && !busy && !this.downloaded,
      canDownload: this.supported && !busy && !!this.state.version && !this.downloaded,
      canInstall: this.supported && !busy && this.downloaded};
  }

  configure(input) {
    if (this.operation || this.state.status === 'installing' || this.installAttempt?.recovery) throw new Error('更新操作正在进行，请稍候');
    normalizeUpdatePreferences(input);
    const next = normalizeUpdatePreferences({...this.preferences, ...input});
    if (next.allowPrerelease !== this.preferences.allowPrerelease) {
      if (this.downloaded) throw new Error('请先安装已下载的更新，再切换更新通道');
      this.state = {...this.state, status: this.supported ? 'idle' : 'unsupported', version: '', progress: null, error: '', errorCode: ''};
    }
    this.preferences = next;
    if (this.updater) this._setChannel();
    this.emit('change');
    return this.snapshot();
  }

  check() {
    if (this.downloaded) return Promise.resolve(this.snapshot());
    return this._run('check', async operation => {
      this._set({status: 'checking', version: '', progress: null, error: '', errorCode: ''});
      await this._network();
      const result = await this.updater.checkForUpdates();
      if (operation.error) throw operation.error;
      if (!result || !['available', 'not-available'].includes(this.state.status)) {
        throw safeError('release-unavailable', '当前更新通道尚未提供可用的安装包或更新信息，请稍后重试。');
      }
    });
  }

  download() {
    if (this.downloaded) return Promise.resolve(this.snapshot());
    if (!this.state.version) return Promise.reject(new Error('请先检查更新'));
    return this._run('download', async operation => {
      this._set({status: 'downloading', progress: null, error: '', errorCode: ''});
      await this._network();
      await this.updater.downloadUpdate();
      if (operation.error) throw operation.error;
      if (!this.downloaded) throw safeError('verification-failed', '无法确认安装包已经完整下载，请重新下载。');
    });
  }

  install() {
    if (!this.downloaded) return Promise.reject(new Error('请先下载更新'));
    return this._run('install', async operation => {
      const attempt = {phase: 'prepare', recovery: null};
      this.installAttempt = attempt;
      this._set({status: 'preparing', error: '', errorCode: ''});
      try {
        // A resolved shutdown with an explicit true is required. No forced quit
        // and no installer launch is allowed while a drive may still be writing.
        if (typeof this.prepareInstall !== 'function' || await this.prepareInstall() !== true) throw new Error('shutdown not confirmed');
        if (operation.error) throw operation.error;
        attempt.phase = 'install';
        this._set({status: 'installing'});
        this.updater.quitAndInstall(false, true); // electron-updater 6.x
        if (operation.error) throw operation.error;
      } catch (error) {
        await this._recover(error, attempt);
        const result = updateError(error, attempt.phase);
        throw safeError(result.errorCode, result.error);
      }
    });
  }

  _setChannel() {
    this.updater.allowPrerelease = this.preferences.allowPrerelease;
    this.updater.allowDowngrade = false;
  }

  async _network() {
    if (this.networkConfigured) return;
    const session = this.updater.netSession;
    if (!session || typeof session.setProxy !== 'function') throw new Error('update session unavailable');
    await session.setProxy(this.proxy.mode === 'manual'
      ? {mode: 'fixed_servers', proxyRules: this.proxy.url, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]'}
      : {mode: 'direct'});
    this.networkConfigured = true;
  }

  _run(name, work) {
    if (this.disposed || !this.supported) return Promise.reject(new Error('当前版本不支持应用内更新，请先安装 OneMount 安装版'));
    if (this.operation) return this.operation.name === name ? this.operation.promise : Promise.reject(new Error('更新操作正在进行，请稍候'));
    if (this.state.status === 'installing' || this.installAttempt?.recovery) return Promise.reject(new Error('正在安装更新，请稍候'));
    const operation = {name, promise: null, error: null};
    this.operation = operation;
    operation.promise = Promise.resolve().then(() => work(operation)).catch(error => {
      if (name === 'download') this.downloaded = false;
      const result = updateError(error, name);
      this._set({...result, status: this.downloaded ? 'downloaded' : 'error'});
      throw new Error(result.error);
    }).finally(() => {this.operation = null; this.emit('change');}).then(() => this.snapshot());
    return operation.promise;
  }

  async _recover(error, attempt) {
    if (attempt.recovery) return attempt.recovery;
    attempt.recovery = Promise.resolve().then(() => {
      // electron-updater 6.x resets this guard for synchronous launch errors,
      // but retains it when an asynchronous spawn fails after doInstall returns.
      // Only a reported install failure may re-arm it; successful attempts and
      // duplicate clicks keep the upstream guard in place.
      if (attempt.phase === 'install' && typeof this.updater.quitAndInstallCalled === 'boolean') this.updater.quitAndInstallCalled = false;
      return this.recoverInstall();
    }).catch(() => {}).then(() => {
      this._set({...updateError(error, attempt.phase), status: this.downloaded ? 'downloaded' : 'error'});
      if (this.installAttempt === attempt) this.installAttempt = null;
      this.emit('change');
    });
    return attempt.recovery;
  }

  _set(patch) {Object.assign(this.state, patch); this.emit('change');}
  _listen(event, listener) {this.updater.on(event, listener); this.listeners.push([event, listener]);}
  dispose() {
    this.disposed = true;
    for (const [event, listener] of this.listeners) this.updater.removeListener(event, listener);
    this.listeners = [];
    this.removeAllListeners();
  }
}

module.exports = {UpdateService, normalizeUpdatePreferences, RELEASE_URL};
