import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appDataRoot } from "./app-data.mjs";
import { dreaminaMembershipFromPayload } from "../dreamina-membership.js";

const SCHEMA_VERSION = 4;
export const dreaminaProfileIdentityStorePath = () => join(appDataRoot(), "config", "dreamina-profile-identities-v1.json");
const dreaminaProfileIdentityStoreBackupPath = () => `${dreaminaProfileIdentityStorePath()}.backup`;
let identityStoreMutationTail = Promise.resolve();

const profileId = (value) => {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : "";
};

const mutationProfileId = (value) => {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) {
    throw Object.assign(new Error("即梦配置 ID 缺失，已阻止写入其他账号核验记录"), {
      code: "DREAMINA_PROFILE_REQUIRED",
    });
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)) {
    throw Object.assign(new Error("即梦配置 ID 无效，已阻止写入默认账号核验记录"), {
      code: "DREAMINA_PROFILE_ID_INVALID",
    });
  }
  return candidate;
};

const normalizedReferenceClass = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["none", "image", "video", "audio", "mixed"].includes(normalized) ? normalized : "none";
};

const referenceClassForRequest = (request = {}) => {
  const kinds = new Set((Array.isArray(request.referenceMedia) ? request.referenceMedia : [])
    .map((item) => String(item?.mimeType || "").split("/")[0].toLowerCase())
    .filter((kind) => ["image", "video", "audio"].includes(kind)));
  if (!kinds.size) return "none";
  return kinds.size === 1 ? [...kinds][0] : "mixed";
};

const normalizedCreditEstimate = (value = {}) => {
  const channel = ["image", "video"].includes(String(value.channel || "").toLowerCase())
    ? String(value.channel).toLowerCase()
    : "video";
  const duration = Number.isFinite(Number(value.duration)) ? Math.max(0, Number(value.duration)) : 0;
  const count = Number.isFinite(Number(value.count)) ? Math.max(1, Number(value.count)) : 1;
  const creditCount = Number.isFinite(Number(value.creditCount)) ? Math.max(0, Number(value.creditCount)) : 0;
  const outputUnits = channel === "video" ? Math.max(1, duration) * count : count;
  const unitCredit = Number.isFinite(Number(value.unitCredit)) && Number(value.unitCredit) > 0
    ? Number(value.unitCredit)
    : outputUnits > 0 ? creditCount / outputUnits : 0;
  return ({
  channel,
  model: String(value.model || "").trim().slice(0, 120),
  mode: String(value.mode || "").trim().slice(0, 80),
  duration,
  resolution: String(value.resolution || "").trim().slice(0, 40),
  aspectRatio: String(value.aspectRatio || "").trim().slice(0, 40),
  count,
  creditCount,
  unitCredit,
  referenceClass: normalizedReferenceClass(value.referenceClass),
  generateAudio: value.generateAudio !== false,
  membership: String(value.membership || "").trim().slice(0, 40),
  calibrationSource: String(value.calibrationSource || "provider_bill").trim().slice(0, 40),
  calibrationRevision: Math.max(1, Number(value.calibrationRevision) || 1),
  previousUnitCredit: Number.isFinite(Number(value.previousUnitCredit)) ? Math.max(0, Number(value.previousUnitCredit)) : 0,
  deviationRatio: Number.isFinite(Number(value.deviationRatio)) ? Math.max(0, Number(value.deviationRatio)) : 0,
  providerTaskId: String(value.providerTaskId || "").trim().slice(0, 160),
  observedAt: String(value.observedAt || "").trim().slice(0, 80),
  });
};

const creditEstimateKey = (value = {}) => {
  const estimate = normalizedCreditEstimate(value);
  return JSON.stringify([
    estimate.channel,
    estimate.model.toLowerCase(),
    estimate.resolution.toLowerCase(),
    estimate.referenceClass,
    estimate.membership.toLowerCase(),
  ]);
};

