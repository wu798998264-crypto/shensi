import { sanitizeMediaProviderPrompt } from "../media-prompt.js";

const mappingError = message => Object.assign(new Error(`LibTV 视频参考映射失败：${message}；尚未提交生成`), { providerErrorCode: "LIBTV_REFERENCE_MAPPING_MISSING", submissionOutcomeKnown: true });
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const referenceSource = job => sanitizeMediaProviderPrompt(job.request?.libTvReferencePrompt || job.request?.prompt || job.request?.executionPrompt || "", { preserveReferenceTokens: true, maxCharacters: Infinity });

export const libTvVideoReferenceBindings = ({ job, references = [] }) => {
  const source = referenceSource(job);
  const tokens = [...new Set((job.request?.providerPromptReferenceTokens || []).map(String).filter(Boolean))];
  if (!tokens.length) return [];
  const pattern = new RegExp(tokens.sort((a, b) => b.length - a.length).map(escape).join("|"), "gu");
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) return [];
  const sequence = job.request?.promptReferenceSequence || [];
  if (matches.length !== sequence.length) throw mappingError("插入引用与卡片身份的数量不一致");
  return matches.map((match, index) => {
    const id = String(sequence[index]);
    const candidates = references.map((reference, offset) => ({ reference, offset })).filter(item => String(item.reference?.id || "") === id);
    if (candidates.length !== 1 || !candidates[0].reference.absolutePath) throw mappingError(`第 ${index + 1} 处引用没有对应的媒体，或身份不唯一`);
    return { token: match[0], start: match.index, end: match.index + match[0].length, id, offset: candidates[0].offset };
  });
};

export const compileLibTvVideoReferencePrompt = ({ job, references = [], uploadedNodes = [] }) => {
  const source = referenceSource(job);
  const bindings = libTvVideoReferenceBindings({ job, references });
  let cursor = 0, compiled = "";
  for (const binding of bindings) {
    const key = String(uploadedNodes[binding.offset] || "");
    if (!/^[A-Za-z0-9_-]+$/u.test(key)) throw mappingError(`第 ${binding.offset + 1} 个参考未返回有效节点 ID`);
    compiled += source.slice(cursor, binding.start) + `{{Node ${key}}}`;
    cursor = binding.end;
  }
  return compiled + source.slice(cursor);
};
