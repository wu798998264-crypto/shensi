import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const emptyState = () => ({
  schemaVersion: 1,
  users: [],
  sessions: [],
  skills: [],
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
    await rename(temporary, target);
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
    this.queue = this.queue.then(async () => {
      const next = structuredClone(this.state || emptyState());
      const result = await mutator(next);
      this.state = next;
      await atomicWrite(this.filePath, next);
      return result;
    });
    return this.queue;
  }
}

export const createMemoryStore = async () => {
  const store = new JsonStore(`${process.cwd()}/.cloud-skill-platform-test-${randomUUID()}.json`);
  await store.init();
  return store;
};
