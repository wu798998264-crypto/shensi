import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  bindWorkspaceOperationConfirmation,
  normalizeWorkspaceOperationPlan,
  workspaceOperationConfirmationIsCurrent,
  workspacePlanRequiresConfirmation,
} from "../src/workspace-operations.js";

const planned = normalizeWorkspaceOperationPlan({
  intent: "整理现有章节",
  operations: [
    { type: "folder.ensure", moduleId: "manuscript", viewId: "novel", name: "第一卷" },
    { type: "document.move", documentId: "chapter-1", moduleId: "manuscript", viewId: "novel", folderLabel: "第一卷" },
  ],
}, {
  documentIds: ["chapter-1"],
  documentTitles: { "chapter-1": "第1章" },
  documentRevisions: { "chapter-1": "revision-1" },
});

assert.equal(workspacePlanRequiresConfirmation(planned), true, "模型规划的写入、新建、移动默认必须确认");
assert.equal(planned.confirmation.status, "pending");
assert.ok(planned.confirmation.planHash);

const explicitlyAuthorized = bindWorkspaceOperationConfirmation(planned, {
  required: false,
  source: "explicit_user_instruction",
  reason: "用户已明确目标和范围",
  workspaceRevision: "workspace-1",
});
assert.equal(workspacePlanRequiresConfirmation(explicitlyAuthorized), false, "确定性解析且与原指令一致时不得重复确认");
assert.equal(explicitlyAuthorized.confirmation.status, "authorized_by_instruction");
assert.equal(workspaceOperationConfirmationIsCurrent(explicitlyAuthorized, { workspaceRevision: "workspace-1" }), true);
assert.equal(workspaceOperationConfirmationIsCurrent(explicitlyAuthorized, { workspaceRevision: "workspace-2" }), false, "工作区变化后旧授权必须失效");

const tampered = structuredClone(explicitlyAuthorized);
tampered.operations[1].folderLabel = "第五卷";
assert.equal(workspaceOperationConfirmationIsCurrent(tampered, { workspaceRevision: "workspace-1" }), false, "确认后修改操作目标必须使操作哈希失效");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const agentTools = await readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8");
assert.doesNotMatch(app, /workspacePlanRequiresConfirmation\(completionMessage\.workspacePlan\)/u,
  "统一 Agent 完成后不得再交给旧 Chat 回调按关键词或旧计划二次执行");
assert.match(agentTools, /tool\("structure_apply"[\s\S]{0,1800}\["expectedRevision", "operationId", "operations"\]/u,
  "Agent 的结构管理必须使用带 revision 和幂等标识的原子事务工具");
assert.match(agentTools, /请先读取 documents\.structure 或 documents\.list 获取结构版本/u,
  "Agent 未真实读取结构版本时不得执行移动、复制、删除或重命名");
assert.match(agentTools, /interaction\.delivery 声明本轮是对话交付还是文档交付/u,
  "统一 Agent 必须声明真实交付结果，不能只在文字中声称完成");
assert.match(app, /workspaceOperationConfirmationIsCurrent\(plan,[\s\S]{0,160}workspaceOperationStateRevision/u, "执行前必须回读工作区结构版本");
assert.match(app, /automatic:\s*true,\s*confirmed:\s*true/u, "已有用户确认的作者驾驶舱操作必须显式传递确认状态");
assert.match(app, /确认并执行/u, "对话区必须明确显示确认操作按钮");
assert.match(app, /source:\s*"model_planner"[\s\S]{0,220}workspaceRevision/u, "模型规划必须绑定确认原因和工作区版本");

console.log("Shensi workspace operation confirmation passed");
