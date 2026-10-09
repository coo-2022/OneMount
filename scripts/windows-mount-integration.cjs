'use strict';
// Exercises the production Manager and real Windows drivers, not --help.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {Manager} = require('../src/manager.cjs');
const P = require('../src/processes.cjs');
if (process.platform !== 'win32') throw new Error('Windows with WinFsp required');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'onemount-mount-test-'));
const letter = [...'ZYXWVUTSRQPONMLKJIHGFE'].find(c => !fs.existsSync(c + ':\\')) + ':';
assert.match(letter, /^[E-Z]:$/);
const state = path.join(base, 'state');
const m = new Manager({root: state, engines: path.resolve(__dirname, '../engines'),
  // Test-only storage wrapper; no real account credentials enter this temporary fixture.
  protect: s => Buffer.from(s).toString('base64'), unprotect: s => Buffer.from(s, 'base64').toString()});
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  console.log('Windows mount test state:', base);
  await m.init();
  assert.ok(m.health.winfsp, 'WinFsp must be installed');
  const backend = path.join(base, 'backend'); fs.mkdirSync(backend);
  const connectionId = await m.addLocal({name: 'Mount integration', path: backend});
  for (const writeback of [false, true]) {
    const id = await m.addDisk({connectionId, name: 'Volume ' + writeback, mode: 'juicefs', letter, cacheGiB: 1, writeback});
    const files = {'hello.txt': Buffer.from('hello juicefs + rclone'), 'empty': Buffer.alloc(0), '中文 空格/large.bin': crypto.randomBytes(12 * 1024 ** 2 + 137)};
    await m.mount(id);
    assert.equal(m.snapshot().disks.find(d => d.id === id).status, 'mounted');
    for (const [name, data] of Object.entries(files)) {
      const file = path.join(letter + '\\', name);
      // Windows rejects mkdir on a drive root even with recursive=true.
      if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, data); assert.equal(hash(fs.readFileSync(file)), hash(data));
    }
    // Reproduce the user's exact PowerShell access pattern as well as Node I/O.
    await P.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Set-Content '${letter}\\powershell.txt' 'hello juicefs + rclone'; if ((Get-Content '${letter}\\powershell.txt' -Raw).Trim() -ne 'hello juicefs + rclone') { throw 'Read mismatch' }`]);
    await m.unmount(id);
    assert.ok(!fs.existsSync(letter + '\\'));
    // Eliminate the read cache only after a clean flush/unmount, and only in this new test fixture.
    const paths = m.paths(m.disk(id));
    fs.rmSync(paths.cache, {recursive: true, force: true});
    const metaBefore = fs.statSync(paths.meta).size;
    const portBefore = m.disk(id).gatewayPort;
    await m.mount(id);
    assert.equal(m.disk(id).gatewayPort, portBefore);
    assert.ok(metaBefore > 0);
    for (const [name, data] of Object.entries(files)) assert.equal(hash(fs.readFileSync(path.join(letter + '\\', name))), hash(data));
    fs.appendFileSync(letter + '\\hello.txt', '\nupdated');
    assert.match(fs.readFileSync(letter + '\\hello.txt', 'utf8'), /updated$/);
    fs.renameSync(letter + '\\hello.txt', letter + '\\renamed.txt');
    fs.unlinkSync(letter + '\\renamed.txt');
    await m.unmount(id);
    console.log(`PASS real Windows mount / PowerShell read-write / flush / cold-cache remount / hash / rename-delete; writeback=${writeback}`);
  }
}
main().catch(e => {
  console.error(e); process.exitCode = 1;
  for (const d of m.state.disks) for (const file of [m.paths(d).jfsLog, m.paths(d).log]) {
    if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8').slice(-16000));
  }
}).finally(async () => {
  try {await m.shutdown();} catch (e) {console.error('Safe shutdown failed:', e.message); process.exitCode = 1;}
  clearInterval(m.timer);
});
