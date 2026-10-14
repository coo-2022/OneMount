'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(process.versions.electron){
  const {app}=require('electron');
  app.setPath('userData',process.env.ONEMOUNT_UI_PROFILE);
  app.whenReady().then(()=>require('../src/main.cjs').start({headless:true})).catch(()=>app.exit(1));
}else{
  const {_electron}=require(process.env.ONEMOUNT_PLAYWRIGHT||'playwright');
  (async()=>{
    const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
    const profile=fs.mkdtempSync(path.join(results,'volume-ui-'));
    fs.writeFileSync(path.join(profile,'disks.json'),JSON.stringify({version:1,settings:{},disks:[],connections:
      ['baidu','drive','onedrive'].map(type=>({id:type,name:type,type,source:'ui-fixture-'+type+':'}))}));
    let app,page;const errors=[];
    try{
      app=await _electron.launch({executablePath:process.env.ONEMOUNT_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe'),
        args:process.env.ONEMOUNT_TEST_EXE?['--user-data-dir='+profile,'--disable-gpu']:[__filename,'--disable-gpu'],
        env:{...process.env,ONEMOUNT_UI_PROFILE:profile},timeout:60000});
      page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
      await page.locator('[data-action="add-disk"]').first().click();
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      assert.equal(await page.locator('[data-mode="juicefs"]').isEnabled(),true);
      await page.locator('[data-mode="juicefs"]').click();
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('drive');
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      assert.equal(await page.locator('[data-mode="juicefs"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#volume-options').isVisible(),true);
      await page.locator('#add-disk-form [name="name"]').fill('百度文件系统卷');
      await page.screenshot({path:path.join(profile,'create-volume.png')});
      await page.locator('[data-action="create-disk"]').click();
      await page.getByRole('heading',{name:'百度文件系统卷',exact:true}).waitFor();
      assert.ok(!(await page.locator('#content').innerText()).includes('百度网盘不接受空文件'));
      let snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[0].mode,'juicefs');assert.equal(snapshot.disks[0].writeback,false);
      await page.locator('.ir-nav [data-nav="home"]').click();await page.locator('[data-action="add-disk"]').first().click();
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      await page.locator('#add-disk-form [name="name"]').fill('百度直连');await page.locator('[data-action="create-disk"]').click();
      await page.getByRole('heading',{name:'百度直连',exact:true}).waitFor();
      assert.ok((await page.locator('#content').innerText()).includes('百度网盘不接受空文件'));
      assert.deepEqual(errors,[]);console.log('PASS volume selection across providers, real IPC creation, direct-only empty-file notice, no renderer errors');
    }finally{
      if(app){await page?.evaluate(()=>window.island.invoke('quit')).catch(()=>{});await app.close();}
    }
  })().catch(e=>{console.error(e);process.exitCode=1;});
}
