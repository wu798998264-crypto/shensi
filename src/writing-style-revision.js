const clean = (value = "") => String(value ?? "").trim();

const uniqueSegments = (hits = []) => [...new Set((Array.isArray(hits) ? hits : [])
  .flatMap((hit) => hit?.occurrences ?? [])
  .filter((occurrence) => occurrence?.editable !== false)
  .map((occurrence) => clean(occurrence?.segment))
  .filter(Boolean))];

export const buildWritingStyleRevisionRequest = ({ draft = "", hits = [], maxSegments = 16 } = {}) => {
  const segments = uniqueSegments(hits).slice(0, Math.max(1, maxSegments));
  const constraints = (Array.isArray(hits) ? hits : []).map((hit) => ({
    type: hit?.rule?.type || "word",
    value: hit?.rule?.value || "",
    count: hit?.count || 0,
    allowed: Number.isFinite(hit?.allowed) ? hit.allowed : null,
    excess: hit?.excess || 0,
  }));
  return {
    segments,
    constraints,
    prompt: [
      "# 局部语言修订协议",
      "只修订以下命中句段，不得返回全文，不得改变剧情事实、人物动作、语气、信息量、专有名词、对白口癖或引用原文。",
      "严格返回 JSON：{\"replacements\":[{\"before\":\"命中句段原文\",\"after\":\"修订后句段\"}]}。before 必须逐字等于下列某个句段。",
      `命中规则：${JSON.stringify(constraints)}`,
      ...segments.map((segment, index) => `${index + 1}. ${segment}`),
    ].join("\n"),
    draftHashInputLength: String(draft ?? "").length,
  };
};

export const parseWritingStyleRevisionResponse = (value = null) => {
  if (value && typeof value === "object" && Array.isArray(value.replacements)) return value;
  const source = clean(value);
  if (!source) return { replacements: [] };
  const unfenced = source.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed = JSON.parse(unfenced);
    return { replacements: Array.isArray(parsed?.replacements) ? parsed.replacements : [] };
  } catch {
    return { replacements: [] };
  }
};

export const applyWritingStyleReplacements = (draft = "", replacements = []) => {
  let text = String(draft ?? "");
  let applied = 0;
  const rejected = [];
  for (const replacement of (Array.isArray(replacements) ? replacements : []).slice(0, 32)) {
    const before = clean(replacement?.before);
    const after = clean(replacement?.after);
    if (!before || !after || before === after) {
      rejected.push({ before, reason: "empty_or_unchanged" });
      continue;
    }
    const first = text.indexOf(before);
    if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
      rejected.push({ before, reason: first < 0 ? "source_not_found" : "source_not_unique" });
      continue;
    }
    text = `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
    applied += 1;
  }
  return { text, applied, rejected };
};

export const runWritingStyleQualityControl = async ({ draft = "", scan, revise = null } = {}) => {
  const original = String(draft ?? "");
  const base = {
    text: original,
    blocking: false,
    mayReturn: true,
    mayLand: true,
    scanAttempts: 0,
    revisionAttempts: 0,
    initialHits: [],
    remainingHits: [],
    notice: "",
    status: "clean",
  };
  let firstScan;
  try {
    firstScan = await scan(original);
    base.scanAttempts = 1;
  } catch (error) {
    return { ...base, status: "scan_failed", notice: `语言质检暂时不可用，已保留初稿并继续：${clean(error?.message || error)}` };
  }
  const hits = Array.isArray(firstScan?.hits) ? firstScan.hits : [];
  if (!hits.length) return { ...base, initialScan: firstScan };
  base.initialHits = hits;
  if (typeof revise !== "function") return {
    ...base,
    status: "issues_unrevised",
    initialScan: firstScan,
    remainingHits: hits,
    notice: `仍有 ${hits.reduce((sum, hit) => sum + (hit.excess || 1), 0)} 处重复表达，可继续优化。`,
  };
  const request = buildWritingStyleRevisionRequest({ draft: original, hits });
  if (!request.segments.length) return {
    ...base,
    status: "issues_protected",
    initialScan: firstScan,
    remainingHits: hits,
    notice: "重复表达只出现在前文、对白、引用或受保护内容中，正文照常继续。",
  };
  let response;
  try {
    base.revisionAttempts = 1;
    response = await revise(request);
  } catch (error) {
    return {
      ...base,
      status: "revision_failed",
      initialScan: firstScan,
      remainingHits: hits,
      revisionAttempts: 1,
      notice: `局部语言修订暂时不可用，已保留初稿并继续：${clean(error?.message || error)}`,
    };
  }
  const parsed = parseWritingStyleRevisionResponse(response);
  const applied = applyWritingStyleReplacements(original, parsed.replacements);
  if (!applied.applied) return {
    ...base,
    status: "revision_invalid",
    initialScan: firstScan,
    remainingHits: hits,
    revisionAttempts: 1,
    notice: "局部修订没有返回可安全应用的句段替换，已保留初稿并继续。",
  };
  let secondScan;
  try {
    secondScan = await scan(applied.text);
  } catch (error) {
    return {
      ...base,
      text: applied.text,
      status: "recheck_failed",
      initialScan: firstScan,
      revisionAttempts: 1,
      scanAttempts: 2,
      notice: `局部修订已应用，复检暂时不可用，正文照常继续：${clean(error?.message || error)}`,
    };
  }
  const remainingHits = Array.isArray(secondScan?.hits) ? secondScan.hits : [];
  return {
    ...base,
    text: applied.text,
    status: remainingHits.length ? "residual_issues" : "revised",
    initialScan: firstScan,
    finalScan: secondScan,
    remainingHits,
    revisionAttempts: 1,
    scanAttempts: 2,
    appliedReplacements: applied.applied,
    notice: remainingHits.length
      ? `仍有 ${remainingHits.reduce((sum, hit) => sum + (hit.excess || 1), 0)} 处重复表达，可继续优化。`
      : "",
  };
};
