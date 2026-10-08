import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CHANNELS = 8;
const MAX_CONNECTIONS_PER_CHANNEL = 128;
const MAX_SECRET_LENGTH = 32_768;

const normalizedSecrets = (value = {}) => Object.fromEntries(
  Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .slice(0, MAX_CHANNELS)
    .map(([channel, records]) => [
      String(channel).trim().slice(0, 40),
      Object.fromEntries(Object.entries(
        records && typeof records === "object" && !Array.isArray(records) ? records : {},
      ).slice(0, MAX_CONNECTIONS_PER_CHANNEL).map(([connectionId, secret]) => [
        String(connectionId).trim().slice(0, 160),
        String(secret ?? "").slice(0, MAX_SECRET_LENGTH),
      ]).filter(([connectionId, secret]) => connectionId && secret)),
    ])
    .filter(([channel]) => channel),
);

// Tombstones are intentionally limited to channel/connection identifiers. They
// contain no credential material, but ensure a stale recovery copy can never
// resurrect an explicitly deleted connection after a restart.
const normalizedTombstones = (value = {}) => Object.fromEntries(
  Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})
    .slice(0, MAX_CHANNELS)
    .map(([channel, ids]) => [
      String(channel).trim().slice(0, 40),
      [...new Set((Array.isArray(ids) ? ids : [ids])
        .map((id) => String(id ?? "").trim().slice(0, 160))
        .filter(Boolean))].slice(0, MAX_CONNECTIONS_PER_CHANNEL),
    ])
    .filter(([channel, ids]) => channel && ids.length),
);

const emptyVaultState = () => ({ secrets: {}, tombstones: {}, generation: 0 });

