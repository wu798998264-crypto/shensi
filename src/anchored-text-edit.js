const cleanText = (value) => String(value ?? "");

const clampOffset = (value, maximum) => Math.max(0, Math.min(maximum, Math.trunc(Number(value) || 0)));

const fingerprint32 = (value, seed) => {
  let hash = seed >>> 0;
  const source = cleanText(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const textContentFingerprint = (value) => {
  const source = cleanText(value);
  return `${source.length.toString(36)}-${fingerprint32(source, 2166136261)}${fingerprint32(source, 3339675911)}`;
};

const allOccurrences = (source, needle) => {
  if (!needle) return [];
  const offsets = [];
  let cursor = 0;
  while (cursor <= source.length - needle.length) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + Math.max(1, needle.length);
  }
  return offsets;
};

const commonPrefixLength = (left, right) => {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
};

const commonSuffixLength = (left, right) => {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[left.length - length - 1] === right[right.length - length - 1]) length += 1;
  return length;
};

const normalizedWhitespaceView = (value) => {
  const source = cleanText(value);
  let text = "";
  const starts = [];
  const ends = [];
  for (let index = 0; index < source.length;) {
    if (/\s/u.test(source[index])) {
      const start = index;
      while (index < source.length && /\s/u.test(source[index])) index += 1;
      text += " ";
      starts.push(start);
      ends.push(index);
      continue;
    }
    text += source[index];
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text, starts, ends };
};

const contextualScore = ({ currentText, startOffset, endOffset, anchor }) => {
  const prefix = cleanText(anchor.prefix);
  const suffix = cleanText(anchor.suffix);
  const currentPrefix = currentText.slice(Math.max(0, startOffset - prefix.length), startOffset);
  const currentSuffix = currentText.slice(endOffset, endOffset + suffix.length);
  const compactPrefix = prefix.replace(/\s+/gu, " ").trimEnd();
  const compactCurrentPrefix = currentPrefix.replace(/\s+/gu, " ").trimEnd();
  const compactSuffix = suffix.replace(/\s+/gu, " ").trimStart();
  const compactCurrentSuffix = currentSuffix.replace(/\s+/gu, " ").trimStart();
  const left = prefix ? Math.max(
    commonSuffixLength(prefix, currentPrefix) / prefix.length,
    compactPrefix ? commonSuffixLength(compactPrefix, compactCurrentPrefix) / compactPrefix.length : 0,
  ) : 1;
  const right = suffix ? Math.max(
    commonPrefixLength(suffix, currentSuffix) / suffix.length,
    compactSuffix ? commonPrefixLength(compactSuffix, compactCurrentSuffix) / compactSuffix.length : 0,
  ) : 1;
  const driftBase = Math.max(80, Math.round(Math.max(anchor.baselineLength || 0, currentText.length) * 0.2));
  const drift = Math.max(0, 1 - Math.abs(startOffset - Number(anchor.startOffset || 0)) / driftBase);
  return Number((left * 0.45 + right * 0.45 + drift * 0.1).toFixed(4));
};

const chooseContextualMatch = ({ currentText, candidates, anchor, strategy, normalized = false }) => {
  const ranked = candidates.map((candidate) => ({
    ...candidate,
    score: contextualScore({ currentText, startOffset: candidate.startOffset, endOffset: candidate.endOffset, anchor }),
  })).sort((left, right) => right.score - left.score || left.startOffset - right.startOffset);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best) return null;
  if (ranked.length === 1) return {
    ...best,
    strategy: normalized ? "normalized_unique" : "exact_unique",
    confidence: normalized ? 0.86 : 0.98,
  };
  const margin = best.score - (runnerUp?.score ?? 0);
  if (best.score < 0.58 || margin < 0.12) return null;
  return {
    ...best,
    strategy,
    confidence: Number(Math.min(normalized ? 0.84 : 0.96, Math.max(normalized ? 0.68 : 0.76, best.score)).toFixed(4)),
  };
};

