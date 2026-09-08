import assert from "node:assert/strict";

import { authorizeFormalMutation } from "../src/formal-mutation-permission.js";
import { compileTaskContract } from "../src/task-contract.js";
import { formalTargetCompatibility } from "../src/formal-target-compatibility.js";

const target = { documentId: "canon-characters", moduleId: "canon", title: "人物设定" };
const contract = compileTaskContract({
  sourceMessageId: "contract-fact-1",
  taskType: "modification",
  operation: "patch",
  persistence: "commit",
  targetResolution: "exact",
  instruction: "按已确认任务更新人物设定",
  deliverables: [{ kind: "setting", target }],
});

assert.equal(authorizeFormalMutation({
  instruction: "按已确认任务执行",
  plan: { primaryTargets: [target] },
  targets: [target],
  taskContract: contract,
}).ok, true, "有效 commit TaskContract 应成为设定目标的授权依据");

assert.equal(authorizeFormalMutation({
  instruction: "把林昭的身份改为巡灯人，其余不变。",
  targets: [target],
  taskContract: contract,
}).ok, true, "有效合同不依赖旧 primaryTargets 清单或句子关键词");

assert.equal(authorizeFormalMutation({
  instruction: "更新人物设定文档",
  plan: { primaryTargets: [target] },
  targets: [target],
  taskContract: { ...contract, targetResolution: "ambiguous" },
}).ok, false, "无效权威合同不能通过关键词或旧计划绕过");

assert.equal(authorizeFormalMutation({
  instruction: "按已确认任务执行",
  plan: { primaryTargets: [target] },
  targets: [{ ...target, moduleId: "outline" }],
  taskContract: contract,
}).ok, false, "目标板块与合同类型不匹配时必须阻断");

for (const projection of [
  { documentId: "memory-reader", moduleId: "memory" },
  { documentId: "index-update-log", moduleId: "index" },
]) {
  const projectionContract = compileTaskContract({
    ...contract,
    deliverables: [{ kind: "document", target: projection }],
  });
  assert.equal(authorizeFormalMutation({
    instruction: "按已确认任务执行",
    plan: { primaryTargets: [projection] },
    targets: [projection],
    taskContract: projectionContract,
  }).ok, false, "权威合同不能让普通正文覆盖系统投影");
}

assert.equal(authorizeFormalMutation({
  instruction: "按已确认任务执行",
  plan: { primaryTargets: [target] },
  targets: [target],
}).ok, false, "未传 TaskContract 时仍保留设定关键词门禁");

const candidateOnly = compileTaskContract({
  ...contract,
  persistence: "candidate_only",
});
assert.equal(authorizeFormalMutation({
  instruction: "按已确认任务执行",
  plan: { primaryTargets: [target] },
  targets: [target],
  taskContract: candidateOnly,
}).ok, false, "candidate_only 不得直接授权正式设定写入");

const wrongTarget = { documentId: "outline-series", moduleId: "outline", title: "全集大纲" };
assert.equal(authorizeFormalMutation({
  instruction: "按已确认任务执行",
  plan: { primaryTargets: [wrongTarget] },
  targets: [wrongTarget],
  taskContract: contract,
}).ok, false, "合同未列出的目标仍必须阻断");

assert.equal(formalTargetCompatibility({
  instruction: "按已确认任务执行",
  target,
  taskContract: contract,
}).compatible, true, "有效合同应同时作为目标板块兼容性的权威来源");

console.log("TaskContract formal fact authorization tests passed");
