import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const normalise = (value) => value.replace(/\s+/g, " ").trim();

/**
 * `hosts` lists the hostnames a source may be fetched from. The single entry "*" means any host — used only
 * for the articles a link aggregator (Hacker News) points to. Everything else still applies to it: HTTPS on
 * 443, no credentials, no IP literals, and fetchSource refuses any name that resolves to a private address.
 */
export const ANY_HOST = ["*"];

export function safeURL(input, hosts) {
  const url = new URL(input);
  const allowed = hosts.includes("*") || hosts.includes(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || isIP(url.hostname) || !allowed) throw new Error(`Source URL is outside the approved HTTPS hosts (${url.protocol}//${url.hostname})`);
  url.hash = "";
  return url;
}

/** Find the declared character set: HTTP header first, then an XML declaration or HTML meta tag. */
function charsetOf(headers, bytes) {
  const header = /charset=["']?([\w-]+)/i.exec(headers["content-type"] ?? "")?.[1];
  if (header) return header;
  const head = bytes.subarray(0, 4096).toString("latin1");
  return /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
    ?? "utf-8";
}

/** Decode in the page's own character set (Big5 and GBK are common on Chinese sites), falling back to UTF-8. */
export function decode(bytes, headers = {}) {
  try {
    return new TextDecoder(charsetOf(headers, bytes)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
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

/** Base domain, roughly: "www.scmp.com" → "scmp.com". Good enough for same-site redirects. */
const site = (host) => host.replace(/^www\./, "");
/**
 * A redirect may move between hosts of the same site (www.scmp.com → scmp.com, www.nature.com →
 * feeds.nature.com). Everything else about it is still checked: HTTPS, no IP literal, a public address.
 */
function withSameSite(hosts, location, from) {
  if (hosts.includes("*")) return hosts;
  try {
    const target = new URL(location, from).hostname;
    return hosts.some((h) => target === site(h) || target.endsWith(`.${site(h)}`)) ? [...hosts, target] : hosts;
  } catch { return hosts; }
}

/**
 * Where a redirect leads. Some sites (SCMP) redirect to plain http://, which is never fetched: ask for the
 * same address over HTTPS instead. If that is exactly where we already are, the site insists on HTTP.
 */
export function nextHop(location, from) {
  const next = new URL(location, from);
  if (next.protocol === "http:") {
    next.protocol = "https:";
    if (next.port === "80") next.port = "";
    if (next.href === new URL(from).href) throw new Error("Source redirects to plain HTTP only");
  }
  return next.href;
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
      headers: { "user-agent": "Mozilla/5.0 (compatible; TKnowledgeFeed/1.0; personal feed reader)", accept: "text/html, application/rss+xml, application/atom+xml, application/xml", "accept-encoding": "identity" },
      lookup: (_host, options, callback) => options.all
        ? callback(null, addresses.map(({ address }) => ({ address, family: 4 })))
        : callback(null, addresses[0].address, 4),
    }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        // Some feeds carry full article bodies and run to a few megabytes.
        if (size > 5_000_000) { res.destroy(); reject(new Error("Source exceeds 5 MB limit")); } else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: decode(Buffer.concat(chunks), res.headers) }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("Source timed out")), 15000);
    request.on("close", () => clearTimeout(deadline)); request.on("error", reject);
  });
  if ([301,302,303,307,308].includes(response.status) && response.headers.location)
  {
    const next = nextHop(response.headers.location, url);
    return fetchSource(next, withSameSite(hosts, next, url), redirects + 1);
  }
  if (response.status !== 200) throw new Error(`Source returned HTTP ${response.status}`);
  if (!/html|xml|text\/plain/i.test(response.headers["content-type"] ?? "")) throw new Error("Unsupported source format");
  return { url: url.href, text: response.text, accessedAt: new Date().toISOString() };
}

/**
 * Feed items with their headline and summary, which the triage call reads before anything is drafted, and
 * what an excerpt needs: the publisher's own description, categories, date and author. With `bodies`, also
 * the article body the feed carries (raw HTML; see feedBlocks). A sitemap (OpenStax lists each book's
 * sections in one) gives locations only, and far more of them than a feed.
 */
