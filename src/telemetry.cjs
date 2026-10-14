'use strict';
const WINDOW_MS = 300000;
const currentRate = t => Math.max(0, Number.isFinite(t.speedAvg) ? t.speedAvg : Number.isFinite(t.speed) ? t.speed : 0);
function transferRates(core, queue = null) {
  const transfers = core.transferring || [], totalSpeed = transfers.reduce((n,t)=>n+currentRate(t),0);
  if (!queue) return {totalSpeed,uploadSpeed:null,downloadSpeed:null};
  const uploads = new Set(queue.filter(f=>f.uploading).map(f=>f.name));
  const uploadSpeed = transfers.filter(t=>uploads.has(t.name)).reduce((n,t)=>n+currentRate(t),0);
  return {totalSpeed,uploadSpeed,downloadSpeed:Math.max(0,totalSpeed-uploadSpeed)};
}
function sample(id, disks, runtime, now = Date.now()) {
  const active = disks.filter(d=>d.connectionId===id && runtime.has(d.id));
  const known = active.every(d=>{const r=runtime.get(d.id),s=r.stats;return r.status==='mounted' && s?.known && Number.isFinite(s.checkedAt) && now-s.checkedAt<=10000;});
  const directional = active.every(d=>d.mode==='direct');
  const sum = key => known ? active.reduce((n,d)=>n+Math.max(0,Number(runtime.get(d.id).stats[key])||0),0) : null;
  return {time:now,known,mounted:active.length,directional,upload:directional?sum('uploadSpeed'):null,download:directional?sum('downloadSpeed'):null,total:sum('speed')};
}
class History {
  constructor() {this.series = new Map();}
  record(connections, disks, runtime, now = Date.now()) {
    const ids = new Set(connections.map(c=>c.id));
    for (const id of this.series.keys()) if (!ids.has(id)) this.series.delete(id);
    for (const {id} of connections) {
      const points = (this.series.get(id)||[]).filter(p=>p.time>=now-WINDOW_MS && p.time<now);
      points.push(sample(id,disks,runtime,now));
      this.series.set(id,points.slice(-101));
    }
  }
  get(id) {return this.series.get(id)||[];}
}
module.exports = {transferRates,sample,History,WINDOW_MS};
