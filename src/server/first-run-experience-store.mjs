import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appDataRoot } from "./app-data.mjs";

const schemaVersion = 1;
let claimQueue = Promise.resolve();

export const creativeStartWelcomeReceiptPath = () => join(
  appDataRoot(),
  "config",
  "creative-start-welcome-v1.json",
);

const readReceipt = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A receipt that exists but cannot be parsed must still suppress the
    // automatic welcome. Reopening it would violate the one-time contract.
    return { schemaVersion, seenAt: "", source: "existing_unreadable_receipt" };
  }
};

export const claimCreativeStartWelcome = async ({
  legacySeen = false,
  path = creativeStartWelcomeReceiptPath(),
  now = () => new Date().toISOString(),
} = {}) => {
  const operation = claimQueue.catch(() => {}).then(async () => {
    const existing = await readReceipt(path);
    if (existing) return { show: false, migrated: false, receipt: existing };

    await mkdir(dirname(path), { recursive: true });
    const receipt = {
      schemaVersion,
      seenAt: now(),
      source: legacySeen ? "legacy_local_storage" : "first_software_open",
    };
    let handle;
    try {
      handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(receipt, null, 2), "utf8");
      await handle.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { show: false, migrated: false, receipt: await readReceipt(path) };
    } finally {
      await handle?.close();
    }
    return { show: !legacySeen, migrated: legacySeen, receipt };
  });
  claimQueue = operation;
  return operation;
};
