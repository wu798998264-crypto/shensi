const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("OpenCode test");
} else if (process.env.SHENSI_TEST_CATALOG === "deepseek") {
  console.log("deepseek/deepseek-chat\ndeepseek/deepseek-v4-pro");
} else {
  console.log("openai/gpt-5.6-sol");
}
