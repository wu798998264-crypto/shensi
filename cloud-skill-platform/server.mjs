import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { JsonStore } from "./lib/store.mjs";
import { createPostgresStore } from "./lib/postgres-store.mjs";
import { createProductionDependencies } from "./lib/production-dependencies.mjs";
import {
  bearerToken, createId, createOpaqueToken, hashPassword, hashRecoveryAnswer, hashToken, publicUser, sessionExpiry, verifyPassword, verifyRecoveryAnswer,
} from "./lib/security.mjs";
import { adjustQuota, ensureQuotaAccount, refundQuota, reserveQuota, settleQuota } from "./lib/quota.mjs";
import {
  artifactFromSkill, catalogItems, ensureSigningKey, findPublishedArtifact, prepareSkillSubmission, publicArtifact, publicSkill, scanSkillPackage,
} from "./lib/skills.mjs";
import {
  decodeUpload, normalizeAccount, normalizeDisplayName, normalizeRecoveryContact, normalizeSecurityAnswer, normalizeSecurityQuestion, publicError,
} from "./lib/validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const defaultDataPath = resolve(process.env.SHENSI_CLOUD_DATA || join(root, "data", "state.json"));
const defaultSigningKeyPath = resolve(process.env.SHENSI_CLOUD_SIGNING_KEY || join(root, "data", "signing-key.json"));
const adminHtmlPath = join(root, "admin.html");
const adminCssPath = join(root, "admin.css");
const adminJsPath = join(root, "admin.js");
// This account is reserved for the fixed 神思后台管理 bootstrap identity.
// Its password is never stored in source; deployment must provide it through
// SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD on the server only.
const RESERVED_BOOTSTRAP_ADMIN_ACCOUNT = "798998264";

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
  const account = RESERVED_BOOTSTRAP_ADMIN_ACCOUNT;
  const password = String(process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD || "");
  // Never overwrite an existing password unless the deployment explicitly
  // supplies the bootstrap secret. This lets upgrades preserve the fixed
  // account while still repairing legacy records that were created as users.
  const passwordHash = password ? await hashPassword(password) : "";
  await store.transact((state) => {
    const user = state.users.find((entry) => (entry.account || entry.email) === account && entry.status !== "deleted") || {
      id: createId("user"), account, email: "", displayName: "神思管理员", role: "admin", status: "active", systemManaged: true, passwordHash: "", createdAt: Date.now(), updatedAt: Date.now(),
    };
    user.account = account;
    user.email = "";
    user.displayName = "神思管理员";
    user.role = "admin";
    user.status = "active";
    user.systemManaged = true;
    if (passwordHash) user.passwordHash = passwordHash;
    user.updatedAt = Date.now();
    if (!state.users.includes(user)) state.users.push(user);
    if (!state.memberships.some((entry) => entry.userId === user.id)) state.memberships.push({ id: createId("membership"), userId: user.id, tier: "admin", status: "active", units: 0, expiresAt: 0, updatedAt: Date.now() });
    ensureQuotaAccount(state, user.id);
  });
};

const normalizeBootstrapAccount = () => {
  return RESERVED_BOOTSTRAP_ADMIN_ACCOUNT;
};

const publicMembership = (membership) => membership ? ({
  tier: String(membership.tier || "free"),
  status: String(membership.status || "inactive"),
  units: Number(membership.units) || 0,
  expiresAt: Number(membership.expiresAt) || 0,
}) : ({ tier: "free", status: "inactive", units: 0, expiresAt: 0 });

const sessionCookie = (token, rememberMe = true) => `shensi_session=${encodeURIComponent(token)}; Max-Age=${rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`;

const staticAsset = async (response, path, contentType) => {
  const content = await readFile(path);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Type": contentType,
    "Content-Length": content.length,
  });
  response.end(content);
};

