'use strict';

const path = require('node:path');

// Kept separate from the portable build. Only release inputs are included; never
// package the developer checkout, test results, credentials or engine sources.
module.exports = {
  appId: 'com.cloudisland.desktop',
  productName: 'OneMount',
  executableName: 'OneMount',
  directories: { output: 'dist/installer', buildResources: 'installer' },
  asar: true,
  npmRebuild: false,
  files: [
    'package.json', 'src/**/*.cjs', 'ui/**/*', 'assets/**/*',
    'provider-config.json', 'oauth-clients.json',
    '!**/*.map', '!**/oauth-clients.local.json',
  ],
  extraResources: [{ from: 'engines', to: 'engines', filter: ['rclone.exe', 'juicefs.exe', 'rclone-build.json'] }],
  extraFiles: [
    { from: 'README.md', to: 'README.md' },
    { from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
    { from: 'LICENSE', to: 'LICENSE-OneMount' },
    { from: 'licenses', to: 'licenses', filter: ['**/*'] },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    guid: 'b8324b91-aedf-46d4-90b8-ce58fe8eb3ba',
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: 'OneMount',
    runAfterFinish: true,
    include: path.join(__dirname, 'installer', 'safe-install.nsh'),
    artifactName: 'OneMount-Setup-${version}-${arch}.${ext}',
    installerLanguages: ['zh_CN', 'en_US'],
    displayLanguageSelector: false,
  },
  publish: [{ provider: 'github', owner: 'coo-2022', repo: 'OneMount', releaseType: 'release' }],
};
