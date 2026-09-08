export const fixedSlotMatchesTask = (slot, {
  workspaceMode,
  contextDomain,
  deliverableType,
  prompt = "",
  matchTriggers = true,
  semanticCapabilitiesAuthoritative = false,
} = {}) => {
  if (!slot) return false;
  const modes = slot.workspaceModes ?? ["general"];
  if (!modes.some((mode) => mode === "general" || mode === workspaceMode)) return false;
  const domains = slot.contextDomains ?? [];
  const deliverables = slot.deliverableTypes ?? [];
  if (deliverables.length) {
    if (deliverableType && !deliverables.includes(deliverableType)) return false;
    if (!deliverableType && !domains.length) return false;
  }
  if ((!deliverables.length || !deliverableType) && domains.length && !domains.includes(contextDomain)) return false;
  const keywords = slot.triggerKeywords ?? [];
  if (!semanticCapabilitiesAuthoritative && matchTriggers && keywords.length && !keywords.some((keyword) => String(prompt).includes(keyword))) return false;
  return true;
};

const capabilityIsRequired = (slot, requiredCapabilities, deliverableType) => (slot?.replacementCapabilities ?? [])
  .some((capability) => requiredCapabilities.has(capability)
    || (capability === "memory_advisor" && requiredCapabilities.has("memory_update"))
    || (capability === "knowledge_reference" && deliverableType === "book_deconstruction"));

export const resolveConfiguredFixedSlotSelections = ({
  selections = [],
  slots = [],
  groups = [],
  requiredCapabilities = new Set(),
  activeOrganizationGroupIds = [],
  task = {},
  semanticCapabilitiesAuthoritative = false,
} = {}) => {
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const configuredBySlotId = new Map(selections.map((selection) => [selection.slotId, selection]));
  const selectedBySlotId = new Map();
  const addSelection = (selection, { matchTriggers = true } = {}) => {
    const slot = slotById.get(selection?.slotId);
    if (!fixedSlotMatchesTask(slot, { ...task, matchTriggers, semanticCapabilitiesAuthoritative })) return false;
    if (!capabilityIsRequired(slot, requiredCapabilities, task.deliverableType)) return false;
    const group = groupById.get(slot.parentGroupId);
    selectedBySlotId.set(selection.slotId, {
      ...selection,
      organizationGroupId: group?.groupType === "organization" ? group.id : "",
      organizationRole: group?.groupType === "organization"
        ? group.leaderSlotId === slot.id ? "leader" : "member"
        : "",
    });
    return true;
  };

  for (const selection of selections) addSelection(selection);
  for (const selection of [...selectedBySlotId.values()]) {
    if (selection.organizationRole !== "member") continue;
    const group = groupById.get(selection.organizationGroupId);
    const leaderSelection = configuredBySlotId.get(group?.leaderSlotId);
    if (leaderSelection) addSelection(leaderSelection, { matchTriggers: false });
  }
  for (const groupId of new Set(activeOrganizationGroupIds ?? [])) {
    const group = groupById.get(groupId);
    if (group?.groupType !== "organization" || !group.leaderSlotId) continue;
    const leaderSelection = configuredBySlotId.get(group.leaderSlotId);
    if (leaderSelection) addSelection(leaderSelection, { matchTriggers: false });
  }
  return [...selectedBySlotId.values()];
};
