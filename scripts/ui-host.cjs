// Test harness for Linux containers without AF_UNIX sockets or a desktop display.
// Production starts through bootstrap.cjs with the single-instance lock.
const {app}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'cloud-island-ui-')));
const main=require('../src/main.cjs');
// Linux has no OS keychain in the test container. Use a temporary AES key for UI tests only.
const crypto=require('node:crypto'),key=crypto.randomBytes(32);
const protect=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');};
const unprotect=s=>{const b=Buffer.from(s,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();};
app.whenReady().then(()=>main.start({protect,unprotect,headless:true})).catch(e=>{console.error(e);app.exit(1);});
