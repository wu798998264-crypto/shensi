const $ = (s) => document.querySelector(s);
const prefix = location.pathname.startsWith('/skill/') ? '/skill' : '';
const state = { token: sessionStorage.getItem('shensi_cloud_admin_token') || '', user: null, users: [], skills: [], reviews: [], audit: [] };
localStorage.removeItem('shensi_cloud_admin_token');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const api = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(prefix + path, { method, headers: { ...(body === undefined ? {} : { 'content-type':'application/json' }), ...(state.token ? { authorization:'Bearer ' + state.token } : {}) }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || '请求失败'), { status:response.status });
  return payload;
};
const message = (s) => { $('#adminMessage').textContent = s; $('#adminMessage').hidden = !s; };
const date = (v) => v ? new Date(Number(v)).toLocaleString('zh-CN') : '—';
const label = (v) => ({ pending_review:'待审核', published:'已发布', rejected:'已拒绝', quarantined:'已隔离', unpublished:'已下架', active:'有效', inactive:'未开通', expired:'已到期', suspended:'已暂停', banned:'已封禁', user:'用户', admin:'管理员', reviewer:'审核员', membership_admin:'会员管理员', visible:'公开', hidden:'隐藏', running:'运行中', completed:'已完成', failed:'失败', reconciliation_required:'待核账', grant:'增发', debit:'扣减', reserve:'预留', settle:'结算', refund:'退回' }[v] || v || '—');
const allowed = (area) => state.user?.role === 'admin' || (area === 'review' && state.user?.role === 'reviewer') || (area === 'members' && state.user?.role === 'membership_admin');
const button = (action, id, name) => '<button type="button" data-action="' + action + '" data-id="' + esc(id) + '">' + name + '</button>';
const cell = (v) => '<td>' + esc(v) + '</td>';
const render = () => {
  document.querySelectorAll('[data-role-panel]').forEach((n) => { n.hidden = !allowed(n.dataset.rolePanel); });
  const metrics = [];
  if (allowed('members')) metrics.push(['用户', state.users.length], ['可用积分合计', state.users.reduce((n, r) => n + (r.quota?.available || 0), 0)]);
  if (allowed('review')) metrics.push(['待审核 Skill', state.skills.filter((r) => r.status === 'pending_review').length], ['待审核评价', state.reviews.filter((r) => r.status === 'pending_review').length]);
  $('#overviewCards').innerHTML = metrics.map(([name, n]) => '<article class="metric"><small>' + name + '</small><strong>' + Number(n).toLocaleString('zh-CN') + '</strong></article>').join('');
  $('#skillsTable').innerHTML = state.skills.map((r) => '<tr>' + cell(r.name) + cell(r.author) + cell(r.version) + cell(label(r.status)) + cell(r.scan?.status === 'passed' ? '自动检查通过' : '需审查') + '<td><div class="row-actions">' + button('inspect', r.recordId, '查看原文与审核') + (r.status === 'published' ? button('unpublish', r.recordId, '下架') : '') + '</div></td></tr>').join('') || '<tr><td colspan="6">暂无记录</td></tr>';
  $('#usersTable').innerHTML = state.users.map(({ user:u, quota:q, membership:m }) => '<tr><td><strong>' + esc(u.displayName) + '</strong><small>' + esc(u.account || u.email) + '</small></td>' + cell(label(u.role)) + cell(label(u.status)) + '<td>' + q.available + ' 可用 / ' + q.reserved + ' 预留<small>' + esc(m.tier) + ' · ' + esc(label(m.status)) + '</small></td><td><div class="row-actions">' + button('membership', u.id, '会员') + button('quota', u.id, '调账') + button('usage', u.id, '流水') + (state.user.role === 'admin' && u.id !== state.user.id ? button(u.status === 'active' ? 'suspend' : 'activate', u.id, u.status === 'active' ? '暂停' : '启用') : '') + '</div></td></tr>').join('') || '<tr><td colspan="5">暂无账号</td></tr>';
  $('#reviewsTable').innerHTML = state.reviews.map((r) => '<tr>' + cell(r.skillId) + cell(r.name) + cell(r.rating + ' / 5') + cell(r.comment) + cell(label(r.status)) + '<td>' + button('review', r.id, '审核') + '</td></tr>').join('') || '<tr><td colspan="6">暂无评价</td></tr>';
  $('#auditList').innerHTML = state.audit.map((r) => '<li><strong>' + esc(r.action) + '</strong><div>' + esc(r.targetId) + '</div><small>' + esc(JSON.stringify(r.detail || {})) + '</small><time>' + date(r.createdAt) + '</time></li>').join('') || '<li>暂无记录</li>';
};
let revision = 0;
const load = async () => {
  const current = ++revision, requests = [];
  if (allowed('members')) requests.push(['users','/v1/admin/users']);
  if (allowed('review')) requests.push(['skills','/v1/admin/skills'], ['reviews','/v1/admin/reviews']);
  if (allowed('audit')) requests.push(['audit','/v1/admin/audit-logs?limit=30']);
  const results = await Promise.all(requests.map(async ([key,path]) => [key, (await api(path)).items || []]));
  if (current !== revision) return; for (const [key, rows] of results) state[key] = rows; render();
};
const logout = () => { revision++; state.token = ''; state.user = null; sessionStorage.removeItem('shensi_cloud_admin_token'); $('#adminView').hidden = true; $('#authView').hidden = false; $('#managementDialog').close(); };
const showAdmin = async () => {
  if (!['admin','reviewer','membership_admin'].includes(state.user?.role)) { logout(); throw new Error('当前账号没有后台管理权限'); }
  $('#authView').hidden = true; $('#adminView').hidden = false; $('#adminIdentity').textContent = state.user.displayName + ' · ' + label(state.user.role); await load();
};
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#authSubmit').disabled = true; $('#authMessage').textContent = '正在登录…';
  try { const p = await api('/v1/auth/login', { method:'POST', body:{ account:$('#authAccount').value, password:$('#authPassword').value, rememberMe:false } }); state.token = p.token; state.user = p.user; sessionStorage.setItem('shensi_cloud_admin_token', state.token); $('#authPassword').value = ''; await showAdmin(); $('#authMessage').textContent = ''; }
  catch (error) { $('#authMessage').textContent = error.message; message(error.message); } finally { $('#authSubmit').disabled = false; }
});
$('#logoutButton').addEventListener('click', async () => { try { await api('/v1/auth/logout', { method:'POST' }); } catch (error) { message(error.message); } finally { logout(); } });
document.querySelectorAll('[data-refresh]').forEach((n) => n.addEventListener('click', () => load().then(() => message('已刷新')).catch((e) => message(e.message))));
const dialog = $('#managementDialog'), form = $('#managementForm');
let save = null, saving = false;
const reason = '<label>操作理由<textarea name="reason" maxlength="500" required rows="3"></textarea></label>';
const open = (title, html, callback = null) => { $('#managementTitle').textContent = title; $('#managementBody').innerHTML = html; $('#managementMessage').textContent = ''; save = callback; $('#managementSubmit').hidden = !save; $('#managementSubmit').disabled = false; if (!dialog.open) dialog.showModal(); };
document.querySelectorAll('[data-close-dialog]').forEach((n) => n.addEventListener('click', () => { if (!saving) dialog.close(); }));
dialog.addEventListener('cancel', (e) => { if (saving) e.preventDefault(); });
form.addEventListener('submit', async (e) => {
  e.preventDefault(); if (!save || saving) return; saving = true; $('#managementSubmit').disabled = true;
  try { await save(Object.fromEntries(new FormData(form))); dialog.close(); await load(); message('已保存并记入审计日志'); }
  catch (error) { $('#managementMessage').textContent = error.message; } finally { saving = false; $('#managementSubmit').disabled = false; }
});
document.addEventListener('click', async (e) => {
  const n = e.target.closest('[data-action]'); if (!n || saving) return; const { id, action } = n.dataset; n.disabled = true;
  try {
    if (action === 'inspect') {
      const item = state.skills.find((r) => r.recordId === id), info = await api('/v1/admin/skills/' + encodeURIComponent(id) + '/inspection');
      open('Skill 原文与质量审核', '<p>只展示原文，不执行指令或代码。自动扫描不能代替人工质量审核。</p><pre id="inspectionMeta"></pre><pre id="inspectionSource"></pre>' + (item.status === 'pending_review' ? '<label>审核结果<select name="decision"><option value="approve">通过并发布</option><option value="reject">拒绝</option></select></label>' + reason : ''), item.status === 'pending_review' ? (fields) => api('/v1/admin/skills/' + encodeURIComponent(id) + '/review', { method:'POST', body:fields }) : null);
      $('#inspectionMeta').textContent = '版本：' + info.version + ' · SHA-256：' + info.sha256 + String.fromCharCode(10) + JSON.stringify(info.scan, null, 2) + (info.truncated ? '（原文预览已截断）' : ''); $('#inspectionSource').textContent = info.source || '原文已清理或不可读取';
    } else if (action === 'review') {
      const item = state.reviews.find((r) => r.id === id); open('评价审核', '<p>' + esc(item.comment) + '</p><label>状态<select name="status"><option value="visible">公开</option><option value="hidden">隐藏</option></select></label>' + reason, (fields) => api('/v1/admin/reviews/' + encodeURIComponent(id), { method:'POST', body:{ ...fields, expectedUpdatedAt:item.updatedAt } }));
    } else if (action === 'quota') {
      const key = crypto.randomUUID(); open('人工积分调账', '<p>不是支付订单。正数增发、负数扣减，不改预留积分。</p><label>调整积分<input name="amount" type="number" min="-10000000" max="10000000" step="1" required /></label>' + reason, (f) => api('/v1/admin/quota/adjust', { method:'POST', body:{ ...f, userId:id, amount:Number(f.amount), idempotencyKey:key } }));
    } else if (action === 'membership') {
      const item = state.users.find((r) => r.user.id === id).membership;
      open('会员权益（人工设置）', '<p>额度基数的差额增减可用积分，不是每月自动发放。</p><label>会员标识<input name="tier" value="' + esc(item.tier) + '" maxlength="40" required /></label><label>状态<select name="status"><option value="active">有效</option><option value="inactive">停用</option></select></label><label>累计授予额度基数<input name="units" type="number" min="0" max="10000000" step="1" value="' + Number(item.units) + '" required /></label><label>到期时间（留空为长期）<input name="expiry" type="datetime-local" /></label>' + reason, (f) => api('/v1/admin/memberships', { method:'POST', body:{ userId:id, tier:f.tier, status:f.status, units:Number(f.units), expiresAt:f.expiry ? new Date(f.expiry).getTime() : 0, reason:f.reason, expectedUpdatedAt:item.updatedAt } }));
      form.elements.status.value = item.status === 'inactive' ? 'inactive' : 'active'; if (item.expiresAt) { const d = new Date(item.expiresAt); form.elements.expiry.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
    } else if (action === 'usage') {
      const result = await api('/v1/admin/usage?userId=' + encodeURIComponent(id));
      open('积分流水与平台任务', '<p>已结算消费：' + result.consumed + ' 积分。预留与退回不重复计数。</p><div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>余额</th><th>说明</th></tr></thead><tbody>' + result.ledger.map((r) => '<tr>' + cell(date(r.createdAt)) + cell(label(r.type)) + cell(r.type === 'settle' ? r.usedUnits + ' 已消费' : r.amount) + cell(r.balance) + cell(r.reason) + '</tr>').join('') + '</tbody></table></div><h3>平台任务</h3><pre id="usageRuns"></pre>');
      $('#usageRuns').textContent = result.runs.length ? result.runs.map((r) => r.id + ' · ' + label(r.status) + ' · ' + r.message).join(String.fromCharCode(10)) : '暂无平台生成任务';
    } else if (['unpublish','suspend','activate'].includes(action)) {
      open(action === 'unpublish' ? '下架 Skill' : '更改用户状态', reason, (f) => action === 'unpublish' ? api('/v1/admin/skills/' + encodeURIComponent(id) + '/unpublish', { method:'POST', body:f }) : api('/v1/admin/users/' + encodeURIComponent(id) + '/status', { method:'POST', body:{ ...f, status:action === 'activate' ? 'active' : 'suspended' } }));
    }
  } catch (error) { message(error.message); } finally { if (n.isConnected) n.disabled = false; }
});
if (state.token) api('/v1/auth/me').then(async (p) => { state.user = p.user; await showAdmin(); }).catch((e) => { if (e.status === 401) logout(); $('#authMessage').textContent = e.message; message(e.message); });
