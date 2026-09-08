export const WORKSPACE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;

const utf8Bytes = (value) => new TextEncoder().encode(value);

const gzipBytes = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export const workspaceSaveRequest = async (payload, {
  compressionThresholdBytes = WORKSPACE_COMPRESSION_THRESHOLD_BYTES,
  compressionStream = globalThis.CompressionStream,
} = {}) => {
  const json = JSON.stringify(payload);
  const bytes = utf8Bytes(json);
  const headers = { "Content-Type": "application/json" };
  if (bytes.byteLength < Math.max(0, Number(compressionThresholdBytes) || 0) || typeof compressionStream !== "function") {
    return { body: json, headers, decodedBytes: bytes.byteLength, encodedBytes: bytes.byteLength, compressed: false };
  }

  const originalCompressionStream = globalThis.CompressionStream;
  let compressed;
  try {
    if (compressionStream === originalCompressionStream) compressed = await gzipBytes(bytes);
    else {
      const stream = new Blob([bytes]).stream().pipeThrough(new compressionStream("gzip"));
      compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    }
  } catch {
    return { body: json, headers, decodedBytes: bytes.byteLength, encodedBytes: bytes.byteLength, compressed: false };
  }
  headers["Content-Encoding"] = "gzip";
  headers["X-Shensi-Decoded-Length"] = String(bytes.byteLength);
  return {
    body: compressed,
    headers,
    decodedBytes: bytes.byteLength,
    encodedBytes: compressed.byteLength,
    compressed: true,
  };
};
