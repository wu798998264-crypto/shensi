import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "account/read") send({ id: request.id, result: { account: { type: "chatgpt" } } });
  if (request.method === "modelProvider/capabilities/read") send({ id: request.id, result: { imageGeneration: true } });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "mock-image-failure-thread" } } });
  if (request.method === "turn/start") {
    await appendFile(process.env.SHENSI_TEST_IMAGE_SUBMISSIONS, "submitted\n");
    send({ id: request.id, result: { turn: { id: "mock-turn" } } });
    if (process.env.SHENSI_TEST_IMAGE_FAILURE === "stream") {
      send({ method: "item/started", params: { item: { type: "imageGeneration", id: "mock-image-start" } } });
      send({ method: "error", params: { willRetry: false, error: { message: "mock stream lost", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } } });
    } else {
      send({ method: "error", params: { willRetry: false, error: { message: "mock invalid reference", codexErrorInfo: "badRequest" } } });
    }
  }
}
