import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExcerpt, validBlocks } from "../../scripts/content/editorial.mjs";
import { discoverXMLItems, feedBlocks, pageExcerpt } from "../../scripts/content/sources.mjs";
import { draftCandidates, validateSources } from "../../scripts/content/engine.mjs";

const day = (offset = 0) => new Date(Date.now() - offset * 86_400_000);
const rss = (items) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>T</title>${items.join("")}</channel></rss>`;
const item = ({ slug, title, description, body, categories = [], date = day(1), author = "Ada Writer" }) => `<item><title>${title}</title>
  <link>https://www.technologyreview.com/2026/09/23/1/${slug}/</link><pubDate>${date.toUTCString()}</pubDate>
  <dc:creator><![CDATA[${author}]]></dc:creator>${categories.map((c) => `<category><![CDATA[${c}]]></category>`).join("")}
  <description><![CDATA[${description}]]></description>${body ? `<content:encoded><![CDATA[${body}]]></content:encoded>` : ""}</item>`;
const long = (words) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
const opening = "Delia Ramirez, a Democratic US representative from Illinois, has announced a plan to introduce new legislation to end the tower programme.";
const articleBody = `<p>${opening}</p><figure><img src="https://x/y.jpg"/><figcaption>Photo credit</figcaption></figure>
  <h2>What happens next</h2><p>${long(120)}.</p><blockquote><p>A quoted line from the hearing.</p></blockquote>
  <ul><li>First point</li><li>Second <b>point</b></li></ul><script>alert(1)</script><iframe src="https://evil.test"></iframe>
  <p>${long(90)}.</p><p>The post A headline appeared first on MIT Technology Review.</p>`;

test("a feed's article becomes plain text blocks: headings, paragraphs, lists and quotes, no markup, no media", () => {
  const blocks = feedBlocks(articleBody);
  assert.deepEqual(blocks.map((b) => b.t), ["p", "h", "p", "q", "ul", "p"]);
  assert.equal(blocks[0].text, opening);
  assert.deepEqual(blocks[4].items, ["First point", "Second point"]);
  assert.equal(blocks[3].text, "A quoted line from the hearing.", "a paragraph inside a quote is taken once, as the quote");
  const all = JSON.stringify(blocks);
  for (const gone of ["<", "alert", "evil.test", "Photo credit", "appeared first on"]) assert.ok(!all.includes(gone), gone);
  assert.ok(validBlocks(blocks));
  const table = feedBlocks("<table><tr><th>Company</th><th>Shift</th></tr><tr><td>Fujifilm</td><td>Film collapsed</td></tr></table>");
  assert.deepEqual(table, [{ t: "table", rows: [["Company", "Shift"], ["Fujifilm", "Film collapsed"]] }]);
});

test("feed items carry the publisher's summary, categories, date and author; bodies only when asked for", () => {
  const xml = rss([item({ slug: "a", title: "Towers &amp; borders", description: "A summary.", body: articleBody, categories: ["Policy", "Tech Policy"] })]);
  const [plain] = discoverXMLItems(xml, ["www.technologyreview.com"]);
  assert.equal(plain.title, "Towers & borders");
  assert.deepEqual(plain.categories, ["Policy", "Tech Policy"]);
  assert.equal(plain.author, "Ada Writer");
  assert.ok(plain.published && plain.description === "A summary.");
  assert.equal(plain.body, undefined);
  assert.ok(discoverXMLItems(xml, ["www.technologyreview.com"], 10, { bodies: true })[0].body.includes(opening));
  const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: 30 }, (_, i) => `<url><loc>https://openstax.org/books/biology-2e/pages/1-${i + 1}-s</loc></url>`).join("")}</urlset>`;
  assert.equal(discoverXMLItems(sitemap, ["openstax.org"], 10).length, 30, "a sitemap is not cut to a feed's length");
});

