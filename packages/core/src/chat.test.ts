import { describe, expect, it, vi } from "vitest";
import { browserToolAllowed, execTool } from "./chat.js";

describe("chat dispatch authority", () => {
  const ctx = { scope: "global" as const, positionId: null, companyId: null, writes: false };
  const call = (name: string) => ({ id: "call-1", name, arguments: "{}", args: {} });
  it("enforces both the advertised tool set and the browser allowlist at dispatch", async () => {
    const mcp = { listTools: vi.fn(), close: vi.fn(), callTool: vi.fn(async () => ({ content: [] })) };
    for (const name of ["browser_run_code", "browser_evaluate", "browser_click", "browser_fill_form"]) {
      expect(await execTool(call(name), [], mcp, ctx, () => {}, new Set([name]))).toContain("unknown tool");
    }
    expect(await execTool(call("browser_snapshot"), [], mcp, ctx, () => {})).toContain("unknown tool");
    expect(mcp.callTool).not.toHaveBeenCalled();
    await execTool(call("browser_snapshot"), [], mcp, ctx, () => {}, new Set(["browser_snapshot"]));
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(browserToolAllowed("browser_click", true)).toBe(false);
    expect(browserToolAllowed("browser_run_code", true)).toBe(false);
  });
  it("refuses a local write even if an unfiltered list reaches dispatch", async () => {
    const run = vi.fn();
    expect(await execTool(call("write"), [{ name: "write", description: "", parameters: {}, write: true, run }], null, ctx, () => {})).toContain("write tools disabled");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("external browser action boundary", () => {
  const ctx = { scope: "global" as const, positionId: null, companyId: null, writes: true };
  const mcp = () => ({ listTools: vi.fn(), close: vi.fn(), callTool: vi.fn(async () => ({ content: [{ type: "text", text: "page" }] })) });
  it("does not allow desk write permission to execute code or submit employer forms", async () => {
    const browser = mcp();
    const calls = [
      { name: "browser_evaluate", args: { function: "() => document.querySelector('form').submit()" } },
      { name: "browser_click", args: { ref: "submit-application", element: "Submit application" } },
      { name: "browser_fill_form", args: { fields: [] } },
      { name: "browser_type", args: { ref: "form", text: "submit", submit: true } },
      { name: "browser_press_key", args: { key: "Enter" } },
      { name: "browser_select_option", args: { ref: "choice", values: ["submit"] } },
    ];
    for (const call of calls) {
      expect(await execTool({ ...call, id: "call", arguments: JSON.stringify(call.args) }, [], browser, ctx, () => {}, new Set([call.name]))).toContain("unknown tool");
    }
    expect(browser.callTool).not.toHaveBeenCalled();
  });
  it.each(["file:///etc/passwd", "data:text/html,<script>fetch('/submit')</script>", "javascript:document.forms[0].submit()", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/"])("does not dispatch browser navigation to %s", async (url) => {
    const browser = mcp();
    const result = await execTool({ id: "call", name: "browser_navigate", args: { url }, arguments: JSON.stringify({ url }) }, [], browser, { ...ctx, writes: false }, () => {}, new Set(["browser_navigate"]));
    expect(result).toContain("public HTTP(S)"); expect(browser.callTool).not.toHaveBeenCalled();
  });
  it("keeps public navigation and page reads available", async () => {
    const browser = mcp();
    for (const [name, args] of [["browser_navigate", { url: "https://jobs.example.com/role" }], ["browser_snapshot", {}]] as const) {
      expect(await execTool({ id: "call", name, args, arguments: JSON.stringify(args) }, [], browser, ctx, () => {}, new Set([name]))).toBe("page");
    }
    expect(browser.callTool).toHaveBeenCalledTimes(2);
  });
});
