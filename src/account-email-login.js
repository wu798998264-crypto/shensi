// Mail authentication lives only in the cloud account path, never provider settings.
const emailFields = (purpose) => '<label>邮箱<input name="' + (purpose === 'login' ? 'loginEmail' : 'bindEmail') + '" type="email" autocomplete="email" maxlength="254" required placeholder="请输入邮箱地址" /></label>'
  + '<label>验证码<span class="account-code-input"><input name="emailCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="6 位验证码" /><button type="button" class="secondary-button" data-email-send>获取验证码</button></span></label>'
  + '<small data-email-help>验证码 5 分钟内有效，请勿向他人透露。</small>'
  + (purpose === 'login' ? '<small>新邮箱验证后创建普通账户；旧账号请先用密码登录，再验证绑定邮箱。</small>' : '<small>验证成功后可用此邮箱登录。不会合并其他账号或转移其会员、积分。</small>');

export const createEmailCodePanel = ({ panel, accountApi, getAccount, purpose, setStatus, onState = () => {} }) => {
  const emailInput = panel.querySelector('input[type=email]');
  const codeInput = panel.querySelector('[name=emailCode]');
  const send = panel.querySelector('[data-email-send]');
  const help = panel.querySelector('[data-email-help]');
  const cooldowns = new Map();
  let active = false; let available = false; let sending = false; let loading = false;
  let revision = 0; let timer; let challenge;
  const email = () => emailInput.value.trim().toLowerCase();
  const seconds = () => Math.max(0, Math.ceil(((cooldowns.get(email()) || 0) - Date.now()) / 1000));
  const update = () => {
    const wait = seconds();
    send.disabled = !active || !available || sending || loading || wait > 0;
    send.textContent = loading ? '读取服务…' : sending ? '发送中…' : wait > 0 ? wait + ' 秒后重发' : '获取验证码';
    onState({ ready: active && available && !loading, sending });
    clearTimeout(timer);
    if (active && wait) timer = setTimeout(update, 250);
  };
  const activate = async () => {
    const current = ++revision; active = true; loading = true; available = false;
    help.textContent = '正在检查验证码服务…'; update();
    try {
      const config = await accountApi('/api/account/email-config');
      if (current !== revision || !active) return;
      available = config.enabled === true;
      help.textContent = available ? '验证码 5 分钟内有效，请勿向他人透露。' : (config.message || '邮箱验证码尚未开放，请使用密码登录');
    } catch (error) {
      if (current === revision && active) help.textContent = error.message || '验证码服务暂不可用，可稍后重试或使用密码登录';
    } finally { if (current === revision && active) { loading = false; update(); } }
  };
  const deactivate = () => { active = false; revision++; sending = false; loading = false; clearTimeout(timer); update(); };
  emailInput.addEventListener('input', () => {
    if (challenge?.email !== email()) { challenge = undefined; codeInput.value = ''; }
    update();
  });
  send.addEventListener('click', async () => {
    if (!active || !available || sending || seconds()) return;
    if (!emailInput.reportValidity()) return;
    const current = revision; const target = email(); const token = getAccount()?.token || '';
    sending = true; setStatus('正在发送验证码…'); update();
    try {
      const result = await accountApi('/api/account/email-code', { method: 'POST', body: { email: target, purpose } });
      cooldowns.set(target, Date.now() + (Number(result.retryAfterSeconds) || 60) * 1000);
      if (current !== revision || !active || target !== email() || token !== (getAccount()?.token || '')) return;
      challenge = { id: result.challengeId, email: target, expiresAt: Date.now() + (Number(result.expiresInSeconds) || 300) * 1000 };
      setStatus(result.message || '验证码已发送，请检查收件箱或垃圾邮件'); codeInput.focus();
    } catch (error) {
      if (current !== revision || !active || token !== (getAccount()?.token || '')) return;
      if (error.retryAfterSeconds) cooldowns.set(target, Date.now() + error.retryAfterSeconds * 1000);
      setStatus(error.message || '发送失败，请稍后重试');
    } finally { if (current === revision && active) { sending = false; update(); } }
  });
  return { activate, deactivate, ready: () => available && active && !loading,
    reset: () => { challenge = undefined; codeInput.value = ''; deactivate(); },
    payload: () => {
      if (!available || loading) throw new Error('验证码服务暂不可用，请稍后重试或使用密码登录');
      if (!challenge || challenge.email !== email() || challenge.expiresAt <= Date.now()) throw new Error('请先为当前邮箱获取有效验证码');
      if (!/^[0-9]{6}$/.test(codeInput.value.trim())) throw new Error('请输入 6 位验证码');
      return { email: email(), challengeId: challenge.id, code: codeInput.value.trim() };
    },
  };
};

