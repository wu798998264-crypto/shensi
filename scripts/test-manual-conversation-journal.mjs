import assert from 'node:assert/strict';
import { journalManualConversation, restoreManualConversations, forgetManualConversation } from '../src/manual-conversation-journal.js';
const data = new Map();
const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) };
const state = { workspaceKind:'notebook', settings:{workspacePath:'C:/work'}, conversations:[], activeConversationId:'manual' };
const conversation = { id:'manual', title:'新对话', manualCreated:true, messages:[] };
journalManualConversation(storage,state,conversation);
restoreManualConversations(storage,state);
assert.equal(state.conversations[0].id,'manual');
assert.equal(state.activeConversationId,'manual');
state.conversations[0].messages.push({content:'newer'});
restoreManualConversations(storage,state);
assert.equal(state.conversations[0].messages[0].content,'newer');
const canonicalState = {
  ...state,
  activeConversationId: 'latest',
  conversations: [
    { id: 'latest', title: '最新对话', messages: [{ content: '最新内容' }] },
    ...state.conversations,
  ],
};
restoreManualConversations(storage, canonicalState);
assert.equal(canonicalState.activeConversationId, 'latest', '旧的 localStorage 活动指针不得覆盖规范工作区当前对话');
const other = {...state,settings:{workspacePath:'C:/other'},conversations:[]};
restoreManualConversations(storage,other);
assert.equal(other.conversations.length,0);
forgetManualConversation(storage,state,'manual');
state.conversations=[];
restoreManualConversations(storage,state);
assert.equal(state.conversations.length,0);
console.log('Manual empty conversations survive interrupted save; newer messages, isolation and explicit deletion preserved');
