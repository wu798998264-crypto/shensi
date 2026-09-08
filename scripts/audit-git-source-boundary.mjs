import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

const staged = process.argv.includes("--staged");
const review = process.argv.includes("--review");
const files = execFileSync("git", staged ? ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACM"] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 8_000_000 }).split("\0").filter(Boolean);
const forbidden = /(?:^|\/)(?:node_modules|runtime|artifacts|output|dist|release|test-results|\.git|\.shensi|\.agent-upgrade-backups|\.tmp[^/]*|generated|作品|笔记)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pfx|p12|pem|key|cer|sqlite\w*|db|exe|dmg|zip|docx|pdf|mp4|log)$/iu;
const signatures = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ["provider-token", /\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/gu],
  ["literal-credential", /\b(?:apiKey|api_key|access_token|refresh_token|client_secret|password|session_token|authorization)["']?\s*[=:]\s*["'`]([^"'`\r\n]{16,})["'`]/giu],
  ["credential-url", /https?:\/\/[^\s/]+:[^\s/@]+@[^\s]+/giu],
];
const placeholder = /(?:mock|test|fake|example|placeholder|invalid|process\.env|\$\{|\{\{|\{env:|[<>]|replace|your[-_ ]|Bearer |script|function|[\u3400-\u9fff])/iu;
const findings = [];
for (const file of new Set(files)) {
  if (forbidden.test(file)) { findings.push({ file, reason: "excluded-path" }); continue; }
  const info = await stat(file);
  if (info.size > 8_000_000) { findings.push({ file, reason: "oversized-source-candidate" }); continue; }
  if (!/\.(?:js|mjs|cjs|ts|css|html|json|md|txt|ps1|sh|nsh|yml|yaml)$/iu.test(file)) continue;
  let lineNumber = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    lineNumber++;
    for (const [reason, expression] of signatures) {
      expression.lastIndex = 0;
      for (const match of line.matchAll(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`))) {
        const value = match[1] || match[0];
        const reviewedTestLiteral = file.startsWith("scripts/test-") && /^[a-z]+(?:[-_ ][a-z0-9]+)+$/iu.test(value);
        if (!placeholder.test(value) && !reviewedTestLiteral) findings.push({ file, line: lineNumber, reason, ...(review ? {
          context: line.replace(match[0], `${reason}=<redacted:${value.length}>`).slice(0, 180),
          shape: /^[a-z]+(?:[-_ ][a-z0-9]+)+$/iu.test(value) ? "words" : "other",
        } : {}) });
      }
    }
  }
}
console.log(JSON.stringify({ scannedFiles: new Set(files).size, findings: findings.slice(0, 60), findingCount: findings.length }, null, 2));
if (findings.length) process.exitCode = 1;
