# 自定义后端扩展规范

自定义网盘后端统一放在 `engine-src/rclone/backend/<name>/`，共享上级 Go 模块。
本工程通过 Go Modules 引用 `github.com/rclone/rclone v1.75.0`，无需复制或 fork 上游源码。
运行时仍是独立的 `rclone.exe`；桌面程序沿用 RC 和命令行控制。

## 目录与自动编译

| 路径 | 约定 |
| --- | --- |
| `<name>/<name>.go` | Go 包入口、`init` 注册、Fs/Object 实现；可按需要增加文件 |
| `<name>/api/types.go` | 可选的网盘 API 请求和响应结构 |
| `<name>/<name>_test.go` | 无凭据单元测试、HTTP 模拟测试 |
| `<name>/integration_test.go` | 真实后端测试；没有测试配置时必须明确 Skip |
| `<name>/README.md` | 服务能力、认证、配置选项、限制与测试方法 |
| `all/all.go` | 自动生成的空白导入，禁止手工编辑 |
| `internal/` | 可选公共实现，不作为独立后端导入 |
| `testdata/` | 测试素材，不作为独立后端导入 |

名称仅使用小写英文字母和数字，以字母开头，例如 `mydrive`；目录名必须与 `fs.RegInfo.Name` 相同，不能与上游后端冲突。每个后端入口目录必须包含至少一个非 `_test.go` 的 Go 文件，不能放独立 `go.mod` 或符号链接。嵌套的 `api/` 等子目录由后端自行 import。

构建会扫描一级后端目录并生成 `all/all.go`；新增目录无需修改主程序或手写导入。随后编译器检查依赖与代码，构建脚本检查该名称是否出现在 `rclone config providers` 中。只有目录、没有可用实现或没有正确注册，将导致构建失败。入口必须支持 Windows；仅其他平台可用的文件不能作为本发行版的唯一入口。

注册结构示意（须先实现 `NewFs`，不能原样作为完整后端提交）：

```go
package mydrive

import "github.com/rclone/rclone/fs"

func init() {
    fs.Register(&fs.RegInfo{
        Name:        "mydrive",
        Description: "My Drive",
        NewFs:       NewFs,
        // Options: 注册必需的连接参数，密码字段设置 IsPassword。
        // Config: 有多步授权时接入 rclone 的非交互配置状态机。
    })
}
```

## 接口与正确性要求

实现上游 `fs.Fs`、`fs.Object` 接口，并加入编译期接口断言。以固定版本的 `fs/types.go` 为准。

- Fs：`Name`、`Root`、`String`、`Precision`、`Hashes`、`Features`；以及 `List`、`NewObject`、`Put`、`Mkdir`、`Rmdir`。
- Object：`Fs`、`String`、`Remote`、`ModTime`、`Size`、`Hash`、`Storable`；以及 `SetModTime`、`Open`、`Update`、`Remove`。
- 支持读取偏移和 Range 选项，按 rclone 约定处理可选/必需 OpenOption；不能忽略 Range 并悄悄返回整个文件。
- 上传和覆盖必须在网盘确认提交后才返回成功；失败不得伪装成成功。处理中间对象、重试、重复请求和取消时，避免留下可被误认为完整文件的结果。
- 目录不存在、对象不存在、非空目录、认证失败等错误，映射为 rclone 标准错误或可诊断错误。所有网络操作遵守 `context.Context` 取消。
- 如无法提供修改时间、哈希、服务端移动/复制等能力，按接口约定声明不支持。可选 `Features` 只填实际实现，不能虚报。基本文件操作可用不代表已经满足文件系统卷要求。
- 使用 rclone 的 HTTP 客户端、重试/限流设施和文件名编码工具，处理中文、空格、保留字符、大小写、分页、同名对象和临时下载链接过期。
- 网盘仍在异步处理文件时，要明确何时可读；不能因为本地接收完输入流就报告远端上传完成。

建议阅读同版本的相似后端，复用 `lib/rest`、`fs/fshttp`、`lib/encoder`、目录缓存和 OAuth 工具，不另写一套存储框架。

