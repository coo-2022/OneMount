# WinFsp 全量外部文件系统兼容性测试

此工作流测试 OneMount 挂载后的文件系统行为，不是重新认证 WinFsp 内核驱动。

## 固定工具和范围

- WinFsp 驱动及官方 `winfsp-tests-x64.exe`：2.1.25156；下载均校验固定 SHA-256。
- 官方 WinFsp v2.1 引用的 secfs.test 提交：`6ac65cda46abc2be39c7b137debf9521052edbaf`。
- `winfstest` 和 FSX 从该提交的原始 C 源码用 MSVC 编译。旧版 winfstest 原样使用其要求的 Python 2.7.18，仅存在于一次性 CI 测试工具中，不随产品分发。
- 产品引擎由本仓库正常构建脚本生成，不改挂载选项来迎合测试。

当前 CI 只运行 **rclone 网盘直连**，使用 Windows x64、本地临时后端和独立测试数据。历史的 NTFS/两种 JuiceFS 对照结果保留在实测报告中；底层脚本仍保留这些诊断模式，但当前工作流不调用。

1. 从 `winfsp-tests --external --resilient --list +*` 动态获取全部外部用例，包括可选/长时间用例。逐例 `+名称` 执行，不使用 FUSE 排除列表、大小写比较放宽或 known-failure 跳过。
2. 运行 secfs.test 中全部 `.t` 脚本，解析 TAP 计划数、通过数、失败数，不能仅依赖进程退出码。
3. FSX 普通读写/mmap、缓存与非缓存混合、命名流三种配置，各运行 5,000 次操作，固定随机种子 20261010。有限随机序列不是穷举所有 IO 序列。

每例独立进程、独立临时目录。断言失败后继续下一例；普通用例 90 秒、压力/FSX 300 秒，超时会记录为 timeout 而不是通过。测试进程树可以被终止；测试引擎仍按产品方式安全卸载。若挂载失效或卸载失败，整体记录 incomplete 和未运行列表。

`report.json` 保存目录、命令、结果、耗时、断言及未运行清单。每条用例保留原始日志，失败也上传；结果有失败时工作流为红色，不能以“跑完”表述为“全部通过”。

## 运行与证据

已完成实测：[2026-10-10 结果报告](WINFSP-RESULTS-2026-10-10.md)，含四组结果、NTFS 基线差异和逐项证据。

在 GitHub Actions 选择 **Rclone direct WinFsp conformance → Run workflow**。相关源码、引擎/自定义后端、脚本、测试和依赖变更在 main push 或 PR 时自动触发；并发运行按分支保留最新一次。它与常规软件发布验收分开运行，完整测试结果保存在 `winfsp-conformance-*` 附件中（30 天）。不要在真实用户挂载盘运行这类破坏性测试。

## 不包含的范围

- WinFsp 内部模式下的 MEMFS、驱动故障注入、驱动加载卸载测试；这些用例不以 OneMount 为被测文件系统。与外部清单的差集记录在 `internalOnly` 中。
- 微软 IFS/HLK 认证、Driver Verifier、内核池泄漏验证、x86/ARM64、SMB 分享和其他操作系统版本矩阵。
- 真实网盘、断电恢复及无限时长压力；fsbench 性能基准不属于本次兼容性通过判定。

某些 Windows 特性（ACL、ADS、reparse points 等）可能是底层引擎未实现的能力，必须保留失败并解释影响；不能直接归因于 WinFsp 驱动缺陷。

参考：[WinFsp Testing](https://winfsp.dev/doc/WinFsp-Testing/)、[官方 2.1 测试发行包](https://github.com/winfsp/winfsp/releases/tag/v2.1)。

直连失败的逐项归因见 [rclone 直连分析](RCLONE-DIRECT-FAILURE-ANALYSIS.md)。CI 严格保留失败/超时状态，并在 Actions Summary 展示计数与断言；未配置分支保护策略。

最新修复验证：[执行权限与重复建目录](RCLONE-DIRECT-FIXES-2026-10-10.md)，直连结果为 68 通过、48 失败、1 超时。
