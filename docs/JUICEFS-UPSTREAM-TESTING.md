# JuiceFS 官方 Windows 文件系统测试

本测试使用云屿实际的 Manager → JuiceFS → rclone S3 → 存储后端通路，
创建全新的卷和测试目录。不会操作已有磁盘或已有网盘文件。

## 固定版本和范围

与随应用分发的 JuiceFS `1.3.0+2025-07-03.30190ca` 保持一致，
上游提交为 `30190ca1094d26e85f19a979ca51b0ea19af1eaa`。
下载地址和 SHA256 固定在 `scripts/juicefs-upstream-tests.json`。

| 测试 | 来源 | 执行内容 |
| --- | --- | --- |
| WindowsFSTest | [官方 Python 用例](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/.github/scripts/wins_fs_test.py) | 创建、读取、重命名、删除、目录、并发、中文文件名、10 MiB 文件、只读属性、深层目录；保留官方的符号链接跳过 |
| winfstest | [官方 Windows CI](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/.github/workflows/wintest.yml) 引用的 `testing_20250313` | 11 个脚本、152 个已启用断言；保留上游已注释的内容 |
| WinFsp conformance | 同一 CI 引用的 `testing_suit_20250324` | 使用 `--fuse-external --resilient --case-insensitive-cmp` 的默认清单，共 54 项；每项独立进程和目录，失败继续记录后续项 |
| FSX | 同一 CI 引用的 `fsx-x64.exe` | 固定随机种子 `20261014`；随机读写、截断、文件扩展、映射读写及数据校验 |
| fsck + 冷读 | JuiceFS 引擎 + 云屿集成校验 | 安全刷新卸载、保留并移走测试卷缓存、重建 Manager、重新挂载；校验 FSX 最终文件及跨块随机文件 SHA256，再运行只读 fsck |

Python 源文件保持原始字节和哈希，仅通过外部运行器替换 `setUp` 中写死的
`Z:\test_fs` 测试位置，避免碰到现有 Z 盘。断言和跳过规则均未改动。

同步模式的 FSX 默认采用上游的 `-d 180 -p 10000 -F 100000`，固定随机种子
`20261014`。上游此项 CI 没有启用后台写入；额外的后台写入变体默认采用
`-N 200`，作为有限次数的补充验证，避免生成需数小时上传的小对象队列。
可用 `ONEMOUNT_FSX_OPS` 显式设置操作次数作专项诊断。早期记录曾采用本地
`-N 10000`、网盘 `-N 200`；这些历史结果不会被改写成 180 秒测试结果。
实际报告的操作数可能包含额外的扩展操作。这是功能校验，不是长期压力测试，
也不是传输速度测试。

本流程针对 Windows/WinFsp。不代表 Linux 的 pjdfstest、LTP、完整 POSIX
兼容性或 WinFsp 全部可选用例已通过。报告保留失败、超时、跳过，
任何失败都会让整轮返回非零状态。
如果 FSX 超时或未输出完成标志，将停止本轮并请求安全退出，不对被中断的
工作负载继续写入或建立“最终文件”快照。中断结果不会被算作通过。

云屿对 JuiceFS 1.3.0 的 Windows 挂载设置 `--attr-cache 0`。原版引擎在
新文件写入并关闭后，可能暂时返回写入前的文件大小，导致立即启动程序时
报“不是有效的 Win32 应用程序”。此参数禁用属性缓存；文件内容的内存和磁盘
缓存仍正常使用。元数据位于本机 SQLite，因此这一调整不增加网盘元数据请求。
网盘模式还设置 `--get-timeout 5m`：4 MiB 数据块在 40 KiB/s 的下载速度下需要
约 100 秒，默认 60 秒会让仍在传输的数据块反复从头读取。该调整延长单块读取
期限，仍保留失败和重试机制；不会更改官方用例的内容校验或错误断言。

## 运行

需要 Windows、已安装的 WinFsp、项目的 Electron/引擎以及 Python 3。
在仓库根目录运行：

```powershell
# Proxy 可省略。所有工具先验证哈希，再解压到新目录。
./scripts/fetch-juicefs-tests.ps1 -Proxy http://127.0.0.1:7892

$env:ONEMOUNT_TEST_PYTHON = 'C:\path\to\python.exe'
$env:ONEMOUNT_UPSTREAM_TYPES = 'local'
$env:ONEMOUNT_LIVE_WRITEBACK = '0,1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$logPrefix = Join-Path $PWD ('test-results/upstream-' + [guid]::NewGuid().ToString('N'))
$run = Start-Process ./node_modules/electron/dist/electron.exe `
  -ArgumentList 'scripts/windows-juicefs-upstream-integration.cjs' `
  -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput ($logPrefix + '.out.log') `
  -RedirectStandardError ($logPrefix + '.err.log')
if ($run.ExitCode -ne 0) { throw '官方测试未全部通过，请查看 report.json 和日志' }
```

真实网盘测试需要现有已登录的云屿账户：

```powershell
$env:ONEMOUNT_LIVE_PROFILE = Join-Path $env:APPDATA 'CloudIsland'
$env:ONEMOUNT_UPSTREAM_TYPES = 'baidu,onedrive,drive'
# 再执行上面的 Start-Process 运行段，为本轮生成新的日志前缀。
```

可用 `ONEMOUNT_FSX_OPS` 显式覆盖 FSX 操作次数。增加次数会显著增加真实网盘
的小对象上传量和测试时间。

并行运行多个测试进程时，分别设置不同的 `ONEMOUNT_TEST_LETTER`（例如 `Q` 和
`R`），避免两个进程在挂载准备期间同时选中同一个尚未出现的盘符。
后台写入测试会先等待上传队列清空，再请求应用安全卸载。
Electron 是 Windows GUI 程序；使用上述输出重定向方式，避免启动终端关闭后
输出管道失效，导致测试进程被错误对话框阻塞。

结果位于 `test-results/juicefs-upstream-run-*/report.json`，包含逐项状态和日志名。
可设置 `ONEMOUNT_UPSTREAM_DEBUG=1` 记录网关 DEBUG 日志；日志仍只保存在私有
测试目录。报告记录协调进程和用例进程 PID，便于核对超时进程归属。
原始日志、复制的加密账户配置、卷元数据和缓存仅保留在被 Git 忽略的
`test-results` 中。测试使用各自 UUID 的 `.cloud-island/<UUID>` 远端目录；
不会自动删除远端数据，便于复核。安全卸载失败时保留会话和缓存，不能强杀
JuiceFS 或网关来制造“测试完成”。

## 已知测试工具限制

`winfstest` 的 `09.t` 在启动一个持有文件句柄的子进程后，直接启动第二个
子进程，没有等待第一个完成文件创建。因此可偶发返回 `ERROR_FILE_NOT_FOUND`，
而非期待的 `ERROR_SHARING_VIOLATION`。2026-10-14 在 NTFS 的 50 次原样复跑中
也出现一次同样的失败。保留首次失败，不通过修改断言、自动重试或忽略它来报绿。
