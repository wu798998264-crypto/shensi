import { normalizeNovelCoverAssetMetadata } from "./novel-cover-design.js";

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const SIDE_VALUES = new Set(["left", "right", "top", "bottom"]);
const NODE_KINDS = new Set(["text", "reference", "skill", "generated", "image", "video", "audio", "web", "group"]);
const MEDIA_NODE_KINDS = new Set(["image", "video", "audio"]);
const ASSET_KINDS = new Set(["text", "image", "video", "audio"]);
const GENERATION_CHANNELS = new Set(["text", "image", "video", "audio"]);
// Read-only UI paths may reuse a canonical projection. Mutation helpers keep
// calling normalizeCanvas so their copy-on-write contract remains intact.
const canonicalCanvasCache = new WeakMap();
export const CANVAS_GRID_SIZE = 20;
export const CANVAS_MIN_ZOOM = 0.125;
export const CANVAS_MAX_ZOOM = 3;

const boundedWebText = (value = "", limit = 120_000) => String(value).normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, limit);

export const normalizeWebSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return null;
  const sourceUrl = String(snapshot.sourceUrl || snapshot.finalUrl || "").slice(0, 2_048);
  if (!sourceUrl) return null;
  const pages = (Array.isArray(snapshot.pages) ? snapshot.pages : []).slice(0, 8).map((page) => ({
    url: String(page?.url || "").slice(0, 2_048),
    title: String(page?.title || "网页资料").slice(0, 200),
    text: boundedWebText(page?.text, 40_000),
  })).filter((page) => page.url && page.text);
  const text = boundedWebText(snapshot.text || pages.map((page) => `# ${page.title}\n来源：${page.url}\n\n${page.text}`).join("\n\n"));
  if (!text) return null;
  return {
    schemaVersion: 1,
    kind: snapshot.kind === "book_directory" ? "book_directory" : "web",
    sourceUrl,
    finalUrl: String(snapshot.finalUrl || sourceUrl).slice(0, 2_048),
    title: String(snapshot.title || pages[0]?.title || "网页资料").slice(0, 200),
    fetchedAt: String(snapshot.fetchedAt || "").slice(0, 64),
    text,
    contentCharacters: text.length,
    pages,
  };
};

const normalizeViewport = (viewport = {}) => ({
  x: finite(viewport.x, 0),
  y: finite(viewport.y, 0),
  zoom: clamp(finite(viewport.zoom, 1), CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM),
});

const normalizeReferenceSkillSelection = (selection = {}) => {
  const id = String(selection.id || selection.relativePath || "");
  if (!id) return null;
  const capabilities = [...new Set((Array.isArray(selection.authorizedCapabilities)
    ? selection.authorizedCapabilities
    : Array.isArray(selection.capabilities) ? selection.capabilities : []).map(String).filter(Boolean))].slice(0, 40);
  return {
    id,
    relativePath: String(selection.relativePath || id),
    name: String(selection.name || ""),
    requestedRole: selection.requestedRole === "primary" ? "primary" : "auxiliary",
    source: String(selection.source || "whiteboard_explicit"),
    ...(capabilities.length ? { authorizedCapabilities: capabilities } : {}),
    ...(selection.slotId ? { slotId: String(selection.slotId) } : {}),
    ...(selection.slotName ? { slotName: String(selection.slotName) } : {}),
    ...(selection.parentGroupId ? { parentGroupId: String(selection.parentGroupId) } : {}),
    ...(Array.isArray(selection.groupPath) ? { groupPath: selection.groupPath.map(String).filter(Boolean).slice(0, 20) } : {}),
    ...(Number(selection.routePriority) ? { routePriority: Number(selection.routePriority) } : {}),
    ...(selection.capabilityBoundary ? { capabilityBoundary: String(selection.capabilityBoundary).slice(0, 500) } : {}),
    ...(selection.organizationGroupId ? { organizationGroupId: String(selection.organizationGroupId) } : {}),
    ...(selection.organizationRole ? { organizationRole: String(selection.organizationRole) } : {}),
    ...(selection.autoRouted === true ? { autoRouted: true } : {}),
    ...(selection.structureReference && typeof selection.structureReference === "object" ? {
      structureReference: {
        type: selection.structureReference.type === "group" ? "group" : "module",
        id: String(selection.structureReference.id || ""),
        name: String(selection.structureReference.name || ""),
      },
    } : {}),
  };
};

const normalizeSourceInspection = (inspection = {}) => {
  if (!inspection || typeof inspection !== "object") return null;
  const sourceFiles = (Array.isArray(inspection.sourceFiles) ? inspection.sourceFiles : [])
    .slice(0, 24)
    .map((file) => ({
      path: String(file?.path || "").slice(0, 240),
      contentLength: Math.max(0, Number(file?.contentLength) || 0),
      byteLength: Math.max(0, Number(file?.byteLength) || 0),
      contentHash: String(file?.contentHash || "").slice(0, 128),
    }))
    .filter((file) => file.path);
  return {
    fullText: inspection.fullText === true,
    sourceContentLength: Math.max(0, Number(inspection.sourceContentLength) || 0),
    sourceByteLength: Math.max(0, Number(inspection.sourceByteLength) || 0),
    contentHash: String(inspection.contentHash || "").slice(0, 128),
    sourceFileCount: Math.max(0, Number(inspection.sourceFileCount) || sourceFiles.length),
    sourceFiles,
    checkedAt: String(inspection.checkedAt || "").slice(0, 64),
    ...(Array.isArray(inspection.skillReadFailures) && inspection.skillReadFailures.length
      ? { skillReadFailures: inspection.skillReadFailures.slice(0, 24).map((failure) => ({
        path: String(failure?.path || "").slice(0, 240),
        reason: String(failure?.reason || "read_failed").slice(0, 120),
      })) }
      : {}),
  };
};

const normalizeReference = (reference) => {
  if (!reference || typeof reference !== "object") return null;
  const type = ["skill", "capability", "book", "document"].includes(reference.type) ? reference.type : "document";
  const skillSelections = (Array.isArray(reference.skillSelections) ? reference.skillSelections : [])
    .map(normalizeReferenceSkillSelection)
    .filter(Boolean)
    .slice(0, 24);
  return {
    type,
    id: String(reference.id ?? ""),
    title: String(reference.title ?? ""),
    ...(type === "capability" ? { nodeType: reference.nodeType === "group" ? "group" : "module", skillSelections } : {}),
    ...(type === "skill" && skillSelections.length ? { skillSelections } : {}),
    ...(reference.autoRouted === true ? { autoRouted: true } : {}),
    ...(reference.autoRouteTargetId ? { autoRouteTargetId: String(reference.autoRouteTargetId) } : {}),
    ...(Array.isArray(reference.autoRouteScopes) ? { autoRouteScopes: [...new Set(reference.autoRouteScopes.map(String).filter(Boolean))].slice(0, 8) } : {}),
    ...(reference.sourceUrl ? { sourceUrl: String(reference.sourceUrl) } : {}),
    ...(reference.coverage && typeof reference.coverage === "object" ? { coverage: reference.coverage } : {}),
    ...(normalizeSourceInspection(reference.sourceInspection) ? { sourceInspection: normalizeSourceInspection(reference.sourceInspection) } : {}),
  };
};

const normalizeGeneration = (generation) => {
  if (!generation || typeof generation !== "object" || !GENERATION_CHANNELS.has(generation.channel)) return null;
  const prompt = String(generation.prompt ?? "");
  const elapsedMs = Math.max(0, finite(generation.elapsedMs, 0));
  const profileSource = generation.profile && typeof generation.profile === "object" ? generation.profile : {};
  const profileFields = generation.channel === "text"
    ? ["executionSurface", "connectionId", "model", "reasoningEffort", "speedMode", "agentEngine", "agentConnectionId", "agentModel", "agentReasoningEffort", "agentSpeedMode"]
    : ["connectionId", "model"];
  const profile = Object.fromEntries(profileFields
    .map((field) => [field, String(profileSource[field] ?? "").trim().slice(0, 300)])
    .filter(([, value]) => value));
  return prompt ? {
      channel: generation.channel,
      prompt,
      ...(Array.isArray(generation.referenceOrder) && generation.referenceOrder.length
        ? { referenceOrder: generation.referenceOrder.map(String).filter(Boolean).slice(0, 100) }
        : {}),
      ...(elapsedMs > 0 ? { elapsedMs } : {}),
    ...(Object.keys(profile).length ? { profile } : {}),
    ...(generation.jobId ? { jobId: String(generation.jobId) } : {}),
    ...(generation.createdAt ? { createdAt: String(generation.createdAt) } : {}),
  } : null;
};

export const isUnusableWhiteboardGenerationText = (value) => {
  const text = String(value ?? "").trim();
  return /^当前任务需要补充说明(?:\s|$)/u.test(text)
    || text === "内部创作规则、系统提示和运行机制不对外提供。我可以继续协助你完善作品本身。"
    || text === "我可以正常解释神思的创作规则、Skill 与任务路由，但不能提供系统或开发者消息、密钥、凭据及隐藏思维链。"
    || text === "不能提供密钥、访问令牌、密码或其他凭据。神思规则、内置 Skill、任务路由和实现机制均可正常说明与审计。"
    || /^本轮候选没有进入可落盘状态[:：]/.test(text);
};

export const whiteboardTextGenerationRequest = (instruction = "", { hasUpstream = false, explicitReferenceCount = 0 } = {}) => {
  const task = String(instruction || "").trim();
  const inputRule = hasUpstream
    ? `逐项读取当前卡片及全部直接上游；上游只作为完成本轮任务的素材与约束，不得取代或改写任务。${explicitReferenceCount > 0 ? "优先满足带 @重点引用 的内容，但仍需综合其他直接上游。" : ""}`
    : "读取当前卡片作为素材；不要自行扩展到未连接的其他资料。";
  return [
    `本轮任务（最高优先级）：${task}`,
    "完成标准：结果必须直接回应上述任务，题材、文体、对象和输出形式均以本轮任务为准；若素材与任务无关，只提取确实有用的部分。",
    `输入规则：${inputRule}不得追溯上游卡片自己的更早节点。`,
    "能力使用方式：若用户指定某项能力，直接完成对应成品；仅输出成品本身，不说明执行过程。",
    "任务歧义兜底：若仍无法从本轮任务和直接上游唯一确定核心意图、Skill 的作用对象或预期输出，不得猜测，也不得声称生成失败；只返回一段供界面临时显示的补充说明，要求用户 @目标文档并写清要使用的 Skill、具体任务和预期结果。补充说明不是正式生成内容，不能覆盖当前卡片。",
    "正常执行时只返回可直接写入当前卡片的结果，不解释过程。",
  ].join("\n\n");
};

