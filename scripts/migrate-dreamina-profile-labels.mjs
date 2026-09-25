import { listGenerationProfileSettings, saveGenerationProfileSettings } from "../src/server/generation-profile-store.mjs";
import { readDreaminaProfileIdentityStore, saveDreaminaProfileIdentity } from "../src/server/dreamina-profile-identity-store.mjs";
import { DREAMINA_CLI_PROFILES } from "../src/media-cli-presets.js";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const remarks = new Map(DREAMINA_CLI_PROFILES.map((profile) => [profile.id, profile.remarkName]));
const store = await listGenerationProfileSettings();
const settings = { ...(store.settings || {}) };
for (const channel of ["imageConnections", "videoConnections"]) {
  settings[channel] = (settings[channel] || []).map((profile) => {
    const account = String(profile.dreaminaCliProfile || "").trim();
    const remarkName = remarks.get(account);
    return profile.provider === "即梦" && profile.adapter === "cli" && remarkName
      ? { ...profile, name: remarkName, remarkName }
      : profile;
  });
}
const normalized = normalizeGenerationProfiles(settings);
const saved = await saveGenerationProfileSettings({ settings: normalized, expectedRevision: store.revision, force: true });

const identities = await readDreaminaProfileIdentityStore();
for (const [profileId, record] of Object.entries(identities.profiles || {})) {
  const remarkName = remarks.get(profileId);
  if (!remarkName || record.remarkName === remarkName) continue;
  await saveDreaminaProfileIdentity({ ...record, profileId, remarkName });
}

console.log(JSON.stringify({
  ok: true,
  generationRevision: saved.revision,
  migratedProfiles: ["default", "duanju-zuiqianxian"].map((profileId) => ({ profileId, remarkName: remarks.get(profileId) })),
}, null, 2));
