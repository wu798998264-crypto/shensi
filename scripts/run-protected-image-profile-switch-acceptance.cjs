const { createHash, randomUUID } = require("node:crypto");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { mkdir, readFile, rename, stat, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, safeStorage } = require("electron");

const PAID_GATE = "SHENSI_RUN_PAID_PROFILE_SWITCH_ACCEPTANCE";
const SHORT_DRAMA_PROFILE_ID = "duanju-zuiqianxian";
const AGGREGATE_PROFILE_ID = "image-cockpit-aggregate-api";
const AGGREGATE_CREDENTIAL_CHANNEL = "text";
const AGGREGATE_CREDENTIAL_PROFILE_ID = "text-1787923302281-8ygl7";
const DATA_ROOT = resolve(String(process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData"));
const APP_ROOT = resolve(__dirname, "..");
const OUTPUT_ROOT = resolve(process.env.SHENSI_PROFILE_SWITCH_OUTPUT
  || join(APP_ROOT, "artifacts", "protected-image-profile-switch-2026-09-04"));
const LEDGER_PATH = join(OUTPUT_ROOT, "acceptance-state.json");
const REPORT_PATH = join(OUTPUT_ROOT, "acceptance-report.json");
const desktopRoot = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime");
const vaultPath = join(desktopRoot, "Credentials", "generation-secrets.dpapi.json");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const finiteNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value)
  : null;

const SEQUENCE = Object.freeze([
  {
    kind: "aggregate",
    profileId: "image-cockpit-aggregate-api",
    displayName: "聚合api",
    prompt: "受保护账号切换验收图：雾蓝色摄影棚中，一只银色机械猫坐在青绿色圆环旁，右上方悬浮一颗红色五角星，电影级写实光影，无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "xiaoyujie",
    displayName: "小鱼姐",
    prompt: "受保护账号切换验收图：奶油白背景，一只橙色纸鹤立在湖蓝色方块上，柔和产品摄影光，无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "guobazai",
    displayName: "锅巴仔",
    prompt: "受保护账号切换验收图：深灰色背景，一艘金色纸船穿过紫色圆环，电影级体积光，无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "chenan",
    displayName: "陈安",
    prompt: "受保护账号切换验收图：清晨薄雾中，一把青绿色雨伞靠在红色长椅旁，写实电影质感，无人物无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "tashuo-juyougeng",
    displayName: "她说剧有梗",
    prompt: "受保护账号切换验收图：暖金色舞台上，一只白色陶瓷鹿站在靛蓝色拱门前，戏剧性灯光，无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "yinou-shijie",
    displayName: "银鸥师姐",
    prompt: "受保护账号切换验收图：海边日落，一只银白色海鸥掠过翠绿色灯塔，电影级写实画面，无文字无水印。",
  },
  {
    kind: "dreamina",
    profileId: "default",
    displayName: "柏物语",
    prompt: "受保护账号切换回归图：雨后森林里，一株白色柏树幼苗生长在琥珀色圆盘中央，清晰电影光影，无文字无水印。",
  },
]);

const redact = (value) => String(value?.message || value || "")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]")
  .replace(/(?:user_?id|uid)\s*[=:]\s*[A-Za-z0-9_-]+/giu, "user_id=[REDACTED]")
  .replace(/[A-Fa-f0-9]{64,}/gu, "[REDACTED]")
  .slice(0, 2_000);

const atomicJson = async (target, value) => {
  await mkdir(resolve(target, ".."), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
};

const loadLedger = async () => {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_PATH, "utf8"));
    return parsed && parsed.schemaVersion === 1 && parsed.sequenceId === "protected-image-profile-switch-v1"
      ? parsed
      : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const createLedger = () => ({
  schemaVersion: 1,
  sequenceId: "protected-image-profile-switch-v1",
  startedAt: now(),
  updatedAt: now(),
  status: "running",
  excludedProfileIds: [SHORT_DRAMA_PROFILE_ID],
  steps: Object.fromEntries(SEQUENCE.map((step, index) => [step.profileId, {
    index,
    kind: step.kind,
    profileId: step.profileId,
    displayName: step.displayName,
    idempotencyKey: `protected-switch-${String(index + 1).padStart(2, "0")}-${step.profileId}-${Date.now()}`,
    status: "pending",
    providerTaskId: "",
  }])),
});

