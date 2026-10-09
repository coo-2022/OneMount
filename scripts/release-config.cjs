'use strict';
// Developer-side branding configuration. End users never enter OAuth application parameters.
const fs=require('node:fs');const path=require('node:path');const root=path.resolve(__dirname,'..');
const local=path.join(root,'oauth-clients.local.json');
const config=fs.existsSync(local)?JSON.parse(fs.readFileSync(local,'utf8')):JSON.parse(fs.readFileSync(path.join(root,'oauth-clients.json'),'utf8'));
for(const id of ['onedrive','drive','dropbox']){
  const prefix='ONEMOUNT_OAUTH_'+id.toUpperCase();
  if(process.env[prefix+'_CLIENT_ID'])config[id]={clientId:process.env[prefix+'_CLIENT_ID'],clientSecret:process.env[prefix+'_CLIENT_SECRET']||''};
}
fs.writeFileSync(path.join(root,'oauth-clients.json'),JSON.stringify(config,null,2)+'\n');
console.log('Release account configuration prepared.');
