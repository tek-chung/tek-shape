import { test } from "node:test";
import assert from "node:assert/strict";
import { ANY_HOST, decode, discoverHTML, extractArticle, safeURL, splitSentences } from "../../scripts/content/sources.mjs";
import { excerptFound } from "../../scripts/content/editorial.mjs";
import { citedExcerpt, discover, failureReason, interleave, publisherOf, settleDraft, validateSources } from "../../scripts/content/engine.mjs";

const page = (body, title = "A title") => ({ url: "https://example.org/a", accessedAt: "2026-09-23T10:00:00.000Z", text: `<html><title>${title}</title><article>${body}</article></html>` });
const long = "Plenty of readable article text sits here for the reader. ".repeat(20);

test("a listing page yields only on-site links that match the article pattern", () => {
  const html = `<a href="/doc/1.html">One</a><a href="/doc/1.html">Dup</a><a href="https://hk.crntt.com/doc/2.html">Two</a>
    <a href="/about">About</a><a href="https://evil.test/doc/3.html">Off-site</a><a href="javascript:alert(1)">JS</a>`;
  assert.deepEqual(discoverHTML(html, "https://hk.crntt.com/", ["hk.crntt.com"], "/doc/"),
    ["https://hk.crntt.com/doc/1.html", "https://hk.crntt.com/doc/2.html"]);
});

test("any-host links still need HTTPS, no credentials and no IP literals", () => {
  assert.equal(safeURL("https://blog.example/post", ANY_HOST).hostname, "blog.example");
  for (const bad of ["http://blog.example/", "https://user:pw@blog.example/", "https://10.0.0.1/", "https://blog.example:8443/"])
    assert.throws(() => safeURL(bad, ANY_HOST));
});

test("discover filters by match and skip; open hosts allow any linked site", async () => {
  const rss = (links) => ({ text: `<rss><channel>${links.map((l) => `<item><link>${l}</link></item>`).join("")}</channel></rss>` });
  const aj = { publisher: "Al Jazeera", hosts: ["www.aljazeera.com"], feeds: ["https://www.aljazeera.com/rss"], skip: "/video/|/liveblog/" };
  const found = await discover(aj, async () => rss(["https://www.aljazeera.com/news/a", "https://www.aljazeera.com/video/b", "https://www.aljazeera.com/liveblog/c"]), () => {});
  assert.deepEqual(found.urls, ["https://www.aljazeera.com/news/a"]);
  const hn = { publisher: "Hacker News", hosts: ["news.ycombinator.com"], feeds: ["https://news.ycombinator.com/rss"], openHosts: true };
  const linked = await discover(hn, async () => rss(["https://blog.example/post", "http://insecure.example/"]), () => {});
  assert.deepEqual(linked.urls, ["https://blog.example/post"]);
  assert.equal(publisherOf(hn, "https://www.blog.example/post"), "blog.example (via Hacker News)");
  assert.equal(publisherOf(aj, "https://www.aljazeera.com/news/a"), "Al Jazeera");
  let failures = 0;
  await discover(aj, async () => { throw new Error("down"); }, () => failures++);
  assert.equal(failures, 1);
});

test("round-robin takes one article from each publisher in turn", () => {
  const order = interleave([{ group: { publisher: "A" }, urls: ["a1", "a2", "a3"], linkHosts: [] }, { group: { publisher: "B" }, urls: ["b1"], linkHosts: [] }]);
  assert.deepEqual(order.map((item) => item.url), ["a1", "b1", "a2", "a3"]);
});

test("paywall teasers and short stubs are refused; a full article is kept", () => {
  assert.throws(() => extractArticle(page(`${long} Subscribe to read the full story.`), "FT"), /Paywalled/);
  assert.throws(() => extractArticle(page("Too short."), "X"), /Not enough/);
  assert.ok(extractArticle(page(long), "X").text.length >= 800);
});

test("pages decode in their declared character set", () => {
  const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // 中文 in Big5
  assert.equal(decode(big5, { "content-type": "text/html; charset=big5" }), "中文");
  assert.equal(decode(Buffer.from("中文"), {}), "中文");
  assert.equal(decode(Buffer.from("plain"), { "content-type": "text/html; charset=nonsense" }), "plain");
});

