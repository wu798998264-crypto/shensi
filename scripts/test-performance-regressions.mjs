import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { canonicalCanvas, updateCanvasViewport } from '../src/whiteboard.js';

const source = await readFile(new URL('../src/app.js', import.meta.url),'utf8');
const block = (from,to) => source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const viewportRuntime = block('const WHITEBOARD_VIEWPORT_GESTURE_COMMIT_DELAY =','const scheduleWhiteboardTextPersist =');
assert.doesNotMatch(source,/scheduleWhiteboardViewportRender|cancelWhiteboardViewportRender/u,'视口交互期间不得有延迟整板重绘计时器');
assert.doesNotMatch(viewportRuntime,/applyWhiteboardTransform\(documentState\);\s*flushWhiteboardGenerationDialogPosition\(\)/,'缩放帧内不得强制同步读取浮层布局');
assert.match(viewportRuntime,/scheduleWhiteboardWheelZoom[\s\S]*cancelWhiteboardMediaHydration\(\);[\s\S]*requestAnimationFrame/,'缩放期间必须暂停后台图片补载');
assert.match(source,/activeDrag\.mode === "pan"[\s\S]{0,180}whiteboardViewportDeferredRender = true/,'视口手势期间候选状态变化必须延后整板重绘');
assert.match(source,/const useProgressiveRender = virtualWindow\.nodes\.length > WHITEBOARD_PROGRESSIVE_RENDER_THRESHOLD\s*&& renderIdentityChanged/u,'大型白板渐进渲染只能用于首次呈现，不得在同一白板状态更新时从头重启');
assert.doesNotMatch(source,/if \(useProgressiveRender\) \{\s*elements\.whiteboardSurface\.classList\.add\("progressive-rendering"\);\s*existingCards\.forEach\(\(card\) => card\.classList\.remove\("progressive-ready"\)\)/u,'白板重绘不得清空已显示卡片的就绪状态造成闪白');
assert.match(source,/drag\.mode === "pan"[\s\S]{0,500}deferredViewportRender/,'平移结束必须收敛被延后的整板重绘');
assert.match(source,/whiteboardZoomOut\.addEventListener[\s\S]{0,260}zoomWhiteboardAt\(\{ zoom: zoom \/ 1\.2, deferCommit: true \}\)/,'缩小按钮必须延迟合并提交');
assert.match(source,/whiteboardZoomIn\.addEventListener[\s\S]{0,260}zoomWhiteboardAt\(\{ zoom: zoom \* 1\.2, deferCommit: true \}\)/,'放大按钮必须延迟合并提交');
assert.match(source,/whiteboardEditor\.addEventListener\("pointermove"[\s\S]{0,220}whiteboardDrag\?\.mode === "pan"\) return/,'平移期间不得计算无关的世界坐标和查找面板位置');
const original = canonicalCanvas({ nodes: [{id:'n',type:'text',text:'保持内容',kind:'text'}],edges:[],assets:[] });
let canvas=original;
for(let n=0;n<500;n++) {
  canvas=updateCanvasViewport(canvas,{x:n,zoom:1});
  assert.equal(canonicalCanvas(canvas),canvas);
  assert.equal(canvas.nodes,original.nodes,'视口移动不得重新规范化节点');
  assert.equal(canvas.assets,original.assets);
}
assert.equal(original.viewport.x,0);
const undo=[],redo=[];
const doc={documentKind:'whiteboard',canvas:updateCanvasViewport(original,{x:500})};
const navigation=vm.createContext({state:{activeDocument:'board',documents:{board:doc}},Date,
  whiteboardViewport:(d=doc)=>({...d.canvas.viewport}),activeWhiteboardDocument:()=>doc,
  whiteboardUndoStack:()=>undo,whiteboardRedoStack:()=>redo,syncWhiteboardHistoryControls:()=>{},
  updateCanvasViewport,nowTime:()=>'',persist:()=>{},renderWhiteboard:()=>{},
});
vm.runInContext(block('const pushWhiteboardViewportHistory =','const workspaceAssetsSnapshot ='),navigation);
for(let n=0;n<100;n++)vm.runInContext(`pushWhiteboardViewportHistory({x:${n},y:0,zoom:1});`,navigation);
assert.equal(undo.length,80);assert.ok(undo.every(action=>action.viewport&&!action.canvas));
doc.canvas=canonicalCanvas({...doc.canvas,nodes:[...doc.canvas.nodes,{id:'new-result',type:'text',kind:'generated',text:'新生成结果'}]});
vm.runInContext('restoreWhiteboardViewportHistory(whiteboardUndoStack().pop(),whiteboardRedoStack());',navigation);
assert.equal(doc.canvas.nodes.at(-1).text,'新生成结果','撤销视图不能撤销期间生成的内容');
assert.equal(doc.canvas.viewport.x,99);
vm.runInContext('restoreWhiteboardViewportHistory(whiteboardRedoStack().pop(),whiteboardUndoStack());',navigation);
assert.equal(doc.canvas.viewport.x,500);

const frames=[],painted=[],full=[];
const state={activeDocument:'doc',settings:{workspacePath:'W'}};
const ui={whiteboardCandidates:new Map(),whiteboardCandidateRenderPending:new Map(),whiteboardCandidateRenderFrame:0};
const context=vm.createContext({state,ui,requestAnimationFrame:fn=>(frames.push(fn),frames.length),
  whiteboardCandidateKey:(id,p)=>`${p.workspacePath}:${p.documentId}:${id}`,
  patchWhiteboardCandidateProgress:c=>(painted.push(c.nodeId),c.kind!=='full'),
  renderWhiteboardCandidateLocationNow:c=>full.push(c.nodeId),
});
vm.runInContext(block('const renderWhiteboardCandidateLocation =','const updateWhiteboardGenerationCandidate ='),context);
for(const id of ['A','B','C']) vm.runInContext(`renderWhiteboardCandidateLocation({nodeId:'${id}',workspacePath:'W',documentId:'doc'});`,context);
assert.equal(frames.length,1);frames.shift()();
assert.deepEqual(painted,['A','B','C'],'一帧内多个卡片都必须更新');
vm.runInContext("renderWhiteboardCandidateLocation({nodeId:'D',workspacePath:'W',documentId:'doc',kind:'full'});renderWhiteboardCandidateLocation({nodeId:'E',workspacePath:'W',documentId:'doc',kind:'full'});",context);
frames.shift()();assert.equal(full.length,1,'需要结构更新时只重绘一次');
vm.runInContext("renderWhiteboardCandidateLocation({nodeId:'old',workspacePath:'W',documentId:'doc'});",context);
state.activeDocument='other';frames.shift()();assert.ok(!painted.includes('old'));

let dialogs=0, reads=0;
const verified={state:'verified',expectedUserId:'fixture-id',verifiedAt:new Date().toISOString(),credentialExists:true};
let verdict=verified;
const auth=vm.createContext({String,Date,Boolean,Number,
  usesDreaminaAccountCredits:()=>true,dreaminaAccountForSettings:()=>null,
  ui:{dreaminaStatusReadAt:new Map()},elements:{dreaminaReverifyDialog:{open:false}},
  refreshDreaminaAccountStatus:async()=>{reads++;return verdict;},
  showToast:()=>{},openDreaminaReverifyDialog:()=>dialogs++,dreaminaAccountCredit:()=>100,
  dreaminaCreditEstimateForForm:()=>null,
});
vm.runInContext(block('const dreaminaAccountHasDurableIdentity =','const dreaminaStatusChannel ='),auth);
vm.runInContext(block('const ensureDreaminaGenerationAccountAvailable =','document.querySelector("#bindDreaminaAccount")'),auth);
assert.equal(await vm.runInContext("ensureDreaminaGenerationAccountAvailable({dreaminaCliProfile:'fixture'})",auth),true);
assert.equal(dialogs,0,'冷启动缓存为空、磁盘已核验时不能先弹核验窗口');assert.equal(reads,1);
for(const bad of [{...verified,state:'unbound',credentialExists:false},{...verified,state:'invalid'},{...verified,state:'mismatch'},{...verified,state:'duplicate'}]) {
  verdict=bad;
  assert.equal(await vm.runInContext("ensureDreaminaGenerationAccountAvailable({dreaminaCliProfile:'fixture'})",auth),false);
}
assert.equal(dialogs,4,'真正失效和账号不匹配仍要求处理');
const queued=[];
let savedAccount={...verified,verifiedAt:'2026-09-24T10:00:00Z'};
const recovered=vm.createContext({String,Date,
  dreaminaReverifyPromptedJobs:new Set(),dreaminaFailureNeedsVerification:()=>true,
  mediaGenerationSettingsForJob:()=>({provider:'即梦',adapter:'cli',dreaminaCliProfile:'fixture'}),
  rememberDreaminaJobForReverification:()=>{},refreshDreaminaAccountStatus:async()=>savedAccount,
  queueDreaminaReverification:payload=>queued.push(payload),mediaGenerationErrorText:()=>'',
});
vm.runInContext(block('const dreaminaAccountHasDurableIdentity =','const dreaminaStatusChannel ='),recovered);
vm.runInContext(block('const promptDreaminaReverificationForJob =','const promptDreaminaSubmissionBlockForJob ='),recovered);
vm.runInContext("promptDreaminaReverificationForJob({id:'old',status:'waiting_credentials',failedAt:'2026-09-23T10:00:00Z'});",recovered);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(queued.length,0,'旧失败任务不得覆盖之后的核验结果');
savedAccount={...verified,state:'invalid'};
vm.runInContext("promptDreaminaReverificationForJob({id:'new',status:'waiting_credentials',failedAt:'2026-09-24T11:00:00Z'});",recovered);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(queued.length,1,'真实新认证失败仍显示核验入口');
const warm={state:{marker:'latest'},stateStamp:'latest',prepared:true};
const cacheUi={workspacePrefetchTimer:null,workspacePrefetches:new Map([['workspace',new Promise(()=>{})]]),workspaceStateCache:new Map([['workspace',warm]])};
const switching=vm.createContext({ui:cacheUi,clearTimeout,Map,workspaceCacheKey:()=> 'workspace',fetchWorkspacePayload:()=>{throw Error('Unexpected duplicate read');}});
vm.runInContext(block('const loadWorkspaceSwitchTarget =','const revalidateActivatedWorkspace ='),switching);
const switched=await Promise.race([vm.runInContext("loadWorkspaceSwitchTarget({workspaceKind:'project',workspacePath:'workspace'})",switching),new Promise((_,reject)=>setTimeout(()=>reject(Error('Warm cache waited for stale prefetch')),100))]);
assert.equal(switched.state,warm.state);
console.log('Viewport graph reuse, multi-card frame coalescing, cold-start authorization and real invalid-account gates passed');
