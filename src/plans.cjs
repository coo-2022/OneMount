'use strict';
const path = require('node:path');

function validateDisk(input, disks) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 48) throw new Error('磁盘名称应为 1–48 个字符');
  if (!['direct', 'juicefs'].includes(input.mode)) throw new Error('未知挂载模式');
  const letter = String(input.letter || '').toUpperCase();
  if (!/^[D-Z]:$/.test(letter)) throw new Error('请选择 D: 到 Z: 之间的盘符');
  if (disks.some(d => d.letter === letter)) throw new Error('这个盘符已分配给其他磁盘');
  const cacheGiB = Number(input.cacheGiB);
  if (!Number.isInteger(cacheGiB) || cacheGiB < 1 || cacheGiB > 2048) throw new Error('缓存上限应为 1–2048 GB');
  return {name, mode: input.mode, letter, cacheGiB, writeback: input.mode === 'juicefs' && input.writeback === true, autoMount: input.autoMount === true};
}

function backendRoot(connection, diskId) {
  if (!/^[a-f0-9-]{36}$/.test(diskId)) throw new Error('无效磁盘标识');
  if (connection.type === 'local') return path.join(connection.source, '.cloud-island', diskId);
  return connection.source.replace(/\/$/, '') + (connection.source.endsWith(':') ? '' : '/') + '.cloud-island/' + diskId;
}

function gatewayArgs(root, port, rcPort, cacheDir, config) {
  return ['serve', 's3', root, '--addr', `127.0.0.1:${port}`, '--vfs-cache-mode', 'off',
    '--rc', '--rc-addr', `127.0.0.1:${rcPort}`, '--rc-user', 'cloud-island', '--cache-dir', cacheDir,
    '--config', config, '--log-level', 'INFO'];
}

function formatArgs(port, volumeName) {
  return ['format', '--no-update', '--storage', 's3', '--bucket', `http://127.0.0.1:${port}/jfs`, 'sqlite3://meta.db', volumeName];
}

function juiceMountArgs(disk, paths, metricsPort) {
  // JuiceFS 1.3.0 --as-root already sets WinFsp uid=-1,gid=-1, which
  // presents ownership as the mounting Windows user while using POSIX root
  // internally. Do not override it: WinFsp explicitly rejects uidmap UID 0.
  const args = ['mount', '--no-usage-report', '--as-root',
    '--cache-dir', paths.cache, '--cache-size', String(disk.cacheGiB * 1024),
    '--metrics', `127.0.0.1:${metricsPort}`];
  if (disk.writeback) args.push('--writeback');
  args.push('sqlite3://meta.db', disk.letter);
  return args;
}

function directMountBody(disk, connection) {
  return {fs: connection.source, mountPoint: disk.letter, mountType: 'cmount',
    vfsOpt: {FilePerms: 0o777, CacheMode: 3, CacheMaxSize: disk.cacheGiB * 1024 ** 3, WriteBack: 5e9},
    mountOpt: {VolName: disk.name}};
}

function parseMetrics(raw) {
  const values = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+)(?:\{[^}]*\})?\s+([-+\d.eE]+)(?:\s|$)/);
    if (m) values[m[1]] = (values[m[1]] || 0) + Number(m[2]);
  }
  const get = suffix => {
    const keys = Object.keys(values).filter(k => k === suffix || k.endsWith('_' + suffix));
    return keys.length ? keys.reduce((n, k) => n + values[k], 0) : null;
  };
  return {pendingBlocks: get('staging_blocks'), pendingBytes: get('staging_block_bytes'),
    cacheBytes: get('blockcache_bytes'), usedBytes: get('used_space'),
    bufferBytes: get('used_buffer_size'), raw: values};
}

function pendingDirect(stats, queue) {
  if (!stats?.diskCache || !Array.isArray(queue)) return {known: false, pending: true};
  const c = stats.diskCache;
  return {known: true, pending: queue.length > 0 || c.uploadsInProgress > 0 || c.uploadsQueued > 0 || c.erroredFiles > 0};
}

module.exports = {validateDisk, backendRoot, gatewayArgs, formatArgs, juiceMountArgs, directMountBody, parseMetrics, pendingDirect};
