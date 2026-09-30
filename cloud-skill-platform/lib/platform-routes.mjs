import { profilePatch, skillReviewsView, submitSkillReview } from './community.mjs';
import { createId, publicUser } from './security.mjs';
import { publicRun } from './membership-core.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const createPlatformRoutes = ({ store, requireUser, requireAdmin, bodyJson, json, generation, readSkillBytes }) => {
  const audit = (state, actor, action, targetId, detail = {}) => state.auditLogs.push({
    id: createId('audit'), actorUserId: actor.id, action, targetType: 'platform', targetId, detail, createdAt: Date.now(),
  });
  return async (request, response, url, headers, parts) => {
    const send = (payload, status = 200) => { json(response, status, payload, headers); return true; };
    if (url.pathname === '/v1/account/profile' && request.method === 'POST') {
      const user = requireUser(request);
      const patch = profilePatch(await bodyJson(request, 200_000));
      let updated;
      await store.transact((state) => {
        const target = state.users.find((entry) => entry.id === user.id && entry.status === 'active');
        if (!target) fail('账号不可用', 401);
        Object.assign(target, patch, { updatedAt: Date.now() });
        updated = publicUser(target);
        audit(state, user, 'profile.update', user.id, { fields: Object.keys(patch) });
      });
      return send({ user: updated });
    }
    if (parts[0] === 'v1' && parts[1] === 'skills' && parts[2] && parts[3] === 'reviews') {
      if (request.method === 'GET') return send(skillReviewsView(store.state, parts[2]));
      if (request.method === 'POST') {
        const user = requireUser(request);
        const body = await bodyJson(request, 8_000);
        let review;
        await store.transact((state) => {
          review = submitSkillReview(state, { userId: user.id, skillId: parts[2], rating: body.rating, comment: body.comment });
          audit(state, user, 'review.submit', review.id);
        });
        return send({ review, message: '评价已提交，审核通过后公开；每位用户只计一次评分' });
      }
    }
    if (url.pathname === '/v1/billing/config' && request.method === 'GET') {
      return send({ paymentEnabled: false, generationEnabled: generation.enabled, plans: [], message: '尚未接入商户和定价，不会产生真实订单或扣款' });
    }
    if (url.pathname === '/v1/ai/text/generate' && request.method === 'POST') {
      const user = requireUser(request);
      return send({ run: await generation.generate(user.id, await bodyJson(request, 150_000)) });
    }
    if (url.pathname === '/v1/ai/tasks' && request.method === 'GET') return send({ items: generation.list(requireUser(request).id) });
    if (url.pathname === '/v1/admin/usage' && request.method === 'GET') {
      requireAdmin(request, ['membership_admin']);
      const userId = url.searchParams.get('userId');
      const ledger = store.state.quotaLedger.filter((row) => !userId || row.userId === userId);
      const runs = store.state.generationRuns.filter((row) => !userId || row.userId === userId);
      return send({ ledger: ledger.slice(-200).reverse(), runs: runs.slice(-100).reverse().map((run) => {
        const { result, ...row } = publicRun(run); return { ...row, userId: run.userId };
      }), consumed: ledger.filter((row) => row.type === 'settle').reduce((sum, row) => sum + (row.usedUnits || 0), 0),
      generationEnabled: generation.enabled, paymentEnabled: false });
    }
    if (url.pathname === '/v1/admin/reviews' && request.method === 'GET') {
      requireAdmin(request, ['reviewer']);
      return send({ items: store.state.skillReviews.slice(-200).reverse().map((row) => ({ ...row,
        name: store.state.users.find((user) => user.id === row.userId)?.displayName || '神思用户' })) });
    }
    if (parts[0] === 'v1' && parts[1] === 'admin' && parts[2] === 'reviews' && parts[3] && request.method === 'POST') {
      const actor = requireAdmin(request, ['reviewer']);
      const body = await bodyJson(request, 8_000);
      if (!['visible', 'hidden'].includes(body.status)) fail('评价状态无效');
      if (!String(body.reason || '').trim()) fail('请填写审核理由');
      await store.transact((state) => {
        const row = state.skillReviews.find((entry) => entry.id === parts[3]);
        if (!row) fail('评价不存在', 404);
        if (row.userId === actor.id) fail('不能审核自己的评价', 403);
        if (Number(body.expectedUpdatedAt) !== row.updatedAt) fail('评价已修改，请刷新后再审核', 409);
        Object.assign(row, { status: body.status, moderationReason: String(body.reason).trim().slice(0, 500), moderatedAt: Date.now(), updatedAt: Math.max(Date.now(), row.updatedAt + 1), moderatorUserId: actor.id });
        audit(state, actor, 'review.moderate', row.id, { status: row.status, reason: row.moderationReason });
      });
      return send({ ok: true });
    }
    if (parts[0] === 'v1' && parts[1] === 'admin' && parts[2] === 'skills' && parts[3] && parts[4] === 'inspection' && request.method === 'GET') {
      requireAdmin(request, ['reviewer']);
      const skill = store.state.skills.find((row) => row.id === parts[3]);
      if (!skill) fail('Skill 不存在', 404);
      const version = skill.versions.at(-1);
      const bytes = version?.objectKey || version?.bytesBase64 ? await readSkillBytes(version) : Buffer.alloc(0);
      return send({ id: skill.id, name: skill.name, ownerUserId: skill.ownerUserId, version: version?.version,
        sha256: version?.sha256, scan: skill.scan, source: bytes.toString('utf8').slice(0, 200_000), truncated: bytes.length > 200_000,
        review: skill.review || null });
    }
    return false;
  };
};
