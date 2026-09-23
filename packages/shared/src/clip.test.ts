import { describe, expect, it } from "vitest";
import { CLIP_TEXT_MAX, clipBookmarklet, parseClipListing } from "./clip.js";

describe("clipBookmarklet", () => {
  it("POSTs innerText to /clip with no secrets", () => {
    const js = clipBookmarklet("https://jobs.example");
    expect(js.startsWith("javascript:")).toBe(true);
    expect(js).toContain("innerText");
    expect(js).toContain("POST");
    expect(js).toContain("/clip");
    expect(js).toContain("https://jobs.example/clip");
    expect(js).toContain("_blank");
    expect(js).toContain("document.title");
    expect(js).toContain("location.href");
    expect(js).toContain(String(CLIP_TEXT_MAX));
    expect(js).not.toContain("/clip?url=");
    expect(js.toLowerCase()).not.toContain("token");
    expect(js.toLowerCase()).not.toContain("bearer");
    expect(js.toLowerCase()).not.toContain("js_session");
    expect(js.toLowerCase()).not.toContain("password");
    expect(js).not.toContain("localStorage");
  });

  it("strips a trailing slash on the origin", () => {
    expect(clipBookmarklet("https://jobs.example/")).toContain("https://jobs.example/clip");
    expect(clipBookmarklet("https://jobs.example/")).not.toContain("https://jobs.example//clip");
  });

  it("fails fast without an origin", () => {
    expect(() => clipBookmarklet("")).toThrow("origin required");
  });
});

describe("parseClipListing", () => {
  it("parses a LinkedIn role-at-company title", () => {
    const p = parseClipListing({
      url: "https://www.linkedin.com/jobs/view/4123456789/",
      title: "Staff SRE at Stripe | LinkedIn",
      text: "Own the Kubernetes control plane.",
    });
    expect(p.title).toBe("Staff SRE");
    expect(p.company).toBe("Stripe");
    expect(p.descriptionText).toContain("Kubernetes");
  });

  it("parses an Indeed title", () => {
    const p = parseClipListing({
      url: "https://www.indeed.com/viewjob?jk=abc",
      title: "Staff SRE - Acme | Indeed.com",
      text: "Run the platform.",
    });
    expect(p.title).toBe("Staff SRE");
    expect(p.company).toBe("Acme");
  });

  it("leaves company unset when the title has no company", () => {
    const p = parseClipListing({
      url: "https://www.linkedin.com/jobs/view/1",
      title: "LinkedIn",
      text: "Platform Engineer\n\nBuild the control plane.",
    });
    expect(p.company).toBeUndefined();
    expect(p.title).toBe("Platform Engineer");
  });
});
