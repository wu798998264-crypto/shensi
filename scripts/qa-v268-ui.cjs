const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const baseUrl = process.env.SHENSI_QA_URL || "http://127.0.0.1:4311";
const evidenceRoot = process.env.SHENSI_QA_EVIDENCE || "E:/ShensiUserData/验收/v268-ui";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.SHENSI_QA_CHROMIUM || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("#settingsButton").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator("#settingsButton").click();
    await page.locator('[data-settings-section="model"]').click();

    await page.locator('[data-model-settings-channel="text"]').click();
    await page.locator('select[name="textExecutionMode"]').waitFor({ state: "visible" });
    await page.screenshot({ path: `${evidenceRoot}/01-text-chat-agent-multi-profile.png` });

    await page.locator('[data-model-settings-channel="image"]').click();
    const connection = page.locator("#imageConnectionSelect");
    const profiles = await connection.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent || "" })));
    const dreamina = profiles.find((option) => /即梦|柏物语|陈安|她说剧有梗|小鱼姐|锅巴仔/.test(option.label));
    assert.ok(dreamina, "没有找到即梦图片配置");
    await connection.selectOption(dreamina.value);
    assert.equal(await page.locator('select[name="imageProvider"]').inputValue(), "即梦");
    const models = await page.locator('select[name="imageModel"] option').evaluateAll((options) => options.map((option) => option.value));
    assert.equal(models.some((model) => /^gpt-image|^sora-/i.test(model)), false, "即梦配置泄漏了 GPT/Sora 模型");
    await page.locator('select[name="imageModel"]').evaluate((select) => { select.size = Math.min(10, Math.max(4, select.options.length)); });
    await page.screenshot({ path: `${evidenceRoot}/02-dreamina-model-isolation.png` });
    process.stdout.write(`${JSON.stringify({ ok: true, profiles, dreaminaModels: models }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
