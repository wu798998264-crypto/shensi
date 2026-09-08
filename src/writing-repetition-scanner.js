const clean = (value = "") => String(value ?? "");
const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const maskRange = (characters, start, end) => {
  for (let index = Math.max(0, start); index < Math.min(characters.length, end); index += 1) characters[index] = " ";
};

const maskedProtectedText = (text = "", protectedTerms = []) => {
  const source = clean(text);
  const characters = [...source];
  const quotePairs = [["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["\"", "\""]];
  for (const [opening, closing] of quotePairs) {
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf(opening, cursor);
      if (start < 0) break;
      const end = source.indexOf(closing, start + opening.length);
      if (end < 0) break;
      maskRange(characters, start, end + closing.length);
      cursor = end + closing.length;
    }
  }
  for (const term of protectedTerms.filter(Boolean)) {
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf(term, cursor);
      if (start < 0) break;
      maskRange(characters, start, start + term.length);
      cursor = start + Math.max(1, term.length);
    }
  }
  return characters.join("");
};

const sentenceAt = (text = "", index = 0) => {
  const source = clean(text);
  const left = Math.max(source.lastIndexOf("。", index - 1), source.lastIndexOf("！", index - 1), source.lastIndexOf("？", index - 1), source.lastIndexOf("\n", index - 1)) + 1;
  const ends = [source.indexOf("。", index), source.indexOf("！", index), source.indexOf("？", index), source.indexOf("\n", index)].filter((value) => value >= 0);
  const right = ends.length ? Math.min(...ends) + 1 : source.length;
  return source.slice(left, right).trim();
};

const patternForRule = (rule = {}) => {
  if (rule.type !== "sentence_pattern") return new RegExp(escapeRegExp(rule.value), "gu");
  const parts = String(rule.value).split(/(?:……|…{2,}|\.\.\.)/u).filter(Boolean).map(escapeRegExp);
  return new RegExp(parts.join("[^。！？\\n]{0,48}?"), "gu");
};

const taskParts = ({ taskKind = "new_chapter", generatedText = "", currentDocumentText = "", adjacentText = "" } = {}) => {
  if (taskKind === "continuation") return [
    { kind: "current", text: clean(currentDocumentText), editable: false },
    { kind: "generated", text: clean(generatedText), editable: true },
  ];
  if (taskKind === "local_patch") return [
    { kind: "adjacent", text: clean(adjacentText), editable: false },
    { kind: "generated", text: clean(generatedText), editable: true },
  ];
  if (taskKind === "full_optimization") return [{ kind: "generated", text: clean(generatedText || currentDocumentText), editable: true }];
  return [{ kind: "generated", text: clean(generatedText), editable: true }];
};

const ruleAllowance = (rule = {}, characterCount = 0) => {
  const limits = [];
  if (Number.isFinite(Number(rule.maxOccurrences))) limits.push(Math.max(0, Math.floor(Number(rule.maxOccurrences))));
  if (Number.isFinite(Number(rule.maxPerThousandChars))) limits.push(Math.max(0, Math.ceil((characterCount / 1000) * Number(rule.maxPerThousandChars))));
  return limits.length ? Math.min(...limits) : Number.POSITIVE_INFINITY;
};

export const scanWritingRepetition = ({
  taskKind = "new_chapter",
  generatedText = "",
  currentDocumentText = "",
  adjacentText = "",
  rules = [],
  protectedTerms = [],
} = {}) => {
  const parts = taskParts({ taskKind, generatedText, currentDocumentText, adjacentText }).filter((part) => part.text);
  const totalText = parts.map((part) => part.text).join("\n");
  const characterCount = (totalText.match(/\p{Script=Han}/gu) ?? []).length || totalText.length;
  const hits = [];
  for (const rule of (Array.isArray(rules) ? rules : [])) {
    if (!rule?.value) continue;
    const occurrences = [];
    for (const part of parts) {
      const protectedForRule = [...protectedTerms, ...(Array.isArray(rule.exceptions) ? rule.exceptions : [])];
      const masked = maskedProtectedText(part.text, protectedForRule);
      const pattern = patternForRule(rule);
      for (const match of masked.matchAll(pattern)) occurrences.push({
        index: match.index ?? 0,
        length: match[0].length,
        text: part.text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length),
        segment: sentenceAt(part.text, match.index ?? 0),
        part: part.kind,
        editable: part.editable,
      });
    }
    const allowed = ruleAllowance(rule, characterCount);
    if (occurrences.length <= allowed) continue;
    hits.push({
      rule: { ...rule },
      count: occurrences.length,
      allowed,
      excess: occurrences.length - allowed,
      occurrences,
    });
  }
  return { taskKind, characterCount, hits, scannedParts: parts.map(({ kind, text, editable }) => ({ kind, characters: text.length, editable })) };
};

export const scanWritingBatch = ({ documents = [], rules = [], protectedTerms = [] } = {}) => {
  const normalized = (Array.isArray(documents) ? documents : []).map((document, index) => ({
    id: String(document?.id || `document-${index + 1}`),
    text: clean(document?.text),
  }));
  const documentResults = normalized.map((document) => ({
    id: document.id,
    scan: scanWritingRepetition({ taskKind: "new_chapter", generatedText: document.text, rules, protectedTerms }),
  }));
  const adjacentHits = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const pair = scanWritingRepetition({
      taskKind: "continuation",
      currentDocumentText: normalized[index].text,
      generatedText: normalized[index + 1].text,
      rules,
      protectedTerms,
    });
    if (pair.hits.length) adjacentHits.push({ documentIds: [normalized[index].id, normalized[index + 1].id], hits: pair.hits });
  }
  return { documents: documentResults, adjacentHits };
};
