# OneMount 定制 rclone

本目录是独立 Go 模块，固定引用 rclone v1.75.0；Go 工具链锁定在 `go.mod`。
`main.go` 引入官方命令/后端和自动生成的本地后端导入。

自定义实现放在 **`backend/<name>/`**。完整开发流程、接口、授权、测试和发布要求见 [后端扩展规范](backend/README.md)。当前没有实际自定义网盘实现；不会向用户展示虚构的示例服务。

在仓库根目录运行 `npm run engine:rclone:build` 生成 Windows 引擎；`npm run engines:win` 同时准备 JuiceFS。发布仍使用独立 exe，不把 Go 代码嵌入 Electron 进程。

前端 cmount/VFS 补丁使用校验后的临时源码副本与 Go modfile，见 [源码补丁规范](patches/README.md)。补丁回归与发行二进制使用同一补丁源码，来源与 hash 记录在引擎清单中。
