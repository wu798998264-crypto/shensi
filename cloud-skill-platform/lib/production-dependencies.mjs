import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const safeSegment = (value) => String(value || "").replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 140);

const scanner = ({ executable = "clamdscan" } = {}) => ({
  async health() {
    const result = await execFile(executable, ["--version"], { timeout: 8_000, windowsHide: true });
    return /ClamAV|clamd/u.test(String(result.stdout || result.stderr || ""));
  },
  async scan(bytes) {
    const root = await mkdtemp(join(tmpdir(), "shensi-skill-scan-"));
    const target = join(root, "upload.skill");
    try {
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
      try {
        const result = await execFile(executable, ["--fdpass", "--no-summary", target], {
          timeout: 60_000,
          windowsHide: true,
          maxBuffer: 512 * 1024,
        });
        return { status: "passed", findings: [], scanner: "clamav", detail: String(result.stdout || "").trim().slice(0, 500) };
      } catch (error) {
        if (Number(error.code) === 1) {
          return { status: "blocked", findings: ["malware_detected"], scanner: "clamav", detail: "ClamAV 检测到风险内容" };
        }
        throw Object.assign(new Error("ClamAV 扫描服务不可用，上传未被接收"), { cause: error });
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  },
});

const redisRuntime = async ({ url } = {}) => {
  if (!url) return {
    async health() { return false; },
    async limit() { throw new Error("生产环境缺少 Redis 连接地址"); },
  };
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { connectTimeout: 5_000, reconnectStrategy: (retries) => Math.min(500 + retries * 250, 5_000) } });
  client.on("error", () => {});
  let connectFlight = null;
  const ensureConnected = async () => {
    if (client.isOpen) return;
    connectFlight ||= client.connect().finally(() => { connectFlight = null; });
    await connectFlight;
  };
  return {
    async health() { await ensureConnected(); return await client.ping() === "PONG"; },
    async limit(key, { maximum = 10, windowSeconds = 60 } = {}) {
      await ensureConnected();
      const normalized = `shensi:skill-upload:${safeSegment(key) || "anonymous"}`;
      const count = await client.incr(normalized);
      if (count === 1) await client.expire(normalized, windowSeconds);
      if (count > maximum) throw Object.assign(new Error("上传过于频繁，请稍后再试"), { statusCode: 429 });
      return { count, remaining: Math.max(0, maximum - count) };
    },
  };
};

const ossRuntime = async ({ region, endpoint, bucket, roleName } = {}) => {
  if (!region || !bucket || !roleName) return {
    bucket: bucket || "",
    async health() { return false; },
    async stage() { throw new Error("生产环境缺少 OSS 区域、私有 Bucket 或 ECS RAM 角色名"); },
    async publish() { throw new Error("生产环境缺少 OSS 区域、私有 Bucket 或 ECS RAM 角色名"); },
    async read() { throw new Error("生产环境缺少 OSS 私有 Bucket"); },
    async remove() { return false; },
  };
  const [{ default: OSS }, credentialModule] = await Promise.all([
    import("ali-oss"),
    import("@alicloud/credentials"),
  ]);
  const Credential = credentialModule.default || credentialModule.Credential;
  const credential = new Credential({ type: "ecs_ram_role", roleName, disableIMDSv1: true });
  const readCredential = async () => {
    const current = await credential.getCredential();
    return {
      accessKeyId: current.accessKeyId,
      accessKeySecret: current.accessKeySecret,
      stsToken: current.securityToken,
    };
  };
  let client = null;
  let clientFlight = null;
  const clientFor = async () => {
    if (client) return client;
    clientFlight ||= (async () => {
      const initial = await readCredential();
      return new OSS({
        region,
        ...(endpoint ? { endpoint } : {}),
        bucket,
        secure: true,
        authorizationV4: true,
        ...initial,
        refreshSTSToken: readCredential,
        refreshSTSTokenInterval: 15 * 60 * 1000,
      });
    })().then((created) => { client = created; return created; }).finally(() => { clientFlight = null; });
    return clientFlight;
  };
  const quarantineKey = (skillId, version) => `quarantine/${safeSegment(skillId)}/${safeSegment(version)}/${Date.now()}-${randomUUID()}.skill`;
  const artifactKey = (skillId, version, sha256) => `artifacts/${safeSegment(skillId)}/${safeSegment(version)}/${String(sha256 || "").toLowerCase()}.skill`;
  return {
    bucket,
    async health() {
      await (await clientFor()).listV2({ prefix: "health/", "max-keys": 1 });
      return true;
    },
    async stage({ skillId, version, bytes }) {
      const key = quarantineKey(skillId, version);
      await (await clientFor()).put(key, bytes, { headers: { "x-oss-object-acl": "private", "Cache-Control": "no-store" } });
      return key;
    },
    async publish({ skillId, version, sha256, objectKey }) {
      if (!objectKey?.startsWith("quarantine/")) throw new Error("Skill 隔离对象不存在，不能发布");
      const target = artifactKey(skillId, version, sha256);
      await (await clientFor()).copy(target, objectKey);
      return target;
    },
    async read(objectKey) {
      if (!String(objectKey || "").startsWith("artifacts/")) throw new Error("Skill 制品尚未发布");
      const result = await (await clientFor()).get(objectKey);
      return Buffer.from(result.content);
    },
    async remove(objectKey) {
      if (!/^(?:quarantine|artifacts)\//u.test(String(objectKey || ""))) return false;
      await (await clientFor()).delete(objectKey);
      return true;
    },
  };
};

export const createProductionDependencies = async ({ environment = process.env } = {}) => {
  const malwareScanner = scanner({ executable: String(environment.SHENSI_CLOUD_CLAMDSCAN_PATH || "clamdscan") });
  const [redis, objects] = await Promise.all([
    redisRuntime({ url: String(environment.SHENSI_CLOUD_REDIS_URL || "") }),
    ossRuntime({
      region: String(environment.SHENSI_CLOUD_OSS_REGION || ""),
      endpoint: String(environment.SHENSI_CLOUD_OSS_ENDPOINT || ""),
      bucket: String(environment.SHENSI_CLOUD_OSS_BUCKET || ""),
      roleName: String(environment.SHENSI_CLOUD_OSS_ROLE_NAME || environment.ALIBABA_CLOUD_ECS_METADATA || ""),
    }),
  ]);
  return {
    redis,
    objects,
    scanner: malwareScanner,
    async health({ store, signingKey }) {
      const [postgres, redisReady, objectStorage, malwareScannerReady] = await Promise.all([
        store.health().catch(() => false),
        redis.health().catch(() => false),
        objects.health().catch(() => false),
        malwareScanner.health().catch(() => false),
      ]);
      const artifactSigning = Boolean(signingKey?.privateKeyPem && signingKey?.publicKeyPem);
      return { postgres, redis: redisReady, objectStorage, malwareScanner: malwareScannerReady, artifactSigning };
    },
  };
};
