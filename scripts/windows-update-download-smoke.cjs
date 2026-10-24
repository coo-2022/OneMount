'use strict';

// Real Electron networking and electron-updater checksum verification against a
// loopback feed. The fixture installer is downloaded only, never executed.
// This does not validate public CDN delivery or Authenticode signing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '..');
const fixtureRoot = path.join(root, 'test-results', 'install-test-fixtures');

function contained(parent, file) {
  const relative = path.relative(path.resolve(parent), path.resolve(file));
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function digest(file, algorithm, encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

// Serialized into a temporary app with version 0.0.1. No production application
// entry point or user profile is loaded; only the production update service is.
async function electronHarness() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const {app} = require('electron');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'harness-config.json'), 'utf8'));
  app.setName('OneMount Update Download Test');
  app.setPath('userData', config.profile);
  app.setPath('sessionData', config.profile);
  app.disableHardwareAcceleration();
  const report = {passed: false, fixtureVersion: config.version, checks: [], publicCDNTested: false, authenticodeTested: false};
  try {
    await app.whenReady();
    const {NsisUpdater} = require(path.join(config.repo, 'node_modules', 'electron-updater'));
    const {UpdateService} = require(path.join(config.repo, 'src', 'updates.cjs'));
    assert.equal(app.getVersion(), '0.0.1');
    for (const name of ['bad', 'good']) {
      const cache = path.join(config.work, name, 'cache');
      fs.mkdirSync(cache, {recursive: true});
      const updater = new NsisUpdater();
      updater.forceDevUpdateConfig = true;
      updater.disableDifferentialDownload = true;
      // Test-only main-process injection. No arbitrary feed IPC exists in OneMount.
      updater.updateConfigPath = path.join(config.work, name, 'app-update.yml');
      Object.defineProperty(updater.app, 'baseCachePath', {value: cache});
      let installAttempts = 0;
      updater.quitAndInstall = updater.install = () => {installAttempts++; throw new Error('This harness must never install an update');};
      const service = new UpdateService({updater, installed: true, currentVersion: app.getVersion(),
        prepareInstall: async () => {throw new Error('Installation is forbidden in the download harness');}});
      const transitions = [];
      service.on('change', () => {const status = service.snapshot().status; if (transitions.at(-1) !== status) transitions.push(status);});
      try {
        assert.equal((await service.check()).version, config.version);
        assert.equal(service.snapshot().status, 'available');
        if (name === 'bad') {
          await assert.rejects(service.download(), /验证失败/);
          assert.equal(service.snapshot().errorCode, 'verification-failed');
          assert.equal(service.snapshot().canInstall, false);
          assert.equal(updater.installerPath, null);
          report.checks.push({name: 'wrong SHA-512 rejected by real downloader', passed: true, transitions});
        } else {
          await service.download();
          assert.equal(service.snapshot().status, 'downloaded');
          assert.equal(service.snapshot().canInstall, true);
          const file = updater.installerPath;
          const relative = path.relative(cache, file);
          assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'download must stay inside isolated cache');
          const hash = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
          const actual = hash.digest('hex');
          assert.equal(actual, config.sha256);
          assert.equal(fs.statSync(file).size, config.size);
          report.checks.push({name: 'valid SHA-512 accepted and downloaded bytes match fixture', passed: true,
            bytes: config.size, sha256: actual, downloadPath: file, transitions});
        }
        assert.equal(installAttempts, 0);
        assert.equal(updater.autoDownload, false);
        assert.equal(updater.autoInstallOnAppQuit, false);
      } finally {service.dispose();}
    }
    report.passed = true;
  } catch (error) {
    report.error = {message: error.message, stack: error.stack};
  } finally {
    fs.writeFileSync(config.report, JSON.stringify(report, null, 2) + '\n');
    app.exit(report.passed ? 0 : 1);
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.purpose !== 'onemount-installer-smoke' ||
      !/^com\.onemount\.install-test\./.test(manifest.appId) || manifest.installerV1?.version !== '0.0.1' || manifest.installerV2?.version !== '0.0.2') {
    throw new Error('Expected the isolated installer test fixture manifest');
  }
  const fixture = manifest.installerV2;
  if (!contained(fixtureRoot, fixture.path) || !contained(fs.realpathSync(fixtureRoot), fs.realpathSync(fixture.path))) {
    throw new Error('Installer fixture must be inside the isolated fixture directory');
  }
  if (await digest(fixture.path, 'sha256') !== fixture.sha256) throw new Error('Installer fixture SHA-256 does not match its manifest');
  const sha512 = await digest(fixture.path, 'sha512', 'base64'), size = fs.statSync(fixture.path).size;
  const base = path.join(root, 'test-results', 'update-download-smoke');
  fs.mkdirSync(base, {recursive: true});
  const work = fs.mkdtempSync(path.join(base, 'run-'));
  const entry = path.join(work, 'electron-app'), profile = path.join(work, 'profile');
  fs.mkdirSync(entry); fs.mkdirSync(profile);
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({method: request.method, path: pathname});
    const match = /^\/(bad|good)\/(latest\.yml|fixture\.exe)$/.exec(pathname);
    if (request.method !== 'GET' || !match) {response.writeHead(404); response.end(); return;}
    if (match[2] === 'latest.yml') {
      const hash = match[1] === 'bad' ? Buffer.alloc(64).toString('base64') : sha512;
      // JSON strings are also valid YAML scalars.
      const metadata = `version: ${fixture.version}\nfiles:\n  - url: fixture.exe\n    sha512: ${JSON.stringify(hash)}\n    size: ${size}\npath: fixture.exe\nsha512: ${JSON.stringify(hash)}\n`;
      response.writeHead(200, {'Content-Type': 'text/yaml', 'Cache-Control': 'no-store'}); response.end(metadata);
    } else {
      response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store'});
      const stream = fs.createReadStream(fixture.path);
      stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {server.once('listening', resolve); server.once('error', reject);});
  const port = server.address().port, reportFile = path.join(work, 'report.json');
  for (const name of ['bad', 'good']) {
    fs.mkdirSync(path.join(work, name));
    fs.writeFileSync(path.join(work, name, 'app-update.yml'), `provider: generic\nurl: http://127.0.0.1:${port}/${name}/\nupdaterCacheDirName: fixture-download\n`);
  }
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({name: 'onemount-update-download-test', version: '0.0.1', main: 'main.cjs'}));
  fs.writeFileSync(path.join(entry, 'harness-config.json'), JSON.stringify({repo: root, work, profile, report: reportFile, version: fixture.version, size, sha256: fixture.sha256}));
  fs.writeFileSync(path.join(entry, 'main.cjs'), `(${electronHarness.toString()})();\n`);
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let childError;
  try {
    const result = await execFileAsync(require('electron'), [entry], {cwd: entry, env, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024});
    fs.writeFileSync(path.join(work, 'electron.log'), result.stdout + result.stderr);
  } catch (error) {
    childError = error;
    fs.writeFileSync(path.join(work, 'electron.log'), String(error.stdout || '') + String(error.stderr || ''));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(work, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
  }
  if (!fs.existsSync(reportFile)) throw new Error(`Electron harness did not produce a result. See ${path.join(work, 'electron.log')}`);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  report.requests = requests;
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(base, 'latest.json'), JSON.stringify({report: reportFile, passed: report.passed}, null, 2) + '\n');
  console.log(JSON.stringify({passed: report.passed, checks: report.checks, report: reportFile}, null, 2));
  if (childError || !report.passed) throw new Error(`Download smoke test failed. See ${reportFile}`);
}

if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
