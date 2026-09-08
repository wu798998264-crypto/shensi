import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-dreamina-identities-"));
const previousDataRoot = process.env.SHENSI_DATA_ROOT;
process.env.SHENSI_DATA_ROOT = tempRoot;

try {
  const identityStore = await import(`../src/server/dreamina-profile-identity-store.mjs?durability=${Date.now()}`);
  const accountPreflight = await import(`../src/cli/dreamina-account-preflight.mjs?durability=${Date.now()}`);
  const accountIdentity = await import(`../src/cli/dreamina-account-identity.mjs?durability=${Date.now()}`);
  const writes = Array.from({ length: 24 }, (_, index) => identityStore.saveDreaminaProfileIdentity({
    profileId: `profile-${index}`,
    remarkName: `账号 ${index}`,
    expectedUserId: `user-${index}`,
    verifiedUserId: `user-${index}`,
    credentialFingerprint: `fingerprint-${index}`,
    verifiedAt: new Date(Date.now() + index).toISOString(),
  }));
  await Promise.all(writes);
  const stored = await identityStore.readDreaminaProfileIdentityStore();
  assert.equal(Object.keys(stored.profiles).length, 24,
    "多个即梦配置并发保存时不得因读改写竞态丢失其他账号的核验记录");
  for (let index = 0; index < 24; index += 1) {
    assert.equal(stored.profiles[`profile-${index}`]?.expectedUserId, `user-${index}`);
  }

  const identityPath = identityStore.dreaminaProfileIdentityStorePath();
  const identityBackupPath = `${identityPath}.backup`;
  await copyFile(identityBackupPath, `${identityBackupPath}.test-copy`);
  await rename(identityPath, `${identityPath}.temporarily-missing`);
  assert.ok((await identityStore.readDreaminaProfileIdentityStore()).profiles["profile-0"],
    "身份主账本短暂缺失时必须读取备份，不能返回空库让所有账号变成未核验");
  await rename(`${identityPath}.temporarily-missing`, identityPath);
  await writeFile(identityPath, "{broken", "utf8");
  assert.ok(identityStore.readDreaminaProfileIdentityStoreSync().profiles["profile-0"],
    "同步生成路径必须从备份恢复损坏的身份主账本");
  await writeFile(identityBackupPath, "{also-broken", "utf8");
  assert.throws(
    () => identityStore.readDreaminaProfileIdentityStoreSync(),
    (error) => error.code === "DREAMINA_IDENTITY_STORE_CORRUPT",
    "主副本同时损坏时必须报告真实存储故障，不能伪装成账号未核验",
  );
  await rename(`${identityBackupPath}.test-copy`, identityBackupPath);
  await copyFile(identityBackupPath, identityPath);
  assert.throws(
    () => identityStore.dreaminaExpectedIdentitySync("bad/profile"),
    (error) => error.code === "DREAMINA_PROFILE_ID_INVALID",
    "非法配置 ID 不得在同步生成路径静默回退到 default 账号",
  );
  assert.throws(
    () => identityStore.dreaminaExpectedIdentitySync(""),
    (error) => error.code === "DREAMINA_PROFILE_REQUIRED",
    "空配置 ID 不得读取或创建柏物语身份记录",
  );
  await assert.rejects(
    identityStore.saveDreaminaProfileIdentity({ expectedUserId: "must-not-land" }),
    (error) => error.code === "DREAMINA_PROFILE_REQUIRED",
    "缺少配置 ID 的核验结果不得写进任何账号账本",
  );

  const previousProfileEnvironment = {
    profileId: process.env.SHENSI_DREAMINA_PROFILE_ID,
    expectedUserId: process.env.SHENSI_DREAMINA_EXPECTED_USER_ID,
    fingerprint: process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT,
  };
  try {
    process.env.SHENSI_DREAMINA_PROFILE_ID = "durable-profile";
    process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "durable-user";
    process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = "durable-fingerprint";
    const nestedIdentity = accountIdentity.assertDreaminaAccountIdentity({
      data: { account: { user_id: "durable-user" }, total_credit: 321, vip_level: "vip3" },
    });
    assert.equal(nestedIdentity.userId, "durable-user",
      "即梦 CLI 将账号字段包在 data/result 中时仍必须识别真实 user_id");
    assert.equal(nestedIdentity.credit, 321,
      "嵌套账号回执中的积分字段也必须正确读取");

    const missingLiveUserId = new Error("即梦没有返回 user_id");
    missingLiveUserId.code = "DREAMINA_ACCOUNT_ID_MISSING";
    const cachedFallback = await accountPreflight.verifiedDreaminaAccountWithControlPlaneFallback(
      async () => { throw missingLiveUserId; },
    );
    assert.equal(cachedFallback.identity.userId, "durable-user",
      "已有持久核验身份时，临时缺少 user_id 不得要求再次浏览器核验");
    assert.equal(cachedFallback.controlPlaneDeferred, true,
      "缺少实时 user_id 时必须明确标记控制面读取延后，不能伪报实时核验成功");

    delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
    delete process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT;
    await assert.rejects(
      accountPreflight.verifiedDreaminaAccountWithControlPlaneFallback(async () => { throw missingLiveUserId; }),
      (error) => error.code === "DREAMINA_ACCOUNT_ID_MISSING",
      "从未绑定的配置缺少 user_id 时仍必须失败关闭，不能借用其他账号身份",
    );
  } finally {
    if (previousProfileEnvironment.profileId === undefined) delete process.env.SHENSI_DREAMINA_PROFILE_ID;
    else process.env.SHENSI_DREAMINA_PROFILE_ID = previousProfileEnvironment.profileId;
    if (previousProfileEnvironment.expectedUserId === undefined) delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
    else process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = previousProfileEnvironment.expectedUserId;
    if (previousProfileEnvironment.fingerprint === undefined) delete process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT;
    else process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = previousProfileEnvironment.fingerprint;
  }

  const [first, second] = await Promise.all([
    identityStore.claimDreaminaProfileIdentity({
      profileId: "claim-a",
      expectedUserId: "same-real-user",
      verifiedUserId: "same-real-user",
    }),
    identityStore.claimDreaminaProfileIdentity({
      profileId: "claim-b",
      expectedUserId: "same-real-user",
      verifiedUserId: "same-real-user",
    }),
  ]);
  assert.equal([first, second].filter((result) => result.saved).length, 1,
    "两个配置并发核验同一真实账号时只能有一个原子绑定成功");
  assert.equal([first, second].filter((result) => result.duplicate).length, 1,
    "另一个配置必须得到重复账号结果，不能形成串号配置");

  const [oauth, app, runner, jobStore, identityStoreSource, imageCli, videoCli] = await Promise.all([
    readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
    readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server/dreamina-profile-identity-store.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(oauth, /reusedPending: true/u,
    "同一配置重复核验必须复用未过期的 OAuth 事务，不能清掉浏览器已确认状态");
  assert.match(oauth, /startDeferred: true/u,
    "OAuth 启动阶段凭证槽繁忙必须返回可恢复状态，不能抛授权失败");
  assert.match(oauth, /verificationDeferred: true/u,
    "OAuth 完成阶段凭证槽繁忙或网络抖动必须保持待确认状态");
  assert.match(oauth, /withOAuthProfileQueue/u,
    "每个 profile 的启动和完成操作必须串行，避免同配置相互覆盖 pending");
  assert.match(oauth, /claimDreaminaProfileIdentity/u,
    "身份去重检查与保存必须是一个原子事务");
  assert.match(oauth, /verifiedUserId: live\.userId[\s\S]{0,300}writePendingOAuth/u,
    "厂商身份确认后必须先保存可恢复证据，再提交最终身份账本");
  assert.match(oauth, /pendingBackupPath[\s\S]{0,3000}pendingWriteVersion/u,
    "OAuth 待确认状态必须维护独立副本，并用单调版本选择最新可恢复记录");
  assert.match(oauth, /const replaceFile[\s\S]{0,1200}process\.platform !== "win32"/u,
    "OAuth 待确认状态必须兼容 Windows 无法直接覆盖目标文件的行为");
  assert.match(oauth, /const readPendingOAuth[\s\S]{0,2400}DREAMINA_OAUTH_PENDING_CORRUPT/u,
    "OAuth 主记录损坏时必须读取安全副本，不能静默当成未发起核验");
  assert.match(oauth, /const removePendingOAuth[\s\S]{0,500}pendingBackupPath[\s\S]{0,200}pendingPath/u,
    "完成或取消 OAuth 时必须先删除副本，避免旧核验事务复活");
  assert.match(oauth, /writeOAuthCompletion[\s\S]{0,2200}readOAuthCompletion/u,
    "OAuth 完成必须保存按 profile 隔离的幂等回执，避免成功响应丢包后显示失败");
  assert.match(oauth, /DREAMINA_OAUTH_NOT_STARTED[\s\S]{0,500}readOAuthCompletion/u,
    "完成接口重复轮询时必须重放同一 profile 的成功回执");
  assert.match(app, /payload\.authorizationAccepted[\s\S]{0,200}10 \* 60_000/u,
    "厂商已接受授权后不得因原设备码到期中止本地核验持久化");
  assert.match(app, /DREAMINA_OAUTH_PERSISTENCE_DEFERRED[\s\S]{0,3000}continueDreaminaProfileVerification\(profileId, ""/u,
    "厂商已接受授权但本地记录暂时失败时必须真正按 profile 自动重试，不能只显示提示");
  assert.match(oauth, /previousCompletion[\s\S]{0,500}removePendingOAuth\(id\)[\s\S]{0,200}removeOAuthCompletion\(id\)/u,
    "主动重新核验前必须先清除旧待确认事务，再清除成功回执，避免旧事务复活");

  assert.match(app, /dreaminaVerificationRetryTimers = new Map/u,
    "OAuth 启动临时失败必须按 profile 隔离自动重试");
  assert.match(app, /visibleProfileId !== profileId|visibleProfileId === profileId/u,
    "另一个 profile 的晚到反馈不得覆盖当前账号面板");
  assert.match(app, /currentDreaminaProfileId\(verificationChannel\) === profileId/u,
    "核验期间切换配置后不得把旧账号保存到新选择");
  assert.match(app, /Object\.assign\(new Error\(payload\.message[\s\S]{0,120}payload\.code/u,
    "前端必须保留后端结构化核验错误码用于临时故障分类");

  assert.match(runner, /Test-DreaminaSemanticAuthFailure/u,
    "退出码 0 但语义认证失败时必须保留上一份已核验凭据快照");
  assert.match(runner, /\$Command -eq 'list_task'[\s\S]{0,1400}\[string\]::IsNullOrWhiteSpace\(\$taskId\)/u,
    "list_task 历史失败任务里的 authsdk 文本不得误判为当前账号掉线");
  assert.match(runner, /\$taskId = if \(\$_\.submit_id\)[\s\S]{0,260}\$_\.taskId/u,
    "历史任务必须通过厂商任务 ID 与命令级认证失败响应区分");
  assert.match(runner, /UTF8Encoding\(\$false\)[\s\S]{0,240}\[Console\]::OutputEncoding[\s\S]{0,160}\$OutputEncoding/u,
    "Windows 凭证代理必须固定 UTF-8，避免中文任务列表 JSON 被系统代码页破坏");
  assert.match(runner, /\[DREAMINA_AUTH_REQUIRED\] authsdk: not logged in/u,
    "凭证代理的语义失败必须保留桥接可识别的未登录协议信号");
  assert.match(runner, /未检测到\(\?:有效\)\?登录态\|请先执行/u,
    "凭证代理必须把新版 CLI 中文未登录回执转换为稳定认证错误码");
  assert.match(runner, /\$exitCode -eq 0 -and \(Test-DreaminaRegistryKey\)/u,
    "官方 CLI 失败后不得把异常注册表状态覆盖为长期凭据快照");
  assert.match(runner, /\[DREAMINA_AUTH_REQUIRED\]/u,
    "独立凭据缺失必须返回结构化认证错误，不能退化为普通 CLI 失败");
  assert.match(runner, /shensi-dreamina-broker-recovery-v1/u,
    "凭证代理被强杀后必须在下一条命令前恢复原 Windows 全局凭据槽");
  assert.match(runner, /\$exitCode -eq 0/u,
    "失败的 CLI 命令不得覆盖已保存的独立账号凭据快照");
  assert.match(jobStore, /identity\.verifiedUserId \|\| identity\.expectedUserId/u,
    "旧身份记录也必须优先使用稳定 user_id，不能因凭据文件轮换要求再次核验");
  assert.match(identityStoreSource, /dreaminaProfileIdentityStoreBackupPath[\s\S]{0,120}\.backup/u,
    "账号核验账本必须保留上一版文件，升级或断电后可恢复");
  assert.match(identityStoreSource, /DREAMINA_IDENTITY_STORE_CORRUPT/u,
    "身份账本损坏时必须阻止空库覆盖，不能让所有核验记忆静默丢失");
  assert.match(identityStoreSource, /readDreaminaProfileIdentityStoreSync[\s\S]{0,1800}DREAMINA_IDENTITY_STORE_CORRUPT/u,
    "生成路径同步读取身份账本损坏时必须报告真实故障，不能伪装成未核验");
  assert.match(oauth, /liveRequiresReverification = live\?\.code === "DREAMINA_AUTH_REQUIRED"/u,
    "实时探针只有明确未登录才能把已保存身份标成需要重新核验");
  assert.match(oauth, /const liveIdentity = async \(profileId\)/u,
    "账号在线读取只能探测现有凭据，不得隐式启动新的 OAuth Device Flow");
  assert.match(oauth, /listDreaminaProfileAccountStatuses[\s\S]{0,2600}liveIdentity\(profile\.id\)/u,
    "账号状态与积分探针必须保持只读，不能占用全局凭证槽执行登录恢复");
  assert.match(oauth, /completeDreaminaProfileOAuth[\s\S]{0,3200}liveIdentity\(id\)/u,
    "OAuth 完成流程必须只读验证 checklogin 写入的同一凭据快照");
  assert.doesNotMatch(oauth, /invokeProfile\(profileId, \["login", "--headless"\]/u,
    "身份探针不得把 login --headless 误作会话恢复并覆盖刚完成的 OAuth 凭据");
  assert.match(oauth, /liveAccountIdMissing[\s\S]{0,3500}statusReadUnavailable/u,
    "user_id 临时缺失必须与真正的账号状态服务故障区分");
  assert.match(oauth, /explicitLoggedOut[\s\S]{0,600}DREAMINA_AUTH_REQUIRED/u,
    "官方 CLI 明确返回未登录时必须转为结构化需核验错误");
  assert.match(app, /account\?\.statusReadUnavailable[\s\S]{0,800}已保存的核验身份保持有效/u,
    "已有身份的账号状态读取故障不得诱导用户重复核验");
  assert.match(app, /statusReadError && !account[\s\S]{0,800}这不能证明账号失效/u,
    "无缓存状态时的读取故障也不得伪装成账号失效");
  assert.match(app, /const existingAccount = \(ui\.dreaminaAccountStatuses[\s\S]{0,300}renderDreaminaAccountStatus\(existingAccount/u,
    "设置页异步刷新时必须保留上次账号状态，不能先清空造成闪烁");
  const whiteboardAccountBootstrap = app.slice(app.indexOf("if (isWhiteboard && !(ui.dreaminaAccountStatuses || []).length)"), app.indexOf("if (!isWhiteboard) renderWhiteboardGenerationCollapsedSessions"));
  assert.doesNotMatch(whiteboardAccountBootstrap, /refreshDreaminaLiveStatus/u,
    "打开白板只允许读取持久化核验状态，不得自动占用即梦凭证槽");
  const providerSync = app.slice(app.indexOf("const syncProviderSpecificCliButtons"), app.indexOf("const chooseDreaminaAuthorizationBrowser"));
  assert.doesNotMatch(providerSync, /refreshDreaminaLiveStatus/u,
    "设置面板渲染不得自动启动即梦在线探针");
  assert.match(app, /refreshDreaminaCreditAfterSuccessfulGeneration[\s\S]{0,1500}creditRefreshDeferred !== true\) return profile/u,
    "生成后积分刷新遇到明确失效必须停止，不能连续重试同一账号十二次");
  assert.match(app, /silent = false[\s\S]{0,900}!silent && \(!waiting \|\| trigger\)/u,
    "后台 OAuth 等待轮询不得反复闪烁底部提示");
  assert.match(app, /showToast\.lastText === text[\s\S]{0,260}Date\.now\(\) - Number\(showToast\.lastAt \|\| 0\) < 3_000/u,
    "相同的后台状态提示在短时间内不得重复重置 Toast 显示");
  assert.match(app, /即梦没有返回\\s\*user\[_ -\]\?id[\s\S]{0,240}即梦账号身份暂时无法读取/u,
    "裸 user_id 读取间隙不得直接以吓人的原始报错闪烁给用户");
  assert.doesNotMatch(imageCli, /const refreshGenerationAuth/u);
  assert.doesNotMatch(videoCli, /const refreshGenerationAuth/u);
  assert.match(imageCli, /dreaminaAuthRetryAllowed\(args\) \|\| error\.submissionOutcomeKnown === true/u,
    "图片提交只有在明确未创建任务时才允许重试原命令");
  assert.match(videoCli, /dreaminaAuthRetryAllowed\(args\) \|\| error\.submissionOutcomeKnown === true/u,
    "视频提交只有在明确未创建任务时才允许重试原命令");
  assert.doesNotMatch(imageCli, /runOnce\(\["login", "--headless"\]\)/u,
    "图片桥接不得隐式启动登录并占用全局凭证槽");
  assert.doesNotMatch(videoCli, /runCliOnce\(\["login", "--headless"\]\)/u,
    "视频桥接不得隐式启动登录并占用全局凭证槽");

  console.log("Dreamina verification durability and multi-profile isolation tests passed");
} finally {
  if (previousDataRoot === undefined) delete process.env.SHENSI_DATA_ROOT;
  else process.env.SHENSI_DATA_ROOT = previousDataRoot;
  await rm(tempRoot, { recursive: true, force: true });
}
