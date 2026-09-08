const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const root = process.env.SHENSI_IMAGE_EDITOR_APP_ROOT
  ? resolve(process.env.SHENSI_IMAGE_EDITOR_APP_ROOT)
  : join(__dirname, "..");
const testUserData = mkdtempSync(join(tmpdir(), "shensi-image-editor-e2e-"));
app.setPath("userData", testUserData);
app.commandLine.appendSwitch("disable-gpu-sandbox");

app.whenReady().then(async () => {
  let exitCode = 0;
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    // The fixture itself is loaded from a local file. Disable the renderer
    // sandbox only for this isolated test window so Chromium does not route a
    // local fixture through a broken/locked Windows network service. The
    // production window still keeps its existing sandbox configuration.
    webPreferences: { contextIsolation: true, sandbox: false },
  });
  window.webContents.on("console-message", (_event, details) => console.log(`[renderer] ${details.message || ""}`));
  try {
    await window.loadFile(join(root, "scripts", "fixtures", "image-editor-e2e.html"));
    const rows = await Promise.race([
      window.webContents.executeJavaScript("window.__imageEditorEvidence", true),
      new Promise((_, reject) => setTimeout(() => reject(new Error("图片编辑 Electron 验收超过 30 秒")), 30_000)),
    ]);
    assert.deepEqual(rows.map((row) => row.mimeType), ["image/png", "image/jpeg", "image/webp"]);
    for (const row of rows) {
      assert.equal(row.operations, 1);
      assert.ok(row.savedBytes > 100);
      assert.equal(row.width, 96);
      assert.equal(row.height, 64);
      assert.ok(row.alpha > 0);
      assert.ok(row.color > 0);
    }
    const installedCss = pathToFileURL(join(root, "src", "styles.css")).href;
    const roundClose = await window.webContents.executeJavaScript(`(async () => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = ${JSON.stringify(installedCss)};
      document.head.append(link);
      await new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; });
      const chip = document.createElement("span");
      chip.className = "context-chip visual-attachment-chip";
      chip.innerHTML = '<button type="button" data-remove-attachment="fixture"><span class="icon">x</span></button>';
      document.body.append(chip);
      const button = chip.querySelector("button");
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const marker = getComputedStyle(button, "::before");
      return {
        width: rect.width,
        height: rect.height,
        radius: style.borderRadius,
        position: style.position,
        top: style.top,
        right: style.right,
        marker: marker.content,
        markerTransform: marker.transform,
      };
    })()`, true);
    assert.equal(roundClose.width, 20);
    assert.equal(roundClose.height, 20);
    assert.equal(roundClose.radius, "999px");
    assert.equal(roundClose.position, "absolute");
    assert.equal(roundClose.top, "1px");
    assert.equal(roundClose.right, "1px");
    assert.match(roundClose.marker, /×/u);
    assert.equal(roundClose.markerTransform, "none");
    let realAttachment = null;
    if (process.env.SHENSI_IMAGE_EDITOR_REAL_FILE) {
      const source = pathToFileURL(resolve(process.env.SHENSI_IMAGE_EDITOR_REAL_FILE)).href;
      realAttachment = await window.webContents.executeJavaScript(`window.__imageEditorExternal(${JSON.stringify(source)})`, true);
      assert.ok(realAttachment.width > 1000 && realAttachment.height > 1000);
      assert.ok(realAttachment.savedBytes > 100_000);
      assert.ok(realAttachment.alpha > 0);
      assert.ok(realAttachment.color > 0);
      assert.ok(realAttachment.contrast > 16, "真实大图初次打开仍为黑屏或单色画布");
    }
    console.log(JSON.stringify({ ok: true, formats: rows, realAttachment, roundClose }, null, 2));
  } catch (error) {
    console.error(error?.stack || error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
    setTimeout(() => process.exit(exitCode), 250);
  }
});
