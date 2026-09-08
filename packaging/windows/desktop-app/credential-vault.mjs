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
    return normalizedSecrets(JSON.parse(plaintext));
  };

  const readCandidate = async (target) => decode(await readFile(target, "utf8"));

  const readUnlocked = async () => {
    assertEncryption();
    try {
      return { secrets: await readCandidate(vaultPath), recovered: false };
    } catch (error) {
      if (error?.code === "ENOENT") return { secrets: {}, recovered: false };
      try {
        const recovered = await readCandidate(previousPath);
        return { secrets: recovered, recovered: true };
      } catch (backupError) {
        if (backupError?.code === "ENOENT") throw new Error(`凭证仓无法读取：${error.message}`);
        throw new Error(`凭证仓与恢复副本均无法读取：${error.message}；${backupError.message}`);
      }
    }
  };

  const writeUnlocked = async (value) => {
    assertEncryption();
    const secrets = normalizedSecrets(value);
    const plaintext = JSON.stringify(secrets);
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
    try {
      await copyFile(vaultPath, previousPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await fsyncWrite(temporary, envelope);
      await replaceFile(temporary, vaultPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return { stored: true, connectionCount: Object.values(secrets).reduce((sum, records) => sum + Object.keys(records).length, 0) };
  };

  const read = async () => {
    await mutationQueue;
    return readUnlocked();
  };

  const write = (value) => {
    const task = mutationQueue.then(() => writeUnlocked(value));
    mutationQueue = task.catch(() => {});
    return task;
  };

  const update = (mutator) => {
    const task = mutationQueue.then(async () => {
      const current = await readUnlocked();
      const next = await mutator(current.secrets);
      return writeUnlocked(next ?? current.secrets);
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

export { normalizedSecrets as normalizeCredentialSecrets };