const normalizeNode = (node) => {
  const mediaNode = node.type === "file" || MEDIA_NODE_KINDS.has(node.kind);
  const kind = mediaNode
    ? node.kind === "audio" || String(node.mimeType ?? "").startsWith("audio/")
      ? "audio"
      : node.kind === "video" || String(node.mimeType ?? "").startsWith("video/") ? "video" : "image"
    : NODE_KINDS.has(node.kind) ? node.kind : "text";
  const aspectRatio = clamp(finite(node.aspectRatio, 16 / 9), 0.1, 10);
  const width = Math.max(180, finite(node.width, mediaNode ? 320 : 260));
  return {
    id: String(node.id),
    type: mediaNode ? "file" : "text",
    kind,
    ...(mediaNode || String(node.name ?? "").trim() ? {
      name: String(node.name ?? (kind === "audio" ? "音频" : kind === "video" ? "视频" : "图片")),
    } : {}),
    text: String(node.text ?? ""),
    x: finite(node.x, 40),
    y: finite(node.y, 40),
    width,
    height: Math.max(100, finite(node.height, mediaNode ? width / aspectRatio : 160)),
    color: String(node.color ?? "default"),
    ...(kind === "web" ? {
      url: String(node.url ?? ""),
      ...(normalizeWebSnapshot(node.webSnapshot) ? { webSnapshot: normalizeWebSnapshot(node.webSnapshot) } : {}),
    } : {}),
    ...(mediaNode ? {
      file: String(node.file ?? node.relativePath ?? ""),
      mimeType: String(node.mimeType ?? (kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "image/png")),
      aspectRatio,
      ...(node.thumbnailRelativePath ? { thumbnailRelativePath: String(node.thumbnailRelativePath) } : {}),
      ...(node.thumbnailMimeType ? { thumbnailMimeType: String(node.thumbnailMimeType) } : {}),
      ...(finite(node.durationMs, 0) > 0 ? { durationMs: Math.max(1, finite(node.durationMs, 0)) } : {}),
      ...(node.mediaBatchDirectory ? { mediaBatchDirectory: String(node.mediaBatchDirectory) } : {}),
      ...(node.mediaBatchIndexPath ? { mediaBatchIndexPath: String(node.mediaBatchIndexPath) } : {}),
      ...(node.whiteboardMediaDirectory ? { whiteboardMediaDirectory: String(node.whiteboardMediaDirectory) } : {}),
      ...(node.whiteboardMediaIndexPath ? { whiteboardMediaIndexPath: String(node.whiteboardMediaIndexPath) } : {}),
    } : {}),
    ...(normalizeReference(node.reference) ? { reference: normalizeReference(node.reference) } : {}),
    ...(normalizeGeneration(node.generation) ? { generation: normalizeGeneration(node.generation) } : {}),
  };
};

const normalizeEdge = (edge, nodeIds, index) => {
  const fromNode = String(edge?.fromNode ?? "");
  const toNode = String(edge?.toNode ?? "");
  if (!fromNode || !toNode || fromNode === toNode || !nodeIds.has(fromNode) || !nodeIds.has(toNode)) return null;
  return {
    id: String(edge.id || `canvas-edge-${fromNode}-${toNode}-${index}`),
    fromNode,
    toNode,
    // Keep the user's insertion order independent from the serialized array
    // position. Older canvases have no order field, so their array position
    // is used as a stable migration fallback.
    order: Number.isFinite(Number(edge.order)) ? Math.max(0, Number(edge.order)) : index,
    fromSide: SIDE_VALUES.has(edge.fromSide) ? edge.fromSide : "right",
    toSide: SIDE_VALUES.has(edge.toSide) ? edge.toSide : "left",
    label: String(edge.label ?? ""),
    color: String(edge.color ?? "default"),
  };
};

const acyclicCanvasEdges = (edges, nodeIds) => {
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, []]));
  const accepted = [];
  for (const edge of edges.filter((item, index, items) => items.findIndex((candidate) => candidate.fromNode === item.fromNode && candidate.toNode === item.toNode) === index)) {
    const pending = [edge.toNode];
    const visited = new Set();
    let createsCycle = false;
    while (pending.length) {
      const current = pending.pop();
      if (current === edge.fromNode) {
        createsCycle = true;
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(outgoing.get(current) ?? []));
    }
    if (createsCycle) continue;
    accepted.push(edge);
    outgoing.get(edge.fromNode)?.push(edge.toNode);
  }
  return accepted;
};

const validAssetTimestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
};

const ASSET_ID_TIMESTAMP_PATTERN = /(?<!\d)(1[5-9]\d{11}|2\d{12})(?!\d)/gu;
const ASSET_ID_TIMESTAMP_MINIMUM = Date.parse("2000-01-01T00:00:00.000Z");
const ASSET_ID_TIMESTAMP_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const LEGACY_ASSET_TIME_REPAIR_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const assetIdentityTimestamp = (asset = {}) => {
  const values = [
    asset.id,
    asset.sourceAssetId,
    asset.messageId,
    asset.sourceMessageId,
    asset.conversationId,
    asset.attachment?.id,
    asset.attachment?.relativePath,
    asset.attachment?.name,
  ];
  const timestamps = values.flatMap((value) => [...String(value || "").matchAll(ASSET_ID_TIMESTAMP_PATTERN)]
    .map((match) => Number(match[1])))
    .filter((timestamp) => Number.isFinite(timestamp)
      && timestamp >= ASSET_ID_TIMESTAMP_MINIMUM
      && timestamp <= Date.now() + ASSET_ID_TIMESTAMP_MAX_FUTURE_MS);
  return timestamps.length ? Math.max(...timestamps) : 0;
};

const persistedAssetEventTimestamp = (asset = {}) => [
  asset.sourceEventAt,
  asset.completedAt,
  asset.uploadedAt,
  asset.submittedAt,
  asset.attachment?.sourceEventAt,
  asset.attachment?.completedAt,
  asset.attachment?.uploadedAt,
  asset.attachment?.createdAt,
].map(validAssetTimestamp).find(Boolean) || "";

export const canonicalAssetEventIso = (asset = {}) => {
  const createdAt = validAssetTimestamp(asset.createdAt);
  const identityTimestamp = assetIdentityTimestamp(asset);
  const identityLooksLikeLegacyFallback = identityTimestamp
    && createdAt
    && Date.parse(createdAt) - identityTimestamp > LEGACY_ASSET_TIME_REPAIR_THRESHOLD_MS;
  // A persisted createdAt is the canonical event time when it is plausible.
  // Only treat it as a migration fallback when a stable ID timestamp proves it
  // is more than a day newer than the original event.
  if (createdAt && !identityLooksLikeLegacyFallback) return createdAt;
  const persistedEventAt = persistedAssetEventTimestamp(asset);
  if (persistedEventAt) return persistedEventAt;
  if (identityTimestamp) return new Date(identityTimestamp).toISOString();
  return createdAt;
};

export const assetEventTimestamp = (asset = {}) => {
  const value = Date.parse(canonicalAssetEventIso(asset));
  return Number.isFinite(value) ? value : 0;
};

