# 神思邮箱验证码登录

更新：2026-09-28。已实现代码与隔离测试；尚未部署、没有真实 QQ 发信验收。

## 已确认配置

- 发件邮箱：shensiforge@qq.com；发件显示名称：神思。
- 账号服务沿用现有 api.hexing.studio/skill 部署规划，不修改 hexing.studio 的邮箱 DNS。
- 每天 1,000 封容量规划；默认硬上限为每天 1,000 次发信尝试，按北京时间自然日重置。失败尝试也计数，达到上限停止新邮件；不会自动购买、扩容或切换付费发信渠道。此限制不等于 QQ 允许发送的额度。
- 另外限制每个邮箱 60 秒一次、每小时 5 次、24 小时 10 次；来源 IP 每小时 20 次、24 小时 100 次；同时最多 3 个发信请求。

## 用户操作

神思账户登录窗口新增“邮箱验证码”。发送后显示 60 秒倒计时，输入六位随机码登录；验证码 5 分钟有效、一次使用、最多错误 5 次。新邮箱创建普通账号，初始积分为 0，不自动开通付费会员。

旧账号的邮箱只是历史填写值，不能当作验证过的登录身份，也不会自动合并账户。旧用户先用密码登录，在账户设置 → 账户安全 → 验证绑定中完成验证；绑定后才允许用该邮箱登录。管理员及其他管理角色保持原登录方式。更换已验证邮箱需要另行设计验证旧邮箱/管理员恢复流程，当前不开放直接覆盖。

原来的密码登录、注册与密保找回保留。未配置邮件服务时只关闭邮件操作，不阻断密码登录、作品生成或供应商配置。

## 服务端秘密配置

将 .env.example 中的邮件变量配置到服务器服务进程的受限环境文件。不要复制桌面用户目录，不要把 SMTP 授权码写进仓库、客户端或对话。

1. 邮箱所有者在 QQ 邮箱启用 SMTP 发信权限并取得授权码，仅在服务器填写 SHENSI_CLOUD_SMTP_PASSWORD；不使用邮箱主密码。
2. 独立生成至少 32 字符随机秘密，填写 SHENSI_CLOUD_EMAIL_CODE_SECRET。它用于保存验证码 HMAC，不是邮箱授权码；重启必须保持相同值。
3. 服务进程需要 Node.js 20+，在 cloud-skill-platform 下按锁文件执行 npm ci --omit=dev --ignore-scripts。
4. 填写 SHENSI_CLOUD_SMTP_USER=shensiforge@qq.com、SHENSI_CLOUD_SMTP_FROM_NAME=神思，默认 smtp.qq.com:465，TLS 验证始终开启。
5. 核对 SHENSI_CLOUD_EMAIL_DAILY_LIMIT=1000。只有邮件配置及数据库就绪后，才设置 SHENSI_CLOUD_EMAIL_LOGIN_ENABLED=true。
6. 生产只使用持久化 PostgreSQL，验证码、限流、消费和会话在事务中原子更新；不能使用多个各自独立的 JSON 文件进程分摊额度。
7. 如有反向代理，配置实际直接连接服务的代理 IP 到 SHENSI_CLOUD_TRUSTED_PROXY_IPS，服务端端口不得直接暴露公网；代理必须覆盖 X-Real-IP，不能透传客户端提供的值。默认忽略客户端代理头。

发信 API 最长等待 12 秒，超时主动终止本次 SMTP 连接，并作废该验证码，不自动重发。SMTP 接受邮件不等于已到收件箱，仍需真实收件验收并检查垃圾邮件。

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| GET /v1/auth/email-config | 公开启用状态、有效期、重发间隔、全站日上限；不公开密码和密钥 |
| POST /v1/auth/email-code | email + purpose(login/bind)，绑定须登录；返回 challengeId，无验证码 |
| POST /v1/auth/email-login | email + challengeId + code；原子消费验证码并签发会话 |
| POST /v1/account/email-bind | 已登录用户验证自己的邮箱，不接受客户端 userId |

桌面端通过现有 /api/account 代理访问这些接口；发信凭据只在云端。每日配额计数存储在后端，伪造客户端、关闭界面或重启服务不能重置。网络错误不清除原密码会话。

## 验收及未完成项

- node scripts/test-account-email-login.mjs：隔离 HTTP 测试，无真实发信；覆盖过期、重放、并发、错误计数、重启限流、账号归属、SMTP 失败、日额度。
- node scripts/test-account-email-ui.mjs：隔离 Edge，使用真实账户窗口片段及处理代码；覆盖密码登录、验证码、绑定、倒计时、迟到响应和未配置状态。
- node scripts/test-account-platform-foundations.mjs、test-cloud-skill-platform.mjs、test-cloud-skill-platform-production-gate.mjs、test-account-and-attempt-recovery-contract.mjs：定向回归。
- 真实 QQ 授权码仍待用户在服务器填写；公开服务健康检查本轮连接重置，尚未确认部署状态，未绕过 TLS。
- 尚未部署、打包或安装；没有对真实用户发邮件，没有使用任何付费模型或支付通道。
- 头像/笔名自动内容审核供应商仍待配置，不把本次邮箱认证或格式校验当作内容审核。
