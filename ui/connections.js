'use strict';
let selectedConnection, activityConnection;
const connectionChecks = new Map();
function settingRow(label, value, actionName, id, note = '', options = {}) {
  const content = `<span class="ci-setting-label">${label}${note?`<small>${note}</small>`:''}</span><span class="ci-setting-value">${value}${options.arrow?'<span class="ci-chevron" aria-hidden="true">›</span>':''}</span>`;
  return actionName ? `<button class="ci-setting-row ${options.danger?'ci-danger':''}" data-action="${actionName}" data-id="${escape(id)}" ${options.disabled?'disabled':''}>${content}</button>` : `<div class="ci-setting-row">${content}</div>`;
}
function connections() {
  let html = '<div class="ci-settings-width">'+title('存储连接','选择一个连接，管理它的访问与设置。',button('add-connection',icon('plus')+' 添加连接'));
  if (!state.connections.length) return html+`<div class="empty">${icon('cloud')}<h1>从一个连接开始</h1><p>登录网盘，或选择本地文件夹。</p>${button('add-connection','添加存储连接','',true)}</div></div>`;
  return html+`<div class="ci-settings-group">${state.connections.map(c=>{const ds=state.disks.filter(d=>d.connectionId===c.id);return `<button class="ci-connection-entry" data-action="connection-detail" data-id="${escape(c.id)}"><span class="service-glyph">${icon(c.type==='local'?'folder':'cloud')}</span><span class="ci-entry-label"><strong>${escape(c.name)}</strong><small>${serviceName(c.type)} · ${ds.length?'用于磁盘 '+ds.map(d=>escape(d.letter)).join('、'):'尚未用于磁盘'}</small></span><span class="ci-chevron" aria-hidden="true">›</span></button>`;}).join('')}</div><p class="ci-group-foot">登录凭据加密保存在这台电脑。</p></div>`;
}
function connectionDetail() {
  const c=connection(selectedConnection);if(!c){page='connections';return connections();}
  const disks=state.disks.filter(d=>d.connectionId===c.id), used=disks.length>0,check=connectionChecks.get(c.id);
  const folder=c.type==='local'?escape(c.localPath):(!c.folder||c.folder==='/'?'根目录':escape(c.folder));
  let html=`<div class="ci-settings-width"><button class="ci-back" data-nav="connections">‹ 存储连接</button><div class="ci-connection-hero"><span class="ir-hardware">${icon(c.type==='local'?'folder':'cloud')}</span><div><h1>${escape(c.name)}</h1><p>${serviceName(c.type)}</p></div></div><div class="ci-group-caption">常规</div><section class="ci-settings-group" aria-label="常规设置">`;
  html+=settingRow('连接名称',escape(c.name),'rename-connection',c.id,'',{arrow:true});
  html+=settingRow('存储目录',folder,c.type==='local'?null:'connection-folder',c.id,'',{arrow:c.type!=='local'});
  if(used) for(const d of disks)html+=settingRow('关联磁盘',escape(d.letter+' · '+d.name),'detail',d.id,'',{arrow:true});
  else html+=settingRow('关联磁盘','尚未创建磁盘');
  html+=`</section><p class="ci-group-foot">存储目录决定挂载后显示的内容。${used?'此连接正被磁盘使用，更换目录前需先移除关联磁盘。':''}</p><div class="ci-group-caption">连接与活动</div><section class="ci-settings-group" aria-label="连接与活动">`;
  const note=check?.status==='success'?'可以读取所选目录 · '+new Date(check.time).toLocaleTimeString():check?.status==='error'?escape(check.message):'检查网络、授权与目录访问，不写入文件';
  html+=settingRow('检查连接',`<span role="status">${check?.status==='running'?'正在检查…':check?.status==='success'?'连接正常':check?.status==='error'?'检查失败':''}</span>`,'test-connection',c.id,note,{disabled:check?.status==='running'});
  html+=settingRow('查看活动','','connection-activity',c.id,'查看实时速度曲线与传输队列',{arrow:true});
  html+=`</section><div class="ci-group-caption">连接管理</div><section class="ci-settings-group" aria-label="连接管理">`;
  html+=settingRow('移除连接','','remove-connection-confirm',c.id,used?'请先移除关联磁盘；网盘中的文件不会被删除':'仅移除本机连接，网盘中的文件不会被删除',{danger:true,disabled:used});
  return html+'</section></div>';
}