const dimensions = (buffer) => {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        format: "webp",
      };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: "jpeg" };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (!length) break;
      offset += 2 + length;
    }
  }
  throw new Error("下载结果不是可验收的 PNG/JPEG/WebP 图片");
};

const inspectImage = async (path) => {
  const absolutePath = resolve(path);
  const buffer = await readFile(absolutePath);
  if (buffer.length < 10_000) throw new Error(`图片文件过小（${buffer.length} bytes）`);
  const image = dimensions(buffer);
  if (image.width < 256 || image.height < 256) throw new Error(`图片尺寸异常（${image.width}x${image.height}）`);
  return {
    path: absolutePath,
    bytes: buffer.length,
    width: image.width,
    height: image.height,
    format: image.format,
    sha256: sha256(buffer),
  };
};

const reusableCompletion = async (record) => {
  if (record?.status !== "completed" || !record.output?.path || !record.output?.sha256) return false;
  try {
    const current = await inspectImage(record.output.path);
    return current.sha256 === record.output.sha256
      && current.width === record.output.width
      && current.height === record.output.height;
  } catch {
    return false;
  }
};

const sharedAggregateCredential = () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
  const envelope = JSON.parse(readFileSync(vaultPath, "utf8"));
  const secrets = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")));
  const apiKey = String(secrets?.[AGGREGATE_CREDENTIAL_CHANNEL]?.[AGGREGATE_CREDENTIAL_PROFILE_ID] || "").trim();
  if (!apiKey) throw new Error("聚合 API 共享的文字连接凭证不存在");
  return apiKey;
};

