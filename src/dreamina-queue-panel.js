import { dreaminaPreSubmitTimingLabel } from './dreamina-task-queue.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const queueTaskMarkup = (job) => {
  const target = job.target || {};
  const location = [target.workspacePath, target.documentTitle || target.documentId || (target.conversationId ? '对话 ' + target.conversationId : ''), target.nodeName || target.nodeId || target.messageId].filter(Boolean).join(' → ');
  const progress = Math.min(100, Math.max(0, Number(job.progressPercent) || 0));
  const action = (name, label) => '<button type="button" class="secondary-button compact" data-queue-action="' + name + '">' + label + '</button>';
  const recover = job.availableActions?.resumeOriginal || job.availableActions?.autoReconcileProviderTask;
  const result = job.status === 'complete';
  const auth = job.status === 'waiting_credentials';
  const localQueue = job.queueReorderable || job.queueState === 'queued_paused';
  const timing = dreaminaPreSubmitTimingLabel(job);
  const controls = result ? action('apply', '重新回填') + action('dismiss', '放弃回填')
    : (auth ? action('verify', '核验原配置') : '')
      + (recover ? action('recover', '找回结果') : job.availableActions?.confirmedResubmit || job.availableActions?.safeResubmit ? action('retry', '重新生成') : '')
      + action('stop', localQueue ? '取消排队' : '停止并释放本机锁');
  return '<article class="generation-queue-item" data-queue-id="' + escape(job.id) + '" data-tone="' + escape(job.queueTone) + '" draggable="' + (job.queueReorderable ? 'true' : 'false') + '">'
    + '<header><strong>' + (job.queuePosition ? '#' + job.queuePosition + ' ' : '') + escape(job.queueProfileName) + ' · ' + (job.channel === 'video' ? '视频' : '图片') + '</strong><span>' + escape(job.queueStage) + '</span></header>'
    + '<p class="queue-location">' + escape(location || '未记录位置') + '</p>'
    + '<p>账号：' + escape(job.queueAccount || '由独立配置绑定') + ' · 模型：' + escape(job.queueModel || '默认模型') + ' · 厂商任务：<code>' + escape(job.providerTaskId || '尚未提交') + '</code></p>'
    + '<div class="queue-progress"><progress max="100" value="' + progress + '"></progress><span>' + progress + '%</span></div>'
    + (timing ? '<p class="queue-timing">' + escape(timing) + '</p>' : '')
    + (job.error ? '<p class="queue-error">' + escape(job.error) + '</p>' : '')
    + '<footer>' + (job.queueReorderable ? '<span class="queue-drag-hint">拖动调整顺序</span><button type="button" class="secondary-button compact" data-queue-action="up" aria-label="上移排队任务">↑</button><button type="button" class="secondary-button compact" data-queue-action="down" aria-label="下移排队任务">↓</button>' : '') + controls + '</footer></article>';
};

