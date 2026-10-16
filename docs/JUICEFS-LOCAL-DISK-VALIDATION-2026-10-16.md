# JuiceFS 本地磁盘挂载验证（2026-10-16）

云屿在 JuiceFS 挂载参数中追加 `-o VolumePrefix=`，覆盖 JuiceFS 1.3.0
默认设置的网络前缀。WinFsp 因而注册本地固定磁盘；JuiceFS 引擎、元数据、
后端地址、缓存设置和当前用户权限映射保持原有逻辑。

## 验证结果

- 现有单元测试：63/63 通过。
- 生产 Manager + 实际 WinFsp 驱动 + 独立本地后端：通过。
  依次开启、关闭、重新开启后台上传，并进行最后一次冷缓存回读，共四次挂载。
  每次均断言 `DriveType=Fixed`、`DriveFormat=JuiceFS`、`IsReady=true`。
- 5 MiB + 137 字节随机数据写入、追加、跨挂载哈希校验、当前用户读写、
  重命名与删除通过。每轮上传完成后安全卸载，再移开测试卷的干净缓存；
  原有测试数据保留，最终测试盘符已释放。
- 本地安装包内容与工作区源码比对通过。
- 旧程序通过界面安全退出；新版启动后原有 X:、Y:、Z: 自动恢复挂载。
  实际百度 JuiceFS 卷 Y: 的 Windows `DriveType` 从 4 变为 3，
  `ProviderName` 为空，`FileSystem=JuiceFS`。此次对用户卷只检查挂载状态，
  没有在用户卷上执行写入或删除测试。
- 原有“登录 Windows 后启动”保持开启，已通过应用设置将启动入口更新到新版，
  并核对 Windows 注册的可执行文件路径。

## 复现与证据

可随仓库查看的[结构化结果](JUICEFS-LOCAL-DISK-RESULTS-2026-10-16.json)保存了测试摘要、
实际磁盘类型、相关源码、引擎及原始证据的 SHA-256。

```powershell
node --test tests/*.test.cjs
node scripts/windows-cache-settings-integration.cjs
```

原始证据保存在本机忽略目录：

- `test-results/local-disk-unit-host.log`
- `test-results/local-disk-integration.log`
- `test-results/cache-settings-C8gs4b/report.json`
- `test-results/local-disk-package-host.log`
- `test-results/local-disk-live-volumes.json`

本地预览包：`dist/juicefs-local-disk-20261016/CloudIsland-win32-x64`。
该包包含已有本地 OAuth 应用配置，仅用于本机预览。

本次是挂载类型变更的定向回归。此前完整语义矩阵使用原来的网络磁盘注册方式，
仍作为历史基准；本次没有重跑全部 WinFsp/JuiceFS 上游语义用例，
也不改变此前已确认的失败、超时或待测结论。
