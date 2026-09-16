import { contentRevision } from "./workspace-operations.js";

const text = (value = "") => String(value ?? "").replace(/\r\n?/gu, "\n");
const clean = (value = "") => text(value).trim();
const unique = (values) => [...new Set(values.filter(Boolean))];

export const MATERIAL_UPDATE_SCHEMA = "shensi.material-update-plan.v1";

export const MATERIAL_DOCUMENT_TITLES = Object.freeze({
  "canon-characters": "人物设定",
  "canon-relations": "人物关系",
  "canon-world": "世界观与基础规则",
  "canon-locations": "地图与地点",
  "canon-factions": "势力与组织",
  "canon-events": "事件与时间线",
  "canon-items": "物品与道具",
  "canon-glossary": "术语表",
  "script-canon-characters": "人物改编",
  "script-canon-relations": "关系改编",
  "script-canon-world": "世界与规则改编",
  "script-canon-locations": "场景与地点改编",
  "script-canon-factions": "势力与组织改编",
  "script-canon-events": "事件与时间线改编",
  "script-canon-items": "道具改编",
  "script-canon-glossary": "剧本术语",
  "outline-series": "全书大纲",
  "script-outline-series": "全集大纲",
  "memory-snapshot": "状态快照",
  "memory-foreshadowing": "伏笔管理",
  "memory-information-ledger": "信息账本",
  "memory-first-appearance": "重要信息登场账本",
  "memory-release": "信息释放表",
  "memory-reader": "读者当前知识库",
  "script-memory-snapshot": "剧本状态快照",
  "script-memory-foreshadowing": "剧本伏笔管理",
  "script-memory-information-ledger": "剧本信息账本",
  "script-memory-first-appearance": "剧本重要信息登场账本",
  "script-memory-release": "剧本信息释放表",
  "script-memory-audience": "观众当前知识库",
  "library-memo": "备忘录",
});

export const isMaterialUpdateDocumentId = (documentId = "") => {
  const id = clean(documentId);
  return /^(?:canon-(?:characters|relations|world|locations|factions|events|items|glossary)|script-canon-(?:characters|relations|world|locations|factions|events|items|glossary)|outline-(?:series|volume-\d+|chapter-\d+)|script-outline-(?:series|episode-\d+)|memory-(?:snapshot|foreshadowing|information-ledger|first-appearance|release|reader)|script-memory-(?:snapshot|foreshadowing|information-ledger|first-appearance|release|audience)|library-memo)$/u.test(id);
};

export const materialUpdateDocumentTitle = (documentId = "", fallback = "") => {
  const id = clean(documentId);
  if (MATERIAL_DOCUMENT_TITLES[id]) return MATERIAL_DOCUMENT_TITLES[id];
  const volume = Number(id.match(/^outline-volume-(\d+)$/u)?.[1] || 0);
  if (volume) return `第${volume}卷卷纲`;
  const chapter = Number(id.match(/^outline-chapter-(\d+)$/u)?.[1] || 0);
  if (chapter) return `第${chapter}章章纲`;
  const episode = Number(id.match(/^script-outline-episode-(\d+)$/u)?.[1] || 0);
  if (episode) return `第${episode}集集纲`;
  return clean(fallback) || id;
};

export const materialUpdateModuleId = (documentId = "") => {
  const id = clean(documentId);
  if (/^(?:canon-|script-canon-)/u.test(id)) return "canon";
  if (/^(?:outline-|script-outline-)/u.test(id)) return "outline";
  if (/^(?:memory-|script-memory-)/u.test(id)) return "memory";
  if (id === "library-memo") return "library";
  return "";
};

export const materialUpdateSourceRevisions = ({ documents = {}, sourceDocumentIds = [] } = {}) => Object.fromEntries(
  (Array.isArray(sourceDocumentIds) ? sourceDocumentIds : [sourceDocumentIds])
    .map(clean)
    .filter((documentId) => Boolean(documentId && documents?.[documentId]))
    .map((documentId) => [
      documentId,
      contentRevision(text(documents[documentId]?.html || documents[documentId]?.markdown || documents[documentId]?.text || "")),
    ]),
);

