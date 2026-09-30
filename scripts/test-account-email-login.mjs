import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudSkillApp } from '../cloud-skill-platform/server.mjs';
import { JsonStore } from '../cloud-skill-platform/lib/store.mjs';
import { normalizeLoginEmail, emailClientIp } from '../cloud-skill-platform/lib/email-auth.mjs';
import { createEmailAuth } from '../cloud-skill-platform/lib/email-auth.mjs';

// Isolated test delivery only. No real mailbox, SMTP server or user state.
process.env.SHENSI_CLOUD_ENV = 'test';
const root = await mkdtemp(join(tmpdir(), 'shensi-email-login-'));
let clock = Date.now();
let deliveryFails = false;
let deliveryGate;
const mailbox = [];
const store = await new JsonStore(join(root, 'state.json')).init();
const environment = {
  SHENSI_CLOUD_EMAIL_LOGIN_ENABLED: 'true',
  SHENSI_CLOUD_EMAIL_CODE_SECRET: 'isolated-test-secret-not-for-production-123456789',
  SHENSI_CLOUD_EMAIL_DAILY_LIMIT: '200',
};
const options = { store, signingKeyPath: join(root, 'signing.json'), emailOptions: {
  environment, now: () => clock,
  delivery: { configured: true, send: async (message) => {
    if (deliveryGate) await deliveryGate;
    if (deliveryFails) throw new Error('SMTP secret must never reach client');
    mailbox.push(message);
  } },
} };
let app = await createCloudSkillApp(options);
const server = createServer((request, response) => app.handler(request, response));
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
let checks = 0;
const call = async (path, { body, token = '', status = 200, headers = {} } = {}) => {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
  const payload = await response.json();
  assert.equal(response.status, status, path + ': ' + JSON.stringify(payload)); checks++;
  return payload;
};
const send = (email, extra = {}) => call('/v1/auth/email-code', { body: { email, purpose: 'login' }, ...extra });
const codeFor = (email) => mailbox.findLast((item) => item.to === email)?.code;
const verify = (email, challenge, extra = {}) => call('/v1/auth/email-login', {
  body: { email, challengeId: challenge.challengeId, code: codeFor(email), rememberMe: false }, ...extra,
});
const register = (account, email) => call('/v1/auth/register', { status: 201, body: {
  account, contact: email, password: 'isolated-password-123', displayName: '测试', securityQuestion: '测试密保问题', securityAnswer: '测试答案',
} });
try {
  assert.equal(normalizeLoginEmail('  READER+test@Example.test '), 'reader+test@example.test');
  for (const unsafe of ['x@example.test,y@example.test', 'a@b.test\r\nBcc:x@y.test', 'Name <a@b.test>', 'a..b@example.test']) assert.throws(() => normalizeLoginEmail(unsafe));
  assert.equal(emailClientIp({ socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-real-ip': '1.1.1.1' } }, { SHENSI_CLOUD_TRUSTED_PROXY_IPS: '127.0.0.1' }), '8.8.8.8');
  assert.equal(emailClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '1.1.1.1' } }, { SHENSI_CLOUD_TRUSTED_PROXY_IPS: '127.0.0.1' }), '1.1.1.1');
  const configuration = await call('/v1/auth/email-config'); assert.equal(configuration.enabled, true);
  const defaultLimit = createEmailAuth({ store, environment: { ...environment, SHENSI_CLOUD_EMAIL_DAILY_LIMIT: undefined }, delivery: options.emailOptions.delivery });
  assert.equal(defaultLimit.config().dailySendLimit, 1000); defaultLimit.close();
  const challenge = await send('reader@example.test');
  assert.equal(challenge.expiresInSeconds, 300); assert.equal(challenge.retryAfterSeconds, 60);
  assert.match(codeFor('reader@example.test'), /^\d{6}$/);
  assert.equal(challenge.code, undefined);
  const record = store.state.emailChallenges.find((row) => row.id === challenge.challengeId);
  assert.equal(record.code, undefined); assert.equal(record.digest.length, 64);
  await send('reader@example.test', { status: 429 });
  const logged = await verify('reader@example.test', challenge);
  assert.ok(logged.token); assert.ok(logged.user.emailVerifiedAt > 0); assert.equal(logged.user.role, 'user');
  assert.equal(store.state.quotaAccounts.find((row) => row.userId === logged.user.id).available, 0);
  await verify('reader@example.test', challenge, { status: 400 });
  await call('/v1/auth/me', { token: logged.token });

  // An unverified legacy contact must not become a login or merge target.
  const legacy = await register('legacy-account', 'legacy@example.test');
  const legacyChallenge = await send('legacy@example.test');
  const blocked = await verify('legacy@example.test', legacyChallenge, { status: 409 });
  assert.equal(blocked.code, 'EMAIL_BIND_REQUIRED');
  await call('/v1/auth/email-code', { body: { email: 'legacy@example.test', purpose: 'bind' }, status: 401 });
  clock += 61_000;
  const binding = await call('/v1/auth/email-code', { token: legacy.token, body: { email: 'legacy@example.test', purpose: 'bind' } });
  await verify('legacy@example.test', binding, { status: 400 }); // cannot use binding code as login
  const stranger = await register('stranger-account', 'stranger@example.test');
  await call('/v1/account/email-bind', { token: stranger.token, status: 400, body: { email: 'legacy@example.test', challengeId: binding.challengeId, code: codeFor('legacy@example.test') } });
  const bound = await call('/v1/account/email-bind', { token: legacy.token, body: { email: 'legacy@example.test', challengeId: binding.challengeId, code: codeFor('legacy@example.test') } });
  assert.equal(bound.user.id, legacy.user.id); assert.ok(bound.user.emailVerifiedAt);
  clock += 61_000;
  const oldLogin = await send('legacy@example.test');
  assert.equal((await verify('legacy@example.test', oldLogin)).user.id, legacy.user.id);
  await call('/v1/auth/login', { body: { account: 'legacy-account', password: 'isolated-password-123' } });
  await call('/v1/auth/email-code', { token: stranger.token, status: 409, body: { email: 'legacy@example.test', purpose: 'bind' } });
  await call('/v1/auth/email-code', { token: legacy.token, status: 409, body: { email: 'replacement@example.test', purpose: 'bind' } });

  const wrong = await send('wrong@example.test');
  const wrongCode = codeFor('wrong@example.test') === '000000' ? '000001' : '000000';
  for (let n = 0; n < 5; n++) await verify('wrong@example.test', wrong, { status: 400, body: { email: 'wrong@example.test', challengeId: wrong.challengeId, code: wrongCode } });
  await verify('wrong@example.test', wrong, { status: 400 });
  const expired = await send('expired@example.test'); clock += 301_000;
  await verify('expired@example.test', expired, { status: 400 });

  const concurrent = await send('concurrent@example.test');
  const consume = () => fetch(base + '/v1/auth/email-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'concurrent@example.test', challengeId: concurrent.challengeId, code: codeFor('concurrent@example.test') }) });
  const statuses = (await Promise.all([consume(), consume()])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 400]);
  assert.equal(store.state.users.filter((row) => row.email === 'concurrent@example.test').length, 1);

  const beforeRestart = await send('restart@example.test');
  app.close(); const reloaded = await new JsonStore(join(root, 'state.json')).init();
  app = await createCloudSkillApp({ ...options, store: reloaded });
  await send('restart@example.test', { status: 429 });
  await verify('restart@example.test', beforeRestart);
  clock += 61_000;
  const replaced = await send('replace@example.test'); const oldCode = codeFor('replace@example.test'); clock += 61_000;
  const replacement = await send('replace@example.test');
  await verify('replace@example.test', replaced, { status: 400, body: { email: 'replace@example.test', challengeId: replaced.challengeId, code: oldCode } });
  await verify('replace@example.test', replacement);

  deliveryFails = true;
  const failed = await send('failed@example.test', { status: 503 });
  assert.doesNotMatch(JSON.stringify(failed), /SMTP secret|isolated-test-secret/);
  deliveryFails = false;
  await send('bad@example.test,other@example.test', { status: 400 });
  await call('/v1/auth/email-code', { status: 400, body: { email: 'p@example.test', purpose: 'admin' } });

  let release; deliveryGate = new Promise((done) => { release = done; });
  const before = mailbox.length;
  const inFlight = send('racing@example.test');
  // The concurrent request must not send another email while delivery is pending.
  await new Promise((done) => setTimeout(done, 20));
  await send('racing@example.test', { status: 429 });
  release(); deliveryGate = null; await inFlight;
  assert.equal(mailbox.length, before + 1);

  clock += 24 * 60 * 60 * 1000;
  environment.SHENSI_CLOUD_EMAIL_DAILY_LIMIT = '2'; app.close();
  app = await createCloudSkillApp({ ...options, store: reloaded });
  deliveryFails = true; await send('limit1@example.test', { status: 503 }); deliveryFails = false;
  await send('limit2@example.test'); // failed send also consumes the daily budget
  const capped = await send('limit3@example.test', { status: 429, headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9' } });
  assert.equal(capped.code, 'EMAIL_DAILY_LIMIT'); assert.match(capped.message, /今日/);
  app.close(); app = await createCloudSkillApp({ ...options, store: reloaded });
  await send('after-restart-limit@example.test', { status: 429 });
  await call('/v1/auth/login', { body: { account: 'legacy-account', password: 'isolated-password-123' } });
  clock = (Math.floor((clock + 8 * 3600000) / 86400000) + 1) * 86400000 - 8 * 3600000 + 1;
  await send('next-day-limit@example.test'); // resets only at midnight Asia/Shanghai

  app.close(); app = await createCloudSkillApp({ store: reloaded, signingKeyPath: join(root, 'signing.json'), emailOptions: { environment: {} } });
  assert.equal((await call('/v1/auth/email-config')).enabled, false);
  await send('disabled@example.test', { status: 503 });
  await call('/v1/auth/login', { body: { account: 'legacy-account', password: 'isolated-password-123' } });
  console.log('Email login: ' + checks + ' isolated HTTP checks PASS; zero real email deliveries.');
} finally {
  app.close(); server.closeAllConnections(); await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
