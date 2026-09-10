import assert from 'node:assert/strict';
import {mkdtemp,readFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConversationAgentService} from '../src/server/conversation-agent-service.mjs';
const root=await mkdtemp(join(tmpdir(),'shensi-event-journal-'));
try {
  let ready=false;
  const service=createConversationAgentService({appRoot:root,storageRoot:root,skillCatalog:async()=>[],readRoute:async()=>'',toolsFactory:()=>({dynamicTools:[]}),run:async({onToolEvent})=>{
    for(let i=0;i<200;i++) await onToolEvent({phase:'completed',name:'documents.read',success:true});
    ready=true; await new Promise(()=>{});
  }});
  const run=await service.start({workspacePath:root,conversationId:'journal',sourceMessageId:'j1',messages:[{role:'user',content:'检查'}],settings:{}});
  for(let i=0;i<500&&!ready;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(ready);
  const baseline=JSON.parse(await readFile(join(root,run.id+'.json'),'utf8'));
  assert.equal(baseline.events.length,0,'非终态不得为每条事件重写完整快照');
  const journal=await readFile(join(root,run.id+'.json.events'),'utf8');
  assert.equal(journal.trim().split('\n').length,201);
  await appendFile(join(root,run.id+'.json.events'),'{"partial":');
  const recovered=createConversationAgentService({appRoot:root,storageRoot:root});
  const state=await recovered.status(run.id);
  assert.equal(state.status,'interrupted');
  assert.equal(state.lastSequence,201,'断电留下的尾部残片不能丢弃已完整写入事件');
  const last=await recovered.status(run.id,200);
  assert.equal(last.events[0].sequence,201);
  console.log('200 incremental events, unchanged baseline, crash-tail replay and cursor recovery passed');
} finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
