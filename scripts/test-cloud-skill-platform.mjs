import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { createCloudSkillApp } from "../cloud-skill-platform/server.mjs";
import { createMemoryStore } from "../cloud-skill-platform/lib/store.mjs";

process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD = "test-admin-password-824657913";
const store = await createMemoryStore();
const signingKeyPath = `${process.cwd()}/.cloud-signing-test-${Date.now()}.json`;
const app = await createCloudSkillApp({ store, signingKeyPath, publicBaseUrl: "" });
const server = createServer(app.handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const call = async (path, { method = "GET", token = "", body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
};

try {
  const adminPage = await fetch(`${base}/admin`);
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /神思后台管理/u);
  const adminScript = await fetch(`${base}/admin/app.js`);
  assert.equal(adminScript.status, 200);
  assert.match(await adminScript.text(), /v1\/admin\/skills/u);

  const health = await call("/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.connected, true);
  const clientConfig = await call("/v1/client-config");
  assert.equal(clientConfig.response.status, 200);
  assert.equal(clientConfig.payload.capabilities.accountLogin, true);
  assert.match(clientConfig.payload.adminUrl, /\/admin$/u);

  const unauthenticatedUpload = await call("/v1/skills/uploads", { method: "POST", body: { source: "---\nid: demo.skill\n---\n# Demo" } });
  assert.equal(unauthenticatedUpload.response.status, 401);

  const reservedAdminRegistration = await call("/v1/auth/register", { method: "POST", body: { account: "798998264", contact: "admin-recovery@example.com", password: "another password", securityQuestion: "不能注册的问题？", securityAnswer: "不能注册" } });
  assert.equal(reservedAdminRegistration.response.status, 409);
  const fixedAdminLogin = await call("/v1/auth/login", { method: "POST", body: { account: "798998264", password: "test-admin-password-824657913", rememberMe: true } });
  assert.equal(fixedAdminLogin.response.status, 200);
  assert.equal(fixedAdminLogin.payload.user.role, "admin");

  const registered = await call("/v1/auth/register", { method: "POST", body: { account: "test-user", contact: "user@example.com", password: "correct horse battery staple", displayName: "测试上传者", securityQuestion: "测试问题是什么？", securityAnswer: "测试答案", rememberMe: true } });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.payload.user.displayName, "测试上传者");
  assert.ok(registered.payload.token);
  const recoveryQuestion = await call("/v1/auth/recovery-question", { method: "POST", body: { account: "test-user" } });
  assert.equal(recoveryQuestion.response.status, 200);
  assert.equal(recoveryQuestion.payload.question, "测试问题是什么？");
  const recovered = await call("/v1/auth/recover", { method: "POST", body: { account: "test-user", securityAnswer: "测试答案", newPassword: "new correct horse battery staple" } });
  assert.equal(recovered.response.status, 200);
  const oldPasswordLogin = await call("/v1/auth/login", { method: "POST", body: { account: "test-user", password: "correct horse battery staple" } });
  assert.equal(oldPasswordLogin.response.status, 401);
  const recoveredLogin = await call("/v1/auth/login", { method: "POST", body: { account: "test-user", password: "new correct horse battery staple" } });
  assert.equal(recoveredLogin.response.status, 200);

  const uploaded = await call("/v1/skills/uploads", { method: "POST", token: recoveredLogin.payload.token, body: { source: "---\nid: demo.skill\nname: Demo Skill\nversion: 1.0.0\n---\n# Demo", skillId: "demo.skill", version: "1.0.0" } });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.payload.skill.author, "测试上传者");
  assert.equal(uploaded.payload.skill.status, "pending_review");

  const beforeReview = await call("/v1/catalog");
  assert.equal(beforeReview.payload.items.length, 0);

  const adminRegistration = await call("/v1/auth/register", { method: "POST", body: { email: "admin@example.com", password: "admin password 123", displayName: "管理员", securityQuestion: "管理员测试问题？", securityAnswer: "管理员答案" } });
  assert.equal(adminRegistration.response.status, 201);
  const adminUser = store.state.users.find((entry) => entry.email === "admin@example.com");
  await store.transact((state) => { state.users.find((entry) => entry.id === adminUser.id).role = "admin"; });

  const reviewed = await call(`/v1/admin/skills/${uploaded.payload.skill.id}/review`, { method: "POST", token: adminRegistration.payload.token, body: { decision: "approve" } });
  assert.equal(reviewed.response.status, 200);
  const catalog = await call("/v1/catalog");
  assert.equal(catalog.payload.items.length, 1);
  assert.equal(catalog.payload.items[0].author, "测试上传者");

  process.env.SHENSI_MARKETPLACE_URL = base;
  process.env.SHENSI_MARKETPLACE_PUBLIC_KEY_PEM = app.signingKey.publicKeyPem;
  const { readRemoteMarketplace } = await import("../src/server/marketplace-client.mjs");
  const remote = await readRemoteMarketplace({ force: true });
  assert.equal(remote.connected, true);
  assert.equal(remote.remoteItems[0].author, "测试上传者");
  assert.equal(remote.capabilities.download, true);
  assert.match(remote.adminUrl, /\/admin$/u);

  const artifactId = catalog.payload.items[0].artifactId;
  const version = catalog.payload.items[0].version;
  const descriptor = await call(`/v1/artifacts/${encodeURIComponent(artifactId)}/${encodeURIComponent(version)}/download`);
  assert.equal(descriptor.response.status, 200);
  assert.ok(descriptor.payload.artifact.signature.signature);
  const contentResponse = await fetch(`${base}${new URL(descriptor.payload.downloadUrl).pathname}`);
  assert.equal(contentResponse.status, 200);
  assert.match(await contentResponse.text(), /Demo Skill/u);

  const forbiddenQuota = await call("/v1/admin/quota/adjust", { method: "POST", token: recoveredLogin.payload.token, body: { userId: adminUser.id, amount: 100 } });
  assert.equal(forbiddenQuota.response.status, 403);
  const quota = await call("/v1/admin/quota/adjust", { method: "POST", token: adminRegistration.payload.token, body: { userId: adminUser.id, amount: 100, reason: "测试赠送" } });
  assert.equal(quota.response.status, 200);
  assert.equal(quota.payload.available, 100);
  const membership = await call("/v1/admin/memberships", { method: "POST", token: adminRegistration.payload.token, body: { userId: store.state.users.find((entry) => entry.account === "test-user").id, tier: "vip", units: 500 } });
  assert.equal(membership.response.status, 200);
  assert.equal(membership.payload.membership.tier, "vip");
  assert.equal(membership.payload.quota.available, 500);
  const userQuota = await call("/v1/quota", { token: recoveredLogin.payload.token });
  assert.equal(userQuota.payload.available, 500);
  const reserved = await call("/v1/ai/text/reserve", { method: "POST", token: recoveredLogin.payload.token, body: { amount: 120, idempotencyKey: "request-1" } });
  assert.equal(reserved.response.status, 200);
  assert.equal(reserved.payload.available, 380);
  const reservedAgain = await call("/v1/ai/text/reserve", { method: "POST", token: recoveredLogin.payload.token, body: { amount: 120, idempotencyKey: "request-1" } });
  assert.equal(reservedAgain.payload.reservationId, reserved.payload.reservationId);
  const settled = await call("/v1/ai/text/settle", { method: "POST", token: recoveredLogin.payload.token, body: { reservationId: reserved.payload.reservationId, usedAmount: 75 } });
  assert.equal(settled.payload.available, 425);
  const auditLogs = await call("/v1/admin/audit-logs", { token: adminRegistration.payload.token });
  assert.ok(auditLogs.payload.items.some((entry) => entry.action === "membership.update"));

  console.log("cloud skill platform contract: PASS");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(store.filePath, { force: true }).catch(() => {});
  await rm(signingKeyPath, { force: true }).catch(() => {});
}