export const normalizeGenerationAsset = (asset) => {
  const kind = ASSET_KINDS.has(asset?.kind) ? asset.kind : "text";
  const hasGenerationEvidence = Boolean(
    String(asset?.generationJobId || "").trim()
    || String(asset?.prompt || "").trim()
    || Number(asset?.elapsedMs) > 0
    || (kind === "text" && String(asset?.sourceNodeId || "").trim()),
  );
  // Older releases defaulted every missing origin to “generated”. Only keep
  // that label when generation evidence exists; media without such evidence
  // is an upload. Unknown text remains unknown instead of fabricating history.
  const origin = asset?.origin === "upload" || asset?.origin === "notebook"
    ? "upload"
    : hasGenerationEvidence
      ? "generated"
      : ["image", "video", "audio"].includes(kind)
        ? "upload"
        : "unknown";
  const attachment = asset?.attachment?.relativePath
    ? {
        relativePath: String(asset.attachment.relativePath),
        name: String(asset.attachment.name || (kind === "audio" ? "生成音频" : kind === "video" ? "生成视频" : "生成图片")),
        mimeType: String(asset.attachment.mimeType || (kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "image/png")),
        size: Math.max(0, finite(asset.attachment.size, 0)),
        ...(asset.attachment.sha256 ? { sha256: String(asset.attachment.sha256) } : {}),
        ...(asset.attachment.objectHash ? { objectHash: String(asset.attachment.objectHash) } : {}),
        ...(asset.attachment.thumbnailRelativePath ? { thumbnailRelativePath: String(asset.attachment.thumbnailRelativePath) } : {}),
        ...(asset.attachment.thumbnailMimeType ? { thumbnailMimeType: String(asset.attachment.thumbnailMimeType) } : {}),
        ...(finite(asset.attachment.width, 0) > 0 ? { width: Math.max(1, finite(asset.attachment.width, 0)) } : {}),
        ...(finite(asset.attachment.height, 0) > 0 ? { height: Math.max(1, finite(asset.attachment.height, 0)) } : {}),
        ...(finite(asset.attachment.durationMs, 0) > 0 ? { durationMs: Math.max(1, finite(asset.attachment.durationMs, 0)) } : {}),
        ...(validAssetTimestamp(asset.attachment.createdAt) ? { createdAt: validAssetTimestamp(asset.attachment.createdAt) } : {}),
        ...(validAssetTimestamp(asset.attachment.uploadedAt) ? { uploadedAt: validAssetTimestamp(asset.attachment.uploadedAt) } : {}),
        ...(validAssetTimestamp(asset.attachment.completedAt) ? { completedAt: validAssetTimestamp(asset.attachment.completedAt) } : {}),
        ...(validAssetTimestamp(asset.attachment.sourceEventAt) ? { sourceEventAt: validAssetTimestamp(asset.attachment.sourceEventAt) } : {}),
      }
    : null;
  if (["image", "video", "audio"].includes(kind) && !attachment) return null;
  const createdAt = canonicalAssetEventIso(asset);
  return {
    id: String(asset.id || `canvas-asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    kind,
    origin,
    text: kind === "text" ? String(asset.text ?? "") : "",
    prompt: String(asset.prompt ?? ""),
    ...(Array.isArray(asset.referenceOrder) && asset.referenceOrder.length
      ? { referenceOrder: asset.referenceOrder.map(String).filter(Boolean).slice(0, 100) }
      : {}),
    elapsedMs: Math.max(0, finite(asset.elapsedMs, 0)),
    createdAt,
    ...(Number.isFinite(Date.parse(String(asset.uploadedAt || ""))) ? { uploadedAt: new Date(asset.uploadedAt).toISOString() } : {}),
    ...(Number.isFinite(Date.parse(String(asset.submittedAt || ""))) ? { submittedAt: new Date(asset.submittedAt).toISOString() } : {}),
    ...(Number.isFinite(Date.parse(String(asset.completedAt || ""))) ? { completedAt: new Date(asset.completedAt).toISOString() } : {}),
    ...(Number.isFinite(Date.parse(String(asset.sourceEventAt || ""))) ? { sourceEventAt: new Date(asset.sourceEventAt).toISOString() } : {}),
    sourceNodeId: String(asset.sourceNodeId ?? ""),
    nodeName: String(asset.nodeName ?? ""),
    source: asset?.source === "conversation" ? "conversation" : asset?.source === "whiteboard" ? "whiteboard" : asset?.source === "notebook" ? "notebook" : asset?.source === "asset-library" ? "asset-library" : "",
    ...(asset.conversationId ? { conversationId: String(asset.conversationId) } : {}),
    ...(asset.messageId ? { messageId: String(asset.messageId) } : {}),
    ...(asset.sourceMessageId ? { sourceMessageId: String(asset.sourceMessageId) } : {}),
    ...(asset.mediaBatchId || asset.mediaBatchDirectory || asset.mediaBatchIndexPath ? {
      mediaBatchId: String(asset.mediaBatchId || ""),
      mediaBatchIndex: Math.max(1, finite(asset.mediaBatchIndex, 1)),
      mediaBatchTotal: Math.max(1, finite(asset.mediaBatchTotal, 1)),
      mediaBatchLabel: String(asset.mediaBatchLabel || ""),
      mediaBatchDirectory: String(asset.mediaBatchDirectory || ""),
      mediaBatchIndexPath: String(asset.mediaBatchIndexPath || ""),
    } : {}),
    ...(asset.whiteboardMediaDirectory ? {
      whiteboardMediaDirectory: String(asset.whiteboardMediaDirectory),
      whiteboardMediaIndexPath: String(asset.whiteboardMediaIndexPath || ""),
    } : {}),
    ...(asset.sourceDocumentId ? { sourceDocumentId: String(asset.sourceDocumentId) } : {}),
    ...(asset.sourceAssetId ? { sourceAssetId: String(asset.sourceAssetId) } : {}),
    ...(asset.sourceWorkspaceKind ? { sourceWorkspaceKind: asset.sourceWorkspaceKind === "notebook" ? "notebook" : "project" } : {}),
    ...(asset.sourceWorkspaceName ? { sourceWorkspaceName: String(asset.sourceWorkspaceName) } : {}),
    ...(asset.sourceWorkspacePath ? { sourceWorkspacePath: String(asset.sourceWorkspacePath) } : {}),
    ...(asset.sourceTitle ? { sourceTitle: String(asset.sourceTitle) } : {}),
    ...(asset.sourceRelativePath ? { sourceRelativePath: String(asset.sourceRelativePath) } : {}),
    ...(asset.catalogSourceType ? { catalogSourceType: String(asset.catalogSourceType) } : {}),
    ...(asset.copiedFromCatalogId ? { copiedFromCatalogId: String(asset.copiedFromCatalogId) } : {}),
    ...(typeof asset.catalogLinked === "boolean" ? { catalogLinked: asset.catalogLinked } : {}),
    ...(typeof asset.readOnlySource === "boolean" ? { readOnlySource: asset.readOnlySource } : {}),
    ...(asset.sourceAvailable === false ? { sourceAvailable: false } : asset.catalogLinked === true ? { sourceAvailable: true } : {}),
    ...(asset.generationJobId ? { generationJobId: String(asset.generationJobId) } : {}),
    ...(normalizeNovelCoverAssetMetadata(asset.novelCover) ? { novelCover: normalizeNovelCoverAssetMetadata(asset.novelCover) } : {}),
    aspectRatio: clamp(finite(asset.aspectRatio, kind === "image" ? 1 : 16 / 9), 0.1, 10),
    ...(attachment ? { attachment } : {}),
  };
};

export const normalizeGenerationAssets = (assets = []) => {
  const normalized = [];
  const seenIds = new Set();
  const uploadedMediaHashes = new Map();
  for (const value of Array.isArray(assets) ? assets : []) {
    const asset = normalizeGenerationAsset(value);
    if (!asset || seenIds.has(asset.id)) continue;
    const uploadedMediaHash = asset.origin === "upload" && ["image", "video", "audio"].includes(asset.kind)
      ? String(asset.attachment?.sha256 || asset.attachment?.objectHash || "").trim().toLowerCase()
      : "";
    if (uploadedMediaHash && uploadedMediaHashes.has(`${asset.kind}:${uploadedMediaHash}`)) {
      const index = uploadedMediaHashes.get(`${asset.kind}:${uploadedMediaHash}`);
      const current = normalized[index];
      const currentTime = Date.parse(current?.createdAt || "") || 0;
      const candidateTime = Date.parse(asset.createdAt || "") || 0;
      if (candidateTime >= currentTime) {
        seenIds.delete(current.id);
        seenIds.add(asset.id);
        normalized[index] = asset;
      }
      continue;
    }
    seenIds.add(asset.id);
    if (uploadedMediaHash) uploadedMediaHashes.set(`${asset.kind}:${uploadedMediaHash}`, normalized.length);
    normalized.push(asset);
  }
  return normalized;
};

export const generationAssetQualifiesForHistory = (asset = {}) => {
  const normalized = normalizeGenerationAsset(asset);
  if (!normalized) return false;
  if (normalized.kind !== "text") return true;
  return Boolean(
    (String(normalized.sourceNodeId || "").trim() || normalized.source === "asset-library")
    && String(normalized.text || "").trim()
    && !isUnusableWhiteboardGenerationText(normalized.text),
  );
};

const mergeStableAssetTimes = (existing, incoming) => {
  const merged = { ...incoming };
  for (const field of ["createdAt", "sourceEventAt", "uploadedAt", "completedAt", "submittedAt"]) {
    const existingValue = validAssetTimestamp(existing?.[field]);
    const incomingValue = validAssetTimestamp(incoming?.[field]);
    if (existingValue) merged[field] = existingValue;
    else if (incomingValue) merged[field] = incomingValue;
  }
  if (existing?.attachment || incoming?.attachment) {
    merged.attachment = { ...(incoming?.attachment || {}) };
    for (const field of ["createdAt", "sourceEventAt", "uploadedAt", "completedAt"]) {
      const existingValue = validAssetTimestamp(existing?.attachment?.[field]);
      const incomingValue = validAssetTimestamp(incoming?.attachment?.[field]);
      if (existingValue) merged.attachment[field] = existingValue;
      else if (incomingValue) merged.attachment[field] = incomingValue;
    }
  }
  return merged;
};

export const appendGenerationAsset = (assets, asset) => {
  const entries = normalizeGenerationAssets(assets);
  const normalizedIncoming = normalizeGenerationAsset(asset);
  const existing = normalizedIncoming ? entries.find((item) => item.id === normalizedIncoming.id) : null;
  const entry = normalizedIncoming ? normalizeGenerationAsset(mergeStableAssetTimes(existing, normalizedIncoming)) : null;
  if (!entry) return entries;
  const contentHash = String(entry.attachment?.sha256 || entry.attachment?.objectHash || "").trim().toLowerCase();
  const deduplicateUploadedMedia = entry.origin === "upload" && ["image", "video", "audio"].includes(entry.kind) && Boolean(contentHash);
  const generatedMediaAlreadyOwnsPath = entry.origin === "upload"
    && ["image", "video", "audio"].includes(entry.kind)
    && Boolean(entry.attachment?.relativePath)
    && entries.some((item) => item.origin === "generated"
      && item.kind === entry.kind
      && item.attachment?.relativePath === entry.attachment.relativePath);
  if (generatedMediaAlreadyOwnsPath) return entries;
  const duplicateUpload = entry.origin === "upload" && ["image", "video", "audio"].includes(entry.kind)
    ? entries.find((item) => item.origin === "upload" && item.kind === entry.kind && (
        (deduplicateUploadedMedia && String(item.attachment?.sha256 || item.attachment?.objectHash || "").trim().toLowerCase() === contentHash)
        || (!entry.generationJobId && Boolean(entry.attachment?.relativePath) && item.attachment?.relativePath === entry.attachment.relativePath)
      ))
    : null;
  if (duplicateUpload && duplicateUpload.id !== entry.id) {
    const currentTime = Date.parse(duplicateUpload.createdAt || "") || 0;
    const candidateTime = Date.parse(entry.createdAt || "") || 0;
    if (candidateTime < currentTime) return entries;
  }
  return [...entries.filter((item) => (
    item.id !== entry.id
    && (!entry.generationJobId
      || item.generationJobId !== entry.generationJobId
      || item.kind !== entry.kind
      || item.attachment?.relativePath !== entry.attachment?.relativePath)
    && !(entry.origin === "generated"
      && item.origin === "upload"
      && item.kind === entry.kind
      && Boolean(entry.attachment?.relativePath)
      && item.attachment?.relativePath === entry.attachment.relativePath)
    && (!entry.attachment?.relativePath || entry.generationJobId || item.attachment?.relativePath !== entry.attachment.relativePath)
    && (!deduplicateUploadedMedia || item.origin !== "upload" || item.kind !== entry.kind || String(item.attachment?.sha256 || item.attachment?.objectHash || "").trim().toLowerCase() !== contentHash)
  )), entry];
};

export const removeGenerationAssets = (assets, assetIds = []) => {
  const removedIds = new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map(String).filter(Boolean));
  return normalizeGenerationAssets(assets).filter((asset) => !removedIds.has(asset.id));
};

const normalizeGenerationRecoveryTombstones = (tombstones = []) => {
  const records = new Map();
  for (const value of Array.isArray(tombstones) ? tombstones : []) {
    const nodeId = String(value?.nodeId || "").trim().slice(0, 200);
    if (!nodeId) continue;
    const generationJobId = String(value?.generationJobId || "").trim().slice(0, 200);
    const deletedAt = String(value?.deletedAt || "").trim().slice(0, 64);
    const key = `${nodeId}\u0000${generationJobId}`;
    const existing = records.get(key);
    if (!existing || Date.parse(deletedAt || 0) >= Date.parse(existing.deletedAt || 0)) {
      records.set(key, { nodeId, generationJobId, deletedAt });
    }
  }
  return [...records.values()]
    .sort((left, right) => Date.parse(left.deletedAt || 0) - Date.parse(right.deletedAt || 0))
    .slice(-5000);
};

export const normalizeCanvas = (canvas = {}) => {
  const nodes = Array.isArray(canvas.nodes)
    ? canvas.nodes.filter((node) => node?.id && ["text", "file"].includes(node.type)).map(normalizeNode)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(canvas.edges)
    ? canvas.edges.map((edge, index) => normalizeEdge(edge, nodeIds, index)).filter(Boolean)
    : [];
  const assets = normalizeGenerationAssets(canvas.assets);
  return {
    nodes,
    edges: acyclicCanvasEdges(edges, nodeIds),
    // Asset history is user-managed and must never disappear merely because a
    // whiteboard crossed an internal count threshold.
    assets,
    generationRecoveryTombstones: normalizeGenerationRecoveryTombstones(canvas.generationRecoveryTombstones),
    viewport: normalizeViewport(canvas.viewport),
    settings: {
      snapToGrid: canvas.settings?.snapToGrid !== false,
      gridSize: clamp(finite(canvas.settings?.gridSize, CANVAS_GRID_SIZE), 8, 80),
    },
  };
};

export const addCanvasGenerationRecoveryTombstone = (canvas, {
  nodeId = "",
  generationJobId = "",
  deletedAt = new Date().toISOString(),
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  const record = normalizeGenerationRecoveryTombstones([{ nodeId, generationJobId, deletedAt }])[0];
  if (!record?.generationJobId) return normalized;
  normalized.generationRecoveryTombstones = normalizeGenerationRecoveryTombstones([
    ...normalized.generationRecoveryTombstones,
    record,
  ]);
  return normalized;
};

export const canvasGenerationRecoveryTargetDeleted = (canvas, {
  nodeId = "",
  generationJobId = "",
  generationCreatedAt = "",
} = {}) => {
  const targetNodeId = String(nodeId || "").trim();
  const targetJobId = String(generationJobId || "").trim();
  const createdAt = Date.parse(generationCreatedAt || 0);
  if (!targetNodeId) return false;
  return normalizeCanvas(canvas).generationRecoveryTombstones.some((record) => {
    if (record.nodeId !== targetNodeId) return false;
    if (record.generationJobId && targetJobId && record.generationJobId !== targetJobId) return false;
    const deletedAt = Date.parse(record.deletedAt || 0);
    return !Number.isFinite(createdAt) || !Number.isFinite(deletedAt) || deletedAt >= createdAt;
  });
};

export const canonicalCanvas = (canvas = {}) => {
  if (!canvas || typeof canvas !== "object") return normalizeCanvas(canvas);
  const cached = canonicalCanvasCache.get(canvas);
  if (cached) return cached;
  const normalized = normalizeCanvas(canvas);
  canonicalCanvasCache.set(canvas, normalized);
  canonicalCanvasCache.set(normalized, normalized);
  return normalized;
};

const GENERATED_NODE_NAME_BASES = Object.freeze({
  text: "文本节点",
  image: "图片节点",
  audio: "音频节点",
  video: "视频节点",
});

const generatedNodeNameKind = (node) => {
  if (node?.kind === "generated") return "text";
  if (!node?.generation) return "";
  return ["image", "audio", "video"].includes(node.kind) ? node.kind : "text";
};

const CANVAS_DUPLICATE_NAME_PATTERN = /^(.*?)-副本\s*(\d+)?$/u;

const canvasDuplicateNameRoot = (value = "") => {
  const name = String(value || "").trim();
  const match = name.match(CANVAS_DUPLICATE_NAME_PATTERN);
  return String(match?.[1] || name).trim();
};

const nextCanvasDuplicateNameFromNames = (names, sourceName = "") => {
  const root = canvasDuplicateNameRoot(sourceName);
  if (!root) return "";
  const usedNames = new Set();
  const usedOrdinals = new Set();
  for (const value of names) {
    const name = String(value || "").trim();
    if (!name) continue;
    usedNames.add(name);
    const match = name.match(CANVAS_DUPLICATE_NAME_PATTERN);
    if (String(match?.[1] || "").trim() !== root) continue;
    usedOrdinals.add(Math.max(1, Number(match?.[2]) || 1));
  }
  let ordinal = 1;
  while (usedOrdinals.has(ordinal) || usedNames.has(`${root}-副本${ordinal}`)) ordinal += 1;
  return `${root}-副本${ordinal}`;
};

const nextCanvasDuplicateName = (canvas, sourceName = "") => nextCanvasDuplicateNameFromNames(
  normalizeCanvas(canvas).nodes.map((node) => node.name),
  sourceName,
);

const normalizedGeneratedNodeName = (name, kind) => {
  const base = GENERATED_NODE_NAME_BASES[kind];
  const match = String(name || "").trim().match(new RegExp(`^${base}\\s*(\\d+)(?:-副本\\s*(\\d+))?$`, "u"));
  if (!match) return null;
  const primary = Math.max(1, Number(match[1]) || 1);
  const duplicate = match[2] ? Math.max(1, Number(match[2]) || 1) : 0;
  return {
    name: `${base} ${primary}${duplicate ? `-副本${duplicate}` : ""}`,
    primary,
  };
};

export const ensureGeneratedCanvasNodeNames = (canvas = {}) => {
  const normalized = normalizeCanvas(canvas);
  const counters = Object.fromEntries(Object.keys(GENERATED_NODE_NAME_BASES).map((kind) => [kind, 0]));
  const generatedNodeIds = new Set(normalized.nodes.filter((node) => generatedNodeNameKind(node)).map((node) => node.id));
  const usedNames = new Set(normalized.nodes
    .filter((node) => !generatedNodeIds.has(node.id))
    .map((node) => String(node.name || "").trim())
    .filter(Boolean));
  for (const node of normalized.nodes) {
    const kind = generatedNodeNameKind(node);
    if (!kind) continue;
    const current = normalizedGeneratedNodeName(node.name, kind);
    if (current) counters[kind] = Math.max(counters[kind], current.primary);
  }
  for (const node of normalized.nodes) {
    const kind = generatedNodeNameKind(node);
    if (!kind) continue;
    const base = GENERATED_NODE_NAME_BASES[kind];
    const current = normalizedGeneratedNodeName(node.name, kind);
    if (current && !usedNames.has(current.name)) {
      node.name = current.name;
      usedNames.add(current.name);
      continue;
    }
    if (current) {
      node.name = nextCanvasDuplicateNameFromNames(usedNames, current.name);
      usedNames.add(node.name);
      continue;
    }
    let name = "";
    do name = `${base} ${++counters[kind]}`;
    while (usedNames.has(name));
    node.name = name;
    usedNames.add(name);
  }
  const nodeNameById = new Map(normalized.nodes.map((node) => [node.id, node.name || ""]));
  normalized.assets = normalized.assets.map((asset) => {
    const nodeName = nodeNameById.get(asset.sourceNodeId) || asset.nodeName;
    return nodeName ? { ...asset, nodeName } : asset;
  });
  return normalized;
};

export const appendCanvasAsset = (canvas, asset) => {
  const normalized = normalizeCanvas(canvas);
  normalized.assets = appendGenerationAsset(normalized.assets, asset);
  return normalized;
};

export const snapshotCanvasNodeVersion = (canvas, nodeId, {
  id = "",
  createdAt = new Date().toISOString(),
  source = "whiteboard",
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  const node = normalized.nodes.find((item) => item.id === String(nodeId));
  if (!node) return normalized;
  const mediaKind = MEDIA_NODE_KINDS.has(node.kind);
  const text = mediaKind ? "" : String(node.text || "");
  const relativePath = mediaKind ? String(node.file || "").trim() : "";
  if ((!mediaKind && (!text.trim() || isUnusableWhiteboardGenerationText(text))) || (mediaKind && !relativePath)) return normalized;

  const alreadyCaptured = normalized.assets.some((asset) => (
    asset.sourceNodeId === node.id
    && asset.kind === (mediaKind ? node.kind : "text")
    && (mediaKind
      ? asset.attachment?.relativePath === relativePath
      : String(asset.text || "") === text)
  ));
  if (alreadyCaptured) return normalized;

  return appendCanvasAsset(normalized, {
    id: id || `canvas-version-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: mediaKind ? node.kind : "text",
    origin: node.generation ? "generated" : "upload",
    text,
    prompt: String(node.generation?.prompt || ""),
    elapsedMs: Math.max(0, finite(node.generation?.elapsedMs, 0)),
    createdAt,
    sourceNodeId: node.id,
    nodeName: String(node.name || ""),
    source,
    aspectRatio: node.aspectRatio,
    ...(mediaKind ? {
      attachment: {
        relativePath,
        name: String(node.name || relativePath.split(/[\\/]/).pop() || "历史媒体"),
        mimeType: String(node.mimeType || (node.kind === "video" ? "video/mp4" : node.kind === "audio" ? "audio/mpeg" : "image/png")),
        ...(Number(node.durationMs) > 0 ? { durationMs: Number(node.durationMs) } : {}),
      },
    } : {}),
  });
};

