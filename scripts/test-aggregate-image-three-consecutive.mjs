import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateImageWithAdapter } from "../src/server/adapters.mjs";

// A local OpenAI-compatible image endpoint keeps this test non-billing.  It
// exercises three complete sequential requests through the same aggregate
// adapter and verifies that each request keeps its own idempotency key.
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7ZQAAAABJRU5ErkJggg==";
const idempotencyKeys = [];
const requestBodies = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  idempotencyKeys.push(String(request.headers["idempotency-key"] || ""));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ b64_json: onePixelPng }] }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  const settings = {
    id: "image-cockpit-aggregate-api",
    connectionId: "image-cockpit-aggregate-api",
    provider: "自定义兼容接口",
    adapter: "api",
    protocol: "images",
    imageChannel: true,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "gpt-image-2.5",
    apiKey: "test-only-local-key",
  };
  for (let index = 1; index <= 3; index += 1) {
    const key = `aggregate-three-consecutive-${index}`;
    const result = await generateImageWithAdapter({
      settings,
      prompt: `非计费连续请求 ${index}`,
      aspectRatio: "1:1",
      quality: "standard",
      imageCount: 1,
      idempotencyKey: key,
    });
    assert.match(result.dataUrl, /^data:image\/png;base64,/u);
    assert.equal(result.returnedImageCount, 1);
  }
  assert.equal(requestBodies.length, 3, "连续三次必须真的经过本地兼容接口三次");
  assert.deepEqual(idempotencyKeys, [
    "aggregate-three-consecutive-1",
    "aggregate-three-consecutive-2",
    "aggregate-three-consecutive-3",
  ]);
  assert.deepEqual(requestBodies.map((body) => body.model), ["gpt-image-2.5", "gpt-image-2.5", "gpt-image-2.5"]);
  console.log("aggregate image three consecutive non-billing requests passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