export const materialUpdateSourceRevisionConflicts = ({ documents = {}, sourceRevisions = {} } = {}) => (
  Object.entries(sourceRevisions && typeof sourceRevisions === "object" ? sourceRevisions : {})
    .filter(([documentId, expectedRevision]) => {
      const document = documents?.[documentId];
      if (!document || !expectedRevision) return true;
      const currentRevision = contentRevision(text(document.html || document.markdown || document.text || ""));
      return currentRevision !== expectedRevision;
    })
    .map(([documentId]) => documentId)
);

const operationRank = Object.freeze({ append: 1, insert: 2, patch: 3, snapshot: 4, create: 5, replace: 6 });
const normalizedChangeType = (value = "") => ({
  new: "insert",
  add: "insert",
  insert: "insert",
  upsert: "patch",
  update: "patch",
  modify: "patch",
  patch: "patch",
  state: "snapshot",
  snapshot: "snapshot",
  append: "append",
  continue: "append",
  overturn: "replace",
  reset: "replace",
  replace: "replace",
  rewrite: "replace",
  create: "create",
}[clean(value).toLowerCase()] || "");

const jsonCandidates = (value = "") => {
  const source = clean(value);
  const candidates = [source.replace(/^```(?:json)?\s*|\s*```$/giu, "").trim()];
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  return unique(candidates);
};

const evidenceList = (value, sourceDocumentIds) => (Array.isArray(value) ? value : [])
  .map((item) => typeof item === "string"
    ? { sourceDocumentId: "", quote: clean(item) }
    : {
      sourceDocumentId: clean(item?.sourceDocumentId || item?.documentId || item?.source),
      quote: clean(item?.quote || item?.evidence || item?.text),
    })
  .filter((item) => item.quote && (!item.sourceDocumentId || sourceDocumentIds.has(item.sourceDocumentId)))
  .slice(0, 24);

export const parseMaterialUpdatePlan = (value = "", {
  documents = {},
  sourceDocumentIds = [],
  sourceRevisions = {},
  allowedTargetDocumentIds = [],
} = {}) => {
  let parsed = null;
  for (const candidate of jsonCandidates(value)) {
    try {
      const next = JSON.parse(candidate);
      if (next && typeof next === "object" && !Array.isArray(next)) { parsed = next; break; }
    } catch {
      // Try the next fenced or embedded JSON candidate.
    }
  }
  if (!parsed) throw Object.assign(new Error("资料差异检查没有返回可验证的结构化计划"), { code: "MATERIAL_UPDATE_PLAN_INVALID" });
  const sources = new Set((Array.isArray(sourceDocumentIds) ? sourceDocumentIds : []).map(clean).filter(Boolean));
  const allowedTargets = new Set((Array.isArray(allowedTargetDocumentIds) ? allowedTargetDocumentIds : []).map(clean).filter(Boolean));
  const changes = (Array.isArray(parsed.changes) ? parsed.changes : [])
    .map((item) => {
      const targetDocumentId = clean(item?.targetDocumentId || item?.documentId || item?.target);
      let changeType = normalizedChangeType(item?.changeType || item?.operation || item?.action);
      const existing = Boolean(documents?.[targetDocumentId]);
      if (!existing && ["insert", "patch", "append"].includes(changeType)) changeType = "create";
      if (existing && changeType === "create") changeType = "insert";
      if (/^(?:memory-|script-memory-)/u.test(targetDocumentId)) changeType = "snapshot";
      return {
        targetDocumentId,
        targetTitle: materialUpdateDocumentTitle(targetDocumentId, item?.targetTitle || documents?.[targetDocumentId]?.title),
        changeType,
        reason: clean(item?.reason || item?.difference || item?.summary),
        evidence: evidenceList(item?.evidence, sources),
        entityHeadings: unique((Array.isArray(item?.entityHeadings) ? item.entityHeadings : [item?.entityHeading || item?.entity || item?.name])
          .map(clean).filter(Boolean)).slice(0, 40),
      };
    })
    .filter((item) => isMaterialUpdateDocumentId(item.targetDocumentId)
      && (!allowedTargets.size || allowedTargets.has(item.targetDocumentId))
      && item.changeType
      && item.evidence.length);
  const grouped = new Map();
  for (const item of changes) {
    const previous = grouped.get(item.targetDocumentId);
    if (!previous) {
      grouped.set(item.targetDocumentId, item);
      continue;
    }
    grouped.set(item.targetDocumentId, {
      ...previous,
      changeType: operationRank[item.changeType] > operationRank[previous.changeType] ? item.changeType : previous.changeType,
      reason: unique([previous.reason, item.reason]).join("；"),
      evidence: [...new Map([...previous.evidence, ...item.evidence].map((entry) => [`${entry.sourceDocumentId}\u0000${entry.quote}`, entry])).values()],
      entityHeadings: unique([...previous.entityHeadings, ...item.entityHeadings]),
    });
  }
  return {
    schema: MATERIAL_UPDATE_SCHEMA,
    sourceDocumentIds: [...sources],
    sourceRevisions: Object.fromEntries([...sources]
      .filter((documentId) => clean(sourceRevisions?.[documentId]))
      .map((documentId) => [documentId, clean(sourceRevisions[documentId])])),
    changes: [...grouped.values()],
    summary: clean(parsed.summary),
  };
};

