const cleanSkillId = (value = "") => {
  const id = String(value ?? "").trim();
  return /^(?:builtin|user):[a-z0-9][a-z0-9._:-]*$/i.test(id) ? id : "";
};

const explicitObjectProperty = (value, key) => (
  value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
);

export const normalizeFixedSlotBinding = ({
  value = null,
  slotId = "",
  developerDefault = true,
  defaultSecondary = [],
  legacyOverride = "",
} = {}) => {
  const primary = explicitObjectProperty(value, "primary")
    ? cleanSkillId(value.primary)
    : cleanSkillId(legacyOverride) || (developerDefault ? cleanSkillId(slotId) : "");
  const secondarySource = Array.isArray(value?.secondary) ? value.secondary : defaultSecondary;
  const secondary = Array.from({ length: 3 }, (_, index) => cleanSkillId(secondarySource[index]));
  return { primary, secondary };
};

export const materializeFixedSlotBindings = ({ settings = {}, slots = [] } = {}) => {
  const stored = settings.skillSlotBindings && typeof settings.skillSlotBindings === "object"
    ? settings.skillSlotBindings : {};
  const legacy = settings.skillOverrides && typeof settings.skillOverrides === "object"
    ? settings.skillOverrides : {};
  return Object.fromEntries(slots.map((slot) => [slot.id, normalizeFixedSlotBinding({
    value: stored[slot.id],
    slotId: slot.id,
    developerDefault: slot.developerDefault !== false,
    defaultSecondary: slot.secondarySkillIds,
    legacyOverride: legacy[slot.id],
  })]));
};

const regexEscape = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const explicitSecondaryIndexForSlot = ({ text = "", slotName = "", slotAliases = [] } = {}) => {
  const source = String(text).replace(/\s+/g, " ").trim();
  const names = [...new Set([slotName, ...slotAliases].map((name) => String(name).trim()).filter(Boolean))];
  if (!source || !names.length) return -1;
  const number = "([123一二三])";
  const patterns = names.flatMap((name) => {
    const escapedName = regexEscape(name);
    return [
      new RegExp(`(?:使用|启用|调用|改用|换成|切换到|选择)\\s*[“\"']?${escapedName}[”\"']?\\s*(?:的)?\\s*(?:副|备用)插槽\\s*${number}`, "i"),
      new RegExp(`[“\"']?${escapedName}[”\"']?\\s*(?:的)?\\s*(?:副|备用)插槽\\s*${number}.{0,18}(?:替换|代替|接管|生效|使用|启用)`, "i"),
      new RegExp(`(?:让|由)\\s*[“\"']?${escapedName}[”\"']?\\s*(?:的)?\\s*(?:副|备用)插槽\\s*${number}.{0,18}(?:替换|代替|接管|执行|来写|来做)`, "i"),
      new RegExp(`(?:use|enable|activate|select|switch\\s+to)\\s+(?:the\\s+)?(?:secondary|backup)\\s+slot\\s+([123])\\s+(?:of|for)\\s+(?:the\\s+)?[\"']?${escapedName}[\"']?`, "i"),
      new RegExp(`(?:use|enable|activate|select|switch\\s+to)\\s+(?:the\\s+)?[\"']?${escapedName}[\"']?(?:'s)?\\s+(?:secondary|backup)\\s+slot\\s+([123])`, "i"),
    ];
  });
  const match = patterns.map((pattern) => source.match(pattern)).find(Boolean);
  if (!match) return -1;
  return ({ "1": 0, "一": 0, "2": 1, "二": 1, "3": 2, "三": 2 })[match[1]] ?? -1;
};

export const fixedSlotSelectionForPrompt = ({ settings = {}, slot = {}, text = "", slotAliases = [] } = {}) => {
  const bindings = materializeFixedSlotBindings({ settings, slots: [slot] });
  const binding = bindings[slot.id] ?? { primary: "", secondary: ["", "", ""] };
  const secondaryIndex = explicitSecondaryIndexForSlot({ text, slotName: slot.name, slotAliases });
  const skillId = secondaryIndex >= 0 ? binding.secondary[secondaryIndex] : binding.primary;
  return {
    skillId,
    bindingRole: secondaryIndex >= 0 ? "secondary" : "primary",
    secondaryIndex,
    explicitlyActivated: secondaryIndex >= 0,
  };
};
