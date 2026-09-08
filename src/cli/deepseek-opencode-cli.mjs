import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocalOpenCodeLaunch } from "./opencode-launch.mjs";
import { deepSeekOpenCodeProviderConfig, qualifiedDeepSeekOpenCodeModel } from "./deepseek-opencode-config.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;

const argumentValue = (args, name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : fallback;
};

const readStandardInput = async () => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("输入超过 8MB，已停止 DeepSeek CLI 调用");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sanitizedMessage = (value, apiKey = process.env.DEEPSEEK_API_KEY || "") => {
  let message = String(value || "DeepSeek OpenCode CLI 调用失败");
  if (apiKey) message = message.replaceAll(apiKey, "[REDACTED]");
  return message
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 4_000);
};

const openCodeErrorMessage = (event = {}) => event?.error?.data?.message
  || event?.error?.message
  || event?.message
  || event?.error?.name
  || "OpenCode 返回错误事件";

export const parseOpenCodeJsonEvents = (stdout = "") => {
  const textParts = [];
  let parsedEvents = 0;
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    parsedEvents += 1;
    if (event?.type === "error") throw new Error(openCodeErrorMessage(event));
    if (event?.type !== "text" && event?.part?.type !== "text") continue;
    const value = event?.part?.text ?? event?.text ?? event?.content;
    if (typeof value === "string" && value) textParts.push(value);
  }
  const text = textParts.join("").trim();
  if (!text) {
    throw new Error(parsedEvents
      ? "OpenCode 已结束，但没有返回可用文本"
      : "OpenCode 没有返回可解析的 JSON 事件");
  }
  return text;
};

const spawnOpenCode = ({ executable, args, input, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS }) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectRun(error);
    else resolveRun(value);
  };
  const append = (current, chunk) => {
    const next = current + chunk;
    if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
      child.kill();
      finish(new Error("OpenCode 输出超过 4MB，已停止本次调用"));
      return current;
    }
    return next;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.stdin.on("error", (error) => {
    if (!settled) finish(new Error(`OpenCode 输入管道提前关闭：${error.message}`));
  });
  child.once("error", (error) => finish(new Error(`OpenCode 无法启动：${error.message}`)));
  child.once("close", (code) => {
    if (code !== 0) {
      let detail = stderr.trim();
      if (!detail && stdout.trim()) {
        try {
          parseOpenCodeJsonEvents(stdout);
        } catch (error) {
          detail = error.message;
        }
      }
      finish(new Error(`OpenCode 退出码 ${code}：${detail || "没有错误输出"}`));
      return;
    }
    finish(null, { stdout, stderr });
  });
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error(`OpenCode 调用超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`));
  }, timeoutMs);
  timer.unref?.();
  child.stdin.end(input || "");
});

export const runDeepSeekOpenCode = async ({
  prompt,
  model = "deepseek-v4-pro",
  reasoningEffort = "",
  environment = process.env,
  launchResolver = resolveLocalOpenCodeLaunch,
} = {}) => {
  const apiKey = String(environment.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw new Error("DeepSeek CLI 缺少 DEEPSEEK_API_KEY；请先在神思中保存 DeepSeek API 连接");
  const input = String(prompt || "").trim();
  if (!input) throw new Error("DeepSeek CLI 没有收到提示词");

  const tempRoot = await mkdtemp(join(tmpdir(), "shensi-deepseek-opencode-"));
  try {
    const xdgConfig = join(tempRoot, "xdg-config");
    const xdgData = join(tempRoot, "xdg-data");
    const xdgCache = join(tempRoot, "xdg-cache");
    const xdgState = join(tempRoot, "xdg-state");
    await Promise.all([xdgConfig, xdgData, xdgCache, xdgState].map((path) => mkdir(path, { recursive: true })));

    const launch = await launchResolver({ environment });
    const config = {
      ...deepSeekOpenCodeProviderConfig([model]),
      share: "disabled",
      snapshot: false,
      permission: { "*": "deny" },
      mcp: {},
      plugin: [],
    };
    const args = [
      ...(Array.isArray(launch?.prefixArgs) ? launch.prefixArgs : []),
      "run",
      "--pure",
      "--model",
      qualifiedDeepSeekOpenCodeModel(model),
      "--format",
      "json",
    ];
    const variant = String(reasoningEffort || environment.SHENSI_DEEPSEEK_REASONING_EFFORT || "").trim().toLowerCase();
    if (["high", "max"].includes(variant)) args.push("--variant", variant);
    const result = await spawnOpenCode({
      executable: String(launch?.executable || ""),
      args,
      input: `Answer the following prompt directly. Do not use tools or modify files. Return only the answer.\n\n${input}`,
      cwd: tempRoot,
      env: {
        ...environment,
        DEEPSEEK_API_KEY: apiKey,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
      },
    });
    return parseOpenCodeJsonEvents(result.stdout);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const promptFile = argumentValue(args, "--prompt-file");
  const prompt = promptFile ? await readFile(promptFile, "utf8") : await readStandardInput();
  const text = await runDeepSeekOpenCode({
    prompt,
    model: argumentValue(args, "--model", "deepseek-v4-pro"),
    reasoningEffort: argumentValue(args, "--reasoning", ""),
  });
  process.stdout.write(text);
};

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`DeepSeek OpenCode CLI 失败：${sanitizedMessage(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
