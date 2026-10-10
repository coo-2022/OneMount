'use strict';
// Compile and execute a temporary backend to prove directory discovery reaches fs.Registry.
// The fixture is removed before producing the release executable.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {generate}=require('./generate-rclone-backends.cjs');
const root=path.resolve(__dirname,'../engine-src/rclone');
const dir=path.join(root,'backend/onemountcismoke'),test=path.join(root,'extension_ci_test.go');
if(fs.existsSync(dir)||fs.existsSync(test))throw new Error('Refusing to replace an existing extension fixture');
fs.mkdirSync(dir);
try {
  fs.writeFileSync(path.join(dir,'smoke.go'),'package onemountcismoke\nimport ("github.com/rclone/rclone/fs"; "github.com/rclone/rclone/backend/local")\nfunc init(){fs.Register(&fs.RegInfo{Name:"onemountcismoke", Description:"CI only", NewFs:local.NewFs})}\n');
  fs.writeFileSync(test,'package main\nimport ("testing"; "github.com/rclone/rclone/fs")\nfunc TestCustomBackendIsLinked(t *testing.T){if _,err:=fs.Find("onemountcismoke");err!=nil{t.Fatal(err)}}\n');
  generate(root);
  const modfile=require('./prepare-rclone-source.cjs').prepare();
  const r=spawnSync('go',['test','-mod=readonly','-modfile',modfile,'-tags','cmount','./...'],{cwd:root,stdio:'inherit',env:{...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0',GOWORK:'off'}});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error('Custom backend integration tests failed: '+r.status);
} finally {
  fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(test,{force:true});generate(root);
}
