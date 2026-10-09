# Third-party components

OneMount application code is MIT licensed. Components retain their original licenses.

| Component | Pinned version | License | Source |
| --- | --- | --- | --- |
| rclone | 1.75.0 | MIT | https://github.com/rclone/rclone/tree/v1.75.0 |
| JuiceFS Community Edition | 1.3.0 | Apache-2.0 | https://github.com/juicedata/juicefs/tree/v1.3.0 |
| Electron | 44.7.0 | MIT plus Chromium/Node third-party notices | https://github.com/electron/electron |
| Lucide icon subset | from bundled Lucide package | ISC, with Lucide's included Feather notice | https://lucide.dev/license |

Full engine and icon license texts are in `licenses/`. Electron's `LICENSE` and `LICENSES.chromium.html` are included by its packager. The original engine executables are redistributed without source modification. Source links above identify the corresponding upstream projects.

WinFsp is a separately installed system dependency. Its installer and licensing are provided by the official project: https://winfsp.dev/.

Downloaded archive SHA-256 values are pinned in `scripts/fetch-engines.ps1`. The application hides engine configuration from ordinary product flows; license attribution remains available with the distributed source and package.
