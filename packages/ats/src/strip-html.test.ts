import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, stripHtml } from "./fetch.js";

describe("stripHtml", () => {
  it("strips normal tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("decodes double-escaped Greenhouse-style HTML", () => {
    const raw =
      "&lt;div class=&quot;content-intro&quot;&gt;&lt;h3&gt;Working At Bitso&lt;/h3&gt; &lt;p&gt;We are a diverse team&lt;/p&gt;&lt;/div&gt;";
    const out = stripHtml(raw);
    expect(out).toContain("Working At Bitso");
    expect(out).toContain("We are a diverse team");
    expect(out).not.toContain("&lt;");
    expect(out).not.toContain("content-intro");
  });

  it("decodes the dashes and quotes Greenhouse leaves in the JD", () => {
    expect(stripHtml("<p>$133,100 &mdash; $210,600</p>")).toBe("$133,100 — $210,600");
    expect(decodeHtmlEntities("it&rsquo;s")).toBe("it’s");
  });

  it("decodeHtmlEntities handles amp last", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities(decodeHtmlEntities("&amp;lt;"))).toBe("<");
  });
});
