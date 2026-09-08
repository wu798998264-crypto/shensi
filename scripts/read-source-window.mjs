import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const readSourceWindow = async (path, marker, lineCount = 80) => {
  if (!marker || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 250) throw new Error("A source window requires a marker and 1–250 lines");
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  try {
    for await (const line of reader) {
      if (!lines.length && !line.includes(marker)) continue;
      lines.push(line);
      if (lines.length === lineCount) break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (!lines.length) throw new Error(`Source marker not found: ${marker}`);
  return lines.join("\n");
};