export const createAnchoredTextEditContract = ({
  transactionId = "",
  documentId = "",
  documentText = "",
  startOffset = 0,
  endOffset = startOffset,
  contextSize = 240,
  createdAt = "",
} = {}) => {
  const source = cleanText(documentText);
  const start = clampOffset(startOffset, source.length);
  const end = Math.max(start, clampOffset(endOffset, source.length));
  const originalText = source.slice(start, end);
  const windowSize = Math.max(48, Math.min(1_200, Math.trunc(Number(contextSize) || 240)));
  const occurrences = allOccurrences(source, originalText);
  return {
    schemaVersion: 1,
    transactionId: cleanText(transactionId).slice(0, 160),
    documentId: cleanText(documentId).slice(0, 160),
    baselineFingerprint: textContentFingerprint(source),
    baselineLength: source.length,
    startOffset: start,
    endOffset: end,
    originalText,
    originalFingerprint: textContentFingerprint(originalText),
    prefix: source.slice(Math.max(0, start - windowSize), start),
    suffix: source.slice(end, Math.min(source.length, end + windowSize)),
    occurrenceOrdinal: Math.max(0, occurrences.indexOf(start)),
    createdAt: cleanText(createdAt).slice(0, 80) || new Date().toISOString(),
  };
};

export const resolveAnchoredTextEdit = ({ contract = {}, currentText = "" } = {}) => {
  const source = cleanText(currentText);
  const originalText = cleanText(contract.originalText);
  if (contract.originalFingerprint && contract.originalFingerprint !== textContentFingerprint(originalText)) {
    return { status: "conflict", reason: "invalid_contract", message: "局部修改锚点已损坏" };
  }
  const expectedStart = clampOffset(contract.startOffset, source.length);
  if (!originalText) {
    const prefix = cleanText(contract.prefix);
    const suffix = cleanText(contract.suffix);
    const matchesAt = (offset) => (!prefix || source.slice(Math.max(0, offset - prefix.length), offset) === prefix)
      && (!suffix || source.slice(offset, offset + suffix.length) === suffix);
    if (contract.baselineFingerprint === textContentFingerprint(source)) return {
      status: "resolved",
      startOffset: expectedStart,
      endOffset: expectedStart,
      currentText: "",
      strategy: "baseline_offset",
      confidence: 1,
    };
    if (matchesAt(expectedStart)) return {
      status: "resolved",
      startOffset: expectedStart,
      endOffset: expectedStart,
      currentText: "",
      strategy: "stable_offset",
      confidence: 0.96,
    };
    const candidates = [];
    if (suffix) {
      for (const offset of allOccurrences(source, suffix)) if (matchesAt(offset)) candidates.push(offset);
    } else if (prefix) {
      for (const start of allOccurrences(source, prefix)) {
        const offset = start + prefix.length;
        if (matchesAt(offset)) candidates.push(offset);
      }
    }
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return {
      status: "resolved",
      startOffset: unique[0],
      endOffset: unique[0],
      currentText: "",
      strategy: "contextual_boundary",
      confidence: 0.9,
    };
    return {
      status: "conflict",
      reason: unique.length > 1 ? "ambiguous_boundary" : "boundary_missing",
      message: unique.length > 1 ? "补写位置出现多个相同前后文，无法安全判断插入点" : "补写位置在生成期间已变化，无法安全插入",
    };
  }
  const expectedEnd = Math.min(source.length, expectedStart + originalText.length);
  if (source.slice(expectedStart, expectedEnd) === originalText) {
    const score = contextualScore({ currentText: source, startOffset: expectedStart, endOffset: expectedEnd, anchor: contract });
    return {
      status: "resolved",
      startOffset: expectedStart,
      endOffset: expectedEnd,
      currentText: originalText,
      strategy: contract.baselineFingerprint === textContentFingerprint(source) ? "baseline_offset" : "stable_offset",
      confidence: contract.baselineFingerprint === textContentFingerprint(source) ? 1 : Math.max(0.92, score),
    };
  }

  const exactCandidates = allOccurrences(source, originalText).map((startOffset) => ({
    startOffset,
    endOffset: startOffset + originalText.length,
    currentText: originalText,
  }));
  const exact = chooseContextualMatch({
    currentText: source,
    candidates: exactCandidates,
    anchor: contract,
    strategy: "contextual_exact",
  });
  if (exact) return { status: "resolved", ...exact };
  if (exactCandidates.length > 1) {
    return { status: "conflict", reason: "ambiguous_original", message: "原文存在多个相同位置，无法安全判断应替换哪一处" };
  }

  const normalizedSource = normalizedWhitespaceView(source);
  const normalizedOriginal = normalizedWhitespaceView(originalText).text;
  const normalizedCandidates = allOccurrences(normalizedSource.text, normalizedOriginal).map((normalizedStart) => {
    const normalizedEnd = normalizedStart + normalizedOriginal.length - 1;
    const startOffset = normalizedSource.starts[normalizedStart];
    const endOffset = normalizedSource.ends[normalizedEnd];
    return { startOffset, endOffset, currentText: source.slice(startOffset, endOffset) };
  }).filter((candidate) => Number.isFinite(candidate.startOffset) && Number.isFinite(candidate.endOffset));
  const normalized = chooseContextualMatch({
    currentText: source,
    candidates: normalizedCandidates,
    anchor: contract,
    strategy: "contextual_normalized",
    normalized: true,
  });
  if (normalized) return { status: "resolved", ...normalized };
  return {
    status: "conflict",
    reason: normalizedCandidates.length > 1 ? "ambiguous_normalized_original" : "original_missing",
    message: normalizedCandidates.length > 1
      ? "原文格式发生变化且存在多个相似位置，已停止自动替换"
      : "原文在生成期间已被修改，无法安全应用旧补丁",
  };
};

