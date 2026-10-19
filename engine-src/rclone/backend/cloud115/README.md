# 115 网盘适配器

使用 115 官方开放平台 API，后端名称为 `cloud115`。挂载、VFS 缓存、盘符和安全卸载沿用 OneMount 的 rclone 通路；没有修改 rclone 核心来接入 115。

## 当前状态

已实现扫码授权、授权自动刷新、目录分页、中文文件名、SHA-1、Range 下载、目录创建、上传、覆盖、文件改名和删除。普通上传使用 115 返回的 OSS 临时凭据，通过官方 OSS SDK 分片上传；同时支持哈希挑战及服务端快速上传。

**尚无获批 App ID 和真实账号授权，本适配尚未完成 115 服务端或真实挂载验收。** 模拟服务测试通过不能替代真实网盘结果。发布配置没有 App ID 时，界面入口显示为尚未开放登录。文件系统卷暂不开放；先完成真实直连验证，再评估 JuiceFS / S3 网关通路。

## 申请与配置

1. 登录 [115 开放平台](https://open.115.com/)，申请个人或企业入驻。认证材料直接提交到官网。
2. 入驻通过后创建应用，申请文件列表、目录创建、上传、下载、改名、移动、删除等实际需要的权限。
3. 配置支持手机扫码的 PKCE 授权。云屿使用 App ID，不需要把 App Secret 分发到桌面端。
4. 在被 Git 忽略的 `oauth-clients.local.json` 中添加 `"cloud115": {"clientId": "获批的数字 App ID", "clientSecret": ""}`，沿用 `npm run release:config` 的构建配置流程；不要提交其他网盘的私有应用配置。也可用构建环境变量 `ONEMOUNT_OAUTH_CLOUD115_CLIENT_ID`。
5. 使用新构建，选择“115 网盘 → 扫码连接”，在 115 手机客户端确认授权。

应用由发布者申请一次，其他用户使用这组获批应用配置授权自己的账号。是否允许分发及相应范围以应用审核结果为准。本适配没有借用 OpenList 的 App ID 或授权中转服务。

授权二维码在本机生成；PKCE verifier、扫码 UID、签名与访问令牌不进入渲染进程或授权日志。刷新后的 token 通过 rclone 配置映射保存，桌面端仍使用加密的 `accounts.conf`。数值错误码可记录到 `auth.log`，不记录接口响应正文。

## 文件行为与限制

- 文件名按 rclone 编码规则处理；同一目录存在多个完全同名对象时明确报错，避免选错文件。
- 修改时间由 115 管理，不承诺设置任意 mtime。只在同一目录内提供服务端文件和文件夹改名，跨目录移动交回 rclone 的回退逻辑。
- 上传前需要计算完整 SHA-1 和前 128 KiB SHA-1，因此先建立临时文件快照。额外临时空间约等于上传文件大小，位于系统临时目录，结束后删除；它不计入界面的 VFS 缓存目标。
- 新内容先以随机临时名称上传，确认远端大小、哈希和完成状态后再发布到目标名称。覆盖时保留旧版本直到新版本发布成功。API 不提供原子替换，这不能保证其他客户端并发修改时的完整事务隔离。
- 取消、网络响应丢失或发布失败时可能保留 `.cloud-island-upload-*` 或带 `-previous` 的恢复文件；不自动扫描删除这些文件，以免误删可恢复内容。
- 文件操作默认每实例最多约 2 个 API 请求/秒；只对读取或获取下载地址的 429/5xx 进行有限重试，文件变更不盲目重发。真实账户的限流、空间不足及跨进程同时刷新仍需实测。
- 下载校验实际 Range、长度及可信下载域名，签名下载链接不携带开放平台 Bearer token。
- 空文件实现走服务端上传流程；能否被当前应用权限接受、单文件最大大小和会员速度限制等待真实验证。

## 自动测试

```powershell
npm test
npm run engine:rclone:test
npm run engine:rclone:build
```

`cloud115_test.go` 使用隔离 HTTP 服务覆盖目录分页、路径编码、重复名称、目录生命周期、Range/过期链接、上传内容校验、覆盖失败恢复、普通分片与快速上传、哈希挑战、回调确认、取消和分片清理、429 重试、禁止盲目重试变更、并发刷新持久化及域名校验。

真实服务测试使用 rclone 官方 `fstest/fstests`，默认明确跳过。获得账号授权后，指向专门测试目录并显式运行：

```powershell
# RCLONE_CONFIG 指向隔离的测试配置，必要时另设 RCLONE_CONFIG_PASS。
$env:ONEMOUNT_115_TEST_REMOTE = 'test115:OneMount-115-validation'
Set-Location engine-src/rclone
go test -run '^TestLive115$' -v -timeout 60m ./backend/cloud115
```

该官方套件在所选路径下创建随机子目录，写入并删除测试数据；不得把生产文件当作测试素材。其结果和 Windows 挂载结果将在取得真实授权后单独记录。

## 协议参考

- [115 官方开发者申请指引](https://115.com/115115/T853224.html)
- [115 开放文档](https://www.yuque.com/115yun/open)
- [OpenList 115 Open 使用说明](https://doc.oplist.org/guide/drivers/115_open)
- [OpenListTeam/115-sdk-go](https://github.com/OpenListTeam/115-sdk-go)，用于核对公开 API 参数；Apache-2.0。
- [阿里云 OSS Go SDK v3.0.2](https://github.com/aliyun/aliyun-oss-go-sdk/tree/v3.0.2)，用于实际上传；Apache-2.0。
