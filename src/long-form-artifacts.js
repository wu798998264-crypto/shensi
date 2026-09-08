const clean = (value) => String(value ?? "").trim();
const section = (title, value) => clean(value) ? `## ${title}\n\n${clean(value)}` : "";
const inlineList = (value) => (Array.isArray(value) ? value : [])
  .map(clean)
  .filter(Boolean)
  .join("、");
const fieldLines = (fields) => fields
  .map(([label, value]) => [label, clean(value)])
  .filter(([, value]) => value)
  .map(([label, value]) => `- ${label}：${value}`)
  .join("\n");
const chapterRange = (startChapter, endChapter) => Number.isInteger(startChapter) && Number.isInteger(endChapter)
  ? `第${startChapter}章至第${endChapter}章`
  : "章节待定";
const chapterPoint = (chapter) => Number.isInteger(chapter) ? `第${chapter}章` : "章节待定";
const renderChapterLength = (chapter = {}) => Number.isFinite(Number(chapter.targetWordCount))
  ? `自然目标约 ${Number(chapter.targetWordCount)} 字；验收范围 ${Number(chapter.minimumWordCount)}-${Number(chapter.maximumWordCount)} 字`
  : "";

const renderStoryArchitecture = (architecture = {}) => fieldLines([
  ["结构策略", architecture.strategy],
  ["选择依据", architecture.rationale],
  ["宏观推进模式", architecture.macroPattern],
  ["持续升级引擎", architecture.escalationEngine],
  ["变化规则", inlineList(architecture.variationRules)],
  ["防重复规则", inlineList(architecture.antiRepetitionRules)],
  ["来源", architecture.source === "universal_fallback" ? "通用结构回退（当前题材没有专属理论时启用）" : architecture.source],
]);

const renderPayoffs = (items = []) => items.map((item, index) => {
  if (!item || typeof item !== "object") return `- ${clean(item)}`;
  const title = clean(item.label) || `兑现${index + 1}`;
  const stableId = clean(item.id) ? `〔${clean(item.id)}〕` : "";
  const target = Number.isInteger(item.targetChapter) ? `（第${item.targetChapter}章）` : "";
  const detail = [
    item.setup && `前置：${clean(item.setup)}`,
    item.delivery && `兑现：${clean(item.delivery)}`,
    item.consequence && `后果：${clean(item.consequence)}`,
  ].filter(Boolean).join("；");
  return `- ${title}${stableId}${target}${detail ? `：${detail}` : ""}`;
}).filter(Boolean).join("\n");

const renderInformationRelease = (items = []) => items.map((item, index) => {
  if (!item || typeof item !== "object") return `- ${clean(item)}`;
  const stableId = clean(item.id) ? `〔${clean(item.id)}〕` : "";
  const schedule = [
    Number.isInteger(item.firstChapter) && `首次登场第${item.firstChapter}章`,
    Number.isInteger(item.partialChapter) && `局部揭示第${item.partialChapter}章`,
    Number.isInteger(item.revealChapter) && `正式揭示第${item.revealChapter}章`,
    Number.isInteger(item.completeChapter) && `解释完成第${item.completeChapter}章`,
  ].filter(Boolean).join("；");
  const detail = [
    item.importance && `级别：${clean(item.importance)}`,
    item.action && `动作：${clean(item.action)}`,
    item.carrier && `承载：${clean(item.carrier)}`,
    item.readerBefore && `读者此前：${clean(item.readerBefore)}`,
    item.readerAfter && `读者章后：${clean(item.readerAfter)}`,
    schedule,
  ].filter(Boolean).join("；");
  return `- ${clean(item.topic) || `信息${index + 1}`}${stableId}${detail ? `：${detail}` : ""}`;
}).filter(Boolean).join("\n");

