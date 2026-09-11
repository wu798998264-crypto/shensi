import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageScript = await readFile(new URL("./windows/package-windows.ps1", import.meta.url), "utf8");
const installer = await readFile(new URL("../packaging/windows/desktop-app/installer-custom.nsh", import.meta.url), "utf8");
const desktop = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");
const appData = await readFile(new URL("../src/server/app-data.mjs", import.meta.url), "utf8");
const updateConfig = JSON.parse(await readFile(new URL("../update-config.json", import.meta.url), "utf8"));
const updatePreparation = await readFile(new URL("./windows/prepare-github-release.mjs", import.meta.url), "utf8");
const finalSigner = await readFile(new URL("./windows/sign-final-installer.ps1", import.meta.url), "utf8");

assert.match(packageScript, /yyyyMMddHHmmssfff/u, "every installer must get a unique timestamp build id");
assert.match(packageScript, /sameVersionInstaller[\s\S]{0,500}Increment package\.json version/u, "a semantic version must not be packaged twice");
assert.match(packageJson.build?.artifactName || "", /Shensi-Setup-\$\{version\}-\$\{env\.SHENSI_BUILD_ID\}-\$\{arch\}/u);
assert.match(installer, /NSD_CreateCheckbox[\s\S]{0,100}创建桌面快捷方式/u, "assisted install must let the user choose a desktop shortcut");
assert.match(installer, /ShensiCreateDesktopShortcut == \$\{BST_CHECKED\}[\s\S]{0,250}CreateShortCut/u, "desktop shortcut must follow the checkbox state");
assert.equal(packageJson.build?.nsis?.deleteAppDataOnUninstall, false, "uninstall and upgrade must preserve user data");
assert.doesNotMatch((packageJson.build?.files || []).join("\n"), /(?:^|\/)作品(?:\/|$)|(?:^|\/)笔记(?:\/|$)|ShensiUserData/u, "installer must never package or replace user-created works, notes, cards, generations, titles, notebooks or documents");
assert.match(appData, /cp\(src, dest, \{ recursive: true, force: false, errorOnExist: false \}\)/u, "data migration must merge without overwriting a newer manual edit");
assert.match(desktop, /requestSingleInstanceLock/u, "packaged app must enforce one instance");
assert.match(desktop, /await loadApplicationPage\(\);\s*showMainWindow\(\)/u, "normal startup must show the main window");
assert.ok(packageJson.build?.files?.includes("update-config.json"), "packaged application must include its pinned update source");
assert.equal(updateConfig.repository, "wu798998264-crypto/shensi");
assert.match(updateConfig.manifestPublicKeyPem, /BEGIN PUBLIC KEY/u, "updater must pin the release manifest public key");
assert.match(packageJson.build?.win?.signtoolOptions?.rfc3161TimeStampServer || "", /^https?:\/\//u, "formal package signing must request a trusted timestamp");
assert.match(finalSigner, /Get-Content\s+-Raw\s+-Encoding\s+UTF8/u, "Windows PowerShell must read UTF-8 package metadata without corrupting the Chinese product name");
assert.match(updatePreparation, /uploadPerformed:\s*false/u, "release preparation must remain local until the user explicitly requests upload");

console.log("Shensi release engineering contract passed");
