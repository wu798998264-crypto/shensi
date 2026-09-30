import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const emptyState = () => ({
  schemaVersion: 1,
  users: [],
  sessions: [],
  emailChallenges: [],
  emailRateLimits: [],
  skills: [],
  skillReviews: [],
  skillDownloads: [],
  generationRuns: [],
  memberships: [],
  quotaAccounts: [],
  quotaLedger: [],
  auditLogs: [],
});

export const normalizeState = (value) => ({
  ...emptyState(),
  ...(value && typeof value === "object" ? value : {}),
});

const atomicWrite = async (target, value) => {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  try {
    // Windows scanners may briefly hold the destination. Keep the old file
    // intact and retry the atomic rename for at most 300ms, never delete it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = normalizeState(parsed);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = emptyState();
      await atomicWrite(this.filePath, this.state);
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.state || emptyState());
  }

  async transact(mutator) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state || emptyState());
      const result = await mutator(next);
      await atomicWrite(this.filePath, next);
      this.state = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export const createMemoryStore = async () => {
  const store = new JsonStore(`${process.cwd()}/.cloud-skill-platform-test-${randomUUID()}.json`);
  await store.init();
  return store;
};