export function discoverXMLItems(xml, hosts, limit = 10, { bodies = false } = {}) {
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  // RSS 2.0, Atom, and RSS 1.0 (RDF, used by Nature), where items sit beside the channel, not inside it.
  const rdf = parsed["rdf:RDF"];
  const sitemap = parsed.urlset ? (parsed.urlset.url ?? []) : null;
  const raw = sitemap ?? parsed.rss?.channel?.item ?? parsed.feed?.entry ?? rdf?.item ?? rdf?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const found = [];
  for (const item of items) {
    const links = sitemap ? [textOf(item?.loc)] : Array.isArray(item?.link) ? item.link : [item?.link];
    const link = links.find((value) => typeof value === "string" || !value?.["@_rel"] || value["@_rel"] === "alternate");
    let url;
    try { url = safeURL(typeof link === "string" ? link.trim() : link?.["@_href"], hosts).href; } catch { continue; /* Off-site or malformed. */ }
    if (seen.has(url)) continue;
    seen.add(url);
    if (sitemap) { found.push({ url, title: "", summary: "", description: "", categories: [], published: null, author: "" }); continue; }
    const body = textOf(item["content:encoded"] ?? item.content);
    const date = textOf(item.pubDate ?? item.published ?? item["dc:date"] ?? item.updated);
    const categories = (Array.isArray(item.category) ? item.category : item.category ? [item.category] : [])
      .map((c) => normalise(decodeEntities(typeof c === "string" ? c : textOf(c) || c?.["@_term"] || ""))).filter((c) => c && c.length <= 60).slice(0, 12);
    found.push({
      url, title: plain(item.title), summary: plain(item.description ?? item.summary ?? body).slice(0, 300),
      description: plain(item.description ?? item.summary, 1200), categories,
      published: Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null,
      author: plain(item["dc:creator"] ?? item.author?.name ?? item.author, 120),
      ...(bodies && body ? { body } : {}),
    });
  }
  return found.slice(0, sitemap ? 2000 : limit);
}
export function discoverXML(xml, hosts, limit = 10) { return discoverXMLItems(xml, hosts, limit).map((item) => item.url); }

/** The text of a parsed XML value: a string, or the text of a CDATA or attributed element. */
const textOf = (value) => (typeof value === "string" ? value : typeof value?.["#text"] === "string" ? value["#text"] : "");
const decodeEntities = (value) => load(`<div>${value}</div>`)("div").text();
/** Text from a feed field that may be a string, CDATA object or HTML. */
function plain(value, max = 300) {
  return normalise(decodeEntities(textOf(value))).slice(0, max);
}

// WordPress appends "The post … appeared first on …" to every item in a full-content feed.
const FEED_FOOTER = /^the post .{1,300} appeared first on .{1,200}$/i;
const MAX_BLOCK_CHARS = 4000;

/**
 * A feed's article body as plain blocks for reading in the app: headings, paragraphs, lists, quotes and
 * simple tables, text only. No markup survives, so nothing from a feed can run or style anything in the
 * app, and images and embeds are dropped. Returns [] when there is nothing worth keeping.
 */
export function feedBlocks(html, { maxBlocks = 300, maxChars = 60_000 } = {}) {
  const $ = load(`<div id="feed-body">${html}</div>`);
  $("script,style,noscript,iframe,object,embed,form,button,svg,img,picture,video,audio,figure,figcaption").remove();
  const blocks = [];
  let total = 0;
  const push = (block, size) => {
    if (blocks.length >= maxBlocks || total + size > maxChars) return;
    blocks.push(block);
    total += size;
  };
  const clean = (element) => normalise($(element).text()).slice(0, MAX_BLOCK_CHARS);
  $("#feed-body").find("h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,table").each((_, element) => {
    // Each block once: a paragraph inside a quote, list or table belongs to that block.
    if ($(element).parents("blockquote,ul,ol,table").length) return;
    const tag = element.name;
    if (tag === "ul" || tag === "ol") {
      const items = $(element).children("li").map((_, li) => clean(li)).get().filter(Boolean).slice(0, 50);
      if (items.length) push({ t: tag, items }, items.join("").length);
    } else if (tag === "table") {
      const rows = $(element).find("tr").map((_, tr) => [$(tr).children("th,td").map((_, cell) => clean(cell).slice(0, 300)).get().slice(0, 12)]).get()
        .filter((row) => row.some(Boolean)).slice(0, 40);
      if (rows.length) push({ t: "table", rows }, rows.flat().join("").length);
    } else {
      const text = clean(element);
      if (!text || (tag === "p" && FEED_FOOTER.test(text))) return;
      push({ t: tag === "p" ? "p" : tag === "blockquote" ? "q" : "h", text }, text.length);
    }
  });
  return blocks;
}

/** The readable text of blocks, for drafting from a feed's copy and for size checks. */
export const blocksText = (blocks) => blocks.map((b) => b.text ?? (b.items ?? b.rows?.flat() ?? []).join(" ")).filter(Boolean).join("\n\n");

/** Newsletters decorate headlines with emoji ("📬 The 3am cash flow stare"); a card reads better without. */
export const plainTitle = (value) => normalise(String(value ?? "").replace(/^[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍\s]+/u, ""));

/**
 * For an excerpt source without a feed summary (a textbook section, a newsletter issue): the page's heading,
 * its first substantial paragraph (skipping "By the end of this section…" learning objectives and list
 * lead-ins), the publisher's own one-line description, and its publication date.
 */