## 认证与 OneMount 界面

后端中实现鉴权及 token 更新，配置通过 rclone 的配置映射和回调保存。不得自己向 OneMount 用户目录写明文 token，不把凭据、授权链接、响应中的密钥打印到日志，不在源码中放测试账号或发布者密钥。

后端不得依赖终端交互输入。多步授权应支持当前 `config/create` / `config/update` 的非交互流程。设备码、二维码等不同授权方式需另行接入产品界面，不能假定现有 OAuth 浏览器流程能够处理。

编译进入引擎不会自动开放用户界面。开放新服务时还需修改：

- `src/manager.cjs` 的服务目录和可用状态。
- `src/accounts.cjs` 的服务类型、配置字段、授权状态/问题映射。
- `ui/` 中对应入口、表单和产品文案。
- 必需的发布者授权配置及前后端测试。

只有需要修改 rclone 的 VFS、RC、S3 服务或上游内部逻辑时，再评估固定提交的 fork/replace；不要为普通后端引入不必要的核心修改。

## 本地开发与构建（Windows x64）

安装 Node.js 24、Go（锁定工具链见上级 `go.mod`）；挂载验收还需 WinFsp。
从 OneMount 仓库根目录执行：

```powershell
npm ci
# 编写 backend/mydrive/ 后生成导入；新依赖在开发阶段整理并提交。
npm run engine:rclone:generate
Push-Location engine-src/rclone
go mod tidy
go test ./backend/mydrive/...
Pop-Location

# 自动导入测试 + 全部本地 Go 包测试（临时注册测试后端，随后清理）。
npm run engine:rclone:test
# 定制编译 rclone，下载并校验 JuiceFS；不会下载官方 rclone 覆盖定制产物。
npm run engines:win
npm run package:win
```

`go.mod`、`go.sum` 与生成的 `all/all.go` 一起提交。CI/发布使用 `-mod=readonly`，不自动 tidy 或升级依赖；新增依赖漏提交会直接失败。

输出为 `engines/rclone.exe` 和 `engines/rclone-build.json`，后者记录上游版本、模块校验和、Go 版本、源码提交、后端列表和二进制 SHA-256。Windows 发行构建使用 `cmount`、`CGO_ENABLED=0`，与本版本上游 Windows 策略一致；WinFsp 在运行时加载。源目录不会打进 Electron 应用。

仅修改前端时可复用已经生成的引擎；修改后端后必须重新执行 `npm run engine:rclone:build` 或 `npm run engines:win`，再打包。不能把旧 exe 的验收结果当作新源码的验证结果。

## 测试与开放条件

1. 无外部凭据测试：用模拟 HTTP 服务覆盖分页、Range、上传错误、过期 token、429/5xx 重试及取消，不访问真实账号。
2. 使用 rclone `fstest/fstests` 等官方测试工具，在专用测试账号/随机目录验证基本语义。测试可能写入、覆盖和删除，严禁使用用户真实数据目录；凭据只通过本地配置或 CI Secrets 注入，不提交。
3. 直连模式：真实 Windows 挂载，PowerShell 读写、中文路径、空文件/大文件、改名/删除、退出后冷缓存重挂校验。
4. 文件系统卷：另外验证 `serve s3` 的对象读写、Range、覆盖、删除和列举；实际通过 JuiceFS 读写重挂，并覆盖默认上传和后台上传两种策略。
5. 真实网盘覆盖断网、限流、授权过期、空间不足、上传中断及恢复；记录服务版本、后端 commit 和已知限制。

现有 CI 的本地后端挂载测试验证公共引擎链路，不代表未来每个网盘已经通过真实服务验收。未完成文件系统卷验收的后端，不能只因支持直连就宣称支持该模式。

参考：[官方后端开发规范](https://github.com/rclone/rclone/blob/v1.75.0/CONTRIBUTING.md#writing-a-new-backend)、[官方 out-of-tree 示例](https://github.com/rclone/rclone_out_of_tree_example)。
