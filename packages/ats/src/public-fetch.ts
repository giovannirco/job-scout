import { lookup } from "node:dns";
import { isIP, BlockList } from "node:net";
import { Agent } from "undici";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
// Only global unicast IPv6 is eligible; block transition ranges that can embed IPv4 destinations.
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, "ipv6");
  return false;
}

export function assertPublicUrl(input: string | URL): URL {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".svc") || hostname.endsWith(".cluster.local") ||
    !hostname.includes(".") && !isIP(hostname) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new Error("ATS URL must address a public HTTP(S) service on port 80 or 443");
  }
  return url;
}

// Validate the addresses actually used by the socket, not a separate DNS preflight.
// This prevents a DNS rebinding between validation and connection.
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error, [], 0);
    if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
      return callback(new Error("ATS hostname resolves to a non-public address"), [], 0);
    }
    const eligible = options.family ? records.filter((record) => record.family === options.family) : records;
    if (!eligible.length) return callback(new Error("No public address for requested family"), [], 0);
    if (options.all) callback(null, eligible);
    else callback(null, eligible[0].address, eligible[0].family);
  });
} } });

/** Follow a bounded redirect chain with the same network policy at every hop. */
export async function publicFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = assertPublicUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url.href, { ...init, redirect: "manual", dispatcher } as RequestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    if (redirects === 5) throw new Error("Too many ATS redirects");
    const next = assertPublicUrl(new URL(location, url));
    if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("ATS redirect cannot downgrade HTTPS");
    url = next;
  }
  throw new Error("Too many ATS redirects");
}
