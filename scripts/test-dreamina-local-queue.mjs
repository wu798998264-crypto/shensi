import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dreaminaCredentialWaitState, dreaminaQueueView, isDreaminaQueueReorderable } from '../src/dreamina-task-queue.js';
import { queueTaskMarkup } from '../src/dreamina-queue-panel.js';
import { mediaRecoveryJobBlocksOperation } from '../src/media-generation-coordination.js';

const root = await mkdtemp(join(tmpdir(), 'shensi-local-queue-'));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
const store = await import('../src/server/generation-job-store.mjs');
const { writeDreaminaBrokerLease, clearDreaminaBrokerLease } = await import('../src/server/dreamina-broker-lease.mjs');
const target = (id) => ({ workspaceKind: 'project', workspacePath: root, documentId: 'queue-test', nodeId: id });
const create = (profile, nodeId, extra = {}) => store.createMediaGenerationJob({ channel: 'image', target: target(nodeId),
  request: { prompt: '隔离的队列合同测试，不调用厂商', aspectRatio: '1:1', imageCount: 1, settings: {
    id: profile, connectionId: profile, provider: '即梦', adapter: 'cli', model: '5.0', dreaminaCliProfile: profile,
  } }, ...extra });

try {
  const a = await create('account-a', 'card-a');
  await writeDreaminaBrokerLease({ profileId: 'account-a', token: 'queue-test', pid: process.pid, jobId: a.id, command: 'submit' });
  const b = await create('account-b', 'card-b');
  assert.equal(b.status, 'queued', '其他配置占锁也必须创建本地任务');
  assert.equal(b.submissionState, 'not_submitted');
  for (let i = 0; i < 100; i += 1) {
    assert.equal(dreaminaCredentialWaitState(b, { providerErrorCode: 'DREAMINA_PROFILE_BROKER_BUSY' }), 'queued', '锁冲突只改变调度状态');
  }
  assert.equal(dreaminaCredentialWaitState({ ...b, providerTaskId: 'paid-task' }, { providerErrorCode: 'DREAMINA_PROFILE_BROKER_BUSY' }), 'polling');
  assert.equal(dreaminaCredentialWaitState({ ...b, billingRisk: 'submission_outcome_unknown' }, { providerErrorCode: 'DREAMINA_PROFILE_BROKER_BUSY' }), 'reconciling');
  assert.equal(dreaminaCredentialWaitState(b, { providerErrorCode: 'DREAMINA_AUTH_REQUIRED' }), '');
  assert.equal(mediaRecoveryJobBlocksOperation({ ...b, status: 'queued', availableActions: { stop: true } }), false, '正常本地排队不得弹待处理窗口');
  assert.equal(mediaRecoveryJobBlocksOperation({ ...b, status: 'waiting_credentials', availableActions: { verify: true } }), true, '明确需要核验才进入待处理');
  assert.deepEqual((await store.listDreaminaProfileBlockingJobs()).map((job) => job.id), [a.id], '只有真实命令占锁');
  await clearDreaminaBrokerLease('queue-test');
  assert.deepEqual(await store.listDreaminaProfileBlockingJobs(), [], '远端生成和本地排队不占物理锁');
  const duplicate = await create('account-b', 'card-b');
  assert.equal(duplicate.id, b.id, '重复请求必须复用已有任务');
  await store.reorderDreaminaQueue({ jobIds: [b.id, a.id] });
  const order = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const s=await import('./src/server/generation-job-store.mjs');console.log(JSON.stringify((await s.listDreaminaQueueJobs()).map(j=>j.id)))"], { env: process.env, encoding: 'utf8' }));
  assert.deepEqual(order, [b.id, a.id], '新进程读取必须保留顺序');
  assert.equal(await store.claimDreaminaQueueTurn({ jobId: a.id }), '', '不得跳过队首');
  const token = await store.claimDreaminaQueueTurn({ jobId: b.id });
  assert.ok(token);
  await assert.rejects(store.reorderDreaminaQueue({ jobIds: [b.id, a.id] }), { code: 'DREAMINA_QUEUE_ORDER_STALE' });
  await store.reorderDreaminaQueue({ jobIds: [a.id] });
  assert.equal(await store.claimDreaminaQueueTurn({ jobId: a.id }), '', '重排不能越过已在提交前准备的任务');
  await store.updateMediaGenerationJob({ jobId: b.id, patch: { status: 'polling', submissionState: 'submitted', providerTaskId: 'task-b-1234567890123456' } });
  const aToken = await store.claimDreaminaQueueTurn({ jobId: a.id });
  assert.ok(aToken, '已拿到任务 ID后下一任务可以准备，不必等远端生成');
  await store.releaseDreaminaQueueTurn({ jobId: a.id, token: aToken });
  await store.releaseDreaminaQueueTurn({ jobId: b.id, token });
  const bView = (await store.listDreaminaQueueJobs()).find((job) => job.id === b.id);
  assert.equal(bView.queueTone, 'green');
  assert.equal(bView.queueReorderable, false);
  assert.equal(bView.queuePosition, 0);
  const stopped = await store.stopDreaminaQueueJob({ jobId: b.id });
  assert.equal(stopped.providerTaskId, 'task-b-1234567890123456');
  assert.equal(stopped.cancelOutcome, 'local_terminalized_unconfirmed');
  assert.match(stopped.error, /费用/u);
  const cancelled = await store.stopDreaminaQueueJob({ jobId: a.id });
  assert.equal(cancelled.cancelOutcome, 'not_submitted');
  const c = await create('account-c', 'card-c');
  await store.updateMediaGenerationJob({ jobId: c.id, patch: { status: 'complete', providerTaskId: 'task-c', result: { attachment: { relativePath: 'assets/landed.png' } }, assetSavedAt: new Date().toISOString() } });
  assert.equal((await store.listDreaminaQueueJobs()).find((job) => job.id === c.id).queueState, 'result_pending_apply');
  const red = dreaminaQueueView({ ...c, status: 'waiting_credentials', providerErrorCode: 'AUTH_REQUIRED' });
  assert.equal(red.queueTone, 'red');
  const d = await create('account-d', 'card-d');
  // Startup recovery intentionally excludes Dreamina records.  The durable
  // queue view is the restart boundary; an explicit resume action enrolls the
  // record in a targeted worker afterwards.
  assert.ok((await store.listDreaminaQueueJobs()).some((job) => job.id === d.id), '新队列可从重启恢复');
  assert.equal((await store.listMediaGenerationJobsForWorker({ skipDreamina: true })).some((job) => job.id === d.id), false, '启动扫描不得自动恢复即梦历史任务');
  assert.equal(isDreaminaQueueReorderable({ ...d, providerTaskId: 'already-submitted' }), false);
  const retry = await create('account-retry', 'card-retry');
  await store.updateMediaGenerationJob({ jobId: retry.id, patch: {
    status: 'failed', providerStatus: 'failed', providerTaskId: 'rejected-provider-task',
    providerErrorCode: 'DREAMINA_CONCURRENCY_LIMIT', submissionState: 'submitted',
  } });
  const resumed = await store.requestMediaGenerationResume({ jobId: retry.id, allowNewSubmission: true, requestId: 'explicit-retry-test' });
  assert.equal(resumed.providerTaskId, null, '手动重试必须清除旧的失败厂商任务 ID');
  assert.equal(resumed.providerErrorCode, '', '手动重试必须清除旧的并发错误');
  assert.equal(isDreaminaQueueReorderable(resumed), true, '手动重试后的任务必须重新进入本地队列');
  const brokerRetry = await create('account-broker-retry', 'card-broker-retry');
  await store.updateMediaGenerationJob({ jobId: brokerRetry.id, patch: {
    status: 'queued', providerStatus: 'queued', providerErrorCode: 'DREAMINA_PROFILE_BROKER_BUSY',
    submissionState: 'not_submitted', safeNoTaskRetry: true, capacityRetrySafe: false,
  } });
  await store.reorderDreaminaQueue({ jobIds: [brokerRetry.id] });
  const brokerToken = await store.claimDreaminaQueueTurn({ jobId: brokerRetry.id });
  assert.ok(brokerToken, '已知未提交的凭证锁冲突任务必须重新进入本地队列并可取得调度轮次');
  await store.releaseDreaminaQueueTurn({ jobId: brokerRetry.id, token: brokerToken });
  const capacityRetry = await create('account-capacity-retry', 'card-capacity-retry');
  await store.updateMediaGenerationJob({ jobId: capacityRetry.id, patch: {
    status: 'queued', providerStatus: 'queued', providerErrorCode: 'DREAMINA_CONCURRENCY_LIMIT',
    submissionState: 'not_submitted', capacityRetrySafe: true,
  } });
  assert.equal(isDreaminaQueueReorderable(await store.getGenerationJob({ jobId: capacityRetry.id })), false, '真实厂商容量重试仍不得手动抢占队列');
  const foreign = { ...d, request: { settings: { adapter: 'cli', provider: 'LibTV' } } };
  assert.equal(isDreaminaQueueReorderable(foreign), false);
  assert.match(queueTaskMarkup({ ...red, queueProfileName: '<script>bad</script>' }), /&lt;script&gt;/u);
  assert.match(queueTaskMarkup(red), /核验原配置/u);
  assert.match(queueTaskMarkup({ ...red, queueModel: '5.0Pro' }), /模型：5\.0Pro/u, '队列条目必须显示所选模型');
  assert.match(queueTaskMarkup(bView), /停止并释放本机锁/u);
  const worker = await readFile(new URL('../src/server/media-generation-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /claimDreaminaQueueTurn/u);
  assert.match(worker, /releaseDreaminaQueueTurn/u);
  assert.match(worker, /onSubmissionAccepted/u, '厂商任务 ID 落盘后必须立即释放本地调度轮次');
  console.log('PASS: queued creation, physical lease, idempotency, atomic order, process reload, dispatch race, stop semantics, red/green/blue and provider isolation');
} finally { await rm(root, { recursive: true, force: true }); }
