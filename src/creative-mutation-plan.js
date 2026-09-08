import { explicitDeliverableArtifactTargets, requestedArtifactTargets } from "./artifact-target.js";
import { explicitlyDefersCandidateLanding, requestedChapterBatch, requestedChapterTarget } from "./chapter-target.js";
import { resolveDocumentTarget } from "./document-target-resolver.js";
import { compileTaskContract, taskContractInstructionSections, taskContractOutputContract } from "./task-contract.js?v=3.0.10-character-preflight-2";
import { managedDocumentFormatInstruction } from "./managed-document-format.js";
import { materialUpdateOutputContract } from "./material-update-plan.js";
import { documentMutationKindForInstruction, documentMutationOutputInstruction } from "./document-edit-plan.js";

const text = (value = "") => String(value ?? "").trim();
const chapterNumber = (documentId = "") => Number(String(documentId).match(/^chapter-(\d+)$/)?.[1] ?? 0);

const PROSE_PRODUCTION_PATTERN = /(?:写|写出|生成|续写|创作|撰写|完成|改写|重写|补写|扩写).{0,24}(?:小说)?(?:正文|章节|下一章|下章|后续正文|后续章节)|(?:正文|章节|下一章|下章|后续正文|后续章节).{0,24}(?:写|写出|生成|续写|创作|撰写|完成|改写|重写|补写|扩写)/u;
const PROSE_RANGE_PATTERN = /(?:前\s*[一二两三四五六七八九十百千万\d]+\s*章|第\s*[一二两三四五六七八九十百千万\d]+\s*章\s*(?:至|到|—|-|~|～)\s*第?\s*[一二两三四五六七八九十百千万\d]+\s*章).{0,12}(?:正式)?正文|(?:正式)?正文.{0,12}(?:前\s*[一二两三四五六七八九十百千万\d]+\s*章|第\s*[一二两三四五六七八九十百千万\d]+\s*章\s*(?:至|到|—|-|~|～)\s*第?\s*[一二两三四五六七八九十百千万\d]+\s*章)/u;
const requestedMinimumChapterCharacters = (value = "") => Math.max(0, Number(String(value).match(/每章(?:正文)?[^。！？；;\n]{0,100}(?:不少于|至少|不低于)\s*(\d+)\s*(?:个)?(?:中文)?字(?:符)?/u)?.[1]) || 0);

const artifactMentionPattern = (artifact = {}) => {
  if (artifact.documentId === "library-reference") return /(?:当前作品的|作品内的|创作|参考|研究)?资料(?:库|文档|汇总|总表)?/u;
  if (artifact.documentId === "canon-world") return /(?:小说|作品)?设定|世界观|基础规则/u;
  if (artifact.documentId === "outline-series") return /(?:全书|全集|整书|小说)?大纲|总纲/u;
  if (artifact.documentId === "memory-foreshadowing") return /伏笔(?:总表|管理|账本)?|暗线(?:总表|管理|账本)?|(?:当前作品|作品|相关|必要)?记忆(?:文档|模块|库)?/u;
  if (artifact.documentId === "memory-release") return /信息(?:释放表|释放|台阶)|读者(?:当前)?知识|(?:当前作品|作品|相关|必要)?记忆(?:文档|模块|库)?/u;
  if (artifact.moduleId === "reports") return /报告|自检文档|验收文档/u;
  const title = text(artifact.title);
  return title ? new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u") : null;
};

const explicitlyMutatedArtifactTargets = (targets = [], source = "") => (Array.isArray(targets) ? targets : []).filter((artifact) => {
  const mention = artifactMentionPattern(artifact);
  if (!mention) return false;
  return String(source || "").split(/\r?\n/u).some((rawLine) => {
    const line = rawLine.replace(/(?:已经|已|现有|已有|此前|先前)[^，。！？；;\n]{0,12}(?:落盘|写入|生成|创建|保存)/gu, " ");
    return mention.test(line) && /(?:写入|写进|写出|加入|纳入|补进|生成|创作|创建|新建|改写|重写|修改|更新|补充|追加|输出|产出|保存|存入|记入|记录(?:到)?|同步(?:到)?|整理成|落盘)/u.test(line);
  });
});

const normalizedInventory = (inventory = []) => (Array.isArray(inventory) ? inventory : [])
  .map((item) => ({
    ...item,
    id: text(item?.id || item?.documentId),
    moduleId: text(item?.moduleId),
    title: text(item?.title),
    characters: Math.max(0, Number(item?.characters) || 0),
  }))
  .filter((item) => item.id);

const targetWithOperation = (target, inventoryById, reason) => ({
  ...target,
  operation: ["patch", "append", "replace", "create"].includes(String(target?.operation || ""))
    ? String(target.operation)
    : inventoryById.has(target.documentId) ? "patch" : "create",
  resolutionReason: reason,
});