test("a textbook page gives its heading and first real paragraph, not its learning objectives", () => {
  const page = { text: `<html><head><title>6.3 The Laws of Thermodynamics - Biology 2e | OpenStax</title></head><body><main>
    <h1>6.3 The Laws of Thermodynamics</h1><section><h3>Learning Objectives</h3><p>By the end of this section, you will be able to do the following:</p>
    <ul><li>Discuss the concept of entropy</li></ul></section><p>Thermodynamics refers to the study of energy and energy transfer involving physical matter. The matter and its environment relevant to a particular case are a system.</p>
    <p>Second paragraph.</p></main></body></html>` };
  const { title, paragraph } = pageExcerpt(page);
  assert.equal(title, "The Laws of Thermodynamics");
  assert.match(paragraph, /^Thermodynamics refers to the study of energy/);
});

const techReview = {
  publisher: "MIT Technology Review", hosts: ["www.technologyreview.com"], feeds: ["https://www.technologyreview.com/feed/"],
  mode: "excerpt", keepBody: true, field: "tech-industry", perRun: 2,
  fieldRules: [{ category: "Policy", field: "public-policy" }, { category: "Artificial intelligence", field: "artificial-intelligence" }],
};

test("excerpt sources never reach a model: the publisher's own words, filed by rules, with the saved article", async () => {
  const xml = rss([
    item({ slug: "towers", title: "Towers", description: `Teaser ${long(20)}…`, body: articleBody, categories: ["Policy", "Tech Policy"] }),
    item({ slug: "hype", title: "Hype", description: `Brace yourself: ${long(30)}.`, categories: ["Artificial intelligence", "App", "Opinion"] }),
    item({ slug: "third", title: "Third", description: `A third item ${long(30)}.` }),
  ]);
  const saved = []; const triaged = [];
  const metrics = await draftCandidates({
    groups: [techReview], retrieve: async () => ({ text: xml }), save: async (c) => saved.push(c),
    generate: async () => { throw new Error("an excerpt source must never call a model"); },
    triage: async (entries) => { triaged.push(...entries); return new Map(); },
  });
  assert.equal(triaged.length, 0, "not even the headlines are sent for triage");
  assert.equal(metrics.excerpts, 2, "perRun caps each run");
  const [towers, hype] = saved.map((c) => c.payload);
  assert.equal(towers.kind, "excerpt");
  assert.deepEqual(towers.explanation, [opening], "the opening paragraph of the saved article, not the feed's cut-off teaser");
  assert.equal(towers.insight, null); assert.equal(towers.deeper, null);
  assert.deepEqual([towers.umbrella, towers.field, towers.subtopic], ["politics-society", "public-policy", "Tech Policy"]);
  assert.equal(towers.contentType, "news");
  assert.equal(towers.sources[0].author, "Ada Writer");
  assert.ok(towers.body.length >= 4 && validBlocks(towers.body));
  assert.equal(hype.field, "artificial-intelligence");
  assert.equal(hype.subtopic, "Artificial intelligence", "only generic categories left, so the field's own name");
  assert.match(hype.explanation[0], /^Brace yourself:/);
  assert.equal(hype.body, undefined, "no body in the feed, none saved");
  for (const c of saved) {
    assert.equal(c.status, "checked"); assert.equal(c.checks.mode, "excerpt"); assert.deepEqual(checkExcerpt(c.payload), []);
    assert.match(c.id, /^idea-[a-f0-9]{32}$/);
  }
});

