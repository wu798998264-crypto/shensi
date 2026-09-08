import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(root, "artifacts", "v2185-guided-novel-ui");
const runtimeRoot = await mkdtemp(join(tmpdir(), "ShensiGuidedNovel-"));
const userDataRoot = join(runtimeRoot, "electron-user");
const buildId = String(process.env.SHENSI_GUIDED_NOVEL_BUILD_ID || new Date().toISOString().replace(/\D/gu, "").slice(0, 17));
const dataRoot = String(process.env.SHENSI_GUIDED_NOVEL_DATA_ROOT || join(artifactsRoot, `data-${buildId}`));
const configuredStatePath = String(process.env.SHENSI_GUIDED_NOVEL_SETTINGS_STATE || "E:\\ShensiUserData\\笔记\\我的笔记\\.shensi\\current-state.json");
const configuredState = JSON.parse(await readFile(configuredStatePath, "utf8"));
const installedSettings = { ...(configuredState.settings || {}) };
const useMockTextModel = process.env.SHENSI_GUIDED_NOVEL_MOCK_MODEL === "1";
let mockTextServer = null;
const mockTextRequests = [];
let mockTextBaseUrl = "";
if (useMockTextModel) {
  const inputTextOf = (body = {}) => {
    const input = Array.isArray(body.input) ? body.input : [];
    return input.flatMap((item) => Array.isArray(item?.content) ? item.content : [item?.content])
      .map((item) => typeof item === "string" ? item : item?.text || "")
      .join("\n");
  };
  const latestUserPrompt = (inputText = "") => {
    const marker = inputText.lastIndexOf('{"recentMessages":');
    if (marker < 0) return "";
    try {
      const payload = JSON.parse(inputText.slice(marker));
      return [...(payload.recentMessages || [])].reverse().find((item) => item.role === "user")?.content || "";
    } catch { return ""; }
  };
  const guidanceState = (questionCluster = "core-promise", question = "你最希望读者追更时反复获得哪一种满足？", completedClusters = []) => ({
    deliverableType: "novel", question, questionCluster, completedClusters, delegatedClusters: [], decisions: [],
    briefSummary: "作者正在逐步形成长篇爽文创作合同。", interactionMode: "discussion", candidateOptions: [], recommendation: "", tradeoffs: [],
  });
  const planningJson = (prompt = "") => {
    const isAsset = /正式内容自动写入|记入当前作品|当前作品相关设定|资料、设定和全书大纲/u.test(prompt);
    const chapter = prompt.match(/现在直接创作《雾都铜心》第\s*(\d+)\s*章《([^》\n]+)》/u);
    if (isAsset || chapter) return JSON.stringify({
      action: "generate", taskType: chapter ? "小说正文" : "小说正式结构资产", target: chapter ? `第${chapter[1]}章 ${chapter[2].trim()}` : "当前作品正式资料、设定与全书大纲",
      intent: prompt.slice(0, 600), capsule: "只依据已确认事实生成正式内容。", evidencePlan: [], productionPlan: ["生成并通过确定性检查"],
      hardConstraints: ["不得输出内部协议", "不得写入空占位"], desiredEffects: ["形成可回读的正式内容"], chapterMission: chapter ? "推进" : "资料归档",
      narrativeMode: chapter ? "外部行动与对话博弈" : "结构化资料", endingFunction: "因果性悬念", protectedAssets: ["叶昭", "铜心", "九炉"], recentReuseRisks: [], canonRisks: [],
      decisionGap: { key: "", impact: "ordinary", inferable: true, alreadyAnswered: true, evidence: "" }, plotAssessment: null, conceptBindings: [], narrativeLock: null, guidanceState: null,
      routeAdaptation: { decision: "stay", confidence: "high", reason: "用户已明确要求正式产出", evidence: [prompt.slice(0, 100)] }, contextAssessment: { sufficient: true, confidence: "high", needs: [] },
    });
    const cluster = /叶昭的父亲|进一步确认/u.test(prompt) ? "information-foreshadowing" : /我的决定|架空晚清/u.test(prompt) ? "protagonist-engine" : "core-promise";
    const question = cluster === "information-foreshadowing" ? "哪一个秘密必须最晚揭示，又要在前文留下什么证据？" : cluster === "protagonist-engine" ? "叶昭最不能退让的目标是什么，失败会立刻失去什么？" : "你最希望读者追更时反复获得哪一种满足？";
    return JSON.stringify({ action: "ask", taskType: "小说创作引导", target: "长篇爽文创作合同", intent: "通过一问一答逐步明确创作方向", question, capsule: "当前仍需确认一个关键创作决策。", evidencePlan: [], productionPlan: [], hardConstraints: ["本轮不写正文", "每轮只问一个问题"], desiredEffects: ["逐步形成可执行的长篇创作合同"], canonRisks: [], decisionGap: { key: cluster, impact: "major", inferable: false, alreadyAnswered: false, evidence: "该决策会改变后续结构" }, plotAssessment: null, conceptBindings: [], narrativeLock: null, guidanceState: guidanceState(cluster, question, cluster === "core-promise" ? [] : [cluster === "protagonist-engine" ? "core-promise" : "protagonist-engine"]), routeAdaptation: { decision: "stay", confidence: "high", reason: "当前仍在专项创作引导", evidence: [] }, contextAssessment: { sufficient: true, confidence: "high", needs: [] } });
  };
  const chapterBody = (number, title) => {
    const seed = `第${number}章《${title}》里，雾桥下的煤雾像贴在城墙上的旧布。叶昭把铜心压回袖口，确认热意没有再带走新的记忆。炉税巡检的脚步逼近，街坊们把黑水桶挪到墙根，每个人的呼吸都变得短促。`;
    const turns = [
      "“你要是再查下去，先被烧掉的不会是纸。”沈砚停在门外，手指按着刀柄。叶昭说：“那就让他们先听见钟声。”",
      "她把铜片摊在案上，用针尖划出齿轮误差。每一道细痕都对应一个人的名字，也对应一口没有被记录的气。九炉议会的账本看似完整，缺口却密得像一张网。",
      "阿满从后窗钻进来，带来一枚沾着炉灰的通行章。他说工匠行会只肯相信半页证据，叶昭看见他袖口藏着另一半。沉默把两个人的交易写得比承诺更清楚。",
      "城楼钟忽然倒走七格，叶昭眼前闪过父亲弯腰修钟的影子，铜心随即骤热。她忘了那双手曾怎样握住她，却记住了钟摆停顿的位置。",
      "沈砚伸手想抢走铜片，她把它塞进炉膛边缘的冷灰里。这个动作让他明白，她不是来求一个答案，而是准备承担答案带来的追捕。",
      "主炉喷出白光，气税牌上的数字同时跳动。贫民区有人倒下，巡检队却只顾封锁街口。叶昭把自己的气券塞进孩子掌心，代价是她今晚再也想不起父亲的脸。",
      "“你会后悔。”“后悔也比忘掉强。”她把铜片扣在腕内，转身朝九炉走去。炉门后的阴影传来三下短促敲击，节奏与城楼钟完全相反。",
      "阿满忽然挡住通道，像是要把她交给巡检队。叶昭没有拔刀，只把半页账本递给他。阿满看完后退一步，脚下的灰印暴露了他刚从议会方向回来。",
      "沈砚在烟里打开一道只够一人通过的窄门。叶昭回头望向雾桥，知道每一个记号都会成为下一次选择的证据。她踏入窄门，身后的钟声终于停止。",
    ];
    const consequences = [
      "窄门后不是议会档案室，而是一条贴满旧气券的检修廊。叶昭逐张摸过去，发现同一天出生的人被写进不同寿数栏；有人多活十年，就有人被提前扣走十年。她把异常编号刻在铜片背面，决定先找到还活着的证人。",
      "廊道尽头守着一名哑火工，他认出叶衡留下的七格刻痕，却不肯立刻开口。巡检队的灯从远处逼近时，他只将一把断齿钥匙塞给叶昭，随后故意踢翻工具箱，把追兵引向另一条岔道。",
      "叶昭追上去想救他，沈砚却拦住她。两人在蒸汽管下压低声音争执：她认为任何人的牺牲都不能被当成计划，他则逼她承认，如果现在回头，贫民区今晚就会断气。最后是远处孩子的咳声替她作了决定。",
      "断齿钥匙只能转动半圈，叶昭便拆下铜心外环补足缺口。机关开启的瞬间，她听见父亲教她辨认钟油气味的声音，却怎么也想不起那堂课发生在哪一年。失去的记忆没有回来，门后却亮起一排仍在跳动的姓名牌。",
      "姓名牌显示叶衡并非唯一被封进主炉的人。九炉议会把失踪工匠登记成自愿献寿者，再用他们的家属领取过抚恤作伪证。阿满的姐姐也在名单上，这让他藏起半页账本的选择突然有了另一层含义。",
      "阿满承认自己早就看过名单，却坚持不能立刻公开。他说工匠行会一旦知道主炉里还有活人，必然会强攻九炉；议会正等着以暴乱为名封死所有街区。叶昭没有原谅他，只要求他在天亮前带来三名能互相印证的火工。",
      "沈砚从巡检腰牌里抽出一层薄纸，上面是今晚的抓捕顺序：先抓叶昭，再抓散发气券的街坊，最后销毁雾桥钟楼。名单末尾却有沈砚自己的名字，墨迹还没有干。议会从未真正信任任何替它办事的人。",
      "他们分头行动前，叶昭把完整铜片掰成三份，一份交给沈砚，一份交给阿满，自己只留下记录父亲暗号的那一角。谁若背叛，另外两人仍能证明气税账目被篡改；谁若死去，证据也不会跟着消失。",
      "回到雾桥时，第一队巡检已经砸开修钟铺。叶昭没有从后门逃走，而是爬上停摆的钟楼，当众敲响本不该在这个时辰响起的警钟。七短一长的节奏越过煤雾，城里别处很快传来相同回应。",
      "议会命令切断钟楼蒸汽，叶昭便让铜心接入老旧传动轴。齿轮重新咬合时，灼热从手腕钻进胸口，她忽然忘记父亲最常叫她的小名。她停了一息，仍把最后一枚固定栓推到底，让整面气税牌暴露在广场上。",
      "牌上的数字不再显示欠税，而是滚出每个街区被偷走的寿数。人群先是安静，随后有人读出母亲的名字，有人认出失踪的儿子。巡检队举起枪，却没有一个人敢在这么多姓名面前率先扣动扳机。",
      "沈砚带着抓捕名单登上石阶，对同僚说议会下一步也会清理他们。领队命他闭嘴，他却把腰牌折断丢进炉沟。两名年轻巡检慢慢放低枪口，更多人仍在犹豫，局面因此变成谁先动手谁就会失去退路的僵持。",
      "白汽忽然从地下喷涌，证明议会已经远程打开泄压阀，准备淹没广场并毁掉证据。叶昭从钟摆的反向震动判断出阀门位置，却发现那里正是父亲暗号指向的旧主炉入口；救下众人和追索叶衡成了同一条危险道路。",
      "她让阿满带街坊沿屋脊撤离，自己与沈砚冲向入口。阿满第一次没有讨价还价，只把藏起的半页账本塞回她手中。纸页背面新显出一行受热文字：第九炉从来没有熄灭，它一直在吞掉被城市遗忘的人。",
      "入口铁门升起时，里面传来与城楼相同的七次倒响。叶昭握紧三分之一的铜片，明白父亲不仅留下求救信号，也在警告她门后有人能操纵整座城的记忆。她跨过门槛，身后铁门轰然落下，沈砚却被隔在了另一边。",
    ];
    return [seed, ...turns, ...consequences].join("\n\n");
  };
  const foundation = [
    "参考资料\n架空晚清的长安被煤雾封锁，九座巨炉按呼吸征收气税。叶昭是修钟匠，父亲叶衡失踪，沈砚和工匠行会牵动她的选择。",
    "作品设定\n蒸汽系统燃烧人的寿数，铜心每次启动都会带走叶昭一段关于父亲的记忆。她用齿轮误差刻录记忆，城楼钟子时倒走七格是叶衡留下的暗号。",
    "全书大纲\n第一幕调查气税和铜心，第二幕揭露九炉议会篡改皇历，第三幕让百姓决定是否关闭主炉。阿满第九章的背叛是假，第十八章揭示他借此进入议会。",
    "伏笔管理\n倒走七格的钟、铜片误差和阿满的假背叛分别承担路线、记忆和身份误导功能，必须保留前文证据并在后续阶段回收。",
    "信息释放表\n先让读者知道气税损耗寿数，再看到叶昭失忆，随后通过皇历篡改确认九炉议会的系统性欺骗；阿满真实目的延迟到第十八章。",
  ].join("\n\n");
  mockTextServer = createServer(async (request, response) => {
    let rawBody = "";
    for await (const chunk of request) rawBody += String(chunk);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const inputText = inputTextOf(body);
    const requestText = `${String(body.instructions || "")}\n${inputText}`;
  const prompt = latestUserPrompt(inputText);
  let outputText = "";
  let stage = "unknown";
  const chapter = requestText.match(/现在直接创作《雾都铜心》第\s*(\d+)\s*章《([^》\n]+)》/u);
  const formalTask = /正式内容自动写入|记入当前作品|当前作品相关设定|资料、设定和全书大纲|自动新建或定位标题/u.test(prompt);
  const landingPlanRequested = requestText.includes("落盘规划器") && requestText.includes("本轮强制目标");
  const landingPlanTargetIds = [
    ["library-reference", 1],
    ["canon-world", 2],
    ["outline-series", 3],
    ["memory-foreshadowing", 4],
    ["memory-release", 5],
  ];
  const landingPlanJson = () => {
    const requestedIds = [...requestText.matchAll(/"documentId"\s*:\s*"([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((id) => landingPlanTargetIds.some(([targetId]) => targetId === id));
    const targetSet = new Set(requestedIds.length ? requestedIds : landingPlanTargetIds.map(([id]) => id));
    return JSON.stringify({
      summary: "已按强制目标完成正式内容分配",
      documents: landingPlanTargetIds
        .filter(([documentId]) => targetSet.has(documentId))
        .map(([documentId, block]) => ({ documentId, blocks: [block] })),
    });
  };
  const unified = requestText.includes("神思统一文字入口")
      && !requestText.includes("本轮内部职责：任务与上下文准备")
      && !requestText.includes("本轮内部职责：正式生成")
      && !requestText.includes("本轮内部职责：效果验收")
      && !requestText.includes("本轮内部职责：普通任务合并验收")
      && !requestText.includes("本轮内部职责：连续性与状态检查")
      && !requestText.includes("本轮内部职责：定向返修");
    if (landingPlanRequested) {
      stage = "landing-plan";
      outputText = landingPlanJson();
    } else if (unified) {
      stage = "unified-entry";
      outputText = JSON.stringify({
        lane: formalTask ? "task_execution" : "guided_dialogue",
        relation: "new_task",
        objective: formalTask ? "执行当前正式创作任务" : "逐步明确爽文创作方向",
        requestMode: formalTask ? "creative" : "creative_guidance",
        deliverableType: "novel",
        reply: formalTask ? "进入正式生成、检查和落盘流程。" : "先明确这本书准备持续兑现的核心爽感。",
        confidence: 0.99,
        guidanceCompleted: formalTask,
        skillQueries: ["小说创作引导"],
        readPlan: [],
        writePlan: formalTask ? chapter ? { intent: "commit", targetKind: "new", targetRef: `第${chapter[1]}章 ${chapter[2].trim()}`, operation: "create" } : { intent: "commit", targetKind: "unspecified", targetRef: "", operation: "none" } : { intent: "none", targetKind: "unspecified", targetRef: "", operation: "none" },
        openDecision: null,
        guidance: formalTask ? null : guidanceState(),
      });
    } else if (requestText.includes("本轮内部职责：任务与上下文准备")) {
      stage = "planning";
      outputText = planningJson(requestText);
    } else if (requestText.includes("本轮内部职责：正式生成")) {
      stage = "creative";
      const decisionMarker = !chapter && /叶昭暂不公开完整图纸/u.test(requestText)
        ? "第二幕前作者决定：叶昭暂不公开完整图纸，只把能证明气税造假的半页交给工匠行会；沈砚表面追捕她，暗中留下通往龙骨列车的通行章。"
        : !chapter && /最终决定/u.test(requestText)
          ? "创作合同确认：铜心每次启动都会让叶昭失去一段关于父亲的记忆；叶衡留下的暗号是子时倒走七格的城楼钟；阿满第九章的背叛是假，第十八章才揭示真实目的。"
          : "";
      const formalContent = decisionMarker
        ? foundation.split("\n\n").map((block, index) => index === 0 ? block : `${block}\n${decisionMarker}`).join("\n\n")
        : foundation;
      outputText = chapter
        ? `【正式内容】\n第${chapter[1]}章 ${chapter[2].trim()}\n\n${chapterBody(Number(chapter[1]), chapter[2].trim())}`
        : `【正式内容】\n${formalContent}`;
    } else if (requestText.includes("本轮内部职责：效果验收") || requestText.includes("本轮内部职责：普通任务合并验收") || requestText.includes("本轮内部职责：连续性与状态检查")) {
      stage = requestText.includes("普通任务合并验收") ? "combined-check" : requestText.includes("连续性与状态检查") ? "memory-check" : "evaluation";
      outputText = stage === "combined-check" ? JSON.stringify({ evaluation: { selectedIndex: 0, pass: true, summary: "检查通过", findings: [], coverage: { read: [], missing: [], truncated: [] }, repairInstruction: "", languageReview: { pass: true, decisions: [] }, integrity: { conceptPass: true, conceptIssues: [], narrativePass: true, narrativeIssues: [] }, qualityDelta: { chapterMission: "推进", narrativeMode: "外部行动", protectedAssets: ["叶昭", "铜心"], gains: ["完成推进"], losses: [], netGain: true, recommendation: "adopt" } }, memoryCheck: { hardConflict: false, summary: "连续性通过", hardConflicts: [], softRisks: [], repairInstruction: "", memoryUpdate: { chapterSummary: "叶昭进入主炉通道。", stateChanges: [], foreshadowing: [], firstAppearances: [], informationRelease: [], readerKnowledge: [], nextContext: [], pendingCanon: [], evidence: [] } } }) : JSON.stringify({ hardConflict: false, summary: "连续性通过", hardConflicts: [], softRisks: [], repairInstruction: "", memoryUpdate: { chapterSummary: "叶昭进入主炉通道。", stateChanges: [], foreshadowing: [], firstAppearances: [], informationRelease: [], readerKnowledge: [], nextContext: [], pendingCanon: [], evidence: [] } });
    } else if (requestText.includes("本轮内部职责：定向返修")) {
      stage = "revision";
      outputText = `【候选稿】\n${chapterBody(Number(chapter?.[1] || 1), chapter?.[2]?.trim() || "修订稿")}`;
    } else {
      stage = "unexpected";
      outputText = "已完成当前阶段。";
    }
    mockTextRequests.push({ url: request.url, stage });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ id: `mock-${mockTextRequests.length}`, output_text: outputText }));
  });
  mockTextServer.listen(0, "127.0.0.1");
  await once(mockTextServer, "listening");
  mockTextBaseUrl = `http://127.0.0.1:${mockTextServer.address().port}/v1`;
}
const requestedTextProfileId = String(process.env.SHENSI_GUIDED_NOVEL_TEXT_PROFILE_ID || "").trim();
const agentTextConnection = useMockTextModel ? {
  id: "local-guidance-agent-test",
  name: "本机创作引导协议验收",
  provider: "自定义兼容接口",
  adapter: "api",
  protocol: "responses",
  baseUrl: mockTextBaseUrl,
  apiKey: "",
  model: "gpt-5.6-sol",
  agentModelId: "gpt-5.6-sol",
  agentEngine: "codex_api",
  executionMode: "agent",
  executionModes: ["agent"],
  credentialSource: "public",
} : (installedSettings.textConnections || []).find((connection) => (
  requestedTextProfileId && connection.id === requestedTextProfileId
)) || (installedSettings.textConnections || []).find((connection) => (
  connection.id === installedSettings.activeTextAgentConnectionId
)) || (installedSettings.textConnections || []).find((connection) => (
  connection.agentEngine && (connection.executionModes || [connection.executionMode]).includes("agent")
));
assert.ok(agentTextConnection, "真实 UI 验收需要一个已配置的 Agent 文字连接");
const configuredSettings = {
  ...installedSettings,
  adapter: agentTextConnection.adapter || "api",
  provider: agentTextConnection.provider || "免费模型",
  protocol: agentTextConnection.protocol || "chat_completions",
  baseUrl: agentTextConnection.baseUrl || "",
  apiKey: agentTextConnection.apiKey || "",
  model: agentTextConnection.model || agentTextConnection.agentModelId || "",
  agentEngine: agentTextConnection.agentEngine || "codex_api",
  activeTextConnectionId: agentTextConnection.id,
  activeTextAgentConnectionId: agentTextConnection.id,
  activeTextChatConnectionId: "",
  textExecutionMode: "agent",
  ...(useMockTextModel ? { textConnections: [agentTextConnection] } : {}),
};
const mockTextRuntimeBinding = useMockTextModel ? {
  channel: "text",
  profileId: agentTextConnection.id,
  adapter: "api",
  provider: agentTextConnection.provider,
  protocol: agentTextConnection.protocol,
  baseUrl: agentTextConnection.baseUrl,
  cliPath: "",
  cliArgs: "",
  chatAdapter: "",
  chatProtocol: "",
  chatBaseUrl: "",
} : null;
const debugPort = Number(process.env.SHENSI_GUIDED_NOVEL_DEBUG_PORT || 9368);
const chapterLimit = Math.max(1, Math.min(20, Number(process.env.SHENSI_GUIDED_NOVEL_MAX_CHAPTERS || 20)));
const guidanceOnly = process.env.SHENSI_GUIDED_NOVEL_GUIDANCE_ONLY === "1";
const projectName = `雾都铜心-${chapterLimit}章实机验收-${buildId}`;
const evidenceStartPath = join(artifactsRoot, `guided-novel-${buildId}-guidance.png`);
const evidenceFinalPath = join(artifactsRoot, `guided-novel-${buildId}-final.png`);
const reportPath = join(artifactsRoot, `guided-novel-${buildId}-report.json`);
const electronExecutable = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");

