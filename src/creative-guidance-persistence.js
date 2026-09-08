const clean = (value = "") => String(value ?? "").trim().toLocaleLowerCase();

export const creativeGuidancePersistentContractKey = ({ deliverableType = "", sourceMode = "" } = {}) => {
  const deliverable = clean(deliverableType);
  const source = clean(sourceMode);
  if (deliverable === "novel") return "novelCreativeContract";
  if (deliverable === "short_drama_script" && source === "original") return "originalDramaCreativeContract";
  return "";
};

export const persistentCreativeGuidanceContract = ({ conversation = null, deliverableType = "", sourceMode = "" } = {}) => {
  const key = creativeGuidancePersistentContractKey({ deliverableType, sourceMode });
  return key && conversation && typeof conversation === "object" ? conversation[key] ?? null : null;
};