const fsyncWrite = async (target, content) => {
  const handle = await open(target, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const replaceFile = async (temporary, target) => {
  await rename(temporary, target).catch(async (error) => {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  });
};

export const createCredentialVault = ({
  root,
  encryptionAvailable,
  encryptString,
  decryptString,
} = {}) => {
  if (!root) throw new Error("凭证仓缺少数据目录");
  if (typeof encryptionAvailable !== "function" || typeof encryptString !== "function" || typeof decryptString !== "function") {
    throw new Error("凭证仓缺少加密实现");
  }
  const vaultRoot = join(root, "Credentials");
  const vaultPath = join(vaultRoot, "generation-secrets.dpapi.json");
  const previousPath = `${vaultPath}.previous`;
  let mutationQueue = Promise.resolve();

  const assertEncryption = () => {
    if (!encryptionAvailable()) throw new Error("当前系统无法使用安全凭证加密，已拒绝把 API Key 写入磁盘");
  };

  const decode = (serialized) => {
    const envelope = JSON.parse(serialized);
    if (Number(envelope?.schemaVersion) !== 1 || typeof envelope?.ciphertext !== "string" || !envelope.ciphertext) {
      throw new Error("凭证仓格式无效");
    }
    const plaintext = decryptString(Buffer.from(envelope.ciphertext, "base64"));
    const decoded = JSON.parse(plaintext);
    // Schema 1 originally stored the secrets object directly. Accept that
    // format, while new writes carry generation/tombstone metadata alongside
    // the same encrypted secret map.
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)
      && Object.prototype.hasOwnProperty.call(decoded, "secrets")) {
      return {
        secrets: normalizedSecrets(decoded.secrets),
        tombstones: normalizedTombstones(decoded.tombstones),
        generation: Math.max(0, Number(decoded.generation) || 0),
      };
    }
    return { ...emptyVaultState(), secrets: normalizedSecrets(decoded) };
  };

  const readCandidate = async (target) => decode(await readFile(target, "utf8"));

  const readUnlocked = async () => {
    assertEncryption();
    try {
      return { ...(await readCandidate(vaultPath)), recovered: false };
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          const recovered = await readCandidate(previousPath);
          return { ...recovered, recovered: true };
        } catch (backupError) {
          if (backupError?.code === "ENOENT") return { ...emptyVaultState(), recovered: false };
          throw new Error(`凭证仓与恢复副本均无法读取：${error.message}；${backupError.message}`);
        }
      }
      try {
        const recovered = await readCandidate(previousPath);
        return { ...recovered, recovered: true };
      } catch (backupError) {
        if (backupError?.code === "ENOENT") throw new Error(`凭证仓无法读取：${error.message}`);
        throw new Error(`凭证仓与恢复副本均无法读取：${error.message}；${backupError.message}`);
      }
    }
  };

  const writeUnlocked = async (value, { tombstones = {}, generation = 0, baseState = null } = {}) => {
    assertEncryption();
    const secrets = normalizedSecrets(value);
    const current = baseState || await readUnlocked();
    const mergedTombstones = normalizedTombstones(tombstones);
    // Derive deletions from every replacement write as well as deleteChannel,
    // so a stale recovery copy cannot reintroduce a removed connection.
    for (const [channel, records] of Object.entries(current.secrets || {})) {
      const nextRecords = secrets[channel] || {};
      const removed = Object.keys(records).filter((id) => !Object.prototype.hasOwnProperty.call(nextRecords, id));
      if (!removed.length) continue;
      const existing = new Set(mergedTombstones[channel] || []);
      for (const id of removed) existing.add(id);
      mergedTombstones[channel] = [...existing].slice(0, MAX_CONNECTIONS_PER_CHANNEL);
    }
    const nextGeneration = Math.max(Number(current.generation) || 0, Number(generation) || 0) + 1;
    const plaintext = JSON.stringify({ secrets, tombstones: mergedTombstones, generation: nextGeneration });
    const ciphertext = encryptString(plaintext);
    if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error("系统凭证加密失败");
    const envelope = `${JSON.stringify({
      schemaVersion: 1,
      encryption: process.platform === "win32" ? "electron-safeStorage-dpapi" : "electron-safeStorage",
      ciphertext: ciphertext.toString("base64"),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    await mkdir(vaultRoot, { recursive: true });
    const temporary = `${vaultPath}.${process.pid}.${randomUUID()}.tmp`;
    const previousTemporary = `${previousPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsyncWrite(temporary, envelope);
      // Publish the new encrypted snapshot to the recovery slot first, then
      // replace the primary. If the process dies between these two renames,
      // at least one complete copy is the new state; a deleted credential can
      // therefore never be resurrected from an older backup.
      await copyFile(temporary, previousTemporary);
      const backupHandle = await open(previousTemporary, "r+");
      try {
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
      await replaceFile(previousTemporary, previousPath);
      await replaceFile(temporary, vaultPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(previousTemporary, { force: true }).catch(() => {});
    }
    return { stored: true, connectionCount: Object.values(secrets).reduce((sum, records) => sum + Object.keys(records).length, 0) };
  };

  const read = async () => {
    const task = mutationQueue.then(async () => {
      const state = await readUnlocked();
      if (!state.recovered) return state;
      // Recovery is immediately made durable. The recovered metadata (including
      // deletion tombstones) is written as the new primary before another write
      // can run, preventing an old backup from being resurrected on restart.
      await writeUnlocked(state.secrets, {
        tombstones: state.tombstones,
        generation: state.generation,
        baseState: state,
      });
      return { ...state, recovered: false, solidified: true };
    });
    mutationQueue = task.catch(() => {});
    return task;
  };

  const write = (value) => {
    const task = mutationQueue.then(async () => {
      const current = await readUnlocked();
      return writeUnlocked(value, { tombstones: current.tombstones, baseState: current, generation: current.generation });
    });
    mutationQueue = task.catch(() => {});
    return task;
  };

  const update = (mutator) => {
    const task = mutationQueue.then(async () => {
      const current = await readUnlocked();
      const next = await mutator(current.secrets);
      return writeUnlocked(next ?? current.secrets, {
        tombstones: current.tombstones,
        baseState: current,
        generation: current.generation,
      });
    });
    mutationQueue = task.catch(() => {});
    return task;
  };

  const readChannel = async (channel) => {
    const current = await read();
    return { records: current.secrets[String(channel)] || {}, recovered: current.recovered };
  };

  const writeChannel = (channel, records) => update((secrets) => ({ ...secrets, [String(channel)]: records && typeof records === "object" ? records : {} }));
  const deleteChannel = (channel) => update((secrets) => { const next = { ...secrets }; delete next[String(channel)]; return next; });

  return { read, write, update, readChannel, writeChannel, deleteChannel, paths: { vaultPath, previousPath } };
};

export { normalizedSecrets as normalizeCredentialSecrets, normalizedTombstones as normalizeCredentialTombstones };
