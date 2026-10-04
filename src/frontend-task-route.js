// A deliberately small, deterministic hint used before the full capability
// route is loaded.  It is never an execution authority: panel candidates are
// still routed by the existing server/compiler path, while only a high-
// confidence general-chat hint may skip the expensive panel catalogue read.

const PANEL_TERMS = [
  /作品|小说|正文|章节|大纲|剧本|短剧|分镜|提示词|创作|续写|改写|生成|修改|保存|落盘|文档|笔记|白板|面板|模块|模组|路由|资料|附件|选区|skill/iu,
  /project|novel|chapter|outline|script|prompt|create|generate|edit|save|document|notebook|canvas/iu,
];

const GENERAL_TERMS = /^(?:你好|嗨|hello|hi|谢谢|好的|明白了|什么是|为什么|怎么|如何|能否|可以吗|请解释|解释一下|帮我理解)/iu;

const textHasPanelSignal = (text = "") => PANEL_TERMS.some((pattern) => pattern.test(String(text || "")));

export const buildFrontendTaskRoute = ({
  text = "",
  workspaceKind = "project",
  routeRevision = 0,
  hasAttachments = false,
  hasReferences = false,
  hasSelection = false,
} = {}) => {
  const prompt = String(text || "").trim();
  const resourceSignal = Boolean(hasAttachments || hasReferences || hasSelection);
  const panelSignal = textHasPanelSignal(prompt);
  // Short exact-reply probes are ordinary conversation even when they are
  // sent from a notebook/project surface. Keep the whitelist narrow so a
  // creative instruction that merely contains “回复” still enters the full
  // panel route.
  const shortReplyProbe = /^(?:请(?:用[^：:\n]{0,12})?(?:回答|回复|输出)|(?:只|仅)(?:回复|输出)|(?:回答|回复|输出))(?::|：|\s|$)/u.test(prompt)
    && prompt.length <= 160;
  const explicitGeneral = (GENERAL_TERMS.test(prompt) || shortReplyProbe) && prompt.length <= 160;
  // The notebook/project surface is context, not proof that the current turn
  // needs the full panel route.  Treating every notebook message as a panel
  // task forced ordinary OpenCode/WorkBuddy turns through catalogue loading,
  // document preloads and delivery review; after a few turns that extra work
  // could exhaust the runner's active timeout even though the user only asked
  // a normal question.  Explicit panel signals and resources remain
  // authoritative, while an unmarked short question can use the lightweight
  // general lane on either surface.
  const panelCandidate = resourceSignal || panelSignal;
  if (panelCandidate) {
    return {
      schemaVersion: 1,
      routeRevision: Math.max(0, Number(routeRevision) || 0),
      kind: "panel_candidate",
      confidence: resourceSignal || panelSignal ? 0.98 : 0.82,
      reason: resourceSignal ? "本轮包含资料、附件或选区" : "本轮出现面板/创作任务信号",
      requiresPanelRoute: true,
    };
  }
  if (explicitGeneral || /[?？]$/u.test(prompt)) {
    return {
      schemaVersion: 1,
      routeRevision: Math.max(0, Number(routeRevision) || 0),
      kind: "general_chat",
      confidence: explicitGeneral ? 0.98 : 0.86,
      reason: explicitGeneral ? "短问句且未命中面板能力" : "未命中面板能力关键词",
      requiresPanelRoute: false,
    };
  }
  // Uncertainty must stay on the safe side and load the full route.
  return {
    schemaVersion: 1,
    routeRevision: Math.max(0, Number(routeRevision) || 0),
    kind: "panel_candidate",
    confidence: 0.5,
    reason: "任务边界不明确，保守读取面板路由",
    requiresPanelRoute: true,
  };
};

export const frontendRouteCanUseGeneralLane = (route = null) => Boolean(
  route
  && route.schemaVersion === 1
  && route.kind === "general_chat"
  && route.requiresPanelRoute === false
  && Number(route.confidence) >= 0.85,
);