export const removeCanvasAssets = (canvas, assetIds = []) => {
  const normalized = normalizeCanvas(canvas);
  const removedIds = new Set((Array.isArray(assetIds) ? assetIds : [assetIds]).map(String).filter(Boolean));
  if (!removedIds.size) return normalized;
  normalized.assets = normalized.assets.filter((asset) => !removedIds.has(asset.id));
  return normalized;
};

export const removeCanvasAsset = (canvas, assetId) => removeCanvasAssets(canvas, [assetId]);

export const canvasNodeGenerationHistory = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const matching = normalized.assets.filter((asset) => (
    asset.sourceNodeId === String(nodeId)
    && generationAssetQualifiesForHistory(asset)
  ));
  return matching.map((asset, index) => ({ ...asset, version: index + 1 }));
};

export const canvasGenerationAssetContent = (asset) => {
  const normalized = normalizeGenerationAsset(asset);
  if (!normalized) return null;
  if (normalized.kind === "text") return {
    kind: "generated",
    ...(normalized.nodeName ? { name: normalized.nodeName } : {}),
    text: normalized.text,
    prompt: normalized.prompt,
    ...(normalized.elapsedMs > 0 ? { elapsedMs: normalized.elapsedMs } : {}),
  };
  return {
    kind: normalized.kind,
    ...(normalized.nodeName ? { name: normalized.nodeName } : {}),
    attachment: { ...normalized.attachment },
    aspectRatio: normalized.aspectRatio,
    prompt: normalized.prompt,
    ...(normalized.whiteboardMediaDirectory ? {
      whiteboardMediaDirectory: normalized.whiteboardMediaDirectory,
      whiteboardMediaIndexPath: normalized.whiteboardMediaIndexPath || "",
    } : {}),
    ...(normalized.elapsedMs > 0 ? { elapsedMs: normalized.elapsedMs } : {}),
  };
};

export const canvasGenerationMetadataForAsset = (asset) => {
  const normalized = normalizeGenerationAsset(asset);
  if (!normalized || normalized.origin !== "generated" || !normalized.prompt.trim()) return null;
  return normalizeGeneration({
    channel: normalized.kind,
    prompt: normalized.prompt,
  });
};

export const canvasNodeIdsInRect = (canvas, rect = {}) => {
  const normalized = normalizeCanvas(canvas);
  const left = Math.min(finite(rect.left, 0), finite(rect.right, 0));
  const right = Math.max(finite(rect.left, 0), finite(rect.right, 0));
  const top = Math.min(finite(rect.top, 0), finite(rect.bottom, 0));
  const bottom = Math.max(finite(rect.top, 0), finite(rect.bottom, 0));
  return normalized.nodes
    .filter((node) => node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top)
    .map((node) => node.id);
};

const segmentIntersectsRect = (start, end, rect) => {
  const inside = (point) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  if (inside(start) || inside(end)) return true;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a, b, c, d) => {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    return ((abC === 0 || abD === 0 || Math.sign(abC) !== Math.sign(abD))
      && (cdA === 0 || cdB === 0 || Math.sign(cdA) !== Math.sign(cdB)));
  };
  const topLeft = { x: rect.left, y: rect.top };
  const topRight = { x: rect.right, y: rect.top };
  const bottomRight = { x: rect.right, y: rect.bottom };
  const bottomLeft = { x: rect.left, y: rect.bottom };
  return [[topLeft, topRight], [topRight, bottomRight], [bottomRight, bottomLeft], [bottomLeft, topLeft]]
    .some(([a, b]) => intersects(start, end, a, b));
};

/** Returns every connector crossed by a marquee rectangle. */
export const canvasEdgeIdsInRect = (canvas, rect = {}) => {
  const normalized = normalizeCanvas(canvas);
  const bounds = {
    left: Math.min(finite(rect.left, 0), finite(rect.right, 0)),
    right: Math.max(finite(rect.left, 0), finite(rect.right, 0)),
    top: Math.min(finite(rect.top, 0), finite(rect.bottom, 0)),
    bottom: Math.max(finite(rect.top, 0), finite(rect.bottom, 0)),
  };
  const nodes = new Map(normalized.nodes.map((node) => [node.id, node]));
  return normalized.edges.filter((edge) => {
    const from = nodes.get(edge.fromNode);
    const to = nodes.get(edge.toNode);
    if (!from || !to) return false;
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    return segmentIntersectsRect(start, end, bounds);
  }).map((edge) => edge.id);
};

