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
    // Hidden packaged windows do not paint consistently on Windows. Source UI
    // runs retain normal actionability checks; packaged checks exercise the same
    // controls and real IPC without waiting for invisible animation frames.
    const interaction=process.env.ONEMOUNT_TEST_EXE?{force:true}:{};
    try{
      app=await _electron.launch({executablePath:process.env.ONEMOUNT_TEST_EXE||path.join(root,'node_modules/electron/dist/electron.exe'),
        args:process.env.ONEMOUNT_TEST_EXE?['--user-data-dir='+profile,'--disable-gpu','--hidden']:[__filename,'--disable-gpu'],
        env:{...process.env,ONEMOUNT_UI_PROFILE:profile},timeout:60000});
      page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
      // The packaged preview stays hidden during testing. Keep animation frames
      // running so actionability checks are not starved by background throttling.
      if(process.env.ONEMOUNT_TEST_EXE)await app.evaluate(({BrowserWindow})=>{
        for(const window of BrowserWindow.getAllWindows())window.webContents.setBackgroundThrottling(false);
      });
      await page.locator('[data-action="add-disk"]').first().click(interaction);
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      assert.equal(await page.locator('[data-mode="juicefs"]').isEnabled(),true);
      await page.locator('[data-mode="juicefs"]').click(interaction);
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('drive');
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      assert.equal(await page.locator('[data-mode="juicefs"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#volume-options').isVisible(),true);
      assert.equal(await page.locator('#add-disk-form [name="writeback"]').isChecked(),true);
      await page.locator('#add-disk-form [name="name"]').fill('百度文件系统卷');
      if(!process.env.ONEMOUNT_TEST_EXE)await page.screenshot({path:path.join(profile,'create-volume.png')});
      await page.locator('[data-action="create-disk"]').click(interaction);
      await page.getByRole('heading',{name:'百度文件系统卷',exact:true}).waitFor();
      assert.ok(!(await page.locator('#content').innerText()).includes('百度网盘不接受空文件'));
      let snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[0].mode,'juicefs');assert.equal(snapshot.disks[0].writeback,true);
      const volumeId=snapshot.disks[0].id;
      await page.locator('[data-tab="cache"]').click(interaction);
      assert.equal(await page.locator('#cache-settings [name="writeback"]').isChecked(),true);
      await page.locator('#cache-settings [name="writeback"]').uncheck(interaction);
      await page.locator('#cache-settings [name="cacheGiB"]').fill('20');
      await page.locator('[data-action="save-cache-settings"]').click(interaction);
      snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[0].writeback,false);assert.equal(snapshot.disks[0].cacheGiB,20);
      await page.reload();await page.locator(`#shortcuts [data-id="${volumeId}"]`).click(interaction);
      await page.locator('[data-tab="cache"]').click(interaction);
      assert.equal(await page.locator('#cache-settings [name="writeback"]').isChecked(),false);
      assert.equal(await page.locator('#cache-settings [name="cacheGiB"]').inputValue(),'20');
      await page.locator('#cache-settings [name="writeback"]').check(interaction);
      await page.locator('[data-action="save-cache-settings"]').click(interaction);
      snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[0].writeback,true);
      await page.locator('[data-tab="advanced"]').click(interaction);
      await page.locator('#disk-settings [name="name"]').fill('百度文件系统卷 · 已配置');
      await page.locator('[data-action="save-disk-settings"]').click(interaction);
      snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[0].writeback,true);assert.equal(snapshot.disks[0].cacheGiB,20);
      await page.locator('[data-tab="cache"]').click(interaction);
      await page.locator('#toast').evaluate(el=>el.hidden=true);
      if(!process.env.ONEMOUNT_TEST_EXE)await page.screenshot({path:path.join(profile,'cache-settings.png')});
      await page.locator('.ir-nav [data-nav="home"]').click(interaction);await page.locator('[data-action="add-disk"]').first().click(interaction);
      await page.locator('#add-disk-form [name="connectionId"]').selectOption('baidu');
      await page.locator('#add-disk-form [name="name"]').fill('百度直连');await page.locator('[data-action="create-disk"]').click(interaction);
      await page.getByRole('heading',{name:'百度直连',exact:true}).waitFor();
      assert.ok((await page.locator('#content').innerText()).includes('百度网盘不接受空文件'));
      await page.locator('[data-tab="cache"]').click(interaction);
      assert.equal(await page.locator('#cache-settings [name="writeback"]').count(),0);
      await page.locator('#cache-settings [name="cacheGiB"]').fill('15');
      await page.locator('[data-action="save-cache-settings"]').click(interaction);
      snapshot=await page.evaluate(()=>window.island.invoke('snapshot'));
      assert.equal(snapshot.disks[1].cacheGiB,15);assert.equal(snapshot.disks[1].writeback,false);
      assert.deepEqual(errors,[]);console.log('PASS default writeback, real IPC cache toggle/save/reload, rename preserves cache settings, direct cache settings, no renderer errors; profile: '+profile);
    }finally{
      if(app){await page?.evaluate(()=>window.island.invoke('quit')).catch(()=>{});await app.close();}
    }
  })().catch(e=>{console.error(e);process.exitCode=1;});
}
