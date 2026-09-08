const args = process.argv.slice(2);
const operation = args[0] || "";
const value = (name) => {
  const direct = args.find((item) => item.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const progressField = String(process.env.SHENSI_TEST_DREAMINA_PROGRESS_FIELD || "").trim();
const progressValue = String(process.env.SHENSI_TEST_DREAMINA_PROGRESS_VALUE || "").trim();
const progressPayload = progressField && progressValue !== "" ? { [progressField]: progressValue } : {};

if (operation === "list_task") {
  if (process.env.SHENSI_TEST_DREAMINA_TASK_AUTH_FAILURE === "1") {
    process.stdout.write(JSON.stringify({
      status: "fail",
      message: "authsdk: not logged in",
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    status: "submit",
    data: [{
      submit_id: value("--submit_id") || "fixture-task-1",
      status: "submit",
      prompt: process.env.SHENSI_TEST_DREAMINA_PROMPT || "状态恢复测试",
      gen_task_type: process.env.SHENSI_TEST_DREAMINA_TASK_TYPE || "seedance2.5",
      ...progressPayload,
    }],
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ status: "submit", submit_id: "fixture-task-1", ...progressPayload }));
