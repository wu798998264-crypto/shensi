import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};
const hash = (value) => createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
const safeId = (value) => String(value || "").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 160);

const atomicJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) {
    if (process.platform !== "win32") throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
};

export class RankingSnapshotStore {
  constructor({ root }) {
    if (!root) throw new Error("榜单快照目录不能为空");
    this.root = root;
    this.indexPath = join(root, "index.json");
  }

  async index() {
    try { return JSON.parse(await readFile(this.indexPath, "utf8")); } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return { schemaVersion: 1, snapshots: [] };
      throw error;
    }
  }

  async save(value = {}) {
    const collectedAt = String(value.collectedAt || "").trim();
    if (!collectedAt || Number.isNaN(Date.parse(collectedAt))) throw new Error("榜单快照缺少真实采集时间");
    if (!Array.isArray(value.items) || !value.items.length) throw new Error("失败任务不得建立空榜单快照");
    const evidenceLedger = value.evidenceLedger && typeof value.evidenceLedger === "object" ? structuredClone(value.evidenceLedger) : {};
    const payloadForHash = { platformId: value.platformId, rankingId: value.rankingId, collectedAt, sourceUrls: value.sourceUrls || [], quality: value.quality || {}, items: value.items, evidenceLedger };
    const contentHash = hash(payloadForHash);
    const index = await this.index();
    const existing = index.snapshots.find((item) => item.idempotencyKey === value.idempotencyKey && item.contentHash === contentHash);
    if (existing) return { ...(await this.load(existing.snapshotId)), deduplicated: true };
    const snapshotId = safeId(value.snapshotId) || `ranking-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const snapshot = {
      snapshotId,
      taskId: safeId(value.taskId),
      idempotencyKey: String(value.idempotencyKey || ""),
      platformId: String(value.platformId || ""),
      rankingId: String(value.rankingId || ""),
      collectedAt,
      sourceUrls: [...new Set((value.sourceUrls || []).map(String))],
      itemCount: value.items.length,
      validItemCount: Number(value.quality?.validEntries) || value.items.length,
      quality: value.quality || {},
      items: structuredClone(value.items),
      evidenceLedger,
      contentHash,
      schemaVersion: 2,
    };
    await atomicJson(join(this.root, `${snapshotId}.json`), snapshot);
    index.snapshots.push({ snapshotId, idempotencyKey: snapshot.idempotencyKey, contentHash, collectedAt, platformId: snapshot.platformId, rankingId: snapshot.rankingId });
    await atomicJson(this.indexPath, index);
    return { ...snapshot, deduplicated: false };
  }

  async load(snapshotId) {
    return JSON.parse(await readFile(join(this.root, `${safeId(snapshotId)}.json`), "utf8"));
  }

  async verify(snapshotId) {
    const snapshot = await this.load(snapshotId);
    const payload = { platformId: snapshot.platformId, rankingId: snapshot.rankingId, collectedAt: snapshot.collectedAt, sourceUrls: snapshot.sourceUrls, quality: snapshot.quality, items: snapshot.items };
    if (Number(snapshot.schemaVersion) >= 2) payload.evidenceLedger = snapshot.evidenceLedger || {};
    const actual = hash(payload);
    return actual === snapshot.contentHash;
  }
}
