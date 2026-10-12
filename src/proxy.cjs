'use strict';

const PROXY_KEYS = /^(https?_proxy|all_proxy|no_proxy)$/i;
const LOOPBACK = 'localhost,127.0.0.1,::1';

function normalizeProxy(value = {mode: 'direct'}) {
  if (!value || !['inherit', 'direct', 'manual'].includes(value.mode)) throw new Error('请选择有效的代理模式');
  // Migrate the old environment-inheritance option to explicit direct access.
  if (value.mode !== 'manual') return {mode: 'direct', url: ''};
  const raw = typeof value.url === 'string' ? value.url.trim() : '';
  let url;
  try {url = new URL(raw);} catch {throw new Error('请填写完整的代理地址，例如 http://127.0.0.1:7892');}
  if (raw.length > 2048 || /\s/.test(raw) || !['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('代理地址仅支持 HTTP、HTTPS 或 SOCKS5，请勿包含账号、密码、路径或查询参数');
  }
  return {mode: 'manual', url: url.href.replace(/\/$/, '')};
}

// Only child engines receive these overrides. The UI's local control requests
// and the JuiceFS loopback gateway must not be routed through a remote proxy.
function proxyEnv(config) {
  const proxy = normalizeProxy(config);
  const env = {HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: LOOPBACK};
  if (proxy.mode === 'manual') env.HTTP_PROXY = env.HTTPS_PROXY = proxy.url;
  return env;
}

module.exports = {normalizeProxy, proxyEnv, PROXY_KEYS};
