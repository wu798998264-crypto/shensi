import { DREAMINA_IMAGE_CLI_ALIAS, DREAMINA_VIDEO_CLI_ALIAS, LIBTV_CLI_ALIAS, OPENAI_IMAGE_CLI_ALIAS } from "./media-cli-presets.js";

export const MEDIA_PROBE_SUCCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MEDIA_PROBE_FAILURE_MAX_AGE_MS = 5 * 60 * 1000;
export const MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

const sha256Hex = (value) => {
  const source = new TextEncoder().encode(String(value ?? ""));
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(source.length / 0x20000000));
  view.setUint32(paddedLength - 4, (source.length * 8) >>> 0);
  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
};

export const mediaCredentialMarker = (apiKey) => {
  const credential = String(apiKey || "");
  return credential ? `sha256:${sha256Hex(`shensi-media-credential-v1\0${credential}`)}` : "none";
};

const PAID_PROBE_FIELDS = Object.freeze([
  "generationPermissionChecked", "paidSmokeTest", "smokeJobId", "smokeJobStatus", "smokeDesiredAction",
  "smokeAvailableActions", "smokeProgressPercent", "smokeStatusMessage", "smokeError", "smokeConnectionInterrupted",
  "landedArtifactSha256", "landedArtifactBytes", "durationMs", "videoWidth", "videoHeight", "videoCodec",
  "videoFrameCount", "smokeVerifiedAt", "evidenceCheckedAt", "evidenceExpiresAt", "paidProfileSignature",
  "paidDurableProfileSignature",
]);

const checkedAtMilliseconds = (probe = {}) => {
  const value = Date.parse(String(probe.checkedAt || ""));
  return Number.isFinite(value) ? value : 0;
};

export const mediaProbeConnected = (probe = {}) => probe.connected === true || probe.available === true;

const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();

const normalizedBaseUrl = (value) => {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const url = new URL(source);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return source.replace(/\/+$/, "").toLowerCase();
  }
};

const normalizedCliPath = (value) => String(value || "")
  .trim()
  .replace(/\\/g, "/")
  .replace(/\/{2,}/g, "/");

const normalizedCliArgs = (value) => (Array.isArray(value)
  ? JSON.stringify(value.map((item) => String(item)))
  : String(value || "").trim().replace(/\r\n?/g, "\n"));

export const mediaCapabilityProfileSignature = (channel, profile = {}) => JSON.stringify([
  normalizedIdentity(channel),
  normalizedIdentity(profile.connectionId || profile.id),
  normalizedIdentity(profile.provider),
  normalizedIdentity(profile.adapter),
  normalizedIdentity(profile.protocol),
  String(profile.model || "").trim(),
  normalizedBaseUrl(profile.baseUrl),
  normalizedCliPath(profile.cliPath),
  normalizedCliArgs(profile.cliArgs),
  mediaCredentialMarker(profile.apiKey),
]);

export const paidMediaCapabilityEvidenceFresh = (probe, now = Date.now()) => {
  if (!probe || typeof probe !== "object" || probe.paidSmokeTest !== true) return false;
  const explicitExpiry = Date.parse(String(probe.evidenceExpiresAt || ""));
  if (Number.isFinite(explicitExpiry)) return explicitExpiry > Number(now);
  const verifiedAt = Date.parse(String(probe.smokeVerifiedAt || probe.evidenceCheckedAt || ""));
  return Number.isFinite(verifiedAt)
    && Math.max(0, Number(now) - verifiedAt) <= MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS;
};

export const mergeMediaCapabilityProbe = ({
  previous = {},
  next = {},
  profileSignature = "",
  durableProfileSignature = next?.durableProfileSignature || "",
} = {}) => {
  const fullSignature = String(profileSignature || next?.profileSignature || "");
  const opaqueSignature = String(durableProfileSignature || "");
  const previousFullSignature = String(previous?.paidProfileSignature || previous?.profileSignature || "");
  const previousOpaqueSignature = String(previous?.paidDurableProfileSignature || previous?.durableProfileSignature || "");
  const hasPaidState = Boolean(previous?.paidProfileSignature || previous?.paidDurableProfileSignature || previous?.smokeJobId);
  const preservePaidState = hasPaidState
    && Boolean(fullSignature)
    && previousFullSignature === fullSignature
    && (!opaqueSignature || (Boolean(previousOpaqueSignature) && previousOpaqueSignature === opaqueSignature));
  const paidFields = new Set(PAID_PROBE_FIELDS);
  const merged = Object.fromEntries(Object.entries(next ?? {}).filter(([field]) => !paidFields.has(field)));
  merged.profileSignature = fullSignature;
  if (opaqueSignature) merged.durableProfileSignature = opaqueSignature;
  else if (previous?.profileSignature === fullSignature && previous?.durableProfileSignature) {
    merged.durableProfileSignature = String(previous.durableProfileSignature);
  }
  if (preservePaidState) {
    for (const field of PAID_PROBE_FIELDS) {
      if (Object.hasOwn(previous, field)) merged[field] = previous[field];
    }
    if (previous.paidSmokeTest === true && previous.verificationLevel === "paid_landed_smoke") {
      merged.verificationLevel = previous.verificationLevel;
    }
  }
  return merged;
};

