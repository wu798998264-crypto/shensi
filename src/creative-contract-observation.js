const text = (value = "", maximum = 2_000) => String(value ?? "").trim().slice(0, maximum);

const REPETITION_PATTERN = /(?:高频|频繁|反复|重复|连续).{0,18}(?:词|词汇|表达|句式|起句|收句|结构)|(?:词|词汇|表达|句式|起句|收句|结构).{0,18}(?:高频|频繁|反复|重复|连续)/u;
const LANGUAGE_DIMENSION_PATTERN = /language|style|prose|wording|语言|文风|表达/u;

const quotedTerm = (instruction = "") => String(instruction ?? "")
  .match(/[“「『"]([^”」』"\r\n]{1,80})[”」』"]/u)?.[1]?.trim() || "";

const explicitPersistentRuleProposal = ({ instruction = "", writingStyleQuality = null } = {}) => {
  const source = text(instruction, 2_000);
  if (!/(?:以后|今后|后续|从现在起|不再|永远)[^。！？；\n]{0,32}(?:不要|不得|禁止|避免|杜绝|不使用|别再)/u.test(source)
    && !/(?:不要|不得|禁止|避免|杜绝)[^。！？；\n]{0,20}(?:再|以后|后续)/u.test(source)) return null;
  const term = quotedTerm(source) || text(writingStyleQuality?.rules?.find((rule) => rule?.source === "current_instruction")?.value, 120);
  if (!term) return null;
  return {
    id: `contract-observation:instruction:${term}`,
    findingId: `instruction:${term}`,
    candidateHash: "",
    issue: `用户要求后续持续避免“${term}”`,
    suggestedRule: `禁止使用“${term}”。`,
    contractField: "specialNotes",
    source: "current_instruction",
  };
};

const residualQualityProposal = (writingStyleQuality = null) => {
  const hit = (Array.isArray(writingStyleQuality?.remainingHits) ? writingStyleQuality.remainingHits : [])
    .find((item) => item?.rule?.value && Number(item?.count) > Number(item?.allowed));
  if (!hit) return null;
  const term = text(hit.rule.value, 120);
  return {
    id: `contract-observation:quality:${term}`,
    findingId: `writing-style:${hit.rule.type || "expression"}:${term}`,
    candidateHash: "",
    issue: `“${term}”仍出现 ${hit.count} 次，超过本轮限制 ${hit.allowed} 次`,
    suggestedRule: `后续写作限制“${term}”的重复使用，默认最多出现 ${hit.allowed} 次。`,
    contractField: "specialNotes",
    source: "writing_style_quality",
  };
};

export const creativeContractObservationProposal = (reviewArtifact = {}, context = {}) => {
  const explicit = explicitPersistentRuleProposal(context);
  if (explicit) return explicit;
  const residual = residualQualityProposal(context?.writingStyleQuality);
  if (residual) return residual;
  if (reviewArtifact?.type !== "shensi_native_review") return null;
  const finding = (Array.isArray(reviewArtifact.findings) ? reviewArtifact.findings : []).find((item) => {
    if (!item || item.status === "resolved") return false;
    const copy = `${text(item.diagnosis)}\n${text(item.evidence)}\n${text(item.repairInstruction)}`;
    return LANGUAGE_DIMENSION_PATTERN.test(text(item.dimension, 120)) && REPETITION_PATTERN.test(copy);
  });
  if (!finding) return null;
  const issue = text(finding.diagnosis || finding.evidence, 800);
  const suggestedRule = text(finding.repairInstruction || `后续写作避免再次出现：${issue}`, 1_200);
  if (!issue || !suggestedRule) return null;
  return {
    id: `contract-observation:${text(finding.fingerprint || finding.code || issue, 180)}`,
    findingId: text(finding.fingerprint || finding.code, 180),
    candidateHash: text(reviewArtifact.candidateHash, 160),
    issue,
    suggestedRule,
    contractField: "specialNotes",
    source: "native_review",
  };
};

export const mergeCreativeContractObservation = (currentValue = "", proposal = null) => {
  const current = text(currentValue, 100_000);
  const rule = text(proposal?.suggestedRule, 1_200);
  if (!rule || current.includes(rule)) return current;
  return [current, rule].filter(Boolean).join("\n");
};
