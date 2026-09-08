import { rankRelevantDocuments } from "./context-compiler.js";
import { contextContentFingerprint } from "./context-source-registry.js";
import { normalizeCanvas } from "./whiteboard.js";

const SOURCE_RESEARCH_PATTERN = /研究|根据|依据|基于|结合|参考|读取|查看|分析|背景|资料|原文|原著|大纲|设定|素材/;
const VISUAL_REUSE_PATTERN = /预告|漫剧|短剧|剧本|分镜|镜头|视觉|图片|视频|角色|场景|怪物|异兽|道具|造型|服装|资产/;
const EXCLUDED_DOCUMENT_PATTERN = /(?:^|[-_:])(trash|retired|deleted|history)(?:$|[-_:])|废弃设定|回收站|历史版本/i;
const GENERIC_ASSET_LABELS = new Set([
  "图片", "视频", "音频", "生成图片", "生成视频", "上传图片", "上传视频", "参考图", "主版", "副本",
  "image", "video", "audio", "generation", "asset", "upload", "copy", "final", "preview",
]);

const text = (value) => String(value ?? "").trim();
const normalized = (value) => text(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const unique = (items) => [...new Set(items.filter(Boolean))];

export const inferCreativeTaskFacets = ({ prompt = "", deliverableType = "" } = {}) => {
  const source = text(prompt);
  return unique([
    deliverableType ? `deliverable:${deliverableType}` : "",
    /预告|先导片|宣传片|片花/.test(source) ? "promo_trailer" : "",
    SOURCE_RESEARCH_PATTERN.test(source) ? "source_analysis" : "",
    VISUAL_REUSE_PATTERN.test(source) ? "visual_asset_reuse" : "",
    /时长|秒|分钟|时间轴|节奏/.test(source) ? "duration_control" : "",
    /改编|原著|原文|小说/.test(source) && /短剧|漫剧|剧本|视频|分镜/.test(source) ? "adaptation" : "",
    /连续|统一|一致|承接|复用|沿用/.test(source) ? "visual_continuity" : "",
    /正式|成稿|定稿|终稿|完成|产出/.test(source) ? "production_ready" : "",
  ]);
};

const assetLabels = (asset = {}) => {
  const fileName = text(asset.name || asset.attachment?.name || asset.relativePath || asset.attachment?.relativePath)
    .split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") || "";
  const source = [fileName, text(asset.prompt)].filter(Boolean).join("\n");
  const labels = [
    ...fileName.split(/[-_｜|（()）【\[\]】]+/),
    ...[...source.matchAll(/[《「『“【]([^》」』”】]{2,18})[》」』”】]/g)].map((match) => match[1]),
    ...[...source.matchAll(/(?:角色|人物|怪物|异兽|地点|场景|道具|名称|主体)[：:]\s*([^，。；;\n]{2,18})/g)].map((match) => match[1]),
    ...(source.match(/[\p{Script=Han}]{2,10}|[a-z][a-z0-9_-]{2,24}/giu) ?? []),
  ].map((item) => text(item).replace(/^[\d_-]+|[\d_-]+$/g, ""))
    .filter((item) => item.length >= 2 && item.length <= 18 && !GENERIC_ASSET_LABELS.has(item.toLowerCase()))
    .filter((item) => !/^[0-9a-f-]{8,}$/i.test(item));
  return unique(labels).slice(0, 32);
};

export const collectProjectMediaAssets = ({ documents = [] } = {}) => {
  const collected = [];
  for (const document of documents) {
    if (!document?.canvas) continue;
    const canvas = normalizeCanvas(document.canvas);
    for (const asset of canvas.assets) {
      if (!["image", "video", "audio"].includes(asset.kind) || !asset.attachment?.relativePath) continue;
      collected.push({
        id: `asset:${document.id}:${asset.id}`,
        assetId: asset.id,
        documentId: document.id,
        documentTitle: document.title,
        kind: asset.kind,
        origin: asset.origin,
        name: asset.attachment.name,
        prompt: asset.prompt,
        relativePath: asset.attachment.relativePath,
        mimeType: asset.attachment.mimeType,
        size: Number(asset.attachment.size) || 0,
        attachment: { ...asset.attachment, documentId: document.id, id: asset.id },
      });
    }
    for (const node of canvas.nodes) {
      if (node.type !== "file" || !["image", "video", "audio"].includes(node.kind) || !node.file) continue;
      collected.push({
        id: `node:${document.id}:${node.id}`,
        assetId: node.id,
        documentId: document.id,
        documentTitle: document.title,
        kind: node.kind,
        origin: "canvas",
        name: node.name,
        prompt: text(node.generation?.prompt || node.generation?.instruction),
        relativePath: node.file,
        mimeType: node.mimeType,
        size: 0,
        attachment: { relativePath: node.file, name: node.name, mimeType: node.mimeType, documentId: document.id, id: node.id },
      });
    }
  }
  return [...new Map(collected.map((asset) => [asset.relativePath || asset.id, asset])).values()];
};

const documentRoleBoost = ({ document, prompt, deliverableType }) => {
  const moduleId = text(document.moduleId);
  let boost = 0;
  if (SOURCE_RESEARCH_PATTERN.test(prompt) && moduleId === "library") boost += 8;
  if (/script|short_drama|short_video|visual_prompt/.test(deliverableType) && moduleId === "outline") boost += 4;
  if (/script|short_drama|short_video|visual_prompt/.test(deliverableType) && moduleId === "canon") boost += 3;
  if (moduleId === "reports" || moduleId === "index") boost -= 3;
  return boost;
};

export const buildAdaptiveCreativeEvidence = ({
  prompt = "",
  deliverableType = "",
  documents = [],
  documentAllowed = () => true,
  maxDocuments = Number.POSITIVE_INFINITY,
  maxAssets = 6,
} = {}) => {
  const source = text(prompt);
  const facets = inferCreativeTaskFacets({ prompt: source, deliverableType });
  const candidates = documents.filter((document) => document?.id
    && text(document.content)
    && !EXCLUDED_DOCUMENT_PATTERN.test(`${document.id} ${document.title}`)
    && documentAllowed(document));
  const ranked = rankRelevantDocuments({
    ids: candidates.map((document) => document.id),
    query: source,
    titleFor: (id) => candidates.find((document) => document.id === id)?.title || id,
    contentFor: (id) => candidates.find((document) => document.id === id)?.content || "",
    limit: Number.isFinite(maxDocuments) ? Math.max(maxDocuments * 2, 20) : Number.POSITIVE_INFINITY,
  });
  const rankedById = new Map(ranked.map((item) => [item.id, item]));
  const selectedDocuments = candidates.map((document, index) => {
    const relevance = rankedById.get(document.id);
    const boost = documentRoleBoost({ document, prompt: source, deliverableType });
    const score = Number(relevance?.score || 0) + boost;
    const reasons = unique([
      relevance?.matchedTerms?.length ? `命中本轮关键词：${relevance.matchedTerms.slice(0, 6).join("、")}` : "",
      boost >= 8 ? "本轮明确要求研究已有资料" : "",
      boost >= 3 && document.moduleId === "outline" ? "交付物需要剧情规划依据" : "",
      boost >= 3 && document.moduleId === "canon" ? "交付物需要设定约束" : "",
    ]);
    return {
      ...document,
      score,
      reasons,
      fingerprint: contextContentFingerprint(document.content),
      stableIndex: index,
    };
  }).filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score || left.stableIndex - right.stableIndex)
    .slice(0, Number.isFinite(maxDocuments) ? Math.max(0, maxDocuments) : Number.POSITIVE_INFINITY);

  const sourceCorpus = normalized(selectedDocuments.map((document) => `${document.title}\n${document.content}`).join("\n\n"));
  const assets = collectProjectMediaAssets({ documents });
  const directAssetRanking = new Map(rankRelevantDocuments({
    ids: assets.map((asset) => asset.id),
    query: source,
    titleFor: (id) => assets.find((asset) => asset.id === id)?.name || id,
    contentFor: (id) => {
      const asset = assets.find((item) => item.id === id);
      // The containing whiteboard title is intentionally excluded here. A generic
      // board called “预告视觉资产” must not make every unrelated asset relevant.
      return asset?.prompt || "";
    },
    limit: Math.max(maxAssets * 3, 18),
  }).map((item) => [item.id, item]));
  const selectedAssets = assets.map((asset, index) => {
    const labels = assetLabels(asset);
    const matchedLabels = labels.filter((label) => normalized(label).length >= 2 && sourceCorpus.includes(normalized(label))).slice(0, 6);
    const direct = directAssetRanking.get(asset.id);
    const score = Number(direct?.score || 0) + matchedLabels.length * 8;
    return {
      ...asset,
      score,
      matchedLabels,
      reasons: unique([
        matchedLabels.length ? `资料正文提到：${matchedLabels.join("、")}` : "",
        direct?.matchedTerms?.length ? `任务直接命中：${direct.matchedTerms.slice(0, 6).join("、")}` : "",
      ]),
      stableIndex: index,
    };
  }).filter((asset) => asset.score > 0)
    .sort((left, right) => right.score - left.score || left.stableIndex - right.stableIndex)
    .slice(0, Math.max(0, maxAssets));

  return {
    facets,
    documents: selectedDocuments,
    assets: selectedAssets,
    sourceCharacters: selectedDocuments.reduce((sum, document) => sum + text(document.content).length, 0),
    manifest: [
      ...selectedDocuments.map((document) => ({
        kind: "document",
        id: document.id,
        title: document.title,
        fingerprint: document.fingerprint,
        reasons: document.reasons,
      })),
      ...selectedAssets.map((asset) => ({
        kind: asset.kind,
        id: asset.id,
        title: asset.name,
        relativePath: asset.relativePath,
        reasons: asset.reasons,
      })),
    ],
  };
};

export const adaptiveCreativeEvidenceContext = (evidence = {}) => {
  if (!evidence?.documents?.length && !evidence?.assets?.length) return "";
  return [
    "# 自适应任务证据",
    evidence.facets?.length ? `任务侧面：${evidence.facets.join("、")}` : "",
    evidence.documents?.length ? "### 动态发现文档" : "",
    ...(evidence.documents ?? []).map((document) => `- ${document.title}｜ID=${document.id}｜版本指纹=${document.fingerprint}｜${document.reasons.join("；") || "按任务相关性召回"}`),
    evidence.assets?.length ? "### 动态发现视觉资产" : "",
    ...(evidence.assets ?? []).map((asset) => `- ${asset.name}｜${asset.kind}｜来源=${asset.documentTitle || asset.documentId}｜路径=${asset.relativePath}｜${asset.reasons.join("；") || "与当前任务相关"}`),
    evidence.assets?.length ? "以上资产只是候选证据；只有实际读取到的附件内容可以作为视觉事实，文件名和提示词本身不能替代画面核验。" : "",
  ].filter(Boolean).join("\n");
};
