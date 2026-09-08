export const textRevealChunks = (value, { targetFrames = 120, maxChunkSize = 32 } = {}) => {
  const characters = [...String(value ?? "")];
  if (!characters.length) return [];
  const chunkSize = Math.max(1, Math.min(maxChunkSize, Math.ceil(characters.length / targetFrames)));
  const chunks = [];
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(characters.slice(index, index + chunkSize).join(""));
  }
  return chunks;
};
