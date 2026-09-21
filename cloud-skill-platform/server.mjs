import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { JsonStore } from "./lib/store.mjs";
import {
  bearerToken, createId, createOpaqueToken, hashPassword, hashToken, publicUser, sessionExpiry, verifyPassword,
} from "./lib/security.mjs";
import { adjustQuota, ensureQuotaAccount, refundQuota, reserveQuota, settleQuota } from "./lib/quota.mjs";
import {
  artifactFromSkill, catalogItems, ensureSigningKey, findPublishedArtifact, prepareSkillSubmission, publicArtifact, publicSkill,
} from "./lib/skills.mjs";
import {
  decodeUpload, normalizeDisplayName, normalizeEmail, publicError,
} from "./lib/validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const defaultDataPath = resolve(process.env.SHENSI_CLOUD_DATA || join(root, "data", "state.json"));
const defaultSigningKeyPath = resolve(process.env.SHENSI_CLOUD_SIGNING_KEY || join(root, "data", "signing-key.json"));

const json = (response, status, payload, headers = {}) => {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

const corsHeaders = (request, allowedOrigin) => {
  const origin = String(request.headers.origin || "").trim();
  if (!origin || !allowedOrigin.has(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
};

const bodyJson = (request, maxBytes = 8 * 1024 * 1024) => new Promise((resolveBody, rejectBody) => {
  let body = "";
  let size = 0;
  let rejected = false;
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    if (rejected) return;
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) {
      rejected = true;
      rejectBody(Object.assign(new Error("请求内容超过大小限制"), { statusCode: 413 }));
      return;
    }
    body += chunk;
  });
  request.on("end", () => {
    if (rejected) return;
    try { resolveBody(body ? JSON.parse(body) : {}); } catch { rejectBody(Object.assign(new Error("请求 JSON 格式无效"), { statusCode: 400 })); }
  });
  request.on("error", rejectBody);
});

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

const roleAllowed = (user, roles) => user && roles.includes(user.role) && user.status === "active";

const cookieToken = (request) => {
  const encoded = String(request.headers.cookie || "")
    .split(";")
    .map((item) => item.trim().split("="))
    .find(([key]) => key === "shensi_session")?.[1];
  if (!encoded) return "";
  try { return decodeURIComponent(encoded); } catch { return ""; }
};

const bootstrapAdmin = async (store) => {
  const email = String(process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD || "");
  if (!email || !password || store.state.users.some((user) => user.role === "admin")) return;
  const passwordHash = await hashPassword(password);
  await store.transact((state) => {
    const user = { id: createId("user"), email, displayName: "神思管理员", role: "admin", status: "active", passwordHash, createdAt: Date.now(), updatedAt: Date.now() };
    state.users.push(user);
    state.memberships.push({ id: createId("membership"), userId: user.id, tier: "admin", status: "active", units: 0, expiresAt: 0, updatedAt: Date.now() });
    ensureQuotaAccount(state, user.id);
  });
};

const publicMembership = (membership) => membership ? ({
  tier: String(membership.tier || "free"),
  status: String(membership.status || "inactive"),
  units: Number(membership.units) || 0,
  expiresAt: Number(membership.expiresAt) || 0,
}) : ({ tier: "free", status: "inactive", units: 0, expiresAt: 0 });

const sessionCookie = (token, rememberMe = true) => `shensi_session=${encodeURIComponent(token)}; Max-Age=${rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`;

