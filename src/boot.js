(() => {
  const installSessionFetch = () => {
    if (window.__shensiFetchAuthInstalled) return;
    const token = document.querySelector('meta[name="shensi-session-token"]')?.content || "";
    if (!token) return;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || "";
      const apiUrl = typeof url === "string" && (url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`));
      if (!apiUrl) return nativeFetch(input, init);
      const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
      headers.set("X-Shensi-Session", token);
      return nativeFetch(input, { ...init, headers });
    };
    window.__shensiFetchAuthInstalled = true;
  };

  installSessionFetch();

  const showBootFailure = () => {
    const root = document.getElementById("root");
    if (!root || root.childElementCount) return;
    const english = localStorage.getItem("shensi-ui-preferences")?.includes('"uiLanguage":"en-US"');
    root.textContent = english
      ? "The app failed to load. Refresh the page to try again."
      : "应用加载失败，请刷新页面后重试。";
    root.setAttribute("role", "alert");
    root.style.padding = "24px";
  };

  window.addEventListener("error", (event) => {
    const detail = event.error?.stack ?? event.message ?? event.target?.src ?? "Unknown boot error";
    console.error("[Shensi boot error]", detail);
    showBootFailure();
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[Shensi boot rejection]", event.reason);
    showBootFailure();
  });
  setTimeout(() => {
    if (document.querySelector(".app-shell")) return;
    console.error("[Shensi boot timeout] Application shell was not mounted.");
    showBootFailure();
  }, 5000);
})();
