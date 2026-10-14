'use strict';
const rate = value => value == null ? '—' : bytes(value).replace('KB','KiB').replace('MB','MiB').replace('GB','GiB')+'/s';
let chartObserver;
function activity() {
  if(!state.connections.some(c=>c.id===activityConnection))activityConnection=state.connections[0]?.id;
  const c=connection(activityConnection);
  let html=title('活动','速度的变化，以及正在传输的文件。');
  if(!c)return html+'<div class="empty">'+icon('cloud')+'<h1>还没有存储连接</h1><p>添加连接并挂载磁盘后，这里会显示传输活动。</p></div>';
  html+=`<div class="ci-clouds" aria-label="选择网盘">${state.connections.map(c=>{const p=c.performance;return `<button data-action="activity-connection" data-id="${escape(c.id)}" aria-pressed="${c.id===activityConnection}"><strong>${escape(c.name)}</strong><small>${!p?.known?'状态暂不可用':!p.mounted?'未挂载':p.total>0?'传输中 · '+rate(p.total):'空闲 · 无传输任务'}</small></button>`;}).join('')}</div>`;
  const p=c.performance,unknown=!p?.known;
  html+=`<section class="ci-monitor"><div class="ci-panelhead"><h2>传输速度</h2><span>最近 5 分钟 · 每 3 秒更新</span></div><div class="ci-metrics">${(p?.directional?[['上传',p.upload,'up'],['下载',p.download,'down']]:[['网关总传输',p?.total,'total']]).map(([label,v,k])=>`<div><label><span class="ci-swatch ${k}"></span>${label}</label><strong>${rate(v)}</strong></div>`).join('')}</div><div class="ci-plot"><svg class="ci-chart" role="img" aria-label="${escape(c.name)}最近五分钟的传输速度曲线"></svg><div class="ci-chart-tip" hidden></div></div><p class="ci-chart-note">${unknown?'暂时无法读取状态，未知时段保留为空白。':!p.mounted?'未挂载，当前没有传输。':p.directional?'显示网盘实际传输速度。':'文件系统卷显示网关总传输速度，无法区分上传与下载。'}</p></section>`;
  const ds=state.disks.filter(d=>d.connectionId===c.id&&d.status!=='unmounted');
  const tasks=[];let unknownQueue=false,blocks='';
  for(const d of ds){const s=d.stats;if(!s?.known||!p.known){unknownQueue=true;continue;}if(d.mode==='juicefs'){blocks+=`<div class="ci-quiet">${icon('layers')}<div><strong>${escape(d.name)} · ${pending(d)}</strong><p>按数据块统计 · ${bytes(s.pendingBytes)}</p></div></div>`;continue;}
    const queue=s.queue||[],uploads=new Set(queue.map(f=>f.name));
    for(const f of queue){const t=(s.transferring||[]).find(t=>t.name===f.name);tasks.push({name:f.name,size:f.size,done:t?.bytes,upload:true,active:!!f.uploading,speed:t?Math.max(0,t.speedAvg??t.speed??0):null,tries:f.tries,disk:d});}
    for(const t of s.transferring||[])if(!uploads.has(t.name))tasks.push({name:t.name,size:t.size,done:t.bytes,upload:false,active:true,speed:Math.max(0,t.speedAvg??t.speed??0),disk:d});
  }
  const active=tasks.filter(t=>t.active).length;
  html+=`<section class="ci-queue"><div class="ci-panelhead"><h2>传输队列 <span class="ci-count">${unknownQueue?'—':tasks.length}</span></h2><span>${active?active+' 正在传输 · '+(tasks.length-active)+' 等待':tasks.length?tasks.length+' 等待传输':unknownQueue?'状态暂不可用':'无待处理文件'}</span></div>`;
  if(unknownQueue)html+='<div class="ci-quiet">'+icon('circle-alert')+'<div><strong>暂时无法确认传输状态</strong><p>恢复连接后自动更新。</p></div></div>';
  html+=tasks.map(t=>{const progress=t.done!=null&&t.size>0?Math.max(0,Math.min(100,t.done/t.size*100)):null;return `<div class="ci-file"><span class="ir-fileicon">${icon('file')}</span><div class="ci-file-body"><strong>${escape(t.name)}</strong>${progress==null?'':`<div class="progress-track ${t.upload?'':'ci-download'}"><div style="width:${progress}%"></div></div>`}<small>${progress==null?bytes(t.size):bytes(t.done)+' / '+bytes(t.size)+' · '+Math.floor(progress)+'%'} · ${escape(t.disk.letter)}${t.tries>1?' · 正在重试':''}</small></div><div class="ci-file-status">${t.active?(t.upload?'↑ ':'↓ ')+rate(t.speed):'等待上传'}<small>${t.active?(t.upload?'正在上传':'正在下载'):'本地暂存'}</small></div></div>`;}).join('');
  html+=blocks;
  if(!tasks.length&&!unknownQueue&&!blocks)html+='<div class="ci-quiet">'+icon('cloud-check')+'<div><strong>当前没有传输任务</strong><p>有文件传输时，速度曲线会自动更新。</p></div></div>';
  return html+'</section>';
}
function drawActivityChart() {
  chartObserver?.disconnect();chartObserver=null;
  const svg=$('.ci-chart');if(!svg)return;
  const c=connection(activityConnection),history=c?.performance?.history||[],tip=$('.ci-chart-tip');
  function draw(){const width=svg.parentElement.clientWidth;if(!width)return;const height=190,left=72,right=width-12,top=16,bottom=158,now=Date.now(),start=now-300000;
    const data=history.filter(p=>p.time>=start&&p.time<=now), keys=c.performance.directional?['upload','download']:['total'];
    const max=Math.max(1024,...data.flatMap(p=>keys.map(k=>p[k]||0)))*1.15;
    const x=t=>left+(right-left)*(t-start)/300000,y=v=>bottom-v/max*(bottom-top);
    const tick=v=>rate(v).replace('/s','');
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    let content=`<title>${escape(c.name)} · 最近五分钟实际传输速度</title>`;
    for(const n of [0,.5,1]){const yy=y(max*n);content+=`<line class="ci-grid" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/><text x="${left-9}" y="${yy+4}" text-anchor="end">${tick(max*n)}</text>`;}
    content+=`<text x="${left}" y="10">每秒</text><text x="${left}" y="184">5 分钟前</text><text x="${(left+right)/2}" y="184" text-anchor="middle">2 分 30 秒前</text><text x="${right}" y="184" text-anchor="end">现在</text>`;
    for(const key of keys){let d='',previous=null;for(const p of data){const v=p[key];if(v==null){previous=null;continue;}d+=(previous&&p.time-previous.time<=7500?'L':'M')+x(p.time).toFixed(1)+' '+y(v).toFixed(1)+' ';previous=p;}content+=`<path class="ci-series ${key}" d="${d}"/>`;for(let i=0;i<data.length;i++){const p=data[i];if(p[key]!=null&&(!data[i-1]||data[i-1][key]==null)&&(!data[i+1]||data[i+1][key]==null))content+=`<circle class="ci-point ${key}" cx="${x(p.time)}" cy="${y(p[key])}" r="2"/>`;}}
    content+=`<line class="ci-guide" y1="${top}" y2="${bottom}" hidden/><rect x="${left}" y="${top}" width="${Math.max(0,right-left)}" height="${bottom-top}" fill="transparent"/>`;svg.innerHTML=content;
    const guide=svg.querySelector('.ci-guide');const hide=()=>{tip.hidden=true;guide.setAttribute('hidden','');};
    svg.onpointermove=e=>{if(!data.length)return;const pos=e.clientX-svg.getBoundingClientRect().left,time=start+(pos-left)/(right-left)*300000;if(time<start||time>now){hide();return;}const p=data.reduce((best,p)=>Math.abs(p.time-time)<Math.abs(best.time-time)?p:best,data[0]);if(Math.abs(p.time-time)>7500){hide();return;}guide.removeAttribute('hidden');guide.setAttribute('x1',x(p.time));guide.setAttribute('x2',x(p.time));tip.textContent=new Date(p.time).toLocaleTimeString()+'　'+keys.map(k=>({upload:'↑ ',download:'↓ ',total:'总传输 '}[k])+rate(p[k])).join('　');tip.hidden=false;};svg.onpointerleave=hide;
  }
  draw();chartObserver=new ResizeObserver(draw);chartObserver.observe(svg.parentElement);
}
