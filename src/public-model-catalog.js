const text = (value) => String(value ?? "").trim();

const zeroPrice = (value) => text(value) !== "" && Number(value) === 0;

const cleanModelLabel = (value, fallback = "") => {
  const raw = text(value) || text(fallback);
  if (!raw) return "";
  return raw
    .replace(/^[^/:：]{1,48}[:：]\s*/u, "")
    .replace(/^[^/]+\//u, "")
    .replace(/[（(]\s*(?:(?:free|免费|公益)|质量优先|(?:最新[·•\s]*)?速度优先|已退役别名|接口预留)\s*[）)]\s*$/iu, "")
    .replace(/(?:[:/_-]free|\s+free(?:\s+models?\s+router)?)$/iu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
};

export const modelDisplayName = (item = {}) => {
  const id = text(typeof item === "string" ? item : item.id || item.name || item.baseModelId);
  if (/^kilo-auto\/free$/iu.test(id)) return "Auto";
  if (/^openrouter\/free$/iu.test(id)) return "OpenRouter";
  const raw = text(typeof item === "string"
    ? item
    : item.display_name || item.displayName || item.label || item.name || id);
  const fallback = id.replace(/^models\//u, "").split("/").at(-1) || id;
  const cleaned = cleanModelLabel(raw, fallback);
  return cleaned || fallback.replace(/[:/_-]free$/iu, "").trim() || id;
};

export const freeModelDisplayName = modelDisplayName;
// User-facing selectors show the model name/version only. Availability and
// connection state stay in option state/title instead of becoming part of the
// model identity displayed to the user.
export const modelPickerDisplayName = (item = {}) => modelDisplayName(item) || text(typeof item === "string" ? item : item?.slug);

export const isFreePublicModel = (item = {}) => {
  const id = text(typeof item === "string" ? item : item.id || item.name || item.baseModelId).toLowerCase();
  if (!id) return false;
  if (/(?:content[-_ ]?safety|moderation|guardrail|classifier)/u.test(id)) return false;
  if (typeof item === "object" && item?.isFree === false) return false;
  const outputModalities = typeof item === "object" && Array.isArray(item?.architecture?.output_modalities)
    ? item.architecture.output_modalities.map((value) => text(value).toLowerCase()).filter(Boolean)
    : [];
  // This catalogue backs the dedicated text-writing connection. Models that
  // emit audio/image/video belong to their media channels and must not appear
  // as if they were prose-writing models merely because they also return text
  // metadata alongside the media result.
  if (outputModalities.length && (outputModalities.length !== 1 || outputModalities[0] !== "text")) return false;
  if (typeof item === "object" && item?.isFree === true) return true;
  if (/(?:^|[/:_-])free(?:$|[/:_-])/u.test(id)) return true;
  const pricing = typeof item === "object" && item ? item.pricing : null;
  return Boolean(pricing && zeroPrice(pricing.prompt) && zeroPrice(pricing.completion));
};

export const freePublicModels = (items = []) => (Array.isArray(items) ? items : []).filter(isFreePublicModel);