const verifyAggregateModel = async (settings) => {
  const response = await fetch(`${settings.baseUrl.replace(/\/$/u, "")}/models`, {
    headers: { authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `聚合 API 模型探针失败（HTTP ${response.status}）`);
  const ids = (Array.isArray(payload?.data) ? payload.data : []).map((item) => String(item?.id || ""));
  if (ids.length && !ids.includes(settings.model)) throw new Error(`聚合 API 当前未列出模型 ${settings.model}`);
  return true;
};

const saveDataUrl = async (dataUrl, outputPath) => {
  const matched = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/su);
  if (!matched) throw new Error("聚合 API 没有返回可保存的 base64 图片");
  await writeFile(outputPath, Buffer.from(matched[2], "base64"));
};

const generateAggregate = async ({ step, record }) => {
  const apiKey = sharedAggregateCredential();
  const settings = {
    id: AGGREGATE_PROFILE_ID,
    connectionId: AGGREGATE_PROFILE_ID,
    name: "聚合api",
    provider: "自定义兼容接口",
    adapter: "api",
    protocol: "images",
    baseUrl: "http://127.0.0.1:5317/v1",
    model: "gpt-image-2",
    timeoutMs: "660000",
    apiKey,
  };
  if (Object.hasOwn(settings, "dreaminaCliProfile")) throw new Error("聚合 API 被污染了即梦配置元数据");
  await verifyAggregateModel(settings);
  const { generateImageWithAdapter } = await import(pathToFileURL(join(APP_ROOT, "src", "server", "adapters.mjs")).href);
  const result = await generateImageWithAdapter({
    settings,
    prompt: step.prompt,
    aspectRatio: "1:1",
    quality: "standard",
    spec: "standard",
    imageCount: 1,
    idempotencyKey: record.idempotencyKey,
    referenceMedia: [],
  });
  if (result.returnedImageCount !== 1 || !result.dataUrl) throw new Error(`聚合 API 预期返回 1 张，实际为 ${result.returnedImageCount || 0} 张`);
  const outputPath = join(OUTPUT_ROOT, `${String(record.index + 1).padStart(2, "0")}-${step.profileId}.png`);
  await saveDataUrl(result.dataUrl, outputPath);
  return {
    providerTaskId: String(result.providerResponseId || ""),
    identityMatched: null,
    capabilityChecked: true,
    output: await inspectImage(outputPath),
  };
};

const generateDreamina = async ({ step, record, ledger }) => {
  // The aggregate step needs Electron safeStorage, but the Dreamina driver
  // launches its JavaScript bridge with process.execPath. In this acceptance
  // runner process.execPath is electron.exe, so every bridge child must opt
  // into Electron's Node mode just like the desktop application's Node worker.
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const [{ DreaminaImageDriver }, { readDreaminaProfileIdentityStore }] = await Promise.all([
    import(pathToFileURL(join(APP_ROOT, "src", "server", "media-provider-drivers.mjs")).href),
    import(pathToFileURL(join(APP_ROOT, "src", "server", "dreamina-profile-identity-store.mjs")).href),
  ]);
  const settings = {
    id: `image-dreamina-${step.profileId}`,
    connectionId: `image-dreamina-${step.profileId}`,
    provider: "即梦",
    adapter: "cli",
    protocol: "images",
    model: "5.0",
    dreaminaCliProfile: step.profileId,
    timeoutMs: String(12 * 60_000),
  };
  const driver = new DreaminaImageDriver();
  let capability = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    capability = await driver.probeCapabilities({ settings, forceFresh: true });
    if (capability.available && capability.generationReady) break;
    const delayedTaskResource = capability.controlPlaneDeferred === true
      || (capability.available === true && capability.generationReady !== true);
    if (!delayedTaskResource || attempt === 4) break;
    process.stdout.write(`${JSON.stringify({
      event: "wait-task-resource",
      profileId: step.profileId,
      attempt,
      code: String(capability.taskResourceErrorCode || "TASK_RESOURCE_DEFERRED"),
    })}\n`);
    await sleep(attempt * 5_000);
  }
  const identity = (await readDreaminaProfileIdentityStore()).profiles[step.profileId] || {};
  const identityMatched = Boolean(identity.expectedUserId
    && capability.userId
    && identity.expectedUserId === capability.userId
    && capability.profileId === step.profileId);
  if (!identityMatched) {
    throw Object.assign(new Error("即梦实时身份与该配置保存身份不一致，已阻止串号"), { code: "DREAMINA_PROFILE_ID_MISMATCH" });
  }
  if (!capability.available || (!capability.generationReady && !record.providerTaskId)) {
    const delayed = capability.controlPlaneDeferred === true || capability.available === true;
    throw Object.assign(new Error(capability.raw?.message || capability.reason || capability.controlPlaneWarning || "即梦图片任务资源不可用"), {
      code: delayed ? String(capability.taskResourceErrorCode || "DREAMINA_TASK_RESOURCE_UNVERIFIED") : "DREAMINA_AUTH_REQUIRED",
    });
  }

  const workRoot = join(OUTPUT_ROOT, "work", record.idempotencyKey);
  const outputPath = join(OUTPUT_ROOT, `${String(record.index + 1).padStart(2, "0")}-${step.profileId}.png`);
  const job = {
    id: record.idempotencyKey,
    idempotencyKey: record.idempotencyKey,
    providerTaskId: String(record.providerTaskId || ""),
    pollCount: Math.max(0, Number(record.pollCount) || 0),
    request: {
      prompt: step.prompt,
      executionPrompt: step.prompt,
      aspectRatio: "1:1",
      quality: "1k",
      resolution: "1k",
      imageCount: 1,
      settings,
      referenceMedia: [],
    },
  };

  let result = null;
  if (!job.providerTaskId) {
    try {
      result = await driver.submit({ job, settings, references: [], workRoot });
    } catch (error) {
      const reconciled = await driver.reconcileSubmission({ job, settings, workRoot }).catch(() => null);
      if (!reconciled?.providerTaskId) throw error;
      result = reconciled;
    }
    if (!result?.providerTaskId) throw new Error("即梦提交未返回可持久化的厂商任务号");
    job.providerTaskId = result.providerTaskId;
    record.providerTaskId = job.providerTaskId;
    record.submittedAt = record.submittedAt || now();
    record.status = "submitted";
    ledger.updatedAt = now();
    await atomicJson(LEDGER_PATH, ledger);
  }

  if (!result || !["completed", "failed", "cancelled"].includes(result.providerStatus)) {
    for (let poll = job.pollCount; poll < 180; poll += 1) {
      await sleep(poll < 10 ? 3_000 : 5_000);
      job.pollCount = poll + 1;
      record.pollCount = job.pollCount;
      result = await driver.getStatus({ job, settings, workRoot });
      if (["completed", "failed", "cancelled"].includes(result.providerStatus)) break;
      if ((poll + 1) % 6 === 0) {
        ledger.updatedAt = now();
        await atomicJson(LEDGER_PATH, ledger);
      }
    }
  }
  if (result?.providerStatus !== "completed") {
    throw new Error(`即梦任务未完成：${result?.providerStatus || "timeout"} ${result?.error || result?.rawStatus || ""}`);
  }
  const downloaded = await driver.download({ job, settings, workRoot, outputPath });
  const paths = (Array.isArray(downloaded.paths) && downloaded.paths.length
    ? downloaded.paths
    : [downloaded.path || downloaded.downloadedPath || outputPath]).filter(Boolean).map((value) => resolve(value));
  if (paths.length !== 1) throw new Error(`即梦预期下载 1 张，实际为 ${paths.length} 张`);
  return {
    providerTaskId: job.providerTaskId,
    identityMatched,
    capabilityChecked: true,
    creditBefore: finiteNumber(capability.credit),
    creditCount: finiteNumber(result.creditCount),
    output: await inspectImage(paths[0]),
  };
};

