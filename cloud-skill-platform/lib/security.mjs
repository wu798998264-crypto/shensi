import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_MIN_LENGTH = 8;

const deriveSecret = async (value, { enforcePasswordLength = false } = {}) => {
  const secret = String(value ?? "");
  if (enforcePasswordLength) validatePassword(secret);
  if (!secret || secret.length > 256) throw new Error("密保答案长度无效");
  const salt = randomBytes(16);
  const derived = await scrypt(secret, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
};

export const validatePassword = (value) => {
  const password = String(value ?? "");
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 256) throw new Error("密码长度必须为 8 到 256 个字符");
  return password;
};

export const hashPassword = async (value) => {
  validatePassword(value);
  return deriveSecret(value, { enforcePasswordLength: true });
};

export const hashRecoveryAnswer = async (value) => deriveSecret(String(value ?? "").normalize("NFKC").trim());

export const verifyPassword = async (value, encoded) => {
  try {
    const [scheme, nText, rText, pText, saltText, hashText] = String(encoded || "").split("$");
    if (scheme !== "scrypt" || !saltText || !hashText) return false;
    const password = validatePassword(value);
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    const actual = Buffer.from(await scrypt(password, salt, expected.length, {
      N: Number(nText) || 16_384,
      r: Number(rText) || 8,
      p: Number(pText) || 1,
      maxmem: 64 * 1024 * 1024,
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

const verifySecret = async (value, encoded) => {
  try {
    const [scheme, nText, rText, pText, saltText, hashText] = String(encoded || "").split("$");
    if (scheme !== "scrypt" || !saltText || !hashText) return false;
    const secret = String(value ?? "");
    if (!secret || secret.length > 256) return false;
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    const actual = Buffer.from(await scrypt(secret, salt, expected.length, {
      N: Number(nText) || 16_384,
      r: Number(rText) || 8,
      p: Number(pText) || 1,
      maxmem: 64 * 1024 * 1024,
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

export const verifyRecoveryAnswer = async (value, encoded) => verifySecret(String(value ?? "").normalize("NFKC").trim(), encoded);

export const createOpaqueToken = () => randomBytes(32).toString("base64url");
export const hashToken = (value) => createHash("sha256").update(String(value || ""), "utf8").digest("hex");
export const createId = (prefix) => `${String(prefix || "id")}_${randomUUID()}`;

export const bearerToken = (request) => {
  const header = String(request.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

export const publicUser = (user) => ({
  id: String(user?.id || ""),
  account: String(user?.account || user?.email || ""),
  email: String(user?.email || ""),
  displayName: String(user?.displayName || "神思用户"),
  role: ["admin", "reviewer", "support", "membership_admin", "user"].includes(user?.role) ? user.role : "user",
  status: ["active", "pending", "suspended", "banned", "deleted"].includes(user?.status) ? user.status : "active",
  createdAt: Number(user?.createdAt) || 0,
});

export const sessionExpiry = (rememberMe) => Date.now() + (rememberMe ? 30 : 1) * 24 * 60 * 60 * 1000;
