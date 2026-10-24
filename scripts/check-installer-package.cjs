'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { installerConfig } = require('./build-installer.cjs');

async function main() {
  const { extractFile, listPackage } = await import('@electron/asar');
  const root = path.resolve(__dirname, '..');
  const config = installerConfig();
  const output = path.resolve(root, config.directories.output);
  const resources = path.join(output, 'win-unpacked', 'resources');
  const archive = path.join(resources, 'app.asar');
  const entries = listPackage(archive).map(file => file.replaceAll('\\', '/'));
  const allowed = new Set(['assets', 'src', 'ui', 'node_modules', 'package.json', 'provider-config.json', 'oauth-clients.json']);
  for (const entry of entries) {
    assert(allowed.has(entry.split('/')[1]), `Unexpected package entry: ${entry}`);
    assert(!/oauth-clients\.local\.json|(?:^|\/)(?:test-results|engine-src|\.env)(?:\/|$)/i.test(entry), `Private/development file in package: ${entry}`);
  }
  for (const file of ['provider-config.json', 'oauth-clients.json']) {
    assert(extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), `Bundled ${file} must match release input`);
  }
  assert(entries.includes('/src/bootstrap.cjs'), 'Missing application entry');
  assert(entries.includes('/node_modules/electron-updater/package.json'), 'Missing updater dependency');
  assert(entries.includes('/node_modules/electron-updater/LICENSE'), 'Missing updater license');
  assert(!fs.existsSync(path.join(resources, 'install-mode.json')), 'Unpacked/portable output must not identify itself as installed');
  const hashes = {};
  for (const file of ['rclone.exe', 'juicefs.exe']) {
    const packaged = fs.readFileSync(path.join(resources, 'engines', file));
    assert(packaged.equals(fs.readFileSync(path.resolve(root, config.extraResources[0].from, file))), `Wrong release engine: ${file}`);
    hashes[file] = crypto.createHash('sha256').update(packaged).digest('hex');
  }
  const provenance = path.resolve(root, config.extraResources[0].from, 'rclone-build.json');
  if (fs.existsSync(provenance)) {
    assert(fs.readFileSync(path.join(resources, 'engines', 'rclone-build.json')).equals(fs.readFileSync(provenance)), 'Missing or changed rclone build provenance');
  }
  const feed = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  assert.equal(feed.provider, 'github');
  assert.equal(feed.owner, 'coo-2022');
  assert.equal(feed.repo, 'OneMount');
  const metadata = yaml.load(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'));
  const setup = metadata.files.find(file => file.url.endsWith('.exe'));
  assert(setup && path.basename(setup.url) === setup.url, 'Invalid installer filename in metadata');
  const setupBytes = fs.readFileSync(path.join(output, setup.url));
  assert.equal(setupBytes.length, setup.size, 'Update size mismatch');
  assert.equal(crypto.createHash('sha512').update(setupBytes).digest('base64'), setup.sha512, 'Update checksum mismatch');
  assert(fs.existsSync(path.join(output, `${setup.url}.blockmap`)), 'Missing differential-update metadata');
  const result = { passed: true, installer: setup.url, version: metadata.version, files: entries.length, engineSHA256: hashes };
  fs.writeFileSync(path.join(output, 'BUILD-CHECK.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
