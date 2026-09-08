export const LONG_FORM_LIFECYCLE_SCHEMA_VERSION = 1;

const positiveInteger = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const uniqueSortedNumbers = (values = [], { start = 1, end = Number.MAX_SAFE_INTEGER } = {}) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => positiveInteger(value))
    .filter((value) => value >= start && value <= end),
)].sort((left, right) => left - right);

const chapterRange = (startChapter, endChapter) => Array.from(
  { length: Math.max(0, endChapter - startChapter + 1) },
  (_, index) => startChapter + index,
);

const chunkRange = (startChapter, endChapter, size) => {
  const chunks = [];
  for (let start = startChapter; start <= endChapter; start += size) {
    const end = Math.min(endChapter, start + size - 1);
    chunks.push({ startChapter: start, endChapter: end, chapterNumbers: chapterRange(start, end) });
  }
  return chunks;
};

const rangesOverlap = (left, right) => left.startChapter <= right.endChapter && right.startChapter <= left.endChapter;

const normalizedOutlineList = (value, startChapter, endChapter) => {
  const byNumber = new Map();
  for (const outline of Array.isArray(value) ? value : []) {
    const number = positiveInteger(outline?.number ?? outline?.chapterNumber);
    if (number < startChapter || number > endChapter) continue;
    byNumber.set(number, { ...(outline && typeof outline === "object" ? outline : {}), number });
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
};

const normalizedAuditList = (value, startChapter, endChapter) => (Array.isArray(value) ? value : [])
  .map((audit) => {
    const start = positiveInteger(audit?.startChapter);
    const end = positiveInteger(audit?.endChapter);
    if (!start || !end || end < start || start < startChapter || end > endChapter) return null;
    return { ...audit, startChapter: start, endChapter: end, pass: audit?.pass === true };
  })
  .filter(Boolean);

const normalizedFinalBlockRanges = (value, startChapter, endChapter) => {
  const ranges = (Array.isArray(value) ? value : [])
    .map((range) => ({ startChapter: positiveInteger(range?.startChapter), endChapter: positiveInteger(range?.endChapter) }))
    .filter((range) => range.startChapter && range.endChapter >= range.startChapter)
    .sort((left, right) => left.startChapter - right.startChapter);
  if (!ranges.length) return [];
  let cursor = startChapter;
  for (const range of ranges) {
    if (range.startChapter !== cursor || range.endChapter > endChapter || range.endChapter - range.startChapter + 1 > 8) return [];
    cursor = range.endChapter + 1;
  }
  return cursor === endChapter + 1 ? ranges : [];
};

const inferredRange = (job = {}) => {
  const candidates = [
    ...(Array.isArray(job.completedChapters) ? job.completedChapters : []),
    ...(Array.isArray(job.chapterOutlines) ? job.chapterOutlines.map((item) => item?.number ?? item?.chapterNumber) : []),
    ...(Array.isArray(job.foundation?.volumes)
      ? job.foundation.volumes.flatMap((volume) => [volume?.startChapter, volume?.endChapter])
      : []),
  ].map((value) => positiveInteger(value)).filter(Boolean);
  const explicitStart = positiveInteger(job.startChapter);
  const startChapter = explicitStart || (candidates.length ? Math.min(...candidates) : 1);
  const explicitEnd = positiveInteger(job.endChapter);
  const inferredEnd = Math.max(startChapter, ...candidates, positiveInteger(job.currentChapter) - 1);
  return { startChapter, endChapter: explicitEnd >= startChapter ? explicitEnd : inferredEnd };
};

const normalizedVolumes = (volumes, startChapter, endChapter) => (Array.isArray(volumes) ? volumes : [])
  .map((volume, index) => {
    const start = positiveInteger(volume?.startChapter);
    const end = positiveInteger(volume?.endChapter);
    if (!start || !end || end < start || end < startChapter || start > endChapter) return null;
    return {
      ...(volume && typeof volume === "object" ? volume : {}),
      number: positiveInteger(volume?.number, index + 1),
      title: String(volume?.title ?? `第${positiveInteger(volume?.number, index + 1)}卷`).trim(),
      startChapter: Math.max(startChapter, start),
      endChapter: Math.min(endChapter, end),
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.startChapter - right.startChapter || left.endChapter - right.endChapter);

const firstMissingChapter = (startChapter, endChapter, completed) => {
  const completedSet = completed instanceof Set ? completed : new Set(completed);
  for (let number = startChapter; number <= endChapter; number += 1) {
    if (!completedSet.has(number)) return number;
  }
  return endChapter + 1;
};

const lifecycleModeFor = (job = {}) => {
  const declaredMode = String(job.lifecycleMode ?? job.lifecycle?.mode ?? "");
  if (["legacy", "hierarchical"].includes(declaredMode)) return declaredMode;
  return positiveInteger(job.lifecycleSchemaVersion ?? job.lifecycle?.schemaVersion) >= LONG_FORM_LIFECYCLE_SCHEMA_VERSION
    || Array.isArray(job.volumeAudits)
    || Array.isArray(job.crossVolumeAudits)
    || Array.isArray(job.lifecycle?.auditResults)
    ? "hierarchical"
    : "legacy";
};

export const normalizeLongFormLifecycleJob = (job = {}) => {
  const source = job && typeof job === "object" ? job : {};
  const { startChapter, endChapter } = inferredRange(source);
  const completedChapters = uniqueSortedNumbers(source.completedChapters, { start: startChapter, end: endChapter });
  const completedSet = new Set(completedChapters);
  const expectedCurrentChapter = firstMissingChapter(startChapter, endChapter, completedSet);
  const reportedCurrentChapter = positiveInteger(source.currentChapter);
  const foundation = source.foundation && typeof source.foundation === "object"
    ? { ...source.foundation, volumes: normalizedVolumes(source.foundation.volumes, startChapter, endChapter) }
    : null;
  const chapterOutlines = normalizedOutlineList(source.chapterOutlines, startChapter, endChapter);
  const volumeNumbers = new Set((foundation?.volumes ?? []).map((volume) => volume.number));
  const outlinedVolumes = uniqueSortedNumbers(source.outlinedVolumes)
    .filter((number) => !volumeNumbers.size || volumeNumbers.has(number));
  const mode = lifecycleModeFor(source);
  const status = String(source.status || (
    completedChapters.length === endChapter - startChapter + 1 && source.finalAudit?.pass === true
      ? "done"
      : completedChapters.length ? "paused" : "planning"
  ));
  const phase = String(source.phase || (
    status === "done" ? "done"
      : !foundation ? "foundation"
        : chapterOutlines.length < endChapter - startChapter + 1 ? "chapter_outlines"
          : completedChapters.length < endChapter - startChapter + 1 ? "chapters" : "final_audit"
  ));
  const invalidatedAuditIds = [...new Set([
    ...(Array.isArray(source.invalidatedAuditIds) ? source.invalidatedAuditIds : []),
    ...(Array.isArray(source.lifecycle?.invalidatedAuditIds) ? source.lifecycle.invalidatedAuditIds : []),
  ].map((value) => String(value ?? "").trim()).filter(Boolean))];

  return {
    ...source,
    lifecycleSchemaVersion: positiveInteger(source.lifecycleSchemaVersion ?? source.lifecycle?.schemaVersion)
      || (mode === "hierarchical" ? LONG_FORM_LIFECYCLE_SCHEMA_VERSION : 0),
    lifecycleMode: mode,
    startChapter,
    endChapter,
    currentChapter: reportedCurrentChapter >= startChapter && reportedCurrentChapter <= endChapter + 1
      ? reportedCurrentChapter
      : expectedCurrentChapter,
    completedChapters,
    chapterOutlines,
    outlinedVolumes,
    structureAudits: normalizedAuditList(source.structureAudits, startChapter, endChapter),
    volumeAudits: normalizedAuditList(source.volumeAudits, startChapter, endChapter),
    crossVolumeAudits: normalizedAuditList(source.crossVolumeAudits, startChapter, endChapter),
    finalAuditSegments: normalizedAuditList(source.finalAuditSegments, startChapter, endChapter),
    finalAuditBlockRanges: normalizedFinalBlockRanges(source.finalAuditBlockRanges, startChapter, endChapter),
    finalAudit: source.finalAudit && typeof source.finalAudit === "object" ? { ...source.finalAudit } : null,
    foundation,
    foundationApplied: source.foundationApplied === true,
    status,
    phase,
    stopRequested: source.stopRequested === true,
    currentRequestId: source.currentRequestId ? String(source.currentRequestId) : null,
    memoryCompletedChapters: uniqueSortedNumbers(source.memoryCompletedChapters, { start: startChapter, end: endChapter }),
    memoryVerifiedChapters: uniqueSortedNumbers(source.memoryVerifiedChapters, { start: startChapter, end: endChapter }),
    staleMemoryChapters: uniqueSortedNumbers(source.staleMemoryChapters, { start: startChapter, end: endChapter }),
    invalidatedAuditIds,
    lifecycle: {
      ...(source.lifecycle && typeof source.lifecycle === "object" ? source.lifecycle : {}),
      schemaVersion: positiveInteger(source.lifecycleSchemaVersion ?? source.lifecycle?.schemaVersion)
        || (mode === "hierarchical" ? LONG_FORM_LIFECYCLE_SCHEMA_VERSION : 0),
      mode,
      invalidatedAuditIds,
    },
  };
};

const resolvedAuditVolumes = (job) => {
  const declared = job.foundation?.volumes ?? [];
  if (!declared.length) {
    return {
      volumes: [{
        number: 1,
        title: "未归卷长篇范围",
        startChapter: job.startChapter,
        endChapter: job.endChapter,
        synthetic: true,
      }],
      issues: ["任务缺少连续分卷信息，审计计划暂按一个兼容卷处理"],
    };
  }

  const volumes = [];
  const issues = [];
  let cursor = job.startChapter;
  let syntheticIndex = 1;
  for (const declaredVolume of declared) {
    if (declaredVolume.startChapter > cursor) {
      volumes.push({
        number: `gap-${syntheticIndex}`,
        title: "未归卷范围",
        startChapter: cursor,
        endChapter: declaredVolume.startChapter - 1,
        synthetic: true,
      });
      issues.push(`第${cursor}章至第${declaredVolume.startChapter - 1}章没有归属卷`);
      syntheticIndex += 1;
    }
    if (declaredVolume.startChapter < cursor) {
      issues.push(`${declaredVolume.title || `第${declaredVolume.number}卷`}与前一卷范围重叠`);
    }
    const startChapter = Math.max(cursor, declaredVolume.startChapter);
    if (startChapter <= declaredVolume.endChapter) {
      volumes.push({ ...declaredVolume, startChapter });
      cursor = declaredVolume.endChapter + 1;
    }
    if (cursor > job.endChapter) break;
  }
  if (cursor <= job.endChapter) {
    volumes.push({
      number: `gap-${syntheticIndex}`,
      title: "未归卷范围",
      startChapter: cursor,
      endChapter: job.endChapter,
      synthetic: true,
    });
    issues.push(`第${cursor}章至第${job.endChapter}章没有归属卷`);
  }
  return { volumes, issues };
};

const taskIdPart = (value) => String(value).replace(/[^A-Za-z0-9_-]+/g, "-");

export const buildLongFormAuditPlan = (jobInput = {}, {
  stageSize = 5,
  finalBlockSize = 8,
  crossVolumeSideChapters = 2,
} = {}) => {
  const job = normalizeLongFormLifecycleJob(jobInput);
  const safeStageSize = Math.max(1, Math.min(5, positiveInteger(stageSize, 5)));
  const safeFinalBlockSize = Math.max(1, Math.min(8, positiveInteger(finalBlockSize, 8)));
  const safeBoundarySide = Math.max(1, Math.min(4, positiveInteger(crossVolumeSideChapters, 2)));
  const completed = new Set(job.completedChapters);
  const { volumes, issues } = resolvedAuditVolumes(job);
  const stageAudits = chunkRange(job.startChapter, job.endChapter, safeStageSize).map((range) => ({
    id: `stage:${range.startChapter}-${range.endChapter}`,
    level: "stage",
    label: `${range.endChapter - range.startChapter + 1}章阶段审计`,
    ...range,
    inputMode: "current_prose",
    maxProseChapters: 5,
    ready: range.chapterNumbers.every((number) => completed.has(number)),
    dependsOn: range.chapterNumbers.map((number) => `chapter:${number}`),
  }));

  const volumeAudits = volumes.map((volume) => {
    const dependencies = stageAudits.filter((task) => rangesOverlap(task, volume)).map((task) => task.id);
    return {
      id: `volume:${taskIdPart(volume.number)}:${volume.startChapter}-${volume.endChapter}`,
      level: "volume",
      label: `${volume.title || `第${volume.number}卷`}整卷审计`,
      volumeNumber: volume.number,
      startChapter: volume.startChapter,
      endChapter: volume.endChapter,
      chapterNumbers: chapterRange(volume.startChapter, volume.endChapter),
      inputMode: "stage_audits_and_volume_outline",
      maxProseChapters: 0,
      synthetic: volume.synthetic === true,
      ready: dependencies.every((id) => stageAudits.find((task) => task.id === id)?.ready),
      dependsOn: dependencies,
    };
  });

  const crossVolumeAudits = volumes.slice(0, -1).map((left, index) => {
    const right = volumes[index + 1];
    const leftNumbers = chapterRange(
      Math.max(left.startChapter, left.endChapter - safeBoundarySide + 1),
      left.endChapter,
    );
    const rightNumbers = chapterRange(
      right.startChapter,
      Math.min(right.endChapter, right.startChapter + safeBoundarySide - 1),
    );
    const chapterNumbers = [...leftNumbers, ...rightNumbers].slice(0, 8);
    const leftTask = volumeAudits[index];
    const rightTask = volumeAudits[index + 1];
    return {
      id: `cross-volume:${taskIdPart(left.number)}-${taskIdPart(right.number)}:${chapterNumbers[0]}-${chapterNumbers.at(-1)}`,
      level: "cross-volume",
      label: `${left.title || `第${left.number}卷`}→${right.title || `第${right.number}卷`}跨卷审计`,
      volumeNumbers: [left.number, right.number],
      startChapter: chapterNumbers[0],
      endChapter: chapterNumbers.at(-1),
      chapterNumbers,
      inputMode: "volume_audits_and_boundary_prose",
      maxProseChapters: 8,
      ready: chapterNumbers.every((number) => completed.has(number)) && leftTask.ready && rightTask.ready,
      dependsOn: [leftTask.id, rightTask.id],
    };
  });

  const finalBlockRanges = job.finalAuditBlockRanges.length
    ? job.finalAuditBlockRanges.map((range) => ({ ...range, chapterNumbers: chapterRange(range.startChapter, range.endChapter) }))
    : chunkRange(job.startChapter, job.endChapter, safeFinalBlockSize);
  const finalBlocks = finalBlockRanges.map((range) => ({
    id: `final-block:${range.startChapter}-${range.endChapter}`,
    level: "final-block",
    label: `第${range.startChapter}章至第${range.endChapter}章最终正文审计`,
    ...range,
    inputMode: "current_prose",
    maxProseChapters: 8,
    ready: range.chapterNumbers.every((number) => completed.has(number)),
    dependsOn: range.chapterNumbers.map((number) => `chapter:${number}`),
  }));

  const bookAggregate = {
    id: `book:${job.startChapter}-${job.endChapter}`,
    level: "book",
    label: "全书聚合验收",
    startChapter: job.startChapter,
    endChapter: job.endChapter,
    chapterNumbers: [],
    inputMode: "audit_results_only",
    maxProseChapters: 0,
    ready: [...volumeAudits, ...crossVolumeAudits, ...finalBlocks].every((task) => task.ready),
    dependsOn: [...volumeAudits, ...crossVolumeAudits, ...finalBlocks].map((task) => task.id),
  };

  return {
    schemaVersion: LONG_FORM_LIFECYCLE_SCHEMA_VERSION,
    startChapter: job.startChapter,
    endChapter: job.endChapter,
    stageSize: safeStageSize,
    finalBlockSize: safeFinalBlockSize,
    validVolumeCoverage: issues.length === 0,
    coverageIssues: issues,
    stageAudits,
    volumeAudits,
    crossVolumeAudits,
    finalBlocks,
    bookAggregate,
    tasks: [...stageAudits, ...volumeAudits, ...crossVolumeAudits, ...finalBlocks, bookAggregate],
  };
};

const volumeForChapter = (volumes, chapterNumber) => volumes.find((volume) => (
  chapterNumber >= volume.startChapter && chapterNumber <= volume.endChapter
));

export const calculateLongFormRevisionImpact = ({
  job: jobInput = {},
  revisedChapterNumbers = [],
  revisionType = "prose",
  volumeNumbers = [],
  auditPlan = null,
} = {}) => {
  const job = normalizeLongFormLifecycleJob(jobInput);
  const plan = auditPlan ?? buildLongFormAuditPlan(job);
  const completed = new Set(job.completedChapters);
  const requestedChapters = uniqueSortedNumbers(revisedChapterNumbers, { start: job.startChapter, end: job.endChapter });
  const requestedVolumes = new Set((Array.isArray(volumeNumbers) ? volumeNumbers : []).map(String));
  const globalChange = ["foundation", "canon", "series_outline"].includes(revisionType);
  const volumeChange = revisionType === "volume_outline";
  const volumeStarts = plan.volumeAudits
    .filter((volume) => requestedVolumes.has(String(volume.volumeNumber)))
    .map((volume) => volume.startChapter);
  const earliestImpactedChapter = globalChange
    ? job.startChapter
    : volumeChange && volumeStarts.length
      ? Math.min(...volumeStarts)
      : requestedChapters.length ? requestedChapters[0] : null;

  if (!earliestImpactedChapter) {
    return {
      revisionType,
      hasImpact: false,
      directChapterNumbers: [],
      downstreamChapterNumbers: [],
      chaptersRequiringRevalidation: [],
      chaptersRequiringRegeneration: [],
      staleMemoryChapterNumbers: [],
      invalidatedAuditIds: [],
      nextSafeResumeChapter: firstMissingChapter(job.startChapter, job.endChapter, completed),
      reasons: [],
    };
  }

  const directChapterNumbers = globalChange
    ? job.completedChapters
    : volumeChange
      ? job.completedChapters.filter((number) => {
        const volume = volumeForChapter(plan.volumeAudits, number);
        return volume && requestedVolumes.has(String(volume.volumeNumber));
      })
      : requestedChapters;
  const directSet = new Set(directChapterNumbers);
  const affectedCompleted = job.completedChapters.filter((number) => number >= earliestImpactedChapter);
  const downstreamChapterNumbers = affectedCompleted.filter((number) => !directSet.has(number));
  const invalidatedAuditIds = plan.tasks
    .filter((task) => task.level === "book" || task.endChapter >= earliestImpactedChapter)
    .map((task) => task.id);
  const requiresRegeneration = ["foundation", "canon", "series_outline", "volume_outline", "chapter_outline"].includes(revisionType);

  return {
    revisionType,
    hasImpact: true,
    earliestImpactedChapter,
    directChapterNumbers,
    downstreamChapterNumbers,
    chaptersRequiringRevalidation: affectedCompleted,
    chaptersRequiringRegeneration: requiresRegeneration ? affectedCompleted : [],
    staleMemoryChapterNumbers: globalChange ? affectedCompleted : directChapterNumbers.filter((number) => completed.has(number)),
    invalidatedAuditIds,
    nextSafeResumeChapter: earliestImpactedChapter,
    finalAuditInvalidated: true,
    reasons: [
      `第${earliestImpactedChapter}章起的已完成正文曾依赖修订前信息，必须重新校验`,
      "命中范围及其下游的阶段、整卷、跨卷和全书审计结果失效",
      requiresRegeneration
        ? "规划或正史发生变化，下游正文需要重新生成或经人工确认后逐章重验"
        : "正文修订首先使本章连续性增量过期，下游正文至少需要连续性复检",
    ],
  };
};

const matchingAudit = (audits, task) => audits.find((audit) => (
  audit.startChapter === task.startChapter && audit.endChapter === task.endChapter
));

const auditTaskState = (job, task) => {
  if (job.invalidatedAuditIds.includes(task.id)) return "stale";
  const record = task.level === "stage" ? matchingAudit(job.structureAudits, task)
    : task.level === "volume" ? matchingAudit(job.volumeAudits, task)
      : task.level === "cross-volume" ? matchingAudit(job.crossVolumeAudits, task)
        : task.level === "final-block" ? matchingAudit(job.finalAuditSegments, task)
          : job.finalAudit;
  if (record?.pass === true) return "passed";
  if (record) return "failed";
  return task.ready ? "ready" : "waiting";
};

export const calculateLongFormCompletion = (jobInput = {}, { auditPlan = null } = {}) => {
  const job = normalizeLongFormLifecycleJob(jobInput);
  const plan = auditPlan ?? buildLongFormAuditPlan(job);
  const allChapterNumbers = chapterRange(job.startChapter, job.endChapter);
  const completed = new Set(job.completedChapters);
  const outlined = new Set(job.chapterOutlines.map((outline) => outline.number));
  const memoryCompleted = new Set(job.memoryCompletedChapters);
  const memoryVerified = new Set(job.memoryVerifiedChapters);
  const staleMemory = new Set(job.staleMemoryChapters);
  const nextChapter = firstMissingChapter(job.startChapter, job.endChapter, completed);
  const volumes = plan.volumeAudits;
  const chapters = allChapterNumbers.map((number) => {
    const volume = volumeForChapter(volumes, number);
    const chapterCompleted = completed.has(number);
    const memoryStatus = staleMemory.has(number) ? "stale"
      : memoryVerified.has(number) ? "verified"
        : memoryCompleted.has(number) ? "recorded" : "missing";
    return {
      number,
      volumeNumber: volume?.volumeNumber ?? null,
      outlined: outlined.has(number),
      completed: chapterCompleted,
      memoryStatus,
      status: chapterCompleted
        ? outlined.has(number) ? "completed" : "completed_without_outline"
        : number === nextChapter ? "next" : "pending",
    };
  });
  const auditTasks = plan.tasks.map((task) => ({ ...task, state: auditTaskState(job, task) }));
  const passedAudits = auditTasks.filter((task) => task.state === "passed").length;
  const proseComplete = job.completedChapters.length === allChapterNumbers.length;
  const outlinesComplete = job.chapterOutlines.length === allChapterNumbers.length;
  const hierarchicalAuditsComplete = auditTasks.every((task) => task.state === "passed");
  const legacyAuditComplete = job.finalAudit?.pass === true && !job.invalidatedAuditIds.includes(plan.bookAggregate.id);
  const auditsComplete = job.lifecycleMode === "legacy" ? legacyAuditComplete : hierarchicalAuditsComplete;
  const complete = proseComplete && auditsComplete;
  const contiguousCompletedThrough = nextChapter === job.startChapter
    ? job.startChapter - 1
    : nextChapter - 1;
  const status = complete ? "complete"
    : !job.foundation && !job.chapterOutlines.length && !job.completedChapters.length ? "not_started"
      : !outlinesComplete ? "planning"
        : !proseComplete ? "writing" : "auditing";

  return {
    schemaVersion: LONG_FORM_LIFECYCLE_SCHEMA_VERSION,
    lifecycleMode: job.lifecycleMode,
    startChapter: job.startChapter,
    endChapter: job.endChapter,
    totalChapters: allChapterNumbers.length,
    completedCount: job.completedChapters.length,
    completedChapterNumbers: job.completedChapters,
    missingChapterNumbers: allChapterNumbers.filter((number) => !completed.has(number)),
    nextChapter: nextChapter <= job.endChapter ? nextChapter : null,
    contiguousCompletedThrough,
    hasCompletionGap: job.completedChapters.some((number) => number > nextChapter),
    outlinesComplete,
    missingOutlineChapterNumbers: allChapterNumbers.filter((number) => !outlined.has(number)),
    proseComplete,
    readyForWriting: Boolean(job.foundation) && outlinesComplete,
    readyForFinalAudit: proseComplete,
    auditsComplete,
    complete,
    status,
    chapters,
    audits: {
      passed: passedAudits,
      total: auditTasks.length,
      pending: auditTasks.filter((task) => !["passed", "failed", "stale"].includes(task.state)).length,
      failed: auditTasks.filter((task) => task.state === "failed").length,
      stale: auditTasks.filter((task) => task.state === "stale").length,
      tasks: auditTasks,
    },
    progress: {
      chapters: allChapterNumbers.length ? job.completedChapters.length / allChapterNumbers.length : 0,
      audits: auditTasks.length ? passedAudits / auditTasks.length : 0,
    },
  };
};

const documentMap = (documents) => {
  if (!documents) return null;
  if (!Array.isArray(documents)) return documents && typeof documents === "object" ? documents : null;
  return Object.fromEntries(documents.map((document) => [document?.id ?? document?.documentId, document]).filter(([id]) => id));
};

const rawNumberList = (value) => (Array.isArray(value) ? value : []).map((item) => Number(item));

export const validateLongFormRecoveryConsistency = ({ job: jobInput = {}, documents = null } = {}) => {
  const rawJob = jobInput && typeof jobInput === "object" ? jobInput : {};
  const job = normalizeLongFormLifecycleJob(rawJob);
  const completion = calculateLongFormCompletion(job);
  const errors = [];
  const warnings = [];
  const repairs = [];
  const rawCompleted = rawNumberList(rawJob.completedChapters);
  const validRawCompleted = rawCompleted.filter(Number.isInteger);
  if (new Set(validRawCompleted).size !== validRawCompleted.length) warnings.push("完成章节列表存在重复章号，规范化时会去重");
  const outOfRange = validRawCompleted.filter((number) => number < job.startChapter || number > job.endChapter);
  if (outOfRange.length) errors.push(`完成章节列表包含范围外章号：${[...new Set(outOfRange)].join("、")}`);
  if (completion.hasCompletionGap) errors.push(`完成章节不连续；第${completion.nextChapter}章缺失，但后续章节已标记完成`);

  const expectedCurrentChapter = completion.nextChapter ?? job.endChapter + 1;
  const reportedCurrentChapter = positiveInteger(rawJob.currentChapter);
  if (reportedCurrentChapter && reportedCurrentChapter !== expectedCurrentChapter) {
    errors.push(`当前检查点为第${reportedCurrentChapter}章，但按已完成章节应为第${expectedCurrentChapter}章`);
    repairs.push({ field: "currentChapter", value: expectedCurrentChapter });
  }
  if (job.foundationApplied && !job.foundation) errors.push("任务标记为已应用创作依据，但基础规划不存在");
  if (["writing", "final_audit", "done"].includes(job.status) && !job.foundation) errors.push(`${job.status} 状态缺少基础规划`);
  if ((job.phase === "chapters" || job.status === "writing") && !completion.outlinesComplete) errors.push("任务已进入逐章写作，但章纲没有覆盖完整请求范围");
  if ((job.phase === "final_audit" || job.status === "final_audit") && !completion.proseComplete) errors.push("任务已进入最终审计，但正文尚未逐章完成");
  if (job.status === "done" && !completion.complete) errors.push("任务标记为完成，但正文或必需审计尚未完成");
  if (job.status === "paused" && job.currentRequestId) {
    errors.push("暂停任务仍保留运行中的请求标识");
    repairs.push({ field: "currentRequestId", value: null });
  }
  if (job.status === "paused" && job.stopRequested) {
    warnings.push("暂停任务仍带有 stopRequested；恢复前应清除此瞬时标记");
    repairs.push({ field: "stopRequested", value: false });
  }

  const knownVolumes = new Set((job.foundation?.volumes ?? []).map((volume) => volume.number));
  const unknownOutlinedVolumes = job.outlinedVolumes.filter((number) => knownVolumes.size && !knownVolumes.has(number));
  if (unknownOutlinedVolumes.length) errors.push(`已规划卷列表包含不存在的卷：${unknownOutlinedVolumes.join("、")}`);
  for (const volumeNumber of job.outlinedVolumes) {
    const volume = job.foundation?.volumes?.find((item) => item.number === volumeNumber);
    if (!volume) continue;
    const outlined = new Set(job.chapterOutlines.map((outline) => outline.number));
    const missing = chapterRange(volume.startChapter, volume.endChapter).filter((number) => !outlined.has(number));
    if (missing.length) errors.push(`第${volumeNumber}卷已标记完成章纲，但缺少第${missing.join("、")}章章纲`);
  }

  for (const audit of [...job.structureAudits, ...job.volumeAudits, ...job.crossVolumeAudits, ...job.finalAuditSegments]) {
    if (!audit.pass) continue;
    const missing = chapterRange(audit.startChapter, audit.endChapter).filter((number) => !job.completedChapters.includes(number));
    if (missing.length) errors.push(`第${audit.startChapter}-${audit.endChapter}章审计标记通过，但正文缺少第${missing.join("、")}章`);
  }

  if (job.finalAudit?.pass === true && job.lifecycleMode === "hierarchical") {
    const plan = buildLongFormAuditPlan(job);
    const oversizedSegments = job.finalAuditSegments.filter((segment) => segment.endChapter - segment.startChapter + 1 > 8);
    if (oversizedSegments.length) {
      errors.push(`最终正文审计块超过 8 章上限：${oversizedSegments.map((segment) => `${segment.startChapter}-${segment.endChapter}`).join("、")}`);
    }
    const missingPlannedBlocks = plan.finalBlocks.filter((block) => !job.finalAuditSegments.some((segment) => (
      segment.pass && segment.startChapter === block.startChapter && segment.endChapter === block.endChapter
    )));
    if (missingPlannedBlocks.length) {
      errors.push(`全书验收缺少标准连续正文块：${missingPlannedBlocks.map((block) => `${block.startChapter}-${block.endChapter}`).join("、")}`);
    }
    const covered = new Set(job.finalAuditSegments.filter((segment) => segment.pass).flatMap((segment) => (
      chapterRange(segment.startChapter, segment.endChapter)
    )));
    const missing = chapterRange(job.startChapter, job.endChapter).filter((number) => !covered.has(number));
    if (missing.length) errors.push(`全书验收标记通过，但最终正文分块未覆盖第${missing.join("、")}章`);
  } else if (job.finalAudit?.pass === true && !job.finalAuditSegments.length) {
    warnings.push("旧任务只有聚合终检结果，没有可追溯的最多 8 章正文分块记录");
  }

  const documentsById = documentMap(documents);
  if (documentsById) {
    for (const number of job.completedChapters) {
      const document = documentsById[`chapter-${number}`];
      if (!document) {
        errors.push(`第${number}章已标记完成，但恢复存储中没有对应正文文档`);
        continue;
      }
      if (document.longFormJobId && job.id && document.longFormJobId !== job.id) {
        errors.push(`第${number}章正文属于其他长篇任务`);
      } else if (!document.longFormJobId) {
        warnings.push(`第${number}章正文缺少 longFormJobId；按旧数据兼容读取，但无法强校验来源`);
      }
      if (document.longFormChapterNumber && Number(document.longFormChapterNumber) !== number) {
        errors.push(`第${number}章正文的检查点章号为 ${document.longFormChapterNumber}`);
      }
    }
    for (const [documentId, document] of Object.entries(documentsById)) {
      const number = positiveInteger(document?.longFormChapterNumber ?? documentId.match(/^chapter-(\d+)$/)?.[1]);
      if (!number || document?.longFormJobId !== job.id) continue;
      if (!job.completedChapters.includes(number)) errors.push(`第${number}章正文已带本任务检查点，但完成章节列表没有该章`);
    }
  }

  if (job.lifecycleMode === "legacy") warnings.push("旧任务缺少分层生命周期字段；已按兼容模式规范化，不会伪造整卷或跨卷审计已通过");
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    repairs,
    expectedCurrentChapter,
    normalizedJob: job,
    completion,
  };
};
