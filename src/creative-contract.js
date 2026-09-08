export const CREATIVE_CONTRACT_DOCUMENT_ID = "index-language-blacklist";

export const CREATIVE_CONTRACT_FIELDS = Object.freeze({
  bannedTerms: "项目禁用词",
  specialNotes: "特别注意事项",
});

const clean = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 20_000);

const decodeHtml = (value = "") => String(value)
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

const plainHtml = (value = "") => decodeHtml(String(value)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(?:p|div|li|tr|blockquote)>/gi, "\n")
  .replace(/<[^>]+>/g, ""))
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n");

const placeholder = (value = "") => /^(?:当前没有项目级禁用词|当前没有项目级特别注意事项|尚未填写|暂无)[。.]?$/u.test(clean(value));

const htmlSection = (html = "", label = "") => {
  const source = String(html);
  const heading = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/giu;
  let matched = null;
  for (const candidate of source.matchAll(heading)) {
    if (plainHtml(candidate[2]) === label) {
      matched = candidate;
      break;
    }
  }
  if (!matched) return "";
  const level = Number(matched[1]);
  const bodyStart = matched.index + matched[0].length;
  const remainder = source.slice(bodyStart);
  let bodyEnd = remainder.length;
  for (const candidate of remainder.matchAll(/<h([2-4])[^>]*>[\s\S]*?<\/h\1>/giu)) {
    if (Number(candidate[1]) <= level) {
      bodyEnd = candidate.index;
      break;
    }
  }
  const value = plainHtml(remainder.slice(0, bodyEnd));
  return placeholder(value) ? "" : clean(value);
};

const markdownSection = (markdown = "", label = "") => {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => {
    const match = line.match(/^(#{2,4})\s*(.*?)\s*$/u);
    return match?.[2] === label;
  });
  if (start < 0) return "";
  const level = lines[start].match(/^(#{2,4})/u)[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,4})\s+/u);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  const value = clean(lines.slice(start + 1, end).join("\n")).replace(/^[-*+]\s+/gm, "").trim();
  return placeholder(value) ? "" : value;
};

export const normalizeCreativeContract = (documentState = {}) => {
  const stored = documentState?.creativeContract && typeof documentState.creativeContract === "object"
    ? documentState.creativeContract
    : null;
  const fromSource = (field, label) => markdownSection(documentState?.markdown, label)
    || htmlSection(documentState?.html, label);
  return {
    schemaVersion: 1,
    bannedTerms: stored && Object.hasOwn(stored, "bannedTerms") ? clean(stored.bannedTerms) : fromSource("bannedTerms", CREATIVE_CONTRACT_FIELDS.bannedTerms),
    specialNotes: stored && Object.hasOwn(stored, "specialNotes") ? clean(stored.specialNotes) : fromSource("specialNotes", CREATIVE_CONTRACT_FIELDS.specialNotes),
  };
};

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const fieldHtml = (value = "") => clean(value)
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => `<p>${escapeHtml(line.trim())}</p>`)
  .join("");

export const creativeContractHtml = (contract = {}) => {
  const normalized = normalizeCreativeContract({ creativeContract: contract });
  return `<h1>创作合同</h1><h2>项目禁用词</h2>${fieldHtml(normalized.bannedTerms)}<h2>特别注意事项</h2>${fieldHtml(normalized.specialNotes)}`;
};

export const creativeContractMarkdown = (contract = {}) => {
  const normalized = normalizeCreativeContract({ creativeContract: contract });
  return `# 创作合同\n\n## 项目禁用词\n\n${normalized.bannedTerms}\n\n## 特别注意事项\n\n${normalized.specialNotes}`.trim();
};

export const creativeContractDocumentPatch = (documentState = {}, patch = {}) => {
  const previous = normalizeCreativeContract(documentState);
  const creativeContract = {
    schemaVersion: 1,
    bannedTerms: Object.hasOwn(patch, "bannedTerms") ? clean(patch.bannedTerms) : previous.bannedTerms,
    specialNotes: Object.hasOwn(patch, "specialNotes") ? clean(patch.specialNotes) : previous.specialNotes,
  };
  return {
    ...documentState,
    title: "创作合同",
    moduleId: "index",
    creativeContract,
    html: creativeContractHtml(creativeContract),
    markdown: creativeContractMarkdown(creativeContract),
    managedFormat: {
      schemaId: "shensi.index.creative-contract.v1",
      schemaVersion: 1,
      source: "trusted-contract-projector",
    },
  };
};

export const creativeContractFieldFromInstruction = (instruction = "") => {
  const source = clean(instruction).replace(/(?:保留|保持|不要修改|不修改|不得修改)[^，。；;\n]{0,30}(?:项目?禁用词|特别注意事项|项目注意事项)[^，。；;\n]{0,12}/gu, "");
  const banned = /项目?禁用词|禁用表达|禁止使用|避免使用/u.test(source);
  const notes = /特别注意事项|特殊注意|项目注意事项|创作边界|特殊要求/u.test(source);
  if (banned && notes) return "both";
  if (banned) return "bannedTerms";
  if (notes) return "specialNotes";
  return /创作合同|项目规则/u.test(source) ? "both" : "";
};

const candidateSection = (candidate = "", label = "") => markdownSection(candidate, label)
  || htmlSection(candidate, label);

const candidateBody = (candidate = "") => clean(String(candidate)
  .replace(/^#{1,4}\s*(?:创作合同|项目禁用词|特别注意事项)\s*$/gmu, "")
  .replace(/^(?:已经?|已为你|以下是|下面是)[^\n]{0,80}[：:]?\s*$/gmu, "")
  .trim());

export const applyCreativeContractCandidate = ({ documentState = {}, candidate = "", instruction = "" } = {}) => {
  const current = normalizeCreativeContract(documentState);
  const bannedTerms = candidateSection(candidate, CREATIVE_CONTRACT_FIELDS.bannedTerms);
  const specialNotes = candidateSection(candidate, CREATIVE_CONTRACT_FIELDS.specialNotes);
  const field = creativeContractFieldFromInstruction(instruction);
  const patch = {};
  if (bannedTerms || specialNotes) {
    if (bannedTerms) patch.bannedTerms = bannedTerms;
    if (specialNotes) patch.specialNotes = specialNotes;
  } else if (field === "bannedTerms") {
    patch.bannedTerms = candidateBody(candidate);
  } else if (field === "specialNotes") {
    patch.specialNotes = candidateBody(candidate);
  } else {
    patch.specialNotes = candidateBody(candidate);
  }
  return creativeContractDocumentPatch({ ...documentState, creativeContract: current }, patch);
};

export const creativeContractText = (documentState = {}) => {
  const contract = normalizeCreativeContract(documentState);
  return [
    contract.bannedTerms && `项目禁用词：\n${contract.bannedTerms}`,
    contract.specialNotes && `特别注意事项：\n${contract.specialNotes}`,
  ].filter(Boolean).join("\n\n");
};
