import { WORKSPACE_MODULES } from "./module-registry.js";
import { DREAMINA_VIDEO_CLI_ALIAS, DREAMINA_VIDEO_CLI_ARGS, OPENAI_IMAGE_CLI_ALIAS, OPENAI_IMAGE_CLI_ARGS } from "./media-cli-presets.js";
import { applyStructureCreationLanguage, normalizeStructureLanguage } from "./structure-language.js";
import { STRUCTURE_WORKSPACE_VERSION } from "./structure-schema.js";
import { canonicalEpisodeTitle, episodeHeadingParts, parseEpisodeHeading } from "./episode-document.js";
import { effectiveSequencedDocumentNumber, freeDocumentTitle, legacySequencedTitleParts, sequencedDocumentKind, sequencedDocumentLabel } from "./document-title-policy.js";
import { taskConversationMetadata } from "./workspace-conversation-policy.js";
import { DEFAULT_AGENT_PERMISSION_MODE } from "./agent-permission-policy.js";

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
    ["script-episode-1", "第一集", { workspaceView: "script", contextDomain: "script", treeGroup: "scripts" }],
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

const documents = Object.fromEntries(Object.entries(MODULE_ITEMS).flatMap(([moduleId, items]) => items
  .filter(([, , metadata]) => !metadata?.alias)
  .map(([id, title, metadata = {}]) => [id, { title, html: "", markdown: "", moduleId, ...metadata,
    ...(id === "report-compile" ? { derived: true } : {}), ...(id === "library-memo" ? { userFacingReference: true } : {}),
  }])));

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
  activeDocument: "",
  documentTabs: [{ id: "document-tab-1", documentId: "" }],
  activeDocumentTabId: "document-tab-1",
  documentViewStates: {},
  moduleItems: structuredClone(MODULE_ITEMS),
  customFolders: [],
  documents: structuredClone(documents),
  histories: {},
  chapterEpisodeMappings: [],
  viewHistories: {},
  volumeHistories: {},
  moduleHistories: {},
  projectHistories: [],
  workspaceAssets: [],
  assetHistoryTombstones: [],
  longFormJobs: [],
  currentVersionMeta: { documents: {}, views: {}, volumes: {}, modules: {}, project: null },
  messages: [],
  snapshots: {},
  isolatedBranches: [],
  currentCandidate: "",
  currentCandidateTarget: null,
  currentCandidateMemoryUpdate: null,
  activeConversationId: "conversation-main",
  documentConversationBindings: {},
  conversations: [{
    id: "conversation-main", title: "新对话", homeDocumentId: null, boundDocumentId: null,
    messages: [], snapshots: {}, isolatedBranches: [], currentCandidate: "",
    currentCandidateTarget: null, currentCandidateMemoryUpdate: null,
    nativeAgentSession: null, constraintIndex: [], conversationContextCheckpoint: null,
    contextLedger: null, queue: [], references: [], attachments: [],
  }],
  activities: [],
  trash: [],
  selectedText: "",
  settings: {
    activeTextConnectionId: "text-public-agent",
    activeTextAgentConnectionId: "text-public-agent",
    agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
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
    imageModel: "gpt-image-2.5",
    imageApiKey: "",
    imageTimeoutMs: "660000",
    imageCliPath: OPENAI_IMAGE_CLI_ALIAS,
    imageCliArgs: OPENAI_IMAGE_CLI_ARGS,
    videoProvider: "即梦",
    videoAdapter: "cli",
    videoProtocol: "videos",
    videoBaseUrl: "",
    videoModel: "seedance2.5",
    videoApiKey: "",
    videoTimeoutMs: "1800000",
    videoCliPath: DREAMINA_VIDEO_CLI_ALIAS,
    videoCliArgs: DREAMINA_VIDEO_CLI_ARGS,
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