test("Chinese text splits at 。！？ and cited sentences rejoin without spaces", () => {
  const sentences = splitSentences("香港今日天氣晴朗。市民外出活動！政府發布新措施？");
  assert.deepEqual(sentences, ["香港今日天氣晴朗。", "市民外出活動！", "政府發布新措施？"]);
  assert.equal(citedExcerpt(sentences, [1, 2]), "香港今日天氣晴朗。市民外出活動！");
  assert.equal(citedExcerpt(sentences, [1, 3]), "香港今日天氣晴朗。 … 政府發布新措施？");
});

test("a Chinese ellipsis quote needs substantial fragments", () => {
  const src = "香港特區政府今日宣布推出一系列新的經濟刺激措施。專家認為這些措施將有助於提振本地消費市場。";
  assert.equal(excerptFound(src, "香港特區政府今日宣布推出 … 專家認為這些措施將有助於"), true);
  assert.equal(excerptFound(src, "香港 … 市場"), false);
});

test("source configuration errors are named", () => {
  const ok = { publisher: "P", hosts: ["p.example"], feeds: ["https://p.example/rss"] };
  assert.doesNotThrow(() => validateSources([ok]));
  assert.throws(() => validateSources([]), /1–30/);
  assert.throws(() => validateSources([{ ...ok, hosts: ["*"] }]), /openHosts/);
  assert.throws(() => validateSources([{ ...ok, feeds: [], pages: ["https://p.example/"] }]), /match/);
  assert.throws(() => validateSources([{ ...ok, feeds: [] }]), /at least one/);
  assert.throws(() => validateSources([{ ...ok, openHosts: "yes" }]), /openHosts/);
  assert.throws(() => validateSources([{ ...ok, feeds: ["https://other.example/rss"] }]), /approved/);
  assert.throws(() => validateSources([{ ...ok, match: "(" }]));
});

test("Gemini lists its text models as bare IDs, so `models` can confirm the chosen one", async () => {
  const { gemini } = await import("../../scripts/content/providers/gemini.mjs");
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, key: init.headers["x-goog-api-key"] });
    return new Response(JSON.stringify({ models: [
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-flash-lite-latest", supportedGenerationMethods: ["generateContent", "countTokens"] },
    ] }), { status: 200, headers: { "content-type": "application/json" } }); };
  assert.deepEqual(await gemini.listModels({ key: "k", fetchImpl }), ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"]);
  assert.equal(seen[0].key, "k");
  assert.ok(!seen[0].url.includes("key="), "the key travels in a header, never the URL");
});

