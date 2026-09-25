import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { createCloudSkillApp } from "../cloud-skill-platform/server.mjs";
import { createMemoryStore } from "../cloud-skill-platform/lib/store.mjs";

const previous = {
  env: process.env.SHENSI_CLOUD_ENV,
  password: process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD,
};
process.env.SHENSI_CLOUD_ENV = "production";
process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD = "test-admin-password-824657913";
const signingKeyPath = `${process.cwd()}/.cloud-production-gate-${Date.now()}.json`;
const app = await createCloudSkillApp({
  store: await createMemoryStore(),
  signingKeyPath,
});
const server = createServer(app.handler).listen(0);
try {
  const port = server.address().port;
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ready, false);
  assert.equal(health.postgres, false);
  assert.equal(health.redis, false);
  assert.equal(health.objectStorage, false);
  assert.equal(health.malwareScanner, false);
  const config = await (await fetch(`http://127.0.0.1:${port}/v1/client-config`)).json();
  assert.equal(config.capabilities.publish, false);
  console.log("Cloud production dependency gate fails closed when adapters are unavailable");
} finally {
  server.close();
  app.close();
  await rm(signingKeyPath, { force: true });
  if (previous.env === undefined) delete process.env.SHENSI_CLOUD_ENV; else process.env.SHENSI_CLOUD_ENV = previous.env;
  if (previous.password === undefined) delete process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD; else process.env.SHENSI_CLOUD_BOOTSTRAP_ADMIN_PASSWORD = previous.password;
}
