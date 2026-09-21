# 云端部署说明

这是独立服务，不要把它挂载到神思桌面端作品目录，也不要把桌面端的 `current-state.json`、凭据或媒体配置复制到服务器。

开发验证：

```powershell
$env:SHENSI_CLOUD_PORT = "4280"
npm start
```

生产部署前必须先配置 PostgreSQL、OSS、Redis、恶意文件扫描、KMS/Secrets Manager、HTTPS 和备份策略。当前 JSON 存储只用于本地测试和临时验收，不应作为多用户生产数据库。

服务器清理规则：先做 ECS/轻量实例快照，再压缩备份旧应用目录；默认只移除旧应用代码，保留数据库、OSS、证书、日志和备份。健康检查、登录、上传、审核、目录下载全部通过后，才切换 `skill.hexing.studio` DNS；保留旧服务回滚入口。

