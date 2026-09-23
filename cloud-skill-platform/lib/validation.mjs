import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_DISPLAY_NAME = 80;

export const normalizeEmail = (value) => {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 255) throw new Error("请输入有效的邮箱地址");
  return email;
};

// 神思账号可以使用邮箱或由用户选择的账号名（后台管理员也可以使用纯数字账号）。
// 账号值只作为登录标识，不会被当作邮箱发送或用于密码恢复通知。
export const normalizeAccount = (value) => {
  const account = String(value ?? "").trim().toLowerCase();
  if (!account || account.length > 120 || /[\u0000-\u001f\u007f\s]/u.test(account)) throw new Error("请输入有效的神思账号");
  if (!/^[a-z0-9][a-z0-9._:@+-]{2,119}$/u.test(account)) throw new Error("账号只能包含字母、数字和常用符号，长度为 3 到 120");
  return account;
};

export const normalizeSecurityQuestion = (value) => {
  const question = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 200);
  if (question.length < 4) throw new Error("密保问题至少需要 4 个字符");
  return question;
};

export const normalizeSecurityAnswer = (value) => {
  const answer = String(value ?? "").normalize("NFKC").trim().replace(/[\u0000-\u001f\u007f]/gu, "");
  if (answer.length < 2 || answer.length > 200) throw new Error("密保答案需要为 2 到 200 个字符");
  return answer;
};

export const normalizeDisplayName = (value) => {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, MAX_DISPLAY_NAME);
  return name || "神思用户";
};

export const normalizeRecoveryContact = (value) => {
  const contact = String(value ?? "").trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact);
  const phone = /^\+?[0-9][0-9 -]{5,19}$/u.test(contact);
  if (!email && !phone) throw new Error("请输入有效的手机号或邮箱");
  return contact.replace(phone ? /[ -]/gu : /$^/gu, "");
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
