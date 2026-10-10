const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {generate}=require('../scripts/generate-rclone-backends.cjs');
test('new backend directories are linked deterministically; helpers are excluded; removed backends disappear',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'backend-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['zdrive','adrive','internal','testdata']){const dir=path.join(root,'backend',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'entry.go'),'package '+name);}
 assert.deepEqual(generate(root),['adrive','zdrive']);
 const out=path.join(root,'backend/all/all.go');const first=fs.readFileSync(out,'utf8');generate(root);assert.equal(fs.readFileSync(out,'utf8'),first);
 fs.rmSync(path.join(root,'backend/adrive'),{recursive:true});generate(root);assert.ok(!fs.readFileSync(out,'utf8').includes('/adrive'));
});
test('empty backend directories and nested modules fail instead of silently missing a provider',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'backend-invalid-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'backend/mydrive');fs.mkdirSync(dir,{recursive:true});assert.throws(()=>generate(root),/missing a Go entry/);
 fs.writeFileSync(path.join(dir,'main.go'),'package mydrive');fs.writeFileSync(path.join(dir,'go.mod'),'module mydrive');assert.throws(()=>generate(root),/share the engine Go module/);
});