export const nextNovelChapterTarget = ({ instruction = "", boundDocumentId = "", inventory = [] } = {}) => {
  const items = normalizedInventory(inventory);
  const chapterItems = items
    .filter((item) => /^chapter-\d+$/.test(item.id))
    .sort((left, right) => chapterNumber(left.id) - chapterNumber(right.id));
  const plannedNumbers = items
    .map((item) => Number(item.id.match(/^outline-chapter-(\d+)$/)?.[1] ?? 0))
    .filter(Boolean)
    .sort((left, right) => left - right);
  const boundNumber = chapterNumber(boundDocumentId);
  const explicitlyRelative = /下一章|下章|后续(?:正文|章节)?|接着写|继续写|续写/u.test(text(instruction));
  if (boundNumber && explicitlyRelative) {
    const number = boundNumber + 1;
    return { documentId: `chapter-${number}`, chapterNumber: number, title: `第${number}章`, moduleId: "manuscript", contextDomain: "novel", explicitChapter: true, inferredFromDeliverable: true };
  }

  const completedNumbers = chapterItems.filter((item) => item.characters >= 80).map((item) => chapterNumber(item.id));
  const completedMax = completedNumbers.length ? Math.max(...completedNumbers) : 0;
  const plannedNext = plannedNumbers.find((number) => number > completedMax && !chapterItems.some((item) => chapterNumber(item.id) === number && item.characters >= 80));
  const blankNext = chapterItems.find((item) => chapterNumber(item.id) > completedMax && item.characters < 80);
  const number = plannedNext
    || chapterNumber(blankNext?.id)
    || Math.max(0, ...chapterItems.map((item) => chapterNumber(item.id)), ...plannedNumbers) + 1;
  return { documentId: `chapter-${Math.max(1, number)}`, chapterNumber: Math.max(1, number), title: `第${Math.max(1, number)}章`, moduleId: "manuscript", contextDomain: "novel", explicitChapter: true, inferredFromDeliverable: true };
};

export const compileCreativeMutationPlan = ({
  instruction = "",
  boundDocument = null,
  inventory = [],
  contextDomain = "novel",
  formalWriteIntent = false,
  productionIntent = false,
  explicitlyRequestsBoundDocument = false,
  explicitTargets = [],
  requiredContextDocumentIds = [],
} = {}) => {
  const source = text(instruction);
  const instructionSections = taskContractInstructionSections(source);
  const affirmativeSource = instructionSections.affirmativeInstruction || source;
  const items = normalizedInventory(inventory);
  const inventoryById = new Map(items.map((item) => [item.id, item]));
  const contextSources = boundDocument?.documentId
    ? [{ documentId: boundDocument.documentId, role: "bound_context", title: text(boundDocument.title), moduleId: text(boundDocument.moduleId) }]
    : [];
  const declaredArtifactTargets = formalWriteIntent ? explicitDeliverableArtifactTargets(affirmativeSource, { contextDomain }) : null;
  const artifactTargets = formalWriteIntent
    ? (declaredArtifactTargets?.length
      ? declaredArtifactTargets
      : explicitlyMutatedArtifactTargets(requestedArtifactTargets(affirmativeSource, { contextDomain }), affirmativeSource))
    : [];
  const declaredChapterBatch = productionIntent ? requestedChapterBatch(affirmativeSource, { baseChapterNumber: 0 }) : null;
  const proseProduction = productionIntent && (
    PROSE_PRODUCTION_PATTERN.test(affirmativeSource)
    || PROSE_RANGE_PATTERN.test(affirmativeSource)
    || Boolean(declaredChapterBatch && /(?:分别)?写入\s*chapter-\d+|chapter-\d+\s*(?:至|到|[-~～—])\s*chapter-\d+/iu.test(affirmativeSource))
  );
  const minimumChapterCharacters = proseProduction ? requestedMinimumChapterCharacters(source) : 0;
  const chapterBatch = proseProduction ? declaredChapterBatch : null;
  const explicitChapter = proseProduction ? requestedChapterTarget(affirmativeSource) : null;
  const chapterTargets = chapterBatch
    ? Array.from({ length: chapterBatch.count }, (_, index) => {
        const number = chapterBatch.startChapter + index;
        return {
          documentId: chapterBatch.documentIds?.[index] || `chapter-${number}`,
          chapterNumber: number,
          title: `第${number}章`,
          moduleId: "manuscript",
          contextDomain: "novel",
          explicitChapter: true,
          ...(minimumChapterCharacters ? { minCharacters: minimumChapterCharacters } : {}),
        };
      })
    : explicitChapter ? [{ ...explicitChapter, moduleId: "manuscript", contextDomain: "novel", explicitChapter: true, ...(minimumChapterCharacters ? { minCharacters: minimumChapterCharacters } : {}) }] : [];
  const resolved = [];

  if (Array.isArray(explicitTargets) && explicitTargets.length) {
    resolved.push(...explicitTargets.map((target) => targetWithOperation(target, inventoryById, "explicit_workflow_target")));
  } else if (artifactTargets.length || chapterTargets.length) {
    resolved.push(...artifactTargets.map((target) => targetWithOperation(target, inventoryById, "explicit_artifact")));
    resolved.push(...chapterTargets.map((target) => targetWithOperation(target, inventoryById, chapterBatch ? "explicit_chapter_batch" : "explicit_chapter")));
  } else if (explicitlyRequestsBoundDocument && boundDocument?.documentId && (productionIntent || formalWriteIntent)) {
    resolved.push(targetWithOperation({
      documentId: boundDocument.documentId,
      moduleId: boundDocument.moduleId,
      contextDomain,
      title: boundDocument.title,
      explicitArtifact: true,
    }, inventoryById, "explicit_bound_document"));
  } else if (proseProduction) {
    const semanticProseTarget = nextNovelChapterTarget({ instruction: affirmativeSource, boundDocumentId: boundDocument?.documentId, inventory: items });
    const targetDecision = resolveDocumentTarget({
      instruction: source,
      boundTarget: boundDocument,
      semanticTargets: [semanticProseTarget],
      inventory: items,
    });
    if (targetDecision.target) resolved.push(targetWithOperation(targetDecision.target, inventoryById, targetDecision.reason || "prose_deliverable"));
  }

  const uniqueTargets = [...new Map(resolved.map((target) => [target.documentId, target])).values()];
  const reportOnly = uniqueTargets.length > 0 && uniqueTargets.every((target) => (
    target.moduleId === "reports" || /^report-/u.test(target.documentId)
  ));
  const mutationRequested = uniqueTargets.some((target) => ["patch", "append", "replace", "rename"].includes(target.operation));
  const taskContract = compileTaskContract({
    taskType: reportOnly ? "diagnosis" : mutationRequested ? "modification" : uniqueTargets.length ? "writing" : "",
    objective: source,
    instruction: source,
    operation: uniqueTargets.length > 1 ? "batch" : uniqueTargets.length ? uniqueTargets[0].operation : "assist",
    target: { documents: uniqueTargets },
    requiredContextDocumentIds,
    exclusions: instructionSections.exclusions,
    acceptanceCriteria: instructionSections.acceptanceCriteria,
    persistence: uniqueTargets.length
      ? explicitlyDefersCandidateLanding(source, { outputKind: reportOnly ? "report" : "" }) ? "candidate_only" : "commit"
      : "none",
    targetResolution: uniqueTargets.length ? "exact" : "unresolved",
    semanticSource: "fallback",
  });
  return {
    schemaVersion: 1,
    instruction: source,
    requestedMutationKind: documentMutationKindForInstruction(source, ""),
    contextSources,
    primaryTargets: uniqueTargets,
    taskContract,
    exactTargetSet: uniqueTargets.length > 1,
    boundDocumentIsTarget: uniqueTargets.some((target) => target.documentId === boundDocument?.documentId),
    status: uniqueTargets.length ? "resolved" : "no_mutation_target",
  };
};

