import { createHash } from 'node:crypto';
import { createId } from './security.mjs';
import { reserveQuota, settleQuota } from './quota.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const membershipView = (value, now = Date.now()) => {
  const membership = value || {};
  const expiresAt = Number(membership.expiresAt) || 0;
  const status = expiresAt && expiresAt <= now ? 'expired' : String(membership.status || 'inactive');
  const tier = String(membership.tier || 'free');
  return { tier, status, units: Number(membership.units) || 0, expiresAt, updatedAt: membership.updatedAt || 0, entitled: status === 'active' && tier !== 'free' };
};
export const publicRun = (run) => ({
  id: run.id, model: run.model, status: run.status, reservedUnits: run.reservedUnits,
  usedUnits: run.usedUnits ?? null, result: run.result || '', message: run.message || '',
  createdAt: run.createdAt, updatedAt: run.updatedAt,
});

// No provider adapter or model prices are enabled by default. Only trusted server
// code can supply them; request bodies cannot supply credentials, prices or usage.
export const createMeteredGenerationService = ({ store, models = [], execute = null, timeoutMs = 60_000 }) => {
  const modelMap = new Map(models.map((model) => [model.id, model]));
  for (const model of models) {
    if (!model.id || !Number.isSafeInteger(model.reserveUnits) || model.reserveUnits < 1 || model.reserveUnits > 10_000_000
      || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || typeof model.meterUsage !== 'function') {
      throw new Error('服务端模型计费配置无效');
    }
  }
  const enabled = typeof execute === 'function' && modelMap.size > 0;
  const generate = async (userId, body) => {
    if (!enabled) fail('平台模型和计费规则尚未启用，不会调用或消耗总 API', 503);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['model', 'prompt', 'idempotencyKey'].includes(key))) fail('生成参数包含不允许的字段');
    const model = modelMap.get(body.model);
    if (!model) fail('该平台模型不可用');
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const requestKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
    if (!prompt || prompt.length > Math.min(32_000, model.maxInputChars || 8_000)) fail('提示词为空或超出长度上限');
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey)) fail('请求标识无效');
    const requestHash = createHash('sha256').update(JSON.stringify({ model: model.id, prompt })).digest('hex');
    let run;
    let duplicate = false;
    await store.transact((state) => {
      const user = state.users.find((entry) => entry.id === userId && entry.status === 'active');
      if (!user) fail('账号不可用', 401);
      const previous = state.generationRuns.find((entry) => entry.userId === userId && entry.requestKey === requestKey);
      if (previous) {
        if (previous.requestHash !== requestHash) fail('相同请求标识不能用于不同内容', 409);
        run = previous; duplicate = true; return;
      }
      if (!membershipView(state.memberships.find((entry) => entry.userId === userId)).entitled) fail('当前会员权益不可用', 403);
      if (state.generationRuns.some((entry) => entry.userId === userId && ['running', 'reconciliation_required'].includes(entry.status))) {
        fail('已有平台生成任务执行中或待核对，请先处理该任务', 409);
      }
      const reservation = reserveQuota({ state, userId, amount: model.reserveUnits, idempotencyKey: requestKey });
      run = { id: createId('generation'), userId, requestKey, requestHash, model: model.id,
        reservationId: reservation.reservationId, reservedUnits: model.reserveUnits, status: 'running', createdAt: Date.now(), updatedAt: Date.now() };
      state.generationRuns.push(run);
    });
    if (duplicate) return { ...publicRun(run), idempotent: true };
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => execute({ model: model.id, prompt, maxOutputTokens: model.maxOutputTokens, requestId: run.id, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, timeoutMs); }),
      ]);
      const usedUnits = model.meterUsage(result?.usage);
      if (!Number.isSafeInteger(usedUnits) || usedUnits < 0 || usedUnits > model.reserveUnits
        || typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 200_000) throw new Error('provider_receipt_invalid');
      await store.transact((state) => {
        const target = state.generationRuns.find((entry) => entry.id === run.id && entry.userId === userId);
        if (target.status !== 'running') fail('任务已被处理，不能重复结算', 409);
        settleQuota({ state, userId, reservationId: target.reservationId, usedAmount: usedUnits });
        Object.assign(target, { status: 'completed', usedUnits, result: result.text, updatedAt: Date.now() });
        run = target;
      });
    } catch (error) {
      await store.transact((state) => {
        const target = state.generationRuns.find((entry) => entry.id === run.id && entry.userId === userId);
        if (target.status !== 'running') { run = target; return; }
        // Only a trusted adapter's explicit non-billable receipt permits refund.
        // Ambiguous submission/timeout must never auto-refund and submit again.
        const unbilled = error?.billable === false;
        if (unbilled) settleQuota({ state, userId, reservationId: target.reservationId, usedAmount: 0 });
        Object.assign(target, { status: unbilled ? 'failed' : 'reconciliation_required',
          message: unbilled ? '生成未计费，预留积分已退回' : '厂商结果或计费尚未确认，积分保留待管理员核对，请勿重复提交', updatedAt: Date.now() });
        run = target;
      });
    } finally { clearTimeout(timer); }
    return publicRun(run);
  };
  return { enabled, generate, list: (userId) => store.state.generationRuns.filter((run) => run.userId === userId).slice(-50).reverse().map(publicRun) };
};
