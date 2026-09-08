import { splitCandidateChapters } from "./candidate-chapters.js";

const EPISODE_HEADING = /^第\s*(\d+)\s*集[^\n]*$/gm;

export const splitCandidateMemoryUnits = (text = "") => {
  const source = String(text).trim();
  const chapters = splitCandidateChapters(source)
    .filter((item) => item.target?.documentId && item.target?.inferredFromOutput)
    .map((item) => ({ documentId: item.target.documentId, content: item.content }));
  if (chapters.length > 1) return chapters;
  const matches = [...source.matchAll(EPISODE_HEADING)];
  if (matches.length <= 1) return [];
  return matches.map((match, index) => ({
    documentId: `script-episode-${Number(match[1])}`,
    content: source.slice(match.index, matches[index + 1]?.index ?? source.length).trim(),
  }));
};
