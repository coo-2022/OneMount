# Windows WinFsp 外部兼容性实测 — 2026-10-10

[完整 Windows CI 运行](https://github.com/coo-2022/OneMount/actions/runs/38048124469) · 被测提交 `63151da049f846e65fb361d1f314df65c2d468a7`。

使用产品正常构建的 rclone v1.75.0-onemount、JuiceFS 1.3.0、WinFsp 2.1.25156；Windows x64，系统 build 10.0.26100，本地临时目录后端。测试由 GitHub Windows runner 实际执行，不是 Linux 模拟或静态检查。

## 结果

每组 117 个执行单元：94 个官方 WinFsp 外部注册用例（含可选项）、20 个原版 winfstest 脚本、3 个 FSX 配置。四组共 468 次；未使用 known-failure 排除列表。

| 配置 | 通过 | 失败 | 超时 | 未执行 |
|---|---:|---:|---:|---:|
| NTFS 对照 | 114 | 3 | 0 | 0 |
| rclone 直连 | 62 | 54 | 1 | 0 |
| JuiceFS 默认上传 | 72 | 44 | 1 | 0 |
| JuiceFS 后台上传 | 72 | 44 | 1 | 0 |

统计单位是用例/脚本，不是内部断言数量。用例遇到断言失败或脚本异常可能提前退出；后续独立用例继续执行。`notRun=0` 表示所有入口均已执行，并不表示每个内部断言、代码分支都执行完毕。

| 配置 | WinFsp：通过/失败/超时 | winfstest：通过/失败/超时 | FSX：通过/失败/超时 |
|---|---|---|---|
| NTFS 对照 | 92/2/0 | 19/1/0 | 3/0/0 |
| rclone 直连 | 56/37/1 | 4/16/0 | 2/1/0 |
| JuiceFS 默认上传 | 62/31/1 | 8/12/0 | 2/1/0 |
| JuiceFS 后台上传 | 62/31/1 | 8/12/0 | 2/1/0 |

## 对产品有实际影响的发现

- 三种挂载配置的普通 FSX 与混合缓存/非缓存 FSX 均通过，各 5,000 次操作，种子 20261010，包含默认 mmap 检查；命名流 FSX 均失败。有限随机测试不能证明任意工作负载下无损坏。
- 三种挂载配置的 `stream_dirnotify_test` 均达到 90 秒上限，记录 timeout。命名流创建、读取和权限相关用例普遍失败，不应承诺完整 ADS 支持。
- 直连模式的 `exec_test`、`exec_delete_test`、`exec_rename_test`、`exec_rename_dir_test` 均在启动测试程序时返回拒绝访问。当前默认配置不宜宣称适用于应用安装/运行盘；JuiceFS 两组通过这四项。
- 两类挂载都有属性、分配大小、Windows 安全描述符和扩展属性/重解析点方面的兼容性差异。不能将它们视为完整 NTFS 替代品，也不能仅凭这些结果归因于 WinFsp 驱动。
- JuiceFS 两组的长 Unicode 文件名创建/枚举测试失败（错误 206），设置创建时间的断言失败；只读目录行为也与 Windows 测试预期不同。
- 两种 JuiceFS 上传策略的 117 项状态完全一致。本次测试中，开关后台上传没有改变这些 Windows 元数据兼容性结果。

## NTFS 对照失败的解释

保留对照组失败，不修改官方预期，也不按名称自动豁免挂载组：

| 用例 | NTFS 观察到的差异 |
|---|---|
| `create_test` | `create-test.c:183`：尾随反斜杠创建文件时预期 `ERROR_INVALID_NAME`，实际错误 267。直连在同名用例更早的断言失败，不能等同。 |
| `getfileinfo_name_test` | `info-test.c:372`：规范化路径与原始路径比较不相等。runner 临时路径含 `RUNNER~1` 短名；短名规范化是可能原因，未另行证实。JuiceFS 在更早的第 355 行失败。 |
| `winfstest-base/08.t` | 17 个断言中 3 个失败，涉及仍有句柄打开时删除文件后的错误码和目录可见性；实际返回 `ERROR_FILE_NOT_FOUND`，旧测试预期 `ERROR_ACCESS_DENIED`。 |

## 证据与复现

- [逐项机器可读结果](WINFSP-RESULTS-2026-10-10.json)保存全部入口的状态、耗时、断言摘要及失败日志节选。CI 的 `winfsp-conformance-*` 附件保留所有原始日志与引擎日志，30 天有效。
- [测试范围与运行说明](WINFSP-CONFORMANCE.md)：在 GitHub Actions 手动运行 **WinFsp full external conformance**。
- 前两轮只用于修复测试环境依赖和输出解析；本报告仅使用上面链接的最终完整运行，不混入启动失败或误判数据。
- 独立 CI 会因真实失败/超时保持红色；“所有用例已执行”不表示“全部通过”。

## 未覆盖

仅覆盖 Windows x64、本地后端、管理员 runner 和有限随机序列。没有验证真实网盘、断电/断网恢复、并发多客户端、其他 Windows 版本或全部普通用户权限组合。官方内部 MEMFS/驱动测试、内核故障注入、Driver Verifier 和微软 HLK 认证不在本次范围；与外部注册表的 41 项差集保存在 JSON 的 `internalOnly`。
