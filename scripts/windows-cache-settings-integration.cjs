'use strict';
// Real Windows mount: default writeback, both transitions, and remote reads after
// moving each clean read cache aside. Uses only a fresh local-backend fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Manager}=require('../src/manager.cjs'),P=require('../src/processes.cjs');
if(process.platform!=='win32')throw Error('Windows with WinFsp required');
const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
fs.mkdirSync(results,{recursive:true});
const base=fs.mkdtempSync(path.join(results,'cache-settings-'));
const backend=path.join(base,'backend');fs.mkdirSync(backend);
const letter=[...'QRSUVWYZ'].find(c=>!fs.existsSync(c+':\\'));
assert.ok(letter,'A free test drive is required');
const m=new Manager({root:path.join(base,'profile'),engines:path.join(root,'engines'),protect:s=>Buffer.from(s).toString('base64'),unprotect:s=>Buffer.from(s,'base64').toString()});
const report={started:new Date().toISOString(),fixture:base,checks:[],passed:false};
const save=()=>fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\n');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=name=>{report.checks.push(name);console.log('PASS '+name);save();};
async function assertLocalDisk(){
  const info=JSON.parse(await P.run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    `$d=[System.IO.DriveInfo]::new('${letter}:\\'); @{type=$d.DriveType.ToString();format=$d.DriveFormat;ready=$d.IsReady}|ConvertTo-Json -Compress`]));
  assert.deepEqual(info,{type:'Fixed',format:'JuiceFS',ready:true},'JuiceFS must be a ready local disk');
}
async function main(){
  save();console.log('Fixture: '+base);await m.init();assert.ok(m.health.winfsp);
  const connectionId=await m.addLocal({name:'Cache settings test',path:backend});
  const id=await m.addDisk({connectionId,name:'Cache settings test',mode:'juicefs',letter:letter+':',cacheGiB:1});
  const d=m.disk(id),paths=m.paths(d),data=crypto.randomBytes(5*1024*1024+137),file=letter+':\\persistent.bin';
  assert.equal(d.writeback,true);let expected=hash(data),gatewayPort;
  for(const [iteration,enabled] of [true,false,true].entries()){
    if(iteration)await m.updateDisk(id,{writeback:enabled,cacheGiB:2});
    await m.mount(id);
    await assertLocalDisk();
    assert.equal(m.runtime.get(id).jfs.spawnargs.includes('--writeback'),enabled);
    await assert.rejects(m.updateDisk(id,{writeback:!enabled}),/先卸载/);
    if(!iteration){fs.writeFileSync(file,data);gatewayPort=d.gatewayPort;}
    else {assert.equal(d.gatewayPort,gatewayPort);assert.equal(hash(fs.readFileSync(file)),expected);}
    fs.appendFileSync(file,Buffer.from('\nmode='+enabled));expected=hash(fs.readFileSync(file));
    const original=letter+':\\permission-check.txt',renamed=letter+':\\renamed-check.txt';
    fs.writeFileSync(original,'current-user write');fs.accessSync(original,fs.constants.R_OK|fs.constants.W_OK);
    fs.renameSync(original,renamed);assert.equal(fs.readFileSync(renamed,'utf8'),'current-user write');
    fs.unlinkSync(renamed);assert.ok(!fs.existsSync(renamed));
    await P.waitFor(async()=>{await m.poll();const s=m.runtime.get(id)?.stats;return s?.known&&s.pendingBlocks===0&&s.pendingBytes===0;},90000);
    await m.unmount(id);assert.ok(!fs.existsSync(letter+':\\'));
    assert.ok(fs.statSync(paths.meta).size>0);assert.equal(await m.hasStagedUploads(paths.cache),false);
    // Keep all evidence. Verify both resolved paths before moving this fixture's cache.
    const from=path.resolve(paths.cache),to=path.resolve(paths.dir,'cache-verified-'+iteration);
    for(const target of [from,to])assert.ok(target.startsWith(path.resolve(base)+path.sep));
    fs.renameSync(from,to);fs.mkdirSync(from);
    check('writeback='+enabled+': local Fixed disk, current-user read/write, rename/delete, mounted edit blocked, uploads drained, safe unmount'+(iteration?', cold read hash verified':''));
  }
  await m.mount(id);await assertLocalDisk();assert.equal(hash(fs.readFileSync(file)),expected);await m.unmount(id);
  check('final cold read matches after both cache-mode transitions');
  report.passed=true;
}
main().catch(e=>{report.error=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{
  try{await m.shutdown();}catch(e){report.shutdownError=e.message;report.passed=false;console.error(e);process.exitCode=1;}
  clearInterval(m.timer);report.finished=new Date().toISOString();save();
});
