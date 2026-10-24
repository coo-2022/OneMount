'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze([
  {id: 'local', name: '本地文件夹'},
  {id: 'webdav', name: 'WebDAV'},
  {id: 's3', name: 'S3 兼容存储'},
  {id: 'onedrive', name: 'OneDrive', oauth: true},
  {id: 'drive', name: 'Google Drive', oauth: true},
  {id: 'dropbox', name: 'Dropbox', oauth: true},
  {id: 'baidu', name: '百度网盘', oauth: true, secretRequired: true},
].map(Object.freeze));

function normalizeProviderConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(k => k !== 'enabledProviders') || !Array.isArray(config.enabledProviders)) {
    throw new Error('provider-config.json 格式无效，需要 enabledProviders 列表。');
  }
  const ids = config.enabledProviders;
  if (ids.some(id => typeof id !== 'string' || !PROVIDERS.some(p => p.id === id)) || new Set(ids).size !== ids.length) {
    throw new Error('provider-config.json 包含未知或重复的服务，请检查配置。');
  }
  return {enabledProviders: [...ids]};
}

function loadProviderConfig({root = path.resolve(__dirname, '..'), executableDir} = {}) {
  // An editable file next to the packaged executable overrides the bundled default.
  const external = executableDir && path.join(executableDir, 'provider-config.json');
  const file = external && fs.existsSync(external) ? external : path.join(root, 'provider-config.json');
  let config;
  try {config = JSON.parse(fs.readFileSync(file, 'utf8'));}
  catch {throw new Error('无法读取 provider-config.json，请检查文件存在且为有效 JSON。');}
  // Never silently enable every provider after a configuration error.
  return normalizeProviderConfig(config);
}

function listServices(config, oauthClients) {
  return PROVIDERS.filter(p => config.enabledProviders.includes(p.id)).map(p => ({
    id: p.id, name: p.name,
    available: !p.oauth || !!oauthClients[p.id]?.clientId && (!p.secretRequired || !!oauthClients[p.id]?.clientSecret),
  }));
}

function loadOAuthClients({root = path.resolve(__dirname, '..'), executableDir} = {}) {
  const external = executableDir && path.join(executableDir, 'oauth-clients.json');
  const file = external && fs.existsSync(external) ? external : path.join(root, 'oauth-clients.json');
  try {
    const clients = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!clients || typeof clients !== 'object' || Array.isArray(clients) ||
        Object.values(clients).some(c => !c || typeof c !== 'object' || Array.isArray(c) ||
          typeof c.clientId !== 'string' || typeof c.clientSecret !== 'string')) throw new Error();
    return clients;
  } catch {throw new Error('无法读取应用登录配置，请检查 oauth-clients.json 格式。');}
}

module.exports = {PROVIDERS, normalizeProviderConfig, loadProviderConfig, loadOAuthClients, listServices};
