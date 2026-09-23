import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAshbyJob, listBoard } from "./fetch.js";

const REMOTEOK_API = "https://remoteok.com/api";
const WWR_RSS = "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss";
const REMOTIVE_API = "https://remotive.com/api/remote-jobs?category=software-dev";

describe("board publication dates", () => {
  const iso = "2026-01-01T00:00:00.000Z";
  it.each([
    ["greenhouse", { jobs: [{ id: 1, title: "Platform Engineer", first_published: iso, updated_at: "2026-09-09" }] }],
    ["ashby", { jobs: [{ id: "1", title: "Platform Engineer", publishedAt: iso }] }],
    ["lever", [{ id: "1", text: "Platform Engineer", createdAt: Date.parse(iso) }]],
    ["remoteok", [{ id: "1", position: "Platform Engineer", date: iso }]],
    ["remotive", { jobs: [{ id: "1", title: "Platform Engineer", publication_date: iso }] }],
  ])("preserves original date from %s", async (provider, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    expect((await listBoard(String(provider), "date-test", "Date test")).jobs[0]?.postedAt).toBe(iso);
  });
  it("preserves RSS pubDate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<rss><channel><item><title>Acme: Platform Engineer</title><link>https://weworkremotely.com/remote-jobs/acme-platform</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>')));
    expect((await listBoard("weworkremotely", "weworkremotely", "WWR")).jobs[0]?.postedAt).toBe(iso);
  });
  it("does not substitute an edit date for unknown or malformed publication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [
      { id: 1, title: "Platform Engineer", updated_at: iso },
      { id: 2, title: "Platform Engineer", first_published: "not-a-date", updated_at: iso },
    ] }))));
    expect((await listBoard("greenhouse", "date-test", "Date test")).jobs.map(j => j.postedAt)).toEqual([undefined, undefined]);
  });
});

/** Live-shaped WWR DevOps/Sysadmin RSS: mix of craft titles and category noise. */
export const WWR_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely: DevOps and Sysadmin Jobs</title>
    <item>
      <title>Grafana Labs: Senior SRE</title>
      <region>Anywhere in the World</region>
      <guid>https://weworkremotely.com/remote-jobs/grafana-labs-senior-sre</guid>
      <link>https://weworkremotely.com/remote-jobs/grafana-labs-senior-sre</link>
    </item>
    <item>
      <title>Helpdesk Co: Sysadmin</title>
      <region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/helpdesk-co-sysadmin</link>
    </item>
    <item>
      <title>Lemon.io: Senior DevOps Engineer</title>
      <region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/lemon-io-senior-devops-engineer</link>
    </item>
    <item>
      <title>Huntress: Evergreen - Sales Development Representative</title>
      <link>https://weworkremotely.com/remote-jobs/huntress-evergreen-sales-development-representative</link>
    </item>
    <item>
      <title>Acme: Platform Engineer</title>
      <region>Worldwide</region>
      <link>https://weworkremotely.com/remote-jobs/acme-platform-engineer</link>
    </item>
    <item>
      <title>Ignition, Inc.: Mac MSP Help Desk Guru (work from home)</title>
      <link>https://weworkremotely.com/remote-jobs/ignition-inc-mac-msp-help-desk-guru-work-from-home</link>
    </item>
    <item>
      <title>Zenara Health: DevOps &amp; Security Engineer - AI-Native Healthcare SaaS</title>
      <region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/zenara-health-devops-security-engineer</link>
    </item>
    <item>
      <title>CircleCI: Senior Software Engineer</title>
      <link>https://weworkremotely.com/remote-jobs/circleci-senior-software-engineer</link>
    </item>
  </channel>
