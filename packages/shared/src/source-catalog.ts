/**
 * Curated discovery sources for Pass-0 scouting.
 *
 * Model:
 * - **ats** boards (Greenhouse / Ashby / Lever / …) are deterministic list APIs.
 * - **market** boards (crypto aggregators, remote indexes) surface roles that often
 *   dual-post to an ATS. Remote OK (public JSON) and We Work Remotely DevOps/Sysadmin RSS
 *   are list_api. Other market boards stay manual_watch (discover → paste ATS URL in Inbox).
 * - Tags drive UI filters (crypto, remote, platform, latam).
 *
 * Research notes (remote + crypto scouting, 2025–2026):
 * - High-pay remote roles usually appear first on company ATS (Greenhouse/Ashby/Lever/Workday),
 *   then repost to LinkedIn/aggregators. Prefer ATS for watches + JD history.
 * - Web3 roles dual-list heavily: web3.career / CryptoJobsList / Remote3 → Greenhouse links.
 * - Niche DevOps boards (devopsjobs.com, DevOps Remotely) + WWR/Remotive/RemoteOK for firehose.
 * - LATAM/Brazil: company ATS (Bitso, Wellhub, Nubank-class) beat global boards for local eligibility.
 */

export type SourceKind = "ats" | "market" | "rss" | "manual";

export type CatalogEntry = {
  id: string;
  company: string;
  provider: string;
  token: string;
  careersUrl: string;
  sourceKind: SourceKind;
  tags: string[];
  notes?: string;
  /** How job-scout uses this source in v0.1 */
  capability: "list_api" | "manual_watch" | "inbox_resolve";
};