export const installAccountEmailUI = ({ dialog, form, accountApi, getAccount, setStatus, onLogin, onBound }) => {
  const tab = document.createElement('button');
  tab.type = 'button'; tab.dataset.accountLoginMode = 'email'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false'); tab.textContent = '邮箱验证码';
  dialog.querySelector('.account-login-tabs').insertBefore(tab, dialog.querySelector('[data-account-login-mode=register]'));
  const panel = document.createElement('section');
  panel.className = 'account-login-panel'; panel.dataset.accountLoginPanel = 'email'; panel.hidden = true;
  panel.innerHTML = emailFields('login');
  dialog.querySelector('.account-login-body').insertBefore(panel, dialog.querySelector('.account-login-status'));
  panel.querySelectorAll('input').forEach((input) => { input.disabled = true; });
  const submit = form.querySelector('[type=submit]');
  let modeActive = false; let loginBusy = false; let loginRevision = 0;
  const controller = createEmailCodePanel({ panel, accountApi, getAccount, purpose: 'login', setStatus,
    onState: ({ ready }) => { if (modeActive) submit.disabled = !ready || loginBusy; } });
  const reset = () => { loginRevision++; loginBusy = false; modeActive = false; controller.reset(); submit.disabled = false; };
  dialog.addEventListener('close', reset);

  const bindDialog = document.createElement('dialog');
  bindDialog.className = 'account-login-dialog account-email-bind-dialog'; bindDialog.setAttribute('aria-label', '验证绑定邮箱');
  bindDialog.innerHTML = '<form><header class="dialog-header"><h2>验证绑定邮箱</h2><button type="button" class="icon-button bare" data-email-close aria-label="关闭">×</button></header>'
    + '<div class="account-login-body"><section class="account-login-panel">' + emailFields('bind') + '</section><p class="account-login-status" role="status"></p></div>'
    + '<footer class="dialog-footer"><button type="button" class="secondary-button" data-email-close>取消</button><button type="submit" class="primary-button">验证并绑定</button></footer></form>';
  document.body.append(bindDialog);
  const bindForm = bindDialog.querySelector('form'); const bindSubmit = bindForm.querySelector('[type=submit]');
  const bindStatus = (message) => { bindDialog.querySelector('[role=status]').textContent = message; };
  let bindBusy = false; let bindRevision = 0;
  const bindController = createEmailCodePanel({ panel: bindDialog, accountApi, getAccount, purpose: 'bind', setStatus: bindStatus,
    onState: ({ ready }) => { bindSubmit.disabled = !ready || bindBusy; } });
  bindDialog.querySelectorAll('[data-email-close]').forEach((button) => button.addEventListener('click', () => bindDialog.close()));
  bindDialog.addEventListener('close', () => { bindRevision++; bindBusy = false; bindController.reset(); bindForm.reset(); });
  bindForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (bindBusy || !getAccount()?.authenticated) return;
    const current = bindRevision; const token = getAccount().token;
    bindBusy = true; bindSubmit.disabled = true;
    try {
      const result = await accountApi('/api/account/email-bind', { method: 'POST', body: bindController.payload() });
      if (current !== bindRevision || !bindDialog.open || token !== getAccount().token) return;
      onBound(result.user, token); bindDialog.close();
    } catch (error) { if (current === bindRevision && bindDialog.open && token === getAccount()?.token) bindStatus(error.message); }
    finally { if (current === bindRevision) { bindBusy = false; bindSubmit.disabled = !bindController.ready(); } }
  });
  return {
    setActive: (active) => {
      if (active === modeActive) return;
      modeActive = active; loginRevision++; loginBusy = false;
      if (active) void controller.activate();
      else { controller.deactivate(); submit.disabled = false; }
    },
    login: async () => {
      if (loginBusy) return; const current = loginRevision; const token = getAccount()?.token || '';
      loginBusy = true; submit.disabled = true;
      try {
        const result = await accountApi('/api/account/email-login', { method: 'POST', body: controller.payload() });
        if (current !== loginRevision || !dialog.open || !modeActive || token !== (getAccount()?.token || '')) return;
        onLogin(result); dialog.close();
      } catch (error) { if (current === loginRevision && dialog.open && modeActive) setStatus(error.message || '验证码登录失败'); }
      finally { if (current === loginRevision) { loginBusy = false; submit.disabled = !controller.ready(); } }
    },
    openBinding: () => {
      if (!getAccount()?.authenticated) return;
      bindRevision++; bindBusy = false; bindController.reset(); bindForm.reset();
      bindForm.elements.bindEmail.value = getAccount().profile?.email || '';
      bindStatus('请验证你实际持有的邮箱，验证后可用验证码登录。');
      if (!bindDialog.open) bindDialog.showModal();
      void bindController.activate(); bindForm.elements.bindEmail.focus();
    },
  };
};
