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
    expect(browserToolAllowed("browser_click", true)).toBe(true);
    expect(browserToolAllowed("browser_run_code", true)).toBe(false);
  });
  it("refuses a local write even if an unfiltered list reaches dispatch", async () => {
    const run = vi.fn();
    expect(await execTool(call("write"), [{ name: "write", description: "", parameters: {}, write: true, run }], null, ctx, () => {})).toContain("write tools disabled");
    expect(run).not.toHaveBeenCalled();
  });
});
