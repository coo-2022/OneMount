# Windows 安装与软件更新

## 使用方式

Windows x64 安装包名为 `OneMount-Setup-<版本>-x64.exe`。默认安装到当前用户的程序目录，可选择安装位置，创建开始菜单入口。安装包包含 OneMount、rclone 和 JuiceFS，不需要用户安装 Node.js。WinFsp 仍通过软件中的「安装驱动」入口从官方页面单独安装；应用安装器不会静默安装系统驱动。

安装向导完成页默认勾选运行 OneMount，点击完成后重新打开应用；用户也可以取消勾选，稍后从开始菜单启动。自动化隔离测试使用静默安装且不传强制启动参数，因此不会打开真实用户配置。

既有便携版仍可使用。安装版与便携版继续共用原有 `%APPDATA%\CloudIsland` 账户、磁盘、元数据和缓存配置。换用安装版前，应先在旧版「设置 → 安全退出」退出。不能同时运行两个版本。

安装版的「设置 → 软件更新」支持：

- 检查更新、下载更新、下载进度与速度、确认后重新启动安装。
- 可选启动时检查更新，默认关闭；可选接收预览版本，默认关闭。
- 下载完成后仍需用户选择安装，普通退出不会偷偷安装。
- 安装前走应用原有安全退出流程。正在连接账户、执行其他操作、尚有上传或不能安全卸载时，停止安装并保留可重试状态。
- 更新请求遵循软件的直接连接/手动代理设置；修改代理后重新启动生效。

便携版、开发环境以及未通过安装程序安装的 `win-unpacked` 目录不启用应用内安装更新，提供发布页入口。安装器放置的 `resources/install-mode.json`、卸载程序和 `app-update.yml` 共同用于区分安装版。

首次安装之后，覆盖升级必须使用已注册的安装目录。改变目录会在旧版卸载之前拒绝安装，防止丢失该目录中的自定义配置。应用或该目录的 rclone/JuiceFS 进程还在运行时，安装和卸载均会退出；不会强制结束进程。请使用应用的「安全退出」后重试。

安装目录中的 `provider-config.json` 和 `oauth-clients.json` 是发布者可配置项。升级会保留已有文件的原始内容；新安装使用安装包中的默认文件。卸载不删除 `%APPDATA%\CloudIsland`，也不删除外部缓存、元数据或远端文件。安装目录内的程序和这两个发布配置文件会随卸载移除。

## 构建与检查

依赖固定为 Electron 44.7.0、electron-builder 26.15.3、electron-updater 6.8.9，并通过 `package-lock.json` 固定依赖树。

```powershell
npm ci
npm run engines:win
npm test
npm run installer:win
npm run installer:check
```

输出目录为 `dist/installer/`：

| 文件 | 用途 |
| --- | --- |
| `OneMount-Setup-<版本>-x64.exe` | 完整安装包 |
| `OneMount-Setup-<版本>-x64.exe.blockmap` | 增量下载元数据 |
| `latest.yml` | 版本、安装包路径、大小、SHA-512 校验值 |
| `BUILD-CHECK.json` | 打包范围、引擎 SHA-256 和更新文件校验结果 |
| `win-unpacked/` | 构建中间输出，仅用于检查和测试 |

`installer:check` 检查归档顶层白名单、排除开发资料和私有配置文件、包内默认配置与输入一致、升级依赖存在、引擎与指定构建输入逐字节一致，以及安装包与更新元数据的大小/SHA-512 一致。

安装包使用显式文件白名单，不读取 `oauth-clients.local.json`，不包含 `test-results/`、测试账户、引擎源码或开发目录。正式发行前仍需确认作为输入的 `oauth-clients.json` 本身是计划公开分发的配置；不要在公共构建中运行会写入私有凭据的配置脚本。

可用 `ONEMOUNT_ENGINE_DIR` 显式指定已验证的引擎目录，默认读取 `engines/`；可用 `ONEMOUNT_ELECTRON_DIST` 指定本机已解压的 Electron，例如 `node_modules/electron/dist`。这两项只影响构建输入，不影响安装后的路径。

`npm run package:win` 保留原有便携包输出 `dist/OneMount-win32-x64/`，不会产生可自动安装更新的标记。

## 发布约定

构建命令固定 `publish: never`，不会自动创建 GitHub Release。Windows 工作流上传安装包、blockmap、更新元数据和检查结果为构建附件。

真实升级需要发布一个高于当前版本的 GitHub Release，并同时上传安装包、对应 blockmap 和更新通道的 YAML 文件；仓库固定为 `coo-2022/OneMount`。稳定版使用 `latest.yml`。若发布预览版，应使用与 electron-updater 通道匹配的版本及元数据（例如 `0.8.0-beta.1` 对应 `beta.yml`），不能仅把普通安装包改名或只上传 EXE。发布前须验证生成的元数据，不能手工复用旧版本校验值。

旧的 v0.7.0 便携发布没有这些更新资源，因此不能据此声称已完成公网升级验收。当前开发修改不自动提高版本、不发布新 Release。代码签名证书尚未配置；SHA-512 验证保障下载完整性，不等同于 Windows 发布者代码签名。

## 隔离验收

`scripts/build-install-test-fixtures.cjs` 和 `scripts/windows-install-update-smoke.cjs` 用于隔离安装、覆盖升级、卸载、配置保留、运行中拒绝安装及应用更新交互验收。测试使用独立的应用 ID、NSIS GUID、程序和快捷方式名称、安装目录和用户数据目录，不向真实 OneMount 配置写测试账户，也不终止用户的磁盘进程。

构建器只允许带 `install-test` 标识的测试应用覆盖版本与身份，不允许复用生产 GUID。详细执行结果保存在 `test-results/`；仅生成安装包不算完成实际安装或升级验证。

## 实现依据

- [electron-builder v26 NSIS 文档](https://www.electron.build/v26/docs/nsis)
- [electron-builder v26 自动更新文档](https://www.electron.build/v26/docs/auto-update)

`installer/safe-install.nsh` 用 `customCheckAppRunning` 完整替换固定版本构建器的自动关闭逻辑；安装保护行为必须随 electron-builder 依赖升级重新验收。
