import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../src/boot.js", import.meta.url), "utf8");

const createElement = () => ({
  style: {}, attributes: {}, children: [], textContent: "",
  setAttribute(name, value) { this.attributes[name] = value; },
  getAttribute(name) { return this.attributes[name] ?? null; },
  replaceChildren(...children) { this.children = children; },
  get childElementCount() { return this.children.length; },
});

const harness = ({ english = false } = {}) => {
  const root = createElement();
  const listeners = new Map();
  const timers = [];
  let shellMounted = false;
  const window = {
    location: { origin: "http://127.0.0.1" },
    fetch: async () => {},
    addEventListener(name, handler) { listeners.set(name, handler); },
  };
  runInNewContext(source, {
    window,
    document: {
      getElementById: (id) => id === "root" ? root : null,
      createElement,
      querySelector: (selector) => selector === ".app-shell" && shellMounted ? root.children[0] : null,
    },
    localStorage: { getItem: () => english ? '{"uiLanguage":"en-US"}' : null },
    console: { error() {} },
    setTimeout(handler) { timers.push(handler); },
  });
  return {
    root,
    trigger(name) { listeners.get(name)({ message: "early resource failure", reason: "early rejection" }); },
    timeout() { timers.forEach((handler) => handler()); },
    mount(runtime) {
      // app.js replaces root.innerHTML; it does not reset root style or attributes.
      delete root.style.padding;
      root.attributes = {};
      root.replaceChildren({ className: `app-shell${runtime === "desktop" ? " desktop-runtime" : ""}` });
      root.textContent = "";
      shellMounted = true;
    },
  };
};

for (const event of ["error", "unhandledrejection", "timeout"]) {
  for (const runtime of ["desktop", "browser"]) {
    const test = harness();
    if (event === "timeout") test.timeout(); else test.trigger(event);
    assert.equal(test.root.style.padding, undefined, `${event}: boot failure must not offset root`);
    assert.equal(test.root.getAttribute("role"), null, "root must not retain an alert role");
    assert.equal(test.root.childElementCount, 1, "boot failure is a replaceable child");
    assert.equal(test.root.children[0].getAttribute("role"), "alert");
    test.mount(runtime);
    test.timeout();
    test.trigger("error");
    assert.match(test.root.children[0].className, /app-shell/u);
    assert.equal(test.root.style.padding, undefined, "successful mount leaves no layout residue");
    assert.equal(test.root.getAttribute("role"), null);
  }
}
for (const english of [false, true]) {
  const test = harness({ english });
  test.timeout();
  const failure = test.root.children[0];
  assert.equal(failure.textContent, english
    ? "The app failed to load. Refresh the page to try again."
    : "应用加载失败，请刷新页面后重试。");
  test.trigger("error");
  assert.equal(test.root.children[0], failure, "repeated errors must not duplicate the alert");
}
console.log("Boot surface reset: early error/rejection/timeout, late mount, both runtimes and localized failure passed");
