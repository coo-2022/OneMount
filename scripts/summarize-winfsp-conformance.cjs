'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2] || 'direct';
if (!['direct', 'ntfs', 'juicefs', 'juicefs-writeback'].includes(mode)) throw Error('Unknown conformance target');
const file = path.resolve(__dirname, '..', 'test-results', 'conformance', mode, 'report.json');
const escape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
let lines;
if (!fs.existsSync(file)) {
  lines = ['## WinFsp conformance: no test report', '', 'Tool preparation or runner startup failed. No compatibility result is available.'];
  process.exitCode = 1;
} else {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = r.totals || {planned:r.catalog.length, passed:0, failed:0, timeout:0, notRun:r.catalog.length};
  lines = [`## WinFsp conformance: ${escape(mode)}`, '', `Status: **${escape(r.status)}**. Commit: ${escape(r.commit || process.env.GITHUB_SHA || 'unknown')}.`, '',
    '| Planned | Passed | Failed | Timed out | Not run |', '|---:|---:|---:|---:|---:|',
    `| ${t.planned} | ${t.passed} | ${t.failed} | ${t.timeout} | ${t.notRun} |`, '',
    'Strict conformance check: failures and timeouts remain failures. No known-failure exclusions. Counts are test entries/scripts, not individual assertions.', '',
    '| Case | Status | First failure or diagnostic |', '|---|---|---|'];
  for (const item of r.results.filter(x => x.status !== 'passed')) {
    const reason = item.error || (item.failure || [])[0] || (item.status === 'timeout' ? 'Per-case deadline exceeded; see raw log' : 'See raw log');
    lines.push(`| ${escape(item.id)} | ${escape(item.status)} | ${escape(reason)} |`);
  }
  if (r.error || r.shutdownError) lines.push('', 'Runner/shutdown error: ' + escape(r.error || r.shutdownError));
  if (r.notRun?.length) lines.push('', 'Not run: ' + r.notRun.map(x => escape(x.id)).join(', '));
  lines.push('', 'Full commands, TAP output, assertions and engine logs: `winfsp-conformance-' + mode + '` artifact (30 days).');
}
const text = lines.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
else process.stdout.write(text);