export const creativeMutationOutputContract = (plan = null) => {
  const targets = Array.isArray(plan?.primaryTargets) ? plan.primaryTargets.filter((target) => target?.documentId) : [];
  const formatInstruction = managedDocumentFormatInstruction(targets);
  const materialContract = materialUpdateOutputContract(plan?.materialUpdateExecutionPlan);
  if (materialContract) return [materialContract, formatInstruction].filter(Boolean).join("\n\n");
  const mutationInstruction = documentMutationOutputInstruction(plan?.instruction || "");
  if (targets.length < 2) return [formatInstruction, mutationInstruction].filter(Boolean).join("\n\n");
  const contract = plan?.taskContract?.deliverables?.length
    ? plan.taskContract
    : compileTaskContract({
        taskType: "writing",
        objective: plan.instruction,
        instruction: plan.instruction,
        operation: "batch",
        target: { documents: targets },
        exclusions: ["处理说明", "完成回执", "检查过程", "待办列表"],
      });
  const hasMemoryTargets = targets.some((target) => target.moduleId === "memory" || /^(?:memory-|script-memory-)/u.test(target.documentId));
  return [
    "# 本轮创作变更计划",
    "绑定文档只提供读取上下文，不是默认写入位置。",
    taskContractOutputContract(contract),
    "只返回一个 JSON 对象，不要使用 Markdown 代码围栏。格式：{\"artifacts\":[{\"deliverableId\":\"合同交付物 id\",\"targetDocumentId\":\"绑定文档 id\",\"contentType\":\"setting|outline|prose|memory\",\"title\":\"文档标题\",\"content\":\"完整正式内容\"}]}。",
    hasMemoryTargets
      ? "memory 交付物不是可直接覆盖的普通正文。伏笔目标在对应 artifact 中附加 memoryUpdate.foreshadowing，信息释放目标附加 memoryUpdate.informationRelease；每条记录提供 name、detail、state，以及 evidence 中逐项对应的 claim 与 content 内原文 quote。不得在一个记忆 artifact 中夹带其他记忆目标。宿主只接收结构化更新并由受信任投影器生成系统文档。"
      : "",
    "artifacts 必须与合同逐项对应；不得合并、遗漏、增加合同外文档，也不得在 content 中放入执行说明、自检报告或完成回执。",
    formatInstruction,
  ].join("\n");
};
