import { describe, expect, it } from "vitest";
import { mapCareerOpsStatus } from "./server.js";

describe("mapCareerOpsStatus", () => {
  it("maps known tracker statuses", () => {
    expect(mapCareerOpsStatus("Applied")).toBe("applied");
    expect(mapCareerOpsStatus(" interviewing ")).toBe("interview");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("ignores prototype key %s", (s) => {
    expect(mapCareerOpsStatus(s)).toBeNull();
  });
});