test("a textbook excerpt comes from the page, in book order, one per run, with its licence", async () => {
  const group = { publisher: "OpenStax Biology 2e", hosts: ["openstax.org"], feeds: ["https://openstax.org/rex/sitemaps/biology-2e.xml"],
    match: "^https://openstax\\.org/books/biology-2e/pages/\\d+-\\d+-[a-z0-9-]+$", mode: "excerpt", contentType: "evergreen", perRun: 1,
    licence: "CC BY-NC-SA 4.0", field: "genetics-molecular-biology", fieldRules: [{ url: "/pages/(18|19|20)-\\d", field: "evolution-palaeontology" }] };
  const sitemap = `<?xml version="1.0"?><urlset>${["1-introduction", "18-1-understanding-evolution", "18-2-formation-of-new-species"].map((p) => `<url><loc>https://openstax.org/books/biology-2e/pages/${p}</loc></url>`).join("")}</urlset>`;
  const page = `<html><body><main><h1>18.1 Understanding Evolution</h1><p>Evolution by natural selection describes a mechanism for how species change over time, and it is the unifying theory of biology.</p></main></body></html>`;
  const saved = [];
  await draftCandidates({ groups: [group], save: async (c) => saved.push(c), generate: async () => { throw new Error("no model"); },
    retrieve: async (url) => ({ url, text: url.endsWith(".xml") ? sitemap : page }) });
  assert.equal(saved.length, 1);
  const post = saved[0].payload;
  assert.deepEqual([post.title, post.field, post.subtopic, post.contentType], ["Understanding Evolution", "evolution-palaeontology", "Understanding Evolution", "evergreen"]);
  assert.equal(post.sources[0].url, "https://openstax.org/books/biology-2e/pages/18-1-understanding-evolution");
  assert.equal(post.sources[0].licence, "CC BY-NC-SA 4.0");
});

test("a newsletter excerpt uses its own one-line description, not the sponsor's opening, and loses the emoji", async () => {
  const group = { publisher: "CFO Secrets", hosts: ["www.cfosecrets.io"], feeds: ["https://www.cfosecrets.io/sitemap.xml"],
    match: "^https://www\\.cfosecrets\\.io/p/[a-z0-9-]+$", mode: "excerpt", excerptFrom: "description", contentType: "evergreen", perRun: 1,
    field: "corporate-finance", subtopic: "CFO playbooks",
    fieldRules: [{ url: "/p/[a-z0-9-]*(board|ceo|leadership)", field: "management-leadership", subtopic: "Leading as CFO" }] };
  const sitemap = `<?xml version="1.0"?><urlset>${["https://www.cfosecrets.io/archive", "https://www.cfosecrets.io/p/when-your-ceo-ignores-the-numbers", "https://www.cfosecrets.io/p/the-3am-cash-flow-stare"]
    .map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
  const page = `<html><head><meta property="og:title" content="📬  When your CEO ignores the numbers"><meta property="og:description" content="And what to do when your CEO calls your numbers ‘fake’">
    <meta property="article:published_time" content="2026-08-25T12:45:00.000Z"></head><body><h1>📬 When your CEO ignores the numbers</h1>
    <p>POV: Your latest AI bill landed on your desk and it is three times bigger than last month, and our sponsor has a five-slide deck that will help you explain it.</p></body></html>`;
  const saved = [];
  await draftCandidates({ groups: [group], save: async (c) => saved.push(c), generate: async () => { throw new Error("no model"); },
    retrieve: async (url) => ({ url, text: url.endsWith(".xml") ? sitemap : page }) });
  assert.equal(saved.length, 1);
  const post = saved[0].payload;
  assert.equal(post.title, "When your CEO ignores the numbers");
  assert.deepEqual(post.explanation, ["And what to do when your CEO calls your numbers ‘fake’"]);
  assert.deepEqual([post.field, post.subtopic, post.contentType, post.articleDate], ["management-leadership", "Leading as CFO", "evergreen", "2026-08-25T12:45:00.000Z"]);
  assert.throws(() => validateSources([{ ...group, excerptFrom: "summary" }]), /excerptFrom/);
});

test("a gated page whose feed carries the article is drafted from the feed's copy, which is saved but never reviewed", async () => {
  const group = { publisher: "MIT Sloan Management Review", hosts: ["sloanreview.mit.edu"], feeds: ["https://sloanreview.mit.edu/feed/"], keepBody: true };
  const body = `<p>${"Design thinking gives users what they want, but what users want is not always good for them. ".repeat(12)}</p><p>${"Firms should add a responsibility review to every stage. ".repeat(10)}</p>`;
  const xml = rss([`<item><title>Design thinking needs a reboot</title><link>https://sloanreview.mit.edu/article/reboot/</link><pubDate>${day(2).toUTCString()}</pubDate><description>Teaser</description><content:encoded><![CDATA[${body}]]></content:encoded></item>`]);
  const calls = []; const saved = [];
  await draftCandidates({ groups: [group], save: async (c) => saved.push(c), checks: "off",
    retrieve: async (url) => { if (url.endsWith("/feed/")) return { url, text: xml }; throw new Error("Paywalled: only a teaser is readable"); },
    generate: async (args) => { calls.push(args); return { field: "strategy-innovation", subtopic: "Design Thinking", title: "Design thinking needs a responsibility check",
      explanation: ["Giving users what they want can harm them."], insight: "Add a responsibility review.", deeper: "Firms should review each stage.",
      contentType: "evergreen", difficulty: 2, conceptIds: ["design-thinking"], eventDate: null, articleDate: null, claims: [] }; } });
  assert.equal(calls.length, 1, "checks off: one drafting call, no review");
  assert.match(calls[0].input.source.sentences[0], /^\[1\] Design thinking gives users what they want/);
  assert.equal(saved[0].payload.body.length, 2);
  assert.equal(saved[0].status, "checked", JSON.stringify(saved[0].checks.errors));
});

