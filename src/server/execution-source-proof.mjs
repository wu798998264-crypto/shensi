import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const clean = (value, limit = 200) => String(value ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, limit);

export const executionSourceIdentity = ({
  kind = "document",
  id = "",
  content = "",
  version = "",
  revision = "",
} = {}) => {
  const text = String(content ?? "");
  return {
    kind: kind === "skill" ? "skill" : "document",
    id: clean(id),
    version: clean(version || revision || "current", 120),
    contentHash: sha256(text),
    contentLength: text.length,
  };
};

export const executionSourceMarker = (source = {}) => {
  const identity = executionSourceIdentity(source);
  return `<!-- shensi-execution-source ${JSON.stringify(identity)} -->`;
};

const SOURCE_MARKER = /<!-- shensi-execution-source (\{[^\r\n]+\}) -->\r?\n/gu;
const SOURCE_DECLARATION = /<!-- shensi-execution-source (\{[^\r\n]+\}) -->/gu;

const executionSourceDeclarations = (text = "") => [...String(text || "").matchAll(SOURCE_DECLARATION)].flatMap((match) => {
  try {
    const identity = JSON.parse(match[1]);
    return [identity];
  } catch {
    return [];
  }
});

export const executionSourcesFromContextBlocks = (blocks = [], { ignoreMismatches = false } = {}) => (Array.isArray(blocks) ? blocks : [])
  .flatMap((block) => {
    const text = String(block?.text || "");
    return [...text.matchAll(SOURCE_MARKER)].flatMap((match) => {
      let identity;
      try {
        identity = JSON.parse(match[1]);
      } catch {
        return [];
      }
      const start = Number(match.index) + match[0].length;
      const content = text.slice(start, start + Math.max(0, Number(identity.contentLength) || 0));
      const actual = executionSourceIdentity({
        kind: identity.kind,
        id: identity.id,
        version: identity.version,
        content,
      });
      if (actual.contentHash !== identity.contentHash || actual.contentLength !== identity.contentLength) {
        if (ignoreMismatches) return [];
        const error = new Error(`${identity.kind === "skill" ? "Skill" : "文档"}“${identity.id || "未知来源"}”的来源标记与实际全文不一致（声明 ${identity.contentLength} 字，实际 ${actual.contentLength} 字；哈希 ${String(identity.contentHash || "").slice(0, 8)}/${String(actual.contentHash || "").slice(0, 8)}）`);
        error.code = "EXECUTION_SOURCE_MARKER_MISMATCH";
        error.source = {
          kind: identity.kind,
          id: identity.id,
          declaredLength: identity.contentLength,
          actualLength: actual.contentLength,
          declaredHashPrefix: String(identity.contentHash || "").slice(0, 12),
          actualHashPrefix: String(actual.contentHash || "").slice(0, 12),
        };
        throw error;
      }
      return [{ kind: identity.kind, id: identity.id, version: identity.version, content }];
    });
  });

const finalInputText = ({ system = "", messages = [] } = {}) => [
  String(system ?? ""),
  ...(Array.isArray(messages) ? messages : []).map((message) => String(message?.content ?? "")),
].join("\n\n");

export const executionSourceProofContext = ({ system = "", messages = [], sources = [] } = {}) => {
  const existingInput = finalInputText({ system, messages });
  return (Array.isArray(sources) ? sources : []).filter((source) => source?.id && String(source?.content || "")).map((source) => {
    const marker = executionSourceMarker(source);
    const content = String(source.content || "");
    return existingInput.includes(content) ? marker : `${marker}\n${content}`;
  }).join("\n");
};

export const buildExecutionSourceReceipt = ({ system = "", messages = [], sources = [], stage = "" } = {}) => {
  const finalInput = finalInputText({ system, messages });
  const declaredIdentities = executionSourceDeclarations(finalInput);
  // Empty target documents (for example a newly-created whiteboard card) are
  // output surfaces, not readable evidence. They must not fail the proof gate.
  const proofSources = (Array.isArray(sources) ? sources : []).filter((source) => (
    source?.id && String(source?.content ?? "").length > 0
  ));
  const verifiedSources = proofSources.map((source) => {
    const identity = executionSourceIdentity(source);
    const content = String(source?.content ?? "");
    const marked = declaredIdentities.find((item) => item.kind === identity.kind
      && item.id === identity.id
      && item.contentHash === identity.contentHash
      && Number(item.contentLength) === identity.contentLength);
    const markerPresent = Boolean(marked);
    const contentPresent = Boolean(content) && finalInput.includes(content);
    if (!identity.id || !content || !markerPresent || !contentPresent) {
      const sameIdCandidates = declaredIdentities.filter((item) => item.kind === identity.kind && item.id === identity.id);
      const candidateSummary = sameIdCandidates.length
        ? `；最终输入中同名来源：${sameIdCandidates.map((item) => `${item.contentLength}/${String(item.contentHash || "").slice(0, 8)}`).join("、")}`
        : "；最终输入中没有同名有效来源标记";
      const error = new Error(`${identity.kind === "skill" ? "Skill" : "文档"}“${identity.id || "未知来源"}”没有完整进入最终模型输入（期望 ${identity.contentLength}/${identity.contentHash.slice(0, 8)}${candidateSummary}）`);
      error.code = "EXECUTION_SOURCE_NOT_FULLY_LOADED";
      error.source = { ...identity, markerPresent, contentPresent };
      throw error;
    }
    return {
      ...identity,
      markerVersion: marked?.version || identity.version,
      markerPresent,
      contentPresent,
      fullText: true,
    };
  });
  return {
    verified: verifiedSources.length > 0 && verifiedSources.every((item) => item.fullText),
    stage: clean(stage, 80),
    finalInputHash: sha256(finalInput),
    sources: verifiedSources,
    verifiedAt: new Date().toISOString(),
  };
};

export const buildExecutionSourceReceiptFromContextBlocks = ({ finalInput = "", blocks = [], stage = "" } = {}) => {
  const inputText = String(finalInput ?? "");
  const verifiedSources = [];
  const seen = new Set();
  let markerBlockCount = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const blockText = String(block?.text || "");
    if (!blockText.includes("<!-- shensi-execution-source ")) continue;
    markerBlockCount += 1;
    const sources = executionSourcesFromContextBlocks([{ text: blockText }], { ignoreMismatches: true });
    if (!sources.length || !inputText.includes(blockText)) continue;
    for (const source of sources) {
      const identity = executionSourceIdentity(source);
      const key = `${identity.kind}:${identity.id}:${identity.contentHash}:${identity.contentLength}`;
      if (seen.has(key)) continue;
      seen.add(key);
      verifiedSources.push({
        ...identity,
        markerVersion: identity.version,
        markerPresent: true,
        contentPresent: true,
        fullText: true,
      });
    }
  }
  if (markerBlockCount > 0 && verifiedSources.length === 0) {
    const error = new Error("启用的 Skill 或文档没有完整进入最终模型输入");
    error.code = "EXECUTION_SOURCE_NOT_FULLY_LOADED";
    throw error;
  }
  return verifiedSources.length ? {
    verified: true,
    stage: clean(stage, 80),
    finalInputHash: sha256(inputText),
    sources: verifiedSources,
    verifiedAt: new Date().toISOString(),
  } : null;
};