export const materialUpdateInspectionInstruction = ({ sourceDocuments = [], targetDocuments = [] } = {}) => [
  "请只检查刚刚落盘的正式内容是否产生了需要同步的作品资料差异，本阶段禁止写入任何文档。",
  "逐条比较正文证据与现有正史设定、相关大纲、结构化记忆和作品资料库；没有真实差异时 changes 必须为空。不得把语言润色、推测、未来可能性或重复信息当成资料变化。",
  "变化类型只能使用：insert（新增记录）、patch（修改已有记录）、snapshot（结构化记忆字段变化）、append（适合末尾累积）、replace（明确推翻整个目标）、create（目标文档不存在且首次写入）。",
  "新增设定或大纲记录使用 insert 或 append；已有设定或剧情规划改变使用 patch；只有原有目标整体被正式内容明确推翻时才能使用 replace。资料库只允许更新作品备忘录，不得改写导入的原始来源资料。",
  "记忆变化必须指向具体记忆目标并使用 snapshot；人物状态、伏笔和信息释放没有发生变化时，不得为了刷新而返回记忆变化。",
  "每项必须给出来源文档 ID 和正文连续原句。没有正文原句证据的项目不得返回。",
  `来源文档：${sourceDocuments.map((item) => `${item.documentId}《${item.title || item.documentId}》`).join("、") || "无"}`,
  `可选目标：${targetDocuments.map((item) => `${item.documentId}《${item.title || materialUpdateDocumentTitle(item.documentId)}》${item.exists ? "" : "（尚未创建）"}`).join("、") || "无"}`,
  "只返回一个 JSON 对象，不使用 Markdown 围栏：",
  `{"schema":"${MATERIAL_UPDATE_SCHEMA}","summary":"检查结论","changes":[{"targetDocumentId":"canon-items","targetTitle":"物品与道具","changeType":"insert","reason":"具体差异","entityHeadings":["神器名称"],"evidence":[{"sourceDocumentId":"chapter-8","quote":"正文连续原句"}]}]}`,
].join("\n");

