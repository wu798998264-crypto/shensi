import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const libTvBoardScope = (job = {}, accountId = "") => {
  const target = job.target || {};
  if (target.documentKind !== "whiteboard" || !target.workspacePath || !target.documentId || !accountId) return null;
  const identity = [String(accountId), resolve(target.workspacePath).toLocaleLowerCase(), String(target.documentId)];
  return { key: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), identity, title: String(target.documentTitle || "白板").replace(/[\r\n]/gu, " ").slice(0, 64) };
};
const read = async path => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const atomic = async (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
};
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

export const getLibTvBoardProject = async ({ root, scope, jobId, create, recover = async () => "" }) => {
  root = resolve(root);
  if (!/^[a-f0-9]{64}$/u.test(scope?.key || "")) throw new Error("LibTV 白板映射身份无效");
  await mkdir(root, { recursive: true });
  const path = join(root, `${scope.key}.json`), lock = `${path}.lock`, token = randomUUID();
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { await mkdir(lock); await atomic(join(lock, "owner.json"), { pid: process.pid, token }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await read(join(lock, "owner.json"));
      const metadata = await stat(lock).catch(() => null);
      if (metadata && ((owner?.pid && !alive(owner.pid)) || (!owner && Date.now() - metadata.mtimeMs > 45_000))) {
        const abandoned = `${lock}.${randomUUID()}.abandoned`;
        try {
          await rename(lock, abandoned);
          const movedOwner = await read(join(abandoned, "owner.json"));
          // A competing reaper may have replaced the lease after our read.
          // Never delete a newer/live owner's lease.
          if (movedOwner?.token !== owner?.token || (movedOwner?.pid && alive(movedOwner.pid))) {
            await rename(abandoned, lock);
            throw new Error("LibTV 白板租约发生并发变化，已保留租约；未提交生成");
          }
          await rm(abandoned, { recursive: true, force: true });
        } catch (recoveryError) { if (recoveryError.code !== "ENOENT") throw recoveryError; }
        continue;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error("LibTV 同一白板正在准备画布，请稍后重试；未提交生成"), { providerErrorCode: "LIBTV_BOARD_BUSY", submissionOutcomeKnown: true });
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  try {
    let record = await read(path);
    if (record && JSON.stringify(record.identity) !== JSON.stringify(scope.identity)) throw new Error("LibTV 画布映射身份不一致，已阻止跨账号使用");
    if (!record) {
      record = { schemaVersion: 1, identity: scope.identity, createName: `神思-${scope.title}-${scope.key.slice(0, 12)}`, state: "creating", jobs: {} };
      await atomic(path, record);
      record.projectUuid = String(await create(record.createName) || "");
    } else if (!record.projectUuid) {
      record.projectUuid = String(await recover(record.createName) || "");
      if (!record.projectUuid) throw Object.assign(new Error("LibTV 上次创建画布的结果尚未确认，不能再次创建；请核对厂商画布后恢复"), { providerErrorCode: "LIBTV_BOARD_CREATE_UNCERTAIN", submissionOutcomeKnown: true });
    }
    if (!record.projectUuid) throw new Error("LibTV 创建画布未返回 UUID");
    record.state = "active";
    record.jobs ||= {};
    if (!Object.hasOwn(record.jobs, jobId)) record.jobs[jobId] = Object.keys(record.jobs).length;
    await atomic(path, record);
    return { projectUuid: record.projectUuid, boardScopeKey: scope.key, accountId: scope.identity[0], slot: record.jobs[jobId] };
  } finally {
    const owner = await read(join(lock, "owner.json"));
    if (owner?.token === token && dirname(lock) === root) await rm(lock, { recursive: true, force: true });
  }
};