export const applyAnchoredTextEdit = ({ contract = {}, currentText = "", replacementText = "", appliedAt = "" } = {}) => {
  const source = cleanText(currentText);
  const replacement = cleanText(replacementText);
  const resolved = resolveAnchoredTextEdit({ contract, currentText: source });
  if (resolved.status !== "resolved") return resolved;
  const afterText = `${source.slice(0, resolved.startOffset)}${replacement}${source.slice(resolved.endOffset)}`;
  return {
    status: "applied",
    beforeText: source,
    afterText,
    startOffset: resolved.startOffset,
    endOffset: resolved.endOffset,
    replacementEndOffset: resolved.startOffset + replacement.length,
    strategy: resolved.strategy,
    confidence: resolved.confidence,
    receipt: {
      schemaVersion: 1,
      transactionId: cleanText(contract.transactionId).slice(0, 160),
      documentId: cleanText(contract.documentId).slice(0, 160),
      baselineFingerprint: cleanText(contract.baselineFingerprint),
      beforeFingerprint: textContentFingerprint(source),
      afterFingerprint: textContentFingerprint(afterText),
      startOffset: resolved.startOffset,
      endOffset: resolved.endOffset,
      replacementEndOffset: resolved.startOffset + replacement.length,
      originalText: resolved.currentText,
      replacementText: replacement,
      strategy: resolved.strategy,
      confidence: resolved.confidence,
      appliedAt: cleanText(appliedAt).slice(0, 80) || new Date().toISOString(),
    },
  };
};

export const undoAnchoredTextEdit = ({ receipt = {}, currentText = "" } = {}) => {
  const source = cleanText(currentText);
  if (!receipt.afterFingerprint || textContentFingerprint(source) !== receipt.afterFingerprint) {
    return {
      status: "conflict",
      reason: "after_hash_mismatch",
      message: "正文在本次局部修改后又发生了变化，已停止旧事务撤销",
    };
  }
  const start = clampOffset(receipt.startOffset, source.length);
  const end = clampOffset(receipt.replacementEndOffset, source.length);
  if (source.slice(start, end) !== cleanText(receipt.replacementText)) {
    return { status: "conflict", reason: "replacement_missing", message: "已落盘替换内容不再匹配，无法安全撤销" };
  }
  const restoredText = `${source.slice(0, start)}${cleanText(receipt.originalText)}${source.slice(end)}`;
  return {
    status: "undone",
    text: restoredText,
    beforeFingerprint: textContentFingerprint(source),
    afterFingerprint: textContentFingerprint(restoredText),
  };
};