test("feed failures give a reason that is safe for public logs", async () => {
  assert.equal(failureReason(new Error("Source returned HTTP 403")), "Source returned HTTP 403");
  assert.equal(failureReason(Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" })), "network error ENOTFOUND");
  assert.equal(failureReason(new Error("Unexpected token near <secret article text>")), "could not read the feed");
  const reasons = [];
  await discover({ publisher: "P", hosts: ["p.example"], feeds: ["https://p.example/rss"] }, async () => { throw new Error("Source returned HTTP 403"); }, (why) => reasons.push(why));
  assert.deepEqual(reasons, ["Source returned HTTP 403"]);
});

test("the event date is kept when valid and past, trimmed of a time, and dropped otherwise", () => {
  const source = { url: "https://p.example/a", publisher: "P", title: "T", articleDate: null, accessedAt: "2026-09-23T10:00:00.000Z", text: "One. Two.", hash: "h" };
  const settle = (eventDate) => settleDraft({ eventDate, claims: [], conceptIds: [] }, source).eventDate;
  assert.equal(settle("2026-09-01"), "2026-09-01");
  assert.equal(settle("2026-09-01T14:00:00Z"), "2026-09-01");
  assert.equal(settle("2999-01-01"), null);
  assert.equal(settle("September 2026"), null);
  assert.equal(settle(null), null);
});

test("article text comes from paragraphs, with blocks spaced so sentences split", async () => {
  const { relevantConcepts } = await import("../../scripts/content/engine.mjs");
  const body = `<div>ListenListen (5 mins)</div><button>Share</button><figure><figcaption>Photo credit</figcaption></figure>
    <p>The heads of several major AI firms told the United Nations Security Council their industry needed global oversight.</p><p>“If managed poorly, AI could be a risk to humanity as a whole,” the chief executive said on Wednesday.</p>
    <ul><li>Recommended: another story entirely</li></ul>${"<p>Further paragraphs of the article explain the context of the meeting in some detail here.</p>".repeat(10)}`;
  const article = extractArticle(page(body, "AI chiefs at the UN"), "Al Jazeera");
  assert.ok(!/Listen|Share|Photo credit|Recommended/.test(article.text));
  const sentences = splitSentences(article.text);
  assert.ok(sentences.every((s) => s.length < 300), "no run-together giant sentence");
  assert.equal(sentences[1], "“If managed poorly, AI could be a risk to humanity as a whole,” the chief executive said on Wednesday.");
  // Run-together blocks with no space still split.
  assert.deepEqual(splitSentences(`${"a".repeat(480)} whole world.“If managed poorly,” he said.Then more.`).length, 3);
  // Concept tags unrelated to the article are dropped; related ones stay.
  assert.deepEqual(relevantConcepts(["ai-regulation", "quantum-decoherence", "gaba-receptors", "global-oversight", "global-state"], article), ["ai-regulation", "global-oversight"]);
});

test("citation markers are stripped from the post text", () => {
  const source = { url: "https://p.example/a", publisher: "P", title: "T", articleDate: null, accessedAt: "2026-09-23T10:00:00.000Z", text: "One. Two.", hash: "h" };
  const d = settleDraft({ title: "Title [1]", insight: "Leaders argue [1, 8].", explanation: ["They said so [1]. Then [2-3] more."], claims: [], conceptIds: [] }, source);
  assert.equal(d.title, "Title"); assert.equal(d.insight, "Leaders argue."); assert.equal(d.explanation[0], "They said so. Then more.");
});

test("unusable concept tags fall back to the subtopic and topic instead of holding the post", () => {
  const source = { url: "https://p.example/a", publisher: "P", title: "Croatia signs", articleDate: null, accessedAt: "2026-09-23T10:00:00.000Z", text: "Croatia signed the accords.", hash: "h" };
  const d = settleDraft({ topic: "Space", subtopic: "Artemis Accords", conceptIds: ["量子", "gaba-receptors"], claims: [] }, source);
  assert.deepEqual(d.conceptIds, ["artemis-accords", "space"]);
});

test("with checks off, a draft whose quotes are wrong is still accepted, and no review call is made", async () => {
  const { draftCandidates } = await import("../../scripts/content/engine.mjs");
  const body = "<p>Croatia became the newest country to sign the Artemis Accords during a ceremony in Zagreb this week.</p>".repeat(10);
  const calls = []; const saved = [];
  const draft = { topic: "Space", subtopic: "Artemis Accords", title: "Croatia signs", explanation: ["Croatia signed."], insight: "More signatories.", deeper: "Details.",
    contentType: "evergreen", difficulty: 2, conceptIds: ["artemis-accords"], eventDate: null, articleDate: null, sources: [], claims: [{ claim: "c", sentences: [999] }] };
  await draftCandidates({ checks: "off", groups: [{ publisher: "P", hosts: ["p.example"], articles: ["https://p.example/a"] }],
    retrieve: async () => page(body, "Croatia signs"), generate: async (args) => { calls.push(args); return structuredClone(draft); }, save: async (c) => saved.push(c) });
  assert.equal(calls.length, 1);
  assert.equal(saved[0].status, "checked", JSON.stringify(saved[0].checks.errors));
  assert.equal(saved[0].checks.mode, "off");
});

test("a redirect may move between hosts of the same site, never to another site", async () => {
  // safeURL is the gate; same-site hosts are added only for the redirect target.
  assert.throws(() => safeURL("https://feeds.nature.com/x", ["www.nature.com"]), /feeds\.nature\.com/);
});

test("a redirect to plain HTTP is followed over HTTPS instead, and a site that insists on HTTP is named", async () => {
  const { nextHop } = await import("../../scripts/content/sources.mjs");
  assert.equal(nextHop("http://www.scmp.com/rss/2/feed/", "https://www.scmp.com/rss/2/feed"), "https://www.scmp.com/rss/2/feed/");
  assert.equal(nextHop("/news/a", "https://www.scmp.com/rss/2/feed"), "https://www.scmp.com/news/a");
  assert.throws(() => nextHop("http://www.scmp.com/rss/2/feed", "https://www.scmp.com/rss/2/feed"), /plain HTTP only/);
});

test("RSS 1.0 (RDF) feeds, as Nature publishes, list their items", async () => {
  const { discoverXML } = await import("../../scripts/content/sources.mjs");
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
    <channel rdf:about="http://feeds.nature.com/nature/rss/current"><link>http://feeds.nature.com/nature/rss/current</link></channel>
    <item rdf:about="https://www.nature.com/articles/d41586-026-02986-4"><link>https://www.nature.com/articles/d41586-026-02986-4</link></item>
    <item rdf:about="https://www.nature.com/articles/s41586-026-1"><link>https://www.nature.com/articles/s41586-026-1</link></item>
  </rdf:RDF>`;
  assert.deepEqual(discoverXML(rdf, ["www.nature.com"]), ["https://www.nature.com/articles/d41586-026-02986-4", "https://www.nature.com/articles/s41586-026-1"]);
});

test("a full article with an upsell box is kept; a short teaser behind a paywall is not", () => {
  const body = "Managers who explain their reasoning earn more trust from their teams, the study found. ".repeat(45);
  assert.ok(extractArticle(page(`${body} Already a subscriber? Sign in.`), "MIT SMR").text.length > 3000);
  assert.throws(() => extractArticle(page(`${"A short opening paragraph for the story. ".repeat(25)} Subscribe to read the rest.`), "X"), /Paywalled/);
});

test("MIT SMR link pattern keeps articles and drops navigation", async () => {
  const { discoverHTML } = await import("../../scripts/content/sources.mjs");
  const groups = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../../content-sources.example.json", import.meta.url), "utf8"));
  const links = (hrefs) => hrefs.map((h) => `<a href="${h}">x</a>`).join("");
  const smr = groups.find((g) => g.publisher === "MIT Sloan Management Review");
  assert.deepEqual(discoverHTML(links(["/article/should-your-brand-take-a-stand/", "/topic/leadership/", "/video/x/"]), smr.pages[0], smr.hosts, smr.match),
    ["https://sloanreview.mit.edu/article/should-your-brand-take-a-stand/"]);
});

test("each post is filed in the subject map: the field decides the umbrella and the card's topic", async () => {
  const { FIELD_IDS, placeOf } = await import("../../scripts/content/taxonomy.mjs");
  const { draftSchema, triageSchema, classifySchema } = await import("../../scripts/content/model.mjs");
  const { DRAFT_INSTRUCTION } = await import("../../scripts/content/engine.mjs");
  assert.equal(new Set(FIELD_IDS).size, FIELD_IDS.length, "field IDs are unique across umbrellas");
  // Gemini rejects the draft schema (HTTP 400) once it carries the full field list, so the list lives in the
  // instruction; the small triage and classify schemas keep the enum.
  const enums = (schema) => JSON.stringify(schema).match(/"enum":\[[^\]]*\]/g) ?? [];
  assert.ok(enums(draftSchema).every((e) => e.split(",").length <= 5), "no long enum in the draft schema");
  for (const id of FIELD_IDS) assert.ok(DRAFT_INSTRUCTION.includes(id), `the draft instruction lists ${id}`);
  assert.deepEqual(triageSchema.properties.items.items.properties.field.enum, FIELD_IDS);
  assert.deepEqual(classifySchema.properties.field.enum, FIELD_IDS);
  assert.equal(placeOf("china-hong-kong").umbrella, "politics-society");
  const source = { url: "https://p.example/a", publisher: "P", title: "T", articleDate: null, accessedAt: "2026-09-23T10:00:00.000Z", text: "Primes are numbers. They matter.", hash: "h" };
  const filed = settleDraft({ field: "algebra-number-theory", subtopic: "  Prime gaps. ", topic: "Maths stuff", claims: [], conceptIds: [] }, source);
  assert.deepEqual([filed.umbrella, filed.field, filed.topic, filed.subtopic], ["mathematics", "algebra-number-theory", "Mathematics", "Prime gaps"]);
  const unknown = settleDraft({ field: "astrology", subtopic: "", topic: "Science", claims: [], conceptIds: [] }, source);
  assert.deepEqual([unknown.umbrella, unknown.field, unknown.topic, unknown.subtopic], ["other", "general", "Science", "General"]);
  // Checked in code now, not by the schema: near misses fold; an unknown ID falls back to triage's pick.
  const folded = settleDraft({ field: " Algebra Number_Theory ", subtopic: "Primes", claims: [], conceptIds: [] }, source);
  assert.equal(folded.field, "algebra-number-theory");
  const rescued = settleDraft({ field: "astrology", subtopic: "Hong Kong Budget", claims: [], conceptIds: [] }, source, undefined, "china-hong-kong");
  assert.deepEqual([rescued.umbrella, rescued.field], ["politics-society", "china-hong-kong"]);
  const kept = settleDraft({ field: "quantum-physics", subtopic: "Qubits", claims: [], conceptIds: [] }, source, undefined, "china-hong-kong");
  assert.equal(kept.field, "quantum-physics", "a valid choice by the drafting model stands");
});