/** Official ATS company boards (token = public board slug). */
export const ATS_CATALOG: CatalogEntry[] = [
  // ── Crypto / fintech (Greenhouse) ───────────────────────────────────────
  { id: "gh-strike", company: "Strike", provider: "greenhouse", token: "strike", careersUrl: "https://strike.me/careers", sourceKind: "ats", tags: ["crypto", "payments", "platform"], capability: "list_api", notes: "Bitcoin payments; strong remote platform/SRE signal." },
  { id: "gh-bitso", company: "Bitso", provider: "greenhouse", token: "bitso", careersUrl: "https://bitso.com/jobs", sourceKind: "ats", tags: ["crypto", "latam", "brazil"], capability: "list_api", notes: "Greenhouse token 404s. Openings are on BambooHR; boot demotes this row to a manual watch." },
  { id: "gh-coinbase", company: "Coinbase", provider: "greenhouse", token: "coinbase", careersUrl: "https://www.coinbase.com/careers", sourceKind: "ats", tags: ["crypto"], capability: "list_api" },
  { id: "gh-block", company: "Block", provider: "greenhouse", token: "block", careersUrl: "https://block.xyz/careers", sourceKind: "ats", tags: ["fintech", "crypto"], capability: "list_api", notes: "Square/Cash App/TBD; multi-board Greenhouse." },
  { id: "gh-bitgo", company: "BitGo", provider: "greenhouse", token: "bitgo", careersUrl: "https://www.bitgo.com/careers", sourceKind: "ats", tags: ["crypto", "infra", "custody"], capability: "list_api" },
  { id: "gh-fireblocks", company: "Fireblocks", provider: "greenhouse", token: "fireblocks", careersUrl: "https://www.fireblocks.com/careers", sourceKind: "ats", tags: ["crypto", "infra", "security"], capability: "list_api" },
  { id: "gh-circle", company: "Circle", provider: "greenhouse", token: "circle", careersUrl: "https://www.circle.com/careers", sourceKind: "ats", tags: ["crypto", "stablecoin", "payments"], capability: "list_api" },
  { id: "gh-ripple", company: "Ripple", provider: "greenhouse", token: "ripple", careersUrl: "https://ripple.com/careers", sourceKind: "ats", tags: ["crypto", "payments"], capability: "list_api" },
  { id: "gh-chainalysis", company: "Chainalysis", provider: "greenhouse", token: "chainalysis", careersUrl: "https://www.chainalysis.com/careers", sourceKind: "ats", tags: ["crypto", "compliance"], capability: "list_api" },
  { id: "gh-alpaca", company: "Alpaca", provider: "greenhouse", token: "alpaca", careersUrl: "https://alpaca.markets/careers", sourceKind: "ats", tags: ["fintech", "crypto"], capability: "list_api" },
  // ── Platform / remote-friendly (Greenhouse) ─────────────────────────────
  { id: "gh-remotecom", company: "Remote.com", provider: "greenhouse", token: "remotecom", careersUrl: "https://remote.com/careers", sourceKind: "ats", tags: ["remote", "hrtech"], capability: "list_api", notes: "Seed includes title-rename revision history demo." },
  { id: "gh-wellhub", company: "Wellhub", provider: "greenhouse", token: "wellhub", careersUrl: "https://wellhub.com/careers", sourceKind: "ats", tags: ["brazil", "platform"], capability: "list_api" },
  { id: "gh-grafana", company: "Grafana Labs", provider: "greenhouse", token: "grafanalabs", careersUrl: "https://grafana.com/careers", sourceKind: "ats", tags: ["observability", "remote"], capability: "list_api" },
  { id: "gh-datadog", company: "Datadog", provider: "greenhouse", token: "datadog", careersUrl: "https://careers.datadoghq.com", sourceKind: "ats", tags: ["observability", "platform"], capability: "list_api" },
  { id: "gh-hashicorp", company: "HashiCorp", provider: "greenhouse", token: "hashicorp", careersUrl: "https://www.hashicorp.com/careers", sourceKind: "ats", tags: ["platform", "infra", "devtools"], capability: "list_api" },
  { id: "gh-cloudflare", company: "Cloudflare", provider: "greenhouse", token: "cloudflare", careersUrl: "https://www.cloudflare.com/careers", sourceKind: "ats", tags: ["edge", "platform", "security"], capability: "list_api" },
  { id: "gh-anthropic", company: "Anthropic", provider: "greenhouse", token: "anthropic", careersUrl: "https://www.anthropic.com/careers", sourceKind: "ats", tags: ["ai"], capability: "list_api" },
  { id: "gh-vercel", company: "Vercel", provider: "greenhouse", token: "vercel", careersUrl: "https://vercel.com/careers", sourceKind: "ats", tags: ["devtools", "platform", "remote"], capability: "list_api" },
  { id: "gh-elastic", company: "Elastic", provider: "greenhouse", token: "elastic", careersUrl: "https://www.elastic.co/careers", sourceKind: "ats", tags: ["observability", "search", "remote"], capability: "list_api" },
  { id: "gh-stripe", company: "Stripe", provider: "greenhouse", token: "stripe", careersUrl: "https://stripe.com/jobs", sourceKind: "ats", tags: ["fintech", "payments", "platform"], capability: "list_api" },
  { id: "gh-honeycomb", company: "Honeycomb", provider: "greenhouse", token: "honeycomb", careersUrl: "https://www.honeycomb.io/careers", sourceKind: "ats", tags: ["observability", "sre"], capability: "list_api" },
  { id: "gh-tailscale", company: "Tailscale", provider: "greenhouse", token: "tailscale", careersUrl: "https://tailscale.com/careers", sourceKind: "ats", tags: ["infra", "security", "remote"], capability: "list_api" },
  { id: "gh-gitlab", company: "GitLab", provider: "greenhouse", token: "gitlab", careersUrl: "https://about.gitlab.com/jobs/", sourceKind: "ats", tags: ["platform", "sre", "remote"], capability: "list_api" },
  { id: "gh-pagerduty", company: "PagerDuty", provider: "greenhouse", token: "pagerduty", careersUrl: "https://www.pagerduty.com/careers/", sourceKind: "ats", tags: ["observability", "sre"], capability: "list_api" },
  { id: "gh-galaxy", company: "Galaxy", provider: "greenhouse", token: "galaxy", careersUrl: "https://www.galaxy.com/careers", sourceKind: "ats", tags: ["crypto", "fintech"], capability: "list_api" },
  { id: "gh-canonical", company: "Canonical", provider: "greenhouse", token: "canonical", careersUrl: "https://canonical.com/careers", sourceKind: "ats", tags: ["remote", "linux", "platform"], capability: "list_api" },
  { id: "gh-hut8", company: "Hut8", provider: "greenhouse", token: "hut8", careersUrl: "https://hut8.com/careers", sourceKind: "ats", tags: ["crypto", "infra"], capability: "list_api" },
  { id: "gh-blockchain", company: "Blockchain.com", provider: "greenhouse", token: "blockchain", careersUrl: "https://www.blockchain.com/careers", sourceKind: "ats", tags: ["crypto"], capability: "list_api" },
  { id: "gh-consensys", company: "Consensys", provider: "greenhouse", token: "consensys", careersUrl: "https://consensys.io/careers", sourceKind: "ats", tags: ["crypto", "web3"], capability: "list_api" },
  // ── Ashby boards ────────────────────────────────────────────────────────
  { id: "ash-supabase", company: "Supabase", provider: "ashby", token: "supabase", careersUrl: "https://supabase.com/careers", sourceKind: "ats", tags: ["devtools", "postgres", "remote"], capability: "list_api" },
  { id: "ash-kraken", company: "Kraken", provider: "ashby", token: "kraken.com", careersUrl: "https://jobs.ashbyhq.com/kraken.com", sourceKind: "ats", tags: ["crypto"], capability: "list_api", notes: "Ashby board slug is kraken.com. The bare kraken token 404s." },
  { id: "ash-chainlink", company: "Chainlink Labs", provider: "ashby", token: "chainlink-labs", careersUrl: "https://chain.link/careers", sourceKind: "ats", tags: ["crypto", "infra"], capability: "list_api" },
  { id: "ash-phantom", company: "Phantom", provider: "ashby", token: "phantom", careersUrl: "https://phantom.app/careers", sourceKind: "ats", tags: ["crypto", "wallet"], capability: "list_api" },
  { id: "ash-railway", company: "Railway", provider: "ashby", token: "railway", careersUrl: "https://railway.app/careers", sourceKind: "ats", tags: ["devtools", "platform", "remote"], capability: "list_api" },
  { id: "ash-1password", company: "1Password", provider: "ashby", token: "1password", careersUrl: "https://1password.com/jobs/", sourceKind: "ats", tags: ["security", "remote"], capability: "list_api" },
  { id: "ash-airbyte", company: "Airbyte", provider: "ashby", token: "airbyte", careersUrl: "https://airbyte.com/careers", sourceKind: "ats", tags: ["data", "platform", "remote"], capability: "list_api" },
  { id: "ash-alchemy", company: "Alchemy", provider: "ashby", token: "alchemy", careersUrl: "https://www.alchemy.com/careers", sourceKind: "ats", tags: ["crypto", "infra"], capability: "list_api" },
  { id: "ash-linear", company: "Linear", provider: "ashby", token: "linear", careersUrl: "https://linear.app/careers", sourceKind: "ats", tags: ["devtools", "remote"], capability: "list_api" },
  { id: "ash-resend", company: "Resend", provider: "ashby", token: "resend", careersUrl: "https://resend.com/careers", sourceKind: "ats", tags: ["devtools", "remote"], capability: "list_api" },
  { id: "ash-cursor", company: "Anysphere (Cursor)", provider: "ashby", token: "anysphere", careersUrl: "https://cursor.com/careers", sourceKind: "ats", tags: ["ai", "devtools"], capability: "list_api" },
  { id: "ash-temporal", company: "Temporal", provider: "ashby", token: "temporal", careersUrl: "https://jobs.ashbyhq.com/temporal", sourceKind: "ats", tags: ["infra", "observability", "platform"], capability: "list_api" },
  { id: "ash-clickhouse", company: "ClickHouse", provider: "ashby", token: "clickhouse", careersUrl: "https://clickhouse.com/careers", sourceKind: "ats", tags: ["data", "infra", "observability"], capability: "list_api", notes: "Ashby posting API; Greenhouse token clickhouse 404." },
  { id: "ash-blockstream", company: "Blockstream", provider: "ashby", token: "blockstream", careersUrl: "https://blockstream.com/careers", sourceKind: "ats", tags: ["crypto", "bitcoin", "infra"], capability: "list_api" },
  { id: "ash-polymarket", company: "Polymarket", provider: "ashby", token: "polymarket", careersUrl: "https://polymarket.com/careers", sourceKind: "ats", tags: ["crypto"], capability: "list_api" },
  { id: "ash-camunda", company: "Camunda", provider: "ashby", token: "camunda", careersUrl: "https://camunda.com/career/", sourceKind: "ats", tags: ["platform", "remote"], capability: "list_api" },
  { id: "ash-openai", company: "OpenAI", provider: "ashby", token: "openai", careersUrl: "https://openai.com/careers", sourceKind: "ats", tags: ["ai", "infra"], capability: "list_api" },
  { id: "ash-primer", company: "Primer", provider: "ashby", token: "primer.io", careersUrl: "https://primer.io/careers", sourceKind: "ats", tags: ["fintech", "platform", "remote"], capability: "list_api" },
  // ── Lever boards ────────────────────────────────────────────────────────
  { id: "lev-anchorage", company: "Anchorage Digital", provider: "lever", token: "anchorage", careersUrl: "https://www.anchorage.com/careers", sourceKind: "ats", tags: ["crypto", "custody"], capability: "list_api" },
  { id: "lev-netflix", company: "Netflix", provider: "lever", token: "netflix", careersUrl: "https://jobs.netflix.com", sourceKind: "ats", tags: ["media", "platform"], capability: "list_api" },
  { id: "lev-figma", company: "Figma", provider: "lever", token: "figma", careersUrl: "https://www.figma.com/careers", sourceKind: "ats", tags: ["devtools", "design"], capability: "list_api" },
];

