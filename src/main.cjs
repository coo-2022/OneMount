'use strict';
const {app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, safeStorage, nativeImage} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {Manager} = require('./manager.cjs');
const {loadProviderConfig, loadOAuthClients} = require('./providers.cjs');
const {isInstalled} = require('./install-state.cjs');
const {UpdateService} = require('./updates.cjs');
require('./accounts.cjs').installAccounts(Manager);

app.setName('OneMount');
// Retain the Windows application identity for existing taskbar and startup entries.
app.setAppUserModelId('com.cloudisland.desktop');
let win, tray, manager, updates, exiting = false, quitting = false, stoppedForUpdate = false;
// electron-updater schedules app.quit() after invoking the NSIS launcher. If
// that launcher then fails, its already queued quit must not become a normal
// safe-quit request after recovery has reopened the application controls.
let cancelQueuedUpdateQuit = false;
let updateOwnsQuit = false;
const activeCommands = new Set();
const home = path.join(__dirname, '..', 'ui', 'index.html');

async function start(options = {}) {
  if (process.platform === 'win32' && !safeStorage.isEncryptionAvailable()) throw new Error('当前系统的账户加密服务不可用');
  const engines = app.isPackaged ? path.join(process.resourcesPath, 'engines') : path.join(__dirname, '..', 'engines');
  manager = new Manager({root: app.getPath('userData'), engines,
    providerConfig: loadProviderConfig({executableDir: app.isPackaged ? path.dirname(process.execPath) : undefined}),
    protect: options.protect || (s => safeStorage.encryptString(s).toString('base64')), unprotect: options.unprotect || (s => safeStorage.decryptString(Buffer.from(s, 'base64'))),
    oauthClients: loadOAuthClients({executableDir: app.isPackaged ? path.dirname(process.execPath) : undefined}), openExternal: url => shell.openExternal(url)});
  await manager.init();
  const installed = isInstalled({packaged: app.isPackaged, resourcesPath: process.resourcesPath});
  updates = new UpdateService({updater: installed ? new (require('electron-updater').NsisUpdater)() : null,
    installed, supported: installed, currentVersion: app.getVersion(), proxy: manager.activeProxy,
    preferences: manager.state.settings.updates,
    prepareInstall: async () => {
      if (quitting || activeCommands.size) throw new Error('还有操作正在进行，请稍后安装更新');
      cancelQueuedUpdateQuit = false;
      quitting = true;
      updateOwnsQuit = true;
      await manager.shutdown();
      stoppedForUpdate = true;
      exiting = true;
      return true;
    },
    recoverInstall: async () => {
      // A separately requested safe quit may have won the race before the
      // update preparation callback ran. Only release our own shutdown lock.
      if (!updateOwnsQuit) return;
      updateOwnsQuit = false;
      if (stoppedForUpdate) cancelQueuedUpdateQuit = true;
      exiting = false; quitting = false;
      if (stoppedForUpdate) {
        clearInterval(manager.timer);
        manager.timer = setInterval(() => manager.poll().catch(() => {}), 3000); manager.timer.unref();
        stoppedForUpdate = false;
      }
    }});
  if (app.isPackaged && manager.state.settings.loginStart) app.setLoginItemSettings({openAtLogin: true, args: ['--hidden']});
  win = new BrowserWindow({width: 1180, height: 810, minWidth: 930, minHeight: 650, title: 'OneMount', backgroundColor: '#f8f9fb', show: !options.headless,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, offscreen: !!options.headless}});
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  win.on('close', e => {if (!exiting && tray) {e.preventDefault(); win.hide();}});
  if (!options.headless) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
    tray.setToolTip('OneMount'); tray.on('double-click', () => win.show());
  }
  function updateTray() {
    if (!tray) return;
    const s = manager.snapshot();
    const items = [{label: '打开 OneMount', click: () => win.show()}, {type: 'separator'}, ...s.disks.map(d => ({label: `${d.name} · ${d.letter} · ${d.status === 'mounted' ? '已挂载' : d.status === 'unmounted' ? '未挂载' : '处理中'}`, click: () => win.show()})), {type: 'separator'}, {label: '安全退出', click: () => requestQuit()}];
    tray.setContextMenu(Menu.buildFromTemplate(items));
    tray.setToolTip(`OneMount · ${s.disks.filter(d => d.status === 'mounted').length} 个磁盘已挂载`);
  }
  manager.on('change', () => {if (!win.isDestroyed()) win.webContents.send('changed'); updateTray();}); updateTray();
  updates.on('change', () => {if (!win.isDestroyed()) win.webContents.send('changed');});
  ipcMain.handle('island', async (event, method, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith(pathToFileURL(home).href)) return {ok: false, error: '无效操作来源'};
    const operation = Symbol(method);
    try {
      if (quitting && method !== 'snapshot') throw new Error('正在安全退出，请稍候');
      if (!['snapshot', 'installUpdate', 'quit'].includes(method)) activeCommands.add(operation);
      let value;
      const methods = new Set(['snapshot','addLocal','connect','answerAuth','cancelAuth','addDisk','updateDisk','removeDisk','mount','unmount','deleteConnection','testConnection','renameConnection','listFolders','setFolder']);
      if (method === 'snapshot') value = {...manager.snapshot(), update: updates.snapshot()};
      else if (methods.has(method)) value = await manager[method](...args);
      else if (method === 'checkUpdate') value = await updates.check();
      else if (method === 'downloadUpdate') value = await updates.download();
      else if (method === 'installUpdate') value = await updates.install();
      else if (method === 'updatePreferences') {
        const input = args[0];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['checkOnStartup', 'allowPrerelease'].includes(k)) ||
            Object.values(input).some(v => typeof v !== 'boolean')) throw new Error('更新设置无效');
        const previous = {...manager.state.settings.updates};
        updates.configure({...previous, ...input});
        try {manager.updateSettings({updates: input});} catch (e) {updates.configure(previous); throw e;}
        value = updates.snapshot();
      }
      else if (method === 'openReleases') await shell.openExternal('https://github.com/coo-2022/OneMount/releases');
      else if (method === 'pickFolder') {const r = await dialog.showOpenDialog(win, {title: '选择存储文件夹', properties: ['openDirectory', 'createDirectory']}); value = r.canceled ? null : r.filePaths[0];}
      else if (method === 'openDisk') {const d = manager.disk(args[0]); if (manager.runtime.get(d.id)?.status !== 'mounted') throw new Error('请先挂载此磁盘'); const err = await shell.openPath(d.letter + '\\'); if (err) throw new Error('暂时无法打开磁盘');}
      else if (method === 'openData') await shell.openPath(manager.root);
      else if (method === 'settings') {
        if (args[0] && Object.hasOwn(args[0], 'updates')) throw new Error('请通过软件更新选项修改更新设置');
        manager.updateSettings(args[0]);
        if (args[0]?.loginStart !== undefined) app.setLoginItemSettings({openAtLogin: manager.state.settings.loginStart, args: ['--hidden']});
      }
      else if (method === 'installDriver') await shell.openExternal('https://winfsp.dev/rel/');
      else if (method === 'quit') await requestQuit();
      else throw new Error('不支持此操作');
      return {ok: true, value};
    } catch (e) {
      // Account/provider messages can contain tokens or raw internal configuration. Do not pass them to the UI.
      const raw = String(e.message || '');
      const clean = /rclone|juicefs|token|secret|password|Authorization|client_id|access_key/i.test(raw)
        ? '连接或磁盘操作未完成。请检查网络、账号信息与磁盘驱动后重试。'
        : raw.replace(/https?:\/\/[^\s]+/g, '[服务地址]');
      return {ok: false, error: clean.slice(0, 500)};
    } finally {activeCommands.delete(operation);}
  });
  await win.loadFile(home);
  if (process.argv.includes('--hidden')) win.hide();
  for (const d of manager.state.disks) if (d.autoMount && !manager.runtime.has(d.id)) manager.mount(d.id).catch(() => {});
  if (installed && manager.state.settings.updates.checkOnStartup) {
    const timer = setTimeout(() => {if (!quitting) updates.check().catch(() => {});}, 10000); timer.unref();
  }
}
async function requestQuit() {
  if (quitting) return;
  // An explicit user action may still quit normally after a failed update.
  cancelQueuedUpdateQuit = false;
  quitting = true;
  try {if (activeCommands.size) throw new Error('还有操作正在进行，请稍后退出'); await manager.shutdown(); exiting = true; tray?.destroy(); app.quit();}
  catch (e) {win?.show(); await dialog.showMessageBox(win, {type: 'warning', title: '暂时不能安全退出', message: e.message, detail: '请关闭使用磁盘的程序，等待上传完成。关闭窗口可继续在托盘运行。', buttons: ['返回 OneMount']});}
  finally {quitting = false;}
}
app.on('before-quit', e => {
  if (cancelQueuedUpdateQuit) {cancelQueuedUpdateQuit = false; e.preventDefault(); win?.show(); return;}
  if (!exiting) {e.preventDefault(); requestQuit();}
});
app.on('window-all-closed', () => {});
module.exports = {start, activate: () => {win?.show(); win?.focus();}, failStartup: e => {dialog.showErrorBox('OneMount 暂时无法启动', '请检查是否完整解压软件，以及当前账户能否访问软件数据目录。\n\n' + e.message); exiting = true; app.quit();}};