export const canvasSelectionBounds = (canvas, nodeIds = [], padding = 18) => {
  const selected = new Set((nodeIds ?? []).map(String));
  const nodes = normalizeCanvas(canvas).nodes.filter((node) => selected.has(node.id));
  if (!nodes.length) return null;
  const inset = Math.max(0, finite(padding, 18));
  const left = Math.min(...nodes.map((node) => node.x)) - inset;
  const top = Math.min(...nodes.map((node) => node.y)) - inset;
  const right = Math.max(...nodes.map((node) => node.x + node.width)) + inset;
  const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + inset;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

export const createCanvasTextNode = ({ id, name = "", text = "", x = 40, y = 40, width = 260, height = 160, kind = "text", color = "default", reference = null, generation = null, url = "", webSnapshot = null } = {}) => ({
  id: String(id || `canvas-node-${Date.now()}`),
  type: "text",
  kind: NODE_KINDS.has(kind) && !MEDIA_NODE_KINDS.has(kind) ? kind : "text",
  name: String(name),
  text: String(text),
  x: finite(x, 40),
  y: finite(y, 40),
  width: Math.max(180, finite(width, 260)),
  height: Math.max(100, finite(height, 160)),
  color: String(color || "default"),
  ...(kind === "web" ? {
    url: String(url),
    ...(normalizeWebSnapshot(webSnapshot) ? { webSnapshot: normalizeWebSnapshot(webSnapshot) } : {}),
  } : {}),
  ...(normalizeReference(reference) ? { reference: normalizeReference(reference) } : {}),
  ...(normalizeGeneration(generation) ? { generation: normalizeGeneration(generation) } : {}),
});

export const createCanvasImageNode = ({ id, file, name = "图片", mimeType = "image/png", aspectRatio = 16 / 9, durationMs = 0, x = 40, y = 40, width = 320, color = "default", generation = null } = {}) => {
  const ratio = clamp(finite(aspectRatio, 16 / 9), 0.1, 10);
  const normalizedWidth = Math.max(180, finite(width, 320));
  const kind = String(mimeType).startsWith("audio/") ? "audio" : String(mimeType).startsWith("video/") ? "video" : "image";
  return {
    id: String(id || `canvas-image-${Date.now()}`),
    type: "file",
    kind,
    text: "",
    file: String(file ?? ""),
    name: String(name),
    mimeType: String(mimeType),
    aspectRatio: ratio,
    ...(finite(durationMs, 0) > 0 ? { durationMs: Math.max(1, finite(durationMs, 0)) } : {}),
    x: finite(x, 40),
    y: finite(y, 40),
    width: normalizedWidth,
    height: Math.max(100, normalizedWidth / ratio),
    color: String(color || "default"),
    ...(normalizeGeneration(generation) ? { generation: normalizeGeneration(generation) } : {}),
  };
};

export const addCanvasTextNode = (canvas, options = {}) => {
  const normalized = normalizeCanvas(canvas);
  normalized.nodes.push(createCanvasTextNode(options));
  return normalized;
};

export const addCanvasImageNode = (canvas, options = {}) => {
  const normalized = normalizeCanvas(canvas);
  normalized.nodes.push(createCanvasImageNode(options));
  return normalized;
};

export const copyCanvasNode = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const source = normalized.nodes.find((node) => node.id === nodeId);
  if (!source) return null;
  return {
    node: {
      ...source,
      ...(source.reference ? { reference: { ...source.reference } } : {}),
      ...(source.generation ? { generation: { ...source.generation } } : {}),
    },
    edges: normalized.edges
      .filter((edge) => edge.fromNode === nodeId || edge.toNode === nodeId)
      .map((edge) => ({ ...edge })),
  };
};

export const pasteCanvasNode = (canvas, record, {
  id,
  x,
  y,
  includeEdges = false,
  maxTextWidth = Number.POSITIVE_INFINITY,
  maxTextHeight = Number.POSITIVE_INFINITY,
  maxImageWidth = Number.POSITIVE_INFINITY,
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  const source = record?.node?.id
    ? normalizeCanvas({ nodes: [record.node] }).nodes[0]
    : null;
  if (!source) return { canvas: normalized, nodeId: "", copiedEdges: 0 };
  const duplicateId = String(id || `canvas-node-copy-${Date.now()}`);
  const duplicateName = nextCanvasDuplicateName(normalized, source.name);
  const limited = (value, maximum) => Number.isFinite(maximum) ? Math.min(value, maximum) : value;
  let next = MEDIA_NODE_KINDS.has(source.kind)
    ? addCanvasImageNode(normalized, {
        id: duplicateId,
        file: source.file,
        name: duplicateName || source.name,
        mimeType: source.mimeType,
        aspectRatio: source.aspectRatio,
        durationMs: source.durationMs,
        color: source.color,
        generation: source.generation,
        width: limited(source.width, maxImageWidth),
        x: finite(x, source.x + 40),
        y: finite(y, source.y + 40),
      })
    : addCanvasTextNode(normalized, {
        id: duplicateId,
        name: duplicateName || source.name,
        text: source.text,
        kind: source.kind,
        color: source.color,
        reference: source.reference,
        generation: source.generation,
        url: source.url,
        width: limited(source.width, maxTextWidth),
        height: limited(source.height, maxTextHeight),
        x: finite(x, source.x + 40),
        y: finite(y, source.y + 40),
      });
  let copiedEdges = 0;
  for (const edge of includeEdges ? record.edges ?? [] : []) {
    const before = next.edges.length;
    next = addCanvasEdge(next, {
      fromNode: edge.fromNode === source.id ? duplicateId : edge.fromNode,
      toNode: edge.toNode === source.id ? duplicateId : edge.toNode,
      order: edge.order,
      fromSide: edge.fromSide,
      toSide: edge.toSide,
      label: edge.label,
      color: edge.color,
    });
    if (next.edges.length > before) copiedEdges += 1;
  }
  return { canvas: next, nodeId: duplicateId, copiedEdges };
};

export const duplicateCanvasNode = (canvas, nodeId, {
  id,
  x,
  y,
  maxTextWidth = 280,
  maxTextHeight = 180,
  maxImageWidth = 320,
  inheritEdges = "upstream",
} = {}) => {
  const record = copyCanvasNode(canvas, nodeId);
  if (record && inheritEdges === "upstream") record.edges = record.edges.filter((edge) => edge.toNode === nodeId);
  if (record && inheritEdges === "downstream") record.edges = record.edges.filter((edge) => edge.fromNode === nodeId);
  return pasteCanvasNode(canvas, record, { id, x, y, includeEdges: true, maxTextWidth, maxTextHeight, maxImageWidth });
};

const canvasSpacing = (canvas, value = 40) => {
  const normalizedValue = Math.max(0, finite(value, 40));
  if (canvas.settings.snapToGrid === false) return normalizedValue;
  const gridSize = clamp(finite(canvas.settings.gridSize, CANVAS_GRID_SIZE), 8, 80);
  return Math.max(gridSize, Math.ceil(normalizedValue / gridSize) * gridSize);
};

const snapCanvasValueUp = (value, canvas) => {
  if (canvas.settings.snapToGrid === false) return finite(value, 0);
  const gridSize = clamp(finite(canvas.settings.gridSize, CANVAS_GRID_SIZE), 8, 80);
  return Math.ceil(finite(value, 0) / gridSize) * gridSize;
};

const horizontalOverlapRatio = (left, right) => {
  const overlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  return overlap / Math.max(1, Math.min(left.width, right.width));
};

export const duplicateCanvasNodeBelow = (canvas, nodeId, {
  id,
  gap = 40,
  inheritEdges = "upstream",
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  const source = normalized.nodes.find((node) => node.id === nodeId);
  if (!source) return { canvas: normalized, nodeId: "", copiedEdges: 0, movedNodeIds: [] };

  const spacing = canvasSpacing(normalized, gap);
  const duplicateRect = {
    x: source.x,
    y: snapCanvasValueUp(source.y + source.height + spacing, normalized),
    width: source.width,
    height: source.height,
  };
  const blockers = [duplicateRect];
  const movedNodes = new Map();

  for (const node of normalized.nodes
    .filter((item) => item.id !== source.id && item.y + item.height > duplicateRect.y - spacing)
    .sort((left, right) => left.y - right.y || left.x - right.x)) {
    let requiredY = node.y;
    for (const blocker of blockers) {
      if (horizontalOverlapRatio(node, blocker) <= 0.5) continue;
      if (node.y >= blocker.y + blocker.height + spacing) continue;
      if (node.y + node.height <= blocker.y - spacing) continue;
      requiredY = Math.max(requiredY, blocker.y + blocker.height + spacing);
    }
    if (requiredY <= node.y) continue;

    const moved = {
      ...node,
      x: snapCanvasValue(source.x + (source.width - node.width) / 2, normalized),
      y: snapCanvasValueUp(requiredY, normalized),
    };
    movedNodes.set(node.id, moved);
    blockers.push(moved);
  }

  if (movedNodes.size) {
    normalized.nodes = normalized.nodes.map((node) => movedNodes.get(node.id) ?? node);
  }
  const duplicated = duplicateCanvasNode(normalized, nodeId, {
    id,
    x: duplicateRect.x,
    y: duplicateRect.y,
    maxTextWidth: source.width,
    maxTextHeight: source.height,
    maxImageWidth: source.width,
    inheritEdges,
  });
  return { ...duplicated, movedNodeIds: [...movedNodes.keys()] };
};

export const snapCanvasValue = (value, canvasOrSettings = {}) => {
  const settings = canvasOrSettings.settings ?? canvasOrSettings;
  if (settings.snapToGrid === false) return finite(value, 0);
  const size = clamp(finite(settings.gridSize, CANVAS_GRID_SIZE), 8, 80);
  return Math.round(finite(value, 0) / size) * size;
};

const patchCanvasNode = (node, patch = {}) => {
  const next = {
    ...node,
    ...(Object.hasOwn(patch, "text") ? { text: String(patch.text ?? "") } : {}),
    ...(Object.hasOwn(patch, "name") ? { name: String(patch.name ?? "") } : {}),
    ...(Object.hasOwn(patch, "x") ? { x: finite(patch.x, node.x) } : {}),
    ...(Object.hasOwn(patch, "y") ? { y: finite(patch.y, node.y) } : {}),
    ...(Object.hasOwn(patch, "width") ? { width: Math.max(180, finite(patch.width, node.width)) } : {}),
    ...(Object.hasOwn(patch, "height") ? { height: Math.max(100, finite(patch.height, node.height)) } : {}),
    ...(Object.hasOwn(patch, "color") ? { color: String(patch.color || "default") } : {}),
    ...(Object.hasOwn(patch, "kind") && NODE_KINDS.has(patch.kind) ? { kind: patch.kind } : {}),
    ...(Object.hasOwn(patch, "url") ? { url: String(patch.url ?? "") } : {}),
    ...(Object.hasOwn(patch, "file") && MEDIA_NODE_KINDS.has(node.kind) ? { file: String(patch.file ?? "") } : {}),
    ...(Object.hasOwn(patch, "mimeType") && MEDIA_NODE_KINDS.has(node.kind) ? { mimeType: String(patch.mimeType ?? node.mimeType) } : {}),
    ...(Object.hasOwn(patch, "aspectRatio") && MEDIA_NODE_KINDS.has(node.kind) ? { aspectRatio: clamp(finite(patch.aspectRatio, node.aspectRatio), 0.1, 10) } : {}),
  };
  if (Object.hasOwn(patch, "webSnapshot")) {
    const snapshot = normalizeWebSnapshot(patch.webSnapshot);
    if (snapshot) next.webSnapshot = snapshot;
    else delete next.webSnapshot;
  }
  if (MEDIA_NODE_KINDS.has(node.kind) && (Object.hasOwn(patch, "width") || Object.hasOwn(patch, "height"))) {
    const ratio = clamp(finite(next.aspectRatio, 16 / 9), 0.1, 10);
    if (Object.hasOwn(patch, "width")) next.height = Math.max(100, next.width / ratio);
    else next.width = Math.max(180, next.height * ratio);
  } else if (MEDIA_NODE_KINDS.has(node.kind) && Object.hasOwn(patch, "aspectRatio")) {
    next.height = Math.max(100, next.width / next.aspectRatio);
  }
  if (Object.hasOwn(patch, "reference")) {
    const reference = normalizeReference(patch.reference);
    if (reference) next.reference = reference;
    else delete next.reference;
  }
  return next;
};

export const updateCanvasNodes = (canvas, updates = []) => {
  const normalized = normalizeCanvas(canvas);
  const patches = new Map((Array.isArray(updates) ? updates : []).map(({ id, ...patch }) => [String(id), patch]));
  normalized.nodes = normalized.nodes.map((node) => patches.has(node.id) ? patchCanvasNode(node, patches.get(node.id)) : node);
  return normalized;
};

export const updateCanvasNode = (canvas, nodeId, patch = {}) => updateCanvasNodes(canvas, [{ ...patch, id: nodeId }]);

export const containedCanvasNodeIds = (canvas, groupId) => {
  const normalized = normalizeCanvas(canvas);
  const group = normalized.nodes.find((node) => node.id === groupId && node.kind === "group");
  if (!group) return [];
  const right = group.x + group.width;
  const bottom = group.y + group.height;
  return normalized.nodes
    .filter((node) => node.id !== group.id && node.kind !== "group")
    .filter((node) => {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return centerX >= group.x && centerX <= right && centerY >= group.y && centerY <= bottom;
    })
    .map((node) => node.id);
};

export const updateCanvasTextNode = updateCanvasNode;

export const replaceCanvasNodeContent = (canvas, nodeId, content = {}) => {
  const normalized = normalizeCanvas(canvas);
  const generation = normalizeGeneration({
    channel: content.kind === "generated" ? "text" : content.kind,
    prompt: content.prompt,
    elapsedMs: content.elapsedMs,
    jobId: content.generationJobId,
    createdAt: content.generationCreatedAt,
    referenceOrder: content.referenceOrder,
    profile: content.generationProfile,
  });
  normalized.nodes = normalized.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    if (["image", "video", "audio"].includes(content.kind) && content.attachment?.relativePath) {
      const ratio = clamp(finite(content.aspectRatio, 16 / 9), 0.1, 10);
      return {
        id: node.id,
        type: "file",
        kind: content.kind,
        text: "",
        file: String(content.attachment.relativePath),
        name: String(content.name || node.name || content.attachment.name || (content.kind === "audio" ? "生成音频" : content.kind === "video" ? "生成视频" : "生成图片")),
        mimeType: String(content.attachment.mimeType || (content.kind === "audio" ? "audio/mpeg" : content.kind === "video" ? "video/mp4" : "image/png")),
        aspectRatio: ratio,
        ...(content.attachment.thumbnailRelativePath ? { thumbnailRelativePath: String(content.attachment.thumbnailRelativePath) } : {}),
        ...(content.attachment.thumbnailMimeType ? { thumbnailMimeType: String(content.attachment.thumbnailMimeType) } : {}),
        ...(finite(content.attachment.durationMs, 0) > 0 ? { durationMs: Math.max(1, finite(content.attachment.durationMs, 0)) } : {}),
        ...(content.mediaBatchDirectory ? { mediaBatchDirectory: String(content.mediaBatchDirectory) } : {}),
        ...(content.mediaBatchIndexPath ? { mediaBatchIndexPath: String(content.mediaBatchIndexPath) } : {}),
        ...(content.whiteboardMediaDirectory ? { whiteboardMediaDirectory: String(content.whiteboardMediaDirectory) } : {}),
        ...(content.whiteboardMediaIndexPath ? { whiteboardMediaIndexPath: String(content.whiteboardMediaIndexPath) } : {}),
        x: node.x,
        y: node.y,
        width: node.width,
        height: Math.max(100, node.width / ratio),
        color: node.color,
        ...(generation ? { generation } : {}),
      };
    }
    return {
      id: node.id,
      type: "text",
      kind: content.kind === "generated" ? "generated" : "text",
      name: String(content.name || node.name || ""),
      text: String(content.text ?? ""),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      color: node.color,
      ...(generation ? { generation } : {}),
    };
  });
  return normalizeCanvas(normalized);
};