const normalizedRecord = (value = {}) => {
  const membership = dreaminaMembershipFromPayload(value, {
    vipLevel: value.vipLevel,
    vipExpiresAt: value.vipExpiresAt,
    membershipTier: value.membershipTier,
  });
  return ({
  profileId: profileId(value.profileId),
  remarkName: String(value.remarkName || "").trim().slice(0, 80),
  expectedUserId: String(value.expectedUserId || "").trim().slice(0, 120),
  verifiedUserId: String(value.verifiedUserId || "").trim().slice(0, 120),
  credentialFingerprint: String(value.credentialFingerprint || "").trim().slice(0, 128),
  browser: String(value.browser || "").trim().slice(0, 40),
  boundAt: String(value.boundAt || "").trim().slice(0, 80),
  verifiedAt: String(value.verifiedAt || "").trim().slice(0, 80),
  lastCredit: Number.isFinite(Number(value.lastCredit)) ? Number(value.lastCredit) : null,
  trackedCreditTotal: Number.isFinite(Number(value.trackedCreditTotal)) ? Math.max(0, Number(value.trackedCreditTotal)) : null,
  consumedCredit: Number.isFinite(Number(value.consumedCredit)) ? Math.max(0, Number(value.consumedCredit)) : 0,
  lastConsumedCredit: Number.isFinite(Number(value.lastConsumedCredit)) ? Math.max(0, Number(value.lastConsumedCredit)) : 0,
  creditUpdatedAt: String(value.creditUpdatedAt || "").trim().slice(0, 80),
  vipLevel: String(value.vipLevel || "").trim().slice(0, 40),
  vipExpiresAt: String(value.vipExpiresAt || "").trim().slice(0, 80),
  membershipTier: membership.tier,
  membershipLabel: membership.label,
  creditEstimates: (Array.isArray(value.creditEstimates) ? value.creditEstimates : [])
    .map(normalizedCreditEstimate)
    .filter((item) => item.creditCount > 0 && item.model)
    .slice(-60),
  });
};

const normalizedStore = (value = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  revision: Math.max(0, Number(value.revision) || 0),
  updatedAt: String(value.updatedAt || ""),
  profiles: Object.fromEntries(Object.entries(value.profiles || {})
    .filter(([key]) => profileId(key) === key)
    .map(([key, record]) => [key, normalizedRecord({ ...record, profileId: key })])),
});

export const readDreaminaProfileIdentityStoreSync = () => {
  try {
    return normalizedStore(JSON.parse(readFileSync(dreaminaProfileIdentityStorePath(), "utf8")));
  } catch (error) {
    try {
      return normalizedStore(JSON.parse(readFileSync(dreaminaProfileIdentityStoreBackupPath(), "utf8")));
    } catch (backupError) {
      if (error?.code === "ENOENT" && backupError?.code === "ENOENT") return normalizedStore();
      // Generation reads this store synchronously while constructing the
      // isolated CLI environment. Returning an empty profile here would turn
      // damaged local state into a false "please verify again" prompt.
      throw Object.assign(new Error("即梦账号核验记录损坏且上一版备份不可读取；已阻止生成，原凭据未被修改"), {
        code: "DREAMINA_IDENTITY_STORE_CORRUPT",
        cause: error,
      });
    }
  }
};

