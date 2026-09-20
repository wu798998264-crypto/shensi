const clean = (value = "", maximum = 2_048) => String(value ?? "").replace(/\0/gu, "").trim().slice(0, maximum);

const normalizedModels = (models = []) => [...new Set((Array.isArray(models) ? models : [])
  .map((model) => clean(model, 288))
  .filter((model) => /^[a-z0-9][a-z0-9._:+/-]*$/iu.test(model)))].slice(0, 200);

/**
 * Store only a verified, non-sensitive WorkBuddy catalogue.  Credentials,
 * executable paths and prompt data never enter this cache.  The entry is
 * deliberately marked stale on restore so the server can refresh it in the
 * background while the already-confirmed choices remain usable.
 */
export const workBuddyCapabilityCacheEntry = (capability = {}) => {
  if (capability?.authenticated !== true && capability?.authState !== "authenticated") return null;
  const models = normalizedModels(capability?.models);
  if (capability?.installed !== true || !models.length) return null;
  return {
    id: "workbuddy",
    label: "WorkBuddy",
    installed: true,
    available: true,
    installState: "installed",
    state: "ready",
    ready: true,
    authenticated: true,
    authState: "authenticated",
    modelState: "catalog_available",
    modelPolicy: "explicit",
    catalogSource: clean(capability?.catalogSource, 120) || "runner_account",
    modelCatalogChecked: true,
    models,
    modelCatalogStale: false,
    cachedAt: clean(capability?.cachedAt, 80) || new Date().toISOString(),
    message: clean(capability?.message, 500) || `已读取 ${models.length} 个 WorkBuddy 当前可用模型`,
  };
};

export const restoreWorkBuddyCapabilityCache = (value = {}) => {
  const entry = workBuddyCapabilityCacheEntry({
    ...value,
    authenticated: value?.authenticated === true || value?.authState === "authenticated",
    authState: "authenticated",
  });
  if (!entry) return null;
  return {
    ...entry,
    modelCatalogStale: true,
    message: "已恢复上次确认的 WorkBuddy 模型目录，正在后台复核",
  };
};

