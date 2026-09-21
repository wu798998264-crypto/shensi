import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_DISPLAY_NAME = 80;

export const normalizeEmail = (value) => {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 255) throw new Error("请输入有效的邮箱地址");
  return email;
};

export const normalizeDisplayName = (value) => {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, MAX_DISPLAY_NAME);
  return name || "神思用户";
};

export const normalizeSkillId = (value) => {
  const id = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!/^[a-z0-9][a-z0-9._:-]{2,119}$/u.test(id)) throw new Error("Skill ID 只能包含字母、数字、点、下划线、冒号和短横线，长度为 3 到 120");
  return id;
};

export const normalizeVersion = (value) => {
  const version = String(value ?? "1.0.0").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Skill 版本必须使用类似 1.0.0 的格式");
  return version;
};

export const decodeUpload = (body) => {
  if (body?.sourceBase64) {
    const raw = String(body.sourceBase64);
    if (!/^[A-Za-z0-9+/=_-]+$/u.test(raw)) throw new Error("Skill 上传内容不是有效的 Base64");
    const bytes = Buffer.from(raw, "base64url");
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("Skill 包不能为空且不能超过 4 MB");
    return bytes;
  }
  const source = String(body?.source ?? "");
  const bytes = Buffer.from(source, "utf8");
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("Skill 内容不能为空且不能超过 4 MB");
  return bytes;
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const publicError = (error) => String(error?.message || "云端请求失败")
  .replace(/[A-Za-z]:\\[^\r\n]+/gu, "<内部路径>")
  .replace(/\/(?:Users|home|var|opt)\/[^\r\n]+/gu, "<内部路径>")
  .slice(0, 260);
