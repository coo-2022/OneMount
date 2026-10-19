'use strict';
const {normalizeProviderConfig} = require('../src/providers.cjs');

// Test selection belongs to the isolated test profile, not the shipped edition.
function selectedProviders(value, fallback) {
  return normalizeProviderConfig({enabledProviders: (value || fallback).split(',').map(id => id.trim())});
}

function cloudVolumeProviders(env = process.env) {
  return selectedProviders(env.ONEMOUNT_LIVE_TYPES, 'baidu,onedrive,drive');
}

function juicefsUpstreamProviders(env = process.env) {
  return selectedProviders(env.ONEMOUNT_UPSTREAM_TYPES, 'local,baidu,onedrive,drive');
}

module.exports = {cloudVolumeProviders, juicefsUpstreamProviders};
