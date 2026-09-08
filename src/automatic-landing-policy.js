import {
  compileAgentTaskPolicy,
  requestsMultipleCandidates,
} from "./agent-task-policy.js";
import { hasExplicitNewDocumentAction } from "./artifact-ontology.js";
import { bindFormalWriteCandidate, validateFormalWriteAuthorization } from "./formal-write-authorization.js";

const text = (value = "") => String(value ?? "").trim();

const cleanRequestedDocumentTitle = (value = "") => text(value)
  .replace(/^[《「『“‘"']+|[》」』”’"']+$/g, "")
  .replace(/(?:并且|并|然后|之后|同时)(?:写入|落盘|保存|放入|加入)[\s\S]*$/u, "")
  .replace(/[，。；;！!？?]+$/u, "")
  .trim()
  .slice(0, 100);

export const explicitNewDocumentIntent = (instruction = "") => {
  const source = text(instruction);
  // A negative constraint such as “不要创建空占位文档” describes what the
  // router must avoid; it is not an instruction to create a document. Remove
  // only the negated clause so a later affirmative instruction (for example
  // “有正式内容后再新建”) can still be detected independently.
  const actionableSource = source.replace(
    /(?:不要|无需|不必|禁止|不得|别|不应|不准|不可|不再|不)\s*(?:先|预先|提前|自动)?\s*(?:新建|创建|另建|另起|新开|新增加?|新文档|新文件|new\s+(?:document|file))[^，。；;！!？?\r\n]*/giu,
    " ",
  );
  if (!actionableSource || !hasExplicitNewDocumentAction(actionableSource)) {
    return { create: false, title: "", reason: "not_requested" };
  }
  const quotedNamed = actionableSource.match(/(?:命名为|名称为|标题为|取名为|名字(?:叫|为)|叫做?)\s*[《「『“‘"']([^》」』”’"'\r\n]{1,100})[》」』”’"']/u)?.[1];
  const named = quotedNamed
    ?? actionableSource.match(/(?:命名为|名称为|标题为|取名为|名字(?:叫|为)|叫做?)\s*[《「『“‘"']?([^\r\n，。；;！!？?]{1,100})/u)?.[1]
    ?? actionableSource.match(/(?:新建|创建|另建|另起|新开|新增)\s*(?:一个|一份|一篇|一章|一集)?\s*(?:新的?)?\s*(?:文档|文件|正文|稿件)\s*[《「『“‘"']([^》」』”’"'\r\n]{1,100})/u)?.[1]
    ?? actionableSource.match(/(?:新建|创建|另建|另起|新开|新增)\s*(?:一个|一份|一篇|一章|一集)?\s*(?:新的?)?\s*(?:文档|文件|正文|稿件)(?:\s*(?:名为|叫做|标题为|：|:))?\s*([^\s，。；;！!？?][^\r\n，。；;！!？?]{0,99})/u)?.[1]
    ?? "";
  const title = cleanRequestedDocumentTitle(named)
    .replace(/[》」』”’"']\s*(?:的)?\s*(?:章节)?(?:文档|文件|正文|稿件)?$/u, "")
    .trim();
  return {
    create: true,
    title: /^(?:里|中|内|用于|用来)$/u.test(title) ? "" : title,
    reason: "explicit_new_document",
  };
};

export { requestsMultipleCandidates } from "./agent-task-policy.js";

export const continuationDestinationIntent = (instruction = "") => {
  const source = text(instruction);
  if (!/(?:续写|继续写|接着写|往下写|承接写)/u.test(source)) return "none";
  if (/(?:下一章|下章|新一章|另起一章|新建章节)/u.test(source)) return "next";
  if (/(?:当前|本章|本节|这个|该)(?:文档|章节|章|节)|(?:当前|本章|本节)(?:继续|接着|往下)/u.test(source)) return "current";
  return "ambiguous";
};

export const splitLabeledCandidateVariants = (value = "") => {
  const source = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];
  const headingPattern = /^(?:#{1,4}[ \t　]*)?(?:(?:候选|版本|方案)[ \t　]*(?:稿)?[ \t　]*(?:[A-ZＡ-Ｚ]|\d+|[一二三四五六七八九十]+)|第[ \t　]*(?:\d+|[一二三四五六七八九十]+)[ \t　]*版)(?:[：: \t　·—-]+.*)?$/gmu;
  const headings = [...source.matchAll(headingPattern)];
  if (headings.length < 2) return [];
  return headings.map((heading, index) => {
    const start = Number(heading.index) + heading[0].length;
    const end = Number(headings[index + 1]?.index ?? source.length);
    return {
      id: `candidate-${index + 1}`,
      label: heading[0].replace(/^#{1,4}\s*/, "").trim(),
      text: source.slice(start, end).trim(),
      position: index + 1,
      selected: index === 0,
    };
  }).filter((variant) => variant.text);
};

export const resultCandidateVariantCount = (result = {}) => {
  const variants = result?.generationAttempt?.candidateVariants
    ?? result?.candidateVariants
    ?? result?.execution?.candidateVariants
    ?? [];
  if (!Array.isArray(variants)) return 0;
  const populated = variants.filter((variant) => text(variant?.text ?? variant?.candidate ?? variant));
  // Native generation attempts explicitly distinguish parallel author choices
  // from internal draft/review revisions. Older and external labeled variants
  // omit this flag and retain their existing multi-candidate behaviour.
  if (populated.length && populated.every((variant) => variant?.selectionRequired === false)) return 1;
  return populated.length;
};

export const candidateLandingShouldBeDeferred = ({
  route = {},
  creativeGuidanceRequested = false,
  guidanceProducedFormalArtifact = false,
  explicitlyDeferred = false,
} = {}) => {
  // A real "不要落盘/只看候选" instruction remains authoritative.  A
  // lingering creative-guidance session, however, must not turn a new,
  // explicitly authorized write command back into a preview-only turn.
  if (explicitlyDeferred) return true;
  if (route?.writeAuthorization?.state === "commit") return false;
  return creativeGuidanceRequested && !guidanceProducedFormalArtifact;
};

export const automaticLandingDecision = ({
  instruction = "",
  result = {},
  explicitlyDeferred = false,
  targetAmbiguous = false,
  taskPolicy = null,
  route = {},
  target = null,
} = {}) => {
  if (explicitlyDeferred) return { action: "defer", reason: "explicit_deferral" };
  if (targetAmbiguous) return { action: "defer", reason: "ambiguous_target" };
  if (!text(result?.candidate)) return { action: "none", reason: "no_candidate" };
  const sourceAuthorization = route?.writeAuthorization
    ?? taskPolicy?.writeAuthorization
    ?? result?.writeAuthorization
    ?? result?.execution?.writeAuthorization
    ?? null;
  if (sourceAuthorization?.state === "candidate_only") return { action: "defer", reason: "candidate_only" };
  const writeAuthorization = bindFormalWriteCandidate(sourceAuthorization, {
    candidate: result.candidate,
    targetDocumentIds: sourceAuthorization?.targetDocumentIds,
    expectedRevisions: sourceAuthorization?.expectedRevisions,
  });
  const authorizationCheck = validateFormalWriteAuthorization(writeAuthorization, {
    requiredState: "commit",
    instruction,
    candidate: result.candidate,
    targetDocumentIds: sourceAuthorization?.targetDocumentIds,
    expectedRevisions: sourceAuthorization?.expectedRevisions,
    requireBodyMutation: sourceAuthorization?.action !== "rename",
    requireTitleMutation: sourceAuthorization?.action === "rename",
  });
  if (!authorizationCheck.valid) return { action: "none", reason: "formal_write_not_authorized" };
  const resultReviewDelivery = result?.engineExecution?.reviewDelivery ?? result?.execution?.reviewDelivery ?? null;
  const resolvedRoute = route?.reviewDelivery || !resultReviewDelivery
    ? route
    : { ...route, mode: route?.mode || "creative", reviewDelivery: resultReviewDelivery };
  const resolvedPolicy = taskPolicy ?? compileAgentTaskPolicy({
    text: instruction,
    route: resolvedRoute,
    target: target ?? { ambiguous: targetAmbiguous },
    candidateCount: Math.max(1, resultCandidateVariantCount(result)),
  });
  if (resolvedPolicy.commitOwner !== "shensi_transaction"
    || !["generate", "modify"].includes(resolvedPolicy.action)) {
    return { action: "none", reason: "formal_write_not_authorized" };
  }
  const decisions = {
    auto_commit: { action: "land", reason: "single_candidate", writeAuthorization },
    defer_explicit: { action: "defer", reason: "explicit_deferral" },
    defer_multiple: { action: "defer", reason: "multiple_candidates" },
    defer_ambiguous: { action: "defer", reason: "ambiguous_target" },
    no_artifact: { action: "none", reason: "no_artifact" },
  };
  return decisions[resolvedPolicy.commitDisposition]
    ?? { action: "none", reason: "unsupported_commit_disposition" };
};

export const conversationAutoAssociationEnabled = (conversation = {}) => (
  conversation?.autoAssociateActiveDocument !== false
);

// Conversations created by the UI are anchored to the document that was
// visible at creation time.  Keep this separate from autoAssociateActiveDocument:
// the latter controls whether the bound document participates in context, while
// this flag controls whether navigation may rewrite the binding.
export const conversationHasFixedDocumentBinding = (conversation = {}) => (
  conversation?.documentBindingMode === "fixed"
);

export const associatedDocumentId = (conversation = {}, activeDocumentId = "") => {
  if (!conversationAutoAssociationEnabled(conversation)) return null;
  if (conversationHasFixedDocumentBinding(conversation)) {
    return text(conversation?.boundDocumentId || conversation?.homeDocumentId) || null;
  }
  // Auto association follows what the author is actually editing now.  The
  // stored bound id is a recovery fallback only; letting it outrank the visible
  // document makes continuation requests patch a document the user has already
  // left.
  return text(activeDocumentId || conversation?.boundDocumentId) || null;
};

export const conversationAssociationDisplayDocumentId = (conversation = {}, activeDocumentId = "") => (
  conversationHasFixedDocumentBinding(conversation)
    ? text(conversation?.boundDocumentId || conversation?.homeDocumentId) || null
    : text(activeDocumentId || conversation?.boundDocumentId) || null
);

export const updateConversationDocumentAssociation = (conversation = {}, activeDocumentId = "") => {
  if (!conversation) return false;
  if (conversationHasFixedDocumentBinding(conversation)) return false;
  const nextId = text(activeDocumentId);
  if (!nextId || conversation.boundDocumentId === nextId) return false;
  // The chip follows the document the author is looking at even while
  // association is paused. Pausing controls whether the body enters model
  // context; it must not freeze the old label or silently re-enable itself.
  conversation.boundDocumentId = nextId;
  conversation.associationRevision = Math.max(0, Number(conversation.associationRevision) || 0) + 1;
  conversation.associationChangedAt = new Date().toISOString();
  conversation.pendingTargetResolution = null;
  conversation.intentTarget = null;
  conversation.constraintIndex = [];
  conversation.contextCapsule = null;
  conversation.contextBudget = null;
  conversation.contextWindowNoticeSignature = "";
  if (conversationAutoAssociationEnabled(conversation)) conversation.associationAnchorDocumentId = "";
  return true;
};

export const toggleConversationDocumentAssociation = (conversation = {}, activeDocumentId = "") => {
  if (!conversation) return false;
  const enabled = !conversationAutoAssociationEnabled(conversation);
  conversation.autoAssociateActiveDocument = enabled;
  if (enabled && text(activeDocumentId)) {
    if (!conversationHasFixedDocumentBinding(conversation)) conversation.boundDocumentId = text(activeDocumentId);
    conversation.associationAnchorDocumentId = "";
  } else {
    conversation.associationAnchorDocumentId = text(conversation.boundDocumentId || activeDocumentId);
  }
  conversation.associationRevision = Math.max(0, Number(conversation.associationRevision) || 0) + 1;
  conversation.associationChangedAt = new Date().toISOString();
  conversation.pendingTargetResolution = null;
  conversation.intentTarget = null;
  conversation.contextCapsule = null;
  conversation.contextBudget = null;
  conversation.contextWindowNoticeSignature = "";
  return enabled;
};

export const createTurnContextSnapshot = ({
  conversation = {},
  workspaceKind = "project",
  workspacePath = "",
  workspaceName = "",
  activeDocumentId = "",
  documents = {},
  editorContentRevision = "",
} = {}) => {
  const editorDocumentId = text(activeDocumentId);
  const effectiveBoundDocumentId = associatedDocumentId(conversation, editorDocumentId) || "";
  const documentState = documents?.[effectiveBoundDocumentId || editorDocumentId] ?? {};
  return Object.freeze({
    schemaVersion: 2,
    conversationId: text(conversation?.id),
    workspaceKind: workspaceKind === "notebook" ? "notebook" : "project",
    workspacePath: text(workspacePath),
    workspaceName: text(workspaceName),
    workspaceIdentity: `${workspaceKind === "notebook" ? "notebook" : "project"}:${text(workspacePath || workspaceName).toLocaleLowerCase("en-US")}`,
    activeDocumentId: editorDocumentId,
    editorDocumentId,
    boundDocumentId: effectiveBoundDocumentId,
    associationEnabled: conversationAutoAssociationEnabled(conversation),
    associationRevision: Math.max(0, Number(conversation?.associationRevision) || 0),
    documentTitle: text(documentState.title),
    documentRevision: text(documentState.revision || documentState.contentRevision || documentState.updatedAt),
    editorContentRevision: text(editorContentRevision || documentState.editorContentRevision || documentState.revision || documentState.contentRevision || documentState.updatedAt),
    capturedAt: new Date().toISOString(),
  });
};

export const conversationAssociationRoutingAnchorId = (conversation = {}, activeDocumentId = "") => (
  conversationAutoAssociationEnabled(conversation)
    ? (conversationHasFixedDocumentBinding(conversation)
      ? text(conversation?.boundDocumentId || conversation?.homeDocumentId) || null
      : text(activeDocumentId || conversation?.boundDocumentId) || null)
    : null
);

export const resolveTurnAssociationChange = ({
  snapshot = {},
  current = {},
  explicitRetarget = false,
  sameWorkspace = null,
} = {}) => {
  const initialDocumentId = text(snapshot.boundDocumentId);
  const currentDocumentId = text(current.boundDocumentId);
  const workspaceMatches = sameWorkspace === null
    ? text(snapshot.workspacePath).toLocaleLowerCase("en-US") === text(current.workspacePath).toLocaleLowerCase("en-US")
    : sameWorkspace === true;
  if (explicitRetarget) return { action: "reroute", reason: "explicit_retarget", documentId: currentDocumentId };
  if (!snapshot.associationEnabled && !current.associationEnabled) return { action: "conversation_only", reason: "association_disabled" };
  if (initialDocumentId === currentDocumentId && workspaceMatches) return { action: "continue", reason: "association_unchanged", documentId: initialDocumentId };
  if (workspaceMatches) return { action: "keep_original_target", reason: "same_workspace_navigation", documentId: initialDocumentId };
  return { action: "confirm_target", reason: "cross_workspace_binding_change", documentId: initialDocumentId, currentDocumentId };
};

// Auto-create document decision
export const shouldAutoCreateDocument = ({ instruction, result, existingDocuments = {}, boundDocumentId = null }) => {
  if (!text(result?.candidate)) return { create: false, reason: "no_candidate" };
  const instructionText = text(instruction).toLowerCase();
  const candidateText = text(result.candidate);
  const explicitIntent = explicitNewDocumentIntent(instruction);
  if (explicitIntent.create) return {
    create: true,
    reason: explicitIntent.reason,
    documentKind: "document",
    suggestedTitle: explicitIntent.title,
  };
  // If instruction mentions creating new document/chapter/episode
  const createKeywords = ["新建", "创建", "新章", "新集", "新文档", "新卷", "新篇", "新增", "另起", "开新", "new chapter", "new document", "create document", "new episode", "new volume"];
  const shouldCreate = createKeywords.some(keyword => instructionText.includes(keyword.toLowerCase()));
  if (shouldCreate) return { create: true, reason: "explicit_create_instruction", documentKind: "chapter" };
  // If content starts with a chapter/episode heading, it's likely a new document
  const headingMatch = candidateText.match(/^(?:第[一二三四五六七八九十百千\d]+[章集卷篇回]|Chapter\s+\d+|Episode\s+\d+)/i);
  if (headingMatch && boundDocumentId && existingDocuments[boundDocumentId]) {
    const boundDoc = existingDocuments[boundDocumentId];
    const existingContent = text(boundDoc.content || "").trim();
    if (existingContent.length > 200 && !existingContent.startsWith(headingMatch[0])) {
      return { create: true, reason: "chapter_heading_detected", documentKind: boundDoc.documentKind || "chapter" };
    }
  }
  // If content is substantial and bound document already has content, suggest creating new
  if (boundDocumentId && existingDocuments[boundDocumentId]) {
    const boundDoc = existingDocuments[boundDocumentId];
    const existingContent = text(boundDoc.content || "").trim();
    const newContent = candidateText.trim();
    if (existingContent.length > 500 && newContent.length > 1000) {
      // Check if the new content seems to be a different topic/chapter
      const existingFirstLine = existingContent.split("\n")[0]?.trim() || "";
      const newFirstLine = newContent.split("\n")[0]?.trim() || "";
      const isDifferentTopic = existingFirstLine !== newFirstLine && !newContent.startsWith(existingContent.slice(0, 100));
      if (isDifferentTopic) {
        return { create: true, reason: "substantial_new_content", documentKind: boundDoc.documentKind || "chapter" };
      }
    }
  }
  return { create: false, reason: "not_needed" };
};

// Smart landing path analysis
export const analyzeSmartLandingPath = ({ instruction, result, boundDocumentId, documents = {}, moduleRootId = null, workspaceKind = "project" }) => {
  const candidate = text(result?.candidate || "");
  if (!candidate) return { action: "none", reason: "no_candidate" };

  // An explicit request to create a new document is authoritative. It must be
  // resolved before any continuation heuristic based on the associated file.
  const explicitCreate = shouldAutoCreateDocument({ instruction, result, existingDocuments: documents, boundDocumentId });
  if (explicitCreate.create && explicitCreate.reason === "explicit_new_document") {
    return {
      action: "create_and_land",
      target: "new",
      documentKind: explicitCreate.documentKind,
      reason: explicitCreate.reason,
      suggestedTitle: explicitCreate.suggestedTitle || extractSuggestedTitle(instruction, candidate),
    };
  }

  const boundDocument = boundDocumentId ? documents[boundDocumentId] : null;
  const boundContent = text(boundDocument?.content || boundDocument?.markdown || boundDocument?.html || "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const continuationIntent = continuationDestinationIntent(instruction);
  const explicitCurrentDocumentWrite = continuationIntent === "current"
    || /(?:追加到|写入|覆盖|修改|润色|优化).{0,12}(?:当前|本章|本节|这个|该)(?:文档|章节|章|节)|(?:在|向).{0,8}(?:当前|这个|该)(?:文档|章节).{0,8}(?:续写|追加|写入)/u.test(text(instruction));
  const genericContinuation = continuationIntent === "next";

  if (continuationIntent === "ambiguous") {
    return { action: "defer", reason: "ambiguous_continuation_requires_choice" };
  }

  // An empty document selected by the author is an intentional landing slot.
  if (boundDocument && !boundContent) {
    return { action: "land", target: "bound", documentId: boundDocumentId, reason: "blank_bound_document" };
  }

  // A generic continuation from a non-empty chapter starts a new chapter. The
  // author can still explicitly say "续写当前文档/本章" to append or patch it.
  if (boundDocument && genericContinuation && !explicitCurrentDocumentWrite) {
    return {
      action: "create_and_land",
      target: "new",
      documentKind: boundDocument.documentKind || "chapter",
      reason: "continuation_creates_next_document",
      suggestedTitle: extractSuggestedTitle(instruction, candidate),
    };
  }

  // If there's a bound document and content seems to continue it
  if (boundDocumentId && documents[boundDocumentId]) {
    const boundDoc = documents[boundDocumentId];
    const existingContent = boundContent;
    // Check if new content is a continuation/appendment
    const isContinuation = candidate.length < 5000 && (existingContent.length === 0 ||
      candidate.startsWith(existingContent.slice(0, 50)) ||
      (!candidate.includes("# ") && !candidate.includes("## ") && !candidate.match(/^第[一二三四五六七八九十百千\d]+[章集卷篇回]/m)));
    if (isContinuation && explicitCurrentDocumentWrite) {
      return { action: "land", target: "bound", documentId: boundDocumentId, reason: "continuation" };
    }
  }

  // Check if should create new document
  const createDecision = explicitCreate;
  if (createDecision.create) {
    return {
      action: "create_and_land",
      target: "new",
      documentKind: createDecision.documentKind,
      reason: createDecision.reason,
      suggestedTitle: extractSuggestedTitle(instruction, candidate)
    };
  }

  // If no bound document but content has chapter heading, create new
  if (!boundDocumentId && candidate.match(/^第[一二三四五六七八九十百千\d]+[章集卷篇回]/m)) {
    return {
      action: "create_and_land",
      target: "new",
      documentKind: "chapter",
      reason: "chapter_heading_no_bound",
      suggestedTitle: extractSuggestedTitle(instruction, candidate)
    };
  }

  // Default: land to bound document if exists
  if (boundDocumentId) {
    return { action: "land", target: "bound", documentId: boundDocumentId, reason: "default_bound" };
  }

  return { action: "defer", reason: "no_target" };
};

// Extract suggested title from instruction or content
const extractSuggestedTitle = (instruction, content) => {
  // Try to extract title from instruction
  const titleMatch = text(instruction).match(/(?:标题|title|名称|名字)[:：\s]+([^\n,，。；;]+)/i);
  if (titleMatch) return titleMatch[1].trim().slice(0, 100);
  // Try to extract chapter/episode heading from content
  const chapterMatch = content.match(/^(?:第([一二三四五六七八九十百千\d]+)[章集卷篇回])\s*(.+)$/m);
  if (chapterMatch) {
    const title = chapterMatch[2]?.trim();
    if (title) return title.slice(0, 100);
    return chapterMatch[0].trim().slice(0, 100);
  }
  // Try markdown heading
  const headingMatch = content.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim().slice(0, 100);
  // Try first non-empty line
  const firstLine = content.split("\n").find(line => line.trim().length > 0);
  if (firstLine) return firstLine.replace(/^#+\s*/, "").trim().slice(0, 100);
  return null;
};

// Batch landing analysis for multiple content pieces
export const analyzeBatchLanding = ({ items, boundDocumentId, documents = {} }) => {
  if (!Array.isArray(items) || !items.length) return [];
  const usedDocumentIds = new Set();
  return items.map((item, index) => {
    const decision = analyzeSmartLandingPath({
      instruction: item.instruction || "",
      result: { candidate: item.content || "" },
      boundDocumentId: index === 0 ? boundDocumentId : null,
      documents,
    });
    // For batch items after the first, prefer creating new documents
    if (index > 0 && decision.action === "land" && decision.target === "bound") {
      const candidateText = text(item.content || "");
      const suggestedTitle = extractSuggestedTitle(item.instruction || "", candidateText);
      return {
        ...item,
        landingDecision: {
          action: "create_and_land",
          target: "new",
          documentKind: "chapter",
          reason: "batch_item_auto_create",
          suggestedTitle,
        },
        index,
      };
    }
    return { ...item, landingDecision: decision, index };
  });
};
