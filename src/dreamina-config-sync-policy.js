import {
  DREAMINA_IMAGE_CLI_ALIAS,
  DREAMINA_IMAGE_CLI_ARGS,
  DREAMINA_VIDEO_CLI_ALIAS,
  DREAMINA_VIDEO_CLI_ARGS,
  normalizeDreaminaCliProfileId,
  validDreaminaCliProfileId,
} from "./media-cli-presets.js";

const CHANNELS = {
  image: { list: "imageConnections", active: "activeImageConnectionId", target: "video" },
  video: { list: "videoConnections", active: "activeVideoConnectionId", target: "image" },
};

const TARGET_DEFAULTS = {
  image: {
    protocol: "images",
    model: "5.0",
    timeoutMs: "1800000",
    cliPath: DREAMINA_IMAGE_CLI_ALIAS,
    cliArgs: DREAMINA_IMAGE_CLI_ARGS,
    label: "图片",
  },
  video: {
    protocol: "videos",
    model: "seedance2.5",
    timeoutMs: "1800000",
    cliPath: DREAMINA_VIDEO_CLI_ALIAS,
    cliArgs: DREAMINA_VIDEO_CLI_ARGS,
    label: "视频",
  },
};

const normalized = (value) => String(value || "").trim().toLowerCase();
const profileId = (profile = {}) => validDreaminaCliProfileId(profile.dreaminaCliProfile)
  ? normalizeDreaminaCliProfileId(profile.dreaminaCliProfile)
  : "";
const isDreaminaCli = (profile = {}) => ["即梦", "dreamina"].includes(normalized(profile.provider))
  && normalized(profile.adapter) === "cli";

const sourceSignature = (profile = {}) => JSON.stringify({
  id: String(profile.id || ""),
  account: profileId(profile),
  remarkName: String(profile.remarkName || ""),
  provider: "即梦",
  adapter: "cli",
});

const activeProfile = (settings, channel) => {
  const keys = CHANNELS[channel];
  if (!keys) return null;
  const profiles = Array.isArray(settings?.[keys.list]) ? settings[keys.list] : [];
  const activeId = String(settings?.[keys.active] || "");
  return profiles.find((profile) => String(profile.id || "") === activeId) || profiles[0] || null;
};

export const dreaminaConfigSyncProposal = ({ settings = {}, sourceChannel = "" } = {}) => {
  const sourceKeys = CHANNELS[sourceChannel];
  if (!sourceKeys) return null;
  const source = activeProfile(settings, sourceChannel);
  if (!isDreaminaCli(source)) return null;
  const targetChannel = sourceKeys.target;
  const targetKeys = CHANNELS[targetChannel];
  const targets = Array.isArray(settings[targetKeys.list]) ? settings[targetKeys.list] : [];
  const account = profileId(source);
  if (!account) return null;
  const existing = targets.find((profile) => isDreaminaCli(profile) && profileId(profile) === account) || null;
  const signature = sourceSignature(source);
  if (existing?.dreaminaSyncSourceChannel === sourceChannel
    && existing?.dreaminaSyncSourceProfileId === source.id
    && existing?.dreaminaSyncSourceSignature === signature) return null;
  return {
    sourceChannel,
    targetChannel,
    sourceProfileId: String(source.id || ""),
    targetProfileId: String(existing?.id || ""),
    dreaminaCliProfile: account,
    remarkName: String(source.remarkName || source.name || account),
    sourceSignature: signature,
  };
};

const uniqueProfileId = (profiles, preferred) => {
  if (!profiles.some((profile) => profile.id === preferred)) return preferred;
  let index = 2;
  while (profiles.some((profile) => profile.id === `${preferred}-${index}`)) index += 1;
  return `${preferred}-${index}`;
};

export const applyDreaminaConfigSync = (settings = {}, proposal = null) => {
  if (!proposal || !CHANNELS[proposal.sourceChannel] || !CHANNELS[proposal.targetChannel]) return settings;
  const account = validDreaminaCliProfileId(proposal.dreaminaCliProfile)
    ? normalizeDreaminaCliProfileId(proposal.dreaminaCliProfile)
    : "";
  if (!account) return settings;
  const targetKeys = CHANNELS[proposal.targetChannel];
  const defaults = TARGET_DEFAULTS[proposal.targetChannel];
  const profiles = Array.isArray(settings[targetKeys.list]) ? settings[targetKeys.list].map((profile) => ({ ...profile })) : [];
  const existingIndex = profiles.findIndex((profile) => String(profile.id || "") === String(proposal.targetProfileId || ""));
  const syncFields = {
    provider: "即梦",
    adapter: "cli",
    baseUrl: "",
    dreaminaCliProfile: account,
    remarkName: String(proposal.remarkName || ""),
    cliPath: defaults.cliPath,
    cliArgs: defaults.cliArgs,
    dreaminaSyncSourceChannel: proposal.sourceChannel,
    dreaminaSyncSourceProfileId: proposal.sourceProfileId,
    dreaminaSyncSourceSignature: proposal.sourceSignature,
  };
  if (existingIndex >= 0) {
    profiles[existingIndex] = { ...profiles[existingIndex], ...syncFields };
  } else {
    const preferredId = `${proposal.targetChannel}-dreamina-cli-${account}`;
    profiles.push({
      id: uniqueProfileId(profiles, preferredId),
      name: `即梦${defaults.label} CLI`,
      protocol: defaults.protocol,
      model: defaults.model,
      timeoutMs: defaults.timeoutMs,
      apiKey: "",
      ...syncFields,
    });
  }
  return { ...settings, [targetKeys.list]: profiles };
};