export const materialUpdateExecutionInstruction = (plan = {}) => {
  const changes = Array.isArray(plan?.changes) ? plan.changes.filter((item) => item.changeType !== "snapshot") : [];
  const sourceRevisionSummary = Object.entries(plan?.sourceRevisions ?? {})
    .map(([documentId, revision]) => `${documentId}=${revision}`)
    .join("；");
  const deliverables = changes.map((item, index) => [
    `交付物 ${String.fromCharCode(65 + index)}：${item.targetTitle || materialUpdateDocumentTitle(item.targetDocumentId)}`,
    `目标文档 ID：${item.targetDocumentId}`,
    `写入策略：${item.changeType}`,
    `涉及记录：${item.entityHeadings?.join("、") || "按证据确定"}`,
    `正文证据：${item.evidence?.map((entry) => `${entry.sourceDocumentId}｜${entry.quote}`).join("；") || "无"}`,
  ].join("\n")).join("\n\n");
  return [
    "根据已经通过检查的资料差异计划更新正式作品资料。只处理下列交付物，不得增加目标。",
    sourceRevisionSummary ? `本计划绑定的来源正文版本：${sourceRevisionSummary}` : "",
    deliverables,
    "执行规则：",
    "1. insert：只返回需要新增的二级标题记录；不得重写现有全文。",
    "2. patch：只返回发生变化的二级标题记录，程序将按标题局部替换或新增；不得返回无变化记录。",
    "3. append：只返回需要追加的新内容。",
    "4. replace：返回目标文档的完整最新内容；只有本计划明确标记 replace 才允许全文覆盖。",
    "5. create：返回首次创建所需的完整正式内容。",
    "6. 不写分析、差异说明、完成回执、自检过程或旧版本。",
  ].filter(Boolean).join("\n\n");
};

export const materialUpdateOutputContract = (plan = {}) => {
  const changes = Array.isArray(plan?.changes) ? plan.changes.filter((item) => item.changeType !== "snapshot") : [];
  if (!changes.length) return "";
  return [
    "# 资料增量输出合同",
    "只返回一个 JSON 对象，不使用 Markdown 代码围栏。",
    "格式：{\"artifacts\":[{\"deliverableId\":\"合同交付物 id\",\"targetDocumentId\":\"目标文档 id\",\"operation\":\"patch|append|replace|create\",\"title\":\"文档标题\",\"insertBeforeHeading\":\"可选的既有二级标题\",\"insertAfterHeading\":\"可选的既有二级标题\",\"content\":\"正式内容\"}]}。",
    ...changes.map((item) => `- ${item.targetDocumentId}：operation 必须为 ${["insert", "patch"].includes(item.changeType) ? "patch" : item.changeType}；${["insert", "patch"].includes(item.changeType) ? "content 只包含新增或变化的二级标题记录" : item.changeType === "append" ? "content 只包含末尾新增内容" : "content 包含完整最新正式内容"}。`),
    "artifacts 必须与计划目标逐项对应，不得遗漏、增加或合并目标。分析、证据说明、执行回执和旧版本不得进入 content。",
  ].join("\n");
};

