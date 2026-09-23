import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const normalise = (value) => value.replace(/\s+/g, " ").trim();

export function safeURL(input, hosts) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || isIP(url.hostname) || !hosts.includes(url.hostname)) throw new Error("Source URL is outside the approved HTTPS hosts");
  url.hash = "";
  return url;
}
// IPv4 ranges that are not the public internet (IANA special-purpose registry), each at its exact size.
// The earlier byte checks blocked whole /16s where only a /24 is reserved — 192.0.x.x among them, which
// rejected every site hosted on WordPress VIP (192.0.64.0/18), NASA's included.
const NON_PUBLIC = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, including cloud metadata endpoints
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, including broadcast
];
const toInt = (address) => address.split(".").reduce((value, octet) => (value << 8 >>> 0) + Number(octet), 0) >>> 0;
const RANGES = NON_PUBLIC.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  // `&` yields a signed 32-bit result; without >>> 0 every range above 128.0.0.0 would never match.
  return { network: (toInt(base) & mask) >>> 0, mask };
});

export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const value = toInt(address);
  return !RANGES.some(({ network, mask }) => ((value & mask) >>> 0) === network);
}

// Pin the checked DNS result for each request; redirects are independently checked.
export async function fetchSource(input, hosts, redirects = 0) {
  if (redirects > 3) throw new Error("Too many source redirects");
  const url = safeURL(input, hosts);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  const blocked = addresses.find(({ address }) => !publicIPv4(address));
  // Name the address: a corporate DNS filter or proxy often answers with a private one, which is otherwise baffling.
  if (!addresses.length || blocked) throw new Error(`Source resolved to a non-public address${blocked ? ` (${blocked.address})` : ""}`);
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "user-agent": "TKnowledgeFeed/1.0", accept: "text/html, application/rss+xml, application/atom+xml, application/xml", "accept-encoding": "identity" },
      lookup: (_host, options, callback) => options.all
        ? callback(null, addresses.map(({ address }) => ({ address, family: 4 })))
        : callback(null, addresses[0].address, 4),
    }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) { res.destroy(); reject(new Error("Source exceeds 1 MB limit")); } else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Source timed out")), 15000);
    request.on("close", () => clearTimeout(deadline)); request.on("error", reject);
  });
  if ([301,302,303,307,308].includes(response.status) && response.headers.location)
    return fetchSource(new URL(response.headers.location, url).href, hosts, redirects + 1);
  if (response.status !== 200) throw new Error(`Source returned HTTP ${response.status}`);
  if (!/html|xml|text\/plain/i.test(response.headers["content-type"] ?? "")) throw new Error("Unsupported source format");
  return { url: url.href, text: response.text, accessedAt: new Date().toISOString() };
}

export function discoverXML(xml, hosts, limit = 10) {
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const raw = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  const urls = [];
  for (const item of items) {
    const links = Array.isArray(item.link) ? item.link : [item.link];
    const link = links.find((value) => typeof value === "string" || !value?.["@_rel"] || value["@_rel"] === "alternate");
    try { urls.push(safeURL(typeof link === "string" ? link : link?.["@_href"], hosts).href); } catch { /* Ignore off-site and malformed entries. */ }
  }
  return [...new Set(urls)].slice(0, limit);
}

/**
 * Split article text into sentences for citation by number. Deliberately simple: a boundary is terminal
 * punctuation (optionally followed by closing quotes or brackets) then whitespace then a capital, digit or
 * opening quote. Imperfect splits are harmless — a cited "sentence" is still verbatim source text.
 */
export function splitSentences(text, max = 400) {
  return String(text)
    .split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Keep the source short enough that the draft and the review both fit a small
 * per-minute token allowance (Groq's free plan: ~8K). 10,000 characters is
 * roughly 2,500 tokens of English, which still covers most of a feature article.
 */
export function extractArticle(response, publisher, maxChars = 10000) {
  const $ = load(response.text);
  const title = normalise($("meta[property='og:title']").attr("content") || $("title").text());
  const rawDate = $("meta[property='article:published_time']").attr("content") || $("time[datetime]").first().attr("datetime");
  const articleDate = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  $("script,style,nav,footer,header,noscript,form,aside").remove();
  const main = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const text = normalise(main.text()).slice(0, maxChars);
  if (text.length < 300 || !title) throw new Error("Not enough accessible source material");
  return { url: response.url, publisher, title: title.slice(0,200), articleDate, accessedAt: response.accessedAt, text, hash: digest(text) };
}
