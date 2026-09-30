import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createId, createOpaqueToken, hashToken, publicUser } from './security.mjs';
import { ensureQuotaAccount } from './quota.mjs';
import { createEmailDelivery } from './email-delivery.mjs';

const TTL = 300_000;
const RESEND = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INVALID = { statusCode: 400, code: 'EMAIL_CODE_INVALID', message: '验证码无效、已使用或已过期，请重新获取' };
const unavailable = () => ({ statusCode: 503, code: 'EMAIL_UNAVAILABLE', message: '邮箱验证码服务尚未配置，请先使用密码登录' });
const raise = (error) => { throw Object.assign(new Error(error.message), error); };
const normalUser = (user) => user && user.role === 'user' && user.status === 'active' && !user.systemManaged;

export const normalizeLoginEmail = (value) => {
  const email = String(value ?? '').trim().toLowerCase();
  const parts = email.split('@');
  const local = parts[0] || '';
  const domain = parts[1] || '';
  if (email.length > 254 || parts.length !== 2 || local.length > 64 || !local
    || !/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+$/u.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !domain.includes('.') || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    raise({ statusCode: 400, code: 'EMAIL_INVALID', message: '请输入有效的邮箱地址（只支持单个收件人）' });
  }
  return email;
};

const normalizeIp = (value) => String(value || '').replace(/^::ffff:/u, '');
export const emailClientIp = (request, environment = process.env) => {
  const remote = normalizeIp(request.socket?.remoteAddress);
  const trusted = String(environment.SHENSI_CLOUD_TRUSTED_PROXY_IPS || '').split(',').map((ip) => normalizeIp(ip.trim())).filter(Boolean);
  const forwarded = normalizeIp(request.headers['x-real-ip']);
  // Only a configured reverse proxy may supply X-Real-IP. Never trust client XFF.
  return trusted.includes(remote) && isIP(forwarded) ? forwarded : (isIP(remote) ? remote : 'unknown');
};

