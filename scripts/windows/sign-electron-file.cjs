const { spawn } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const { join, normalize, sep } = require("node:path");

const TIMESTAMP_FALLBACKS = [
  "http://timestamp.globalsign.com/tsa/r6advanced1",
  "http://timestamp.sectigo.com",
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const findSignTool = () => {
  const kitsRoot = join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (existsSync(kitsRoot)) {
    const versions = readdirSync(kitsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(kitsRoot, version, "x64", "signtool.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Windows SDK x64 signtool.exe was not found");
};

const run = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.once("error", (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
  child.once("exit", (code) => resolve({ code: Number.isInteger(code) ? code : -1, output }));
});

const replaceTimestampUrl = (args, timestampUrl) => {
  const next = [...args];
  const marker = next.findIndex((value) => String(value).toLowerCase() === "/tr");
  if (marker >= 0 && marker + 1 < next.length) next[marker + 1] = timestampUrl;
  return next;
};

module.exports = async (configuration) => {
  const target = normalize(String(configuration.path || ""));
  if (target.toLowerCase().includes(`${sep}node_modules${sep}`.toLowerCase())) return;

  const signTool = findSignTool();
  const baseArgs = configuration.computeSignToolArgs(true);
  let lastOutput = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const timestampUrl = TIMESTAMP_FALLBACKS[attempt % TIMESTAMP_FALLBACKS.length];
    const result = await run(signTool, replaceTimestampUrl(baseArgs, timestampUrl));
    if (result.code === 0) return;
    lastOutput = result.output;
    const retryable = /timestamp server|could not be reached|invalid response|0x80072|timed?\s*out/i.test(lastOutput);
    if (!retryable || attempt === 7) break;
    await wait(8_000 + attempt * 2_000);
  }

  const detail = lastOutput.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  throw new Error(`Windows signing failed for ${target}\n${detail}`);
};
