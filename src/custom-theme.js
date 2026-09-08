import { TRASH_RETENTION_MS } from "./trash.js";

export const CUSTOM_THEME_COLOR_KEYS = Object.freeze([
  "topbar",
  "sidebar",
  "editor",
  "chat",
  "text",
  "accent",
]);

export const CUSTOM_THEME_SWATCHES = Object.freeze([
  "#ffffff",
  "#f4f4f2",
  "#e3e7ea",
  "#b8c0c8",
  "#5d6670",
  "#17191c",
  "#d86f67",
  "#df9c45",
  "#d7bc45",
  "#54a678",
  "#3d9d96",
  "#4d8fc6",
  "#576fd1",
  "#936ac4",
  "#c56f9b",
]);

export const DEFAULT_CUSTOM_THEME = Object.freeze({
  name: "",
  colors: Object.freeze({
    topbar: "#f8f9fa",
    sidebar: "#eef1f3",
    editor: "#ffffff",
    chat: "#f4f6f8",
    text: "#17191c",
    accent: "#4169d8",
  }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const normalizeHexColor = (value, fallback = "#000000") => {
  const source = String(value ?? "").trim();
  const short = source.match(/^#([\da-f]{3})$/i);
  if (short) return `#${[...short[1]].map((character) => character.repeat(2)).join("")}`.toLowerCase();
  if (/^#[\da-f]{6}$/i.test(source)) return source.toLowerCase();
  return /^#[\da-f]{6}$/i.test(fallback) ? fallback.toLowerCase() : "#000000";
};

export const normalizeCustomTheme = (value = {}) => {
  const colors = value?.colors && typeof value.colors === "object" ? value.colors : value;
  return {
    name: String(value?.name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 40),
    colors: Object.fromEntries(CUSTOM_THEME_COLOR_KEYS.map((key) => [
      key,
      normalizeHexColor(colors?.[key], DEFAULT_CUSTOM_THEME.colors[key]),
    ])),
  };
};

const validIso = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
};

const themeSignature = (theme) => JSON.stringify(normalizeCustomTheme(theme));

export const normalizeCustomThemeVersionHistory = (entries = [], currentTheme = null) => {
  const source = Array.isArray(entries) ? entries : [];
  const normalized = source.map((entry, index) => {
    const theme = normalizeCustomTheme(entry?.theme ?? entry);
    return {
      id: String(entry?.id || `theme-version-${index + 1}`),
      version: Math.max(1, Math.floor(Number(entry?.version) || index + 1)),
      createdAtIso: validIso(entry?.createdAtIso ?? entry?.createdAt),
      reason: ["created", "edited", "restored"].includes(entry?.reason) ? entry.reason : "edited",
      theme,
    };
  });
  if (currentTheme) {
    const version = Math.max(1, Math.floor(Number(currentTheme.version) || 1));
    const currentSignature = themeSignature(currentTheme);
    const currentIndex = normalized.findIndex((entry) => entry.version === version);
    const currentEntry = {
      id: String(currentIndex >= 0 ? normalized[currentIndex].id : `theme-version-${version}`),
      version,
      createdAtIso: validIso(currentTheme.updatedAtIso ?? currentTheme.createdAtIso),
      reason: currentIndex >= 0 ? normalized[currentIndex].reason : version === 1 ? "created" : "edited",
      theme: normalizeCustomTheme(currentTheme),
    };
    if (currentIndex >= 0) {
      if (themeSignature(normalized[currentIndex].theme) !== currentSignature) normalized[currentIndex] = currentEntry;
    } else {
      normalized.push(currentEntry);
    }
  }
  return normalized
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.version === entry.version) === index)
    .sort((left, right) => left.version - right.version)
    .slice(-50);
};

export const appendCustomThemeVersion = (entries, theme, { reason = "edited", now = Date.now() } = {}) => {
  const normalizedTheme = normalizeCustomTheme(theme);
  const version = Math.max(1, Math.floor(Number(theme?.version) || 1));
  const history = normalizeCustomThemeVersionHistory(entries);
  const next = {
    id: `theme-version-${version}-${Math.max(0, Number(now) || Date.now()).toString(36)}`,
    version,
    createdAtIso: new Date(now).toISOString(),
    reason: ["created", "edited", "restored"].includes(reason) ? reason : "edited",
    theme: normalizedTheme,
  };
  return [...history.filter((entry) => entry.version !== version), next]
    .sort((left, right) => left.version - right.version)
    .slice(-50);
};

export const deleteCustomThemeVersion = (entries, version) => {
  const history = normalizeCustomThemeVersionHistory(entries);
  const selected = history.find((entry) => Number(entry.version) === Number(version));
  if (!selected) throw new Error("主题历史版本不存在");
  return {
    history: history.filter((entry) => Number(entry.version) !== Number(version)),
    deleted: selected,
  };
};

export const createCustomThemeTrashEntry = ({ theme, history = [], now = Date.now() } = {}) => {
  const id = String(theme?.id || `custom-theme-${now}`);
  const deletedAtIso = new Date(now).toISOString();
  return {
    id,
    trashId: `theme-trash-${id}-${now}`,
    kind: "custom-theme",
    title: normalizeCustomTheme(theme).name || "自定义主题",
    theme: { id, ...normalizeCustomTheme(theme), version: Math.max(1, Math.floor(Number(theme?.version) || 1)), createdAtIso: validIso(theme?.createdAtIso), updatedAtIso: validIso(theme?.updatedAtIso) },
    history: normalizeCustomThemeVersionHistory(history),
    deletedAtIso,
    expiresAtIso: new Date(now + TRASH_RETENTION_MS).toISOString(),
  };
};

export const pruneCustomThemeTrashEntries = (entries = [], now = Date.now()) => {
  const normalized = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.theme && entry?.kind === "custom-theme").map((entry) => {
    const deletedAt = Date.parse(entry.deletedAtIso ?? "");
    const deletedAtMs = Number.isFinite(deletedAt) ? deletedAt : now;
    const expiresAt = Date.parse(entry.expiresAtIso ?? "");
    return {
      ...createCustomThemeTrashEntry({ theme: entry.theme, history: entry.history, now: deletedAtMs }),
      trashId: String(entry.trashId || `theme-trash-${entry.theme.id}-${deletedAtMs}`),
      deletedAtIso: new Date(deletedAtMs).toISOString(),
      expiresAtIso: new Date(Number.isFinite(expiresAt) ? expiresAt : deletedAtMs + TRASH_RETENTION_MS).toISOString(),
    };
  });
  return {
    active: normalized.filter((entry) => Date.parse(entry.expiresAtIso) > now),
    expired: normalized.filter((entry) => Date.parse(entry.expiresAtIso) <= now),
  };
};

export const hexToRgb = (value) => {
  const normalized = normalizeHexColor(value);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
};

export const rgbToHex = ({ r = 0, g = 0, b = 0 } = {}) => `#${[r, g, b]
  .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0"))
  .join("")}`;

export const hsvToHex = ({ h = 0, s = 0, v = 0 } = {}) => {
  const hue = ((Number(h) || 0) % 360 + 360) % 360;
  const saturation = clamp(s, 0, 100) / 100;
  const brightness = clamp(v, 0, 100) / 100;
  const chroma = brightness * saturation;
  const segment = hue / 60;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1 ? [chroma, intermediate, 0]
    : segment < 2 ? [intermediate, chroma, 0]
      : segment < 3 ? [0, chroma, intermediate]
        : segment < 4 ? [0, intermediate, chroma]
          : segment < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  const match = brightness - chroma;
  return rgbToHex({ r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 });
};

export const hexToHsv = (value) => {
  const { r, g, b } = hexToRgb(value);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  return {
    h: Math.round(hue),
    s: Math.round((max ? delta / max : 0) * 100),
    v: Math.round(max * 100),
  };
};

const linearChannel = (value) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (value) => {
  const { r, g, b } = hexToRgb(value);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
};

export const contrastRatio = (first, second) => {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
};

export const customThemeScheme = (theme) => relativeLuminance(normalizeCustomTheme(theme).colors.editor) < 0.32 ? "dark" : "light";

export const customThemeCssVariables = (theme) => {
  const normalized = normalizeCustomTheme(theme);
  const accentText = contrastRatio(normalized.colors.accent, "#ffffff") >= contrastRatio(normalized.colors.accent, "#111111")
    ? "#ffffff"
    : "#111111";
  return {
    "--custom-topbar": normalized.colors.topbar,
    "--custom-sidebar": normalized.colors.sidebar,
    "--custom-editor": normalized.colors.editor,
    "--custom-chat": normalized.colors.chat,
    "--custom-text": normalized.colors.text,
    "--custom-accent": normalized.colors.accent,
    "--custom-accent-text": accentText,
  };
};

export const customThemeMinimumContrast = (theme) => {
  const normalized = normalizeCustomTheme(theme);
  return Math.min(...["topbar", "sidebar", "editor", "chat"].map((key) => contrastRatio(normalized.colors.text, normalized.colors[key])));
};
