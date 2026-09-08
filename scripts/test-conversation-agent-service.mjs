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
  const saved = await loadWorkspaceState({ appRoot: root, requestedPath: workspacePath });
  assert.ok(saved.state.histories['agent-note'].length >= 2);
  assert.match(saved.state.documents['agent-note'].markdown, /局部修订/u);

  const waiting = new Map();
  const service = createConversationAgentService({ appRoot: root, storageRoot: join(root, 'sessions'), skillCatalog: async () => [], readRoute: async () => '按任务阶段加载技能', run: async ({ sessionId, workspaceToolRuntime }) => {
    waiting.set(sessionId, true);
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
  assert.equal(waiting.size, 2, 'two conversations must execute concurrently');
  await assert.rejects(service.answer(a.id, qb.id, '串线'), /过期/u);
  await service.answer(a.id, qa.id, '我的其他想法');
  await service.cancel(b.id);
  await new Promise((done) => setTimeout(done, 40));
  assert.equal((await service.status(a.id)).text, '我的其他想法');
  assert.equal((await service.status(b.id)).status, 'cancelled');
  const restarted = createConversationAgentService({ appRoot: root, storageRoot: join(root, 'sessions') });
  assert.equal((await restarted.status(a.id)).text, '我的其他想法');
  console.log('Conversation Agent tools, full-history writes, two concurrent conversations, free answers, cancellation and durable status passed');
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}