export const installDreaminaQueuePanel = ({ elements, act, toast, changed, fetchFn = (...args) => fetch(...args) }) => {
  const dialog = elements.generationQueueDialog, list = elements.generationQueueList;
  const button = elements.generationQueueButton, badge = elements.generationQueueBadge;
  const controls = elements.generationQueueControls;
  if (!dialog || !list || !button || !controls) return;
  controls.hidden = false;
  let jobs = [], busy = false, dragging = '', timer, refreshing = null, lastMarkup = '';
  const request = async (url, body) => {
    const response = await fetchFn(url, { cache: 'no-store', signal: AbortSignal.timeout(/\/(?:stop|cancel)$/u.test(url) ? 40_000 : 12_000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || '队列读取失败');
    return payload;
  };
  const render = () => {
    badge.textContent = String(jobs.length); badge.hidden = !jobs.length;
    button.title = '查看排队任务（' + jobs.length + '）';
    elements.generationQueueCount.textContent = String(jobs.length);
    if (!dialog.open || dragging || busy) return;
    const markup = jobs.map(queueTaskMarkup).join('') || '<p class="panel-empty">当前没有即梦排队或待处理任务。</p>';
    if (lastMarkup !== markup) {
      const scroll = list.scrollTop;
      list.innerHTML = markup; lastMarkup = markup; list.scrollTop = scroll;
    }
  };
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = request('/api/dreamina-queue').then((data) => { jobs = data.jobs || []; render(); }).catch((error) => {
      if (dialog.open && !jobs.length) { lastMarkup = ''; list.innerHTML = '<p class="panel-empty">' + escape(error.message) + '，可点击重新读取。</p>'; }
    }).finally(() => { refreshing = null; });
    return refreshing;
  };
  const reorder = async (sourceId, targetId) => {
    const ids = jobs.filter((job) => job.queueReorderable).map((job) => job.id);
    const source = ids.indexOf(sourceId), target = ids.indexOf(targetId);
    if (source < 0 || target < 0 || source === target) return;
    ids.splice(target, 0, ids.splice(source, 1)[0]);
    busy = true;
    try { jobs = (await request('/api/dreamina-queue/reorder', { jobIds: ids })).jobs; }
    catch (error) { toast(error.message); }
    finally { busy = false; await refresh(); render(); }
  };
  list.addEventListener('dragstart', (event) => {
    const item = event.target.closest('[draggable="true"]');
    if (!item || busy) { event.preventDefault(); return; }
    dragging = item.dataset.queueId; event.dataTransfer.setData('text/plain', dragging); event.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (event) => { if (dragging && event.target.closest('[draggable="true"]')) event.preventDefault(); });
  list.addEventListener('drop', (event) => {
    const target = event.target.closest('[draggable="true"]')?.dataset.queueId;
    if (!dragging || !target) return;
    event.preventDefault(); const source = dragging; dragging = ''; void reorder(source, target);
  });
  list.addEventListener('dragend', () => { dragging = ''; render(); });
  list.addEventListener('click', async (event) => {
    const control = event.target.closest('[data-queue-action]');
    if (!control || busy) return;
    const job = jobs.find((item) => item.id === control.closest('[data-queue-id]').dataset.queueId);
    if (!job) return;
    const action = control.dataset.queueAction;
    if (['up', 'down'].includes(action)) {
      const queued = jobs.filter((item) => item.queueReorderable);
      const next = queued[queued.findIndex((item) => item.id === job.id) + (action === 'up' ? -1 : 1)];
      if (next) await reorder(job.id, next.id);
      return;
    }
    busy = true; control.disabled = true;
    try {
    if (action === 'stop') {
        const localQueue = job.queueReorderable || job.queueState === 'queued_paused';
        const message = localQueue ? '确认取消排队？尚未提交，不会扣费。' : '确认停止本地任务并释放凭证锁？远端任务可能继续生成并产生费用，任务记录会保留。';
        if (window.confirm(message)) {
          const endpoint = job.queueProvider && !/即梦|dreamina/iu.test(String(job.queueProvider))
            ? '/api/generation/jobs/' + encodeURIComponent(job.id) + '/cancel'
            : '/api/dreamina-queue/' + encodeURIComponent(job.id) + '/stop';
          const data = await request(endpoint, {}); changed(data.job); toast(data.job.error || (data.job.status === 'cancelled' ? '任务已终止' : '已保存停止意图'));
        }
      } else { await act(job, action); }
    } catch (error) { toast(error.message); }
    finally { busy = false; if (control.isConnected) control.disabled = false; await refresh(); render(); }
  });
  button.addEventListener('click', () => { dialog.showModal(); button.setAttribute('aria-expanded', 'true'); render(); void refresh(); });
  dialog.addEventListener('close', () => { button.setAttribute('aria-expanded', 'false'); });
  elements.refreshGenerationQueue.addEventListener('click', () => { void refresh(); });
  const tick = async () => { if (document.visibilityState !== 'hidden') await refresh(); timer = setTimeout(tick, dialog.open ? 2_000 : 8_000); };
  document.addEventListener('shensi:media-job-updated', () => { void refresh(); });
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  void tick();
  return { refresh };
};
