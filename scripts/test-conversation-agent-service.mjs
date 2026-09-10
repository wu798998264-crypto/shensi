import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createConversationAgentService } from '../src/server/conversation-agent-service.mjs';
import { createConversationAgentTools } from '../src/server/conversation-agent-tools.mjs';
import { createBlankNotebookState } from '../src/data.js';
import { saveWorkspaceState, loadWorkspaceState } from '../src/server/workspace.mjs';

const root = await mkdtemp(join(tmpdir(), 'shensi-agent-native-'));
try {
  const workspacePath = join(root, 'runtime', 'E-drive-data', '笔记', 'Agent测试');
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state: createBlankNotebookState({ name: 'Agent测试' }) });
  const tools = createConversationAgentTools({ appRoot: root, workspacePath, workspaceKind: 'notebook', requestId: 'request-12345678', sourceMessageId: 'user-12345678', instruction: '创建文档，然后追加并局部替换保存', catalog: [], signal: new AbortController().signal });
  const call = async (tool, args) => {
    const result = await tools.invoke({ namespace: 'documents', tool, arguments: args });
    assert.equal(result.success, true, result.contentItems[0].text);
    return JSON.parse(result.contentItems[0].text);
  };
  await call('write', { operation: 'create', documentId: 'agent-note', title: 'Agent文档', content: '这是一段真实初稿。', operationId: 'create-one' });
  let doc = await call('read', { documentId: 'agent-note' });
  assert.ok(doc.revision);
  await call('write', { operation: 'append', documentId: 'agent-note', content: '\n\n追加的新段落。', expectedRevision: doc.revision, operationId: 'append-one' });
  doc = await call('read', { documentId: 'agent-note' });
  assert.match(doc.content, /真实初稿/u);
  await call('write', { operation: 'patch', documentId: 'agent-note', patches: [{ type: 'block', original: '真实初稿', content: '局部修订' }], expectedRevision: doc.revision, operationId: 'patch-one' });
  doc = await call('read', { documentId: 'agent-note' });
  await call('write', { operation: 'replace', documentId: 'agent-note', content: '完整覆盖后的正文。', expectedRevision: doc.revision, operationId: 'replace-one' });
  const saved = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  assert.equal(saved.state.histories['agent-note'].length, 3);
  assert.match(saved.state.histories['agent-note'][0].content, /局部修订/u, '覆盖前必须保存完整正文');
  assert.match(saved.state.histories['agent-note'][1].content, /真实初稿[\s\S]*追加的新段落/u, '局部替换前必须保存完整正文');
  assert.equal(saved.state.histories['agent-note'][2].content, '这是一段真实初稿。', '续写/追加前必须保存完整正文');
  assert.equal(saved.state.documents['agent-note'].markdown, '完整覆盖后的正文。');

  const skillReads = [];
  const skillTools = createConversationAgentTools({
    appRoot: root,
    workspacePath,
    workspaceKind: 'notebook',
    requestId: 'request-skill-alias',
    sourceMessageId: 'user-skill-alias',
    instruction: '读取所需 Skill',
    catalog: [{ id: 'builtin:creative-guidance', name: '创作引导', description: '引导创作方向', capabilities: ['novel_guidance'] }],
    readSkill: async (id) => {
      skillReads.push(id);
      return { id, name: '创作引导', text: '真实 Skill 全文', fullText: true, contentHash: 'skill-hash' };
    },
    signal: new AbortController().signal,
  });
  for (const argumentsValue of [
    { id: 'builtin:creative-guidance' },
    { skillId: 'builtin:creative-guidance' },
    { skill_id: 'builtin:creative-guidance' },
    { selection: { name: '创作引导' } },
    { name: '创作引导' },
  ]) {
    const result = await skillTools.invoke({ namespace: 'skills', tool: 'read', arguments: argumentsValue });
    assert.equal(result.success, true, result.contentItems[0].text);
  }
  assert.deepEqual(skillReads, Array(5).fill('builtin:creative-guidance'), 'Skill 参数别名必须解析到目录中的唯一真实 ID');

  const waiting = new Map();
  let choiceProtocol = '';
  const service = createConversationAgentService({ appRoot: root, storageRoot: join(root, 'sessions'), skillCatalog: async () => [], readRoute: async () => '按任务阶段加载技能', run: async ({ sessionId, workspaceToolRuntime, contextBlocks, deliveryReview, prompt }) => {
    if (deliveryReview) return {text: JSON.parse(prompt).result};
    choiceProtocol = contextBlocks.find((block) => block.name === '动态选择交互')?.text || '';
    waiting.set(sessionId, true);
    await workspaceToolRuntime.invoke({ namespace: 'interaction', tool: 'delivery', arguments: { mode: 'conversation', documentIds: [] } });
    const result = await workspaceToolRuntime.invoke({ namespace: 'interaction', tool: 'ask', arguments: { question: '方向？', options: ['方向甲', '方向乙'] } });
    return { text: JSON.parse(result.contentItems[0].text).answer };
  } });
  const request = { workspacePath, workspaceKind: 'notebook', conversationId: 'conv-a', messages: [{ role: 'user', content: '帮我构思' }], settings: { agentEngine: 'codex_api', model: 'mock', apiKey: 'mock-secret' } };
  const a = await service.start(request);
  const b = await service.start({ ...request, conversationId: 'conv-b' });
  await assert.rejects(service.start(request), { code: 'AGENT_CONVERSATION_BUSY' });
  const question = async (run) => {
    for (let i = 0; i < 100; i++) {
      const status = await service.status(run.id);
      const event = status.events.find((event) => event.type === 'question');
      if (event) return event.payload;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Question timeout');
  };
  const [qa, qb] = await Promise.all([question(a), question(b)]);
  assert.match(choiceProtocol, /必须调用 interaction\.ask/u, '有限选择必须使用结构化选择工具');
  assert.match(choiceProtocol, /1\/2\/3\/4[\s\S]*不是选择题[\s\S]*不得调用 interaction\.ask/u, '普通编号说明不得误转为选择框');
  assert.match(choiceProtocol, /不要用正文关键词、编号或固定模板推断选择框/u, '不得退回正文关键词解析');
  assert.equal(waiting.size, 2, 'two conversations must execute concurrently');
  await assert.rejects(service.answer(a.id, qb.id, '串线'), /过期/u);
  const [firstAnswer, duplicateAnswer] = await Promise.all([
    service.answer(a.id, qa.id, '我的其他想法'),
    service.answer(a.id, qa.id, '第二次点击不应重复接受'),
  ]);
  assert.deepEqual(firstAnswer, { accepted: true });
  assert.deepEqual(duplicateAnswer, { accepted: true }, '同一决策的快速重复回答应共享一次接受结果');
  const answerStatus = await service.status(a.id);
  const acceptedEvents = answerStatus.events.filter((event) => event.type === 'answer_accepted' && event.payload.decisionId === qa.id);
  assert.equal(acceptedEvents.length, 1, '同一决策只能写入一条 answer_accepted 事件');
  assert.ok(answerStatus.events.some((event) => event.type === 'progress' && /继续生成/u.test(event.payload.message)), '答案接受后必须明确发出恢复运行进度');
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(await service.answer(a.id, qa.id, '我的其他想法'), { accepted: true }, '接受后响应丢失的重试不能变成过期错误');
  await service.cancel(b.id);
  await new Promise((done) => setTimeout(done, 40));
  assert.equal((await service.status(a.id)).text, '我的其他想法');
  assert.equal((await service.status(b.id)).status, 'cancelled');
  const restarted = createConversationAgentService({ appRoot: root, storageRoot: join(root, 'sessions') });
  assert.equal((await restarted.status(a.id)).text, '我的其他想法');

  const interruptedStorage = join(root, 'interrupted-sessions');
  const orphaned = createConversationAgentService({ appRoot: root, storageRoot: interruptedStorage, skillCatalog: async () => [], readRoute: async () => 'route', run: async () => new Promise(() => {}) });
  const orphan = await orphaned.start({ ...request, conversationId: 'conv-orphan', sourceMessageId: 'orphan-message' });
  for (let index = 0; index < 100; index += 1) {
    const status = await orphaned.status(orphan.id);
    if (status.events.some((event) => event.type === 'started')) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const recovered = createConversationAgentService({ appRoot: root, storageRoot: interruptedStorage });
  assert.equal((await recovered.status(orphan.id)).status, 'interrupted');
  const recoveredAgain = createConversationAgentService({ appRoot: root, storageRoot: interruptedStorage });
  assert.equal((await recoveredAgain.status(orphan.id)).status, 'interrupted', '服务重启恢复状态必须真正持久化');
  console.log('Conversation Agent tools, exact full-history writes, two concurrent conversations, free answers, cancellation and durable restart status passed');
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