const renderForeshadowing = (items = []) => items.map((item, index) => {
  if (!item || typeof item !== "object") return `- ${clean(item)}`;
  const stableId = clean(item.id) ? `〔${clean(item.id)}〕` : "";
  const progress = (item.progressChapters ?? []).filter(Number.isInteger).map((chapter) => `第${chapter}章`).join("、");
  const detail = [
    item.action && `动作：${clean(item.action)}`,
    item.setup && `埋设：${clean(item.setup)}`,
    Number.isInteger(item.plantChapter) && `埋设章节：第${item.plantChapter}章`,
    progress && `推进章节：${progress}`,
    Number.isInteger(item.payoffChapter) && `回收章节：第${item.payoffChapter}章`,
    item.payoff && `回收与后果：${clean(item.payoff)}`,
    item.status && `状态：${clean(item.status)}`,
  ].filter(Boolean).join("；");
  return `- ${clean(item.label) || `伏笔${index + 1}`}${stableId}${detail ? `：${detail}` : ""}`;
}).filter(Boolean).join("\n");

const renderCharacterArcBeats = (items = []) => items.map((item, index) => {
  if (!item || typeof item !== "object") return `- ${clean(item)}`;
  const ids = [clean(item.id), clean(item.arcId)].filter(Boolean).join(" / ");
  const detail = [
    item.change && `变化：${clean(item.change)}`,
    item.choice && `选择：${clean(item.choice)}`,
    item.cost && `代价：${clean(item.cost)}`,
  ].filter(Boolean).join("；");
  return `- ${clean(item.character) || clean(item.arcId) || `人物弧节点${index + 1}`}${ids ? `〔${ids}〕` : ""}${detail ? `：${detail}` : ""}`;
}).filter(Boolean).join("\n");

const renderSubplotBeats = (items = []) => items.map((item, index) => {
  if (!item || typeof item !== "object") return `- ${clean(item)}`;
  const ids = [clean(item.id), clean(item.subplotId)].filter(Boolean).join(" / ");
  const detail = [item.action && `推进：${clean(item.action)}`, item.consequence && `结果：${clean(item.consequence)}`].filter(Boolean).join("；");
  return `- ${clean(item.title) || clean(item.subplotId) || `副线节点${index + 1}`}${ids ? `〔${ids}〕` : ""}${detail ? `：${detail}` : ""}`;
}).filter(Boolean).join("\n");

const renderStages = (stages = []) => stages.map((stage, index) => [
  `### ${stage.number || index + 1}. ${clean(stage.title) || `阶段${index + 1}`}（${chapterRange(stage.startChapter, stage.endChapter)}）`,
  fieldLines([
    ["稳定 ID", stage.id],
    ["阶段目标", stage.objective],
    ["核心矛盾", stage.mainConflict],
    ["阶段转折", stage.turningPoint],
    ["阶段兑现", stage.payoff],
    ["结束状态", stage.endingState],
    ["下一阶段钩子", stage.nextHook],
    ["情绪曲线", stage.emotionalArc],
    ["张力曲线", stage.tensionCurve],
    ["人物弧", inlineList(stage.characterArcIds)],
    ["副线", inlineList(stage.subplotIds)],
    ["场景类型", inlineList(stage.sceneTypes)],
    ["钩子类型", inlineList(stage.hookTypes)],
  ]),
  renderInformationRelease(stage.informationRelease) && `#### 信息释放\n\n${renderInformationRelease(stage.informationRelease)}`,
  renderForeshadowing(stage.foreshadowing) && `#### 伏笔与回收\n\n${renderForeshadowing(stage.foreshadowing)}`,
].filter(Boolean).join("\n\n")).join("\n\n");

const renderCharacterArcs = (arcs = []) => arcs.map((arc, index) => {
  const milestones = (arc.milestones ?? []).map((item) => {
    const detail = [item.change, item.choice && `选择：${clean(item.choice)}`, item.cost && `代价：${clean(item.cost)}`].filter(Boolean).join("；");
    return `  - ${chapterPoint(item.chapter)}${item.id ? `〔${clean(item.id)}〕` : ""}${item.stageId ? ` / ${clean(item.stageId)}` : ""}：${detail || "变化待定"}`;
  }).join("\n");
  return [
    `### ${clean(arc.character) || `人物${index + 1}`}（${clean(arc.id) || `character-arc-${index + 1}`}）`,
    fieldLines([
      ["角色", arc.role],
      ["弧线类型", arc.arcType],
      ["核心欲望", arc.desire],
      ["恐惧或缺陷", arc.fearOrFlaw],
      ["开篇状态", arc.startingState],
      ["终局状态", arc.endingState],
      ["核心冲突", arc.coreConflict],
    ]),
    milestones && `- 里程碑：\n${milestones}`,
  ].filter(Boolean).join("\n\n");
}).join("\n\n");

