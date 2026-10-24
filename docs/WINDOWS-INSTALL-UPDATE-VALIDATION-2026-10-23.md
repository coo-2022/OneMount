# Windows 安装与更新验证 · 2026-10-23

本轮为 Windows x64 安装与更新功能验证。实现位于 `codex/windows-install-update`，基于主干 `837644a4de09f85cf6c17c2fcbdd169394730b60`；没有合入待真实账号验证的 115 分支。没有发布 GitHub Release，也没有替换用户正在使用的安装或真实账号数据。

## 验证范围与结果

| 范围 | 验证内容 | 结果 |
| --- | --- | --- |
| 应用单元与回归 | 原有账号、磁盘、缓存等测试，以及更新状态机、代理、错误脱敏、并发操作、设置持久化 | 95/95 通过 |
| 安全退出 | 上传等原因阻止退出时不启动安装；准备退出期间错误不提前释放锁；更新失败不释放另一项退出操作的锁 | 通过 |
| 安装器失败恢复 | 异步启动失败取消已排队退出；使用真实 electron-updater 6.x 安装逻辑验证失败后可再次尝试 | 通过 |
| 实际 NSIS 安装 | 独立应用身份、GUID、快捷方式、安装目录和用户数据目录；当前用户安装，登记 HKCU 卸载项 | 通过 |
| 运行中保护 | 实际应用运行时，升级和卸载均拒绝操作，程序与文件保留 | 通过 |
| 升级目录保护 | 覆盖升级尝试改变已注册安装目录时，在替换旧文件前拒绝操作 | 通过 |
| 实际跨版本升级 | 测试版本 0.0.1 → 0.0.2；保留加密账号、磁盘记录、外部 provider/OAuth 配置原始字节，以及缓存/元数据哨兵 | 通过 |
| 实际卸载 | 移除测试应用和卸载项，保留隔离用户数据、元数据和缓存 | 通过 |
| 更新下载 | 实际 Electron 网络和 electron-updater，从回环 HTTP 服务下载真实 NSIS 安装包；错误 SHA-512 拒绝，正确 SHA-512 接受且 SHA-256 与原包一致 | 通过 |
| 打包 | 文件白名单、公开配置输入、生产更新依赖、引擎及来源记录、许可证、完整安装包及 blockmap/SHA-512 元数据 | 通过 |

隔离安装套件共 9 组检查通过，升级后的 V2 包含最终更新失败重试修复，界面无脚本异常或水平溢出，截图已查看。应用 UI 的版本发现和进度事件由测试注入。退出门禁运行实际主进程与管理器；异步启动失败用真实更新库安装路径、模拟进程启动失败。真实 NSIS 跨版本安装和真实更新下载分别独立验证，不能将它们描述为已完成 GitHub 公网一键升级。

本轮没有执行网盘读写或重新挂载文件系统；它不替代现有文件语义、真实云端上传和 WinFsp 测试。测试缓存与元数据使用哨兵文件验证保留行为，未伪称为远端持久性验证。

## 本地构建产物

- 安装包：`dist/installer/OneMount-Setup-0.7.0-x64.exe`
- 大小：155,458,030 字节。
- SHA-256：`f1a45ac68681b6a69f762c7792ef79e9131f676d0e0985d31d52cdbd39afeea1`
- 与该包配套的 `latest.yml`、`.exe.blockmap`、`BUILD-CHECK.json` 位于同一目录。
- 包内 23 个 `src/`、`ui/` 文件与最终源文件逐字节一致。
- rclone SHA-256：`080c018d446081e1b8a725044a88e15e995b08b09ed36dfa7e1b1725e039285e`。
- JuiceFS SHA-256：`ad1c2096241b3430908d7d3e6eae1671fd58e6946b3320ab8a6bf566ca58f31c`。

本地开发包沿用 0.7.0 版本号，未覆盖既有公开发布。真实在线升级需要先发布更高版本及对应更新元数据。安装包未配置 Authenticode 签名；本轮未验证公网 GitHub/CDN 分发、代码签名或 Windows 各版本兼容性。

## 可复跑入口与证据

- `npm test`；本地日志 `test-results/install-update-unit.log`。
- `npm run installer:win`、`npm run installer:check`。
- `node scripts/build-install-test-fixtures.cjs`，再运行 `node scripts/windows-install-update-smoke.cjs`。后者需要 `ONEMOUNT_PLAYWRIGHT` 指向隔离安装的 Playwright 模块。
- `node scripts/windows-update-download-smoke.cjs`，复用上述测试安装包。
- 安装验收报告：`test-results/windows-install-update-report.json`；界面截图：`test-results/installation-update-settings.png`。
- 下载验收报告索引：`test-results/update-download-smoke/latest.json`。

Windows CI 已接入上述新增检查。原始本地测试产物与临时配置不纳入 Git；CI 只上传报告、截图和日志。功能、部署配置和发布约定见 [Windows 安装与软件更新](windows-install-update.md)。
