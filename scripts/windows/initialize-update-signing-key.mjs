import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const localAppData = String(process.env.LOCALAPPDATA || "").trim();
if (!localAppData) throw new Error("LOCALAPPDATA 未设置，无法创建本机发布密钥目录");

const keyRoot = resolve(process.env.SHENSI_RELEASE_KEY_ROOT || join(localAppData, "ShensiRelease", "signing"));
const privateKeyPath = join(keyRoot, "manifest-ed25519-private.pem");
const publicKeyPath = join(keyRoot, "manifest-ed25519-public.pem");
await mkdir(keyRoot, { recursive: true });

const exists = async (path) => Boolean(await stat(path).catch(() => null));
if (!(await exists(privateKeyPath)) || !(await exists(publicKeyPath))) {
  if (await exists(privateKeyPath) || await exists(publicKeyPath)) {
    throw new Error("更新签名密钥不完整；为避免覆盖有效私钥，已停止初始化");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const privateOptions = process.platform === "win32" ? { encoding: "utf8", flag: "wx" } : { encoding: "utf8", mode: 0o600, flag: "wx" };
  const publicOptions = process.platform === "win32" ? { encoding: "utf8", flag: "wx" } : { encoding: "utf8", mode: 0o644, flag: "wx" };
  await writeFile(privateKeyPath, privateKey, privateOptions);
  await writeFile(publicKeyPath, publicKey, publicOptions);
}

if (process.platform === "win32") {
  const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  if (identity) {
    const targets = [
      [keyRoot, `${identity}:(OI)(CI)F`],
      [privateKeyPath, `${identity}:F`],
      [publicKeyPath, `${identity}:F`],
    ];
    for (const [target, grant] of targets) {
      const result = spawnSync("icacls.exe", [target, "/inheritance:r", "/grant:r", grant, "/C", "/Q"], { windowsHide: true, stdio: "ignore" });
      if (result.status !== 0) throw new Error(`更新签名密钥权限收紧失败：${target}`);
    }
  }
}

const publicKeyPem = await readFile(publicKeyPath, "utf8");
if (!publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new Error("更新签名公钥格式无效");
process.stdout.write(JSON.stringify({ ok: true, keyRoot, privateKeyPath, publicKeyPath, publicKeyPem }, null, 2));