</rss>`;

/** First row is RemoteOK metadata; remaining rows are jobs. */
export const REMOTEOK_FIXTURE = [
  { last_updated: 1_725_000_000, legal: "https://remoteok.com/legal" },
  {
    id: "111",
    slug: "111-remote-senior-devops-engineer-acme",
    position: "Senior DevOps Engineer",
    company: "Acme",
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/111-remote-senior-devops-engineer-acme",
    tags: ["devops", "aws"],
    description: "<p>Kubernetes on EKS</p>",
  },
  {
    id: "222",
    slug: "222-staff-sre-grafana",
    position: "Staff SRE",
    company: "Grafana Labs",
    location: "Remote",
    url: "https://remoteok.com/remote-jobs/222-staff-sre-grafana",
    tags: ["sre"],
  },
  {
    id: 333,
    slug: "333-platform-engineer-neon",
    position: "Platform Engineer",
    company: "Neon",
    location: "Remote - Americas",
    url: "https://remoteok.com/remote-jobs/333-platform-engineer-neon",
    tags: ["python"],
  },
  {
    id: "444",
    slug: "444-observability-engineer-honeycomb",
    position: "Observability Engineer",
    company: "Honeycomb",
    location: "Worldwide",
    tags: ["observability"],
  },
  {
    id: "555",
    slug: "555-kubernetes-engineer-clickhouse",
    position: "Kubernetes Engineer",
    company: "ClickHouse",
    location: "Remote",
    url: "https://remoteok.com/remote-jobs/555-kubernetes-engineer-clickhouse",
    tags: ["k8s"],
  },
  {
    id: "666",
    slug: "666-software-engineer-infraco",
    position: "Software Engineer",
    company: "InfraCo",
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/666-software-engineer-infraco",
    tags: ["infra"],
  },
  {
    id: "777",
    slug: "777-senior-product-designer-figma",
    position: "Senior Product Designer",
    company: "Figma",
    location: "Remote",
    url: "https://remoteok.com/remote-jobs/777-senior-product-designer-figma",
    tags: ["design", "figma"],
  },
  {
    id: "888",
    slug: "888-account-executive-salesco",
    position: "Account Executive",
    company: "SalesCo",
    location: "Remote",
    url: "https://remoteok.com/remote-jobs/888-account-executive-salesco",
    tags: ["sales"],
  },
  {
    id: "999",
    slug: "999-react-native-engineer-appco",
    position: "React Native Engineer",
    company: "AppCo",
    location: "Worldwide",
    url: "https://remoteok.com/remote-jobs/999-react-native-engineer-appco",
    tags: ["javascript", "react"],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockRemoteOkFetch(body: unknown = REMOTEOK_FIXTURE, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === REMOTEOK_API || url.startsWith(`${REMOTEOK_API}?`)) {
      return jsonResponse(body, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/rss+xml" },
  });
}

export const REMOTIVE_FIXTURE = {
  "job-count": 3,
  jobs: [
    {
      id: 1,
      url: "https://remotive.com/remote-jobs/software-dev/senior-sre-1",
      title: "Senior SRE",
      company_name: "Grafana Labs",
      candidate_required_location: "Worldwide",
      category: "Software Development",
    },
    {
      id: 2,
      url: "https://remotive.com/remote-jobs/writing/freelance-copywriter-2",
      title: "Freelance Copywriter",
      company_name: "Coalition",
      candidate_required_location: "Worldwide",
      category: "Writing",
    },
    {
      id: 3,
      url: "https://remotive.com/remote-jobs/software-dev/platform-engineer-3",
      title: "Platform Engineer",
      company_name: "Neon",
      candidate_required_location: "Remote - Americas",
      category: "Software Development",
    },
  ],
};

function mockRemotiveFetch(body: unknown = REMOTIVE_FIXTURE, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === REMOTIVE_API || url.startsWith(`${REMOTIVE_API}&`)) {
      return jsonResponse(body, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockWwrFetch(body: string = WWR_RSS_FIXTURE, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === WWR_RSS || url.startsWith(`${WWR_RSS}?`)) {
      return xmlResponse(body, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PRIMER_DEVEX_ID = "fff14e2f-8335-461e-8b09-532a5371b579";
const PRIMER_ASHBY_JOB = {
  id: PRIMER_DEVEX_ID,
  title: "Senior DevEx Engineer - Infrastructure",
  jobUrl: `https://jobs.ashbyhq.com/primer.io/${PRIMER_DEVEX_ID}`,
  applyUrl: `https://jobs.ashbyhq.com/primer.io/${PRIMER_DEVEX_ID}/application`,
  location: "United Kingdom",
  isRemote: true,
  workplaceType: "Remote",
  isListed: true,
  descriptionPlain: "Remote-first infrastructure.",
  secondaryLocations: [
    { location: "Hungary", address: { postalAddress: { addressCountry: "Hungary" } } },
    { location: "Poland", address: { postalAddress: { addressCountry: "Poland" } } },
    { location: "South Africa", address: { postalAddress: {} } },
    { location: "Portugal", address: { postalAddress: { addressCountry: "Portugal" } } },
    { location: "Ireland", address: { postalAddress: {} } },
    { location: "Romania", address: { postalAddress: { addressCountry: "Romania" } } },
  ],
};

function mockAshbyFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.ashbyhq.com/posting-api/job-board/primer.io")) {
      return jsonResponse({ jobs: [PRIMER_ASHBY_JOB] });
    }
    if (url.includes("/application")) {
      return new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listBoard ashby", () => {
  it("joins Ashby object secondaryLocations into locationRaw", async () => {
    mockAshbyFetch();
    const { jobs } = await listBoard("ashby", "primer.io", "Primer");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.locationRaw).toBe(
      "United Kingdom · Hungary · Poland · South Africa · Portugal · Ireland · Romania",
    );
    expect(jobs[0]?.locationRaw).not.toMatch(/\[object Object\]/);
    expect(jobs[0]?.isRemote).toBe(true);
    expect(jobs[0]?.workplaceType).toBe("Remote");
  });
});

describe("fetchAshbyJob", () => {
  it("does not stringify secondary location objects", async () => {
    mockAshbyFetch();
    const job = await fetchAshbyJob("primer.io", PRIMER_DEVEX_ID);
    expect(job.locationRaw).toBe(
      "United Kingdom · Hungary · Poland · South Africa · Portugal · Ireland · Romania",
    );
    expect(job.locationRaw).not.toMatch(/\[object Object\]/);
    expect(job.isRemote).toBe(true);
    expect(job.workplaceType).toBe("Remote");
  });
});

describe("listBoard remoteok", () => {
  it("returns craft-matching jobs from the public JSON feed and drops noise", async () => {
    const fetchMock = mockRemoteOkFetch();
    const { jobs, total } = await listBoard("remoteok", "remoteok", "Remote OK");

    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(calledUrl)).toBe(REMOTEOK_API);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(String(headers?.["User-Agent"] || "")).toMatch(/job-scout/);

    expect(total).toBe(6);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior DevOps Engineer",
      "Staff SRE",
      "Platform Engineer",
      "Observability Engineer",
      "Kubernetes Engineer",
      "Software Engineer",
    ]);
    expect(jobs.map((j) => j.title)).not.toContain("Senior Product Designer");
    expect(jobs.map((j) => j.title)).not.toContain("Account Executive");
    expect(jobs.map((j) => j.title)).not.toContain("React Native Engineer");

    expect(jobs[0]).toMatchObject({
      provider: "remoteok",
      boardToken: "remoteok",
      jobId: "111",
      externalIdentity: "remoteok:111",
      company: "Acme",
      url: "https://remoteok.com/remote-jobs/111-remote-senior-devops-engineer-acme",
      locationRaw: "Worldwide",
    });
    expect(jobs.find((j) => j.jobId === "333")?.externalIdentity).toBe("remoteok:333");
    expect(jobs.find((j) => j.jobId === "444")?.url).toBe(
      "https://remoteok.com/remote-jobs/444-observability-engineer-honeycomb",
    );
  });

  it("accepts market + token remoteok", async () => {
    mockRemoteOkFetch();
    const { jobs } = await listBoard("market", "remoteok", "Remote OK");
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j) => j.provider === "remoteok")).toBe(true);
  });

  it("throws when the feed is unavailable", async () => {
    mockRemoteOkFetch({ error: "nope" }, 403);
    await expect(listBoard("remoteok", "remoteok", "Remote OK")).rejects.toThrow(/remoteok/i);
  });

  it("drops live-shaped Sysadmin tagged sys admin and keeps Senior SRE", async () => {
    mockRemoteOkFetch([
      { last_updated: 1_725_000_000, legal: "https://remoteok.com/legal" },
      {
        id: "1001",
        slug: "1001-sysadmin-helpdesk",
        position: "Sysadmin",
        company: "Helpdesk Co",
        location: "Remote",
        url: "https://remoteok.com/remote-jobs/1001-sysadmin-helpdesk",
        tags: ["sys admin", "ops"],
      },
      {
        id: "1002",
        slug: "1002-senior-sre-grafana",
        position: "Senior SRE",
        company: "Grafana Labs",
        location: "Worldwide",
        url: "https://remoteok.com/remote-jobs/1002-senior-sre-grafana",
        tags: ["sys admin", "ops"],
      },
      {
        id: "1003",
        slug: "1003-account-executive-salesco",
        position: "Account Executive",
        company: "SalesCo",
        location: "Remote",
        url: "https://remoteok.com/remote-jobs/1003-account-executive-salesco",
        tags: ["infosec"],
      },
    ]);
    const { jobs, total } = await listBoard("remoteok", "remoteok", "Remote OK");
    expect(total).toBe(1);
    expect(jobs.map((j) => j.title)).toEqual(["Senior SRE"]);
    expect(jobs[0]?.externalIdentity).toBe("remoteok:1002");
  });
});

