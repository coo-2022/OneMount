# JuiceFS 官方文件系统测试记录（2026-10-14）

后续修复与复测见 [2026-10-15 记录](JUICEFS-UPSTREAM-VALIDATION-2026-10-15.md)；本页保留原始失败结论。

**结论：未全部通过，不能把 JuiceFS 网盘模式标记为完整验收通过。**

产品基线：分支 `feat/juicefs`，提交 `e920ead`；Windows x64，WinFsp
`2.1.25156`，官方 JuiceFS `1.3.0+2025-07-03.30190ca`。
本次新增测试脚本和报告，未更改产品逻辑或引擎。

使用 [JuiceFS 官方 Windows Python 用例](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/.github/scripts/wins_fs_test.py)，
以及[该版本 Windows CI](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/.github/workflows/wintest.yml)
指定的 winfstest、WinFsp 和 FSX。原始断言未修改；Python 仅由外部运行器调整测试目录。

## 结果

同步表示关闭后台写入，后台表示启用 writeback。“基础 8+1”表示 8 项通过、1 项按上游规则跳过。

| 后端 | 写入模式 | Python 基础 | winfstest 断言 | WinFsp 用例 | FSX | 冷缓存哈希 / fsck |
| --- | --- | --- | --- | --- | --- | --- |
| 本地对照 | 同步 | 8+1 | 151/152 | 50/54 | 10,822 操作通过 | 均通过 |
| 本地对照 | 后台 | 8+1 | 152/152 | 50/54 | 10,822 操作通过 | 均通过 |
| 百度 | 同步 | 8+1 | 152/152 | 54/54 | 221 操作通过 | 均通过 |
| 百度 | 后台 | 8+1 | 152/152 | 50/54 | 221 操作通过 | 补充校验均通过¹ |
| OneDrive | 同步 | 大文件读取错误，整组超时 | 152/152 | 21 通过，1 阻塞，32 未运行 | 未运行 | 未运行 |
| OneDrive | 后台 | 未运行 | 未运行 | 未运行 | 未运行 | 未运行 |
| Google Drive | 同步 | 8+1 | 148/152 | 54/54 | 221 操作通过 | 均通过 |
| Google Drive | 后台 | 8+1 | 152/152 | 50/54 | 221 操作通过 | 均通过 |

FSX 固定种子为 20261014，本地设定 `-N 10000`，网盘设定 `-N 200`，
文件长度上限 100,000 字节。表中为工具实际报告的操作数，含额外扩展操作。
另用 4 MiB + 137 字节随机文件验证跨块保存与冷读。

¹ 百度后台组产生大量小对象，首次安全卸载超过应用 120 秒限时，随后正常退出完成。
保留原始失败报告，在同一卷重新读取暖缓存文件，卸载并保留旧缓存，以空缓存
重新挂载，比较 SHA256 并执行 fsck，均通过。补充校验没有覆盖首次卸载超时记录。

## 发现的问题

### OneDrive 持续 I/O 超时

10 MiB 文件读取出现 `GetObject ... timeout awaiting response headers`，
多次达到 JuiceFS 的 30 秒响应头等待限时，随后也出现 PutObject 超时。
基础组达到 10 分钟限时，进程退出仍受挂起 I/O 影响。后续
`rename_standby_test` 阻塞超过 6 分钟，未在该用例 90 秒限时内退出。

因此中止此隔离测试卷，余下 32 项原生用例、FSX、冷读、fsck 和后台模式未完成。
清理前核对测试 UUID、引擎命令行和父进程关系，仅停止这个测试的协调进程、网关、
挂载及账户辅助服务。保留日志、缓存和元数据；中止不代表数据已安全刷新。
本轮没有定位 OneDrive 超时的最终根因。

### 程序执行相关的 4 项失败

本地两种模式，以及百度、Google 的后台模式，均有以下失败：

- `exec_test`
- `exec_delete_test`
- `exec_rename_test`
- `exec_rename_dir_test`

失败位于 `exec-test.c:135:ExecHelper` 的辅助程序启动检查。
百度、Google 同步模式下四项均通过。直接运行原版 JuiceFS，使用本地文件存储，
分别启用和关闭 `--as-root`，两轮对照均复现这四项失败；NTFS 单独的
`exec_test` 通过。

目前不能归因于某个网盘适配器，也不能排除辅助进程启动时序影响。
保留失败，没有放宽官方断言来取得通过结果。

### 共享打开用例存在时序干扰

本地同步组的 `09.t` 失败 1 个断言，Google 同步组失败 4 个断言。
该用例启动持有文件句柄的子进程后，没有等待其就绪便启动另一个子进程。

NTFS 原样重复 50 次，其中 1 次也在首个共享打开断言得到
`ERROR_FILE_NOT_FOUND`，而非期望的 `ERROR_SHARING_VIOLATION`。
Google 的四项表现为共享句柄建立顺序相反，与该竞争相符，但未单独消除竞争后
复跑确认，因此仍计失败，不能直接宣称它们全部是测试工具误报。

另一次 NTFS 整套尝试在 `create_test` 因错误码差异中止（期望
`ERROR_INVALID_NAME`，实际 `ERROR_DIRECTORY`）；没有把 NTFS 整套作为已通过基准。

## 复现和证据

- [复跑步骤和范围](JUICEFS-UPSTREAM-TESTING.md)
- [结构化结果](JUICEFS-UPSTREAM-RESULTS-2026-10-14.json)
- 本地、百度：`test-results/juicefs-upstream-run-HnBXp9/report.json`
- 百度补充校验：同目录 `resume-baidu-writeback.json`
- OneDrive 部分结果：`test-results/juicefs-upstream-run-y4Vrpl/report.json`
- OneDrive 中止清理：同目录 `abort-report.json`
- Google：`test-results/juicefs-upstream-run-XLCGqz/report.json`

Google 首次准备尝试因两个并行脚本竞争 Q 盘而停止，没有执行功能用例。
固定独立 R 盘后完成的结果列于上表。脚本已支持显式盘符、后台上传排空等待，
以及超时后仍不能退出时停止后续用例的保护。

测试卷和辅助服务均已停止；测试数据保留在独立 UUID 目录。
没有修改用户已有挂载或删除已有云端文件。原始配置和日志位于 Git 忽略的
`test-results`，结构化报告不含账户密钥。没有运行 Linux pjdfstest/LTP，
也没有宣称完整 POSIX 兼容性或长期压力测试通过。
