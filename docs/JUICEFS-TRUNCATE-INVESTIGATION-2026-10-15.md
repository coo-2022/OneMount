# JuiceFS 截断后文件变长：根因分析（2026-10-15）

**结论：已确认当前 JuiceFS 1.3.0 引擎存在刷新失败后仍执行截断的一致性缺陷，尚未修复。**
原 OneDrive FSX 哈希差异已逐字节还原；独立本地故障注入在不终止任何测试进程的情况下复现。
正常完成的八组功能测试仍有效，但不能据此认定异常上传场景通过。

## 原始失败的证据

保留目录：`test-results/juicefs-upstream-run-folzy6`。
卷 `7e401695-154c-42d8-a014-b6e3c0c3abd8`，文件 `fsxtest`，inode 771。

| 状态 | 文件大小 | SHA256 |
| --- | ---: | --- |
| 从原始缓存重建的暖读内容 | 25,248 | `cefe5d986341da7b84bdf5afbbd5844dc3ca41ec44e70fe1bf7ebff3cdf56c24` |
| 从最终元数据和缓存重建的冷读内容 | 98,304 | `1e494cef93b0b179e78b755ff6c9611291032625471849baac068614b628ac84` |

两个值与原始失败断言完全一致。最终文件前 25,248 字节保留，之后
`[25248,49152)` 为零，`[49152,98304)` 被之前的写入覆盖。
涉及的 `285_0_100000`、`286_0_49152` 两个块，在原暖缓存与冷读下载缓存中
逐字节相同，包括缓存校验尾部。这次差异发生在文件长度和片段提交顺序，而非这两个对象的传输内容。

SQLite 中保留的片段顺序：

1. 块 285：文件偏移 0，长度 100,000。
2. 零片段：文件偏移 25,248，长度 74,752，来自缩短文件。
3. 块 286：文件偏移 49,152，长度 49,152，在缩短之后提交，又把文件长度扩展到 98,304。

用官方 FSX 二进制、相同种子 `20261014` 在独立 NTFS 目录回放，确认操作 206
是映射写入 `[52828,96752)`，操作 207 是截断到 25,248。块 286 的对应范围
恰好全部包含操作编号 206 的数据。原始日志的五分钟刷新超时栈也直接位于
`VFS.Truncate(..., 0x62a0, ...)`，`0x62a0` 即 25,248。

原测试确实曾被测试运行器终止，但这一事实不足以解释或豁免一致性错误。

## 无强制终止的独立复现

原版 JuiceFS 二进制 SHA256：
`ad1c2096241b3430908d7d3e6eae1671fd58e6946b3320ab8a6bf566ca58f31c`。

复现使用独立 SQLite、独立缓存、空闲 Q: 盘符，以及仅绑定回环地址的
HTTP 故障代理和 rclone 本地 S3 后端。没有连接 OneDrive，也没有修改现有用户卷。

步骤：

1. 创建并同步一个 100,000 字节文件。
2. 映射写入 `[52828,96752)`，调用 `FlushViewOfFile`，解除映射。
3. 故障代理暂扣新数据块 PUT，使客户端持续重试；保留 JuiceFS 原始五分钟刷新期限。
4. 请求截断到 25,248 字节，记录系统调用返回值及 SQLite 元数据。
5. 恢复 PUT，执行文件同步、关闭、正常卸载，并更换为空缓存后重新挂载检查。

| 条件 | 截断调用 | 截断返回时大小 | 同步关闭后 | 冷缓存重挂载后 |
| --- | --- | ---: | ---: | ---: |
| 上传阻塞 | 300.812 秒后返回成功 | 25,248 | **98,304** | **98,304** |
| 无故障对照 | 0.016 秒后返回成功 | 25,248 | 25,248 | 25,248 |

故障组测试进程正常退出，退出码 0；过程中没有杀进程。它的业务结果是**复现缺陷**，
不能将退出码 0 或暖冷哈希相同理解为文件系统通过测试：两次读取的是同一个错误长度的文件。

证据目录：

- 故障组：`test-results/juicefs-truncate-fault-1zMiy6`。
- 无故障组：`test-results/juicefs-truncate-fault-44vSzl`。
- 原始失败离线重建：`test-results/juicefs-fsx-forensics-byh751xz`。
- 官方种子回放：`test-results/fsx-seed-replay-iCqFqz`。

诊断脚本随仓库保存在 [`scripts/juicefs-truncate-fault.cjs`](../scripts/juicefs-truncate-fault.cjs)、
[`juicefs-truncate-worker.py`](../scripts/juicefs-truncate-worker.py) 和
[`reconstruct-fsx-failure.py`](../scripts/reconstruct-fsx-failure.py)，原始输出仍位于忽略目录 `test-results/`。
故障组需要 Node.js 24、本地引擎与 WinFsp，在独立进程中启动前设置 `ONEMOUNT_TEST_PYTHON`；
无故障组另外设置 `ONEMOUNT_FAULT=off`。脚本只用于诊断，不属于官方测试套件。

不含账户信息的[结构化证据](JUICEFS-TRUNCATE-RESULTS-2026-10-15.json)随本报告保存。

## 源码中的原因与修复边界

固定版本源码：

- [`pkg/vfs/vfs.go` 的 Truncate](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/pkg/vfs/vfs.go#L588)：
  截断前调用 `_ = v.writer.Flush(ctx, ino)`，丢弃刷新错误，继续修改元数据。
- [`pkg/vfs/writer.go`](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/pkg/vfs/writer.go#L353)：
  等待超时会返回 EIO，但尚未完成的上传和片段提交仍可继续。
- [`pkg/meta/sql.go`](https://github.com/juicedata/juicefs/blob/30190ca1094d26e85f19a979ca51b0ea19af1eaa/pkg/meta/sql.go#L2697)：
  后到的片段提交会按片段末尾更新文件长度，因此撤销了已返回成功的截短效果。
- [官方 FSX Windows 映射实现](https://github.com/chenjie4255/fstools/blob/v0.0.1/src/fsx/win/mman.c#L159)：
  映射刷新调用 `FlushViewOfFile`；文件同步和映射刷新属于不同步骤。

建议最小修复：在 `VFS.Truncate` 中检查并返回 `writer.Flush` 的错误，刷新失败时
不执行元数据截断、不更新读写端长度。上传恢复后，由调用方重试截断。
修复验收必须检查“成功截断的长度不会被旧写入恢复”，同时覆盖失败返回、恢复重试和冷读。

该修复属于 JuiceFS 引擎，不应限制在 OneDrive 适配器。增加超时可以降低触发概率，
但无法保证慢请求最终不超时；测试运行器在 FSX 未完成时停止后续步骤也只是避免误判，
没有修复引擎。此次诊断仅完成归因和对照验证，未替换或修复引擎。

所有本轮诊断挂载和后台服务已安全停止，原始失败证据继续保留。
