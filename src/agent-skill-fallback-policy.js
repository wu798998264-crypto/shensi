const clean = (value = "") => String(value ?? "").trim();
const unique = (items = []) => [...new Set(items.map(clean).filter(Boolean))];

const skillId = (selection = {}) => clean(typeof selection === "string"
  ? selection
  : selection?.id || selection?.relativePath || selection?.name);

const explicitSelection = (selection = {}) => {
  if (typeof selection === "string") return true;
  const source = clean(selection?.source).toLowerCase();
  return selection?.explicit === true || /explicit|manual|user_selected|mention/.test(source);
};

const clauseMentionsSkill = (clause, selection) => {
  const name = clean(typeof selection === "string" ? selection : selection?.name || selection?.slotName);
  const id = skillId(selection).replace(/^user:/, "");
  return /@|skill|技能/i.test(clause)
    && ((!name && !id) || (name && clause.includes(name)) || (id && clause.includes(id)) || /@/.test(clause));
};

export const compileAgentSkillFallbackPolicy = ({
  instruction = "",
  requestedSkills = [],
  loadedSkillIds = [],
  explicitSkillIds = [],
  userInsists = false,
} = {}) => {
  const loaded = new Set(unique(loadedSkillIds).map((id) => id.replace(/^user:/, "")));
  const explicitIds = new Set(unique(explicitSkillIds).map((id) => id.replace(/^user:/, "")));
  const normalized = requestedSkills.map((selection) => ({
    selection,
    id: skillId(selection),
    explicit: explicitSelection(selection) || explicitIds.has(skillId(selection).replace(/^user:/, "")),
  })).filter((item) => item.id);
  const missing = normalized.filter((item) => !loaded.has(item.id.replace(/^user:/, "")));
  const missingExplicit = missing.filter((item) => item.explicit);
  const missingAutomatic = missing.filter((item) => !item.explicit);
  const source = clean(instruction);
  const clauses = source.split(/(?:[。！？；\n]+|，?(?:另外|同时|并且|然后|再者)\s*)/u).map(clean).filter(Boolean);
  const effectiveClauses = clauses.length ? clauses : [source || "current_request"];
  const blockedSubtasks = [];
  const runnableSubtasks = [];
  const warnings = [];

  effectiveClauses.forEach((description, index) => {
    const dependent = missingExplicit.filter((item) => (
      clauseMentionsSkill(description, item.selection)
      || (effectiveClauses.length === 1 && missingExplicit.length > 0)
    ));
    const id = `subtask-${index + 1}`;
    runnableSubtasks.push({
      id,
      description,
      ...(dependent.length ? {
        nativeFallback: true,
        assumptions: dependent.map((item) => `未读取 Skill ${item.id}；不得声称已执行或采用该 Skill`),
      } : {}),
    });
  });

  if (missingAutomatic.length) {
    warnings.push(`自动路由的 Skill 当前不可读取：${missingAutomatic.map((item) => item.id).join("、")}。继续使用 Agent 原生能力执行，不得声称已采用这些 Skill。`);
  }
  if (missingExplicit.length) {
    warnings.push(`用户指定或启用的 Skill 当前不可读取：${missingExplicit.map((item) => item.id).join("、")}。改用当前模型原生能力继续，但不得声称已执行这些 Skill。`);
  }

  return {
    missingSkillIds: missing.map((item) => item.id),
    missingExplicitSkillIds: missingExplicit.map((item) => item.id),
    missingAutomaticSkillIds: missingAutomatic.map((item) => item.id),
    blockedSubtasks,
    runnableSubtasks,
    warnings,
    nativeFallback: missing.length > 0,
    claimsMissingSkillUse: false,
    terminal: false,
  };
};

export const skillFallbackRecoveryDecision = ({ code = "", missingSkillIds = [] } = {}) => {
  const normalizedCode = clean(code).toUpperCase();
  if (!["SKILL_SELECTION_REQUIRED", "SKILL_REFERENCE_UNAVAILABLE"].includes(normalizedCode)) {
    return { action: "none", options: [], missingSkillIds: unique(missingSkillIds) };
  }
  return {
    action: "ask",
    options: ["retry", "choose_other", "continue_without"],
    missingSkillIds: unique(missingSkillIds),
  };
};

const presentEntries = (value = {}) => Object.entries(value && typeof value === "object" ? value : {})
  .filter(([, item]) => item !== undefined && item !== null && clean(item) !== "");

export const compileVisualPromptControlPolicy = ({ mode = "smart", explicitControls = {}, defaults = {} } = {}) => {
  const controls = Object.fromEntries(presentEntries(explicitControls));
  const filledDimensions = [];
  if (["precise", "precise_control", "full_control"].includes(clean(mode).toLowerCase())) {
    for (const [key, value] of presentEntries(defaults)) {
      if (Object.hasOwn(controls, key)) continue;
      controls[key] = value;
      filledDimensions.push(key);
    }
  }
  return { mode: filledDimensions.length ? "precise" : clean(mode) || "smart", controls, filledDimensions };
};