export const createCloudSkillApp = async ({ dataPath = defaultDataPath, signingKeyPath = defaultSigningKeyPath, publicBaseUrl = "", store: suppliedStore } = {}) => {
  const store = suppliedStore || await new JsonStore(dataPath).init();
  await bootstrapAdmin(store);
  const signingKey = await ensureSigningKey(signingKeyPath);
  const allowedOrigins = new Set(String(process.env.SHENSI_CLOUD_ALLOWED_ORIGINS || "https://hexing.studio,https://skill.hexing.studio,http://127.0.0.1:4280")
    .split(",").map((item) => item.trim()).filter(Boolean));
  const baseUrl = String(publicBaseUrl || process.env.SHENSI_CLOUD_PUBLIC_URL || "").replace(/\/$/u, "");

  const currentUser = (request) => {
    const token = bearerToken(request) || cookieToken(request);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = store.state.sessions.find((entry) => entry.tokenHash === tokenHash && entry.expiresAt > Date.now() && !entry.revokedAt);
    const user = session && store.state.users.find((entry) => entry.id === session.userId && entry.status === "active");
    return user || null;
  };
  const requireUser = (request) => currentUser(request) || fail("请先登录后再操作", 401);
  const requireAdmin = (request) => {
    const user = requireUser(request);
    if (!roleAllowed(user, ["admin", "reviewer", "membership_admin"])) fail("当前账号没有管理员权限", 403);
    return user;
  };
  const audit = async ({ actorUserId = "system", action, targetType, targetId, detail = {} }) => {
    await store.transact((state) => {
      state.auditLogs.push({ id: createId("audit"), actorUserId, action, targetType, targetId, detail, createdAt: Date.now() });
    });
  };

  const register = async (body) => {
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    const displayName = normalizeDisplayName(body.displayName);
    let user;
    await store.transact((state) => {
      if (state.users.some((entry) => entry.email === email && entry.status !== "deleted")) fail("该邮箱已注册", 409);
      user = { id: createId("user"), email, displayName, role: "user", status: "active", passwordHash, createdAt: Date.now(), updatedAt: Date.now() };
      state.users.push(user);
      state.memberships.push({ id: createId("membership"), userId: user.id, tier: "free", status: "active", units: 0, expiresAt: 0, updatedAt: Date.now() });
      ensureQuotaAccount(state, user.id);
    });
    const token = await issueSession(user.id, Boolean(body.rememberMe));
    return { user: publicUser(user), token };
  };

  const issueSession = async (userId, rememberMe) => {
    const token = createOpaqueToken();
    await store.transact((state) => state.sessions.push({ id: createId("session"), userId, tokenHash: hashToken(token), expiresAt: sessionExpiry(rememberMe), createdAt: Date.now(), revokedAt: 0 }));
    return token;
  };

  const login = async (body) => {
    const email = normalizeEmail(body.email);
    const user = store.state.users.find((entry) => entry.email === email && entry.status === "active");
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) fail("邮箱或密码不正确", 401);
    const token = await issueSession(user.id, Boolean(body.rememberMe));
    return { user: publicUser(user), token };
  };

  const handle = async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const headers = corsHeaders(request, allowedOrigins);
    if (request.method === "OPTIONS") return json(response, 204, {}, { ...headers, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" });
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        const local = String(process.env.SHENSI_CLOUD_ENV || "development") !== "production";
        return json(response, 200, {
          ok: true, connected: true, service: "shensi-skill-marketplace", version: "0.1.0", ready: local,
          postgres: local || process.env.SHENSI_CLOUD_POSTGRES_READY === "true",
          objectStorage: local || process.env.SHENSI_CLOUD_OBJECT_STORAGE_READY === "true",
          malwareScanner: local || process.env.SHENSI_CLOUD_MALWARE_SCANNER_READY === "true",
          artifactSigning: true, signedCatalog: true,
          production: !local,
          message: local ? "开发/测试存储已启用；生产部署前必须接入 PostgreSQL、OSS 和恶意文件扫描。" : "生产服务依赖项已由部署配置声明。",
        }, headers);
      }
      if (url.pathname === "/v1/catalog" && request.method === "GET") {
        return json(response, 200, { connected: true, items: catalogItems(store.state).slice(0, Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100))) }, headers);
      }
      const segments = url.pathname.split("/").filter(Boolean).map((value) => decodeURIComponent(value));
      if (segments[0] === "v1" && segments[1] === "artifacts" && segments[4] === "download" && request.method === "GET") {
        const found = findPublishedArtifact(store.state, segments[2], segments[3]);
        if (!found) return json(response, 404, { ok: false, message: "Skill 制品不存在" }, headers);
        const contentUrl = `${baseUrl || `${url.protocol}//${url.host}`}/v1/artifacts/${encodeURIComponent(segments[2])}/${encodeURIComponent(segments[3])}/content`;
        return json(response, 200, { artifact: publicArtifact(found.artifact), downloadUrl: contentUrl }, headers);
      }
      if (segments[0] === "v1" && segments[1] === "artifacts" && segments[4] === "content" && request.method === "GET") {
        const found = findPublishedArtifact(store.state, segments[2], segments[3]);
        if (!found) return json(response, 404, { ok: false, message: "Skill 制品不存在" }, headers);
        const bytes = Buffer.from(found.versionRecord.bytesBase64, "base64url");
        response.writeHead(200, { ...headers, "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff" });
        return response.end(bytes);
      }
      if (url.pathname === "/v1/auth/register" && request.method === "POST") {
        const body = await bodyJson(request);
        const result = await register(body);
        return json(response, 201, result, { ...headers, "Set-Cookie": sessionCookie(result.token, Boolean(body.rememberMe)) });
      }
      if (url.pathname === "/v1/auth/login" && request.method === "POST") {
        const body = await bodyJson(request);
        const result = await login(body);
        return json(response, 200, result, { ...headers, "Set-Cookie": sessionCookie(result.token, Boolean(body.rememberMe)) });
      }
      if (url.pathname === "/v1/auth/refresh" && request.method === "POST") {
        const user = requireUser(request);
        return json(response, 200, { user: publicUser(user), token: await issueSession(user.id, true) }, headers);
      }
      if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
        const token = bearerToken(request) || cookieToken(request);
        await store.transact((state) => { const session = state.sessions.find((entry) => entry.tokenHash === hashToken(token)); if (session) session.revokedAt = Date.now(); });
        return json(response, 200, { ok: true }, { ...headers, "Set-Cookie": "shensi_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" });
      }
      if (url.pathname === "/v1/auth/me" && request.method === "GET") return json(response, 200, { user: publicUser(requireUser(request)) }, headers);
      if (segments[0] === "v1" && segments[1] === "skills" && segments[2] && request.method === "GET") {
        const skill = store.state.skills.find((entry) => entry.skillId === segments[2] && entry.status === "published");
        if (!skill) return json(response, 404, { ok: false, message: "Skill 不存在" }, headers);
        const version = skill.versions.find((entry) => entry.publishedAt) || skill.versions.at(-1);
        return json(response, 200, { skill: publicSkill(skill, version), artifact: version.artifact ? publicArtifact(version.artifact) : null }, headers);
      }
      if (url.pathname === "/v1/skills/uploads" && request.method === "POST") {
        const owner = requireUser(request);
        const body = await bodyJson(request);
        const bytes = decodeUpload(body);
        const submission = prepareSkillSubmission({ body, bytes, owner });
        await store.transact((state) => state.skills.push(submission));
        await audit({ actorUserId: owner.id, action: "skill.upload", targetType: "skill", targetId: submission.id, detail: { skillId: submission.skillId, status: submission.status } });
        return json(response, 201, { skill: publicSkill(submission), scan: submission.scan, message: submission.status === "quarantined" ? "上传已隔离，等待处理" : "上传成功，等待管理员审核" }, headers);
      }
      if (url.pathname === "/v1/membership" && request.method === "GET") {
        const user = requireUser(request);
        return json(response, 200, { membership: publicMembership(store.state.memberships.find((entry) => entry.userId === user.id)) }, headers);
      }
      if (url.pathname === "/v1/quota" && request.method === "GET") {
        const user = requireUser(request);
        const account = ensureQuotaAccount(store.state, user.id);
        return json(response, 200, { available: account.available, reserved: account.reserved, ledger: store.state.quotaLedger.filter((entry) => entry.userId === user.id).slice(-50) }, headers);
      }
      if (url.pathname === "/v1/ai/text/reserve" && request.method === "POST") {
        const user = requireUser(request);
        const body = await bodyJson(request);
        let result;
        await store.transact((state) => { result = reserveQuota({ state, userId: user.id, amount: body.amount, idempotencyKey: body.idempotencyKey, reason: body.reason || "文字 AI 请求" }); });
        return json(response, 200, { reservationId: result.reservationId, idempotent: result.idempotent, available: result.account.available, reserved: result.account.reserved }, headers);
      }
      if (url.pathname === "/v1/ai/text/settle" && request.method === "POST") {
        const user = requireUser(request);
        const body = await bodyJson(request);
        let account;
        await store.transact((state) => { account = settleQuota({ state, userId: user.id, reservationId: body.reservationId, usedAmount: body.usedAmount }); });
        return json(response, 200, { available: account.available, reserved: account.reserved }, headers);
      }
      if (url.pathname === "/v1/ai/text/refund" && request.method === "POST") {
        const user = requireUser(request);
        const body = await bodyJson(request);
        let account;
        await store.transact((state) => { account = refundQuota({ state, userId: user.id, reservationId: body.reservationId }); });
        return json(response, 200, { available: account.available, reserved: account.reserved }, headers);
      }
      if (url.pathname === "/v1/admin/skills" && request.method === "GET") {
        requireAdmin(request);
        return json(response, 200, { items: store.state.skills.map((skill) => ({ ...publicSkill(skill), recordId: skill.id, scan: skill.scan, review: skill.review || null })) }, headers);
      }
      if (url.pathname === "/v1/admin/users" && request.method === "GET") {
        requireAdmin(request);
        return json(response, 200, { items: store.state.users.map((user) => ({ user: publicUser(user), membership: publicMembership(store.state.memberships.find((entry) => entry.userId === user.id)), quota: store.state.quotaAccounts.find((entry) => entry.userId === user.id) ? { available: store.state.quotaAccounts.find((entry) => entry.userId === user.id).available, reserved: store.state.quotaAccounts.find((entry) => entry.userId === user.id).reserved } : { available: 0, reserved: 0 } })) }, headers);
      }
      if (segments[0] === "v1" && segments[1] === "admin" && segments[2] === "skills" && segments[3] && request.method !== "DELETE") {
        const actor = requireAdmin(request);
        const skill = store.state.skills.find((entry) => entry.id === segments[3] || entry.skillId === segments[3]);
        if (!skill) return json(response, 404, { ok: false, message: "Skill 不存在" }, headers);
        if (segments[4] === "review" && request.method === "POST") {
          const body = await bodyJson(request);
          const decision = String(body.decision || "");
          if (!["approve", "reject"].includes(decision)) fail("审核决定无效");
          if (decision === "approve" && skill.scan.status !== "passed") fail("自动检查未通过，不能发布", 409);
          const versionRecord = skill.versions.at(-1);
          if (decision === "approve") {
            const artifact = await artifactFromSkill({ skill: { ...skill, publisherRole: skill.ownerUserId === actor.id ? "user" : "user" }, versionRecord, signingKey });
            await store.transact((state) => {
              const target = state.skills.find((entry) => entry.id === skill.id);
              target.status = "published";
              target.updatedAt = Date.now();
              target.review = { decision, reason: String(body.reason || "").slice(0, 500), reviewerUserId: actor.id, reviewedAt: Date.now() };
              target.versions.at(-1).publishedAt = Date.now();
              target.versions.at(-1).artifact = artifact;
            });
          } else {
            await store.transact((state) => { const target = state.skills.find((entry) => entry.id === skill.id); target.status = "rejected"; target.updatedAt = Date.now(); target.review = { decision, reason: String(body.reason || "").slice(0, 500), reviewerUserId: actor.id, reviewedAt: Date.now() }; });
          }
          await audit({ actorUserId: actor.id, action: `skill.${decision}`, targetType: "skill", targetId: skill.id, detail: { reason: String(body.reason || "").slice(0, 500) } });
          return json(response, 200, { skill: publicSkill(store.state.skills.find((entry) => entry.id === skill.id)) }, headers);
        }
        if (segments[4] === "unpublish" && request.method === "POST") {
          await store.transact((state) => { const target = state.skills.find((entry) => entry.id === skill.id); target.status = "unpublished"; target.updatedAt = Date.now(); });
          await audit({ actorUserId: actor.id, action: "skill.unpublish", targetType: "skill", targetId: skill.id });
          return json(response, 200, { ok: true }, headers);
        }
        return json(response, 404, { ok: false, message: "管理员 Skill 操作不存在" }, headers);
      }
      if (segments[0] === "v1" && segments[1] === "admin" && segments[2] === "skills" && segments[3] && request.method === "DELETE") {
        const actor = requireAdmin(request);
        const index = store.state.skills.findIndex((entry) => entry.id === segments[3] || entry.skillId === segments[3]);
        if (index < 0) return json(response, 404, { ok: false, message: "Skill 不存在" }, headers);
        await store.transact((state) => state.skills.splice(index, 1));
        await audit({ actorUserId: actor.id, action: "skill.delete", targetType: "skill", targetId: segments[3] });
        return json(response, 200, { ok: true }, headers);
      }
      if (url.pathname === "/v1/admin/quota/adjust" && request.method === "POST") {
        const actor = requireAdmin(request);
        const body = await bodyJson(request);
        const userId = String(body.userId || "");
        if (!store.state.users.some((entry) => entry.id === userId)) fail("目标用户不存在", 404);
        let account;
        await store.transact((state) => { account = adjustQuota({ state, userId, amount: body.amount, reason: body.reason || "管理员调整", actorUserId: actor.id }); });
        await audit({ actorUserId: actor.id, action: "quota.adjust", targetType: "user", targetId: userId, detail: { amount: Number(body.amount) || 0 } });
        return json(response, 200, { available: account.available, reserved: account.reserved }, headers);
      }
      if (url.pathname === "/v1/admin/memberships" && request.method === "POST") {
        const actor = requireAdmin(request);
        const body = await bodyJson(request);
        const userId = String(body.userId || "");
        if (!store.state.users.some((entry) => entry.id === userId)) fail("目标用户不存在", 404);
        let membership;
        let account;
        await store.transact((state) => {
          membership = state.memberships.find((entry) => entry.userId === userId) || { id: createId("membership"), userId };
          const previousUnits = Number(membership.units) || 0;
          membership.tier = String(body.tier || "vip").slice(0, 40);
          membership.status = "active";
          membership.units = Number(body.units) || 0;
          membership.expiresAt = Number(body.expiresAt) || 0;
          membership.updatedAt = Date.now();
          if (!state.memberships.includes(membership)) state.memberships.push(membership);
          const delta = membership.units - previousUnits;
          account = delta ? adjustQuota({ state, userId, amount: delta, reason: `会员${membership.tier}额度调整`, actorUserId: actor.id }) : ensureQuotaAccount(state, userId);
        });
        await audit({ actorUserId: actor.id, action: "membership.update", targetType: "user", targetId: userId, detail: { tier: membership.tier, units: membership.units, quotaAvailable: account.available } });
        return json(response, 200, { membership: publicMembership(membership), quota: { available: account.available, reserved: account.reserved } }, headers);
      }
      if (segments[0] === "v1" && segments[1] === "admin" && segments[2] === "users" && segments[3] && segments[4] === "status" && request.method === "POST") {
        const actor = requireAdmin(request);
        const body = await bodyJson(request);
        const status = ["active", "suspended", "banned"].includes(String(body.status)) ? String(body.status) : "";
        if (!status) fail("账号状态无效");
        if (!store.state.users.some((entry) => entry.id === segments[3])) fail("目标用户不存在", 404);
        await store.transact((state) => { const target = state.users.find((entry) => entry.id === segments[3]); target.status = status; target.updatedAt = Date.now(); });
        await audit({ actorUserId: actor.id, action: "user.status", targetType: "user", targetId: segments[3], detail: { status } });
        return json(response, 200, { user: publicUser(store.state.users.find((entry) => entry.id === segments[3])) }, headers);
      }
      if (url.pathname === "/v1/admin/audit-logs" && request.method === "GET") {
        requireAdmin(request);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        return json(response, 200, { items: store.state.auditLogs.slice(-limit).reverse() }, headers);
      }
      return json(response, 404, { ok: false, message: "接口不存在" }, headers);
    } catch (error) {
      return json(response, Number(error?.statusCode) || 400, { ok: false, message: publicError(error) }, headers);
    }
  };
  return { store, signingKey, handler: handle, close: () => {} };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createCloudSkillApp();
  const host = process.env.SHENSI_CLOUD_HOST || "127.0.0.1";
  const port = Number(process.env.SHENSI_CLOUD_PORT || 4280);
  createServer(app.handler).listen(port, host, () => console.log(`神思云端 Skill 广场运行于 http://${host}:${port}`));
}
