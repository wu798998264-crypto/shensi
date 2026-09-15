import fs from "node:fs";

const obsoleteId = "index-creative-guidance";
const files = process.argv.slice(2);

const purge = (value, seen, report) => {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (item === obsoleteId || (Array.isArray(item) && item[0] === obsoleteId)) {
        value.splice(index, 1);
        report.removedReferences += 1;
      } else purge(item, seen, report);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === obsoleteId || value[key] === obsoleteId) {
      delete value[key];
      report.removedReferences += 1;
      continue;
    }
    purge(value[key], seen, report);
  }
};

for (const file of files) {
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const report = { file, removedReferences: 0 };
  purge(state, new WeakSet(), report);
  state.obsoleteWorkspaceCompatibilityVersion = 1;
  const settings = state.settings && typeof state.settings === "object" ? state.settings : null;
  if (settings) {
    const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
    const ids = new Set(profiles.map((profile) => String(profile?.id || "").trim()).filter(Boolean));
    const selected = [settings.activeTextAgentConnectionId, settings.activeTextConnectionId, settings.activeTextChatConnectionId]
      .map((id) => String(id || "").trim())
      .find((id) => ids.has(id)) || "";
    if (selected) {
      settings.activeTextConnectionId = selected;
      settings.activeTextAgentConnectionId = selected;
      settings.activeTextChatConnectionId = selected;
    }
    report.activeTextConnectionId = String(settings.activeTextConnectionId || "");
  }
  if (!Object.hasOwn(state, "activeDocument") || state.activeDocument === obsoleteId) state.activeDocument = "";
  if (state.moduleLastDocuments && typeof state.moduleLastDocuments === "object") {
    for (const key of Object.keys(state.moduleLastDocuments)) {
      if (state.moduleLastDocuments[key] === obsoleteId) state.moduleLastDocuments[key] = "";
    }
  }
  const temporaryPath = `${file}.tmp-obsolete-compat`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, state.workspaceKind === "notebook" ? 0 : 2), "utf8");
  fs.renameSync(temporaryPath, file);
  console.log(JSON.stringify(report));
}
