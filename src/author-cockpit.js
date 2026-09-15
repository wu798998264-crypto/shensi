import { normalizeCreativeContract } from "./creative-contract.js";
import { normalizePendingCreativeDecision, pendingDecisionEvidenceSources, pendingDecisionIsActionable } from "./pending-decision-policy.js";
import { buildDocumentTree } from "./document-tree.js";

export const AUTHOR_COCKPIT_MODULE_ID = "reports";
export const AUTHOR_COCKPIT_SOURCE_MODULE_IDS = Object.freeze(["reports", "index"]);

const COCKPIT_LABELS = Object.freeze({
  "report-compile": "项目总览",
  "index-language-blacklist": "创作合同",
  "index-pending": "待确认事项",
  "index-update-log": "最近变更",
});

const DECISION_STATUS = Object.freeze({
  blocked: { label: "存在阻断项", detail: "先处理阻断项，再把当前进度作为可靠生产依据。" },
  attention: { label: "需要补齐证据", detail: "结构可以继续使用，但关键覆盖或验证仍不完整。" },
  progress: { label: "结构健康，继续推进", detail: "当前没有结构阻断，可以按计划继续完成正文。" },
  ready: { label: "当前结构健康", detail: "规划、正文与连续性资料没有检测到待处理缺口。" },
});