export const createCloudSkillApp = async ({ dataPath = defaultDataPath, signingKeyPath = defaultSigningKeyPath, publicBaseUrl = "", store: suppliedStore } = {}) => {
  const production = String(process.env.SHENSI_CLOUD_ENV || "development") === "production";
  const postgresUrl = String(process.env.SHENSI_CLOUD_DATABASE_URL || "").trim();
  const store = suppliedStore || (production && postgresUrl
    ? await createPostgresStore({ connectionString: postgresUrl, ssl: String(process.env.SHENSI_CLOUD_POSTGRES_SSL || "false") === "true" })
    : await new JsonStore(dataPath).init());
  const productionDependencies = production && !suppliedStore && postgresUrl
    ? await createProductionDependencies({ environment: process.env })
    : null;
  await bootstrapAdmin(store);
  const signingKey = await ensureSigningKey(signingKeyPath);
  const allowedOrigins = new Set(String(process.env.SHENSI_CLOUD_ALLOWED_ORIGINS || "https://hexing.studio,https://skill.hexing.studio,http://127.0.0.1:4280")
    .split(",").map((item) => item.trim()).filter(Boolean));
  const baseUrl = String(publicBaseUrl || process.env.SHENSI_CLOUD_PUBLIC_URL || "").replace(/\/$/u, "");
  let readinessCache = null;
  let readinessAt = 0;
  const readiness = async () => {
    if (!production) return { ready: true, postgres: true, redis: true, objectStorage: true, malwareScanner: true, artifactSigning: true };
    if (readinessCache && Date.now() - readinessAt < 10_000) return readinessCache;
    const details = productionDependencies
      ? await productionDependencies.health({ store, signingKey })
      : { postgres: false, redis: false, objectStorage: false, malwareScanner: false, artifactSigning: Boolean(signingKey.privateKeyPem && signingKey.publicKeyPem) };
    readinessCache = { ...details, ready: Object.values(details).every(Boolean) };
    readinessAt = Date.now();
    return readinessCache;
  };
  const requireProductionReady = async () => {
    const state = await readiness();
    if (!state.ready) fail("云端安全依赖尚未全部就绪，Skill 上传和发布已保持关闭", 503);
    return state;
  };
  const RETENTION = {
    unpublished: 15 * 24 * 60 * 60 * 1000,
    audit: 30 * 24 * 60 * 60 * 1000,
  };
  let cleanupFlight = null;
  const cleanupRetention = () => {
    if (cleanupFlight) return cleanupFlight;
    cleanupFlight = (async () => {
      const now = Date.now();
      const expiredObjects = store.state.skills.flatMap((skill) => (skill.versions || [])
        .filter((version) => skill.status === "unpublished" && Number(version.purgeAfter) > 0 && Number(version.purgeAfter) <= now && version.objectKey)
        .map((version) => version.objectKey));
      const removedObjects = new Set();
      if (productionDependencies) {
        for (const objectKey of expiredObjects) {
          if (await productionDependencies.objects.remove(objectKey).catch(() => false)) removedObjects.add(objectKey);
        }
      } else {
        for (const objectKey of expiredObjects) removedObjects.add(objectKey);
      }
      await store.transact((state) => {
        state.auditLogs = state.auditLogs.filter((entry) => Number(entry.createdAt) >= now - RETENTION.audit);
        for (const skill of state.skills) {
          for (const version of skill.versions || []) {
            if (!removedObjects.has(version.objectKey)) continue;
            version.objectKey = "";
            version.bytesBase64 = "";
            version.artifact = null;
            version.purgedAt = now;
          }
        }
      });
    })().finally(() => { cleanupFlight = null; });
    return cleanupFlight;
  };
  const cleanupTimer = setInterval(() => { void cleanupRetention().catch(() => {}); }, 60 * 60 * 1000);
  cleanupTimer.unref?.();

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
    const account = normalizeAccount(body.account || body.email);
    const email = account.includes("@") ? account : String(body.email || "").trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);
    const displayName = normalizeDisplayName(body.displayName);
    const recoveryContact = normalizeRecoveryContact(body.contact || body.email);
    const securityQuestion = normalizeSecurityQuestion(body.securityQuestion);
    const securityAnswerHash = await hashRecoveryAnswer(normalizeSecurityAnswer(body.securityAnswer));
    if (account === RESERVED_BOOTSTRAP_ADMIN_ACCOUNT) fail("该账号由神思后台管理固定使用，不能注册", 409);
    let user;
    await store.transact((state) => {
      if (state.users.some((entry) => (entry.account || entry.email) === account && entry.status !== "deleted")) fail("该账号已注册", 409);
      user = { id: createId("user"), account, email: recoveryContact.includes("@") ? recoveryContact : "", phone: recoveryContact.includes("@") ? "" : recoveryContact, recoveryContact, displayName, securityQuestion, securityAnswerHash, role: "user", status: "active", passwordHash, createdAt: Date.now(), updatedAt: Date.now() };
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
    const account = normalizeAccount(body.account || body.email);
    const user = store.state.users.find((entry) => (entry.account || entry.email) === account && entry.status === "active");
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) fail("邮箱或密码不正确", 401);
    const token = await issueSession(user.id, Boolean(body.rememberMe));
    return { user: publicUser(user), token };
  };

  const recoveryQuestion = async (body) => {
    const account = normalizeAccount(body.account || body.email);
    const user = store.state.users.find((entry) => (entry.account || entry.email) === account && entry.status !== "deleted");
    if (!user || user.role === "admin" || user.systemManaged === true) fail("账号不存在或不支持自助找回", 404);
    if (!user.securityQuestion) fail("该账号尚未设置密保问题，请联系管理员", 409);
    return { account: user.account || user.email, question: user.securityQuestion };
  };

  const recoverPassword = async (body) => {
    const account = normalizeAccount(body.account || body.email);
    const user = store.state.users.find((entry) => (entry.account || entry.email) === account && entry.status === "active");
    if (!user || user.role === "admin" || user.systemManaged === true || !user.securityAnswerHash) fail("账号或密保信息不正确", 400);
    const answer = normalizeSecurityAnswer(body.securityAnswer);
    if (!(await verifyRecoveryAnswer(answer, user.securityAnswerHash))) fail("账号或密保信息不正确", 400);
    const passwordHash = await hashPassword(body.newPassword);
    await store.transact((state) => {
      const target = state.users.find((entry) => entry.id === user.id);
      target.passwordHash = passwordHash;
      target.updatedAt = Date.now();
      for (const session of state.sessions.filter((entry) => entry.userId === user.id)) session.revokedAt = Date.now();
    });
    return { ok: true, message: "密码已重置，请使用新密码登录" };
  };

  const handle = async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const headers = corsHeaders(request, allowedOrigins);
    void cleanupRetention().catch(() => {});
    if (request.method === "OPTIONS") return json(response, 204, {}, { ...headers, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" });
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        const local = !production;
        const status = await readiness();
        return json(response, 200, {
          ok: true, connected: true, service: "shensi-skill-marketplace", version: "0.1.0", ready: status.ready,
          postgres: status.postgres,
          redis: status.redis,
          objectStorage: status.objectStorage,
          malwareScanner: status.malwareScanner,
          artifactSigning: status.artifactSigning, signedCatalog: true,
          production: !local,
          message: local ? "开发/测试存储已启用；生产部署前必须接入 PostgreSQL、Redis、OSS 和 ClamAV。" : (status.ready ? "生产服务依赖项已通过真实探针。" : "生产服务依赖项未全部通过真实探针，上传与发布保持关闭。"),
        }, headers);
      }
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return staticAsset(response, adminHtmlPath, "text/html; charset=utf-8");
      }
      if (url.pathname === "/admin/styles.css") {
        return staticAsset(response, adminCssPath, "text/css; charset=utf-8");
      }
      if (url.pathname === "/admin/app.js") {
        return staticAsset(response, adminJsPath, "text/javascript; charset=utf-8");
      }
      if (url.pathname === "/v1/client-config" && request.method === "GET") {
        return json(response, 200, {
          connected: true,
          marketplaceUrl: baseUrl || `${url.protocol}//${url.host}`,
          adminUrl: `${baseUrl || `${url.protocol}//${url.host}`}/admin`,
          publicKeyPem: signingKey.publicKeyPem,
          capabilities: {
            catalog: true,
            download: true,
            accountLogin: true,
            accountRegistration: true,
            adminConsole: true,
            publish: (await readiness()).ready,
          },
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
        const bytes = productionDependencies
          ? await productionDependencies.objects.read(found.versionRecord.objectKey)
          : Buffer.from(found.versionRecord.bytesBase64, "base64url");
        response.writeHead(200, { ...headers, "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/octet-stream", "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff" });
        return response.end(bytes);
      }
      if (url.pathname === "/v1/auth/register" && request.method === "POST") {
        const body = await bodyJson(request);
        const result = await register(body);
        return json(response, 201, result, { ...headers, "Set-Cookie": sessionCookie(result.token, Boolean(body.rememberMe)) });
      }
      if (url.pathname === "/v1/auth/recovery-question" && request.method === "POST") {
        const body = await bodyJson(request);
        return json(response, 200, await recoveryQuestion(body), headers);
      }
      if (url.pathname === "/v1/auth/recover" && request.method === "POST") {
        const body = await bodyJson(request);
        return json(response, 200, await recoverPassword(body), headers);
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
        let submission;
        if (production) {
          await requireProductionReady();
          if (!productionDependencies) fail("生产上传服务未配置真实存储、Redis 和 ClamAV", 503);
          await productionDependencies.redis.limit(owner.id, { maximum: 10, windowSeconds: 60 });
          const staticScan = scanSkillPackage(bytes);
          const malwareScan = staticScan.status === "passed"
            ? await productionDependencies.scanner.scan(bytes)
            : { status: "blocked", findings: [], scanner: "clamav-skipped", detail: "静态安全规则已拒绝该上传" };
          const scan = {
            status: staticScan.status === "passed" && malwareScan.status === "passed" ? "passed" : "blocked",
            findings: [...new Set([...(staticScan.findings || []), ...(malwareScan.findings || [])])],
            scanner: "static-v1+clamav",
          };
          submission = prepareSkillSubmission({ body, bytes, owner, scanOverride: scan, objectKey: "" });
          submission.versions[0].bytesBase64 = "";
          if (scan.status === "passed") {
            submission.versions[0].objectKey = await productionDependencies.objects.stage({
              skillId: submission.skillId,
              version: submission.versions[0].version,
              bytes,
            });
          } else {
            submission.status = "rejected";
            submission.versions[0].objectKey = "";
            submission.rejectedAt = Date.now();
          }
        } else {
          submission = prepareSkillSubmission({ body, bytes, owner });
        }
        try {
          await store.transact((state) => state.skills.push(submission));
        } catch (error) {
          if (production && submission.versions[0]?.objectKey) await productionDependencies.objects.remove(submission.versions[0].objectKey).catch(() => {});
          throw error;
        }
        await audit({ actorUserId: owner.id, action: "skill.upload", targetType: "skill", targetId: submission.id, detail: { skillId: submission.skillId, status: submission.status } });
        return json(response, 201, { skill: publicSkill(submission), scan: submission.scan, message: submission.status === "rejected" || submission.status === "quarantined" ? "上传未通过安全检查，临时文件已清理" : "上传成功，等待管理员审核" }, headers);
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
          if (production) await requireProductionReady();
          const body = await bodyJson(request);
          const decision = String(body.decision || "");
          if (!["approve", "reject"].includes(decision)) fail("审核决定无效");
          if (decision === "approve" && skill.scan.status !== "passed") fail("自动检查未通过，不能发布", 409);
          const versionRecord = skill.versions.at(-1);
          if (decision === "approve") {
            const stagedKey = versionRecord.objectKey;
            let publishedKey = stagedKey;
            if (production) {
              if (!stagedKey.startsWith("quarantine/")) fail("Skill 隔离制品不存在，不能发布", 409);
              publishedKey = await productionDependencies.objects.publish({ skillId: skill.skillId, version: versionRecord.version, sha256: versionRecord.sha256, objectKey: stagedKey });
            }
            try {
              const artifact = await artifactFromSkill({ skill: { ...skill, publisherRole: "user" }, versionRecord: { ...versionRecord, objectKey: publishedKey }, signingKey });
              await store.transact((state) => {
                const target = state.skills.find((entry) => entry.id === skill.id);
                target.status = "published";
                target.updatedAt = Date.now();
                target.review = { decision, reason: String(body.reason || "").slice(0, 500), reviewerUserId: actor.id, reviewedAt: Date.now() };
                target.versions.at(-1).publishedAt = Date.now();
                target.versions.at(-1).purgeAfter = 0;
                target.versions.at(-1).objectKey = publishedKey;
                target.versions.at(-1).artifact = artifact;
              });
              if (production && stagedKey !== publishedKey) await productionDependencies.objects.remove(stagedKey).catch(() => {});
            } catch (error) {
              if (production && publishedKey !== stagedKey) await productionDependencies.objects.remove(publishedKey).catch(() => {});
              throw error;
            }
          } else {
            if (production && skill.versions.at(-1)?.objectKey) await productionDependencies.objects.remove(skill.versions.at(-1).objectKey);
            await store.transact((state) => { const target = state.skills.find((entry) => entry.id === skill.id); target.status = "rejected"; target.updatedAt = Date.now(); target.rejectedAt = Date.now(); target.review = { decision, reason: String(body.reason || "").slice(0, 500), reviewerUserId: actor.id, reviewedAt: Date.now() }; target.versions.at(-1).objectKey = ""; target.versions.at(-1).bytesBase64 = ""; });
          }
          await audit({ actorUserId: actor.id, action: `skill.${decision}`, targetType: "skill", targetId: skill.id, detail: { reason: String(body.reason || "").slice(0, 500) } });
          return json(response, 200, { skill: publicSkill(store.state.skills.find((entry) => entry.id === skill.id)) }, headers);
        }
        if (segments[4] === "unpublish" && request.method === "POST") {
          if (production) await requireProductionReady();
          await store.transact((state) => { const target = state.skills.find((entry) => entry.id === skill.id); target.status = "unpublished"; target.updatedAt = Date.now(); for (const version of target.versions || []) version.purgeAfter = Date.now() + RETENTION.unpublished; });
          await audit({ actorUserId: actor.id, action: "skill.unpublish", targetType: "skill", targetId: skill.id });
          return json(response, 200, { ok: true }, headers);
        }
        return json(response, 404, { ok: false, message: "管理员 Skill 操作不存在" }, headers);
      }
      if (segments[0] === "v1" && segments[1] === "admin" && segments[2] === "skills" && segments[3] && request.method === "DELETE") {
        const actor = requireAdmin(request);
        const index = store.state.skills.findIndex((entry) => entry.id === segments[3] || entry.skillId === segments[3]);
        if (index < 0) return json(response, 404, { ok: false, message: "Skill 不存在" }, headers);
        if (production) {
          await requireProductionReady();
          for (const version of store.state.skills[index].versions || []) if (version.objectKey) await productionDependencies.objects.remove(version.objectKey);
        }
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
        const targetUser = store.state.users.find((entry) => entry.id === segments[3]);
        if (!targetUser) fail("目标用户不存在", 404);
        if (targetUser.systemManaged === true || targetUser.account === RESERVED_BOOTSTRAP_ADMIN_ACCOUNT) fail("神思后台管理固定账号不可停用或修改", 403);
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
  return { store, signingKey, handler: handle, close: () => clearInterval(cleanupTimer) };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createCloudSkillApp();
  const host = process.env.SHENSI_CLOUD_HOST || "127.0.0.1";
  const port = Number(process.env.SHENSI_CLOUD_PORT || 4280);
  createServer(app.handler).listen(port, host, () => console.log(`神思云端 Skill 广场运行于 http://${host}:${port}`));
}