const normalizedGenerationAttachmentPath = (value = "") => String(value || "")
  .replaceAll("\\", "/")
  .replace(/^\.\//, "")
  .toLocaleLowerCase();

export const canvasNodeDisplaysGenerationContent = (node, content = {}) => {
  const generationJobId = String(content.generationJobId || "");
  if (!node || !generationJobId || String(node.generation?.jobId || "") !== generationJobId) return false;
  if (["image", "video", "audio"].includes(content.kind)) {
    const expectedPath = normalizedGenerationAttachmentPath(content.attachment?.relativePath);
    return Boolean(expectedPath) && normalizedGenerationAttachmentPath(node.file) === expectedPath;
  }
  return node.type === "text" && String(node.text || "") === String(content.text || "");
};

export const replaceCanvasNodeWithGenerationAsset = (canvas, nodeId, asset) => {
  const normalized = normalizeGenerationAsset(asset);
  if (!normalized) return normalizeCanvas(canvas);
  const content = normalized.kind === "text"
    ? {
        kind: "generated",
        name: normalized.nodeName,
        text: normalized.text,
        prompt: normalized.prompt,
        elapsedMs: normalized.elapsedMs,
        generationJobId: normalized.generationJobId || "",
        generationCreatedAt: normalized.createdAt || "",
        ...(Array.isArray(normalized.referenceOrder) ? { referenceOrder: normalized.referenceOrder } : {}),
      }
    : {
        kind: normalized.kind,
        name: normalized.nodeName,
        attachment: { ...normalized.attachment },
        aspectRatio: normalized.aspectRatio,
        prompt: normalized.prompt,
        elapsedMs: normalized.elapsedMs,
        generationJobId: normalized.generationJobId || "",
        generationCreatedAt: normalized.createdAt || "",
        ...(Array.isArray(normalized.referenceOrder) ? { referenceOrder: normalized.referenceOrder } : {}),
        ...(normalized.whiteboardMediaDirectory ? {
          whiteboardMediaDirectory: normalized.whiteboardMediaDirectory,
          whiteboardMediaIndexPath: normalized.whiteboardMediaIndexPath || "",
        } : {}),
      };
  return replaceCanvasNodeContent(canvas, nodeId, content);
};

export const updateCanvasViewport = (canvas, patch = {}) => {
  // Viewport changes are the hottest whiteboard mutation (wheel zoom and
  // panning). Re-normalizing every node, edge and asset for every wheel tick
  // made the cost proportional to board size. Reuse the immutable canonical
  // projection and copy only the top-level object plus viewport instead.
  const normalized = canonicalCanvas(canvas);
  return {
    ...normalized,
    viewport: normalizeViewport({ ...normalized.viewport, ...patch }),
  };
};

export const setCanvasSnap = (canvas, enabled) => {
  const normalized = normalizeCanvas(canvas);
  normalized.settings.snapToGrid = Boolean(enabled);
  return normalized;
};

export const addCanvasEdge = (canvas, { id, fromNode, toNode, order, fromSide = "right", toSide = "left", label = "", color = "default" } = {}) => {
  const normalized = normalizeCanvas(canvas);
  if (!fromNode || !toNode || fromNode === toNode) return normalized;
  if (!normalized.nodes.some((node) => node.id === fromNode) || !normalized.nodes.some((node) => node.id === toNode)) return normalized;
  if (normalized.edges.some((edge) => edge.fromNode === fromNode && edge.toNode === toNode)) return normalized;
  const outgoing = new Map(normalized.nodes.map((node) => [node.id, []]));
  normalized.edges.forEach((edge) => outgoing.get(edge.fromNode)?.push(edge.toNode));
  const pending = [toNode];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === fromNode) return normalized;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  const incomingOrders = normalized.edges
    .filter((edge) => edge.toNode === String(toNode))
    .map((edge) => Number(edge.order))
    .filter(Number.isFinite);
  const nextOrder = Number.isFinite(Number(order))
    ? Math.max(0, Number(order))
    : (incomingOrders.length ? Math.max(...incomingOrders) + 1 : 0);
  normalized.edges.push({
    id: String(id || `canvas-edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    fromNode: String(fromNode),
    toNode: String(toNode),
    order: nextOrder,
    fromSide: SIDE_VALUES.has(fromSide) ? fromSide : "right",
    toSide: SIDE_VALUES.has(toSide) ? toSide : "left",
    label: String(label),
    color: String(color || "default"),
  });
  return normalized;
};

const whiteboardMediaReferenceKey = (node) => {
  if (!["image", "video", "audio"].includes(node?.kind) || !node.file) return "";
  return String(node.file).replaceAll("\\", "/").toLowerCase();
};

export const canvasIncomingReferenceUsage = (canvas, nodeId, { includeTargetMedia = false } = {}) => {
  const normalized = normalizeCanvas(canvas);
  const target = normalized.nodes.find((node) => node.id === String(nodeId)) ?? null;
  const upstreamIds = [...new Set(normalized.edges
    .filter((edge) => edge.toNode === String(nodeId))
    .map((edge) => edge.fromNode))];
  const upstream = upstreamIds
    .map((id) => normalized.nodes.find((node) => node.id === id))
    .filter(Boolean);
  const upstreamMediaKeys = new Set(upstream.map(whiteboardMediaReferenceKey).filter(Boolean));
  const targetMediaKey = includeTargetMedia ? whiteboardMediaReferenceKey(target) : "";
  const mediaKeys = new Set(upstreamMediaKeys);
  if (targetMediaKey) mediaKeys.add(targetMediaKey);
  return {
    target,
    upstream,
    upstreamCount: upstream.length,
    upstreamMediaReferenceCount: upstreamMediaKeys.size,
    targetMediaReferenceCount: targetMediaKey && !upstreamMediaKeys.has(targetMediaKey) ? 1 : 0,
    mediaReferenceCount: mediaKeys.size,
  };
};

export const whiteboardReferenceCapacityViolation = (canvas, nodeId, {
  maxUpstreamReferences,
  maxMediaReferences,
  includeTargetMedia = false,
} = {}) => {
  const usage = canvasIncomingReferenceUsage(canvas, nodeId, { includeTargetMedia });
  const upstreamLimit = Math.max(0, Number(maxUpstreamReferences) || 0);
  const mediaLimit = Math.max(0, Number(maxMediaReferences) || 0);
  if (usage.upstreamCount > upstreamLimit) {
    return { kind: "upstream", count: usage.upstreamCount, limit: upstreamLimit, usage };
  }
  if (usage.mediaReferenceCount > mediaLimit) {
    return { kind: "media", count: usage.mediaReferenceCount, limit: mediaLimit, usage };
  }
  return null;
};

export const addConnectedCanvasTextNode = (canvas, {
  id,
  fromNode,
  text = "",
  x = 40,
  y = 40,
  width = 260,
  height = 160,
  kind = "text",
  color = "default",
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  if (!fromNode || !normalized.nodes.some((node) => node.id === fromNode)) {
    return { canvas: normalized, nodeId: "" };
  }
  const nodeId = String(id || `canvas-node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const withNode = addCanvasTextNode(normalized, { id: nodeId, text, x, y, width, height, kind, color });
  return {
    canvas: addCanvasEdge(withNode, { fromNode, toNode: nodeId }),
    nodeId,
  };
};

const canvasRectsOverlap = (left, right, padding = 20) => !(
  left.x + left.width + padding <= right.x
  || right.x + right.width + padding <= left.x
  || left.y + left.height + padding <= right.y
  || right.y + right.height + padding <= left.y
);

export const addCanvasSplitTextNodes = (canvas, nodeId, parts = [], {
  ids = [],
  horizontalGap = 100,
  verticalGap = 40,
  maximumRows = 5,
} = {}) => {
  let normalized = normalizeCanvas(canvas);
  const source = normalized.nodes.find((node) => node.id === nodeId);
  const content = parts.map((part) => String(part?.text ?? part ?? "").trim()).filter(Boolean);
  if (!source || ["image", "video", "audio", "web", "group", "skill"].includes(source.kind) || content.length < 2) {
    return { canvas: normalized, nodeIds: [] };
  }

  const width = clamp(source.width, 260, 420);
  const height = clamp(source.height, 180, 280);
  const rowCount = clamp(Math.ceil(Math.sqrt(content.length * 1.5)), 2, maximumRows);
  const occupied = [...normalized.nodes];
  const nodeIds = [];
  let slotIndex = 0;

  for (let index = 0; index < content.length; index += 1) {
    let candidate;
    do {
      const column = Math.floor(slotIndex / rowCount);
      const row = slotIndex % rowCount;
      candidate = {
        x: snapCanvasValue(source.x + source.width + horizontalGap + column * (width + horizontalGap), normalized),
        y: snapCanvasValue(source.y + row * (height + verticalGap), normalized),
        width,
        height,
      };
      slotIndex += 1;
    } while (occupied.some((node) => canvasRectsOverlap(candidate, node)) && slotIndex < 5000);

    const childId = String(ids[index] || `canvas-split-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`);
    normalized = addCanvasTextNode(normalized, {
      id: childId,
      text: content[index],
      kind: source.kind === "generated" ? "generated" : "text",
      color: source.color,
      ...candidate,
    });
    normalized = addCanvasEdge(normalized, {
      fromNode: source.id,
      toNode: childId,
      label: "智能拆分",
    });
    occupied.push({ id: childId, ...candidate });
    nodeIds.push(childId);
  }

  return { canvas: normalized, nodeIds };
};

export const removeCanvasEdge = (canvas, edgeId) => {
  const normalized = normalizeCanvas(canvas);
  normalized.edges = normalized.edges.filter((edge) => edge.id !== edgeId);
  return normalized;
};

export const removeCanvasNode = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  normalized.nodes = normalized.nodes.filter((node) => node.id !== nodeId);
  normalized.edges = normalized.edges.filter((edge) => edge.fromNode !== nodeId && edge.toNode !== nodeId);
  return normalized;
};

export const removeCanvasNodeWithRecord = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const node = normalized.nodes.find((item) => item.id === nodeId);
  if (!node) return { canvas: normalized, record: null };
  const edges = normalized.edges.filter((edge) => edge.fromNode === nodeId || edge.toNode === nodeId);
  return {
    canvas: removeCanvasNode(normalized, nodeId),
    record: { node: { ...node }, edges: edges.map((edge) => ({ ...edge })) },
  };
};

export const restoreCanvasNodeRemoval = (canvas, record) => {
  const normalized = normalizeCanvas(canvas);
  if (!record?.node?.id || normalized.nodes.some((node) => node.id === record.node.id)) return normalized;
  normalized.nodes.push(normalizeNode(record.node));
  return (Array.isArray(record.edges) ? record.edges : []).reduce((next, edge) => addCanvasEdge(next, edge), normalized);
};

export const incomingCanvasNodes = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const upstreamIds = normalized.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.toNode === nodeId)
    .sort((left, right) => (Number(left.edge.order) - Number(right.edge.order)) || (left.index - right.index))
    .map(({ edge }) => edge.fromNode);
  return upstreamIds.map((id) => normalized.nodes.find((node) => node.id === id)).filter(Boolean);
};

