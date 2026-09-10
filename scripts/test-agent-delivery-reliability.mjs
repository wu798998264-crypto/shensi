import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationAgentService } from '../src/server/conversation-agent-service.mjs';
import { createConversationAgentTools } from '../src/server/conversation-agent-tools.mjs';
import { createBlankNotebookState } from '../src/data.js';
import { saveWorkspaceState, loadWorkspaceState } from '../src/server/workspace.mjs';
const root = await mkdtemp(join(tmpdir(), 'shensi-delivery-check-'));
try {
  const workspacePath = join(root, 'runtime', 'E-drive-data', '笔记', '交付测试');
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state: createBlankNotebookState({name:'交付测试', workspacePath}) });
  const base = {appRoot:root,workspacePath,workspaceKind:'notebook',requestId:'create-original',sourceMessageId:'user-original',instruction:'新建文章'};
  const seed = createConversationAgentTools(base);
  const invoke = async (tools, namespace, tool, args) => {
    const result = await tools.invoke({namespace,tool,arguments:args});
    assert.equal(result.success,true,result.contentItems[0].text);
    return JSON.parse(result.contentItems[0].text);
  };
  await invoke(seed,'documents','write',{operation:'create',documentId:'article',title:'未命名',content:'这是需要完整保留的旧文章内容。',operationId:'seed'});
  let calls=0;
  const service=createConversationAgentService({appRoot:root,storageRoot:join(root,'runs'),skillCatalog:async()=>[],readRoute:async()=>'',run:async ({workspaceToolRuntime:tools})=>{
    calls++;
    if(calls===1) {
      await invoke(tools,'interaction','delivery',{mode:'documents',documentIds:['article']});
      return {text:'已经完成写入。'}; // deliberately false: must not become success
    }
    const current=await invoke(tools,'documents','read',{documentId:'article'});
    await invoke(tools,'documents','write',{operation:'replace',documentId:'article',title:'新的文章标题',content:'这是新文章完整的正式正文内容。',expectedRevision:current.revision,operationId:'replace'});
    return {text:'已通过验收。'};
  }});
  const request={workspacePath,workspaceKind:'notebook',conversationId:'delivery',sourceMessageId:'user-delivery',instruction:'将新文章保存到目标并更新标题',messages:[{role:'user',content:'保存文章'}],settings:{agentEngine:'codex_api',model:'mock'}};
  const wait=async(service,id)=>{
    for(let i=0;i<400;i++) {const r=await service.status(id);if(['failed','completed'].includes(r.status))return r;await new Promise(r=>setTimeout(r,10));}
    throw Error('delivery timeout');
  };
  const result=await wait(service,(await service.start(request)).id);
  assert.equal(result.status,'completed',result.error); assert.equal(calls,2);
  assert.ok(result.events.some(e=>e.type==='progress'));
  assert.ok(result.events.some(e=>e.type==='document_saved'&&e.payload.trustedDocumentSave));
  assert.ok(result.events.some(e=>e.type==='resource_read'&&e.payload.title==='未命名'));
  const loaded=await loadWorkspaceState({appRoot:root,requestedPath:workspacePath});
  assert.equal(loaded.state.documents.article.title,'新的文章标题');
  assert.match(loaded.state.documents.article.markdown,/新文章完整/);
  assert.match(loaded.state.histories.article[0].content,/完整保留的旧文章/);
  let stubbornCalls=0;
  const stubborn=createConversationAgentService({appRoot:root,storageRoot:join(root,'failures'),skillCatalog:async()=>[],readRoute:async()=>'',run:async()=>{stubbornCalls++;return {text:'声称完成但没有工具证据'};}});
  const failure=await wait(stubborn,(await stubborn.start({...request,conversationId:'stubborn'})).id);
  assert.equal(failure.status,'failed');assert.equal(stubbornCalls,3);
  assert.equal(failure.events.filter(e=>e.type==='document_saved').length,0);
  assert.match(failure.text,/没有工具证据/);
  const events=[];
  const reader=createConversationAgentTools({...base,catalog:[{id:'skill',name:'真实技能'}],readSkill:async()=>({name:'真实技能',text:'实际内容',fullText:true}),emit:(type,payload)=>events.push({type,payload}),load:async()=>({state:{documents:{empty:{title:'空文档',markdown:''},full:{title:'非空文档',markdown:'123456'}}}})});
  await invoke(reader,'documents','read',{documentId:'empty'});
  assert.equal(events.length,0);
  await invoke(reader,'documents','read',{documentId:'full',length:2});
  await invoke(reader,'skills','read',{id:'skill'});
  assert.equal(events.length,2);assert.equal(events[0].payload.fullText,false);assert.equal(events[1].payload.title,'真实技能');
  console.log('Delivery repair, bounded failure, verified title/body transaction, full history and actual nonempty read evidence passed');
} finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