const sectionRecords = (value = "") => {
  const source = text(value);
  if (/<h2\b/iu.test(source)) {
    const htmlMatches = [...source.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/giu)];
    return htmlMatches.map((match, index) => ({
      heading: clean(match[1].replace(/<[^>]+>/gu, " ")
        .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'")),
      start: Number(match.index),
      end: Number(htmlMatches[index + 1]?.index ?? source.length),
      content: source.slice(Number(match.index), Number(htmlMatches[index + 1]?.index ?? source.length)).trimEnd(),
    }));
  }
  const matches = [...source.matchAll(/^##\s+([^\n]+?)\s*$/gmu)];
  return matches.map((match, index) => ({
    heading: clean(match[1]),
    start: Number(match.index),
    end: Number(matches[index + 1]?.index ?? source.length),
    content: source.slice(Number(match.index), Number(matches[index + 1]?.index ?? source.length)).trimEnd(),
  }));
};

export const compileManagedMaterialMutation = ({
  currentContent = "",
  candidateContent = "",
  changeType = "patch",
  targetExists = true,
  insertBeforeHeading = "",
  insertAfterHeading = "",
} = {}) => {
  const current = text(currentContent).trim();
  const candidate = text(candidateContent).trim();
  const operation = normalizedChangeType(changeType) || "patch";
  if (!candidate) throw Object.assign(new Error("资料更新候选为空"), { code: "MATERIAL_UPDATE_EMPTY_CANDIDATE" });
  if (!targetExists || operation === "create") return { changed: true, operation: "create", content: candidate, patches: [], beforeRevision: contentRevision(current), afterRevision: contentRevision(candidate) };
  if (operation === "replace") return {
    changed: current !== candidate,
    operation: "replace",
    content: candidate,
    patches: [],
    beforeRevision: contentRevision(current),
    afterRevision: contentRevision(candidate),
  };
  if (operation === "append") {
    if (current.includes(candidate)) return { changed: false, operation: "append", content: current, patches: [], beforeRevision: contentRevision(current), afterRevision: contentRevision(current) };
    const next = `${current}${current ? "\n\n" : ""}${candidate}`;
    return { changed: true, operation: "append", content: next, patches: [{ type: "append", content: candidate }], beforeRevision: contentRevision(current), afterRevision: contentRevision(next) };
  }
  const currentSections = sectionRecords(current);
  const candidateSections = sectionRecords(candidate);
  if (!currentSections.length || !candidateSections.length) {
    throw Object.assign(new Error("新增或局部修改没有形成可安全定位的二级标题记录，已阻止全文覆盖"), { code: "MATERIAL_UPDATE_UNSAFE_PATCH" });
  }
  const currentByHeading = new Map(currentSections.map((section) => [section.heading, section]));
  const patches = [];
  const insertionByOffset = new Map();
  for (const section of candidateSections) {
    const existing = currentByHeading.get(section.heading);
    if (existing) {
      if (clean(existing.content) === clean(section.content)) continue;
      patches.push({
        type: "range",
        editId: `material-section-${patches.length + 1}`,
        start: existing.start,
        end: existing.end,
        expectedText: current.slice(existing.start, existing.end),
        content: `${section.content}\n\n`,
      });
      continue;
    }
    const before = currentByHeading.get(clean(insertBeforeHeading));
    const after = currentByHeading.get(clean(insertAfterHeading));
    const offset = before?.start ?? after?.end ?? current.length;
    const separator = offset === current.length && current && !current.endsWith("\n") ? "\n\n" : "";
    const inserted = `${separator}${section.content}\n\n`;
    insertionByOffset.set(offset, `${insertionByOffset.get(offset) || ""}${inserted}`);
  }
  for (const [offset, content] of insertionByOffset) patches.push({
    type: "range",
    editId: `material-insert-${patches.length + 1}`,
    start: offset,
    end: offset,
    expectedText: "",
    content,
  });
  if (!patches.length) return { changed: false, operation: "patch", content: current, patches: [], beforeRevision: contentRevision(current), afterRevision: contentRevision(current) };
  return { changed: true, operation: "patch", content: "", patches, beforeRevision: contentRevision(current), afterRevision: "" };
};

export const materialDocumentRevisions = (documents = {}) => Object.fromEntries(Object.entries(documents)
  .filter(([documentId]) => isMaterialUpdateDocumentId(documentId))
  .map(([documentId, document]) => [documentId, contentRevision(text(document?.html || document?.markdown || document?.text || ""))]));

export const unintendedMaterialDocumentChanges = ({ before = {}, after = {}, targetDocumentIds = [] } = {}) => {
  const targets = new Set((Array.isArray(targetDocumentIds) ? targetDocumentIds : []).map(clean));
  return Object.keys(before).filter((documentId) => !targets.has(documentId) && before[documentId] !== after[documentId]);
};