const renderSubplots = (subplots = []) => subplots.map((subplot, index) => {
  const milestones = (subplot.milestones ?? []).map((item) => `  - ${chapterPoint(item.chapter)}${item.id ? `〔${clean(item.id)}〕` : ""}：${clean(item.event) || "事件待定"}${item.consequence ? `；结果：${clean(item.consequence)}` : ""}`).join("\n");
  return [
    `### ${clean(subplot.title) || `副线${index + 1}`}（${clean(subplot.id) || `subplot-${index + 1}`}）`,
    fieldLines([
      ["类型", subplot.type],
      ["目标", subplot.objective],
      ["涉及人物", inlineList(subplot.characters)],
      ["章节范围", chapterRange(subplot.startChapter, subplot.endChapter)],
      ["与主线关系", subplot.relationToMain],
      ["收束", subplot.resolution],
    ]),
    milestones && `- 里程碑：\n${milestones}`,
  ].filter(Boolean).join("\n\n");
}).join("\n\n");

const renderScenes = (scenes = []) => scenes.map((scene, index) => [
  `### 场景${scene.number || index + 1}：${clean(scene.type) || "类型待定"}`,
  fieldLines([
    ["地点", scene.location],
    ["视角", scene.pov],
    ["目标", scene.objective],
    ["冲突", scene.conflict],
    ["转折", scene.turn],
    ["结果", scene.result],
    ["情绪", scene.emotion],
    ["张力", scene.tension],
  ]),
  renderInformationRelease(scene.informationRelease) && `#### 信息释放\n\n${renderInformationRelease(scene.informationRelease)}`,
  renderForeshadowing(scene.foreshadowing) && `#### 伏笔与回收\n\n${renderForeshadowing(scene.foreshadowing)}`,
].filter(Boolean).join("\n\n")).join("\n\n");

