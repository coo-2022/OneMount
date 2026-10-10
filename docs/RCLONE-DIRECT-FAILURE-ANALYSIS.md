# rclone 直连：WinFsp 失败归因与 CI

后续更新：执行权限与重复建目录已完成修复，六项由失败变为通过，见 [修复及 Windows 验证](RCLONE-DIRECT-FIXES-2026-10-10.md)。本文保留修复前的归因基线。

本阶段只分析 rclone 直连。证据来自 [2026-10-10 Windows 全量运行](https://github.com/coo-2022/OneMount/actions/runs/38048124469)：117 个入口，62 通过、54 失败、1 超时。被测版本为 rclone v1.75.0-onemount / WinFsp 2.1.25156，使用本地后端、产品默认挂载参数。

54 个失败不等于 54 个独立缺陷。大量断言来自同一个功能缺口，而且这套测试按完整 Windows 文件系统语义检查，没有使用 FUSE 排除列表。即使后端是 NTFS，本次 IO 仍经过 rclone VFS 和 WinFsp FUSE 适配，不会自动透传 NTFS 全部能力。

## 全部 55 个非通过入口的归类

每个入口只计入一个主因类别；修复首个断言后仍可能暴露后续问题，不能以本表预测最终通过数量。

| 主因类别 | 失败 | 超时 | 原因与证据 | 处理方向 |
|---|---:|---:|---|---|
| ADS 命名流 | 19 | 1 | WinFsp 2.1 的 FUSE 层明确设置 `NamedStreams = FALSE`；创建 `file:stream` 返回非法名称 | 需要补充流模型及前端接口，不是新增网盘 backend 即可解决 |
| 重解析点与符号链接 | 8 | 0 | 默认 `Links=false`，VFS 创建符号链接返回 ENOSYS；任意 GUID/NFS 重解析点也没有等价后端表示 | 链接开关只能解决其中一部分；通用重解析点需额外实现 |
| DOS 文件属性及其衍生行为 | 7 | 0 | cmount 未实现 `Chflags`；`stat` 不填属性 flags；只读、隐藏、归档等无法按 NTFS 方式保存 | 补属性存储/映射，连带校正只读文件覆盖与删除 |
| Windows ACL 与权限变更 | 7 | 0 | 文件/目录使用全局权限；`Chmod`、`Chown` 是返回成功的空操作，不能保存任意 DACL | 需要单独的权限模型，不能通过统一调大权限解决 |
| EA 扩展属性 | 3 | 0 | cmount 的 Setxattr/Getxattr/Listxattr/Removexattr 均返回 ENOSYS | 需要后端或附属元数据的持久化支持 |
| 执行程序权限 | 4 | 0 | 默认文件权限 0666 没有执行位，启动程序返回拒绝访问；官方文档明确说明该行为 | 产品是否允许执行应明确决定；可用 `FilePerms: 0o777` 做后续对照验证 |
| 重复创建目录 | 2 | 0 | `VFS.Dir.Mkdir` 在目录已存在时返回该目录和 nil；cmount 原样转换为成功 | 属于可修复的适配语义问题，应在 cmount/专用创建接口保证 EEXIST，避免破坏内部幂等调用 |
| 预分配大小 | 1 | 0 | WinFsp FUSE 的 AllocationSize 由文件大小取整生成；代码明确说明 FUSE 2.8 不支持独立 allocation size | 需要接口/元数据能力，不能等同于普通文件内容读写损坏 |
| 创建时间与访问时间 | 1 | 0 | cmount `stat` 将各时间统一为 ModTime；`Utimens` 只写 tmsp[1] 修改时间 | 独立时间字段需要持久化和接入；修改时间本身不属于这个失败结论 |
| 删除后可见性基线差异 | 1 | 0 | `base/08.t` 在 NTFS 对照同样出现 3 个相同断言失败 | 保留失败，区分旧测试预期与当前 Windows 删除语义，不直接算 rclone 独有缺陷 |
| WSL stat 查询兼容性 | 1 | 0 | 测试未接受查询返回状态。WinFsp 的非 WslFeatures 分支返回 INVALID_PARAMETER，而测试只接受 INVALID_INFO_CLASS / NOT_IMPLEMENTED | 源码支持这一原因推断；原日志未打印 Result，仍需定点采集 NTSTATUS 确认 |
| 合计 | 54 | 1 | 所有非通过入口均覆盖 | 不自动豁免任何项 |

## 几个容易误判的地方

**程序无法启动首先是配置问题。** 修复前 `src/plans.cjs` 的 `directMountBody` 未指定 `FilePerms`，rclone 默认 0666。官方 Windows 权限文档说明这会禁止从挂载盘启动程序。设置执行位是候选调整，本次没有修改产品权限，也没有声称这四项修复后已通过；全局 0777 同时增加了 owner/group/others 的执行权限，应按产品权限策略选择。

**重复 mkdir 是具体的语义缺陷。** `create_test` 在第 125 行要求第二次 CreateDirectory 失败，实际成功；`winfstest-base/02.t` 第 6 个断言重复验证了这一点。它与 NTFS 对照 `create_test` 在第 183 行的尾随反斜杠错误码问题不是一回事。

**重命名失败有连锁关系。** `winfstest-base/04.t` 首先在断言 10 发现只读目标文件居然能被覆盖；断言 12 随后报源文件不存在，是前一步已经错误地完成移动后的连锁结果。不能将后者另算一个普通重命名丢文件问题。

**ADS 超时不能直接说成驱动死锁。** `stream_dirnotify_test` 的子线程尝试创建命名流，创建失败后直接退出；主线程同步等待 STREAM_NAME 通知。结合 ADS 不支持以及主线程等待路径，90 秒超时很可能是测试等待永远不会发生的通知。尚无线程栈证据证明驱动死锁，CI 保留 timeout。

**权限失败不会由 VFS 缓存模式修好。** `Chmod`/`Chown` 的空实现、统一权限和有限的 POSIX→ACL 映射，解释了 setsecurity、no-traverse、backup/restore、delete-access 等不同断言。0666→0777 只能增加执行权限，不能实现任意 Windows ACL。

## 固定版本的源码依据

- [OneMount 实际挂载参数](../src/plans.cjs)：`directMountBody`，cmount、VFS full、写回延迟 5 秒。
- [rclone v1.75.0 cmount/fs.go](https://github.com/rclone/rclone/blob/v1.75.0/cmd/cmount/fs.go)：`stat`、`CreateEx`、`Mkdir`、`Utimens`、`Chmod`、`Chown`、`Mknod`、xattr 系列，以及末尾未实现的 `FileSystemChflags` / `FileSystemSetcrtime` 接口。
- [VFS 默认参数](https://github.com/rclone/rclone/blob/v1.75.0/vfs/vfscommon/options.go)：`file_perms=0666`、`vfs_links=false`。
- [VFS 目录创建](https://github.com/rclone/rclone/blob/v1.75.0/vfs/dir.go)：`Dir.Mkdir` 的已有目录分支。
- [VFS 链接](https://github.com/rclone/rclone/blob/v1.75.0/vfs/vfs.go)：`CreateSymlink`。
- [WinFsp 2.1 FUSE 初始化](https://github.com/winfsp/winfsp/blob/v2.1/src/dll/fuse/fuse.c)：`VolumeParams.NamedStreams = FALSE`。
- [WinFsp 2.1 FUSE 实现](https://github.com/winfsp/winfsp/blob/v2.1/src/dll/fuse/fuse_intf.c)：属性映射与 `SetFileSize` 中 allocation size 处理。
- [WinFsp 2.1 stat 查询](https://github.com/winfsp/winfsp/blob/v2.1/src/sys/fileinfo.c)：68 / 70 两个信息类和 WslFeatures 分支。
- [官方命名流通知测试](https://github.com/winfsp/winfsp/blob/v2.1/tst/winfsp-tests/stream-tests.c)：`stream_dirnotify_dotest_thread` / `stream_dirnotify_dotest`。
- [官方 Windows 权限说明](https://rclone.org/commands/rclone_mount/#windows-filesystem-permissions)。

## 后续处理次序

1. 先验证执行权限配置，并修正重复创建目录的错误码。这两项原因具体、修改范围相对小。
2. 再处理只读/隐藏等属性、独立时间字段和 ACL。必须决定元数据如何存储、重挂载后如何恢复，不能只在内存里让断言通过。
3. ADS、任意重解析点、EA 和预分配属于更大的能力扩展，先明确产品承诺范围。继续保留测试失败以显示缺口。
4. WSL 返回码与 ADS 通知等待做定点诊断；与 NTFS 一致的 base/08 差异保留对照证据。

当前工程从 Go module 构建 rclone，但只有 backend 扩展目录；上述 VFS/cmount 修改需要受控的 rclone 源码补丁或 fork，单纯添加网盘 backend 不会改变这些前端语义。本次只接入 CI 和分析原因，没有修改引擎行为。

## CI 行为

工作流 **Rclone direct WinFsp conformance** 对相关源码、引擎、自定义后端、脚本、测试和依赖变更自动触发（main push / PR），也可手动触发。只挂载并测试 direct，全部 117 个入口执行；运行摘要直接展示计数和失败断言，原始日志保留 30 天。

任何失败、超时、启动失败或未执行都会使检查失败。当前存在已知失败，所以检查仍会标红；没有新增 known-failure 豁免，也没有设置分支保护或合并必需检查。历史四组结果保留作对照，当前自动化不再执行其余三组。

## 逐项主因映射

以下列表由本次归类对实际失败清单校验生成，覆盖 54 失败 + 1 超时，无遗漏、无重复。

### 执行权限

`exec_test`, `exec_delete_test`, `exec_rename_test`, `exec_rename_dir_test`

### 重复创建目录

`create_test`, `winfstest-base/02.t`

### DOS 属性及衍生行为

`create_fileattr_test`, `create_readonlydir_test`, `setfileinfo_test`, `delete_ex_test`, `winfstest-base/01.t`, `winfstest-base/07.t`, `winfstest-base/04.t`

### Windows ACL

`create_notraverse_test`, `create_backup_test`, `create_restore_test`, `getfileattr_test`, `delete_access_test`, `setsecurity_test`, `winfstest-base/10.t`

### 预分配大小

`create_allocation_test`

### 时间字段

`winfstest-base/06.t`

### 重解析点与符号链接

`reparse_guid_test`, `reparse_nfs_test`, `reparse_symlink_test`, `reparse_symlink_relative_test`, `winfstest-reparse/00.t`, `winfstest-reparse/01.t`, `winfstest-reparse/02.t`, `winfstest-reparse/03.t`

### EA 扩展属性

`ea_create_test`, `ea_overwrite_test`, `ea_getset_test`

### ADS 命名流

`stream_create_test`, `stream_create_overwrite_test`, `stream_create_related_test`, `stream_create_sd_test`, `stream_create_share_test`, `stream_getfileinfo_test`, `stream_setfileinfo_test`, `stream_delete_test`, `stream_delete_pending_test`, `stream_rename_flipflop_test`, `stream_getsecurity_test`, `stream_setsecurity_test`, `stream_getstreaminfo_test`, `stream_dirnotify_test`, `winfstest-streams/00.t`, `winfstest-streams/01.t`, `winfstest-streams/02.t`, `winfstest-streams/03.t`, `winfstest-streams/04.t`, `fsx-stream`

### 删除可见性基线差异

`winfstest-base/08.t`

### WSL stat 查询

`wsl_stat_test`