export const readDreaminaProfileIdentityStore = async () => {
  try {
    return normalizedStore(JSON.parse(await readFile(dreaminaProfileIdentityStorePath(), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      try {
        return normalizedStore(JSON.parse(await readFile(dreaminaProfileIdentityStoreBackupPath(), "utf8")));
      } catch (backupError) {
        if (error.code === "ENOENT" && backupError?.code === "ENOENT") return normalizedStore();
        throw Object.assign(new Error("即梦账号核验记录损坏且上一版备份不可读取；已阻止覆盖，请先恢复核验记录"), {
          code: "DREAMINA_IDENTITY_STORE_CORRUPT",
          cause: error,
        });
      }
    }
    throw error;
  }
};

const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (existsSync(path)) {
    // Preserve the last parseable ledger. A corrupt primary must never replace
    // its good backup immediately before recovery writes a repaired primary.
    try {
      JSON.parse(await readFile(path, "utf8"));
      await copyFile(path, dreaminaProfileIdentityStoreBackupPath());
    } catch {}
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform !== "win32" || !existsSync(path)) throw error;
    const previous = `${path}.${process.pid}.${Date.now()}.previous`;
    try {
      await rename(path, previous);
      await rename(temporary, path);
      await rm(previous, { force: true });
    } catch (replacementError) {
      await rename(previous, path).catch(() => {});
      throw replacementError;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  if (!existsSync(dreaminaProfileIdentityStoreBackupPath())) {
    await copyFile(path, dreaminaProfileIdentityStoreBackupPath());
  }
};

const mutateIdentityStore = (operation) => {
  const current = identityStoreMutationTail.then(operation, operation);
  identityStoreMutationTail = current.then(() => undefined, () => undefined);
  return current;
};

const writeDreaminaProfileIdentityFromStore = async (store, record = {}) => {
  const id = mutationProfileId(record.profileId);
  const next = normalizedStore({
    ...store,
    revision: store.revision + 1,
    updatedAt: new Date().toISOString(),
    profiles: { ...store.profiles, [id]: normalizedRecord({ ...store.profiles[id], ...record, profileId: id }) },
  });
  await atomicWrite(dreaminaProfileIdentityStorePath(), next);
  return next.profiles[id];
};

const writeDreaminaProfileIdentity = async (record = {}) => writeDreaminaProfileIdentityFromStore(
  await readDreaminaProfileIdentityStore(),
  record,
);

// Status refreshes, OAuth completion and post-generation credit calibration can
// finish at the same time for different profiles. Serialize the complete
// read-modify-write transaction so one account cannot erase another account's
// newly persisted identity with an older store snapshot.
export const saveDreaminaProfileIdentity = async (record = {}) => mutateIdentityStore(
  () => writeDreaminaProfileIdentity(record),
);

export const claimDreaminaProfileIdentity = async (record = {}) => mutateIdentityStore(async () => {
  const id = mutationProfileId(record.profileId);
  const expectedUserId = String(record.expectedUserId || record.verifiedUserId || "").trim().slice(0, 120);
  const store = await readDreaminaProfileIdentityStore();
  const duplicate = expectedUserId
    ? Object.values(store.profiles).find((item) => item.profileId !== id && item.expectedUserId === expectedUserId) || null
    : null;
  if (duplicate) return { saved: null, duplicate };
  return {
    saved: await writeDreaminaProfileIdentityFromStore(store, record),
    duplicate: null,
  };
});

export const recordDreaminaProfileCreditEstimate = async ({
  profileId: requestedProfileId,
  channel,
  request = {},
  creditCount,
  providerTaskId = "",
} = {}) => {
  const amount = Number(creditCount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const id = mutationProfileId(requestedProfileId);
  const estimate = normalizedCreditEstimate({
    channel,
    model: request.settings?.model || request.model,
    mode: request.generationMode || request.mode,
    duration: request.duration,
    resolution: request.resolution || request.quality,
    aspectRatio: request.aspectRatio || request.ratio,
    count: channel === "image" ? request.imageCount : request.videoCount,
    referenceClass: referenceClassForRequest(request),
    generateAudio: request.generateAudio !== false,
    creditCount: amount,
    providerTaskId,
    observedAt: new Date().toISOString(),
  });
  return mutateIdentityStore(async () => {
    const store = await readDreaminaProfileIdentityStore();
    const current = store.profiles[id] || normalizedRecord({ profileId: id });
    estimate.membership = current.vipLevel || "";
    const key = creditEstimateKey(estimate);
    const previous = [...current.creditEstimates].reverse().find((item) => creditEstimateKey(item) === key) || null;
    if (previous?.unitCredit > 0) {
      estimate.previousUnitCredit = previous.unitCredit;
      estimate.deviationRatio = Math.abs(estimate.unitCredit - previous.unitCredit) / previous.unitCredit;
      estimate.calibrationRevision = Math.max(1, Number(previous.calibrationRevision) || 1)
        + (estimate.deviationRatio > 0.001 ? 1 : 0);
    }
    const estimates = current.creditEstimates.filter((item) => creditEstimateKey(item) !== key);
    estimates.push(estimate);
    return writeDreaminaProfileIdentity({ ...current, profileId: id, creditEstimates: estimates.slice(-60) });
  });
};

export const dreaminaExpectedIdentitySync = (value) => {
  const id = mutationProfileId(value);
  return readDreaminaProfileIdentityStoreSync().profiles[id] || normalizedRecord({ profileId: id });
};

export const credentialFileFingerprint = (path) => {
  if (!path || !existsSync(path)) return "";
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // OAuth/registry files can be briefly locked by the browser or Windows
    // credential broker. A read-only identity probe must never modify the
    // profile or prevent the application/build from starting; the caller
    // falls back to the last verified identity until the file is readable.
    return "";
  }
};