export const bindPaidMediaCapabilityProbe = ({
  previous = {},
  currentProfileSignature = "",
  paidProfileSignature = "",
  paidDurableProfileSignature = "",
  patch = {},
} = {}) => {
  const currentFull = String(currentProfileSignature || "");
  const paidFull = String(paidProfileSignature || "");
  const paidOpaque = String(paidDurableProfileSignature || "");
  if (!currentFull || !paidFull || !paidOpaque || currentFull !== paidFull) return null;
  if (previous?.profileSignature && previous.profileSignature !== paidFull) return null;
  if (previous?.durableProfileSignature && previous.durableProfileSignature !== paidOpaque) return null;
  return {
    ...previous,
    ...patch,
    profileSignature: previous.profileSignature || paidFull,
    durableProfileSignature: previous.durableProfileSignature || paidOpaque,
    paidProfileSignature: paidFull,
    paidDurableProfileSignature: paidOpaque,
  };
};

export const freshMediaCapabilityProbe = (probe, now = Date.now(), profileSignature = "") => {
  if (!probe || typeof probe !== "object") return null;
  if (profileSignature && probe.profileSignature !== profileSignature) return null;
  const checkedAt = checkedAtMilliseconds(probe);
  if (!checkedAt) return null;
  const age = Math.max(0, Number(now) - checkedAt);
  const maxAge = mediaProbeConnected(probe)
    ? MEDIA_PROBE_SUCCESS_MAX_AGE_MS
    : MEDIA_PROBE_FAILURE_MAX_AGE_MS;
  return age <= maxAge ? probe : null;
};

export const builtInMediaCliProfile = (channel, profile = {}) => {
  if (profile.adapter !== "cli") return false;
  if (channel === "image") return [OPENAI_IMAGE_CLI_ALIAS, DREAMINA_IMAGE_CLI_ALIAS].includes(profile.cliPath)
    || (profile.cliPath === LIBTV_CLI_ALIAS && String(profile.provider || "").toLowerCase() === "libtv");
  if (channel === "video") return profile.cliPath === DREAMINA_VIDEO_CLI_ALIAS
    || (profile.cliPath === LIBTV_CLI_ALIAS && String(profile.provider || "").toLowerCase() === "libtv");
  if (channel === "audio") return profile.cliPath === LIBTV_CLI_ALIAS && String(profile.provider || "").toLowerCase() === "libtv";
  return false;
};

export const mediaModelAllowedByCapabilityProbe = (channel, profile = {}, probe) => {
  if (!probe || typeof probe !== "object") return null;
  if (!mediaProbeConnected(probe)) return false;
  const models = Array.isArray(probe.models) ? probe.models.map((model) => String(model)) : [];
  const selectedModel = String(profile.model || "");
  if (probe.visibilityChecked === true) return Boolean(selectedModel && models.includes(selectedModel));
  // The bundled media CLIs do not expose an account-scoped model-list API.
  // Their registered driver still returns its exact supported catalog after a
  // successful session/auth check. Treat that catalog as compatibility
  // evidence without pretending that account-level visibility was inspected.
  if (probe.driverRegistered === true && builtInMediaCliProfile(channel, profile)) {
    return Boolean(selectedModel && models.includes(selectedModel));
  }
  return null;
};

export const mediaConnectionAllowedWhileProbePending = (channel, profile = {}, probe) => (
  builtInMediaCliProfile(channel, profile)
  && (!probe || (mediaProbeConnected(probe) && probe.visibilityChecked !== true))
);

export const mediaGenerationConnectionAvailable = (channel, profile = {}, probe, {
  modeAvailable = true,
} = {}) => {
  if (!modeAvailable) return false;
  // Audio is an optional capability. Do not briefly expose its whiteboard
  // entry merely because a bundled profile exists; wait until the driver and
  // selected model have both been confirmed by the current-session probe.
  if (!probe) return channel === "audio" ? false : mediaConnectionAllowedWhileProbePending(channel, profile, probe);
  const connected = mediaProbeConnected(probe);
  if (!connected) return false;
  const modelAllowed = mediaModelAllowedByCapabilityProbe(channel, profile, probe);
  if (channel === "image") {
    return profile.adapter === "cli" ? modelAllowed !== false : modelAllowed === true;
  }
  if (channel === "video" || channel === "audio") return probe.driverRegistered === true && modelAllowed === true;
  return false;
};

export const capabilityProbeSessionIsHydrated = (profiles = [], {
  textProbes = {},
  mediaProbes = {},
  now = Date.now(),
} = {}) => profiles.every(({ channel, settings = {} }) => {
  if (!settings.id) return true;
  if (settings.adapter === "api" && !settings.apiKey) return true;
  if (channel === "text") {
    if (settings.adapter === "cli") return true;
    return Boolean(textProbes[settings.id]?.checkedAt);
  }
  return Boolean(freshMediaCapabilityProbe(
    mediaProbes[`${channel}:${settings.id}`],
    now,
    mediaCapabilityProfileSignature(channel, settings),
  ));
});
