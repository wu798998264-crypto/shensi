import { WORKSPACE_MODULES } from "./module-registry.js";
import { OPENAI_IMAGE_CLI_ALIAS, OPENAI_IMAGE_CLI_ARGS } from "./media-cli-presets.js";
import { applyStructureCreationLanguage, normalizeStructureLanguage } from "./structure-language.js";
import { STRUCTURE_WORKSPACE_VERSION } from "./structure-schema.js";
import { canonicalEpisodeTitle, episodeHeadingParts, parseEpisodeHeading } from "./episode-document.js";
import { effectiveSequencedDocumentNumber, freeDocumentTitle, legacySequencedTitleParts, sequencedDocumentKind, sequencedDocumentLabel } from "./document-title-policy.js";
import { taskConversationMetadata } from "./workspace-conversation-policy.js";

export const MODULES = WORKSPACE_MODULES;

const blankConversationId = () => `conversation-${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12)}`;

export const MODULE_VIEWS = {
  manuscript: [
    { id: "novel", label: "正文目录" },
    { id: "script", label: "剧本目录" },
    { id: "prompts", label: "提示词目录" },
  ],
  outline: [
    { id: "novel", label: "小说大纲" },
    { id: "script", label: "剧本大纲" },
  ],
  canon: [
    { id: "novel", label: "正史设定" },
    { id: "script", label: "剧本设定" },
  ],
  memory: [
    { id: "novel", label: "小说记忆" },
    { id: "script", label: "剧本记忆" },
  ],
};