export function pageExcerpt(response) {
  const $ = load(response.text);
  const heading = plainTitle($("h1").first().text() || $("meta[property='og:title']").attr("content") || $("title").text());
  const description = normalise($("meta[property='og:description']").attr("content") || $("meta[name='description']").attr("content") || "");
  const rawDate = $("meta[property='article:published_time']").attr("content");
  $("script,style,nav,footer,header,noscript,form,aside,figure,figcaption,button,svg,[aria-hidden='true']").remove();
  const main = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  const paragraph = main.find("p").map((_, p) => normalise($(p).text())).get()
    .find((p) => p.length >= 120 && !/:$/.test(p) && !/^by the end of this (section|chapter|module)/i.test(p));
  return {
    // "6.3 The Laws of Thermodynamics" reads better without its section number.
    title: heading.replace(/^\d+(\.\d+)*\s+/, "").slice(0, 200),
    paragraph: paragraph ? paragraph.slice(0, 1200) : null,
    description: description.slice(0, 600),
    articleDate: rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null,
  };
}

/**
 * For a site with no feed: collect article links from one of its listing pages. `match` (a regular
 * expression) says which links are articles, e.g. "/doc/"; without it every on-site link would qualify.
 */
export function discoverHTMLItems(html, pageUrl, hosts, match, limit = 10) {
  const $ = load(html);
  const found = new Map();
  $("a[href]").each((_, element) => {
    try {
      const url = safeURL(new URL($(element).attr("href"), pageUrl).href, hosts).href;
      if (match && !new RegExp(match).test(url)) return;
      const title = normalise($(element).text()).slice(0, 200);
      // The same article is often linked twice (image, then headline); keep the link with the most text.
      if (!found.has(url) || title.length > found.get(url).title.length) found.set(url, { url, title, summary: "" });
    } catch { /* Off-site, relative junk or javascript: links. */ }
  });
  return [...found.values()].slice(0, limit);
}
export function discoverHTML(html, pageUrl, hosts, match, limit = 10) { return discoverHTMLItems(html, pageUrl, hosts, match, limit).map((item) => item.url); }

/**
 * Split article text into sentences for citation by number. Deliberately simple: a boundary is terminal
 * punctuation (optionally followed by closing quotes or brackets) then whitespace then a capital, digit or
 * opening quote. Imperfect splits are harmless — a cited "sentence" is still verbatim source text.
 */
export function splitSentences(text, max = 400) {
  return String(text)
    .split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)
    // Chinese and Japanese end sentences with 。！？ and no following space.
    .flatMap((part) => part.split(/(?<=[。！？][」』”’）]*)/))
    // A very long "sentence" usually means blocks ran together with no space after the full stop.
    .flatMap((part) => part.length > 500 ? part.split(/(?<=[a-z0-9)][.!?]["'”’]?)(?=["“‘]?[A-Z])/) : [part])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Pages that give non-subscribers only a teaser. Summarising the teaser would produce a thin post about
 * the paywall rather than the article, so such pages are refused.
 */
const PAYWALL = /subscribe (now )?to (read|continue)|to continue reading|already a (subscriber|member)\?|this (article|content|story) is (only )?(available|reserved|exclusive) (to|for) (subscribers|members)|register (now |free )?to (read|continue)|sign in to (read|continue reading)|unlock (this|the full) article|subscriber-only|for subscribers only/i;
const MIN_ARTICLE_CHARS = 800;
const PAYWALL_TEASER_CHARS = 3000;

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
  $("script,style,nav,footer,header,noscript,form,aside,figure,figcaption,button,svg,[aria-hidden='true']").remove();
  const main = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  // Prefer the article's paragraphs: that drops share buttons, "Listen (5 mins)", photo credits and
  // "Recommended stories" lists. Fall back to all text for pages that do not use <p>.
  const paragraphs = main.find("p").map((_, p) => normalise($(p).text())).get().filter((p) => p.length >= 40);
  // Without this, cheerio runs adjacent blocks together ("…the world.“If managed…"), and the sentence
  // splitter, which needs a space after a full stop, sees one giant sentence.
  main.find("p,h1,h2,h3,h4,h5,h6,li,blockquote,div,section,br,tr,td").after(" ");
  const full = paragraphs.join(" ").length >= MIN_ARTICLE_CHARS ? paragraphs.join(" ") : normalise(main.text());
  // A long page that merely mentions subscribing (an upsell box after the article) is not a teaser; a paywall
  // leaves only a few paragraphs.
  if (PAYWALL.test(full) && full.length < PAYWALL_TEASER_CHARS) throw new Error("Paywalled: only a teaser is readable");
  const text = full.slice(0, maxChars);
  // Short pages are usually video, gallery or live-blog stubs with little to summarise.
  if (text.length < MIN_ARTICLE_CHARS || !title) throw new Error("Not enough accessible source material");
  return { url: response.url, publisher, title: title.slice(0,200), articleDate, accessedAt: response.accessedAt, text, hash: digest(text) };
}