/** Market / aggregator sources — often dual-list to ATS. */
export const MARKET_CATALOG: CatalogEntry[] = [
  {
    id: "mkt-web3career",
    company: "Web3.career",
    provider: "market",
    token: "web3-career",
    careersUrl: "https://web3.career/devops-jobs",
    sourceKind: "market",
    tags: ["crypto", "web3", "remote", "aggregator"],
    notes: "Largest web3 aggregator. Filter devops/infra/SRE; open company ATS link → Inbox paste. Dual-lists Greenhouse heavily.",
    capability: "manual_watch",
  },
  {
    id: "mkt-cryptojobslist",
    company: "CryptoJobsList",
    provider: "market",
    token: "cryptojobslist",
    careersUrl: "https://cryptojobslist.com/",
    sourceKind: "market",
    tags: ["crypto", "web3", "aggregator"],
    notes: "Dedicated crypto board. Prefer roles that deep-link to Greenhouse/Ashby.",
    capability: "manual_watch",
  },
  {
    id: "mkt-cryptocurrencyjobs",
    company: "Cryptocurrency Jobs",
    provider: "market",
    token: "cryptocurrencyjobs",
    careersUrl: "https://cryptocurrencyjobs.co/",
    sourceKind: "market",
    tags: ["crypto", "technical", "aggregator"],
    notes: "Strong for senior/technical crypto (SRE, platform, protocol ops).",
    capability: "manual_watch",
  },
  {
    id: "mkt-cryptojobs",
    company: "CryptoJobs.com",
    provider: "market",
    token: "cryptojobs-com",
    careersUrl: "https://www.cryptojobs.com/jobs",
    sourceKind: "market",
    tags: ["crypto", "web3", "aggregator"],
    capability: "manual_watch",
  },
  {
    id: "mkt-remote3",
    company: "Remote3",
    provider: "market",
    token: "remote3",
    careersUrl: "https://www.remote3.co/",
    sourceKind: "market",
    tags: ["crypto", "remote", "web3"],
    notes: "Remote-first web3 board; good for location-flexible crypto infra.",
    capability: "manual_watch",
  },
  {
    id: "mkt-crypto-jobs",
    company: "Crypto.Jobs",
    provider: "market",
    token: "crypto-jobs-dot",
    careersUrl: "https://crypto.jobs/",
    sourceKind: "market",
    tags: ["crypto", "web3", "aggregator"],
    capability: "manual_watch",
  },
  {
    id: "mkt-bitbo",
    company: "Bitbo Jobs",
    provider: "market",
    token: "bitbo-jobs",
    careersUrl: "https://bitbo.io/jobs/",
    sourceKind: "market",
    tags: ["crypto", "bitcoin"],
    notes: "Bitcoin-focused; infrastructure and market roles.",
    capability: "manual_watch",
  },
  {
    id: "mkt-web3nomads",
    company: "Web3 Nomads",
    provider: "market",
    token: "web3-nomads",
    careersUrl: "https://www.web3nomads.co/",
    sourceKind: "market",
    tags: ["crypto", "remote", "web3"],
    capability: "manual_watch",
  },
  {
    id: "mkt-remotive",
    company: "Remotive",
    provider: "market",
    token: "remotive",
    careersUrl: "https://remotive.com/remote-jobs/software-dev",
    sourceKind: "market",
    tags: ["remote", "software"],
    notes: "Public JSON https://remotive.com/api/remote-jobs?category=software-dev; scanned; title-filtered with isCraftMatch.",
    capability: "list_api",
  },
  {
    id: "mkt-weworkremotely",
    company: "We Work Remotely",
    provider: "market",
    token: "weworkremotely",
    careersUrl: "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs",
    sourceKind: "market",
    tags: ["remote", "devops"],
    notes: "DevOps/Sysadmin RSS https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss; scanned; title-filtered with isCraftMatch.",
    capability: "list_api",
  },
  {
    id: "mkt-remoteok",
    company: "Remote OK",
    provider: "remoteok",
    token: "remoteok",
    careersUrl: "https://remoteok.com/remote-devops-jobs",
    sourceKind: "market",
    tags: ["remote", "devops", "software"],
    notes: "Public JSON feed https://remoteok.com/api; scanned; isCraftMatch(title) or craft tags (devops/sre/platform/infra/observability/kubernetes). sys admin/infosec tags keep only when isCraftMatch(title).",
    capability: "list_api",
  },
  {
    id: "mkt-wellfound",
    company: "Wellfound (AngelList)",
    provider: "market",
    token: "wellfound",
    careersUrl: "https://wellfound.com/role/r/devops-engineer",
    sourceKind: "market",
    tags: ["startup", "remote"],
    capability: "manual_watch",
  },
  {
    id: "mkt-himalayas",
    company: "Himalayas",
    provider: "market",
    token: "himalayas",
    careersUrl: "https://himalayas.app/jobs/remote-devops",
    sourceKind: "market",
    tags: ["remote"],
    capability: "manual_watch",
  },
  {
    id: "mkt-builtin",
    company: "Built In",
    provider: "market",
    token: "builtin",
    careersUrl: "https://builtin.com/jobs/remote/dev-engineering",
    sourceKind: "market",
    tags: ["remote", "tech", "salary"],
    notes: "Tech-heavy with transparent pay ranges; US-biased remote.",
    capability: "manual_watch",
  },
  {
    id: "mkt-devopsjobs",
    company: "DevOpsJobs.com",
    provider: "market",
    token: "devopsjobs",
    careersUrl: "https://devopsjobs.com",
    sourceKind: "market",
    tags: ["devops", "sre", "platform"],
    notes: "Niche DevOps/SRE board — higher signal than general remote indexes.",
    capability: "manual_watch",
  },
  {
    id: "mkt-devops-remotely",
    company: "DevOps Remotely",
    provider: "market",
    token: "devops-remotely",
    careersUrl: "https://devopsremotely.com",
    sourceKind: "market",
    tags: ["devops", "remote", "sre"],
    capability: "manual_watch",
  },
  {
    id: "mkt-bitcoinerjobs",
    company: "Bitcoiner Jobs",
    provider: "market",
    token: "bitcoinerjobs",
    careersUrl: "https://bitcoinerjobs.com",
    sourceKind: "market",
    tags: ["crypto", "bitcoin"],
    notes: "Bitcoin-only board. No public JSON; paste ATS URLs into Inbox.",
    capability: "manual_watch",
  },
];