const run = async () => {
  if (String(process.env[PAID_GATE] || "") !== "1") {
    throw new Error(`真实付费验收被保护；仅在用户明确授权后设置 ${PAID_GATE}=1`);
  }
  if (SEQUENCE.some((step) => step.profileId === SHORT_DRAMA_PROFILE_ID)) throw new Error("短剧最前线不得进入本验收序列");
  if (SEQUENCE[0].profileId !== AGGREGATE_PROFILE_ID || SEQUENCE.at(-1).profileId !== "default") {
    throw new Error("受保护序列必须以聚合 API 开始并以柏物语结束");
  }
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const ledger = await loadLedger() || createLedger();
  await atomicJson(LEDGER_PATH, ledger);

  for (const step of SEQUENCE) {
    const record = ledger.steps[step.profileId];
    if (!record || record.index !== SEQUENCE.indexOf(step)) throw new Error(`验收账本顺序损坏：${step.profileId}`);
    if (await reusableCompletion(record)) {
      record.blocker = "";
      record.error = "";
      record.errorCode = "";
      record.blockedAt = "";
      ledger.updatedAt = now();
      await atomicJson(LEDGER_PATH, ledger);
      process.stdout.write(`${JSON.stringify({ event: "reuse", profileId: step.profileId, status: "completed" })}\n`);
      continue;
    }
    const predecessor = SEQUENCE[record.index - 1];
    if (predecessor && ledger.steps[predecessor.profileId]?.status !== "completed") {
      throw new Error(`上一步 ${predecessor.profileId} 尚未完成，拒绝切换到 ${step.profileId}`);
    }
    record.status = record.providerTaskId ? "submitted" : "running";
    record.startedAt = record.startedAt || now();
    record.predecessorCompletedAt = predecessor ? ledger.steps[predecessor.profileId].completedAt : null;
    ledger.updatedAt = now();
    await atomicJson(LEDGER_PATH, ledger);
    process.stdout.write(`${JSON.stringify({ event: "start", index: record.index + 1, profileId: step.profileId, displayName: step.displayName })}\n`);
    try {
      const generated = step.kind === "aggregate"
        ? await generateAggregate({ step, record })
        : await generateDreamina({ step, record, ledger });
      Object.assign(record, generated, {
        status: "completed",
        completedAt: now(),
        blocker: "",
        error: "",
        errorCode: "",
        blockedAt: "",
      });
      ledger.updatedAt = now();
      await atomicJson(LEDGER_PATH, ledger);
      process.stdout.write(`${JSON.stringify({
        event: "completed",
        index: record.index + 1,
        profileId: step.profileId,
        providerTaskId: record.providerTaskId,
        bytes: record.output.bytes,
        dimensions: `${record.output.width}x${record.output.height}`,
        sha256: record.output.sha256,
        identityMatched: record.identityMatched,
      })}\n`);
    } catch (error) {
      record.status = record.providerTaskId ? "submitted" : "blocked";
      record.error = redact(error);
      record.errorCode = String(error?.code || error?.providerErrorCode || "").slice(0, 100);
      record.blockedAt = now();
      record.blocker = /DREAMINA_PROFILE_BROKER_BUSY/u.test(`${record.errorCode} ${record.error}`)
        ? "DREAMINA_PROFILE_BROKER_BUSY"
        : /DREAMINA_INSUFFICIENT_CREDIT|积分为 0|积分不足/u.test(`${record.errorCode} ${record.error}`)
          ? "DREAMINA_INSUFFICIENT_CREDIT"
        : /DREAMINA_AUTH_REQUIRED|未检测到有效登录态|请核验/u.test(`${record.errorCode} ${record.error}`)
          ? "DREAMINA_AUTH_REQUIRED"
          : /DREAMINA_PROFILE_ID_MISMATCH/u.test(`${record.errorCode} ${record.error}`)
            ? "DREAMINA_PROFILE_ID_MISMATCH"
            : /timeout|timed out|超时/iu.test(record.error) ? "TIMEOUT" : "OTHER";
      ledger.status = "blocked";
      ledger.updatedAt = now();
      await atomicJson(LEDGER_PATH, ledger);
      throw error;
    }
  }

  ledger.status = "completed";
  ledger.completedAt = now();
  ledger.updatedAt = now();
  await atomicJson(LEDGER_PATH, ledger);
  const report = {
    schemaVersion: 1,
    workflow: ledger.sequenceId,
    startedAt: ledger.startedAt,
    completedAt: ledger.completedAt,
    excludedProfileIds: ledger.excludedProfileIds,
    strictlySerial: true,
    allPassed: true,
    results: SEQUENCE.map((step) => {
      const record = ledger.steps[step.profileId];
      return {
        index: record.index + 1,
        profileId: record.profileId,
        displayName: record.displayName,
        providerTaskId: record.providerTaskId,
        startedAt: record.startedAt,
        predecessorCompletedAt: record.predecessorCompletedAt,
        completedAt: record.completedAt,
        identityMatched: record.identityMatched,
        creditBefore: record.creditBefore ?? null,
        creditCount: record.creditCount ?? null,
        output: record.output,
      };
    }),
  };
  await atomicJson(REPORT_PATH, report);
  process.stdout.write(`${JSON.stringify({ event: "acceptance-completed", reportPath: REPORT_PATH, count: report.results.length })}\n`);
};

app.setPath("userData", desktopRoot);
app.setPath("sessionData", join(desktopRoot, "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");
app.whenReady().then(run).then(() => app.exit(0)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: String(error?.code || ""), message: redact(error), outputRoot: OUTPUT_ROOT })}\n`);
  app.exit(1);
});