const equalDigest = (actual, expected) => {
  const a = Buffer.from(String(actual), 'hex'); const b = Buffer.from(String(expected), 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
};

export const createEmailAuth = ({ store, environment = process.env, delivery = createEmailDelivery(environment), now = Date.now } = {}) => {
  const secret = String(environment.SHENSI_CLOUD_EMAIL_CODE_SECRET || '');
  const enabled = environment.SHENSI_CLOUD_EMAIL_LOGIN_ENABLED === 'true'
    && secret.length >= 32 && delivery.configured === true
    && (environment.SHENSI_CLOUD_ENV !== 'production' || Boolean(environment.SHENSI_CLOUD_DATABASE_URL));
  const dailyLimit = Math.max(1, Math.min(100_000, Number(environment.SHENSI_CLOUD_EMAIL_DAILY_LIMIT) || 1000));
  const digest = (parts) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
  const config = () => ({ enabled, expiresInSeconds: TTL / 1000, retryAfterSeconds: RESEND / 1000, dailySendLimit: dailyLimit,
    message: enabled ? '验证码由神思发出，5 分钟内有效' : unavailable().message });
  const prune = (state, time) => {
    state.emailChallenges = (state.emailChallenges || []).filter((entry) => entry.expiresAt > time);
    state.emailRateLimits = (state.emailRateLimits || []).filter((entry) => entry.resetAt > time);
  };
  const limit = (state, rules, time) => {
    const buckets = rules.map(([scope, value, maximum, windowMs]) => {
      const key = digest(['limit', scope, value]);
      return { key, scope, maximum, windowMs, existing: state.emailRateLimits.find((entry) => entry.key === key) };
    });
    const blocked = buckets.find(({ existing, maximum }) => existing?.count >= maximum);
    if (blocked) return { statusCode: 429, code: blocked.scope === 'send-site-day' ? 'EMAIL_DAILY_LIMIT' : 'EMAIL_RATE_LIMIT',
      retryAfterSeconds: Math.max(1, Math.ceil((blocked.existing.resetAt - time) / 1000)),
      message: blocked.scope === 'send-site-day' ? '今日验证码邮件额度已用完，请明天再试或使用密码登录' : '验证码操作过于频繁，请稍后再试' };
    for (const bucket of buckets) {
      if (bucket.existing) bucket.existing.count++;
      else state.emailRateLimits.push({ key: bucket.key, count: 1, resetAt: time + bucket.windowMs });
    }
    return null;
  };
  const boundOwner = (state, email) => state.users.find((user) => user.emailVerifiedAt > 0 && String(user.email).toLowerCase() === email);
  const checkBinding = (state, userId, email) => {
    const user = state.users.find((entry) => entry.id === userId);
    if (!normalUser(user)) return { statusCode: 403, code: 'EMAIL_BIND_DENIED', message: '当前账户不支持邮箱绑定' };
    const owner = boundOwner(state, email);
    if (owner && owner.id !== user.id) return { statusCode: 409, code: 'EMAIL_ALREADY_BOUND', message: '该邮箱无法绑定到此账号，请使用其他邮箱' };
    if (user.emailVerifiedAt > 0) return { statusCode: 409, code: 'EMAIL_ALREADY_VERIFIED', message: '当前账号已绑定验证邮箱；更换邮箱请联系管理员' };
    return null;
  };
  const sendCode = async ({ email: rawEmail, purpose = 'login', userId = '', ip = '' }) => {
    if (!enabled) raise(unavailable());
    const email = normalizeLoginEmail(rawEmail);
    if (!['login', 'bind'].includes(purpose)) raise({ statusCode: 400, code: 'EMAIL_PURPOSE_INVALID', message: '验证码用途无效' });
    if (purpose === 'bind' && !userId) raise({ statusCode: 401, message: '请先用密码登录再验证绑定邮箱' });
    const targetUserId = purpose === 'bind' ? userId : '';
    const id = createId('emailcode');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const time = now();
    // Site budget resets at midnight Asia/Shanghai, not on service restart.
    const dayRemaining = DAY - ((time + 8 * HOUR) % DAY);
    const reserved = await store.transact((state) => {
      prune(state, time);
      if (purpose === 'bind') { const error = checkBinding(state, userId, email); if (error) return { error }; }
      if (state.emailChallenges.filter((entry) => entry.status === 'sending').length >= 3) return { error: { statusCode: 429, code: 'EMAIL_BUSY', retryAfterSeconds: 15, message: '发信服务繁忙，请稍后再试' } };
      const error = limit(state, [
        ['send-cooldown', email, 1, RESEND], ['send-email-hour', email, 5, HOUR],
        ['send-email-day', email, 10, DAY], ['send-ip-hour', ip, 20, HOUR],
        ['send-ip-day', ip, 100, DAY], ['send-site-day', 'all', dailyLimit, dayRemaining],
      ], time);
      if (error) return { error };
      for (const previous of state.emailChallenges.filter((row) => row.email === email && row.purpose === purpose && row.userId === targetUserId)) {
        previous.status = 'replaced'; previous.digest = '';
      }
      state.emailChallenges.push({ id, email, purpose, userId: targetUserId, status: 'sending', attempts: 0,
        digest: digest([id, email, purpose, targetUserId, code]), createdAt: time, expiresAt: time + TTL });
      return { ok: true };
    });
    if (reserved.error) raise(reserved.error);
    let timer; const abort = new AbortController();
    try {
      await Promise.race([
        delivery.send({ to: email, code, purpose, signal: abort.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('发送超时')); }, 12_000); timer.unref?.(); }),
      ]);
      await store.transact((state) => {
        const challenge = state.emailChallenges.find((row) => row.id === id);
        if (challenge?.status === 'sending') challenge.status = 'sent';
      });
    } catch {
      await store.transact((state) => {
        const challenge = state.emailChallenges.find((row) => row.id === id);
        if (challenge) { challenge.status = 'failed'; challenge.digest = ''; }
      });
      raise({ statusCode: 503, code: 'EMAIL_SEND_FAILED', message: '验证码暂未发送成功，请稍后再试；也可以使用密码登录' });
    } finally { clearTimeout(timer); }
    return { ok: true, challengeId: id, expiresInSeconds: TTL / 1000, retryAfterSeconds: RESEND / 1000,
      message: '验证码邮件已提交发送，请检查收件箱或垃圾邮件' };
  };

  const verify = async ({ email: rawEmail, challengeId, code, purpose = 'login', userId = '', ip = '', rememberMe = false }) => {
    if (!enabled) raise(unavailable());
    const email = normalizeLoginEmail(rawEmail);
    const targetUserId = purpose === 'bind' ? userId : '';
    if (!['login', 'bind'].includes(purpose) || typeof challengeId !== 'string' || challengeId.length > 100
      || typeof code !== 'string' || !/^\d{6}$/u.test(code)) raise(INVALID);
    const time = now();
    const result = await store.transact((state) => {
      prune(state, time);
      const throttled = limit(state, [['verify-ip', ip, 50, 10 * 60_000], ['verify-email', email, 20, 10 * 60_000]], time);
      if (throttled) return { error: throttled };
      const challenge = state.emailChallenges.find((row) => row.id === challengeId
        && row.email === email && row.purpose === purpose && row.userId === targetUserId);
      if (!challenge || challenge.status !== 'sent' || challenge.attempts >= 5 || challenge.expiresAt <= time) return { error: INVALID };
      if (!equalDigest(digest([challenge.id, email, purpose, targetUserId, code]), challenge.digest)) {
        challenge.attempts++;
        if (challenge.attempts >= 5) { challenge.status = 'locked'; challenge.digest = ''; }
        // Return, do not throw: failed-attempt counters must commit too.
        return { error: INVALID };
      }
      challenge.status = 'used'; challenge.digest = ''; challenge.usedAt = time;
      if (purpose === 'bind') {
        const error = checkBinding(state, userId, email);
        if (error) return { error };
        const user = state.users.find((row) => row.id === userId);
        user.email = email; user.emailVerifiedAt = time; user.updatedAt = time;
        state.auditLogs.push({ id: createId('audit'), actorUserId: user.id, action: 'account.email_verified', targetType: 'user', targetId: user.id, detail: {}, createdAt: time });
        return { ok: true, user: publicUser(user) };
      }
      let user = boundOwner(state, email);
      if (!user) {
        const legacy = state.users.some((row) => [row.email, row.account, row.recoveryContact].some((field) => String(field || '').trim().toLowerCase() === email));
        if (legacy) return { error: { statusCode: 409, code: 'EMAIL_BIND_REQUIRED', message: '该邮箱关联的旧账号尚未验证，请先用密码登录，再在个人资料中验证绑定邮箱；不会自动合并账号' } };
        user = { id: createId('user'), account: createId('emailuser'), email, emailVerifiedAt: time, displayName: '神思用户',
          avatar: '', role: 'user', status: 'active', passwordHash: '', createdAt: time, updatedAt: time };
        state.users.push(user);
        state.memberships.push({ id: createId('membership'), userId: user.id, tier: 'free', status: 'active', units: 0, expiresAt: 0, updatedAt: time });
        ensureQuotaAccount(state, user.id);
      }
      if (!normalUser(user)) return { error: { statusCode: 403, code: 'EMAIL_LOGIN_DENIED', message: '该账号不能使用邮箱验证码登录，请使用原登录方式或联系管理员' } };
      const token = createOpaqueToken();
      state.sessions.push({ id: createId('session'), userId: user.id, tokenHash: hashToken(token),
        expiresAt: time + (rememberMe === true ? 30 : 1) * DAY, createdAt: time, revokedAt: 0 });
      state.auditLogs.push({ id: createId('audit'), actorUserId: user.id, action: 'account.email_login', targetType: 'user', targetId: user.id, detail: {}, createdAt: time });
      return { ok: true, user: publicUser(user), token };
    });
    if (result.error) raise(result.error);
    return result;
  };
  return { config, sendCode, verify, ip: (request) => emailClientIp(request, environment), close: () => delivery.close?.() };
};
