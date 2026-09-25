import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// An opt-in desktop acceptance: copies the named canvas and its referenced
// files, never opens/saves the original workspace or submits a provider job.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.SHENSI_PERF_SOURCE_ROOT || 'E:/ShensiUserData/笔记/我的笔记');
const sourceCanvas = join(sourceRoot, '向天垂钓/预告片.canvas');
const sourceBytes = await readFile(sourceCanvas);
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
const canvas = JSON.parse(sourceBytes);
const count = Number(process.env.SHENSI_PERF_NODE_COUNT) || canvas.nodes.length;
const label = String(process.env.SHENSI_PERF_LABEL || 'current').replace(/[^a-z0-9-]/gi, '');
const acceptanceRoot = 'E:/ShensiUserData/验收';
await mkdir(acceptanceRoot, { recursive: true });
const runtimeRoot = await mkdtemp(join(acceptanceRoot, `预告片性能-${label}-`));
const dataRoot = join(runtimeRoot, 'data');
const debugPort = Number(process.env.SHENSI_PERF_PORT) || 9462;
const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [
  `--remote-debugging-port=${debugPort}`, join(root, 'packaging/windows/desktop-app'),
], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SHENSI_DATA_ROOT: dataRoot, SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DESKTOP_USER_DATA_ROOT: join(runtimeRoot, 'desktop'), SHENSI_SKIP_UPDATE_CHECK: '1', SHENSI_TEST_DESKTOP_RUNTIME: '1' },
});
let errors = '';
child.stderr.on('data', x => { errors = (errors + x).slice(-4000); });
child.stdout.resume();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let socket;
const report = { sourceHash, runtimeRoot, originalNodes: canvas.nodes.length, nodes: count, originalVideos: canvas.nodes.filter(n => n.kind === 'video').length };
try {
  let target;
  for (let n = 0; n < 300 && !target; n++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:')); } catch {}
    if (!target) await sleep(100);
  }
  assert.ok(target, errors);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => socket.addEventListener('open', r, { once: true }));
  let sequence = 0;
  const waiting = new Map();
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data));
    const p = waiting.get(msg.id);
    if (p) { waiting.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    waiting.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async expression => {
    for (let n = 0; n < 400; n++) {
      try { if (await evaluate(`Boolean(${expression})`)) return; }
      catch(error) { if (!/null|context|navigat/iu.test(error.message)) throw error; }
      await sleep(50);
    }
    throw new Error(`Not ready: ${expression}`);
  };
  const click = async selector => {
    await cdp('Page.bringToFront');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e?.getBoundingClientRect(); return r && { x:r.x+r.width/2,y:r.y+r.height/2 }; })()`);
    assert.ok(p, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
  };
  await waitFor("document.documentElement?.dataset.bootReady === 'true'");
  await evaluate("localStorage.setItem('shensi:creative-start-welcome:v1','seen'); document.querySelector('#creativeStartWelcomeDialog')?.close()");
  // Fixture setup is not part of the measured gesture workload below.
  await evaluate("document.querySelector('#projectButton').click()");
  await waitFor("document.querySelector('#newWorkspaceButton')");
  await evaluate("document.querySelector('#newWorkspaceButton').click()");
  await waitFor("document.querySelector('#textDialog')?.open");
  await evaluate("document.querySelector('#textDialogInput').value = '预告片性能副本'; document.querySelector('#textDialogForm').requestSubmit()");
  await waitFor("document.querySelector('#projectButton').textContent.includes('预告片性能副本') && document.querySelector('.autosave-state')?.dataset.state === 'saved'");
  const workspacePath = await evaluate("fetch('/api/recovery/session').then(r=>r.json()).then(p=>p.activeWorkspace.workspacePath)");
  report.workspacePath = workspacePath;
  const refs = new Set();
  for (const node of canvas.nodes) { if (node.file) refs.add(node.file); if (node.thumbnailRelativePath) refs.add(node.thumbnailRelativePath); }
  for (const asset of canvas.assets || []) { for (const file of [asset.attachment?.relativePath, asset.attachment?.thumbnailRelativePath, asset.mediaBatchIndexPath]) if (file) refs.add(file); }
  for (const file of refs) {
    const src = resolve(sourceRoot, file), dest = resolve(workspacePath, file);
    assert.ok(!relative(sourceRoot, src).startsWith('..') && !isAbsolute(relative(sourceRoot, src)));
    assert.ok(!relative(workspacePath, dest).startsWith('..') && !isAbsolute(relative(workspacePath, dest)));
    await mkdir(dirname(dest), { recursive: true }); await copyFile(src, dest);
  }
  report.copiedFiles = refs.size;
  if (count > canvas.nodes.length) {
    const originals = [...canvas.nodes]; const edges = [...canvas.edges];
    for (let batch = 1; canvas.nodes.length < count; batch++) {
      const nodes = originals.slice(0, count - canvas.nodes.length).map(n => ({ ...n, id: `${n.id}-perf-${batch}`, x: n.x + batch * 12000 }));
      const ids = new Set(nodes.map(n => n.id));
      canvas.nodes.push(...nodes);
      canvas.edges.push(...edges.map(e => ({ ...e, id: `${e.id}-perf-${batch}`, fromNode: `${e.fromNode}-perf-${batch}`, toNode: `${e.toNode}-perf-${batch}` })).filter(e => ids.has(e.fromNode) && ids.has(e.toNode)));
    }
  }
  report.videoNodes = canvas.nodes.filter(node => node.kind === 'video').length;
  report.edges = canvas.edges.length;
  // Seed through the same transaction API as the app; the target is the fresh copy.
  await evaluate(`(async()=>{
    const workspacePath=${JSON.stringify(workspacePath)};
    const headers={'content-type':'application/json','x-shensi-session':document.querySelector('meta[name="shensi-session-token"]').content};
    const loaded=await fetch('/api/workspace/load',{method:'POST',headers,body:JSON.stringify({workspacePath})}).then(r=>r.json());
    const state=loaded.state, id='trailer-performance';
    state.documents[id]={title:'预告片（性能副本）',moduleId:'manuscript',documentKind:'whiteboard',canvas:${JSON.stringify(canvas)}};
    state.moduleItems.manuscript.push([id,'预告片（性能副本）']); state.activeDocument=id; state.activeModule='manuscript';
    const saved=await fetch('/api/workspace/save',{method:'POST',headers,body:JSON.stringify({workspacePath,state,expectedStateStamp:loaded.stateStamp})}).then(r=>r.json());
    if(!saved.ok)throw Error(saved.message);
    await fetch('/api/recovery/session',{method:'POST',headers,body:JSON.stringify({activeWorkspace:{workspacePath,workspaceKind:'project',projectName:state.projectName,activeModule:'manuscript',activeDocument:id,resumeRevision:Date.now()}})});
  })()`);
  await cdp('Page.reload', { ignoreCache: true });
  await waitFor(`document.querySelector('#whiteboardEditor')?.dataset.totalNodeCount === '${count}'`);
  console.log(JSON.stringify({phase:'canvas-loaded',count,runtimeRoot}));
  await sleep(1600);
  await cdp('Profiler.enable'); await cdp('Profiler.start');
  await evaluate(`window.__perf={frames:[],phaseFrames:{idle:[],zoom:[],pan:[],card:[]},phase:'idle',longTasks:[]}; window.__perfRunning=true;
    new PerformanceObserver(list=>window.__perf.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});
    let last=performance.now(); function tick(t){ if(!window.__perfRunning)return; const delta=t-last; window.__perf.frames.push(delta); (window.__perf.phaseFrames[window.__perf.phase]??= []).push(delta); last=t;requestAnimationFrame(tick); }requestAnimationFrame(tick);`);
  const bounds = await evaluate("(()=>{const r=document.querySelector('#whiteboardEditor').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  // Real wheel events and pointer drags in the Electron window.
  await evaluate("window.__perf.phase='zoom'");
  for (let i = 0; i < 36; i++) {
    await cdp('Input.dispatchMouseEvent', { type:'mouseWheel', ...bounds, deltaX:0, deltaY:i<18?-24:24, modifiers:2 });
    await sleep(17);
  }
  console.log(JSON.stringify({phase:'zoom-complete',count}));
  await evaluate("window.__perf.phase='idle'");
  await sleep(250);
  await evaluate("window.__perf.phase='pan'");
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...bounds,button:'left',clickCount:1});
  for(let i=1;i<=50;i++){ await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x-i*12,y:bounds.y-i*5,button:'left',buttons:1});await sleep(17); }
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:bounds.x-600,y:bounds.y-250,button:'left',clickCount:1});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  console.log(JSON.stringify({phase:'pan-complete',count}));
  await evaluate("window.__perf.phase='idle'");
  await sleep(750);
  const cardPoint=await evaluate(`(()=>{const r=document.querySelector('#whiteboardEditor').getBoundingClientRect();for(const c of document.querySelectorAll('[data-canvas-node]')){const b=c.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(x>r.x+40&&x<r.right-60&&y>r.y+40&&y<r.bottom-60&&document.elementFromPoint(x,y)?.closest('[data-canvas-node]')===c)return {id:c.dataset.canvasNode,x,y}}return null})()`);
  assert.ok(cardPoint,'可见卡片');
  await evaluate("window.__perf.phase='card'");
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:cardPoint.x,y:cardPoint.y,button:'left',clickCount:1});
  for(let i=1;i<=35;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:cardPoint.x+i*2,y:cardPoint.y+i,button:'left',buttons:1});await sleep(17);}
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:cardPoint.x+70,y:cardPoint.y+35,button:'left',clickCount:1});
  console.log(JSON.stringify({phase:'card-drag-complete',count}));
  await evaluate("window.__perf.phase='idle'");
  await sleep(600);
  const {profile}=await cdp('Profiler.stop');
  const totals=new Map(), frames=new Map(profile.nodes.map(n=>[n.id,n.callFrame]));
  profile.samples.forEach((id,i)=>totals.set(id,(totals.get(id)||0)+(profile.timeDeltas[i]||0)));
  report.cpu=Array.from(totals).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([id,us])=>({name:frames.get(id).functionName,line:frames.get(id).lineNumber+1,ms:Math.round(us/1000)}));
  report.interaction=await evaluate(`window.__perfRunning=false; (()=>{const summarize=values=>{const f=values.filter(n=>n>0).sort((a,b)=>a-b);return {frames:f.length,p95:f[Math.floor(f.length*.95)]||0,p99:f[Math.floor(f.length*.99)]||0,max:f.length?Math.max(...f):0}};return {...summarize(window.__perf.frames),phases:Object.fromEntries(Object.entries(window.__perf.phaseFrames).map(([name,values])=>[name,summarize(values)])),longTasks:window.__perf.longTasks,rendered:document.querySelectorAll('[data-canvas-node]').length,videos:document.querySelectorAll('#whiteboardSurface video').length,pendingImages:document.querySelectorAll('[data-whiteboard-deferred-src]').length}})()`);
  const start=Date.now(); await click('#settingsButton'); await waitFor("document.querySelector('#settingsDialog')?.open && document.querySelector('#settingsDialog')?.getAttribute('aria-busy') !== 'true'");
  report.settingsReadyMs=Date.now()-start;
  await click('#closeSettings');
  if (Number(process.env.SHENSI_PERF_SOAK_MS)>0) {
    await cdp('Performance.enable');
    const metrics=async()=>Object.fromEntries((await cdp('Performance.getMetrics')).metrics
      .filter(x=>['JSHeapUsedSize','Nodes','Documents'].includes(x.name)).map(x=>[x.name,x.value]));
    const before=await metrics(), deadline=Date.now()+Math.min(180000,Number(process.env.SHENSI_PERF_SOAK_MS));
    let cycles=0;
    while(Date.now()<deadline){
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...bounds,button:'left',clickCount:1});
      const direction=cycles%2?1:-1;
      for(let i=1;i<=18;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:bounds.x+direction*i*8,y:bounds.y,button:'left',buttons:1});await sleep(17);}
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:bounds.x+direction*144,y:bounds.y,button:'left',clickCount:1});
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
      await sleep(160);
      if(++cycles%20===0)console.log(JSON.stringify({phase:'soak',cycles}));
    }
    await waitFor("document.querySelector('.autosave-state')?.dataset.state === 'saved'");
    report.soak={cycles,before,after:await metrics()};
  }
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(runtimeRoot,'desktop-trailer.png'),Buffer.from(shot.data,'base64'));
  assert.equal(createHash('sha256').update(await readFile(sourceCanvas)).digest('hex'),sourceHash,'原白板内容必须保持不变');
  report.sourceUnchanged=true;
  await writeFile(join(runtimeRoot,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} catch(error) { console.error(error.stack); console.error(errors.slice(-1000)); process.exitCode=1; }
finally {
  socket?.close();
  // This is only the child Electron test process; the installed user's app is untouched.
  if(child.exitCode==null){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(r=>{killer.once('exit',r);killer.once('error',r);});}
}
