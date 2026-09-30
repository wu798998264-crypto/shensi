import { createId } from './security.mjs';
import { normalizeDisplayName } from './validation.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const profilePatch = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['displayName', 'avatar'].includes(key))) fail('仅允许修改笔名和头像');
  const patch = {};
  if ('displayName' in body) {
    if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 40) fail('笔名需为 1–40 个字符');
    patch.displayName = normalizeDisplayName(body.displayName);
  }
  if ('avatar' in body) {
    const avatar = body.avatar;
    if (avatar === '') patch.avatar = '';
    else {
      if (typeof avatar !== 'string' || avatar.length > 180_000 || !avatar.startsWith('data:image/png;base64,')) fail('头像需为 PNG 图片，大小不超过 128KB');
      const encoded = avatar.slice(22);
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length < 33 || bytes.length > 131_072 || bytes.toString('base64') !== encoded
        || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('头像 PNG 文件无效');
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (!width || !height || width > 512 || height > 512) fail('头像尺寸不可超过 512×512');
      patch.avatar = avatar;
    }
  }
  if (!Object.keys(patch).length) fail('请提供要修改的资料');
  return patch;
};
export const skillReviewsView = (state, skillId) => {
  const rows = state.skillReviews.filter((entry) => entry.skillId === skillId && entry.status === 'visible');
  return {
    rating: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.rating, 0) / rows.length * 10) / 10 : 0,
    ratingCount: rows.length,
    reviews: rows.slice(-50).reverse().map((row) => {
      const author = state.users.find((user) => user.id === row.userId);
      return { id: row.id, authorName: author?.displayName || '神思用户', avatarUrl: author?.avatar || '', rating: row.rating, comment: row.comment, createdAt: row.updatedAt };
    }),
  };
};
export const submitSkillReview = (state, { userId, skillId, rating, comment }) => {
  const skill = state.skills.find((entry) => entry.skillId === skillId && entry.status === 'published');
  if (!skill) fail('Skill 不存在或尚未发布', 404);
  if (skill.ownerUserId === userId) fail('不能评价自己的 Skill', 403);
  if (!state.skillDownloads.some((entry) => entry.userId === userId && entry.skillId === skillId)) fail('请登录并获取该 Skill 后再评价', 403);
  if (!Number.isSafeInteger(rating) || rating < 1 || rating > 5) fail('评分必须为 1–5 的整数');
  if (typeof comment !== 'string' || comment.trim().length < 2 || comment.trim().length > 1000) fail('评价需为 2–1000 个字符');
  let row = state.skillReviews.find((entry) => entry.userId === userId && entry.skillId === skillId);
  if (!row) { row = { id: createId('review'), userId, skillId, createdAt: Date.now() }; state.skillReviews.push(row); }
  Object.assign(row, { rating, comment: comment.trim(), status: 'pending_review', updatedAt: Math.max(Date.now(), (row.updatedAt || 0) + 1), moderationReason: '' });
  return { id: row.id, rating: row.rating, comment: row.comment, status: row.status };
};
