'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const {setTimeout: delay} = require('node:timers/promises');

function cleanEnv(extra = {}) {
  const env = {...process.env};
  for (const k of Object.keys(env)) if (/^(RCLONE_|JFS_|ACCESS_KEY$|SECRET_KEY$|JUICEFS_)/i.test(k)) delete env[k];
  return {...env, ...extra};
}

function run(file, args, {cwd, env = {}, timeout = 30000, maxBytes = 2 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, {cwd, env: cleanEnv(env), windowsHide: true, shell: false});
    let out = '', err = '', expired = false;
    const timer = setTimeout(() => {expired = true; p.kill();}, timeout);
    const append = (s, d) => (s + d.toString()).slice(-maxBytes);
    p.stdout.on('data', d => out = append(out, d));
    p.stderr.on('data', d => err = append(err, d));
    p.once('error', e => {clearTimeout(timer); reject(e);});
    p.once('close', code => {clearTimeout(timer); if (code === 0 && !expired) resolve(out); else reject(new Error(expired ? '操作超时，请查看日志' : err.trim() || out.trim() || `进程退出 (${code})`));});
  });
}

function launch(file, args, {cwd, env = {}, logfile, secrets = [], onExit = () => {}}) {
  const redact = s => secrets.reduce((v, secret) => secret ? v.split(secret).join('[redacted]') : v, s);
  // Bounded log with line buffering: redaction must not be bypassed by stream chunk boundaries.
  let size = fs.existsSync(logfile) ? fs.statSync(logfile).size : 0;
  function log(s) {
    if (size > 5 * 1024 * 1024) {try {fs.renameSync(logfile, logfile + '.1');} catch {} size = 0;}
    const line = redact(s); fs.appendFileSync(logfile, line, {mode: 0o600}); size += Buffer.byteLength(line);
  }
  log(`\n[${new Date().toISOString()}] Starting ${require('node:path').basename(file)}\n`);
  const p = spawn(file, args, {cwd, env: cleanEnv(env), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [p.stdout, p.stderr]) {
    let buffer = '';
    stream.on('data', data => {buffer += data.toString(); let i; while ((i = buffer.indexOf('\n')) >= 0) {log(buffer.slice(0, i + 1)); buffer = buffer.slice(i + 1);} if (buffer.length > 65536) {log('[oversized log line omitted]\n'); buffer = '';}});
    stream.on('end', () => {if (buffer) log(buffer + '\n');});
  }
  p.once('error', e => {log(e.message + '\n'); onExit(e.message);});
  p.once('exit', code => {log(`Process exited (${code})\n`); onExit(code);});
  return p;
}

function alive(pid) {if (!Number.isInteger(pid) || pid < 1) return false; try {process.kill(pid, 0); return true;} catch {return false;}}
async function waitExit(proc, timeout = 45000) {
  const until = Date.now() + timeout;
  while (alive(proc.pid)) {if (Date.now() > until) throw new Error('进程尚未退出，已保留网关和缓存。请关闭使用此磁盘的程序后重试。'); await delay(300);}
}

async function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${preferred || ''} 被占用；未修改已有卷的存储地址。`)));
    server.listen(preferred || 0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});
  });
}

async function rc(runtime, method, data = {}, timeout = 5000) {
  const response = await fetch(`http://127.0.0.1:${runtime.rcPort}/${method}`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`cloud-island:${runtime.rcPass}`).toString('base64')},
    body: JSON.stringify(data), signal: AbortSignal.timeout(timeout)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `rclone RC ${response.status}`);
  return result;
}

async function waitFor(fn, timeout = 30000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {try {const result = await fn(); if (result) return result;} catch (e) {last = e;} await delay(350);}
  throw new Error(last?.message || '等待服务启动超时');
}

module.exports = {run, launch, alive, waitExit, freePort, rc, waitFor, cleanEnv, delay};
