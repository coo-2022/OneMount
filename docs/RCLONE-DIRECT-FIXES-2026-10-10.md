# rclone 直连：执行权限与重复建目录修复

已在 Windows x64 实测完成。被测源码提交：`aa273af42b7359c73dee5278204da054f8286f18`。

- [完整直连 CI](https://github.com/coo-2022/OneMount/actions/runs/38050532018)
- [Windows 软件构建与验收](https://github.com/coo-2022/OneMount/actions/runs/38050531893)（成功，包含普通用户挂载和打包桌面应用验收；可下载预览包）
- [机器可读结果与逐项对比](RCLONE-DIRECT-FIX-RESULTS-2026-10-10.json)

## 修改

1. `directMountBody` 显式设置 `FilePerms: 0o777`，允许从直连挂载盘运行程序。权限仍是当前 rclone 的统一权限模型，不等于补齐逐文件 Windows ACL。已有挂载需要安全卸载，再使用新版本重新挂载。
2. cmount 的 `Mkdir` 检查已有名称并返回 EEXIST。用专用互斥锁串行化同一挂载实例的目录创建检查/创建，防止并发重复成功；rclone 内部 VFS Mkdir 的幂等行为保留。
3. 受控源码补丁固定在 `engine-src/rclone/patches/series.json`，锁定上游 v1.75.0 与源文件 SHA-256。构建复制已校验源码到临时目录，并用生成的 `-modfile` 应用本地替换；原始 go.mod/go.sum 和全局 module cache 不变。发行清单记录补丁 hash。
4. 每次构建运行 Windows Go 回归：首次创建、重复目录、大小写不敏感名称、文件碰撞且内容不变、缺失父目录、VFS 内部幂等性，以及 16 路并发只能有一个成功。

发行与回归统一走 `npm run engine:rclone:build` / `npm run engines:win`；直接在模块目录执行不带生成 modfile 的 `go build` 不会应用这些补丁。

## 实测结果

| 阶段 | 通过 | 失败 | 超时 | 未执行 |
|---|---:|---:|---:|---:|
| 修复前 | 62 | 54 | 1 | 0 |
| 修复后 | 68 | 48 | 1 | 0 |

以下六项由失败变为通过：

- `create_test`
- `winfstest-base/02.t`
- `exec_test`
- `exec_delete_test`
- `exec_rename_test`
- `exec_rename_dir_test`

其余 111 项状态保持不变；原先通过的 62 项仍全部通过。另有 14 项 Node 测试通过，Windows Go mkdir 回归通过。源码补丁与正式发行引擎使用同一构建流程。

严格兼容性 CI 仍为红色，因为其他 48 个失败和 1 个超时尚未修复；没有加入排除列表或放宽断言。两项指定修复已在真实挂载盘验证，并不代表全部 NTFS 语义或所有安装程序已兼容。

## 剩余影响

见 [文件系统语义缺失的实际影响](RCLONE-DIRECT-SEMANTICS-IMPACT.md)。其中只读保护和 ACL 应优先评估；属性/时间/ADS/EA 的完整保真、远端持久化和恢复是不同的验证目标。
