// Cloud account UI only: never changes local provider or generation settings.
export const installAccountPlatformUI = ({ accountApi, getAccount, syncAccountProfile, showToast }) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'account-login-dialog account-profile-dialog';
  dialog.setAttribute('aria-label', '编辑头像与笔名');
  dialog.innerHTML = '<form><header class="dialog-header"><h2>头像与笔名</h2><button type="button" class="icon-button bare" data-profile-close aria-label="关闭">×</button></header>'
    + '<div class="account-login-body"><img class="account-profile-preview" alt="头像预览" hidden />'
    + '<label>笔名<input name="displayName" maxlength="40" required autocomplete="nickname" /></label>'
    + '<label>头像<input name="avatarFile" type="file" accept="image/png,image/jpeg,image/webp" /></label>'
    + '<small>支持 PNG、JPG、WebP，最大 5MB；保存时裁为方形头像。</small>'
    + '<button type="button" class="secondary-button compact" data-profile-clear>移除头像</button>'
    + '<p role="status" data-profile-status></p></div>'
    + '<footer class="dialog-footer"><button type="button" class="secondary-button" data-profile-close>取消</button><button type="submit" class="primary-button">保存资料</button></footer></form>';
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const submit = form.querySelector('[type=submit]');
  const fileInput = form.elements.avatarFile;
  const status = dialog.querySelector('[data-profile-status]');
  const preview = dialog.querySelector('img');
  let avatar = '';
  let loadingImage = false;
  let saving = false;
  let imageRevision = 0;
  let refreshRevision = 0;
  const safeAvatar = (value) => typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length <= 180000 ? value : '';
  const updatePreview = () => { preview.hidden = !avatar; if (avatar) preview.src = avatar; else preview.removeAttribute('src'); };
  const close = () => { if (!saving) { imageRevision++; dialog.close(); } };
  dialog.querySelectorAll('[data-profile-close]').forEach((button) => button.addEventListener('click', close));
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); else imageRevision++; });
  dialog.querySelector('[data-profile-clear]').addEventListener('click', () => {
    imageRevision++; avatar = ''; fileInput.value = ''; loadingImage = false; submit.disabled = saving; updatePreview(); status.textContent = '';
  });
  fileInput.addEventListener('change', async () => {
    const revision = ++imageRevision;
    const file = fileInput.files?.[0];
    if (!file) { loadingImage = false; submit.disabled = saving; return; }
    loadingImage = true; submit.disabled = true; status.textContent = '正在准备头像…';
    let bitmap;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5MB 的 PNG、JPG 或 WebP 图片');
      bitmap = await createImageBitmap(file);
      if (revision !== imageRevision) return;
      const side = Math.min(bitmap.width, bitmap.height);
      if (!side) throw new Error('图片尺寸无效');
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 160;
      canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 160, 160);
      const next = canvas.toDataURL('image/png');
      if (next.length > 174786) throw new Error('头像压缩后仍过大，请选择其他图片');
      avatar = next; updatePreview(); status.textContent = '头像已准备好，点击保存后生效。';
    } catch (error) { if (revision === imageRevision) status.textContent = error.message || '图片读取失败'; }
    finally { bitmap?.close(); if (revision === imageRevision) { loadingImage = false; submit.disabled = saving; } }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || loadingImage || !getAccount().authenticated) return;
    const token = getAccount().token;
    saving = true; submit.disabled = true; fileInput.disabled = true; status.textContent = '正在保存…';
    try {
      const payload = await accountApi('/api/account/profile', { method: 'POST', body: { displayName: form.elements.displayName.value.trim(), avatar } });
      if (getAccount().token !== token) return;
      syncAccountProfile(payload.user, token); dialog.close(); showToast('头像与笔名已保存');
    } catch (error) { status.textContent = error.message || '保存失败，请重试'; }
    finally { saving = false; submit.disabled = false; fileInput.disabled = false; }
  });
  const write = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  const refresh = async () => {
    const revision = ++refreshRevision;
    const account = getAccount();
    const token = account.token;
    const holder = document.querySelector('.account-profile-avatar');
    const currentAvatar = safeAvatar(account.profile?.avatar);
    if (holder) {
      const img = holder.querySelector('img');
      if (currentAvatar) { const image = img || document.createElement('img'); image.alt = '账户头像'; image.src = currentAvatar; holder.replaceChildren(image); }
      else if (img) holder.replaceChildren(document.createTextNode((account.profile?.nickname || '神思').slice(0, 1)));
    }
    for (const selector of ['[data-account-membership]', '[data-account-quota]', '[data-account-reserved]']) write(selector, account.authenticated ? '读取中…' : '登录后读取');
    write('[data-account-service-status]', '支付和平台计费尚未开放。');
    if (!account.authenticated) return;
    try {
      const [member, quota] = await Promise.all([accountApi('/api/account/membership'), accountApi('/api/account/quota')]);
      if (revision !== refreshRevision || token !== getAccount().token) return;
      const membership = member.membership || {};
      const label = { active: '有效', inactive: '未开通', expired: '已到期' }[membership.status] || '未开通';
      write('[data-account-membership]', membership.tier === 'free' ? '普通用户' : membership.tier + ' · ' + label);
      write('[data-account-quota]', Number(quota.available || 0).toLocaleString('zh-CN'));
      write('[data-account-reserved]', Number(quota.reserved || 0).toLocaleString('zh-CN'));
      write('[data-account-service-status]', '积分来自服务器账本；收款与平台付费生成功能尚未开放。');
    } catch (error) {
      if (revision !== refreshRevision || token !== getAccount().token) return;
      for (const selector of ['[data-account-membership]', '[data-account-quota]', '[data-account-reserved]']) write(selector, '暂不可读取');
      write('[data-account-service-status]', error.message || '账户服务暂不可用');
    }
  };
  return { refresh, open: () => {
    if (!getAccount().authenticated) return;
    imageRevision++; loadingImage = false; saving = false; submit.disabled = false; fileInput.disabled = false;
    avatar = safeAvatar(getAccount().profile?.avatar); form.elements.displayName.value = getAccount().profile?.nickname || '';
    fileInput.value = ''; status.textContent = ''; updatePreview(); if (!dialog.open) dialog.showModal();
  } };
};
