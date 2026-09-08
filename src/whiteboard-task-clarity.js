const SKILL_REFERENCE_TYPES = new Set(["skill", "capability"]);
const DOCUMENT_REFERENCE_TYPES = new Set(["book", "document"]);

const BOOK_DECONSTRUCTION_TASK_PATTERN = /(?:拆书|拆文|拆小说|爆款拆解|逆向分析(?:这|该|本)?(?:部作品|本书|篇小说)|拆解(?:这|该|本|整)?(?:本书|部作品|篇小说|篇文章|个故事))/iu;
const BOOK_DECONSTRUCTION_SKILL_PATTERN = /(?:拆书|拆文|拆小说|爆款.{0,8}(?:拆解|逆向)|book[-_\s]?deconstruction)/iu;
const BOOK_DECONSTRUCTION_CAPABILITIES = new Set(["book_deconstruction", "knowledge_reference", "story_deconstruction"]);
const VAGUE_TASK_PATTERN = /^(?:请|麻烦|帮我)?(?:用|使用|调用)?(?:这个|这些|上面的?|连线的?)?(?:skill|技能|文档|内容|资料)?(?:来)?(?:处理|弄|做|执行|开始|参考|看|分析|生成)(?:一?下|一下子|吧|看看)?[。！!？?]*$/iu;
const EXPLICIT_TASK_ACTION_PATTERN = /(?:拆书|拆文|拆小说|拆解|逆向分析|总结|摘要|提炼|提取|归纳|整理|改写|重写|润色|续写|扩写|缩写|翻译|校对|审校|检查|诊断|对比|比较|转换|改编|生成|创作|撰写|编写|制作|设计|输出|列出)/iu;
const EXPLICIT_TASK_OBJECT_PATTERN = /(?:全文|全书|本书|这本书|该书|小说|文章|故事|文档|文本|内容|资料|素材|章节|设定|大纲|剧本|提示词|报告|结构|人物|角色|剧情|机制|方法|结果|成品)/iu;

const normalizedIds = (values = []) => new Set((Array.isArray(values) ? values : String(values || "").split(","))
  .map(String)
  .filter(Boolean));

const skillNodeSearchText = (node = {}) => {
  const selections = Array.isArray(node.reference?.skillSelections) ? node.reference.skillSelections : [];
  return [
    node.reference?.id,
    node.reference?.title,
    node.name,
    ...selections.flatMap((selection) => [
      selection.id,
      selection.relativePath,
      selection.name,
      ...(Array.isArray(selection.authorizedCapabilities) ? selection.authorizedCapabilities : []),
    ]),
  ].filter(Boolean).join(" ");
};

const skillSupportsBookDeconstruction = (node = {}, selectedSkills = []) => {
  if (BOOK_DECONSTRUCTION_SKILL_PATTERN.test(skillNodeSearchText(node))) return true;
  const nodeSelectionIds = new Set((node.reference?.skillSelections ?? [])
    .flatMap((selection) => [selection.id, selection.relativePath])
    .map(String)
    .filter(Boolean));
  if (node.reference?.id) nodeSelectionIds.add(String(node.reference.id));
  return selectedSkills.some((selection) => {
    const selectionId = String(selection.id || selection.relativePath || "");
    if (nodeSelectionIds.size && selectionId && !nodeSelectionIds.has(selectionId)) return false;
    if (BOOK_DECONSTRUCTION_SKILL_PATTERN.test([
      selectionId,
      selection.name,
      selection.capabilityBoundary,
    ].filter(Boolean).join(" "))) return true;
    return (selection.authorizedCapabilities ?? []).some((capability) => BOOK_DECONSTRUCTION_CAPABILITIES.has(String(capability)));
  });
};

const hasClearTaskIntent = (instruction = "") => {
  const task = String(instruction || "").trim();
  if (!task || VAGUE_TASK_PATTERN.test(task)) return false;
  if (BOOK_DECONSTRUCTION_TASK_PATTERN.test(task)) return true;
  return EXPLICIT_TASK_ACTION_PATTERN.test(task) && EXPLICIT_TASK_OBJECT_PATTERN.test(task);
};

const FUZZY_TASK_SKILL_HINTS = [
  { pattern: /(?:改编|改写成|转换成|转成)/iu, capabilities: new Set(["adaptation_writer", "original_script_writer", "custom_writer"]) },
  { pattern: /(?:写|创作|续写|扩写|正文|小说|剧本)/iu, capabilities: new Set(["novel_prose_writer", "short_fiction_writer", "original_script_writer", "custom_writer"]) },
  { pattern: /(?:提示词|画面|分镜|镜头)/iu, capabilities: new Set(["visual_prompt_writer", "prompt_writer", "short_video_script_writer"]) },
  { pattern: /(?:检查|诊断|审校|校对)/iu, capabilities: new Set(["novel_reviewer", "script_reviewer", "content_reviewer", "custom_reviewer"]) },
];

