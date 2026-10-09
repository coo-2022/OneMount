'use strict';
// Validate generated commands against the real bundled Windows executables.
// --help does not format, mount, or connect to a backend.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const plans = require('../src/plans.cjs');
if (process.platform !== 'win32') throw new Error('Run this check on Windows with the bundled Windows engines');
const root = path.resolve(__dirname, '..');
function invoke(engine, args) {
  const result = spawnSync(path.join(root, 'engines', engine + '.exe'), args, {encoding: 'utf8', windowsHide: true, timeout: 15000});
  if (result.error) throw result.error;
  return {...result, output: (result.stdout || '') + (result.stderr || '')};
}
function check(engine, args) {
  const result = invoke(engine, [...args, '--help']);
  assert.equal(result.status, 0, `${engine} rejected generated arguments:\n${result.output}`);
  assert.match(result.output, /USAGE:|Usage:/, 'Expected help output without performing the operation');
}
const d = {name: 'compatibility-check', letter: 'X:', cacheGiB: 10, writeback: false};
for (const writeback of [false, true]) check('juicefs', plans.juiceMountArgs({...d, writeback}, {cache: path.join(root, 'test-cache-not-created')}, 19567));
check('juicefs', plans.formatArgs(18765, 'compatibilitycheck'));
check('rclone', plans.gatewayArgs(path.join(root, 'test-backend-not-created'), 18765, 18766, path.join(root, 'test-cache-not-created'), path.join(root, 'test-config-not-created')));
// Negative control proves that --help does not hide the original parser failure.
const invalid = invoke('juicefs', ['mount', '--umask', '022', '--help']);
assert.notEqual(invalid.status, 0, 'Negative control unexpectedly accepted --umask');
assert.match(invalid.output, /unknown option: --umask/);
console.log('PASS: real Windows engine parsers accept both mount policies, format, and S3 gateway commands; Unix-only flag rejected as expected.');
