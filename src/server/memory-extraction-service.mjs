import {
  buildMemorySourceIndex,
  compileMemoryExtraction,
  deferredMemoryCandidates,
  memoryExtractionPrompt,
  memoryExtractionRepairPrompt,
  mergeCompiledMemoryUpdates,
  parseMemoryExtractionOutput,
} from "../memory-numbered-evidence.js";

const resultText = (value) => String(value?.text ?? value ?? "").trim();

const protocolFailure = (reason, repairKey = "protocol") => ({
  item: { repairKey, type: "unknown", name: "", content: "", sourceRefs: [] },
  reason,
  stage: "protocol",
});

export const extractMemoryWithNumberedEvidence = async ({
  documentId = "",
  content = "",
  sourceRevision = "",
  pendingCandidates = [],
  runModel,
  maxRepairRounds = 2,
  now = () => new Date().toISOString(),
} = {}) => {
  const sourceIndex = buildMemorySourceIndex(content);
  const audit = [];
  const acceptedUpdates = [];
  let failures = [];
  let protocolRetries = 0;
  let initial = null;
  try {
    initial = parseMemoryExtractionOutput(resultText(await runModel({
      phase: "extract",
      prompt: memoryExtractionPrompt({ sourceIndex, pendingCandidates }),
    })));
  } catch (error) {
    failures = [protocolFailure(`记忆提取调用失败：${error?.message || "未知错误"}`)];
  }
  if (!initial && !failures.length) {
    protocolRetries += 1;
    try {
      initial = parseMemoryExtractionOutput(resultText(await runModel({
        phase: "protocol_repair",
        prompt: `${memoryExtractionPrompt({ sourceIndex, pendingCandidates })}\n\n上一轮不是合法 JSON。只修复格式，仍只返回 {\"items\":[]} 结构。`,
      })));
    } catch (error) {
      failures = [protocolFailure(`记忆提取协议修复失败：${error?.message || "未知错误"}`)];
    }
  }
  if (!initial && !failures.length) failures = [protocolFailure("记忆提取连续未返回合法 items 协议")];
  if (initial) {
    const compiled = compileMemoryExtraction({ items: initial.items, sourceIndex, documentId, sourceRevision });
    if (compiled.memoryUpdate) acceptedUpdates.push(compiled.memoryUpdate);
    failures = compiled.failures;
    audit.push(...compiled.failures.map((failure) => ({
      repairKey: failure.item?.repairKey || "",
      stage: failure.stage,
      reason: failure.reason,
      outcome: "repair_pending",
      recordedAt: now(),
    })));
  }

  let repairRound = 0;
  while (failures.length && failures.some((failure) => failure.stage !== "protocol") && repairRound < maxRepairRounds) {
    repairRound += 1;
    const expectedKeys = new Set(failures.map((failure) => failure.item?.repairKey).filter(Boolean));
    let repaired = null;
    try {
      repaired = parseMemoryExtractionOutput(resultText(await runModel({
        phase: "item_repair",
        repairRound,
        failures,
        prompt: memoryExtractionRepairPrompt({ sourceIndex, failures, round: repairRound }),
      })));
    } catch (error) {
      audit.push({ stage: "item_repair", reason: error?.message || "局部修复调用失败", outcome: "repair_failed", repairRound, recordedAt: now() });
    }
    if (!repaired) {
      failures = failures.map((failure) => ({ ...failure, reason: `${failure.reason}；第 ${repairRound} 次局部修复未返回合法协议`, stage: "item_repair" }));
      continue;
    }
    const repairedItems = repaired.items.filter((item) => expectedKeys.has(item.repairKey));
    const returnedKeys = new Set(repairedItems.map((item) => item.repairKey).filter(Boolean));
    const compiled = compileMemoryExtraction({ items: repairedItems, sourceIndex, documentId, sourceRevision });
    if (compiled.memoryUpdate) acceptedUpdates.push(compiled.memoryUpdate);
    const omitted = [...expectedKeys].filter((key) => !returnedKeys.has(key)).map((key) => {
      const previous = failures.find((failure) => failure.item?.repairKey === key);
      return { ...previous, reason: `${previous?.reason || "校验失败"}；模型未返回该失败项`, stage: "item_repair" };
    });
    failures = [...compiled.failures, ...omitted];
    audit.push(...repairedItems.map((item) => ({
      repairKey: item.repairKey,
      stage: "item_repair",
      reason: failures.some((failure) => failure.item?.repairKey === item.repairKey) ? "局部修复后仍未通过" : "局部修复通过",
      outcome: failures.some((failure) => failure.item?.repairKey === item.repairKey) ? "repair_failed" : "repaired",
      repairRound,
      recordedAt: now(),
    })));
  }

  const accepted = mergeCompiledMemoryUpdates(acceptedUpdates);
  const acceptedItemCount = acceptedUpdates.reduce((total, update) => total
    + (update.chapterSummary ? 1 : 0)
    + ["stateChanges", "foreshadowing", "firstAppearances", "informationRelease", "readerKnowledge", "nextContext", "pendingCanon"]
      .reduce((count, field) => count + (update[field]?.length || 0), 0), 0);
  const deferred = deferredMemoryCandidates({
    failures,
    sourceIndex,
    documentId,
    sourceRevision,
    repairAttempts: repairRound + protocolRetries,
    createdAt: now(),
  });
  const hasAccepted = acceptedItemCount > 0;
  const memoryUpdate = {
    ...accepted,
    evidenceVerified: true,
    analysisComplete: true,
    deferredCandidates: deferred,
    degradationEvents: [
      ...audit,
      ...deferred.map((item) => ({
        pendingCandidateId: item.id,
        repairKey: item.repairKey,
        stage: item.failureStage,
        reason: item.reason,
        outcome: "deferred_to_unit_memory",
        recordedAt: now(),
      })),
    ],
    evidenceReview: {
      mode: deferred.length ? hasAccepted ? "numbered_partial_deferred" : "numbered_deferred" : "numbered_verified",
      sourceHash: sourceIndex.sourceHash,
      acceptedItemCount,
      deferredItemCount: deferred.length,
      repairRounds: repairRound,
      protocolRetries,
    },
  };
  return {
    memoryUpdate,
    mode: deferred.length ? hasAccepted ? "partial_deferred" : "deferred" : hasAccepted ? "verified" : "empty",
    acceptedItemCount,
    deferredItemCount: deferred.length,
    failures,
    audit,
    sourceHash: sourceIndex.sourceHash,
  };
};