export const FULL_CATALOG = [...ATS_CATALOG, ...MARKET_CATALOG];

export const SCOUT_PLAYBOOK = {
  dualListing:
    "Market boards (web3.career, CryptoJobsList, Remote3, …) often repost roles that live on Greenhouse/Ashby/Lever. Prefer the ATS URL for watches and JD history — market pages churn and hide body text.",
  pass0:
    "Pass 0 = list public ATS boards + Remote OK JSON + Remotive software-dev JSON + WWR DevOps/Sysadmin RSS → title/geo classify → discovery lanes. No apply. Other market boards stay manual_watch. Prod scan: k8s job-scout-discovery CronJob (capability=list_api).",
  inbox:
    "Human or agent pastes ATS or aggregator URL into Inbox → worker fetches canonical JD → position + first revision. If aggregator, resolve the real ATS link when possible. Agents: prefer MCP intake.",
  agentAccess:
    "WQ-C2: (1) MCP POST /mcp for CRM reads/writes on Mac Grok · (2) Buzz cards for LLM stages only · (3) raw REST if no MCP tool · (4) k8s discovery + agent-drain crons — not Hermes REST agent loops.",
  hermes:
    "LEGACY thin: Hermes may own messaging only. job-scout owns Postgres SoT + discovery/drain crons. Prefer MCP + Buzz for agent work; do not rebuild scoring via Hermes REST.",
  buzz:
    "Block Buzz = human+agent rooms (Nostr). LLM write-backs only (fit/research/materials/jdr). CRM reads prefer MCP. job-scout does not embed Buzz — integration only.",
  mcp:
    "PRIMARY agent path for Mac Grok/Cursor: embedded Streamable HTTP MCP at POST /mcp (2026-07-28, legacy:stateless). Bearer token scopes mcp,agent. See Integrations → MCP.",
  remoteScout:
    "Remote signal: (1) enable ATS boards for target companies first, (2) skim niche remote/DevOps boards for NEW titles, (3) never watch aggregator HTML — promote to ATS watch. Filter hard-geo listings early.",
  cryptoScout:
    "Crypto path: enable GH/Ashby for target exchanges and infra cos, then skim web3.career devops + CryptoJobsList. Many posts are the same Greenhouse job with different wrappers.",
};