export const reorderCanvasIncomingEdges = (canvas, nodeId, orderedSourceNodeIds = []) => {
  const normalized = normalizeCanvas(canvas);
  const targetId = String(nodeId || "");
  const incoming = normalized.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.toNode === targetId)
    .sort((left, right) => (Number(left.edge.order) - Number(right.edge.order)) || (left.index - right.index))
    .map(({ edge }) => edge);
  const currentIds = incoming.map((edge) => edge.fromNode);
  const requestedIds = [...new Set((Array.isArray(orderedSourceNodeIds) ? orderedSourceNodeIds : []).map(String))];
  if (requestedIds.length !== currentIds.length
    || requestedIds.some((id) => !currentIds.includes(id))) return normalized;
  const bySource = new Map(incoming.map((edge) => [edge.fromNode, edge]));
  const queue = requestedIds.map((id) => bySource.get(id)).filter(Boolean);
  let nextOrder = 0;
  normalized.edges = normalized.edges.map((edge) => edge.toNode === targetId ? {
    ...queue.shift(),
    order: nextOrder++,
  } : edge);
  return normalized;
};

export const upstreamCanvasNodes = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const nodeMap = new Map(normalized.nodes.map((node) => [node.id, node]));
  const incoming = new Map(normalized.nodes.map((node) => [node.id, []]));
  normalized.edges.forEach((edge) => incoming.get(edge.toNode)?.push(edge.fromNode));
  const visited = new Set([String(nodeId)]);
  const upstream = [];
  const visit = (currentId) => {
    for (const sourceId of incoming.get(currentId) ?? []) {
      if (visited.has(sourceId)) continue;
      visited.add(sourceId);
      visit(sourceId);
      const source = nodeMap.get(sourceId);
      if (source) upstream.push(source);
    }
  };
  visit(String(nodeId));
  return upstream;
};

export const whiteboardGenerationSources = (canvas, nodeId) => {
  const normalized = normalizeCanvas(canvas);
  const target = normalized.nodes.find((node) => node.id === nodeId) ?? null;
  const upstream = target ? incomingCanvasNodes(normalized, nodeId) : [];
  const rawSelectedSkills = upstream
    .flatMap((node) => {
      const reference = node.reference;
      if (!reference || !["skill", "capability"].includes(reference.type)) return [];
      if (reference.skillSelections?.length) return reference.skillSelections.map((selection) => ({ ...selection, source: "whiteboard_explicit" }));
      if (reference.type !== "skill" || !reference.id) return [];
      return [{
        id: reference.id,
        relativePath: reference.id,
        requestedRole: "auxiliary",
        source: "whiteboard_explicit",
        ...(String(reference.id).startsWith("builtin:") ? { builtinId: reference.id, slotId: reference.id } : {}),
      }];
    });
  const selectedSkills = [];
  for (const skill of rawSelectedSkills) {
    const index = selectedSkills.findIndex((item) => item.id === skill.id);
    if (index < 0) selectedSkills.push(skill);
    else if (selectedSkills[index].autoRouted === true && skill.autoRouted !== true) selectedSkills[index] = skill;
  }
  return {
    target,
    upstream,
    selectedSkills,
    authorizedNodeIds: [target?.id, ...upstream.map((node) => node.id)].filter(Boolean),
  };
};

export const whiteboardGenerationResult = (result = {}) => {
  const execution = result?.engineExecution && typeof result.engineExecution === "object"
    ? result.engineExecution
    : {};
  const text = String(result?.candidate || result?.content || "").trim();
  if (execution.status === "blocked") {
    return {
      accepted: false,
      draft: false,
      text: "",
      message: String(execution.result || "本次生成未通过硬门禁，原卡片保持不变"),
    };
  }
  if (isUnusableWhiteboardGenerationText(text)) {
    return {
      accepted: false,
      draft: false,
      text: "",
      message: text.startsWith("本轮候选没有进入可落盘状态")
        ? "模型只返回了审查说明，原卡片保持不变"
        : "模型只返回了受保护内容提示，原卡片保持不变，请调整任务后重新生成",
    };
  }
  return {
    accepted: Boolean(text),
    draft: execution.status === "draft",
    text,
    message: text ? "" : "模型没有返回可用内容",
  };
};

const aspectRatioValue = (value) => {
  const [width, height] = String(value ?? "").split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 0;
};

const closestAspectRatio = (ratio, allowedRatios) => allowedRatios
  .filter((value) => aspectRatioValue(value) > 0)
  .sort((left, right) => Math.abs(Math.log(aspectRatioValue(left) / ratio)) - Math.abs(Math.log(aspectRatioValue(right) / ratio)))[0];

export const adaptiveWhiteboardAspectRatio = ({ upstream = [], prompt = "", channel = "image", allowedRatios = [] } = {}) => {
  const defaults = ["16:9", "9:16", "1:1", "4:3", "3:4"];
  const requested = [...new Set(allowedRatios.map(String).filter((value) => aspectRatioValue(value) > 0))];
  const supported = requested.length ? requested : defaults;
  const nearestMedia = [...upstream].reverse().find((node) => ["image", "video"].includes(node?.kind) && Number(node.aspectRatio) > 0);
  if (nearestMedia) return closestAspectRatio(Number(nearestMedia.aspectRatio), supported);

  const text = String(prompt).toLowerCase();
  const explicit = supported.find((ratio) => new RegExp(`(?:^|\\D)${ratio.replace(":", "\\s*[:：x×]\\s*")}(?:\\D|$)`).test(text));
  if (explicit) return explicit;
  if (/(?:竖屏|手机(?:屏|端|画幅)?|短视频|story|reel|vertical|mobile)/i.test(text)) return closestAspectRatio(9 / 16, supported);
  if (/(?:人物海报|全身像|肖像|纵向|portrait|poster)/i.test(text)) return closestAspectRatio(3 / 4, supported);
  if (/(?:方形|头像|图标|徽标|logo|icon|avatar|square)/i.test(text)) return closestAspectRatio(1, supported);
  if (/(?:横屏|宽银幕|全景|广角|电影感|风景|横幅|landscape|widescreen|cinematic|panorama|banner)/i.test(text)) return closestAspectRatio(16 / 9, supported);
  return closestAspectRatio(channel === "video" ? 16 / 9 : 1, supported);
};

