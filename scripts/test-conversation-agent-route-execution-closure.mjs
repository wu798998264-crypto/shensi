import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlankNotebookState } from "../src/data.js";
import { catalogWithManagedPlacements, compileManagedRouteBundle } from "../src/managed-route-document.js";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";
import { saveWorkspaceState } from "../src/server/workspace.mjs";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /event\.type === "delivery_warning"/u, "界面必须单独接收验收提示");
assert.match(appSource, /pending\.content = event\.payload\.text/u, "完成事件必须优先显示最终结果正文");
assert.match(appSource, /deliveryWarnings\.length \? "soft_warning" : "complete"/u, "有验收提示时使用非阻断警告状态");
assert.match(appSource, /结果已正常显示/u, "任务卡必须说明结果没有被验收提示屏蔽");
assert.doesNotMatch(appSource, /event\.type === "progress"\) \{\s*pending\.streamText = ""/u, "交付复核进度不得清空已经生成的正文");

const root = await mkdtemp(join(tmpdir(), "shensi-route-closure-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "路由闭环测试");
  await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state: createBlankNotebookState({ name: "路由闭环测试", workspacePath }) });
  const skills = [{ id: "skill:article", name: "文章写作", description: "撰写正式文章" }];
  const routeBundle = compileManagedRouteBundle({
    topology: {
      revision: 1,
      hash: "d".repeat(64),
      capabilityTemplate: {
        template: { id: "template:route", name: "写作面板", relationType: "parallel", items: [{ id: "item:article", targetType: "group", targetId: "group:article" }] },
        groups: [{ id: "group:article", name: "文章模组", relationType: "parallel", items: [{ id: "item:module", targetType: "module", targetId: "module:article" }] }],
        modules: [{ id: "module:article", name: "文章模块", relationType: "parallel", slots: [{ id: "slot:article", skillId: "skill:article" }] }],
      },
    },
    skills,
  });
  const catalog = catalogWithManagedPlacements({ catalog: skills, routeBundle });
  const articlePlacement = routeBundle.skillPlacements[0];
  const events = [];
  let calls = 0;
  const invoke = async (tools, namespace, tool, args) => {
    const result = await tools.invoke({ namespace, tool, arguments: args });
    assert.equal(result.success, true, result.contentItems[0].text);
    return JSON.parse(result.contentItems[0].text);
  };
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => ({ skills: catalog, routeBundle }),
    readRoute: async () => ({ text: routeBundle.panel.text, routeBundle }),
    readSkill: async (id) => ({ id, name: "文章写作", text: "文章写作 Skill 真实全文", fullText: true }),
    run: async ({ workspaceToolRuntime, prompt }) => {
      calls += 1;
      if (calls === 1) {
        await invoke(workspaceToolRuntime, "routes", "read", { placementId: articlePlacement.modulePlacementId });
        const bypass = await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: {
          mode: "conversation", taskType: "formal_creation", routingMode: "general",
          routingReason: "只想在对话中交付，不需要专项能力", documentIds: [],
        } });
        assert.equal(bypass.success, false, "读取具体分支后不能把任务改报为通用问答");
        assert.match(bypass.contentItems[0].text, /已经读取面板能力分支/u);
        await invoke(workspaceToolRuntime, "interaction", "delivery", { mode: "conversation", taskType: "formal_creation", routingMode: "skills", documentIds: [] });
        return { text: "模块唯一 Skill 已在生成前自动读取。" };
      }
      const review = JSON.parse(prompt);
      assert.equal(review.delivery.routing.complete, true);
      return { text: review.result || "模块唯一 Skill 已在生成前自动读取。" };
    },
  });
  const started = await service.start({
    workspacePath,
    workspaceKind: "notebook",
    conversationId: "route-closure",
    sourceMessageId: "route-closure-user",
    instruction: "按文章 Skill 完成任务",
    messages: [{ role: "user", content: "按文章 Skill 完成任务" }],
    settings: { agentEngine: "codex_api", model: "mock" },
  });
  let result;
  for (let index = 0; index < 300; index += 1) {
    result = await service.status(started.id);
    if (["completed", "failed"].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.status, "completed", result.error);
  assert.equal(calls, 2, "对话交付只进行一次语义归档复核，不得反复补救");
  assert.ok(result.events.some((event) => event.type === "resource_read" && event.payload.kind === "skill" && event.payload.id === "skill:article"));
  assert.ok(result.events.some((event) => event.type === "route_decision" && event.payload.placementId === articlePlacement.placementId));
  assert.equal(result.events.filter((event) => event.type === "delivery_warning").length, 0);
  events.push(...result.events);

  const ambiguousSkills = [
    { id: "skill:article-a", name: "文章写作 A", description: "文章写作" },
    { id: "skill:article-b", name: "文章写作 B", description: "文章写作" },
  ];
  const ambiguousBundle = compileManagedRouteBundle({
    topology: {
      revision: 1,
      hash: "e".repeat(64),
      capabilityTemplate: {
        template: { id: "template:ambiguous", name: "多 Skill 面板", relationType: "parallel", items: [{ id: "item:group", targetType: "group", targetId: "group:ambiguous" }] },
        groups: [{ id: "group:ambiguous", name: "文章模组", relationType: "parallel", items: [{ id: "item:module", targetType: "module", targetId: "module:ambiguous" }] }],
        modules: [{ id: "module:ambiguous", name: "文章模块", relationType: "parallel", slots: [
          { id: "slot:a", skillId: "skill:article-a" },
          { id: "slot:b", skillId: "skill:article-b" },
        ] }],
      },
    },
    skills: ambiguousSkills,
  });
  const ambiguousCatalog = catalogWithManagedPlacements({ catalog: ambiguousSkills, routeBundle: ambiguousBundle });
  const ambiguousModulePlacementId = ambiguousBundle.skillPlacements[0].modulePlacementId;
  let ambiguousCalls = 0;
  const ambiguousService = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "ambiguous-runs"),
    skillCatalog: async () => ({ skills: ambiguousCatalog, routeBundle: ambiguousBundle }),
    readRoute: async () => ({ text: ambiguousBundle.panel.text, routeBundle: ambiguousBundle }),
    readSkill: async () => { throw new Error("多 Skill 模块未选择具体 Skill 时不得擅自读取"); },
    run: async ({ workspaceToolRuntime, deliveryReview, prompt }) => {
      ambiguousCalls += 1;
      if (deliveryReview) return { text: JSON.parse(prompt).result };
      await invoke(workspaceToolRuntime, "routes", "read", { placementId: ambiguousModulePlacementId });
      await invoke(workspaceToolRuntime, "interaction", "delivery", { mode: "conversation", taskType: "formal_creation", routingMode: "skills", documentIds: [] });
      return { text: "这份正文必须正常交付，不能被验收提示覆盖。" };
    },
  });
  const ambiguousStarted = await ambiguousService.start({
    workspacePath,
    workspaceKind: "notebook",
    conversationId: "ambiguous-route",
    sourceMessageId: "ambiguous-route-user",
    instruction: "生成一份对话正文",
    messages: [{ role: "user", content: "生成一份对话正文" }],
    settings: { agentEngine: "codex_api", model: "mock" },
  });
  let ambiguousResult;
  for (let index = 0; index < 300; index += 1) {
    ambiguousResult = await ambiguousService.status(ambiguousStarted.id);
    if (["completed", "failed"].includes(ambiguousResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ambiguousResult.status, "completed", ambiguousResult.error);
  assert.equal(ambiguousCalls, 2, "验收提示不得触发反复生成");
  assert.equal(ambiguousResult.text, "这份正文必须正常交付，不能被验收提示覆盖。");
  assert.match(ambiguousResult.deliveryWarnings.join("\n"), /没有真实读取对应 Skill/u);
  assert.ok(ambiguousResult.events.some((event) => event.type === "delivery_warning"));

  let reviewFailureCalls = 0;
  const reviewFailureService = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "review-failure-runs"),
    skillCatalog: async () => ({ skills: catalog, routeBundle }),
    readRoute: async () => ({ text: routeBundle.panel.text, routeBundle }),
    readSkill: async () => { throw new Error("通用问答不应读取 Skill"); },
    run: async ({ workspaceToolRuntime, deliveryReview }) => {
      reviewFailureCalls += 1;
      if (deliveryReview) throw new Error("验收服务暂时不可用");
      await invoke(workspaceToolRuntime, "interaction", "delivery", {
        mode: "conversation",
        taskType: "general_qa",
        routingMode: "general",
        routingReason: "普通概念问答不需要面板专项能力",
        documentIds: [],
      });
      return { text: "主生成结果必须保留。" };
    },
  });
  const reviewFailureStarted = await reviewFailureService.start({
    workspacePath,
    workspaceKind: "notebook",
    conversationId: "review-failure",
    sourceMessageId: "review-failure-user",
    instruction: "回答普通问题",
    messages: [{ role: "user", content: "回答普通问题" }],
    settings: { agentEngine: "codex_api", model: "mock" },
  });
  let reviewFailureResult;
  for (let index = 0; index < 300; index += 1) {
    reviewFailureResult = await reviewFailureService.status(reviewFailureStarted.id);
    if (["completed", "failed"].includes(reviewFailureResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reviewFailureResult.status, "completed", reviewFailureResult.error);
  assert.equal(reviewFailureCalls, 2);
  assert.equal(reviewFailureResult.text, "主生成结果必须保留。");
  assert.match(reviewFailureResult.deliveryWarnings.join("\n"), /交付复核未完成：验收服务暂时不可用/u);
  assert.ok(reviewFailureResult.events.some((event) => event.type === "delivery_warning"));

  let generalCalls = 0;
  const generalService = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "general-runs"),
    skillCatalog: async () => ({ skills: catalog, routeBundle }),
    readRoute: async () => ({ text: routeBundle.panel.text, routeBundle }),
    readSkill: async () => { throw new Error("通用问答不应读取 Skill"); },
    run: async ({ workspaceToolRuntime, deliveryReview, prompt }) => {
      generalCalls += 1;
      if (deliveryReview) return { text: JSON.parse(prompt).result };
      await invoke(workspaceToolRuntime, "interaction", "delivery", {
        mode: "conversation",
        taskType: "general_qa",
        routingMode: "general",
        routingReason: "用户只询问当前界面的普通概念，不需要任何面板专项能力",
        documentIds: [],
      });
      return { text: "通用回答" };
    },
  });
  const generalStarted = await generalService.start({
    workspacePath,
    workspaceKind: "notebook",
    conversationId: "general-route",
    sourceMessageId: "general-route-user",
    instruction: "解释什么是字数",
    messages: [{ role: "user", content: "解释什么是字数" }],
    settings: { agentEngine: "codex_api", model: "mock" },
  });
  let generalResult;
  for (let index = 0; index < 300; index += 1) {
    generalResult = await generalService.status(generalStarted.id);
    if (["completed", "failed"].includes(generalResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(generalResult.status, "completed", generalResult.error);
  assert.equal(generalResult.events.filter((event) => event.type === "resource_read" && event.payload.kind === "skill").length, 0);
  assert.ok(generalCalls >= 1);
  console.log("Conversation Agent route execution closure and explicit Skill-free general routing passed");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