test("the reviewer sees the post without the saved article riding along", async () => {
  const group = { publisher: "MIT Sloan Management Review", hosts: ["sloanreview.mit.edu"], feeds: ["https://sloanreview.mit.edu/feed/"], keepBody: true };
  const text = "Energy is neither created nor destroyed in a closed system. ".repeat(20);
  const body = `<p>${text}</p>`;
  const xml = rss([`<item><title>Energy</title><link>https://sloanreview.mit.edu/article/energy/</link><content:encoded><![CDATA[${body}]]></content:encoded></item>`]);
  const inputs = [];
  await draftCandidates({ groups: [group], save: async () => {},
    retrieve: async (url) => (url.endsWith("/feed/") ? { url, text: xml } : { url, accessedAt: new Date().toISOString(), text: `<html><title>Energy</title><article>${text}</article></html>` }),
    generate: async (args) => { inputs.push(args.input); return args.schema.properties.supported
      ? { supported: true, complete: true, misleading: false, problems: "", claims: [{ index: 0, supported: true, reason: "Stated" }] }
      : { field: "fundamental-physics", subtopic: "Energy", title: "Energy is conserved", explanation: ["Energy is conserved."], insight: "Conserved.", deeper: "Closed systems.",
        contentType: "evergreen", difficulty: 2, conceptIds: ["energy"], eventDate: null, articleDate: null, claims: [{ claim: "Energy is conserved", sentences: [1] }] }; } });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].draft.body, undefined);
});

test("excerpt sources are checked strictly: a known field, sensible rules, and no AI-only settings on AI sources", () => {
  assert.throws(() => validateSources([{ ...techReview, field: "astrology" }]), /need a "field"/);
  assert.throws(() => validateSources([{ ...techReview, fieldRules: [{ category: "Space", url: "/x", field: "astronomy-cosmology" }] }]), /fieldRules/);
  assert.throws(() => validateSources([{ publisher: "P", hosts: ["p.example"], feeds: ["https://p.example/feed"], field: "ethics" }]), /excerpt sources only/);
  assert.throws(() => validateSources([{ ...techReview, perRun: 50 }]), /perRun/);
  assert.equal(validateSources([techReview]).length, 1);
  const post = { kind: "excerpt", topic: "T", subtopic: "S", title: "T", explanation: ["Words."], insight: null, deeper: null, contentType: "news",
    difficulty: 1, conceptIds: ["subject"], articleDate: day(30).toISOString(), sources: [{ url: "https://p.example/a", publisher: "P", title: "T", accessedAt: day(0).toISOString() }] };
  assert.ok(checkExcerpt(post).includes("News needs a recent article date"));
  assert.ok(checkExcerpt({ ...post, contentType: "evergreen", body: [{ t: "p", text: "x", html: "<b>" }] }).includes("Invalid saved article"));
  assert.deepEqual(checkExcerpt({ ...post, contentType: "evergreen" }), []);
});
