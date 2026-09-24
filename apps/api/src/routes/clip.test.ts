import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@job-scout/core";
import { createApp } from "../app.js";
import { createSession } from "../auth.js";
import { env } from "../env.js";

const listing = "https://www.linkedin.com/jobs/view/12345";

const clipResult = {
  position: { id: "pos_clip", slug: "acme-sre", title: "SRE" },
  created: true,
  revived: false,
  triageJobId: "job_1",
};

function stubIntake(over: Record<string, unknown> = {}) {
  return vi.spyOn(core, "intakeUrl").mockResolvedValue({
    ...clipResult,
    ...over,
  } as Awaited<ReturnType<typeof core.intakeUrl>>);
}

function stubClip(over: Record<string, unknown> = {}) {
  return vi.spyOn(core, "intakeClipSnapshot").mockResolvedValue({
    ...clipResult,
    ...over,
  } as Awaited<ReturnType<typeof core.intakeClipSnapshot>>);
}

describe("GET /clip", () => {
  afterEach(() => {
    env.authMode = "dev";
    vi.restoreAllMocks();
  });

  it("rejects a missing url", async () => {
    const intake = stubIntake();
    const res = await createApp().request("/clip");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { message: string } };
    expect(json.ok).toBe(false);
    expect(json.error.message).toBe("url required");
    expect(intake).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated clip when AUTH_MODE=token", async () => {
    env.authMode = "token";
    const intake = stubIntake();
    const res = await createApp().request(`/clip?url=${encodeURIComponent(listing)}`);
    expect(res.status).toBe(401);
    expect(intake).not.toHaveBeenCalled();
  });

  it("intakes the url and redirects to the position without fetching the listing", async () => {
    const intake = stubIntake();
    const res = await createApp().request(`/clip?url=${encodeURIComponent(listing)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/positions/acme-sre");
    expect(intake).toHaveBeenCalledTimes(1);
    expect(intake).toHaveBeenCalledWith(listing);
  });

  it("accepts a session cookie in token mode", async () => {
    env.authMode = "token";
    const intake = stubIntake();
    const res = await createApp().request(`/clip?url=${encodeURIComponent(listing)}`, {
      headers: { Cookie: `js_session=${createSession()}` },
    });
    expect(res.status).toBe(302);
    expect(intake).toHaveBeenCalledWith(listing);
  });

  it("surfaces intake failures as 400", async () => {
    vi.spyOn(core, "intakeUrl").mockRejectedValue(new Error("not a job page"));
    const res = await createApp().request(`/clip?url=${encodeURIComponent(listing)}`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { message: string } };
    expect(json.error.message).toBe("not a job page");
  });
});

describe("POST /clip", () => {
  afterEach(() => {
    env.authMode = "dev";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const jd = "Own the Kubernetes control plane. Terraform and Argo CD.";
  const linkedInTitle = "Staff SRE at Stripe | LinkedIn";

  it("POSTs snapshot text without calling intakeUrl or fetch", async () => {
    const intake = stubIntake();
    const clip = stubClip();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network forbidden in clip POST");
    });
    const res = await createApp().request("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: listing, title: linkedInTitle, text: jd }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/positions/acme-sre");
    expect(intake).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(clip).toHaveBeenCalledTimes(1);
    expect(clip).toHaveBeenCalledWith({ url: listing, title: linkedInTitle, text: jd });
  });

  it("accepts application/x-www-form-urlencoded snapshots", async () => {
    const intake = stubIntake();
    const clip = stubClip();
    const body = new URLSearchParams({ url: listing, title: linkedInTitle, text: jd });
    const res = await createApp().request("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(res.status).toBe(302);
    expect(intake).not.toHaveBeenCalled();
    expect(clip).toHaveBeenCalledWith({ url: listing, title: linkedInTitle, text: jd });
  });

  it("rejects an empty snapshot with 400", async () => {
    const intake = stubIntake();
    const clip = stubClip();
    const res = await createApp().request("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: listing, title: "", text: "" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { message: string } };
    expect(json.error.message).toBe("snapshot empty");
    expect(intake).not.toHaveBeenCalled();
    expect(clip).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated POST when AUTH_MODE=token", async () => {
    env.authMode = "token";
    const clip = stubClip();
    const res = await createApp().request("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: listing, title: linkedInTitle, text: jd }),
    });
    expect(res.status).toBe(401);
    expect(clip).not.toHaveBeenCalled();
  });
});

describe("cross-site clip confirmation", () => {
  afterEach(() => { env.authMode = "dev"; vi.restoreAllMocks(); });
  it("stages an escaped bookmarklet preview without invoking intake, then accepts same-origin confirmation", async () => {
    env.authMode = "token";
    const intake = stubClip();
    const payload = { url: listing, title: '<script>alert("xss")</script>', text: "The job description" };
    const a = createApp();
    const preview = await a.request("/clip", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://www.linkedin.com" }, body: new URLSearchParams(payload),
    });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Save job clip"); expect(html).not.toContain("<script>");
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(intake).not.toHaveBeenCalled();
    const saved = await a.request("/clip", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: env.allowedOrigins[0], cookie: `js_session=${createSession()}` }, body: new URLSearchParams(payload),
    });
    expect(saved.status).toBe(302); expect(intake).toHaveBeenCalledTimes(1);
  });
  it.each(["cross-site", "same-site"])("does not import %s GET clips until confirmed", async (site) => {
    const intake = stubIntake();
    const response = await createApp().request(`/clip?url=${encodeURIComponent(listing)}`, { headers: { "sec-fetch-site": site } });
    expect(response.status).toBe(200); expect(intake).not.toHaveBeenCalled();
  });
});
