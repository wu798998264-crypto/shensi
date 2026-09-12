import { compileTaskContract } from "../../src/task-contract.js";

// Simulated model outputs. Tests supply decisions explicitly; this fixture
// never classifies user text and is not shipped with the application.
export const agentDecision = ({ mode = "creative", intent = "commit", operation = "replace", taskKind = "content_creation", ...extra } = {}) => ({
  lane: mode === "creative_guidance" ? "guided_dialogue" : "task_execution",
  requestMode: mode, taskKind, confidence: 1,
  writePlan: { intent, operation },
  executionPlan: { candidateCount: intent === "candidate" ? 2 : 1, reviewTier: "none" },
  ...extra,
});

export const reportContract = ({ sourceMessageId = "report-request", documentId = "report-novel", requiredContextDocumentIds = [], persistence = "commit" } = {}) => compileTaskContract({
  sourceMessageId, taskType: "diagnosis", objective: "生成检查报告", operation: "replace",
  semanticSource: "agent", targetResolution: "exact", persistence,
  deliverables: [{ id: "report", kind: "review_report", targetDocumentId: documentId, title: "自检报告", target: { documentId, moduleId: "reports" } }],
  requiredContextDocumentIds,
});