export const canvasBounds = (canvas) => {
  const nodes = normalizeCanvas(canvas).nodes;
  if (!nodes.length) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

export const centeredCanvasViewport = (canvas, { width, height, padding = 80, maximumZoom = 1.25 } = {}) => {
  const normalized = normalizeCanvas(canvas);
  const bounds = canvasBounds(normalized);
  if (!bounds) return { x: finite(width, 0) / 2, y: finite(height, 0) / 2, zoom: 1 };
  const availableWidth = Math.max(1, finite(width, 1) - padding * 2);
  const availableHeight = Math.max(1, finite(height, 1) - padding * 2);
  const zoom = clamp(
    Math.min(availableWidth / Math.max(bounds.width, 1), availableHeight / Math.max(bounds.height, 1), maximumZoom),
    CANVAS_MIN_ZOOM,
    CANVAS_MAX_ZOOM,
  );
  return normalizeViewport({
    zoom,
    x: finite(width, 0) / 2 - (bounds.left + bounds.width / 2) * zoom,
    y: finite(height, 0) / 2 - (bounds.top + bounds.height / 2) * zoom,
  });
};

export const arrangeCanvasNodes = (canvas, {
  startX = 40,
  startY = 40,
  horizontalGap = 88,
  verticalGap = 36,
  componentGap = 96,
  rowGap = 96,
  componentAspectRatio = 1.6,
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  if (!normalized.nodes.length) return normalized;

  const nodesById = new Map(normalized.nodes.map((node) => [node.id, node]));
  const originalNodes = [...normalized.nodes]
    .sort((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id));
  const originalOrder = new Map(originalNodes.map((node, index) => [node.id, index]));
  const compareIds = (leftId, rightId) => (originalOrder.get(leftId) ?? 0) - (originalOrder.get(rightId) ?? 0)
    || String(leftId).localeCompare(String(rightId));
  const outgoing = new Map(normalized.nodes.map((node) => [node.id, []]));
  const incoming = new Map(normalized.nodes.map((node) => [node.id, []]));
  const undirected = new Map(normalized.nodes.map((node) => [node.id, []]));
  for (const edge of normalized.edges) {
    outgoing.get(edge.fromNode)?.push(edge.toNode);
    incoming.get(edge.toNode)?.push(edge.fromNode);
    undirected.get(edge.fromNode)?.push(edge.toNode);
    undirected.get(edge.toNode)?.push(edge.fromNode);
  }
  for (const links of [...outgoing.values(), ...incoming.values(), ...undirected.values()]) links.sort(compareIds);

  const componentIds = [];
  const visited = new Set();
  for (const node of originalNodes) {
    if (visited.has(node.id)) continue;
    const ids = [];
    const pending = [node.id];
    visited.add(node.id);
    while (pending.length) {
      const current = pending.pop();
      ids.push(current);
      for (const linked of undirected.get(current) ?? []) {
        if (visited.has(linked)) continue;
        visited.add(linked);
        pending.push(linked);
      }
    }
    ids.sort(compareIds);
    componentIds.push(ids);
  }

  const layoutComponent = (ids) => {
    const idSet = new Set(ids);
    const componentEdges = normalized.edges.filter((edge) => idSet.has(edge.fromNode) && idSet.has(edge.toNode));
    const indegree = new Map(ids.map((id) => [id, (incoming.get(id) ?? []).filter((parentId) => idSet.has(parentId)).length]));
    const queue = ids.filter((id) => indegree.get(id) === 0).sort(compareIds);
    const topological = [];
    while (queue.length) {
      const current = queue.shift();
      topological.push(current);
      for (const childId of outgoing.get(current) ?? []) {
        if (!idSet.has(childId)) continue;
        indegree.set(childId, indegree.get(childId) - 1);
        if (indegree.get(childId) === 0) {
          queue.push(childId);
          queue.sort(compareIds);
        }
      }
    }
    const topologicalIds = new Set(topological);
    for (const id of ids) if (!topologicalIds.has(id)) topological.push(id);

    const rank = new Map(ids.map((id) => [id, 0]));
    for (const id of topological) {
      for (const childId of outgoing.get(id) ?? []) {
        if (!idSet.has(childId)) continue;
        rank.set(childId, Math.max(rank.get(childId) ?? 0, (rank.get(id) ?? 0) + 1));
      }
    }
    const layerCount = Math.max(...rank.values(), 0) + 1;
    const layers = Array.from({ length: layerCount }, () => []);
    ids.forEach((id) => layers[rank.get(id) ?? 0].push(id));
    layers.forEach((layer) => layer.sort(compareIds));

    const layerPositions = () => {
      const positions = new Map();
      layers.forEach((layer, layerIndex) => layer.forEach((id, index) => positions.set(id, {
        layer: layerIndex,
        index,
        normalized: layer.length <= 1 ? 0.5 : index / (layer.length - 1),
      })));
      return positions;
    };
    const reorderLayer = (layerIndex, neighborsById) => {
      const positions = layerPositions();
      const score = (id) => {
        const values = (neighborsById.get(id) ?? [])
          .filter((neighborId) => idSet.has(neighborId) && positions.has(neighborId))
          .map((neighborId) => positions.get(neighborId).normalized);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      };
      layers[layerIndex].sort((leftId, rightId) => {
        const leftScore = score(leftId);
        const rightScore = score(rightId);
        if (leftScore !== null && rightScore !== null && Math.abs(leftScore - rightScore) > 1e-7) return leftScore - rightScore;
        if (leftScore !== null && rightScore === null) return -1;
        if (leftScore === null && rightScore !== null) return 1;
        return compareIds(leftId, rightId);
      });
    };
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (let layerIndex = 1; layerIndex < layers.length; layerIndex += 1) reorderLayer(layerIndex, incoming);
      for (let layerIndex = layers.length - 2; layerIndex >= 0; layerIndex -= 1) reorderLayer(layerIndex, outgoing);
    }

    const layerWidths = layers.map((layer) => Math.max(...layer.map((id) => nodesById.get(id).width), 0));
    const layerX = [];
    let xCursor = 0;
    layerWidths.forEach((width, layerIndex) => {
      layerX[layerIndex] = xCursor;
      xCursor += width + (layerIndex < layerWidths.length - 1 ? horizontalGap : 0);
    });

    const centers = new Map();
    layers.forEach((layer) => {
      const height = layer.reduce((sum, id) => sum + nodesById.get(id).height, 0) + verticalGap * Math.max(0, layer.length - 1);
      let cursor = -height / 2;
      layer.forEach((id) => {
        const node = nodesById.get(id);
        centers.set(id, cursor + node.height / 2);
        cursor += node.height + verticalGap;
      });
    });

    const packLayer = (layer, desiredCenters) => {
      if (!layer.length) return;
      const tops = [];
      layer.forEach((id, index) => {
        const node = nodesById.get(id);
        const desiredTop = (desiredCenters.get(id) ?? centers.get(id) ?? 0) - node.height / 2;
        tops[index] = index === 0
          ? desiredTop
          : Math.max(desiredTop, tops[index - 1] + nodesById.get(layer[index - 1]).height + verticalGap);
      });
      const desiredMean = layer.reduce((sum, id) => sum + (desiredCenters.get(id) ?? centers.get(id) ?? 0), 0) / layer.length;
      const packedMean = layer.reduce((sum, id, index) => sum + tops[index] + nodesById.get(id).height / 2, 0) / layer.length;
      const shift = desiredMean - packedMean;
      layer.forEach((id, index) => centers.set(id, tops[index] + shift + nodesById.get(id).height / 2));
    };
    for (let sweep = 0; sweep < 3; sweep += 1) {
      for (let layerIndex = 1; layerIndex < layers.length; layerIndex += 1) {
        const desired = new Map(layers[layerIndex].map((id) => {
          const parentCenters = (incoming.get(id) ?? []).filter((parentId) => idSet.has(parentId)).map((parentId) => centers.get(parentId));
          return [id, parentCenters.length ? parentCenters.reduce((sum, value) => sum + value, 0) / parentCenters.length : centers.get(id)];
        }));
        packLayer(layers[layerIndex], desired);
      }
      for (let layerIndex = layers.length - 2; layerIndex >= 0; layerIndex -= 1) {
        const desired = new Map(layers[layerIndex].map((id) => {
          const childCenters = (outgoing.get(id) ?? []).filter((childId) => idSet.has(childId)).map((childId) => centers.get(childId));
          return [id, childCenters.length ? childCenters.reduce((sum, value) => sum + value, 0) / childCenters.length : centers.get(id)];
        }));
        packLayer(layers[layerIndex], desired);
      }
    }

    const minTop = Math.min(...ids.map((id) => centers.get(id) - nodesById.get(id).height / 2));
    const maxBottom = Math.max(...ids.map((id) => centers.get(id) + nodesById.get(id).height / 2));
    const positions = new Map();
    layers.forEach((layer, layerIndex) => layer.forEach((id) => {
      const node = nodesById.get(id);
      positions.set(id, {
        x: layerX[layerIndex] + (layerWidths[layerIndex] - node.width) / 2,
        y: centers.get(id) - node.height / 2 - minTop,
      });
    }));
    return {
      ids,
      positions,
      edgeCount: componentEdges.length,
      width: Math.max(1, xCursor),
      height: Math.max(1, maxBottom - minTop),
      originalOrder: Math.min(...ids.map((id) => originalOrder.get(id) ?? 0)),
    };
  };

  const layouts = componentIds.map(layoutComponent).sort((left, right) => right.edgeCount - left.edgeCount
    || right.ids.length - left.ids.length
    || left.originalOrder - right.originalOrder);
  const widestComponent = Math.max(...layouts.map((layout) => layout.width), 1);
  const estimatedArea = layouts.reduce((sum, layout) => sum + (layout.width + componentGap) * (layout.height + rowGap), 0);
  const targetRowWidth = Math.max(widestComponent, Math.sqrt(estimatedArea * Math.max(1, componentAspectRatio)));
  const rows = [];
  for (const layout of layouts) {
    let row = rows.at(-1);
    const nextWidth = row?.layouts.length ? row.width + componentGap + layout.width : layout.width;
    if (!row || row.layouts.length && nextWidth > targetRowWidth) {
      row = { layouts: [], width: 0, height: 0 };
      rows.push(row);
    }
    row.width += row.layouts.length ? componentGap + layout.width : layout.width;
    row.height = Math.max(row.height, layout.height);
    row.layouts.push(layout);
  }
  const clusterWidth = Math.max(...rows.map((row) => row.width), 1);
  let rowY = startY;
  for (const row of rows) {
    let componentX = startX + (clusterWidth - row.width) / 2;
    for (const layout of row.layouts) {
      const componentY = rowY + (row.height - layout.height) / 2;
      for (const id of layout.ids) {
        const node = nodesById.get(id);
        const position = layout.positions.get(id);
        node.x = snapCanvasValue(componentX + position.x, normalized);
        node.y = snapCanvasValue(componentY + position.y, normalized);
      }
      componentX += layout.width + componentGap;
    }
    rowY += row.height + rowGap;
  }
  return normalized;
};
