const clean = (value = "") => String(value ?? "").replace(/\s+/gu, " ").trim();
const comparablePath = (value = "") => clean(value).replace(/\\/gu, "/").replace(/\/+$/gu, "").toLocaleLowerCase("en-US");
const comparableName = (value = "") => clean(value).toLocaleLowerCase("zh-CN");

const EXPLICIT_PROJECT_PROMOTION = /(?:以|把|将|用|根据).{0,24}(?:当前|这篇|这份|这些|本篇|本笔记|笔记).{0,24}(?:创建|建立|新建|转成|转为|归入|迁移到).{0,12}(?:作品|项目)|(?:创建|建立|新建).{0,12}(?:作品|项目).{0,24}(?:当前|这篇|这份|这些|本篇|本笔记|笔记)/u;
const EXPLICIT_PROJECT_TARGET = /(?:写入|落盘|保存|归入|放到|移动到|转到).{0,20}(?:作品|项目)[《「『“‘"']?([^》」』”’"'，。；;！!？?\n]{1,80})?/u;
const EXPLICIT_NOTEBOOK_TARGET = /(?:写入|落盘|保存|归入|放到|移动到|转到).{0,20}(?:笔记本|笔记)[《「『“‘"']?([^》」』”’"'，。；;！!？?\n]{1,80})?/u;

export const explicitWorkspaceTransitionIntent = ({ instruction = "", currentWorkspaceKind = "project" } = {}) => {
  const source = clean(instruction);
  const projectMatch = source.match(EXPLICIT_PROJECT_TARGET);
  const notebookMatch = source.match(EXPLICIT_NOTEBOOK_TARGET);
  if (EXPLICIT_PROJECT_PROMOTION.test(source)) return {
    explicit: true,
    targetWorkspaceKind: "project",
    operation: currentWorkspaceKind === "notebook" ? "promote_notebook_content" : "create_project",
    targetWorkspaceName: clean(projectMatch?.[1]),
  };
  if (projectMatch) return { explicit: true, targetWorkspaceKind: "project", operation: "route", targetWorkspaceName: clean(projectMatch[1]) };
  if (notebookMatch) return { explicit: true, targetWorkspaceKind: "notebook", operation: "route", targetWorkspaceName: clean(notebookMatch[1]) };
  return { explicit: false, targetWorkspaceKind: currentWorkspaceKind === "notebook" ? "notebook" : "project", operation: "stay", targetWorkspaceName: "" };
};

export const resolveWorkspaceLandingScope = ({
  workspaceKind = "project",
  workspacePath = "",
  workspaceName = "",
  instruction = "",
  explicitTargetWorkspaceKind = "",
  explicitTargetWorkspacePath = "",
  explicitTargetWorkspaceName = "",
} = {}) => {
  const currentKind = workspaceKind === "notebook" ? "notebook" : "project";
  const transition = explicitWorkspaceTransitionIntent({ instruction, currentWorkspaceKind: currentKind });
  const requestedKind = explicitTargetWorkspaceKind === "notebook" || explicitTargetWorkspaceKind === "project"
    ? explicitTargetWorkspaceKind
    : transition.targetWorkspaceKind;
  const requestedPath = clean(explicitTargetWorkspacePath);
  const requestedName = clean(explicitTargetWorkspaceName || transition.targetWorkspaceName);
  const explicitSameKindPathChange = requestedKind === currentKind
    && Boolean(requestedPath)
    && comparablePath(requestedPath) !== comparablePath(workspacePath);
  const explicitSameKindNameChange = requestedKind === currentKind
    && Boolean(requestedName)
    && comparableName(requestedName) !== comparableName(workspaceName)
    && (transition.explicit || Boolean(clean(explicitTargetWorkspaceKind)));
  const crossWorkspace = requestedKind !== currentKind || explicitSameKindPathChange || explicitSameKindNameChange;
  return {
    workspaceKind: requestedKind,
    workspacePath: crossWorkspace ? requestedPath : clean(workspacePath),
    workspaceName: crossWorkspace ? requestedName : clean(workspaceName),
    crossWorkspace,
    authorized: !crossWorkspace || transition.explicit || Boolean(clean(explicitTargetWorkspaceKind)),
    operation: transition.operation,
    reason: crossWorkspace
      ? (transition.explicit || explicitTargetWorkspaceKind ? "explicit_workspace_transition" : "cross_workspace_not_authorized")
      : "current_workspace_is_authoritative",
  };
};

const sectionForBlock = (block = "") => {
  const value = clean(block);
  if (!value) return "";
  if (/(?:人物设定|角色设定|世界观|规则|地点设定|势力设定|能力设定)/u.test(value)) return "canon";
  if (/(?:故事大纲|剧情大纲|章节规划|分卷规划|后续剧情|情节走向|伏笔回收)/u.test(value)) return "outline";
  if (/(?:长期记忆|连续性|已确认事实|人物当前状态|信息释放|读者知情)/u.test(value)) return "memory";
  if (/(?:第[零〇一二两三四五六七八九十百千万\d]+章|第[零〇一二两三四五六七八九十百千万\d]+集|正文|场\s*\d+|内景|外景)/u.test(value)) return "manuscript";
  return "library";
};

export const planNotebookContentPromotion = ({ title = "", content = "", requestedProjectName = "" } = {}) => {
  const source = String(content ?? "").replace(/\r\n?/gu, "\n").trim();
  const blocks = source.split(/\n\s*\n/gu).map((item) => item.trim()).filter(Boolean);
  const grouped = new Map();
  for (const block of blocks) {
    const section = sectionForBlock(block);
    const values = grouped.get(section) ?? [];
    values.push(block);
    grouped.set(section, values);
  }
  const baseTitle = clean(title) || "当前笔记资料";
  const documents = [...grouped.entries()].map(([moduleId, values]) => ({
    moduleId,
    title: moduleId === "library" ? baseTitle : `${baseTitle} · ${{ canon: "设定", outline: "大纲", manuscript: "正文", memory: "记忆" }[moduleId]}`,
    content: values.join("\n\n"),
  })).filter((item) => item.content.trim());
  if (source && !documents.some((item) => item.moduleId === "library")) documents.unshift({ moduleId: "library", title: baseTitle, content: source });
  return {
    operation: "promote_notebook_content",
    projectName: clean(requestedProjectName) || baseTitle,
    preserveSource: true,
    createEmptySections: false,
    documents,
  };
};
