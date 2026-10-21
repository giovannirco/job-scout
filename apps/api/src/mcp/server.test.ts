import { describe, expect, it } from "vitest";
import { agentOf, mapCareerOpsStatus } from "./server.js";

describe("mapCareerOpsStatus", () => {
  it("maps known tracker statuses", () => {
    expect(mapCareerOpsStatus("Applied")).toBe("applied");
    expect(mapCareerOpsStatus(" interviewing ")).toBe("interview");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("ignores prototype key %s", (s) => {
    expect(mapCareerOpsStatus(s)).toBeNull();
  });
});

describe("agentOf", () => {
  const ctx = (extra?: Record<string, unknown>) => ({ http: { authInfo: { clientId: "shared-agent-token", extra } } });

  it("falls back to the token name, then to mcp-client", () => {
    expect(agentOf(ctx())).toBe("shared-agent-token");
    expect(agentOf({})).toBe("mcp-client");
  });

  it("records the calling agent via its token", () => {
    expect(agentOf(ctx({ actor: "pipeline-sync" }))).toBe("pipeline-sync via shared-agent-token");
    expect(agentOf({ authInfo: { clientId: "shared-agent-token", extra: { actor: "pipeline-sync" } } })).toBe("pipeline-sync via shared-agent-token");
    expect(agentOf(ctx({ actor: "from-header" }), "from-arg")).toBe("from-arg via shared-agent-token");
  });

  it("sanitizes the caller and never drops the token", () => {
    expect(agentOf(ctx(), "pipeline sync!")).toBe("pipeline-sync via shared-agent-token");
    expect(agentOf(ctx(), "x via operator")).toBe("x-via-operator via shared-agent-token");
    expect(agentOf(ctx(), "  ")).toBe("shared-agent-token");
    expect(agentOf(ctx(), "shared-agent-token")).toBe("shared-agent-token");
    expect(agentOf(ctx({ actor: 42 }))).toBe("shared-agent-token");
    expect(agentOf(ctx(), "a".repeat(200))).toBe(`${"a".repeat(64)} via shared-agent-token`);
  });
});
