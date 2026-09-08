import assert from "node:assert/strict";
import { parsePublicSearchResults, publicSearchTargetUrl, searchPublicWeb } from "../src/server/public-web-search.mjs";

assert.equal(publicSearchTargetUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1"), "https://example.com/a?x=1");
assert.equal(publicSearchTargetUrl("javascript:alert(1)"), "");
const results = parsePublicSearchResults('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fofficial">Official &amp; Source</a>');
assert.deepEqual(results, [{ title: "Official & Source", url: "https://example.com/official" }]);

const response = new Response('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fofficial">Official source</a>', {
  status: 200,
  headers: { "content-type": "text/html" },
});
const outcome = await searchPublicWeb({
  query: "official source",
  fetchImpl: async () => response,
  dispatcherFactory: () => ({ close: async () => {} }),
  dispatcherCloser: async () => {},
  validateUrl: async (url) => new URL(url),
  lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
  readReference: async () => ({ title: "Official source", sourceUrl: "https://example.com/official", fetchedAt: "2026-08-31T00:00:00.000Z", text: "Verified page body." }),
});
assert.equal(outcome.attachments.length, 1);
assert.equal(outcome.sources[0].url, "https://example.com/official");
assert.match(outcome.attachments[0].text, /Verified page body/u);
console.log("Public web search tests passed");
