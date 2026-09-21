# 神思云端 Skill 广场与账号平台设计

> 本设计只覆盖独立云端服务，不修改神思桌面端的文档、卡片、白板图片/视频、历史版本或即梦媒体链路。

## 目标

提供一个可部署到阿里云的独立服务，支持账号登录、记住登录状态、登录后上传 Skill、上传者显示、自动扫描、管理员审核/下架/删除、会员状态和文字 AI 算力额度账本。桌面端通过现有远程 Skill 广场客户端按 HTTP API 读取目录；云端故障不得阻断本地创作。

## 边界

- 云端服务独立放在 `cloud-skill-platform/`，不被 Electron 打包，也不被本地 `server.mjs` import。
- 初期提供文件存储适配器，接口预留 PostgreSQL、OSS、Redis 和 KMS 适配器；部署前必须配置真实生产实现。
- 账号密码只保存密码哈希，客户端只保存短期访问令牌和可撤销刷新令牌；不保存明文密码。
- AI 请求先预留额度、成功后按 usage 结算、失败或取消退回预留额度；供应商密钥只放在服务端。
- 发布版本不可变，更新必须创建新版本；删除、下架、审核和额度变更都写审计日志。

## 核心流程

```text
注册/登录 → 会话 → 上传 Skill → 静态扫描 → 待审核 → 审核通过 → 发布目录
                                      ↘ 拒绝/隔离
VIP → 额度账户 → 预留 → 文字请求 → usage 结算/失败退款
```

## API 合同（第一阶段）

- `GET /health`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`
- `GET /v1/catalog`
- `POST /v1/skills/uploads`
- `GET /v1/skills/:skillId`
- `POST /v1/admin/skills/:skillId/review`
- `POST /v1/admin/skills/:skillId/unpublish`
- `DELETE /v1/admin/skills/:skillId`
- `GET /v1/membership`
- `GET /v1/quota`
- `POST /v1/quota/adjust`（管理员）

## 安全与隔离验收

1. 未登录不能上传 Skill。
2. 目录只返回已发布版本和上传者公开名称，不返回密码、令牌、内部路径或扫描原文。
3. 普通用户不能审核、下架、删除或调整额度。
4. 密码哈希使用 Node `scrypt`，比较使用常量时间比较。
5. 会话令牌可撤销且具有过期时间。
6. 上传大小、Skill ID、版本号和内容类型均受限；源文件不执行。
7. 云端测试只监听测试端口和临时目录；不会读取或写入作品工作区。
8. 本地文档/卡片/媒体定向测试在改动后继续通过。

## 生产部署前置

需要用户提供或确认：阿里云 ECS/轻量实例、SSH 临时密钥或本机密钥路径、旧项目目录及清理范围、DNS 管理方式、是否使用 `skill.hexing.studio`、PostgreSQL/OSS/Redis 资源、邮件或短信验证方式、VIP 等级与额度规则。清理服务器前先创建快照和压缩备份，默认只清理旧应用代码，不删除数据库、OSS、证书和备份。