await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactsRoot, { recursive: true });

const child = spawn(electronExecutable, [
  `--remote-debugging-port=${debugPort}`,
  "--disable-gpu",
  "--disable-gpu-compositing",
  desktopEntry,
], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: dataRoot,
    SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DESKTOP_USER_DATA_ROOT: userDataRoot,
    SHENSI_SKIP_UPDATE_CHECK: "1",
    SHENSI_DISABLE_HARDWARE_ACCELERATION: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const targetDeadline = Date.now() + 45_000;
let pageTarget = null;
while (Date.now() < targetDeadline && !pageTarget) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    pageTarget = targets.find((target) => target.type === "page" && /127\.0\.0\.1|localhost/u.test(target.url));
  } catch {}
  if (!pageTarget) await delay(250);
}
if (!pageTarget) {
  child.kill();
  throw new Error(`神思真实创作界面没有启动：${stderr.slice(-2000)}`);
}

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener("open", resolvePromise, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const cdp = (method, params = {}, timeout = 45_000) => new Promise((resolvePromise, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`神思真实创作调试命令超时：${method}`));
  }, timeout);
  pending.set(id, { resolve: resolvePromise, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, timeout = 45_000) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`).catch(() => false)) return true;
    await delay(250);
  }
  const diagnostic = await evaluate(`(() => ({ title: document.title, body: document.body?.innerText?.slice(-1800) || '', provider: document.querySelector('#chatProviderSelect')?.value || '', model: document.querySelector('#quickChatModel')?.value || '', toast: document.querySelector('.toast.visible')?.textContent || '' }))()`).catch(() => null);
  throw new Error(`等待超时：${label}；${JSON.stringify(diagnostic)}；stderr=${stderr.slice(-1200)}`);
};
const screenshot = async (path) => {
  const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 120_000);
  await writeFile(path, Buffer.from(image.data, "base64"));
};
const submitUiPrompt = async ({ label, prompt, timeout = 12 * 60_000 }) => {
  const before = await evaluate(`document.querySelectorAll('#chatFeed .assistant-message').length`);
  const previousAssistantMessageId = await evaluate(`[...document.querySelectorAll('#chatFeed .assistant-message')].at(-1)?.dataset.message || ''`);
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  // Real CLI runs can spend several minutes preparing before the assistant
  // bubble is inserted. Keep this phase inside the caller's end-to-end budget
  // instead of reporting a false failure at a fixed 90 seconds.
  await waitFor(
    `document.querySelectorAll('#chatFeed .assistant-message').length > ${before}`,
    `${label}出现回答`,
    Math.min(timeout, 5 * 60_000),
  );
  await waitFor(`(() => {
    const last = [...document.querySelectorAll('#chatFeed .assistant-message')].at(-1);
    return Boolean(last?.dataset.message && last.dataset.message !== ${JSON.stringify(previousAssistantMessageId)});
  })()`, `${label}新回答标识`, 30_000);
  const terminalReceipt = await waitForPersistedAssistantTerminal(label, timeout, {
    previousAssistantMessageId,
  });
  await waitFor(`(() => {
    const last = [...document.querySelectorAll('#chatFeed .assistant-message')].at(-1);
    return last && last.querySelector('.assistant-message-content');
  })()`, `${label}终态界面完成`, 30_000);
  await waitFor(`document.querySelector('.autosave-state')?.dataset.state !== 'saving'`, `${label}保存完成`, 60_000).catch(() => {});
  const result = await evaluate(`(() => {
    const last = [...document.querySelectorAll('#chatFeed .assistant-message')].at(-1);
    const actualSkillDetails = [...(last?.querySelectorAll('[data-context-readout] details') || [])]
      .find((details) => details.querySelector('summary')?.textContent.includes('实际加载 Skill'));
    return {
      text: last?.innerText || '',
      contentText: last?.querySelector('.assistant-message-content .assistant-copy')?.innerText || '',
      actualSkillText: actualSkillDetails?.innerText || '',
      contentCollapsed: Boolean(last?.querySelector('.assistant-message-content.is-collapsible:not(.is-expanded)')),
      hasExpandButton: Boolean(last?.querySelector('.assistant-message-expand-button')),
      executionStatus: last?.querySelector('.execution-process')?.dataset.status || '',
      links: [...(last?.querySelectorAll('[data-open-landed-document], [data-document-link]') || [])].map((link) => link.textContent.trim()).filter(Boolean),
      failed: /(?:^|\\n)(?:任务失败|生成失败|调用失败|无法继续|已阻止|缺少必读资料)(?:[：:]|$)/m.test(last?.innerText || ''),
      messageId: last?.dataset.message || '',
    };
  })()`);
  result.executionStatus ||= terminalReceipt.status;
  result.failed ||= ["failed", "blocked", "hard_blocked", "retry_required"].includes(terminalReceipt.status);
  console.log(JSON.stringify({ phase: "ui-turn", label, characters: result.text.length, links: result.links, failed: result.failed, executionStatus: result.executionStatus }));
  return result;
};
const stripSnapshotText = (value = "") => String(value)
  .replace(/<[^>]*>/gu, " ")
  .replace(/[`#*_>~-]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim();
const workspaceSnapshot = async (workspacePath) => {
  const snapshot = await evaluate(`(async () => {
  const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
  const response = await fetch('/api/workspace/load', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shensi-session': token }, body: JSON.stringify({ workspacePath: ${JSON.stringify("__WORKSPACE_PATH__")} }) });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.message || '作品回读失败');
  const strip = (value = '') => String(value).replace(/<[^>]*>/g, ' ').replace(/[\u0060#*_>~-]/g, ' ').replace(/\\s+/g, ' ').trim();
  return {
    stateStamp: payload.stateStamp || '',
    documents: Object.entries(payload.state?.documents || {}).map(([id, doc]) => ({ id, title: String(doc.title || ''), text: strip(doc.markdown || doc.html || ''), moduleId: doc.moduleId || '', contentRef: doc.contentRef || null, projectionHashVersion: Number(doc.memoryStoreProjectionHashVersion) || 0 })),
    memoryStore: {
      present: Boolean(payload.state?.memoryStore),
      foreshadowingCount: Object.keys(payload.state?.memoryStore?.foreshadowing || {}).length,
      informationCount: Object.keys(payload.state?.memoryStore?.informationEntities || {}).length,
      projectionConflicts: (payload.state?.memoryStore?.conflicts || []).filter((item) => item?.key === 'structured-store-projection').map((item) => item.documentId || ''),
    },
    settings: { provider: payload.state?.settings?.provider || '', model: payload.state?.settings?.model || '' },
  };
})()`.replace("__WORKSPACE_PATH__", String(workspacePath).replaceAll("\\", "\\\\")), 90_000);
  const workspaceRoot = resolve(workspacePath);
  for (const document of snapshot.documents) {
    if (document.text || !document.contentRef?.path) continue;
    const contentPath = resolve(workspaceRoot, String(document.contentRef.path));
    if (!contentPath.toLowerCase().startsWith(`${workspaceRoot}${sep}`.toLowerCase())) continue;
    document.text = stripSnapshotText(await readFile(contentPath, "utf8").catch(() => ""));
  }
  return snapshot;
};
const hanCount = (value) => (String(value || "").match(/[\u3400-\u9fff]/gu) || []).length;
const chapterNumberPattern = (number) => new RegExp(`第\\s*0*${number}\\s*章`, "u");

const chapterTitles = [
  "雾桥吞火", "铜心醒来", "失踪的铸钟师", "气税巡检", "地底蒸汽河",
  "假皇历", "龙骨列车", "雾都罢工", "九炉会审", "天穹裂缝",
  "皇城无风", "机械菩萨", "铜血名单", "烟囱之上", "失速的长安",
  "百姓的钟声", "龙脉反转", "最后一炉", "黎明拆城", "人间新历",
];
const arcGuidance = new Map([
  [6, {
    question: "进入第二幕前继续创作引导：只围绕叶昭是否公开父亲留下的铜心图纸、公开会立刻伤害谁，以及这一决定怎样改变她与巡检官沈砚的关系，向我提出两个具体问题；先讨论，不写正文。",
    answer: "叶昭暂不公开完整图纸，只把能证明气税造假的半页交给工匠行会；这样会让她救下贫民区，却令沈砚怀疑她在争夺铸造权。沈砚表面追捕她，暗中给她留下通往龙骨列车的通行章。",
  }],
  [11, {
    question: "进入第三幕前继续创作引导：围绕机械菩萨究竟是统治工具还是被篡改的城市救生系统、叶昭必须付出的个人代价，向我提出两个具体问题；先讨论，不写正文。",
    answer: "机械菩萨本是灾变时调度蒸汽和粮食的救生系统，被九炉议会改成气税与监控中枢。叶昭重启它会失去铜心带来的长寿，并暴露自己就是最后一名炉心继承者。",
  }],
  [16, {
    question: "进入终幕前继续创作引导：围绕推翻九炉议会后是否保留龙脉蒸汽网、普通工人如何获得决定权，向我提出两个具体问题；先讨论，不写正文。",
    answer: "不摧毁蒸汽网，而是把控制权拆成九枚公开的民选炉印，任何一枚都不能单独启动主炉。叶昭拒绝成为新掌权者，最终回到雾桥开一间公开图纸的修造所。",
  }],
]);

const turns = [];
let workspacePath = "";
const waitForPersistedAssistantTerminal = async (label, timeout, {
  previousAssistantMessageId = "",
} = {}) => {
  const deadline = Date.now() + timeout;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await evaluate(`(async () => {
      const workspacePath = ${JSON.stringify("__WORKSPACE_PATH__")};
      const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
      const payload = await fetch('/api/workspace/load', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shensi-session': token }, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
      const conversation = (payload.state?.conversations || []).find((item) => item.id === payload.state?.activeConversationId);
      const message = [...(conversation?.messages || [])].reverse().find((item) => item.role === 'assistant');
      return message ? {
        id: message.id || '',
        pending: message.pending === true,
        status: message.execution?.status || '',
        content: String(message.content || ''),
      } : null;
    })()`.replace("__WORKSPACE_PATH__", String(workspacePath).replaceAll("\\", "\\\\"))).catch(() => null);
    const running = latest?.pending === true
      || ["", "queued", "running", "starting", "preparing", "cancelling"].includes(String(latest?.status || ""));
    const belongsToCurrentTurn = Boolean(latest?.id)
      && latest.id !== previousAssistantMessageId;
    if (belongsToCurrentTurn && !running) return latest;
    await delay(250);
  }
  throw new Error(`等待超时：${label}持久化终态；${JSON.stringify(latest)}`);
};
try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.bringToFront");
  await waitFor("document.querySelector('#projectButton') && document.querySelector('#chatInput')", "神思主界面启动", 60_000);
  await evaluate(`(() => {
    const projectButton = document.querySelector('#projectButton');
    if (document.querySelector('#projectMenu')?.hidden) projectButton.click();
    return true;
  })()`);
  await waitFor("document.querySelector('#workspaceKindButton')", "作品菜单渲染完成");
  await evaluate(`(() => {
    document.querySelector('#workspaceKindButton')?.click();
    document.querySelector('#projectMenu [data-workspace-kind="project"]')?.click();
    return true;
  })()`);
  await waitFor("document.querySelector('#workspaceKindButton strong')?.textContent.trim() === '作品'", "切换到作品列表");
  await waitFor("document.querySelector('#newWorkspaceButton')", "新建作品按钮");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建作品对话框");
  await evaluate(`(() => { const input = document.querySelector('#textDialogInput'); input.value = ${JSON.stringify(projectName)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#textDialogForm').requestSubmit(); return true; })()`);
  await waitFor(`document.querySelector('#projectButton')?.textContent.includes(${JSON.stringify(projectName)})`, "验收作品创建并打开", 60_000);
  await waitFor("document.querySelector('.autosave-state')?.dataset.state === 'saved'", "验收作品首次保存", 60_000);
  await evaluate(`(() => { if (document.querySelector('#projectMenu').hidden) document.querySelector('#projectButton').click(); return true; })()`);
  await waitFor(`[...document.querySelectorAll('[data-project-path]')].some((row) => row.dataset.projectName === ${JSON.stringify(projectName)})`, "验收作品登记到作品列表");
  workspacePath = await evaluate(`[...document.querySelectorAll('[data-project-path]')].find((row) => row.dataset.projectName === ${JSON.stringify(projectName)})?.dataset.projectPath || ''`);
  assert.ok(workspacePath && workspacePath.toLowerCase().startsWith(dataRoot.toLowerCase()), `验收作品必须写入隔离数据根目录：${workspacePath}`);
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  const initialConversationState = await evaluate(`(async () => {
    const workspacePath = ${JSON.stringify("__WORKSPACE_PATH__")};
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const payload = await fetch('/api/workspace/load', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shensi-session': token }, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    const conversations = payload.state?.conversations || [];
    return { activeConversationId: payload.state?.activeConversationId || '', conversationIds: conversations.map((item) => item.id), messageCounts: conversations.map((item) => item.messages?.length || 0) };
  })()`.replace("__WORKSPACE_PATH__", String(workspacePath).replaceAll("\\", "\\\\")));
  console.log(JSON.stringify({ phase: "new-workspace-conversation", ...initialConversationState }));
  assert.ok(initialConversationState.conversationIds.includes(initialConversationState.activeConversationId), "新建作品的当前对话 ID 必须对应真实对话记录");
  assert.equal(initialConversationState.messageCounts.reduce((sum, count) => sum + count, 0), 0, "新建作品不得继承其他作品或示例对话");

  const configuredWorkspaceState = await evaluate(`(async () => {
    const workspacePath = ${JSON.stringify("__WORKSPACE_PATH__")};
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const headers = { 'content-type': 'application/json', 'x-shensi-session': token };
    const loaded = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    if (!loaded.ok || !loaded.state) throw new Error(loaded.message || '验收作品读取失败');
    loaded.state.settings = { ...${JSON.stringify(configuredSettings)}, workspacePath };
    const saved = await fetch('/api/workspace/save', { method: 'POST', headers, body: JSON.stringify({ workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp || '' }) }).then((response) => response.json());
    if (!saved.ok) throw new Error(saved.message || '验收模型设置保存失败');
    const verified = await fetch('/api/workspace/load', { method: 'POST', headers, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    if (!verified.ok || !verified.state) throw new Error(verified.message || '验收模型设置回读失败');
    const resumed = await fetch('/api/recovery/session', { method: 'POST', headers, body: JSON.stringify({ activeWorkspace: { workspacePath, workspaceKind: 'project', projectName: ${JSON.stringify(projectName)}, activeModule: 'manuscript', activeDocument: loaded.state.activeDocument || '', activeConversationId: loaded.state.activeConversationId || '', resumeRevision: Date.now() } }) }).then((response) => response.json());
    if (!resumed.ok) throw new Error(resumed.message || '验收作品恢复位置保存失败');
    return { activeConversationId: verified.state.activeConversationId || '', conversationIds: (verified.state.conversations || []).map((item) => item.id), messageCounts: (verified.state.conversations || []).map((item) => item.messages?.length || 0) };
  })()`.replace("__WORKSPACE_PATH__", String(workspacePath).replaceAll("\\", "\\\\")), 90_000);
  console.log(JSON.stringify({ phase: "configured-workspace-conversation", ...configuredWorkspaceState }));
  assert.ok(configuredWorkspaceState.conversationIds.includes(configuredWorkspaceState.activeConversationId), "写入现有模型设置后，当前对话 ID 仍必须对应真实对话记录");
  assert.equal(configuredWorkspaceState.messageCounts.reduce((sum, count) => sum + count, 0), 0, "写入模型设置不得把示例或其他作品对话带入新作品");
  if (mockTextRuntimeBinding) {
    const runtimeRegistration = await evaluate(`(async () => {
      const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
      const response = await fetch('/api/generation/runtime/bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shensi-session': token },
        body: JSON.stringify({
          schemaVersion: 1,
          bindings: [${JSON.stringify(mockTextRuntimeBinding)}],
          credentials: {},
          confirmed: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || '本机假模型运行时注册失败');
      const binding = (payload.bindings || []).find((item) => item.channel === 'text' && item.profileId === ${JSON.stringify(agentTextConnection.id)});
      return { ok: payload.ok === true, binding };
    })()`);
    assert.equal(runtimeRegistration.binding?.baseUrl, mockTextBaseUrl, "本机假模型端点必须注册到隔离核心进程的运行时绑定");
    console.log(JSON.stringify({ phase: "mock-runtime-binding", ...runtimeRegistration }));
  }
  await cdp("Page.reload", { ignoreCache: true });
  await delay(2000);
  await waitFor(`document.readyState === 'complete' && document.documentElement.dataset.bootReady === 'true' && document.querySelector('#projectButton')?.textContent.includes(${JSON.stringify(projectName)}) && document.querySelector('#chatProviderSelect') && document.querySelector('#chatInput')`, "使用现有模型设置重新载入验收作品", 60_000);
  const cleanConversation = await evaluate(`(() => ({
    assistantMessages: document.querySelectorAll('#chatFeed .assistant-message').length,
    userMessages: document.querySelectorAll('#chatFeed .user-message').length,
    hydrationError: [...document.querySelectorAll('.toast, .panel-empty.error')].map((item) => item.textContent || '').find((text) => /工作区安全加载失败|安全恢复/.test(text)) || '',
  }))()`);
  console.log(JSON.stringify({ phase: "reloaded-workspace-conversation", ...cleanConversation }));
  assert.equal(cleanConversation.hydrationError, "", `验收作品重载不得进入恢复失败状态：${cleanConversation.hydrationError}`);
  assert.equal(cleanConversation.assistantMessages + cleanConversation.userMessages, 0, "新建验收作品重载后必须仍为空对话，不得继承其他作品或示例对话");

  const firstGuidance = await submitUiPrompt({
    label: "创作引导-核心命题",
    prompt: "我想写个爽文",
  });
  turns.push(firstGuidance);
  const firstGuidanceReceipt = await evaluate(`(async () => {
    const workspacePath = ${JSON.stringify("__WORKSPACE_PATH__")};
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || '';
    const payload = await fetch('/api/workspace/load', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shensi-session': token }, body: JSON.stringify({ workspacePath }) }).then((response) => response.json());
    const conversation = (payload.state?.conversations || []).find((item) => item.id === payload.state?.activeConversationId);
    const message = [...(conversation?.messages || [])].reverse().find((item) => item.role === 'assistant');
    return {
      lane: message?.execution?.lane || message?.execution?.agentDecision?.lane || '',
      requestMode: message?.execution?.agentDecision?.requestMode || message?.execution?.taskRoute?.mode || '',
      skillNames: (message?.execution?.contextReads?.actual?.skills || []).map((item) => item.name || item.title || item.id).filter(Boolean),
      writeState: message?.execution?.writeAuthorization?.state || message?.execution?.taskRoute?.writeAuthorization?.state || '',
    };
  })()`.replace("__WORKSPACE_PATH__", String(workspacePath).replaceAll("\\", "\\\\")));
  const guidanceQuestionCount = (firstGuidance.contentText.match(/[？?]/gu) || []).length;
  if (!/实际加载 Skill（[1-9]\d*）[\s\S]*小说创作引导/u.test(firstGuidance.actualSkillText)) {
    const domDiagnostic = await evaluate(`(() => {
      const last = [...document.querySelectorAll('#chatFeed .assistant-message')].at(-1);
      return {
        html: last?.innerHTML?.slice(-12000) || '',
        executionProcess: last?.querySelector('.execution-process')?.outerHTML?.slice(-16000) || '',
        contextReadout: last?.querySelector('[data-context-readout]')?.outerHTML || '',
        visibleText: last?.innerText || '',
      };
    })()`);
    console.log(JSON.stringify({ phase: "guidance-dom-diagnostic", ...domDiagnostic }));
  }
  assert.equal(firstGuidanceReceipt.lane, "guided_dialogue", "“我想写个爽文”必须由统一 Agent 判定为持续创作引导");
  assert.equal(firstGuidanceReceipt.requestMode, "creative_guidance", "首轮不得降级为普通对话");
  assert.ok(firstGuidanceReceipt.skillNames.includes("小说创作引导"), `必须真实加载并记录小说创作引导 Skill：${JSON.stringify(firstGuidanceReceipt)}`);
  assert.match(firstGuidance.actualSkillText, /实际加载 Skill（[1-9]\d*）[\s\S]*小说创作引导/u, "界面执行详情必须显示真实加载的小说创作引导 Skill");
  assert.equal(guidanceQuestionCount, 1, `创作引导每轮只能提出一个问题：${firstGuidance.contentText}`);
  assert.ok(hanCount(firstGuidance.contentText) <= 300, `首轮创作引导必须简短承接并只问一题，不能输出大段方案：${hanCount(firstGuidance.contentText)}字`);
  assert.ok(!/(?:第一章|正文|完整大纲|人物小传)[：:]/u.test(firstGuidance.contentText), "首轮不得直接输出正文、完整大纲或成套设定");
  assert.ok(["", "none"].includes(firstGuidanceReceipt.writeState), "未完成的创作引导不得获得写入权限");
  await screenshot(evidenceStartPath);
  if (guidanceOnly) {
    const report = {
      ok: true,
      version: "2.18.8",
      buildId,
      projectName,
      workspacePath,
      dataRoot,
      executionSurface: "real-ui-agent",
      guidanceOnly: true,
      guidanceReceipt: firstGuidanceReceipt,
      responseCharacters: hanCount(firstGuidance.contentText),
      questionCount: guidanceQuestionCount,
      evidenceStartPath,
      mockTextRequests,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } else {
  turns.push(await submitUiPrompt({
    label: "创作引导-作者回答一",
    prompt: "我的决定：架空晚清的长安被永不散去的煤雾封锁，九座巨炉供应全城却按呼吸征收气税。女主叶昭是修钟匠，想查清父亲失踪真相并让穷人不再因欠气税窒息；反派是掌管九炉的议会。蒸汽技术燃烧的不是煤，而是人的寿数。结局不是换一个皇帝，而是拆分垄断的控制权。请继续追问人物关系、秘密揭示次序和每一幕不可逆代价，不写正文。",
  }));
  turns.push(await submitUiPrompt({
    label: "创作引导-作者回答二",
    prompt: "进一步确认：叶昭的父亲叶衡没有死，他被封在主炉里维持城市；巡检官沈砚起初追捕叶昭，后来发现母亲也死于气税造假；童年伙伴阿满代表工匠行会，既帮助叶昭也害怕图纸公开后引发暴乱。第一幕叶昭得到会跳动的铜心，第二幕揭露九炉篡改皇历掩盖寿数损耗，第三幕让百姓决定是否关闭主炉。请最后核对连续性和伏笔投放，提出两个最关键的细节问题，不写正文。",
  }));
  const finalizedGuidance = await submitUiPrompt({
    label: "创作引导-最终确认",
    prompt: "最终决定：铜心每次启动都会让叶昭失去一段关于父亲的记忆；她用修钟时记录齿轮误差的旧习惯，把重要记忆刻进铜片。叶衡留下的暗号是每到子时会倒走七格的城楼钟。阿满在第九章背叛是假，目的是进入九炉议会；第十八章才揭示。现在把已经确认的内容作为正式内容自动写入当前作品的资料、设定和全书大纲，并记录必要伏笔与信息台阶。只在有实际内容时创建文档，不创建空占位，不写正文；完成后给出与真实文档同名的可点击链接。",
    timeout: 15 * 60_000,
  });
  turns.push(finalizedGuidance);
  const foundationSnapshot = await workspaceSnapshot(workspacePath);
  const foundationDocuments = foundationSnapshot.documents.filter((document) => (
    !["report-compile", "index-language-blacklist"].includes(document.id)
    && hanCount(document.text) >= 40
  ));
  console.log(JSON.stringify({ phase: "foundation-verify", documents: foundationDocuments.map((document) => ({ id: document.id, title: document.title, moduleId: document.moduleId, han: hanCount(document.text) })), links: finalizedGuidance.links }));
  assert.ok(foundationDocuments.length >= 3, "确认后的资料、设定、大纲与记忆必须至少形成3篇有实际内容的可回读文档");
  assert.ok(finalizedGuidance.links.length >= 3, "创作引导正式内容落盘后必须显示与真实文档同名的跳转链接");
  await cdp("Page.reload", { ignoreCache: true });
  await delay(1500);
  await waitFor(`document.readyState === 'complete' && document.documentElement.dataset.bootReady === 'true' && document.querySelector('#projectButton')?.textContent.includes(${JSON.stringify(projectName)}) && document.querySelector('#chatInput')`, "基础资料保存后重启回读", 60_000);
  const reloadedFoundation = await workspaceSnapshot(workspacePath);
  console.log(JSON.stringify({ phase: "foundation-restart-verify", memoryStore: reloadedFoundation.memoryStore }));
  assert.equal(reloadedFoundation.memoryStore.present, true, "重启后必须恢复结构化记忆仓，不能从展示文档猜测重建");
  assert.ok(reloadedFoundation.memoryStore.foreshadowingCount >= 1 && reloadedFoundation.memoryStore.informationCount >= 1, "重启后结构化记忆记录不得丢失");
  assert.deepEqual(reloadedFoundation.memoryStore.projectionConflicts, [], "系统投影保存并重启后不得误报人工修改");
  assert.ok(["memory-foreshadowing", "memory-release"].every((id) => reloadedFoundation.documents.find((document) => document.id === id)?.projectionHashVersion === 2), "记忆投影必须使用稳定指纹基线");

  for (let number = 1; number <= chapterLimit; number += 1) {
    const guidance = arcGuidance.get(number);
    if (guidance) {
      turns.push(await submitUiPrompt({ label: `第${number}章前创作引导`, prompt: guidance.question }));
      turns.push(await submitUiPrompt({ label: `第${number}章前作者决定`, prompt: `${guidance.answer}\n请把这项决定记入当前作品相关设定、大纲和记忆，然后继续按既定二十章结构推进；此时不写正文。` }));
    }
    const title = chapterTitles[number - 1];
    let completed = false;
    for (let attempt = 1; attempt <= 2 && !completed; attempt += 1) {
      const retry = attempt > 1 ? "上一轮没有形成可回读且内容充分的正式章节，请修复，不要解释失败原因。" : "";
      const result = await submitUiPrompt({
        label: `第${number}章-${title}${attempt > 1 ? "-修复" : ""}`,
        prompt: [
          retry,
          `现在直接创作《雾都铜心》第${number}章《${title}》的正式中文小说正文。`,
          "本章至少1500个汉字，必须有可感知的场景、人物行动、对白、冲突、转折和改变后续局面的章节结尾；承接当前作品已经确认的设定、大纲、记忆和前章最新版。",
          "创作过程中执行小说自检、连续性核对与去AI味修订，但只把最终正式正文写入文档，不把说明、检查过程、协议字段、Markdown符号或自检报告写进正文。",
          `自动新建或定位标题为“第${number}章 ${title}”的章节文档并落盘；只处理本章，不覆盖其他章节，不生成多个候选稿。完成后在对话下方显示与真实章节标题一致的可点击链接。`,
        ].filter(Boolean).join("\n"),
        timeout: 18 * 60_000,
      });
      turns.push(result);
      const snapshot = await workspaceSnapshot(workspacePath);
      const chapter = snapshot.documents.find((document) => document.id === `chapter-${number}`);
      assert.ok(result.links.some((link) => chapterNumberPattern(number).test(link) && link.includes(title)), `第${number}章落盘链接必须同时包含章节号和文档名`);
      completed = Boolean(chapter && hanCount(chapter.text) >= 900 && !/targetdocumentid|target_document_id|operation\s*:/iu.test(chapter.text));
      console.log(JSON.stringify({ phase: "chapter-verify", number, title: chapter?.title || "", han: hanCount(chapter?.text || ""), completed }));
    }
    if (!completed) throw new Error(`第${number}章“${title}”经过一次修复仍未形成不少于900汉字的可回读正式正文`);
  }

  const finalSnapshot = await workspaceSnapshot(workspacePath);
  const chapterEvidence = chapterTitles.slice(0, chapterLimit).map((expectedTitle, index) => {
    const number = index + 1;
    const document = finalSnapshot.documents.find((item) => item.id === `chapter-${number}`);
    return {
      number,
      expectedTitle,
      id: document?.id || "",
      title: document?.title || "",
      han: hanCount(document?.text || ""),
      hasStoryTurn: /突然|却|终于|发现|决定|真相|原来|竟然|直到/u.test(document?.text || ""),
      hasDialogue: /[“”「」『』]/u.test(document?.text || ""),
      protocolFree: !/targetdocumentid|target_document_id|hostmustreadcurrent|operation\s*:/iu.test(document?.text || ""),
    };
  });
  assert.equal(chapterEvidence.filter((item) => item.id).length, chapterLimit, `必须真实创建并回读${chapterLimit}章`);
  assert.ok(chapterEvidence.every((item) => item.han >= 900), "每章必须达到正式章节的最低实测长度");
  assert.ok(chapterEvidence.every((item) => item.hasStoryTurn && item.hasDialogue && item.protocolFree), "每章必须包含故事推进和对白，且不得混入内部协议");
  await evaluate(`document.querySelector('[data-module="manuscript"]')?.click(); true`);
  await delay(1200);
  await screenshot(evidenceFinalPath);
  const report = {
    ok: true,
    version: "2.18.8",
    buildId,
    projectName,
    workspacePath,
    dataRoot,
    executionSurface: "real-ui-agent",
    guidanceTurns: 4 + [...arcGuidance.keys()].filter((number) => number <= chapterLimit).length * 2,
    chapterTurns: turns.length - (4 + [...arcGuidance.keys()].filter((number) => number <= chapterLimit).length * 2),
    chapterLimit,
    documentCount: finalSnapshot.documents.length,
    chapterEvidence,
    evidenceStartPath,
    evidenceFinalPath,
    runtimeProvider: finalSnapshot.settings,
    mockTextRequests,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  }
} catch (error) {
  const failure = {
    ok: false,
    version: "2.18.8",
    buildId,
    projectName,
    workspacePath,
    dataRoot,
    error: error.message,
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    completedTurns: turns.length,
    mockTextRequests,
  };
  await writeFile(reportPath, JSON.stringify(failure, null, 2), "utf8").catch(() => {});
  throw error;
} finally {
  socket.close();
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), delay(5000)]);
  }
  if (mockTextServer) await new Promise((resolvePromise) => mockTextServer.close(resolvePromise));
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
