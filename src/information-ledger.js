const clean = (value, max = 800) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

const hashText = (value) => {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const safeId = (value) => clean(value, 100).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

const inferredName = (value) => {
  const source = clean(value, 800);
  const first = source.split(/[：:；;。\n]|\s[-—]\s/)[0]?.trim();
  return clean(first || source, 80) || "未命名信息";
};

export const stableLedgerEntryId = ({ id = "", name = "", kind = "information" } = {}) => {
  const explicit = safeId(id);
  if (explicit) return explicit.startsWith(`${kind}-`) ? explicit : `${kind}-${explicit}`;
  const normalizedName = clean(name, 120).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return `${kind}-${hashText(normalizedName || "unnamed")}`;
};

export const normalizeLedgerEntries = (value, { kind = "information", maxItems = 24 } = {}) => (Array.isArray(value) ? value : [])
  .map((item) => {
    const object = item && typeof item === "object" && !Array.isArray(item) ? item : null;
    const detail = clean(object?.detail ?? object?.content ?? object?.description ?? (object ? "" : item), 1200);
    const name = clean(object?.name ?? object?.title ?? object?.information ?? inferredName(detail), 120);
    if (!name && !detail) return null;
    return {
      id: stableLedgerEntryId({ id: object?.id, name: name || detail, kind }),
      name: name || inferredName(detail),
      state: clean(object?.state ?? object?.status, 120),
      chapter: clean(object?.chapter ?? object?.sourceChapter, 120),
      detail,
      allowedWriting: clean(object?.allowedWriting ?? object?.allowed ?? object?.permission, 400),
    };
  })
  .filter(Boolean)
  .slice(0, maxItems);
