'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),source=path.join(root,'engine-src/rclone'),exe=path.join(root,'engines/rclone.exe');
const version=execFileSync(exe,['version'],{encoding:'utf8'});
if(!version.includes('v1.75.0-onemount')||!version.includes('cmount'))throw new Error('Expected the custom rclone build with cmount');
const providers=JSON.parse(execFileSync(exe,['config','providers'],{encoding:'utf8',maxBuffer:16*1024**2}));
const names=(Array.isArray(providers)?providers:providers.providers).map(p=>p.Name);
for(const name of require('./generate-rclone-backends.cjs').generate(source))if(!names.includes(name))throw new Error('Backend directory must register the same provider name: '+name);
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dependency=JSON.parse(execFileSync('go',['list','-mod=readonly','-m','-json','github.com/rclone/rclone'],{cwd:source,encoding:'utf8'}));
let commit='unknown';try{commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();}catch{}
const sourcePatches=JSON.parse(fs.readFileSync(path.join(source,'.build/patched/manifest.json'),'utf8'));
const report={sourcePatches,upstream:dependency.Version,upstreamModuleSum:dependency.Sum,go:execFileSync('go',['version'],{encoding:'utf8'}).trim(),sourceCommit:commit,buildTags:['cmount'],goModSha256:sha(path.join(source,'go.mod')),goSumSha256:sha(path.join(source,'go.sum')),customBackends:require('./generate-rclone-backends.cjs').generate(source),sha256:sha(exe),version:version.trim()};
fs.writeFileSync(path.join(root,'engines/rclone-build.json'),JSON.stringify(report,null,2)+'\n');
console.log(version.trim());console.log('Verified registered backends and wrote engine build manifest.');
