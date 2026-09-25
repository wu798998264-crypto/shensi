import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInitialCapabilityTemplate, normalizeCapabilityTemplate } from "../src/capability-template.js";
import { buildAdaptiveTaskRoute, classifyRequestMode, continuesPriorCreativeTask } from "../src/request-routing.js";

const context = { targetDocumentId: "chapter-3", targetModuleId: "manuscript", continuesCreativeThread: true };
for (const text of ["我不知道接下来怎么写", "卡住了！", "下一步该怎么推进？", "救命，好乱啊"]) {
  assert.equal(classifyRequestMode({ text, ...context }).mode, "creative", `${text} 应保留创作任务边界并由面板选择模块`);
  assert.equal(buildAdaptiveTaskRoute({ text, ...context }, { executionSurface: "agent" }).selectedCapabilityNodeId, undefined, `${text} 不得由软件预选引导或主笔`);
}
const explicitGuidance = classifyRequestMode({ text: "请开启创作引导", targetDocumentId: "", targetModuleId: "", continuesCreativeThread: false });
assert.equal(explicitGuidance.mode, "creative");
assert.equal(explicitGuidance.panelRouteDelegated, true);
assert.equal(classifyRequestMode({ text: "为什么软件生成失败", ...context }).mode, "general", "软件诊断不能误进创作引导");
assert.equal(classifyRequestMode({ text: "直接写下一章", ...context }).mode, "creative", "明确直写不能被中途引导覆盖");

const conceptAnswer = "一个失去记忆的天体维修师，为了阻止悬空城市坠毁，必须在一夜内修复被人为切断的重力锚；如果失败，整座城市都会坠入云海。";
assert.equal(continuesPriorCreativeTask({
  text: conceptAnswer,
  previousRequestMode: "creative_guidance",
  previousAssistantHasCreativeContext: true,
}), true, "创作引导提出问题后，较长的自然语言回答必须继续沿用创作引导");
assert.equal(classifyRequestMode({ text: conceptAnswer, ...context, guidanceActive: true }).mode, "creative", "引导回答保留创作边界，具体模块由 Agent 读取面板决定");
assert.equal(continuesPriorCreativeTask({ text: "为什么软件生成失败", previousRequestMode: "creative_guidance" }), false, "创作引导之后的软件诊断仍须退出创作链");
assert.equal(continuesPriorCreativeTask({ text: "帮我写一封求职邮件。", previousRequestMode: "creative_guidance" }), false, "创作引导之后的非神思产物不能被误当作引导回答");

const panel = createInitialCapabilityTemplate();
assert.match(panel.template.triggerRules, /任何阶段/u, "面板总路由必须声明创作引导可在写作任意阶段启用");
assert.match(panel.template.triggerRules, /不要求固定关键词/u, "面板总路由必须按完整语义判断而非关键词抢判");
for (const moduleId of ["module:novel-guidance", "module:short-drama-guidance", "module:short-fiction-guidance", "module:public-account-guidance", "module:short-video-guidance", "module:prompt-guidance"]) {
  const module = panel.modules.find((item) => item.id === moduleId);
  assert.match(module?.triggerRules || "", /不要求固定关键词/u, `${moduleId} 必须包含语义触发规则`);
  assert.match(module?.triggerRules || "", /明确要求/u, `${moduleId} 必须保留直接执行边界`);
}
const legacyPanel = structuredClone(panel);
legacyPanel.schemaVersion = 31;
legacyPanel.template.triggerRules = "可信任务路由读取完整模板，根据任务意图选择能力。";
for (const module of legacyPanel.modules) {
  if (module.id.endsWith("-guidance")) module.triggerRules = "创作合同尚未完整时启用。";
}
const migratedPanel = normalizeCapabilityTemplate(legacyPanel);
assert.equal(migratedPanel.schemaVersion, 32);
assert.match(migratedPanel.template.triggerRules, /不要求固定关键词/u, "已保存官方面板必须迁移到语义触发规则");
assert.match(migratedPanel.modules.find((item) => item.id === "module:novel-guidance")?.triggerRules || "", /任何阶段/u, "已有小说引导模块必须迁移");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /previousAssistantRequestMode[\s\S]{0,420}previousAssistantMessage\?\.execution\?\.taskRoute\?\.mode/u, "续接路由必须优先读取上一轮 Agent 任务卡的真实模式");
assert.match(appSource, /taskRuntime\?\.messages \|\| conversationMessagesForTaskState[\s\S]{0,900}pendingMessage\.pending = false/u, "停止按钮必须在当前真实任务运行时中同步终止任务卡");

console.log("creative guidance mid-writing routing: ok");
