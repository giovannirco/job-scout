import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@job-scout/core";
import { createApp } from "../app.js";

type ErrorEnvelope = { ok: boolean; error: { code: string; message: string; details: Record<string, unknown> } };

function post(url: string) {
  return createApp().request("/api/v1/positions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("POST /api/v1/positions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a careers board URL with code board_index and a board suggestion", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await post("https://boards.greenhouse.io/acme-example");
      expect(res.status).toBe(400);
      const json = (await res.json()) as ErrorEnvelope;
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.details).toMatchObject({
        code: "board_index",
        reason: "board_url",
        boardSuggestion: { provider: "greenhouse", token: "acme-example" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries board_index for a page titled like a listing", async () => {
    vi.spyOn(core, "intakeUrl").mockRejectedValue(new core.BoardIndexError({ reason: "board_title", title: "Job openings" }));
    const res = await post("https://www.acme-example.com/about/team-and-roles");
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorEnvelope;
    expect(json.error.details).toMatchObject({ code: "board_index", reason: "board_title" });
  });

  it("does not add a code to other intake failures", async () => {
    vi.spyOn(core, "intakeUrl").mockRejectedValue(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }));
    const res = await post("https://careers.acme-example.com/jobs/1");
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorEnvelope;
    expect(json.error.details).toEqual({});
  });
});
