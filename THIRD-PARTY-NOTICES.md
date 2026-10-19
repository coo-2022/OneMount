# Third-party components

OneMount application code is MIT licensed. Components retain their original licenses.

| Component | Pinned version | License | Source |
| --- | --- | --- | --- |
| rclone | 1.75.0 | MIT | https://github.com/rclone/rclone/tree/v1.75.0 |
| JuiceFS Community Edition | 1.3.0 | Apache-2.0 | https://github.com/juicedata/juicefs/tree/v1.3.0 |
| Electron | 44.7.0 | MIT plus Chromium/Node third-party notices | https://github.com/electron/electron |
| Lucide icon subset | from bundled Lucide package | ISC, with Lucide's included Feather notice | https://lucide.dev/license |
| node-qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| Alibaba Cloud OSS SDK for Go | 3.0.2 | Apache-2.0 | https://github.com/aliyun/aliyun-oss-go-sdk/tree/v3.0.2 |

The 115 adapter's protocol definitions were checked against [OpenListTeam/115-sdk-go](https://github.com/OpenListTeam/115-sdk-go) (Apache-2.0). It does not embed the OpenList server or its AGPL driver. No third-party application's credentials or token relay service are bundled.

Full engine and icon license texts are in `licenses/`. Electron's `LICENSE` and `LICENSES.chromium.html` are included by its packager. JuiceFS is redistributed as the verified upstream executable. rclone is compiled from its pinned Go module together with the OneMount entry point and local backends; the distribution is identified as `v1.75.0-onemount`. Source links above identify the corresponding upstream projects.

WinFsp is a separately installed system dependency. Its installer and licensing are provided by the official project: https://winfsp.dev/.

The JuiceFS archive SHA-256 is pinned in `scripts/fetch-engines.ps1`. rclone dependencies are locked in `engine-src/rclone/go.mod` and `go.sum`; its build identity and binary checksum are in the packaged `resources/engines/rclone-build.json`. The application hides engine configuration from ordinary product flows; license attribution remains available with the distributed source and package.
