# 云端部署说明

这是独立服务，不要把它挂载到神思桌面端作品目录，也不要把桌面端的 `current-state.json`、凭据或媒体配置复制到服务器。

开发验证：

```powershell
$env:SHENSI_CLOUD_PORT = "4280"
npm start
```

生产部署前必须先配置 PostgreSQL、OSS、Redis、ClamAV、HTTPS 和备份策略。当前 JSON 存储只用于本地测试和临时验收，不应作为多用户生产数据库。生产服务会真实探测四类依赖；任一探测失败都会保持 `ready=false`，上传和发布返回 503，不接受只修改 READY 环境变量的“假就绪”。

生产依赖变量：`SHENSI_CLOUD_DATABASE_URL`、`SHENSI_CLOUD_REDIS_URL`、`SHENSI_CLOUD_OSS_REGION`、`SHENSI_CLOUD_OSS_ENDPOINT`、`SHENSI_CLOUD_OSS_BUCKET`、`SHENSI_CLOUD_OSS_ROLE_NAME`、`SHENSI_CLOUD_CLAMDSCAN_PATH`。OSS 使用 ECS RAM 角色临时凭据，应用不保存 AccessKey；Bucket 必须为私有 Bucket。

上传生命周期：登录用户上传后先做静态规则和 ClamAV 双重检查；通过后只进入 OSS `quarantine/` 隔离前缀并写入 PostgreSQL，审核通过才复制到 `artifacts/` 正式前缀并生成签名目录。扫描拒绝、管理员拒绝或失败的隔离对象立即删除；已下架版本设置 15 天清理时间；审计日志保留 30 天。清理任务每小时运行一次，服务每次请求也会触发一次轻量清理。

管理入口：https://api.hexing.studio/skill/admin（待 `skill.hexing.studio` DNS 配置完成后可切换到独立子域名），名称为“神思后台管理”。后台只允许管理员登录，不提供注册、找回密码或修改密码。固定后台账号为 `798998264`，服务启动时由 `SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD` 在服务器受限环境中注入并确保该账号保持启用；密码不会写入仓库、前端、安装包或日志。旧的账号环境变量仅作兼容，不改变固定账号规则。

神思普通用户通过桌面端账号入口注册、登录或使用密保问题找回密码。普通用户账号与后台管理员账号分离；上传 Skill、会员/积分操作均要求普通用户已登录。生产环境没有接入真实支付渠道前，会员页面只显示“支付渠道未配置”，不会伪造充值成功。

桌面端默认连接 `https://api.hexing.studio/skill`，也可以通过 `SHENSI_MARKETPLACE_URL` 覆盖。服务器的 `/v1/client-config` 会公开制品验签公钥和管理入口；桌面端仍会校验 HTTPS、健康状态、目录签名和下载制品哈希。生产服务未通过健康检查时，桌面端保持本地目录模式，不会把未连接状态显示为可用。

服务器清理规则：先做 ECS/轻量实例快照，再压缩备份旧应用目录；默认只移除旧应用代码，保留数据库、OSS、证书、日志和备份。健康检查、登录、上传、审核、目录下载全部通过后，才切换 `skill.hexing.studio` DNS；保留旧服务回滚入口。
