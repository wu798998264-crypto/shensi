const SOURCE_SECTION_HEADING = /^(?:#{1,6}[ \t]+)?(?:参考来源|网络来源|资料来源|来源链接|来源|references?|sources?)\s*[:：]?\s*$/i;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gi;
const RAW_WEB_URL = /https?:\/\/[^\s<>)\]"']+/gi;

const normalizedSource = (url, title = "") => {
  try {
    const parsed = new URL(String(url ?? ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return {
      url: parsed.toString(),
      title: String(title ?? "").trim().slice(0, 240) || parsed.hostname,
    };
  } catch {
    return null;
  }
};

export const collectOutputWebSources = (value = "", providedSources = []) => {
  const sources = [];
  const add = (url, title = "") => {
    const source = normalizedSource(url, title);
    if (source && !sources.some((item) => item.url === source.url)) sources.push(source);
  };
  for (const source of providedSources ?? []) add(source?.url, source?.title || source?.name);
  for (const match of String(value).matchAll(MARKDOWN_LINK)) add(match[2], match[1]);
  for (const match of String(value).matchAll(RAW_WEB_URL)) add(match[0]);
  return sources.slice(0, 20);
};

const cleanWebLine = (line) => String(line)
  .replace(MARKDOWN_LINK, "$1")
  .replace(/<\s*(https?:\/\/[^>]+)>/gi, "")
  .replace(RAW_WEB_URL, "")
  .replace(/cite[^]+/g, "")
  .replace(/【\d+†[^】]+】/g, "")
  .replace(/[ \t]+([，。；：！？、])/g, "$1")
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\(\s*\)|（\s*）/g, "")
  .trimEnd();

export const separateWebSources = (value = "", providedSources = []) => {
  const source = String(value ?? "").replace(/\r\n?/g, "\n");
  const sources = collectOutputWebSources(source, providedSources);
  const lines = source.split("\n");
  const cleaned = [];
  let fenced = false;
  let sourceSection = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      cleaned.push(line);
      continue;
    }
    if (!fenced && SOURCE_SECTION_HEADING.test(line.trim())) {
      sourceSection = true;
      continue;
    }
    if (sourceSection) {
      if (!line.trim() || /^\s*(?:[-*+]\s+|\d+[.)]\s*)?(?:\[[^\]]+\]\()?https?:\/\//i.test(line)) continue;
      if (/^#{1,6}[ \t]+/.test(line)) sourceSection = false;
      else continue;
    }
    cleaned.push(fenced ? line : cleanWebLine(line));
  }
  return {
    text: cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    sources,
  };
};

export const stripMarkdownHeadingMarkers = (value = "") => {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : line.replace(/^\s{0,3}#{1,6}[ \t]+/, "");
  }).join("\n").trim();
};