describe("listBoard weworkremotely", () => {
  it("parses DevOps/Sysadmin RSS items and keeps craft titles only", async () => {
    const fetchMock = mockWwrFetch();
    const { jobs, total } = await listBoard("market", "weworkremotely", "We Work Remotely");

    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(calledUrl)).toBe(WWR_RSS);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(String(headers?.["User-Agent"] || "")).toMatch(/job-scout/);
    expect(String(headers?.Accept || "")).toMatch(/rss|xml/i);

    expect(total).toBe(4);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior SRE",
      "Senior DevOps Engineer",
      "Platform Engineer",
      "DevOps & Security Engineer - AI-Native Healthcare SaaS",
    ]);
    expect(jobs.map((j) => j.title)).not.toContain("Sysadmin");
    expect(jobs.map((j) => j.title)).not.toContain("Evergreen - Sales Development Representative");
    expect(jobs.map((j) => j.title)).not.toContain("Mac MSP Help Desk Guru (work from home)");
    expect(jobs.map((j) => j.title)).not.toContain("Senior Software Engineer");

    expect(jobs[0]).toMatchObject({
      provider: "weworkremotely",
      boardToken: "weworkremotely",
      jobId: "grafana-labs-senior-sre",
      externalIdentity: "weworkremotely:grafana-labs-senior-sre",
      company: "Grafana Labs",
      url: "https://weworkremotely.com/remote-jobs/grafana-labs-senior-sre",
      locationRaw: "Anywhere in the World",
    });
    expect(jobs.find((j) => j.jobId === "lemon-io-senior-devops-engineer")?.company).toBe("Lemon.io");
  });

  it("accepts provider weworkremotely", async () => {
    mockWwrFetch();
    const { jobs } = await listBoard("weworkremotely", "weworkremotely", "We Work Remotely");
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.provider === "weworkremotely")).toBe(true);
  });

  it("throws when the feed is unavailable", async () => {
    mockWwrFetch("<error>nope</error>", 403);
    await expect(listBoard("market", "weworkremotely", "We Work Remotely")).rejects.toThrow(
      /weworkremotely/i,
    );
  });
});

describe("listBoard remotive", () => {
  it("returns craft-matching Remotive jobs and drops copywriters", async () => {
    const fetchMock = mockRemotiveFetch();
    const { jobs, total } = await listBoard("market", "remotive", "Remotive");

    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(calledUrl)).toBe(REMOTIVE_API);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(String(headers?.["User-Agent"] || "")).toMatch(/job-scout/);

    expect(total).toBe(2);
    expect(jobs.map((j) => j.title)).toEqual(["Senior SRE", "Platform Engineer"]);
    expect(jobs.map((j) => j.title)).not.toContain("Freelance Copywriter");
    expect(jobs[0]).toMatchObject({
      provider: "remotive",
      boardToken: "remotive",
      jobId: "1",
      externalIdentity: "remotive:1",
      company: "Grafana Labs",
      url: "https://remotive.com/remote-jobs/software-dev/senior-sre-1",
      locationRaw: "Worldwide",
    });
    expect(jobs.find((j) => j.jobId === "3")?.company).toBe("Neon");
    expect(jobs.find((j) => j.jobId === "3")?.locationRaw).toBe("Remote - Americas");
  });

  it("accepts provider remotive", async () => {
    mockRemotiveFetch();
    const { jobs } = await listBoard("remotive", "remotive", "Remotive");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.provider === "remotive")).toBe(true);
  });

  it("throws when the feed is unavailable", async () => {
    mockRemotiveFetch({ error: "nope" }, 403);
    await expect(listBoard("market", "remotive", "Remotive")).rejects.toThrow(/remotive/i);
  });
});
