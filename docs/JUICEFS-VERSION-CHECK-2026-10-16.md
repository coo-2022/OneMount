# JuiceFS 新版本修复状态核查（2026-10-16）

**结论：最新正式版 v1.4.1、1.3 系列维护版 v1.3.3 均未修复本次截断一致性缺陷。当前主分支的相关逻辑也未修改。**

本次查询 GitHub 官方 releases/latest 返回 v1.4.1（2026-07-30 发布）；1.3 分支最新维护发布为 v1.3.3（2026-08-07）。
主分支固定在提交 `2553b958a6f4bb58d86ac7adff4789a9cb82c32f`，提交时间 2026-10-16 09:53:44（北京时间）。

## 官方二进制实测

沿用前次独立本地 S3 故障注入实验：100,000 字节文件，映射写入后阻塞数据块 PUT，
再截断到 25,248 字节。保留五分钟刷新期限，截断返回后恢复上传，同步关闭，正常卸载后更换为空缓存重新挂载。
没有强制终止测试进程，没有使用网盘账户，没有替换项目原来的引擎。

| 发布标签 | 安装包实际版本 | 截断等待 | 成功返回时大小 | 冷读最终大小 | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| v1.3.3 | 1.3.2+2026-08-07.f65ce9b | 300.687 秒 | 25,248 | 98,304 | 缺陷仍可复现 |
| v1.4.1 | 1.4.1+2026-07-30.0b90c7d | 300.047 秒 | 25,248 | 98,304 | 缺陷仍可复现 |

两个官方安装包都核验了 GitHub 发布资产的 SHA256。v1.3.3 安装包内部显示 1.3.2，
与官方发布说明一致：原计划 v1.3.2，受不可变发布标签限制改名为 v1.3.3。
两个运行均正常退出，安全卸载后完成冷读验证。

## 源码和相关修改

三个版本的整个 VFS.Truncate 函数与 v1.3.0 完全相同，仍用
`_ = v.writer.Flush(ctx, ino)` 丢弃错误，然后继续截断元数据。
刷新超时返回 EIO、待上传片段后续提交、按片段末尾扩展 SQLite 文件长度的路径仍然存在。

- [v1.4.1 截断代码](https://github.com/juicedata/juicefs/blob/v1.4.1/pkg/vfs/vfs.go#L619)
- [v1.3.3 截断代码](https://github.com/juicedata/juicefs/blob/v1.3.3/pkg/vfs/vfs.go#L611)
- [本次固定的主分支代码](https://github.com/juicedata/juicefs/blob/2553b958a6f4bb58d86ac7adff4789a9cb82c32f/pkg/vfs/vfs.go#L627)

主分支同日合入的 [PR #7693](https://github.com/juicedata/juicefs/pull/7693)
仅限制刷新超时的全量堆栈诊断输出频率，保留原来的 EIO 和操作行为，不能修复本问题。
主分支只做了源码核查，没有构建并运行其二进制。

因此单纯升级上述版本不能解决本问题，仍需针对截断前刷新失败的处理修改 JuiceFS 引擎。

## 可复核证据

- [结构化记录与哈希](JUICEFS-VERSION-CHECK-2026-10-16.json)
- [原始根因分析](JUICEFS-TRUNCATE-INVESTIGATION-2026-10-15.md)
- [v1.4.1 官方发布](https://github.com/juicedata/juicefs/releases/tag/v1.4.1)
- [v1.3.3 官方发布](https://github.com/juicedata/juicefs/releases/tag/v1.3.3)

原始查询、安装包、源码保存在 `test-results/juicefs-version-check-20261016`。
- v1.3.3 运行：`test-results/juicefs-truncate-fault-7UQmHH`。
- v1.4.1 运行：`test-results/juicefs-truncate-fault-qbwApl`。
诊断运行器为 [`scripts/juicefs-truncate-version-check.cjs`](../scripts/juicefs-truncate-version-check.cjs)，通过
`ONEMOUNT_TEST_ENGINE` 指定引擎，通过 `ONEMOUNT_TEST_LETTER` 指定独立盘符。