export const foundationArtifacts = (foundation = {}) => {
  const { canon: _canon, ...structuredFoundation } = foundation;
  const artifacts = [
    {
      id: "outline-series",
      moduleId: "outline",
      title: "全集大纲",
      treeGroup: "series",
      metadata: { longFormFoundation: structuredFoundation },
      content: [
        `# ${foundation.projectTitle || "未命名长篇"}`,
        section("类型与受众", foundation.genre),
        section("目标读者", foundation.audience),
        section("商业与细分赛道定位", foundation.marketPositioning),
        section("核心读者承诺", foundation.corePromise),
        section("故事前提", foundation.premise),
        section("全集结构", foundation.seriesOutline),
        section("故事结构策略", renderStoryArchitecture(foundation.storyArchitecture)),
        section("全书阶段", renderStages(foundation.stages)),
        section("人物弧", renderCharacterArcs(foundation.characterArcs)),
        section("副线", renderSubplots(foundation.subplots)),
        section("全书情绪曲线", foundation.emotionalArc),
        section("全书张力曲线", foundation.tensionCurve),
        section("兑现计划", renderPayoffs(foundation.payoffs)),
        section("场景类型库", inlineList(foundation.sceneTypes)),
        section("信息释放", renderInformationRelease(foundation.informationRelease)),
        section("伏笔与回收", renderForeshadowing(foundation.foreshadowing)),
        section("钩子类型", inlineList(foundation.hookTypes)),
        section("终局兑现", foundation.ending),
      ].filter(Boolean).join("\n\n"),
    },
    ["canon-characters", "人物", "characters"],
    ["canon-world", "世界观", "world"],
    ["canon-factions", "势力", "factions"],
    ["canon-relations", "关系", "relations"],
    ["canon-locations", "地点", "locations"],
    ["canon-items", "物品", "items"],
  ].map((item) => Array.isArray(item) ? {
    id: item[0],
    moduleId: "canon",
    title: item[1],
    content: foundation.canon?.[item[2]] || `# ${item[1]}\n\n待后续章节补充。`,
  } : item);
  for (const volume of foundation.volumes ?? []) {
    artifacts.push({
      id: `outline-volume-${volume.number}`,
      moduleId: "outline",
      title: `第${volume.number}卷卷纲　${volume.title}`,
      treeGroup: "volumes",
      metadata: {
        longFormVolume: volume,
        longFormVolumeRange: { startChapter: volume.startChapter, endChapter: volume.endChapter },
      },
      content: [
        `# ${volume.title}`,
        `章节范围：第${volume.startChapter}章至第${volume.endChapter}章`,
        volume.summary,
        section("本卷目标", volume.objective),
        section("卷首状态", volume.openingState),
        section("卷末状态", volume.endingState),
        section("核心矛盾", volume.mainConflict),
        section("压力升级", volume.escalation),
        section("高潮与转折", volume.climax),
        section("本卷兑现", renderPayoffs(volume.payoffs)),
        section("下一卷钩子", volume.nextVolumeHook),
        section("所属全书阶段", inlineList(volume.stageIds)),
        section("人物弧推进", renderCharacterArcBeats(volume.characterArcBeats)),
        section("副线推进", renderSubplotBeats(volume.subplotBeats)),
        section("情绪曲线", volume.emotionalArc),
        section("张力曲线", volume.tensionCurve),
        section("场景类型", inlineList(volume.sceneTypes)),
        section("信息释放", renderInformationRelease(volume.informationRelease)),
        section("伏笔与回收", renderForeshadowing(volume.foreshadowing)),
        section("钩子类型", inlineList(volume.hookTypes)),
      ].filter((value) => clean(value)).join("\n\n"),
    });
  }
  return artifacts;
};

export const chapterOutlineArtifacts = (chapters = []) => chapters.map((chapter) => ({
  id: `outline-chapter-${chapter.number}`,
  moduleId: "outline",
  title: `第${chapter.number}章章纲　${chapter.title || "未命名"}`,
  treeGroup: "chapters",
  metadata: { longFormChapterOutline: chapter },
  content: [
    `# 第${chapter.number}章　${chapter.title || "未命名"}`,
    chapter.outline,
    section("章节功能", chapter.objective),
    section("本章字数变量", renderChapterLength(chapter)),
    section("所属全书阶段", chapter.stageId),
    section("场景锚点", renderScenes(chapter.scenes)),
    section("场景类型", inlineList(chapter.sceneTypes)),
    section("人物弧推进", renderCharacterArcBeats(chapter.characterArcBeats)),
    section("副线推进", renderSubplotBeats(chapter.subplotBeats)),
    section("情绪曲线", chapter.emotionalArc),
    section("张力曲线", chapter.tensionCurve),
    section("本章兑现", renderPayoffs(chapter.payoffs)),
    section("信息释放", renderInformationRelease(chapter.informationRelease)),
    section("伏笔与回收", renderForeshadowing(chapter.foreshadowing)),
    section("章末追读点", chapter.hook),
    section("钩子类型", chapter.hookType),
  ].filter(Boolean).join("\n\n"),
}));

export const longFormChapterPrompt = ({ chapterNumber, chapterTitle, userPrompt, lengthVariable = "" }) => [
  `请直接生成第${chapterNumber}章《${chapterTitle || "未命名"}》正式正文。`,
  "只生成这一章，不得合并前后章节。正文开头必须保留明确的第N章标题，供程序识别目标文档。",
  clean(lengthVariable),
  "完成效果检查、连续性检查和必要返修后输出候选稿。不要追问。",
  userPrompt ? `原始自动创作要求：${userPrompt}` : "",
].filter(Boolean).join("\n");
