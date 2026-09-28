import { seedanceModelFamily } from "./video-generation-sequence.js";

export const seedanceReferenceDurationSeconds = (reference = {}) => {
  const seconds = Number(reference.durationSeconds) > 0
    ? Number(reference.durationSeconds) : Number(reference.durationMs) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

// Pure metadata validation: no provider check, file download or media decode.
// UI, durable job creation and CLI must enforce the same submit-time limits.
export const seedanceReferenceValidation = ({ model, references = [], requireKnownDuration = true } = {}) => {
  const family = seedanceModelFamily(model);
  if (!["seedance2.0", "seedance2.5"].includes(family)) return { ok: true };
  if (!Array.isArray(references)) return { ok: false, code: "VIDEO_REFERENCE_LIMIT_INVALID", message: "参考媒体参数必须为列表" };
  const counts = { image: 0, video: 0, audio: 0, unknown: 0 };
  const durations = { video: 0, audio: 0 };
  const unknownDuration = { video: 0, audio: 0 };
  for (const reference of references) {
    const type = String(reference?.mimeType || "").toLowerCase().split("/")[0];
    counts[["image", "video", "audio"].includes(type) ? type : "unknown"] += 1;
    if (type === "video" || type === "audio") {
      const seconds = seedanceReferenceDurationSeconds(reference);
      durations[type] += seconds;
      if (!seconds) unknownDuration[type] += 1;
    }
  }
  const fail = (message, code = "VIDEO_REFERENCE_LIMIT_INVALID") => ({ ok: false, code, message });
  const label = family === "seedance2.5" ? "Seedance 2.5" : "Seedance 2.0";
  if (counts.unknown) return fail(`${label} 参考中包含无法识别的媒体类型`);
  if (family === "seedance2.0") {
    if (references.length > 11) return fail(`Seedance 2.0 最多支持 11 个参考物，当前为 ${references.length} 个`);
    if (counts.image > 9 || counts.video > 3 || counts.audio > 3) return fail("Seedance 2.0 全能参考最多支持 9 张图片、3 个视频、3 个音频，合计不超过 11 项");
    return { ok: true, counts, durations };
  }
  if (counts.image > 30 || counts.video > 10 || counts.audio > 10) {
    return fail(`Seedance 2.5 最多支持 30 张图片、10 个视频、10 个音频；当前为图片 ${counts.image}、视频 ${counts.video}、音频 ${counts.audio}`);
  }
  for (const type of ["video", "audio"]) {
    const name = type === "video" ? "视频" : "音频";
    if (durations[type] > 30 + 1e-9) return fail(`Seedance 2.5 ${name}参考总时长不能超过 30 秒，当前为 ${Number(durations[type].toFixed(3))} 秒；请裁剪或减少参考`, "VIDEO_REFERENCE_DURATION_INVALID");
    if (requireKnownDuration && unknownDuration[type]) return fail(`有 ${unknownDuration[type]} 个${name}参考尚未读取到有效时长；请先预览或重新导入该素材后生成`, "VIDEO_REFERENCE_DURATION_INVALID");
  }
  return { ok: true, counts, durations };
};
