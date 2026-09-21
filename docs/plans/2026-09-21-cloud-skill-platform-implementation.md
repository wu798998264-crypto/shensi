# 神思云端 Skill 平台 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变桌面端创作链路的前提下，建立可测试、可部署的账号、Skill 审核、会员和额度云端服务。

**Architecture:** 新建独立 `cloud-skill-platform/` Node 服务，使用 HTTP 路由、可替换存储接口和临时文件存储完成第一阶段合同测试；生产环境再把存储适配器替换为 PostgreSQL/OSS/Redis/KMS。桌面端暂不改接入，待云端真实健康检查和凭据准备完成后再单独做适配。

**Tech Stack:** Node.js 22+、原生 `node:http`、`node:crypto`、JSON 文件存储（测试/开发）、PostgreSQL/OSS/Redis 适配接口（生产）。

---

### Task 1: 建立隔离服务目录与数据模型

**Files:**
- Create: `cloud-skill-platform/package.json`
- Create: `cloud-skill-platform/lib/store.mjs`
- Create: `cloud-skill-platform/lib/security.mjs`
- Create: `cloud-skill-platform/lib/validation.mjs`

**Step 1:** 建立无桌面端依赖的服务目录。

**Step 2:** 实现用户、会话、Skill、审核、会员、额度和审计的最小数据结构。

**Step 3:** 实现原子 JSON 写入和测试目录注入。

**Step 4:** 实现 scrypt 密码哈希、会话令牌哈希和常量时间校验。

**Step 5:** 运行 `node --check` 验证模块语法。

### Task 2: 实现认证与 Skill 生命周期 API

**Files:**
- Create: `cloud-skill-platform/server.mjs`
- Create: `cloud-skill-platform/lib/skills.mjs`

**Step 1:** 实现注册、登录、刷新、注销和当前用户接口。

**Step 2:** 强制已登录用户上传；上传后只进入待审核状态。

**Step 3:** 实现目录只返回已发布版本和公开上传者名称。

**Step 4:** 实现管理员审核、下架和删除，所有操作写审计日志。

**Step 5:** 运行 API 合同测试。

### Task 3: 实现会员与额度账本

**Files:**
- Modify: `cloud-skill-platform/server.mjs`
- Create: `cloud-skill-platform/lib/quota.mjs`

**Step 1:** 实现会员查询和额度查询。

**Step 2:** 实现管理员额度调整和不可变流水。

**Step 3:** 实现预留、结算、退款的幂等合同，为后续文字 AI 代理留出入口。

**Step 4:** 验证普通用户无权调整额度。

### Task 4: 安全与桌面端隔离测试

**Files:**
- Create: `scripts/test-cloud-skill-platform.mjs`

**Step 1:** 启动临时服务和临时存储。

**Step 2:** 验证未登录上传失败、普通用户审核失败、管理员审核成功、目录显示上传者。

**Step 3:** 验证密码和会话敏感值不出现在 API 响应。

**Step 4:** 验证桌面端受保护文件未被 import 或修改。

**Step 5:** 运行现有受保护图片定向测试 `npm run test:protected-image-profile-switch`，只读确认媒体链路未变。

### Task 5: 生产部署准备（需外部信息）

**Files:**
- Create: `cloud-skill-platform/.env.example`
- Create: `cloud-skill-platform/DEPLOYMENT.md`

**Step 1:** 配置阿里云资源和秘密管理器，不把密钥提交仓库。

**Step 2:** 先做服务器快照和旧代码备份。

**Step 3:** 部署新服务并通过 `/health`、注册、登录、上传、审核、目录检查。

**Step 4:** 核验 DNS 和 HTTPS 后，才将 `skill.hexing.studio` 指向新服务。

**Step 5:** 保留回滚指向和旧代码备份，确认桌面端本地创作不受影响后再清理旧应用代码。

