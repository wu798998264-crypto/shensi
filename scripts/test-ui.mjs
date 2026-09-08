import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const focus = String(process.env.SHENSI_UI_FOCUS || "all");
const check = (pattern, message, source = app) => assert.match(source, pattern, message);

check(/button "收起左侧目录栏"|收起左侧目录栏/u, "directory collapse control must remain accessible");

if (focus === "all" || focus === "whiteboard-directory-contexts") {
  check(/三击白板创建 AI 生成目标/u, "whiteboard triple-click must open the shared AI target flow");
  check(/whiteboardSelectedEdgeIds/u, "whiteboard must support multi-edge selection");
  check(/data-whiteboard-action="preview"[^>]*data-whiteboard-text-only/u, "whiteboard text cards must expose read-only preview");
  check(/whiteboard-edge-group\.selected/u, "selected edges must have visible state", styles);
  const previewIndex = app.indexOf('data-whiteboard-action="preview"');
  const historyIndex = app.indexOf('data-whiteboard-action="history"', previewIndex);
  assert.ok(previewIndex >= 0 && historyIndex > previewIndex, "whiteboard Preview must be above History");
  check(/data-whiteboard-action="upload-card"/u, "whiteboard cards must support upload-and-replace");
  check(/pushWhiteboardHistory\(beforeCanvas, \{ label: `上传覆盖卡片/u, "card upload must save the prior canvas version");
}
if (focus === "all" || focus === "attachment-preview-pan" || focus === "conversation-attachment-references") {
  check(/clipboardImageFiles/u, "conversation clipboard must ingest image files");
  check(/attachment-preview-dialog/u, "attachments must use the shared preview dialog");
  check(/attachment-preview-close[\s\S]{0,500}border-radius:\s*50%/u, "attachment close control must stay circular", styles);
  check(/attachmentPreviewScale = Math\.min\(20/u, "attachment previews must support the expanded zoom range");
  check(/textPreview && !event\.ctrlKey && !event\.metaKey/u, "text previews must support Ctrl+wheel font scaling");
}
if (focus === "all" || focus === "conversation-concurrency" || focus === "agent-stuck-lifecycle") {
  check(/data-edit-queued/u, "queued messages must support inline editing");
  check(/data-send-edited-queued/u, "edited queue messages must re-enter scheduling from the same item");
  check(/status:\s*"running"/u, "active tasks must retain a running lifecycle state");
}
if (focus === "all" || focus === "workspace-performance") {
  check(/scheduleWorkspaceSwitchPrefetch|workspaceSwitchCache|prefetchWorkspace/u, "workspace switching must include an incremental cache or prefetch path");
}
if (focus === "all" || focus === "image-card-editor-interactions") {
  check(/openWhiteboardImageEditor|imageCardEditor/u, "image cards must route to the image editor");
}
if (focus === "all" || focus === "author-cockpit-decisions") {
  check(/id="authorCockpitDecisionDialog"/u, "project overview decisions must open a dedicated instruction dialog");
  check(/data-open-cockpit-decision/u, "decision summary cards must open the shared instruction dialog");
  check(/const selected = pendingDecisionItems\(pendingDocument\)\.filter/u, "batch execution must derive its targets from persisted confirmed items");
  assert.doesNotMatch(app, /authorCockpitSelectedDecisionIds|data-select-cockpit-decision/u, "decision execution must not depend on manual checkboxes");
  check(/status:\s*"pending"[\s\S]{0,180}draftOpinion:\s*item\.draftOpinion \|\| item\.opinion/u, "editing a confirmed decision must restore pending state without clearing the draft");
  check(/persistCockpitDecisionDraftSoon\(\)/u, "decision drafts must schedule durable workspace persistence");
}

console.log(`Shensi UI contract passed (${focus})`);