export const MODULE_ITEMS = {
  manuscript: [
    ["chapter-1", "第1章　暴雨将至"],
    ["chapter-2", "第2章　破局"],
    ["chapter-3", "第3章　无人之地"],
    ["chapter-4", "第4章　旧事重提"],
    ["chapter-5", "第5章　暗潮"],
    ["chapter-6", "第6章　第一次误判"],
    ["chapter-7", "第7章　交锋"],
    ["chapter-8", "第8章　深水"],
    ["chapter-9", "第9章　逆光"],
    ["chapter-10", "第10章　终局之前"],
    ["script-episode-1", "第一集　样集", { workspaceView: "script", contextDomain: "script", treeGroup: "scripts" }],
    ["prompt-video-1", "第一集视频提示词", { workspaceView: "prompts", contextDomain: "script", treeGroup: "video" }],
    ["prompt-visual-assets", "视觉资产总表", { workspaceView: "prompts", contextDomain: "script", treeGroup: "visual" }],
    ["prompt-panorama-1", "第一集全景调度图提示词", { workspaceView: "prompts", contextDomain: "script", treeGroup: "panorama" }],
  ],
  outline: [
    ["outline-series", "全集大纲"],
    ["outline-volume-1", "第一卷卷纲"],
    ["outline-chapter-6", "第6章章纲"],
    ["script-outline-series", "全集大纲", { workspaceView: "script", contextDomain: "script", treeGroup: "series" }],
    ["script-outline-episode-1", "第一集集纲", { workspaceView: "script", contextDomain: "script", treeGroup: "episodes" }],
  ],
  canon: [
    ["canon-characters", "人物设定"],
    ["canon-relations", "人物关系"],
    ["canon-world", "世界观与基础规则"],
    ["canon-locations", "地图与地点"],
    ["canon-factions", "势力与组织"],
    ["canon-events", "事件与时间线"],
    ["canon-items", "物品与道具"],
    ["canon-glossary", "术语表"],
    ["script-canon-characters", "人物改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-relations", "关系改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-world", "世界与规则改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-locations", "场景与地点改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-factions", "势力与组织改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-events", "事件与时间线改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-items", "道具改编", { workspaceView: "script", contextDomain: "script" }],
    ["script-canon-glossary", "剧本术语", { workspaceView: "script", contextDomain: "script" }],
  ],
  memory: [
    ["memory-foreshadowing", "伏笔管理"],
    ["memory-information-ledger", "信息账本", { mergedMemoryView: true }],
    ["memory-first-appearance", "重要信息登场账本", { legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["memory-release", "信息释放表", { legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["outline-series", "全集大纲", { alias: true }],
    ["memory-reader", "读者当前知识库", { legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["memory-snapshot", "状态快照"],
    ["script-memory-foreshadowing", "伏笔管理", { workspaceView: "script", contextDomain: "script" }],
    ["script-memory-information-ledger", "信息账本", { workspaceView: "script", contextDomain: "script", mergedMemoryView: true }],
    ["script-memory-first-appearance", "重要信息登场账本", { workspaceView: "script", contextDomain: "script", legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["script-memory-release", "信息释放表", { workspaceView: "script", contextDomain: "script", legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["script-outline-series", "剧本全集大纲", { workspaceView: "script", contextDomain: "script", alias: true }],
    ["script-memory-audience", "观众当前知识库", { workspaceView: "script", contextDomain: "script", legacyMemoryProjection: true, hiddenFromDirectory: true }],
    ["script-memory-snapshot", "状态快照", { workspaceView: "script", contextDomain: "script" }],
  ],
  reports: [
    ["report-novel", "小说自检"],
    ["report-script", "剧本自检", { contextDomain: "script" }],
    ["report-compile", "项目总览"],
    ["report-adaptation", "小说改剧本编译报告", { contextDomain: "script" }],
  ],
  library: [
    ["library-reference", "参考资料"],
    ["library-retired", "废弃设定"],
    ["library-memo", "备忘录", { readPolicy: "explicit-only" }],
  ],
  index: [
    ["index-language-blacklist", "创作合同"],
    ["index-update-log", "更新日志"],
    ["index-pending", "待确认事项"],
  ],
};

const manuscript = `
  <p>雨在凌晨停了。城市像被人按下静音键，连远处高架桥上的车流声都消失了，只剩偶尔滴落的水声，敲在铁皮屋檐上，轻而缓慢。</p>
  <p>陆沉站在窗前，指尖夹着一支将熄的烟。烟灰在玻璃杯里堆成一小截，他没去弹。桌上摊着几张打印件，边角被水汽弄得微微卷起。</p>
  <p>那组数据不对劲。</p>
  <p>不是结论不对，而是逻辑链在某个节点上被人为掐断了。掐断它的人，很可能以为自己做得天衣无缝。</p>
  <p>手机在桌面上震动了一下，是简宁。</p>
  <p>“我到了老地方，东西带来了。”</p>
  <p><span class="seed-selection">他没立刻回。目光落在其中一页的时间戳上——03:17。</span></p>
  <p>那时他应该在会议室，却出现在了别处。</p>
  <p>第一次误判，往往不是信息不足，而是把太像真的线索，当成了真相。</p>
  <p>他掐灭烟，起身拉开抽屉，拿出一个牛皮纸文件袋。</p>
  <p>里面是一张被折叠过无数次的地图，边缘磨白，折痕处有细小的裂口。陆沉将它摊开，指尖沿着那条被红笔圈出的路线移动。</p>
  <p>这座城市从不说谎，只有人会。</p>
`;

const simpleDocument = (title, body, metadata = {}) => ({
  title,
  html: `<h1>${title}</h1><p>${body}</p>`,
  updatedAt: "10:31",
  ...metadata,
});

const CHAPTER_PREFIX = /^第(?:\d+|[〇零一二三四五六七八九十百千万两]+)章/;
const EPISODE_PREFIX = /^第(?:\d+|[〇零一二三四五六七八九十百千万两]+)集/;
const ENGLISH_CHAPTER_PREFIX = /^Chapter\s+(?:\d+|[〇零一二三四五六七八九十百千万两]+)/i;

export const numericChapterTitle = (id, value) => {
  const match = String(id).match(/^(chapter|outline-chapter|script-episode|script-outline-episode)-(\d+)$/);
  const number = Number(match?.[2] ?? 0);
  const source = String(value ?? "");
  if (!number) return source;
  if (match?.[1]?.includes("episode") && EPISODE_PREFIX.test(source)) return source.replace(EPISODE_PREFIX, `第${number}集`);
  if (CHAPTER_PREFIX.test(source)) return source.replace(CHAPTER_PREFIX, `第${number}章`);
  if (ENGLISH_CHAPTER_PREFIX.test(source)) return source.replace(ENGLISH_CHAPTER_PREFIX, `Chapter ${number}`);
  return source;
};

export const normalizeChapterNumbering = (targetState) => {
  let changed = false;
  for (const [id, documentState] of Object.entries(targetState.documents ?? {})) {
    const previousTitle = documentState?.title ?? "";
    const kind = sequencedDocumentKind(id);
    if (kind && documentState?.manualChapterNumber === true) {
      const legacyNumber = legacySequencedTitleParts({ documentId: id, title: previousTitle })?.number;
      if (legacyNumber && legacyNumber !== Number(String(id).match(/(\d+)$/)?.[1] || 0)) documentState.manualChapterNumber = legacyNumber;
      else delete documentState.manualChapterNumber;
      changed = true;
    } else if (kind && documentState?.manualChapterNumber != null) {
      const previousManualNumber = documentState.manualChapterNumber;
      const normalizedNumber = effectiveSequencedDocumentNumber({ documentId: id, documentState, title: previousTitle });
      const idNumber = Number(String(id).match(/(\d+)$/)?.[1] || 0);
      if (!normalizedNumber || normalizedNumber === idNumber) delete documentState.manualChapterNumber;
      else documentState.manualChapterNumber = normalizedNumber;
      if (documentState.manualChapterNumber !== previousManualNumber) changed = true;
    }
    const nextTitle = kind
      ? freeDocumentTitle({ documentId: id, title: previousTitle, language: documentState?.titleLanguage || targetState.structureLanguage || "zh-CN" })
      : numericChapterTitle(id, previousTitle);
    if (nextTitle === previousTitle) continue;
    documentState.title = nextTitle;
    if (!kind && typeof documentState.html === "string") {
      documentState.html = documentState.html.replace(`<h1>${previousTitle}</h1>`, `<h1>${nextTitle}</h1>`);
    }
    changed = true;
  }
  // Migrate the stored sequence number before rebuilding directory labels.
  // Older workspaces represented a custom chapter number with the boolean
  // `manualChapterNumber: true`; labelling first would temporarily fall back to
  // the numeric document id and overwrite the user's visible chapter number.
  for (const items of Object.values(targetState.moduleItems ?? {})) {
    for (const item of items ?? []) {
      const documentState = targetState.documents?.[item[0]];
      const kind = sequencedDocumentKind(item[0]);
      const nextLabel = kind
        ? sequencedDocumentLabel({
          documentId: item[0],
          title: documentState?.title || item[1],
          language: documentState?.titleLanguage || targetState.structureLanguage || "zh-CN",
          documentState,
        })
        : numericChapterTitle(item[0], item[1]);
      if (nextLabel === item[1]) continue;
      item[1] = nextLabel;
      changed = true;
    }
  }
  for (const [id, documentState] of Object.entries(targetState.documents ?? {})) {
    if (!/^script-episode-\d+$/.test(id) || !documentState) continue;
    const current = episodeHeadingParts(id, documentState.title);
    if (current.title !== "未命名") continue;
    const htmlHeading = String(documentState.html || "").match(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
    const markdownHeading = String(documentState.markdown || "").match(/^\s*#{1,6}\s+([^\n]+)/)?.[1] || "";
    const inferred = parseEpisodeHeading(htmlHeading || markdownHeading);
    if (!inferred || inferred.title === "未命名") continue;
    const nextTitle = inferred.title;
    documentState.title = nextTitle;
    for (const items of Object.values(targetState.moduleItems ?? {})) {
      const item = (items ?? []).find(([documentId]) => documentId === id);
      if (item) item[1] = canonicalEpisodeTitle({ documentId: id, episodeNumber: inferred.number, episodeTitle: inferred.title, language: inferred.language });
    }
    changed = true;
  }
  return changed;
};

const documents = {
  "chapter-6": {
    title: "第一次误判",
    html: manuscript,
    updatedAt: "10:31",
    continuityDelta: {
      summary: "陆沉发现时间记录冲突，决定带地图前往老地方。",
      nextCarryover: ["03:17记录冲突仍未解释。", "陆沉即将与简宁在老地方会面。"],
      updatedAt: "10:31",
    },
  },
  "outline-series": simpleDocument("全集大纲", "全书以一次被人为制造的误判为起点，逐层揭开人物关系、利益交换与旧案真相。"),
  "outline-volume-1": simpleDocument("第一卷卷纲", "第一卷完成主角入局、第一次误判和核心对手的首次正面交锋。"),
  "outline-chapter-6": simpleDocument("第6章章纲", "本章用03:17的时间戳制造逻辑断点，让主角第一次意识到证据链被人主动修改。"),
  "canon-characters": simpleDocument("人物设定", "陆沉：克制、敏锐，在信息不足时习惯先压下情绪；简宁：掌握旧案关键材料。"),
  "canon-world": { title: "世界观与基础规则", html: "<h1>世界观与基础规则</h1><h2>世界观</h2><p>故事发生在一座高度依赖数据调度的沿海城市，公开记录不等于真实发生。</p><h2>基础规则</h2><p>概念、规则、基础设定、力量体系、种族与特殊机制均按标题锚点维护在本聚合板中。</p>", updatedAt: "10:31" },
  "canon-factions": simpleDocument("势力与组织", "城建集团、旧案调查组与匿名数据修正者构成当前三方力量。"),
  "canon-relations": simpleDocument("人物关系", "陆沉与简宁互相需要，但双方仍各自保留一部分关键信息。"),
  "canon-locations": simpleDocument("地图与地点", "老地方：废弃高架桥下的通宵餐馆；会议室：03:17线索的冲突地点。"),
  "canon-items": simpleDocument("物品与道具", "牛皮纸文件袋、折叠地图和被修改的打印数据是当前关键物品。"),
  "canon-events": { title: "事件与时间线", html: "<h1>事件与时间线</h1><h2>事件</h2><p>03:17记录冲突被确认，但造成冲突的人和目的尚未揭示。</p><h2>时间线</h2><p>02:40会议开始；03:17系统记录出现冲突；凌晨雨停后陆沉复核材料。</p>", updatedAt: "10:31" },
  "canon-glossary": simpleDocument("术语表", "尚未收录正式术语。"),
  "memory-foreshadowing": simpleDocument("伏笔管理", "F-006：03:17时间戳。状态：已埋设；预计在第十二章完成第一次解释。"),
  "memory-information-ledger": simpleDocument("信息账本", "当前没有已通过正文证据验收的记录。", { moduleId: "memory", mergedMemoryView: true }),
  "memory-first-appearance": simpleDocument("重要信息登场账本", "03:17在第六章首次进入读者视野，目前只知道它与陆沉的不在场记录冲突。"),
  "memory-release": simpleDocument("信息释放表", "第六章释放：记录冲突。暂缓释放：谁修改了记录，以及简宁掌握材料的真实来源。"),
  "memory-reader": simpleDocument("读者当前知识库", "读者知道数据链被人为掐断，但尚不知道陆沉是否真的离开过会议室。"),
  "memory-snapshot": simpleDocument("状态快照", "陆沉：警觉上升；简宁：等待见面；03:17：未解释；地图：已重新启用。"),
  "script-episode-1": simpleDocument("样集", "按单集剧本格式承接剧本大纲、剧本设定和当前状态；当前等待确认本集主戏剧问题。", { contextDomain: "script", workspaceView: "script", moduleId: "manuscript" }),
  "prompt-video-1": simpleDocument("第一集视频提示词", "按镜头拆分可执行的视频提示词，并追溯到对应分集剧本。", { contextDomain: "script", workspaceView: "prompts", treeGroup: "video", moduleId: "manuscript" }),
  "prompt-visual-assets": simpleDocument("视觉资产总表", "维护剧本所需角色、场景、道具和复用资产的视觉生成提示词。", { contextDomain: "script", workspaceView: "prompts", treeGroup: "visual", moduleId: "manuscript" }),
  "prompt-panorama-1": simpleDocument("第一集全景调度图提示词", "固定多人场景的空间关系、站位、朝向、动线和关键动作区域。", { contextDomain: "script", workspaceView: "prompts", treeGroup: "panorama", moduleId: "manuscript" }),
  "script-outline-series": simpleDocument("剧本全集大纲", "原创项目在此建立类型契约、核心矛盾、阶段爆点和终局；改编项目在原作基础上重构为剧本总控。", { contextDomain: "script", workspaceView: "script", moduleId: "outline" }),
  "script-outline-episode-1": simpleDocument("第一集集纲", "记录本集主戏剧问题、情绪变化、信息释放、关系推进和结尾画面钩子。", { contextDomain: "script", workspaceView: "script", moduleId: "outline" }),
  "script-canon-characters": simpleDocument("人物改编", "只记录相对小说正史发生的人物删减、功能合并、表演方向和出场顺序变化。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-relations": simpleDocument("关系改编", "只记录剧本化导致的关系位置、关系弧线和人物合并变化。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-world": simpleDocument("世界与规则改编", "只记录为画面呈现、制作执行或观众理解而改动的世界信息与规则，不复制小说正史。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-locations": simpleDocument("场景与地点改编", "只记录场景调度、地点压缩、合并、替换与新增。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-factions": simpleDocument("势力与组织改编", "只记录组织的保留、合并、替换及其戏剧功能变化。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-events": simpleDocument("事件与时间线改编", "只记录原作事件的删并重排、跨集位置与时间顺序变化。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-items": simpleDocument("道具改编", "只记录承担证据、反转、身份标记或视觉记忆点的关键道具变化。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-canon-glossary": simpleDocument("剧本术语", "只记录剧本新增或为观众理解而改写的术语。", { contextDomain: "script", workspaceView: "script", moduleId: "canon" }),
  "script-memory-foreshadowing": simpleDocument("剧本伏笔管理", "记录原创或改编剧本中已经成立的可呈现伏笔及其跨集回收位置。", { contextDomain: "script", workspaceView: "script", moduleId: "memory" }),
  "script-memory-information-ledger": simpleDocument("信息账本", "当前没有已通过正文证据验收的记录。", { contextDomain: "script", workspaceView: "script", moduleId: "memory", mergedMemoryView: true }),
  "script-memory-first-appearance": simpleDocument("剧本重要信息登场账本", "记录关键信息在剧本中的首次出现、局部揭示和正式揭示集数。", { contextDomain: "script", workspaceView: "script", moduleId: "memory" }),
  "script-memory-release": simpleDocument("剧本信息释放表", "按集维护观众获得的信息、角色知情差和延后解释事项。", { contextDomain: "script", workspaceView: "script", moduleId: "memory" }),
  "script-memory-audience": simpleDocument("观众当前知识库", "记录观众在当前集结束时已经确认、怀疑和仍未知的信息。", { contextDomain: "script", workspaceView: "script", moduleId: "memory" }),
  "script-memory-snapshot": simpleDocument("剧本状态快照", "记录人物、关系、道具、伤口、地点和未兑现集尾承诺的当前状态。", { contextDomain: "script", workspaceView: "script", moduleId: "memory" }),
  "report-novel": simpleDocument("小说自检", "当前未发现硬设定冲突。风险：03:17若解释过早，会削弱后续调查线的牵引力。"),
  "report-script": simpleDocument("剧本自检", "当前尚未执行剧本自检。", { contextDomain: "script", moduleId: "reports" }),
  "report-compile": simpleDocument("项目总览", "本报告将根据当前项目的大纲、分卷、正文、设定和连续性资料实时更新。", { derived: true }),
  "report-adaptation": {
    title: "小说改剧本编译报告",
    html: "<h1>小说改剧本编译报告</h1><h2>改编范围</h2><p>记录本轮采用的小说章节、设定和目标集数。</p><h2>具体改动</h2><p>逐项记录保留、删除、合并、前置、后置、视觉化和功能转移。</p><h2>改编思路</h2><p>说明每项调整服务的冲突、节奏、人物功能、信息释放或制作执行目标。</p><h2>连续性与风险</h2><p>记录对后续集数、人物关系、伏笔回收和小说正史隔离的影响。</p>",
    updatedAt: "10:31",
    contextDomain: "script",
    moduleId: "reports",
  },
  "library-reference": simpleDocument("参考资料", "用于保存研究资料、用户导入文本和不会直接进入正史的参考信息。"),
  "library-retired": simpleDocument("废弃设定", "已经废弃但需要保留来源的设定进入隔离区。"),
  "library-memo": simpleDocument("备忘录", "", { moduleId: "library", readPolicy: "explicit-only", userFacingReference: true }),
  "index-language-blacklist": {
    ...simpleDocument("创作合同", ""),
    html: "<h1>创作合同</h1><h2>项目禁用词</h2><p>当前没有项目级禁用词。</p><h2>特别注意事项</h2><p>记录只针对本项目生效的创作边界、必须承接事项和特殊要求。</p>",
  },
  "index-update-log": simpleDocument("更新日志", "当前尚无结构化更新记录。"),
  "index-pending": simpleDocument("待确认事项", "03:17冲突最终指向情感误会还是商业判断失误，仍待作者确认。"),
};

for (const [id, label] of MODULE_ITEMS.manuscript) {
  if (!documents[id]) {
    documents[id] = {
      ...simpleDocument(label.replace(/^第.+?章　/, ""), ""),
      html: "",
    };
  }
}

const initialMessages = [
  {
    id: "m1",
    role: "user",
    time: "10:28",
    content: "把他没立刻回。目光落在其中一页的时间戳上——03:17。改得更有张力一些。",
  },
  {
    id: "m2",
    role: "assistant",
    time: "10:28",
    lead: "已生成以下候选稿：",
    candidate: "他没有回信。目光停在那一页的时间戳上——03:17，像一根被刻意留下的针。",
  },
  {
    id: "m3",
    role: "user",
    time: "10:29",
    content: "全自动写下去。",
  },
  {
    id: "m4",
    role: "assistant",
    time: "10:31",
    content: "现有设定与大纲足以支撑续写。先确认一个会影响本章效果的细节：这次误判，你更希望它偏向情感误会，还是商业判断失误？",
  },
];

export const createInitialState = () => ({
  schemaVersion: 19,
  mediaWorkspaceVersion: 3,
  structureWorkspaceVersion: 0,
  structureLanguage: "zh-CN",
  workspaceKind: "project",
  projectName: "未命名",
  theme: "light",
  layout: { leftPaneWidth: 270, rightPaneWidth: 420 },
  activeModule: "manuscript",
  activeDocument: "chapter-6",
  moduleItems: structuredClone(MODULE_ITEMS),
  customFolders: [],
  documents: structuredClone(documents),
  histories: {
    "chapter-6": [
      {
        id: "h12",
        title: "03:17线索更隐晦，男主没有立即回应",
        version: "v12",
        time: "今天 10:31",
        html: manuscript.replace("他没立刻回。", "他没有回复。"),
      },
      {
        id: "h11",
        title: "误判被写成信息不足，情绪冲击较弱",
        version: "v11",
        time: "今天 09:47",
        html: manuscript.replace("往往不是信息不足", "往往只是信息不足"),
      },
      {
        id: "h10",
        title: "会议室线索尚未前置",
        version: "v10",
        time: "昨天 22:18",
        html: manuscript.replace("那时他应该在会议室，却出现在了别处。", ""),
      },
    ],
  },
  chapterEpisodeMappings: [],
  viewHistories: {},
  volumeHistories: {},
  moduleHistories: {
    manuscript: [{ id: "mh1", title: "第六章冲突线索尚未强化", version: "正文快照 18", time: "今天 10:31" }],
    outline: [{ id: "oh1", title: "第一卷终点仍停在旧案重启", version: "大纲快照 7", time: "昨天 21:06" }],
    canon: [{ id: "ch1", title: "简宁的信息权限尚未收紧", version: "设定快照 12", time: "昨天 19:42" }],
    memory: [{ id: "mm1", title: "03:17伏笔尚未进入读者知识库", version: "记忆快照 31", time: "今天 09:47" }],
    index: [{ id: "ih1", title: "待确认事项尚未加入误判方向", version: "索引快照 15", time: "今天 09:48" }],
  },
  projectHistories: [
    { id: "ph1", title: "第六章首次引入03:17冲突之前", version: "作品快照 24", time: "今天 09:40" },
    { id: "ph2", title: "第一卷调查线重新排序之前", version: "作品快照 23", time: "昨天 21:06" },
  ],
  workspaceAssets: [],
  assetHistoryTombstones: [],
  longFormJobs: [],
  currentVersionMeta: { documents: {}, views: {}, volumes: {}, modules: {}, project: null },
  messages: structuredClone(initialMessages),
  snapshots: {},
  isolatedBranches: [],
  currentCandidate: initialMessages[1].candidate,
  currentCandidateTarget: { chapterNumber: 6, documentId: "chapter-6" },
  currentCandidateMemoryUpdate: null,
  activeConversationId: "conversation-main",
  documentConversationBindings: { "chapter-6": "conversation-main" },
  conversations: [
    {
      id: "conversation-main",
      title: "第六章修改",
      homeDocumentId: "chapter-6",
      homeDocumentBoundAtEpoch: 0,
      boundDocumentId: "chapter-6",
      autoAssociateActiveDocument: true,
      messages: structuredClone(initialMessages),
      snapshots: {},
      isolatedBranches: [],
      currentCandidate: initialMessages[1].candidate,
      currentCandidateTarget: { chapterNumber: 6, documentId: "chapter-6" },
      currentCandidateMemoryUpdate: null,
      nativeAgentSession: null,
      constraintIndex: [],
      conversationContextCheckpoint: null,
      contextLedger: null,
      contextCompressionSignature: "",
      contextCompressionStatus: null,
      intentTarget: { chapterNumber: 6, documentId: "chapter-6" },
      queue: [],
      references: [],
      attachments: [],
      createdAt: "今天 10:28",
      updatedAt: "今天 10:31",
    },
  ],
  activities: [
    { id: "activity-seed", type: "open", label: "打开第六章《第一次误判》", documentId: "chapter-6", time: "今天 10:31" },
  ],
  trash: [],
  selectedText: "他没立刻回。目光落在其中一页的时间戳上——03:17。",
  settings: {
    adapter: "api",
    provider: "OpenAI",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    speedMode: "default",
    temperature: "0.7",
    maxOutputTokens: "4000",
    timeoutMs: "120000",
    apiKey: "",
    imageProvider: "OpenAI",
    imageAdapter: "cli",
    imageProtocol: "images",
    imageBaseUrl: "https://api.openai.com/v1",
    imageModel: "gpt-image-2",
    imageApiKey: "",
    imageTimeoutMs: "660000",
    imageCliPath: OPENAI_IMAGE_CLI_ALIAS,
    imageCliArgs: OPENAI_IMAGE_CLI_ARGS,
    videoProvider: "OpenAI",
    videoAdapter: "api",
    videoProtocol: "videos",
    videoBaseUrl: "https://api.openai.com/v1",
    videoModel: "sora-2",
    videoApiKey: "",
    videoTimeoutMs: "900000",
    videoCliPath: "",
    videoCliArgs: "",
    cliPath: "",
    cliArgs: "",
    skillOverrides: {},
    skillSlotBindings: {},
    workspacePath: "",
    uiLanguage: "zh-CN",
    themePreference: "system",
    editorFontFamily: "songti",
    editorMaxWidth: "800",
    editorFontSize: "17",
    editorLineHeight: "1.85",
    shortcuts: {
      newConversation: "Ctrl+Alt+N",
      focusSearch: "Ctrl+Shift+F",
      saveVersion: "Ctrl+Alt+S",
      togglePreview: "Ctrl+Alt+P",
      openSettings: "Ctrl+,",
      toggleWebSearch: "Ctrl+Alt+W",
    },
  },
});

export const ensureScriptOutlineSeries = (targetState, defaults = null) => {
  const effectiveDefaults = defaults ?? applyStructureCreationLanguage(createInitialState(), targetState?.structureLanguage);
  targetState.moduleItems ??= {};
  targetState.moduleItems.outline ??= [];
  targetState.documents ??= {};
  let changed = false;
  if (!targetState.moduleItems.outline.some(([id]) => id === "script-outline-series")) {
    const defaultItem = effectiveDefaults.moduleItems.outline.find(([id]) => id === "script-outline-series");
    if (defaultItem) {
      targetState.moduleItems.outline.push(structuredClone(defaultItem));
      changed = true;
    }
  }
  if (!targetState.documents["script-outline-series"] && effectiveDefaults.documents["script-outline-series"]) {
    targetState.documents["script-outline-series"] = structuredClone(effectiveDefaults.documents["script-outline-series"]);
    changed = true;
  }
  return changed;
};

export const createBlankProjectState = ({ name = "未命名", workspacePath = "", settings = {} } = {}) => {
  const state = createInitialState();
  const conversationId = blankConversationId();
  const structureLanguage = normalizeStructureLanguage(settings.uiLanguage);
  const english = structureLanguage === "en-US";
  const blankItems = Object.fromEntries(MODULES.map(({ id }) => [id, []]));
  // Managed cockpit documents are materialized only when they have real
  // content. Keep the derived project overview and the editable creation
  // contract, but do not create empty review/adaptation reports, update logs,
  // pending-decision placeholders, or a guidance log for every new work.
  blankItems.reports = structuredClone(MODULE_ITEMS.reports.filter(([id]) => id === "report-compile"));
  blankItems.library = structuredClone(MODULE_ITEMS.library.filter(([id]) => id === "library-memo"));
  blankItems.index = structuredClone(MODULE_ITEMS.index.filter(([id]) => id === "index-language-blacklist"));
  blankItems.memory = structuredClone(MODULE_ITEMS.memory.filter(([id]) => [
    "memory-snapshot",
    "memory-foreshadowing",
    "memory-information-ledger",
    "memory-first-appearance",
    "memory-release",
    "memory-reader",
    "script-memory-snapshot",
    "script-memory-foreshadowing",
    "script-memory-information-ledger",
    "script-memory-first-appearance",
    "script-memory-release",
    "script-memory-audience",
  ].includes(id)));
  // Keep the canonical memory views available in every new project. Legacy
  // projections stay migration-only and are materialized when old source
  // documents are present, so a blank project does not expose duplicates.
  const blankDocuments = {};
  for (const [moduleId, items] of Object.entries(blankItems)) {
    for (const [id, label, options = {}] of items) {
      if (blankDocuments[id]) continue;
      const defaultDocument = state.documents[id] ?? {};
      const title = freeDocumentTitle({ documentId: id, title: label, language: structureLanguage });
      const metadata = {
        ...Object.fromEntries(Object.entries(defaultDocument).filter(([key]) => !["title", "html", "markdown", "updatedAt", "continuityDelta"].includes(key))),
        ...options,
        moduleId: defaultDocument.moduleId || moduleId,
      };
      blankDocuments[id] = id === "index-language-blacklist"
        ? {
          ...simpleDocument(title, "", metadata),
          html: `<h1>${title}</h1><h2>项目禁用词</h2><p>当前没有项目级禁用词。</p><h2>特别注意事项</h2><p>当前没有项目级特别注意事项。</p>`,
        }
        : { ...simpleDocument(title, "", metadata), html: "" };
    }
  }
  state.projectName = name;
  state.structureWorkspaceVersion = STRUCTURE_WORKSPACE_VERSION;
  state.activeModule = "manuscript";
  state.activeDocument = "";
  state.moduleItems = blankItems;
  state.customFolders = [];
  state.documents = blankDocuments;
  state.histories = {};
  state.viewHistories = {};
  state.volumeHistories = {};
  state.moduleHistories = { manuscript: [], outline: [], canon: [], memory: [], reports: [], library: [], index: [] };
  state.projectHistories = [];
  state.longFormJobs = [];
  state.messages = [];
  state.snapshots = {};
  state.isolatedBranches = [];
  state.currentCandidate = "";
  state.currentCandidateTarget = null;
  state.currentCandidateMemoryUpdate = null;
  state.activeConversationId = conversationId;
  state.documentConversationBindings = {};
  state.moduleLastDocuments = {};
  state.currentCandidateAuthorization = null;
  state.conversations = [{
    id: conversationId,
    title: english ? "New Chat" : "新对话",
    homeDocumentId: null,
    homeDocumentBoundAtEpoch: 0,
    boundDocumentId: null,
    ...taskConversationMetadata({}, { workspaceKind: "project", workspacePath, workspaceName: name }),
    messages: [],
    snapshots: {},
    isolatedBranches: [],
    currentCandidate: "",
    currentCandidateTarget: null,
    currentCandidateMemoryUpdate: null,
    nativeAgentSession: null,
    constraintIndex: [],
    conversationContextCheckpoint: null,
    contextLedger: null,
    contextCompressionSignature: "",
    contextCompressionStatus: null,
    intentTarget: null,
    queue: [],
    references: [],
    attachments: [],
    createdAt: `${english ? "Today" : "今天"} ${new Intl.DateTimeFormat(english ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`,
    updatedAt: english ? "Not started" : "尚未开始",
  }];
  state.activities = [];
  state.trash = [];
  state.selectedText = "";
  state.settings = { ...state.settings, ...settings, workspacePath, apiKey: settings.apiKey ?? "" };
  return applyStructureCreationLanguage(state, structureLanguage, { blank: true });
};

export const createBlankNotebookState = ({ name = "我的笔记", workspacePath = "", settings = {} } = {}) => {
  const state = createInitialState();
  const conversationId = blankConversationId();
  const structureLanguage = normalizeStructureLanguage(settings.uiLanguage);
  const english = structureLanguage === "en-US";
  state.workspaceKind = "notebook";
  state.structureWorkspaceVersion = STRUCTURE_WORKSPACE_VERSION;
  state.projectName = name;
  state.activeModule = "library";
  state.activeDocument = "";
  state.moduleItems = {
    manuscript: [],
    outline: [],
    canon: [],
    memory: [],
    reports: [],
    library: [],
    index: [],
  };
  state.customFolders = [];
  state.documents = {};
  state.histories = {};
  state.viewHistories = {};
  state.volumeHistories = {};
  state.moduleHistories = { manuscript: [], outline: [], canon: [], memory: [], reports: [], library: [], index: [] };
  state.projectHistories = [];
  state.longFormJobs = [];
  state.messages = [];
  state.snapshots = {};
  state.isolatedBranches = [];
  state.currentCandidate = "";
  state.currentCandidateTarget = null;
  state.currentCandidateMemoryUpdate = null;
  state.activeConversationId = conversationId;
  state.documentConversationBindings = {};
  state.moduleLastDocuments = {};
  state.currentCandidateAuthorization = null;
  state.conversations = [{
    id: conversationId,
    title: english ? "New Chat" : "新对话",
    homeDocumentId: null,
    homeDocumentBoundAtEpoch: 0,
    boundDocumentId: null,
    ...taskConversationMetadata({}, { workspaceKind: "notebook", workspacePath, workspaceName: name }),
    messages: [],
    snapshots: {},
    isolatedBranches: [],
    currentCandidate: "",
    currentCandidateTarget: null,
    currentCandidateMemoryUpdate: null,
    nativeAgentSession: null,
    constraintIndex: [],
    conversationContextCheckpoint: null,
    contextLedger: null,
    contextCompressionSignature: "",
    contextCompressionStatus: null,
    intentTarget: null,
    queue: [],
    references: [],
    attachments: [],
    createdAt: `${english ? "Today" : "今天"} ${new Intl.DateTimeFormat(english ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`,
    updatedAt: english ? "Not started" : "尚未开始",
  }];
  state.activities = [];
  state.trash = [];
  state.selectedText = "";
  state.settings = { ...state.settings, ...settings, workspacePath, apiKey: settings.apiKey ?? "" };
  state.structureLanguage = structureLanguage;
  return state;
};

export const clone = (value) => structuredClone(value);