const ACTION_LABELS = Object.freeze({
  "series-outline": "完善全集大纲",
  "outline-coverage": "补齐章纲",
  "prose-progress": "继续完成正文",
  "stale-memory": "重新验证过期记忆",
  "missing-memory": "补齐缺失记忆",
  "evidence-coverage": "提高证据验证覆盖",
});

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const decodeEntities = (value) => String(value ?? "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

const fragmentText = (value) => decodeEntities(String(value ?? "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .replace(/\s+/g, " ")
  .trim();

const plainText = (documentState = {}) => fragmentText(String(documentState.html ?? documentState.markdown ?? "")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
  .replace(/^\s*#{1,6}\s+[^\n]+/gm, ""));

const excerpt = (documentState, fallback, limit = 84) => {
  const text = plainText(documentState);
  if (!text) return fallback;
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
};

const fingerprintText = (text = "") => {
  const source = String(text).replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length}:${hash.toString(16).padStart(8, "0")}`;
};

export const pendingDecisionFingerprint = (documentState = {}) => fingerprintText(plainText(documentState));

const isEmptyPendingCopy = (text) => /^(?:暂无|当前)?(?:没有|无)待(?:确认|决策|处理)|^0\s*项/.test(String(text).trim());
const isPendingHeaderRow = (cells = []) => cells.length > 0 && cells.every((cell) => /^(?:类型|内容|事项|问题|具体问题|需要确认的问题|来源|来源文档|文档路径|建议处理|状态|说明|处理|建议)$/.test(cell));

const legacyPendingDecisionFields = (text = "") => {
  const cells = String(text).split(/\uFF5C/u).map((cell) => cell.trim()).filter(Boolean);
  if (isPendingHeaderRow(cells)) return null;
  if (cells.length >= 5) {
    return {
      question: cells[1],
      sourcePath: cells[2],
    };
  }
  if (cells.length >= 3) {
    return {
      question: `${cells[0]}：${cells.slice(2).join("；")}`,
      sourcePath: cells[1],
    };
  }
  return {
    question: cells[0] || String(text).trim(),
    sourcePath: "",
  };
};

const pendingMarkdownRows = (markdown = "") => {
  const rows = [];
  const source = String(markdown).replace(/\|\s*\|(?=\s*(?:---|[^|\r\n]+\|))/g, "|\n|");
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-:|\s]+$/.test(line)) continue;
    if (/^\|.*\|$/.test(line)) {
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length && !isPendingHeaderRow(cells)) rows.push(cells.join("｜"));
      continue;
    }
    rows.push(line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ""));
  }
  return rows;
};

const pendingSourceRows = (documentState = {}) => {
  const html = String(documentState.html ?? "");
  const markdown = String(documentState.markdown ?? "");
  const rows = [];
  // Prefer the source Markdown when it contains a table. Some renderers wrap a
  // malformed/compact table in one <p>, which otherwise merges every decision.
  if (/^\s*\|.*\|\s*$/m.test(markdown)) rows.push(...pendingMarkdownRows(markdown));
  if (!rows.length && html) {
    for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) rows.push(fragmentText(match[1]));
    for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => fragmentText(cell[1])).filter(Boolean);
      if (cells.length && !isPendingHeaderRow(cells)) rows.push(cells.join("｜"));
    }
    if (!rows.length) {
      for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) rows.push(fragmentText(match[1]));
    }
  }
  if (!rows.length && markdown) rows.push(...pendingMarkdownRows(markdown));
  const fallback = plainText(documentState);
  if (!rows.length && fallback) rows.push(fallback);
  return [...new Set(rows.map((row) => row.trim()).filter((row) => row && !isEmptyPendingCopy(row)))];
};

export const pendingDecisionItems = (documentState = {}) => {
  const stored = Array.isArray(documentState.cockpitDecisionItems) ? documentState.cockpitDecisionItems : [];
  const structuredSource = stored.filter((item) => item && typeof item === "object" && (item.question || item.issue || item.options || item.affectedScopes));
  const structured = structuredSource
    .map((item) => normalizePendingCreativeDecision(item))
    .filter(Boolean)
    .map((item, index) => ({
      ...item,
      text: [
        item.question,
        item.source ? `来源：${item.source}` : "",
        item.context ? `背景：${item.context}` : "",
        item.options.length ? `方案：${item.options.map((option) => `${option.label}${option.impact ? `（${option.impact}）` : ""}`).join("；")}` : "",
        item.recommendation ? `建议：${item.recommendation}` : "",
        item.affectedScopes.length ? `影响：${item.affectedScopes.join("、")}` : "",
      ].filter(Boolean).join("｜"),
      sourceFingerprint: item.sourceFingerprint || fingerprintText(item.question),
      sourcePath: item.sourcePath || item.source,
      status: item.status === "committed" ? "resolved" : item.status,
      order: Number.isFinite(Number(structuredSource[index]?.order)) ? Number(structuredSource[index].order) : index,
    }));
  if (stored.length) return structured.sort((left, right) => left.order - right.order);
  const storedByFingerprint = new Map(stored.filter((item) => item?.sourceFingerprint).map((item) => [item.sourceFingerprint, item]));
  const legacyReview = documentState.cockpitDecisionReview;
  const legacyResolved = Boolean(legacyReview?.sourceFingerprint && legacyReview.sourceFingerprint === pendingDecisionFingerprint(documentState));
  return pendingSourceRows(documentState).map((text, index) => {
    const fields = legacyPendingDecisionFields(text);
    if (!fields || !pendingDecisionIsActionable(fields.question)) return null;
    const sourceFingerprint = fingerprintText(text);
    const previous = storedByFingerprint.get(sourceFingerprint);
    return {
      id: previous?.id || `pending-${sourceFingerprint.replace(":", "-")}`,
      text,
      question: fields.question,
      source: fields.sourcePath,
      sourcePath: fields.sourcePath,
      sourceFingerprint,
      status: previous?.status || (legacyResolved ? "resolved" : "pending"),
      decisionType: previous?.decisionType || (legacyResolved ? legacyReview.status : ""),
      opinion: previous?.opinion || (legacyResolved ? legacyReview.opinion || "" : ""),
      reviewedAt: previous?.reviewedAt || (legacyResolved ? legacyReview.reviewedAt || "" : ""),
      processingAt: previous?.processingAt || "",
      lastError: previous?.lastError || "",
      order: Number.isFinite(Number(previous?.order)) ? Number(previous.order) : index,
    };
  }).filter(Boolean).sort((left, right) => left.order - right.order);
};

export const pendingDecisionDisplay = (item = {}) => ({
  sourcePath: String(item.sourcePath || item.source || "当前文档").trim(),
  question: String(item.question || item.issue || item.text || "").trim(),
  explanation: String(item.conflictExplanation || item.context || "").trim(),
  sources: pendingDecisionEvidenceSources(item),
});

const sourceItem = (moduleItems, moduleId, documentId) => (
  (moduleItems?.[moduleId] ?? []).find(([id]) => id === documentId)
);

const cockpitItem = (moduleItems, documents, moduleId, documentId) => {
  const item = sourceItem(moduleItems, moduleId, documentId);
  if (!item || !documents?.[documentId]) return null;
  return {
    id: documentId,
    label: COCKPIT_LABELS[documentId] ?? item[1] ?? documents[documentId]?.title ?? documentId,
    sourceLabel: item[1] ?? documents[documentId]?.title ?? documentId,
    sourceModuleId: moduleId,
    options: item[2] ?? {},
  };
};

const orderItems = (items, requestedOrder = []) => {
  const rank = new Map((requestedOrder ?? []).map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index }))
    .sort((left, right) => (rank.get(left.item.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.item.id) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ item }) => item);
};

export const isAuthorCockpitModule = (moduleId) => AUTHOR_COCKPIT_SOURCE_MODULE_IDS.includes(moduleId);

export const presentationModuleId = (moduleId) => isAuthorCockpitModule(moduleId)
  ? AUTHOR_COCKPIT_MODULE_ID
  : moduleId;

export const visibleWorkspaceModules = (modules = []) => {
  const projected = modules
    .filter((module) => module.id !== "index")
    .map((module) => module.id === AUTHOR_COCKPIT_MODULE_ID
      ? Object.freeze({ ...module, label: "索引", listTitle: "索引" })
      : module);
  const cockpitIndex = projected.findIndex((module) => module.id === AUTHOR_COCKPIT_MODULE_ID);
  const cockpit = cockpitIndex >= 0 ? projected.splice(cockpitIndex, 1)[0] : null;
  if (cockpit) projected.unshift(cockpit);
  return Object.freeze(projected);
};

export const authorCockpitDocumentLabel = (documentId, fallback = "") => COCKPIT_LABELS[documentId] ?? fallback;

export const authorCockpitSections = ({ moduleItems = {}, documents = {}, reportOrder = [] } = {}) => {
  const compileReports = [
    cockpitItem(moduleItems, documents, "index", "index-pending"),
    ...(moduleItems.reports ?? [])
      .filter(([id]) => id !== "report-compile")
      .map(([id]) => cockpitItem(moduleItems, documents, "reports", id)),
    cockpitItem(moduleItems, documents, "index", "index-update-log"),
  ].filter(Boolean);
  return [
    {
      id: "project-control",
      label: "项目管理",
      items: [
        cockpitItem(moduleItems, documents, "reports", "report-compile"),
        cockpitItem(moduleItems, documents, "index", "index-language-blacklist"),
      ].filter(Boolean),
    },
    {
      id: "compile-reports",
      label: "编译报告",
      items: orderItems(compileReports, reportOrder),
    },
  ];
};

// The index projects two backing modules. Keep its system shortcuts, but do
// not mistake that curated list for the complete editable directory.
export const authorCockpitDirectoryContent = ({ moduleItems = {}, documents = {}, customFolders = [], authorCockpitReportOrder = [] } = {}) => {
  const folderIds = new Set(customFolders.map((folder) => folder.id));
  const customIds = new Set(AUTHOR_COCKPIT_SOURCE_MODULE_IDS.flatMap((moduleId) => (moduleItems[moduleId] ?? [])
    .filter(([id, , options = {}]) => documents[id]?.placementOverride === true
      || documents[id]?.documentKind === "whiteboard"
      || folderIds.has(options.customFolderId))
    .map(([id]) => id)));
  const sections = authorCockpitSections({ moduleItems, documents, reportOrder: authorCockpitReportOrder })
    .map((section) => section.id === "project-control" ? section : {
      ...section,
      items: section.items.filter((item) => !customIds.has(item.id)),
    });
  const listedIds = new Set(sections.flatMap((section) => section.items.map((item) => item.id)));
  const directories = ["index", "reports"].map((moduleId) => ({
    moduleId,
    viewId: "default",
    label: moduleId === "index" ? "索引文档" : "报告目录",
    tree: buildDocumentTree({
      moduleId,
      viewId: "default",
      items: (moduleItems[moduleId] ?? []).filter(([id]) => !listedIds.has(id)),
      documents,
      folders: customFolders,
      workspaceKind: "project",
    }),
  })).filter((directory) => directory.tree.length);
  return { sections, directories };
};

export const authorCockpitOverviewModel = ({ moduleItems = {}, documents = {}, decision = {}, reportOrder = [] } = {}) => {
  const sections = authorCockpitSections({ moduleItems, documents, reportOrder });
  const pendingDocument = documents["index-pending"] ?? {};
  const allPendingItems = pendingDecisionItems(pendingDocument);
  const openPendingItems = allPendingItems.filter((item) => item.status !== "resolved");
  return {
    status: DECISION_STATUS[decision.status] ?? DECISION_STATUS.attention,
    contract: {
      id: "index-language-blacklist",
      excerpt: excerpt(documents["index-language-blacklist"], "尚未建立项目级创作边界。"),
    },
    pending: {
      id: "index-pending",
      count: openPendingItems.length,
      items: openPendingItems,
    },
    recent: {
      id: "index-update-log",
      excerpt: String(documents["index-update-log"]?.cockpitRecentSummary || "").trim()
        || excerpt(documents["index-update-log"], "当前尚无结构化更新记录。"),
    },
    reports: sections.find((section) => section.id === "compile-reports")?.items ?? [],
    riskCount: Number(decision.metrics?.actionCount ?? 0),
  };
};

const metric = (label, value, translate) => `<div><dt>${escapeHtml(translate(label))}</dt><dd>${escapeHtml(value)}</dd></div>`;

const cockpitLink = ({ documentId, label, meta = "" }, translate) => `<button class="author-cockpit-link" type="button" data-open-cockpit-document="${escapeHtml(documentId)}"><span>${escapeHtml(translate(label))}</span>${meta ? `<small>${escapeHtml(translate(meta))}</small>` : ""}<b aria-hidden="true">›</b></button>`;

const pendingDecisionCopyHtml = (item = {}) => {
  const display = pendingDecisionDisplay(item);
  const sourceLinks = display.sources.map((source, index) => {
    const label = [source.path || source.title || source.documentId || display.sourcePath, source.heading].filter(Boolean).join(" · ");
    return source.documentId
      ? `<button class="author-cockpit-decision-source" type="button" data-open-pending-source="${escapeHtml(source.documentId)}" data-pending-source-index="${index}"><span>${escapeHtml(label)}</span><b aria-hidden="true">↗</b></button>`
      : `<span class="author-cockpit-decision-path">${escapeHtml(label)}</span>`;
  }).join("") || `<span class="author-cockpit-decision-path">${escapeHtml(display.sourcePath)}</span>`;
  return `<div class="author-cockpit-decision-copy" data-open-cockpit-decision="${escapeHtml(item.id)}"><div class="author-cockpit-decision-sources">${sourceLinks}</div><strong>${escapeHtml(display.question)}</strong>${display.explanation && display.explanation !== display.question ? `<p>${escapeHtml(display.explanation)}</p>` : ""}</div>`;
};

const pendingDecisionItemHtml = (item, index, translate, { compact = false } = {}) => {
  const processing = item.status === "processing" || item.status === "queued";
  const confirmed = item.status === "confirmed";
  const opinion = String(confirmed ? item.opinion : item.draftOpinion || item.opinion || "").trim();
  const stateLabel = confirmed ? `已确认 ${index + 1}` : processing ? `处理中 ${index + 1}` : `待确认 ${index + 1}`;
  return `<article class="author-cockpit-decision-item ${compact ? "author-cockpit-decision-summary-card" : ""}" data-cockpit-decision-item="${escapeHtml(item.id)}" data-state="${escapeHtml(item.status)}" ${compact ? `data-open-cockpit-decision="${escapeHtml(item.id)}"` : ""} tabindex="0">
    <header><span>${escapeHtml(translate(stateLabel))}</span></header>
    ${pendingDecisionCopyHtml(item)}
    ${item.lastError ? `<small class="author-cockpit-decision-error">${escapeHtml(item.lastError)}</small>` : ""}
    ${compact ? "" : `<div class="author-cockpit-decision-directive" data-cockpit-decision-directive>
      <label><span>${escapeHtml(translate("具体决策指示"))}</span><textarea rows="3" maxlength="1200" data-cockpit-decision-opinion placeholder="${escapeHtml(translate("填写修改方向、补充要求或明确处理边界…"))}" ${confirmed || processing ? "readonly aria-readonly=\"true\"" : ""}>${escapeHtml(opinion)}</textarea></label>
      ${processing
        ? `<button class="primary-button compact" type="button" disabled>${escapeHtml(translate("处理中…"))}</button>`
        : confirmed
          ? `<button class="secondary-button compact" type="button" data-edit-cockpit-decision="${escapeHtml(item.id)}">${escapeHtml(translate("编辑"))}</button>`
          : `<button class="primary-button compact" type="button" data-confirm-cockpit-decision="${escapeHtml(item.id)}" ${opinion ? "" : "disabled"}>${escapeHtml(translate("确认"))}</button>`}
    </div>`}
  </article>`;
};

const pendingDecisionListHtml = (pending, translate, options = {}) => pending.items.length
  ? `<div class="author-cockpit-decision-list">${pending.items.map((item, index) => pendingDecisionItemHtml(item, index, translate, options)).join("")}</div>`
  : `<div class="author-cockpit-decision-empty"><span aria-hidden="true">✓</span><strong>${escapeHtml(translate("当前没有待确认事项"))}</strong><p>${escapeHtml(translate("新发现的冲突、缺口或需要作者裁定的问题会出现在这里。"))}</p></div>`;

export const authorCockpitDecisionEditorHtml = ({ item = {}, index = 0, translate = (value) => value } = {}) => pendingDecisionItemHtml(item, index, translate);

export const authorCockpitReadonlyDocumentHtml = ({ documentState = {}, translate = (value) => value } = {}) => `<section class="author-cockpit-readonly-report">
  <header><div><small>${escapeHtml(translate("索引 · 只读报告"))}</small><strong>${escapeHtml(documentState.title || translate("未命名报告"))}</strong><p>${escapeHtml(translate("该内容由当前项目资料自动汇总，在索引内统一阅读。"))}</p></div></header>
  <article>${String(documentState.html ?? documentState.markdown ?? "")}</article>
</section>`;

export const authorCockpitContractDocumentHtml = ({ documentState = {}, translate = (value) => value } = {}) => {
  const contract = normalizeCreativeContract(documentState);
  const field = ({ id, label, value, placeholder }) => `<article class="author-cockpit-contract-field">
    <header><div><small>${escapeHtml(translate("项目级约束"))}</small><strong>${escapeHtml(translate(label))}</strong></div><button class="secondary-button compact" type="button" data-creative-contract-ai="${escapeHtml(id)}">${escapeHtml(translate("AI 辅助填写"))}</button></header>
    <textarea data-creative-contract-field="${escapeHtml(id)}" rows="8" maxlength="20000" placeholder="${escapeHtml(translate(placeholder))}" spellcheck="true">${escapeHtml(value)}</textarea>
    <small>${escapeHtml(translate("仅对当前作品生效；修改后自动保存并进入历史版本。"))}</small>
  </article>`;
  return `<section class="author-cockpit-readonly-report author-cockpit-contract-report">
    <header><div><small>${escapeHtml(translate("索引 · 固定项目合同"))}</small><strong>${escapeHtml(translate("创作合同"))}</strong><p>${escapeHtml(translate("集中维护当前作品必须遵守的禁用表达与特别要求。用户和 AI 写入同一份项目合同。"))}</p></div></header>
    <div class="author-cockpit-contract-fields">
      ${field({ id: "bannedTerms", label: "项目禁用词", value: contract.bannedTerms, placeholder: "每行填写一个禁用词或禁用表达，也可以用逗号、顿号分隔。" })}
      ${field({ id: "specialNotes", label: "特别注意事项", value: contract.specialNotes, placeholder: "填写本项目必须遵守的创作边界、承接事项、风格要求或其他特殊规则。" })}
    </div>
  </section>`;
};

export const authorCockpitPendingDocumentHtml = ({ documentState = {}, translate = (value) => value } = {}) => {
  const items = pendingDecisionItems(documentState).filter((item) => item.status !== "resolved");
  const executableCount = items.filter((item) => item.status === "confirmed" && String(item.opinion || "").trim()).length;
  return `<section class="author-cockpit-readonly-report author-cockpit-pending-report">
    <header><div><small>${escapeHtml(translate("索引 · 只读事项"))}</small><strong>${escapeHtml(translate("待确认事项"))}</strong><p>${escapeHtml(translate("事项正文不可直接编辑。逐条确认，或点开事项填写批示；处理完成后会自动移出并写入编译报告。"))}</p></div><span>${items.length}</span></header>
    <div class="author-cockpit-batch-toolbar"><span>${escapeHtml(translate(`已确认 ${executableCount} 项`))}</span><button class="primary-button compact" type="button" data-run-cockpit-agent-batch ${executableCount < 1 ? "disabled" : ""}>${escapeHtml(translate(`执行已确认项目（${executableCount}）`))}</button></div>
    <article>${pendingDecisionListHtml({ items }, translate)}</article>
  </section>`;
};

export const authorCockpitOverviewHtml = ({ moduleItems = {}, documents = {}, decision = {}, reportOrder = [], experienceSummary = {}, translate = (value) => value, refreshing = false, integrityScan = {} } = {}) => {
  const model = authorCockpitOverviewModel({ moduleItems, documents, decision, reportOrder });
  const actions = (decision.actions ?? []).slice(0, 4).map((action) => {
    const suffix = action.id === "evidence-coverage"
      ? `${Number(action.value || 0).toLocaleString()}%`
      : action.value ? Number(action.value).toLocaleString() : "";
    return `<li data-severity="${escapeHtml(action.severity)}"><span>${escapeHtml(translate(ACTION_LABELS[action.id] || action.id))}</span>${suffix ? `<b>${escapeHtml(suffix)}</b>` : ""}</li>`;
  }).join("");
  const reports = model.reports.map((report) => cockpitLink({
    documentId: report.id,
    label: report.label,
    meta: report.id === "index-pending" ? `${model.pending.count} 项` : report.id === "index-update-log" ? "可手动刷新" : "打开报告",
  }, translate)).join("");
  const executablePendingCount = model.pending.items.filter((item) => item.status === "confirmed" && String(item.opinion || "").trim()).length;
  const integrityStatus = integrityScan.running
    ? "正在检查…"
    : integrityScan.error
      ? `检查失败：${integrityScan.error}`
      : integrityScan.completedAt
        ? `最近检查 ${integrityScan.issues ?? 0} 项 · 已核对 ${integrityScan.checkedDocuments ?? 0} 份`
        : "手动检查资料、大纲、设定、正文与记忆之间的明确事实冲突";
  return `<header><div><small>${escapeHtml(translate("索引 · 项目总览"))}</small><strong>${escapeHtml(translate(model.status.label))}</strong><p>${escapeHtml(translate(model.status.detail))}</p><small class="author-cockpit-integrity-status" data-integrity-scan-status>${escapeHtml(translate(integrityStatus))}</small></div><div class="author-cockpit-overview-actions"><button class="secondary-button compact" type="button" data-run-integrity-scan ${integrityScan.running ? "disabled" : ""}>${escapeHtml(translate(integrityScan.running ? "正在检查…" : "检查作品一致性"))}</button>${decision.canReviewMemory ? `<button class="secondary-button compact" type="button" data-open-compilation-memory-review>${escapeHtml(translate("审阅记忆证据"))}</button>` : ""}</div></header>
    <dl>${metric("章纲完成", `${decision.metrics?.outline?.completed ?? 0}/${decision.metrics?.outline?.total ?? 0}`, translate)}${metric("正文完成", `${decision.metrics?.prose?.completed ?? 0}/${decision.metrics?.prose?.total ?? 0}`, translate)}${metric("证据验证覆盖", `${Number(decision.metrics?.evidenceCoverage ?? 0).toLocaleString()}%`, translate)}${metric("待处理", decision.metrics?.actionCount ?? 0, translate)}</dl>
    <div class="compilation-decision-actions"><strong>${escapeHtml(translate("建议行动"))}</strong>${actions ? `<ol>${actions}</ol>` : `<p>${escapeHtml(translate("当前没有需要优先处理的结构问题。"))}</p>`}</div>
    <section class="author-cockpit-decision-layout" aria-label="${escapeHtml(translate("待确认与项目约束"))}">
      <article class="author-cockpit-pending-panel"><header><div><small>${escapeHtml(translate("待确认事项"))}</small><strong>${escapeHtml(model.pending.count)} ${escapeHtml(translate("项待作者裁定"))}</strong></div>${cockpitLink({ documentId: model.pending.id, label: "查看全部", meta: "只读事项" }, translate)}</header>${pendingDecisionListHtml(model.pending, translate, { compact: true })}${model.pending.count ? `<div class="author-cockpit-batch-toolbar"><span>${escapeHtml(translate(`已确认 ${executablePendingCount} 项`))}</span><button class="primary-button compact" type="button" data-run-cockpit-agent-batch ${executablePendingCount < 1 ? "disabled" : ""}>${escapeHtml(translate(`执行已确认项目（${executablePendingCount}）`))}</button></div>` : ""}</article>
      <aside>
        <article><small>${escapeHtml(translate("创作合同"))}</small><strong>${escapeHtml(translate("项目级创作边界"))}</strong><p>${escapeHtml(model.contract.excerpt)}</p>${cockpitLink({ documentId: model.contract.id, label: "查看并编辑", meta: "创作合同" }, translate)}</article>
        <article><small>${escapeHtml(translate("风险与连续性"))}</small><strong>${escapeHtml(model.riskCount)} ${escapeHtml(translate("项需要关注"))}</strong><p>${escapeHtml(translate(decision.canReviewMemory ? "存在记忆证据或连续性覆盖问题，可进入审阅。" : "当前连续性资料没有需要优先处理的缺口。"))}</p>${decision.canReviewMemory ? `<button class="author-cockpit-link" type="button" data-open-compilation-memory-review><span>${escapeHtml(translate("检查长文记忆"))}</span><small>${escapeHtml(translate("证据审阅"))}</small><b aria-hidden="true">›</b></button>` : ""}</article>
      </aside>
    </section>
    <section class="author-cockpit-report-collection"><header><div><small>${escapeHtml(translate("项目自动汇总资产"))}</small><strong>${escapeHtml(translate("编译报告"))}</strong></div><span>${model.reports.length}</span></header><div>${reports}</div></section>
    <section class="author-cockpit-experience"><div><small>${escapeHtml(translate("本作品经验"))}</small><p>${experienceSummary.loading ? escapeHtml(translate("正在读取本作品经验…")) : `${escapeHtml(translate("经验总数"))} ${Number(experienceSummary.total || 0)} · ${escapeHtml(translate("成熟"))} ${Number(experienceSummary.mature || 0)} · ${escapeHtml(translate("已暂停"))} ${Number(experienceSummary.suspended || 0)}`}</p></div><div class="author-cockpit-recent-actions"><button class="author-cockpit-link" type="button" data-open-experience-settings><span>${escapeHtml(translate("管理创作经验"))}</span><small>${escapeHtml(translate("设置 · 创作经验"))}</small><b aria-hidden="true">›</b></button></div></section>
    <section class="author-cockpit-recent"><div><small>${escapeHtml(translate("最近变更摘要"))}</small><p>${escapeHtml(model.recent.excerpt)}</p></div><div class="author-cockpit-recent-actions"><button class="secondary-button compact" type="button" data-refresh-author-cockpit ${refreshing ? "disabled" : ""}>${escapeHtml(translate(refreshing ? "正在刷新…" : "刷新变更"))}</button>${cockpitLink({ documentId: model.recent.id, label: "打开编译记录" }, translate)}</div></section>`;
};
