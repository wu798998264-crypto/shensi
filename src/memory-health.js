import { memoryPlaceholderReason, memoryReviewMatchesCurrentSource } from "./memory-source.js";

const unitItems = (moduleItems = {}) => (moduleItems.manuscript ?? []).filter(([id]) => /^(?:chapter-\d+|script-episode-\d+)$/.test(id));

const hasUsefulDelta = (delta) => Boolean(delta && (
  String(delta.summary ?? "").trim()
  || (Array.isArray(delta.nextCarryover) && delta.nextCarryover.length)
));

const substantiveUnitText = (documentState = {}) => String(documentState.markdown ?? documentState.html ?? "")
  .replace(/^---[\s\S]*?---\s*/u, "")
  .replace(/^#{1,6}\s+.*$/gm, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/[\s\p{P}\p{S}]/gu, "")
  .trim();

const naturalNumber = (id = "") => Number(String(id).match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);

export const memoryHealth = ({ moduleItems = {}, documents = {} } = {}) => {
  const units = unitItems(moduleItems).sort(([left], [right]) => naturalNumber(left) - naturalNumber(right));
  const rows = units.map(([id, label]) => {
    const documentState = documents[id] ?? {};
    const delta = documentState.continuityDelta;
    const placeholderReason = memoryPlaceholderReason(documentState);
    const excluded = documentState.memoryBackfillPolicy?.excluded === true;
    const ignored = !excluded && memoryReviewMatchesCurrentSource(documentState);
    const written = !placeholderReason && substantiveUnitText(documentState).length >= 8;
    const covered = hasUsefulDelta(delta);
    const evidenceVerified = delta?.evidenceVerified === true;
    const evidenceCount = Array.isArray(delta?.evidence) ? delta.evidence.length : 0;
    const carryoverCount = Array.isArray(delta?.nextCarryover) ? delta.nextCarryover.filter(Boolean).length : 0;
    const stale = documentState.memorySyncStatus === "stale";
    const conflictIssueIds = Array.isArray(documentState.memoryConflictIssues)
      ? documentState.memoryConflictIssues.filter(Boolean) : [];
    const conflicted = conflictIssueIds.length > 0;
    const status = excluded
      ? "excluded"
      : !written
        ? "unwritten"
        : ignored
          ? "ignored"
          : !covered
            ? "missing"
            : conflicted
              ? "conflict"
              : stale
              ? "stale"
              : !evidenceVerified
                ? "unverified"
                : carryoverCount
                  ? "verified"
                  : "thin";
    return {
      id,
      title: documentState.title ?? label ?? id,
      status,
      written,
      excluded,
      ignored,
      placeholderReason,
      covered,
      stale,
      conflicted,
      conflictIssueIds,
      evidenceVerified,
      evidenceCount,
      carryoverCount,
      updatedAt: delta?.updatedAt ?? "",
    };
  });
  const writtenRows = rows.filter((row) => row.written && !row.excluded);
  const actionableRows = writtenRows.filter((row) => !row.ignored);
  const covered = writtenRows.filter((row) => row.covered).length;
  const verified = writtenRows.filter((row) => row.status === "verified").length;
  const stale = writtenRows.filter((row) => row.stale).length;
  const conflicts = writtenRows.filter((row) => row.conflicted).length;
  const missing = writtenRows.filter((row) => row.status === "missing").length;
  const thin = writtenRows.filter((row) => row.status === "thin").length;
  const total = writtenRows.length;
  const plannedTotal = rows.length;
  const unwritten = rows.filter((row) => !row.written && !row.excluded).length;
  const ignored = rows.filter((row) => row.ignored).length;
  const excluded = rows.filter((row) => row.excluded).length;
  return {
    schemaVersion: 1,
    plannedTotal,
    unwritten,
    ignored,
    excluded,
    total,
    covered,
    verified,
    stale,
    conflicts,
    missing,
    thin,
    coverage: total ? covered / total : 1,
    verifiedCoverage: total ? verified / total : 1,
    ready: actionableRows.length === 0 || actionableRows.every((row) => row.status === "verified"),
    rows,
    backfillQueue: actionableRows.filter((row) => row.status !== "verified").map((row) => ({
      documentId: row.id,
      reason: row.status,
      priority: row.status === "conflict" ? 0 : row.stale ? 1 : row.status === "missing" ? 2 : row.status === "thin" ? 3 : 4,
    })),
  };
};

export const memoryHealthMarkdown = (input = {}) => {
  const health = memoryHealth(input);
  const percent = (value) => `${Math.round(value * 1000) / 10}%`;
  return [
    "# 长文记忆健康度",
    "",
    `章节增量覆盖：${health.covered}/${health.total}（${percent(health.coverage)}）；章节证据校验：${health.verified}/${health.total}（${percent(health.verifiedCoverage)}）；未写计划单元：${health.unwritten}/${health.plannedTotal}；记忆冲突：${health.conflicts}；过期：${health.stale}；缺失：${health.missing}。`,
    "以上比例只统计章节连续性增量与证据状态，不代表人物、规则、读者知识或伏笔的语义完整性已经验收。",
    "",
    "| 单元 | 状态 | 证据数 | 更新时间 |",
    "|---|---:|---:|---|",
    ...health.rows.map((row) => `| ${row.title.replaceAll("|", "\\|")} | ${row.status} | ${row.evidenceCount} | ${row.updatedAt || "—"} |`),
    "",
  ].join("\n");
};
