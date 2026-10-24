'use strict';

function updateSettingsPanel() {
  const u=state.update||{}, prefs=u.preferences||{};
  const busy=['checking','downloading','preparing','installing'].includes(u.status);
  const labels={idle:'随时检查是否有新版本',checking:'正在检查更新…','not-available':'当前已是此通道的最新版本',available:`新版本 ${u.version} 已发布`,downloading:`正在下载 ${u.version}`,downloaded:`${u.version} 已准备好安装`,preparing:'正在安全卸载磁盘…',installing:'正在打开安装程序…',error:'更新未完成',unsupported:'安装版支持在应用内更新'};
  let control=button('check-update','检查更新','',false,!u.canCheck);
  if(u.canDownload)control=button('download-update','下载更新','',true);
  if(u.canInstall)control=button('install-update-confirm','重启并安装','',true);
  if(!u.supported)control=button('open-releases','下载安装版');
  const percent=Math.max(0,Math.min(100,Number(u.progress?.percent)||0));
  return `<section class="ir-section" id="update-settings" aria-labelledby="update-heading"><div class="ir-sectionhead"><h2 id="update-heading">软件更新</h2></div><div class="ir-list">${row('OneMount',escape(u.currentVersion||state.version||'—'),u.installed?'已安装 · Windows x64':'便携版或开发环境')}${row(escape(labels[u.status]||labels.idle),control)}${u.supported?`<label class="ir-row"><span>启动时检查更新<small>发现新版本后提示，由你决定下载和安装。</small></span><input type="checkbox" class="ir-switch" id="update-auto-check" ${prefs.checkOnStartup?'checked':''} ${busy?'disabled':''}></label><label class="ir-row"><span>接收预览版<small>包含尚未正式发布的新功能。</small></span><input type="checkbox" class="ir-switch" id="update-preview" ${prefs.allowPrerelease?'checked':''} ${busy||u.canInstall?'disabled':''}></label>`:''}</div>${u.status==='downloading'?`<div class="ci-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><div class="progress-track"><div style="width:${percent}%"></div></div><p>${Math.round(percent)}% · ${bytes(u.progress?.transferred||0)}${u.progress?.total?' / '+bytes(u.progress.total):''}${u.progress?.bytesPerSecond?' · '+bytes(u.progress.bytesPerSecond)+'/s':''}</p></div>`:''}${u.error?`<div class="errorbox" role="status">${escape(u.error)}</div>`:''}<p class="ci-update-note">${u.supported?'更新前会安全卸载磁盘，保留账号、磁盘配置与本地数据。':'安装版会继续使用这台电脑已有的账号、磁盘配置与本地数据。安装前请先安全退出正在运行的 OneMount。'}</p></section>`;
}
