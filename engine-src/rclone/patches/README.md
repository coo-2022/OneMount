# rclone 前端补丁

网盘扩展仍放在 `backend/<name>/`。cmount 和 S3 网关的修复放在本目录，与后端隔离。

`series.json` 锁定上游版本、源文件 SHA-256 和唯一匹配的替换片段。`scripts/prepare-rclone-source.cjs` 读取已校验的 Go module，复制到临时 `.build/patched/upstream/` 后应用补丁，再生成带本地 replace 的 `-modfile` 参与测试和编译。Go 不允许 overlay 覆盖 module cache，因此采用构建目录内的源码副本；不修改全局 module cache，不把整份上游源码提交到仓库。原始 go.mod/go.sum 仍固定上游版本，并保持不变。

上游源文件变化、重复补丁、上下文不唯一均立即失败。升级 rclone 时必须逐项重新审查；不能仅更新 hash 跳过审查。引擎构建清单 `rclone-build.json` 记录补丁清单及修改前后 hash，确保发行包可追溯。

当前补丁 `cmount-exclusive-mkdir`：

- cmount 的 Mkdir 对已存在的文件或目录返回 EEXIST。
- 同一挂载实例的 mkdir 检查/创建通过专用互斥锁串行化，避免并发请求全部成功。
- VFS 内部 Mkdir 保留幂等行为，其他 rclone 命令不受此语义修改影响。
- 互斥锁不覆盖其他挂载实例或外部写入者；云盘后端的跨客户端原子创建能力不由此补丁提供。

`cmount_mkdir_windows_test.go` 在每次 Windows 引擎构建前执行，覆盖新建、重复目录、已有文件、缺失父目录、内部 VFS 幂等性及 16 路并发创建。完整 Windows WinFsp 测试验证实际挂载后的行为。

`s3-serialized-object-mutations` 修复慢网盘上的上传重试：

- PUT 和 DELETE 对同一个 bucket/key 使用固定数量的锁分组，等待可以被请求上下文取消。旧 PUT 的失败清理结束前，新 PUT 不会开始，避免清理掉已完成的新对象。不同分组仍可并发。
- PUT 的递归父目录创建串行执行，避免多个数据块同时创建相同目录。
- 使上游已经声明但未实际使用的 `--no-cleanup` 生效；云屿的卷网关设置此选项，删除数据块后保留空目录，避免远端目录 ID 失效及与新上传竞争。此选项不阻止对象删除。
- 修改仅位于 `cmd/serve/s3/backend.go`，不修改 VFS 核心或网盘直连的写回路径；不提供跨网关、跨客户端的写入互斥。JuiceFS 的块对象名由引擎生成，用户不得直接操作卷的存储目录。

`s3-gateway_test.go.txt` 由构建脚本复制进隔离的上游测试目录，原文件不参与本地后端包扫描。每次构建执行 `TestOneMountS3*`，验证旧上传失败与新上传竞争、已取消的重试不会改写对象，以及保留/清理空目录两种行为。测试文件的 SHA-256 同样写入引擎清单。