const fuzzyTaskCompatibleSkillNodes = (task, skillNodes = [], selectedSkills = []) => {
  const hint = FUZZY_TASK_SKILL_HINTS.find((item) => item.pattern.test(String(task || "")));
  if (!hint) return [];
  return skillNodes.filter((node) => {
    const nodeCapabilities = new Set([
      ...(Array.isArray(node?.reference?.skillSelections) ? node.reference.skillSelections : [])
        .flatMap((selection) => selection.authorizedCapabilities || []),
      ...selectedSkills.filter((selection) => {
        const nodeIds = new Set((node?.reference?.skillSelections || [])
          .flatMap((selection) => [selection.id, selection.relativePath]).filter(Boolean).map(String));
        return !nodeIds.size || nodeIds.has(String(selection.id || selection.relativePath || ""));
      }).flatMap((selection) => selection.authorizedCapabilities || []),
    ].map(String));
    return [...hint.capabilities].some((capability) => nodeCapabilities.has(capability))
      || [...hint.capabilities].some((capability) => new RegExp(capability.replaceAll("_", "[-_ ]"), "iu").test(skillNodeSearchText(node)));
  });
};

const skillDetails = ({ skillNodes = [], selectedSkills = [] } = {}) => {
  const candidates = [
    ...(Array.isArray(skillNodes) ? skillNodes : []).flatMap((node) => [
      ...(Array.isArray(node?.reference?.skillSelections) ? node.reference.skillSelections : []),
      node?.reference?.type === "skill" ? node.reference : null,
      node,
    ]),
    ...(Array.isArray(selectedSkills) ? selectedSkills : []),
  ];
  const details = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = String(candidate.name || candidate.slotName || candidate.title || candidate.reference?.title || candidate.id || "").trim().replace(/[\r\n\t]+/gu, " ");
    if (!name) continue;
    const capabilities = [
      ...(Array.isArray(candidate.authorizedCapabilities) ? candidate.authorizedCapabilities : []),
      ...(Array.isArray(candidate.selectionAuthorizedCapabilities) ? candidate.selectionAuthorizedCapabilities : []),
      ...(Array.isArray(candidate.capabilities) ? candidate.capabilities : []),
    ].map(String).filter(Boolean);
    const key = `${name.toLocaleLowerCase()}::${[...new Set(capabilities)].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    details.push({ name: name.slice(0, 80), capabilities: [...new Set(capabilities)].slice(0, 16) });
  }
  return details.slice(0, 6);
};

const skillTaskHint = (capabilities = []) => {
  const values = new Set((Array.isArray(capabilities) ? capabilities : []).map(String));
  if (["visual_prompt_writer", "prompt_writer", "short_video_script_writer"].some((item) => values.has(item))) {
    return "请补充主体、场景/风格、镜头或结构要求，以及希望输出的提示词格式";
  }
  if (["book_deconstruction", "story_deconstruction", "knowledge_reference"].some((item) => values.has(item))) {
    return "请补充拆解对象、分析范围和希望输出的维度";
  }
  if (["novel_prose_writer", "short_fiction_writer", "original_script_writer", "adaptation_writer", "custom_writer"].some((item) => values.has(item))) {
    return "请补充写作对象、情节或改写要求、篇幅和交付形式";
  }
  if (["story_planner", "setting_planner"].some((item) => values.has(item))) {
    return "请补充规划对象、范围和需要保留或产出的结构字段";
  }
  if (["creative_guidance", "novel_guidance", "short_drama_guidance", "prompt_guidance"].some((item) => values.has(item))) {
    return "请补充希望确认的方向、限制条件和最终交付目标";
  }
  return "请补充处理对象、具体动作和预期输出";
};

const skillTaskExample = (name, capabilities = []) => {
  const values = new Set((Array.isArray(capabilities) ? capabilities : []).map(String));
  if (["visual_prompt_writer", "prompt_writer", "short_video_script_writer"].some((item) => values.has(item))) {
    return `例如：使用“${name}”为 @目标文档生成可执行的画面/视频提示词，明确主体、场景风格、镜头结构和输出格式。`;
  }
  if (["book_deconstruction", "story_deconstruction", "knowledge_reference"].some((item) => values.has(item))) {
    return `例如：使用“${name}”拆解 @目标文档，输出作品定位、人物关系、剧情结构、关键机制和可复用方法。`;
  }
  if (["novel_prose_writer", "short_fiction_writer", "original_script_writer", "adaptation_writer", "custom_writer"].some((item) => values.has(item))) {
    return `例如：使用“${name}”改写 @目标文档中的指定内容，保持人物和事实约束，输出可直接使用的正式正文。`;
  }
  if (["story_planner", "setting_planner"].some((item) => values.has(item))) {
    return `例如：使用“${name}”整理 @目标文档，输出完整的设定/大纲字段、范围和顺序要求。`;
  }
  return `例如：使用“${name}”处理 @目标文档，写明处理范围、关键要求和最终输出格式。`;
};

export const inspectWhiteboardTaskClarity = ({
  instruction = "",
  upstream = [],
  selectedSkills = [],
  explicitReferenceIds = [],
} = {}) => {
  const task = String(instruction || "").trim();
  const directInputs = Array.isArray(upstream) ? upstream : [];
  const skillNodes = directInputs.filter((node) => SKILL_REFERENCE_TYPES.has(node?.reference?.type));
  const documentNodes = directInputs.filter((node) => DOCUMENT_REFERENCE_TYPES.has(node?.reference?.type));

  // This preflight protects the relationship between connected Skills and
  // source documents. Skill-only and ordinary text-card generation retain the
  // existing flexible behavior and receive a semantic fallback in the prompt.
  if (!skillNodes.length || !documentNodes.length) {
    return { requiresClarification: false, reason: "not_applicable", skillNodes, documentNodes };
  }

  const explicitIds = normalizedIds(explicitReferenceIds);
  const explicitDocuments = documentNodes.filter((node) => explicitIds.has(String(node.id)));
  const explicitSkillNodes = skillNodes.filter((node) => explicitIds.has(String(node.id)));

  if (documentNodes.length > 1 && explicitDocuments.length !== 1) {
    const details = skillDetails({ skillNodes, selectedSkills });
    return { requiresClarification: true, reason: "target_document", skillNodes, documentNodes, skillNames: details.map((item) => item.name), skillCapabilities: details.flatMap((item) => item.capabilities) };
  }

  // With exactly one connected Skill and one document, the connection itself
  // provides enough object/output context for short commands such as
  // “改编”“整理一下” or “继续”. Keep the explicit-intent gate for multiple
  // candidates, where silently choosing a target would be unsafe.
  const fuzzyCompatibleSkillNodes = fuzzyTaskCompatibleSkillNodes(task, skillNodes, selectedSkills);
  const canInferFromContext = documentNodes.length === 1
    && (skillNodes.length === 1 || fuzzyCompatibleSkillNodes.length === 1);
  if (!canInferFromContext && !hasClearTaskIntent(task)) {
    const details = skillDetails({ skillNodes, selectedSkills });
    return { requiresClarification: true, reason: "core_intent", skillNodes, documentNodes, skillNames: details.map((item) => item.name), skillCapabilities: details.flatMap((item) => item.capabilities) };
  }

  const isBookDeconstruction = BOOK_DECONSTRUCTION_TASK_PATTERN.test(task);
  const compatibleSkillNodes = isBookDeconstruction
    ? skillNodes.filter((node) => skillSupportsBookDeconstruction(node, selectedSkills))
    : skillNodes;
  if (isBookDeconstruction && compatibleSkillNodes.length === 0) {
    const details = skillDetails({ skillNodes, selectedSkills });
    return { requiresClarification: true, reason: "skill_mismatch", skillNodes, documentNodes, skillNames: details.map((item) => item.name), skillCapabilities: details.flatMap((item) => item.capabilities) };
  }
  const inferredCompatibleSkillNodes = isBookDeconstruction
    ? compatibleSkillNodes
    : fuzzyCompatibleSkillNodes.length ? fuzzyCompatibleSkillNodes : skillNodes;
  if (skillNodes.length > 1 && explicitSkillNodes.length !== 1 && inferredCompatibleSkillNodes.length !== 1) {
    const details = skillDetails({ skillNodes, selectedSkills });
    return { requiresClarification: true, reason: "target_skill", skillNodes, documentNodes, skillNames: details.map((item) => item.name), skillCapabilities: details.flatMap((item) => item.capabilities) };
  }

  return {
    requiresClarification: false,
    reason: "inferred",
    inferredDocumentId: String((explicitDocuments[0] || documentNodes[0])?.id || ""),
    inferredSkillNodeId: String((explicitSkillNodes[0] || inferredCompatibleSkillNodes[0] || skillNodes[0])?.id || ""),
    skillNodes,
    documentNodes,
  };
};

export const whiteboardTaskClarityMessage = ({ reason = "core_intent", skillNames = [], skillCapabilities = [] } = {}) => {
  const names = [...new Set((Array.isArray(skillNames) ? skillNames : []).map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 4);
  const primarySkill = names[0] || "当前 Skill";
  const skillLine = names.length
    ? `已连接 Skill：${names.join("、")}。${skillTaskHint(skillCapabilities)}`
    : "当前没有可识别的 Skill，请直接写明处理对象、具体动作和预期输出";
  const reasonText = reason === "target_document"
    ? "当前连接了多个候选文档，无法唯一确定要处理哪一个。"
    : reason === "target_skill"
      ? `当前连接了多个可用 Skill（${names.join("、") || "未命名 Skill"}），无法唯一确定要调用哪一个。`
      : reason === "skill_mismatch"
        ? `当前任务与已连接 Skill（${names.join("、") || "未命名 Skill"}）的已知能力不匹配，无法可靠确定执行方式。`
        : "当前指令没有说明清楚要对文档执行什么任务，以及希望得到什么结果。";
  return [
    "当前任务需要补充说明",
    "",
    reasonText,
    "这不是软件故障，本次没有启动模型生成，也没有产生收费请求。",
    "",
    `请在生成要求中 @目标文档，并写清楚要使用的 Skill、具体任务和预期输出。${skillLine}`,
    skillTaskExample(primarySkill, skillCapabilities),
    "",
    "补充明确后再次生成即可。",
  ].join("\n");
};
