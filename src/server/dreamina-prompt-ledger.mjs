import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync as readSync } from "node:fs";
import { join, dirname } from "node:path";
import { appDataRoot } from "./app-data.mjs";

const ledgerPath = () => join(appDataRoot(), "config", "dreamina-prompt-ledger-v1.json");
const MAX_ENTRIES = 2_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const normalizedEntry = (value = {}) => ({
  signature: String(value.signature || "").trim().slice(0, 500),
  profileId: String(value.profileId || "").trim().slice(0, 80),
  kind: String(value.kind || "").trim().slice(0, 40),
  status: String(value.status || "").trim().slice(0, 40),
  providerTaskId: String(value.providerTaskId || "").trim().slice(0, 160),
  errorCode: String(value.errorCode || "").trim().slice(0, 120),
  shownAt: String(value.shownAt || "").trim().slice(0, 80),
});

const normalizedLedger = (value = {}) => ({
  schemaVersion: 1,
  entries: (Array.isArray(value.entries) ? value.entries : [])
    .map(normalizedEntry)
    .filter((entry) => entry.signature)
    .slice(-MAX_ENTRIES),
});

const readLedger = async () => {
  try {
    return normalizedLedger(JSON.parse(await readFile(ledgerPath(), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return normalizedLedger();
    throw error;
  }
};

const writeLedger = async (ledger) => {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalizedLedger(ledger), null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

let mutationTail = Promise.resolve();
const mutate = (operation) => {
  const next = mutationTail.then(operation, operation);
  mutationTail = next.then(() => undefined, () => undefined);
  return next;
};

const prune = (entries) => {
  const cutoff = Date.now() - RETENTION_MS;
  return entries.filter((entry) => {
    const shownAt = Date.parse(entry.shownAt || "");
    return !Number.isFinite(shownAt) || shownAt >= cutoff;
  }).slice(-MAX_ENTRIES);
};

export const dreaminaPromptSignature = ({ jobId = "", status = "", providerTaskId = "", errorCode = "" } = {}) => [
  String(jobId || "").trim(),
  String(status || "").trim().toLowerCase(),
  String(providerTaskId || "").trim(),
  String(errorCode || "").trim().toUpperCase(),
].join("|");

export const claimDreaminaPromptSignature = async ({ signature, profileId = "", kind = "", status = "", providerTaskId = "", errorCode = "" } = {}) => mutate(async () => {
  const normalizedSignature = String(signature || "").trim().slice(0, 500);
  if (!normalizedSignature) return false;
  const ledger = await readLedger();
  const entries = prune(ledger.entries);
  if (entries.some((entry) => entry.signature === normalizedSignature)) {
    if (entries.length !== ledger.entries.length) await writeLedger({ entries });
    return false;
  }
  entries.push(normalizedEntry({
    signature: normalizedSignature,
    profileId,
    kind,
    status,
    providerTaskId,
    errorCode,
    shownAt: new Date().toISOString(),
  }));
  await writeLedger({ entries: prune(entries) });
  return true;
});

export const readDreaminaPromptLedgerSync = () => {
  try { return normalizedLedger(JSON.parse(readSync(ledgerPath(), "utf8"))); } catch { return normalizedLedger(); }
};
