const clean = (value = "") => String(value || "").trim();

const normalizedProvider = (value = "") => clean(value).toLowerCase().replace(/[\s_-]+/gu, "");

const providerNamespace = (value = "") => {
  const key = normalizedProvider(value);
  return ({ openai: "openai", deepseek: "deepseek", anthropic: "anthropic", google: "google" })[key]
    || key.replace(/[^a-z0-9.-]/gu, "");
};

export const openCodeCatalogCacheKey = ({ runner = "opencode", credentialSource = "opencode", provider = "", baseUrl = "" } = {}) => [
  clean(runner).toLowerCase() || "opencode",
  credentialSource === "shensi" ? "shensi" : "opencode",
  normalizedProvider(provider) || "*",
  clean(baseUrl).replace(/\/+$/u, "").toLowerCase() || "*",
].join("|");

export const openCodeModelMatchesProvider = (model = "", provider = "") => {
  const namespace = providerNamespace(provider);
  if (!namespace) return true;
  return clean(model).toLowerCase().startsWith(`${namespace}/`);
};

export const openCodeCatalogGroupsForProvider = (groups = [], provider = "") => {
  const namespace = providerNamespace(provider);
  if (!namespace) return Array.isArray(groups) ? groups : [];
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    models: (Array.isArray(group?.models) ? group.models : []).filter((item) => (
      openCodeModelMatchesProvider(item?.slug || item?.id, provider)
    )),
  })).filter((group) => group.models.length > 0);
};

export const openCodeProviderFallbackGroup = (provider = "", models = []) => {
  const namespace = providerNamespace(provider);
  const normalized = (Array.isArray(models) ? models : []).map((item) => {
    // `available:false` can mean only that the live OpenCode catalogue has not
    // been fetched yet. Keep selectable provider presets visible as explicitly
    // unverified fallbacks; submit-time probing still decides real availability.
    if (item?.selectable === false) return null;
    const rawSlug = clean(item?.slug || item?.id || item?.name);
    if (!rawSlug) return null;
    const slug = rawSlug.includes("/") ? rawSlug : `${namespace}/${rawSlug}`;
    if (!namespace || !openCodeModelMatchesProvider(slug, provider)) return null;
    return {
      slug,
      label: clean(item?.label || item?.displayName || rawSlug) || slug,
      available: false,
    };
  }).filter(Boolean);
  return {
    provider: namespace,
    source: "provider_preset_unverified",
    models: normalized,
  };
};

export const openCodeRunnerDefaults = (runner = "") => runner === "opencode" ? {
  adapter: "cli",
  cliPath: "opencode",
  cliArgs: "",
  requiresQualifiedModel: true,
} : runner === "claude_code" ? {
  adapter: "cli",
  cliPath: "claude",
  cliArgs: "-p --output-format json --model {model}",
  requiresQualifiedModel: false,
} : {
  adapter: "cli",
  cliPath: "codex",
  cliArgs: "exec --sandbox read-only --skip-git-repo-check --ephemeral --color never -",
  requiresQualifiedModel: false,
};

export const usableOpenCodeCliOverride = (value = "") => {
  const path = clean(value);
  if (!path || /^opencode(?:\.(?:exe|cmd|ps1))?$/iu.test(path)) return "";
  const fileName = path.replace(/\\/gu, "/").split("/").at(-1) || "";
  return /^opencode(?:\.(?:exe|cmd|ps1))?$/iu.test(fileName) ? path : "";
};
