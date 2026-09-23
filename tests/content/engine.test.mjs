import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, checkReview, excerptFound, recentConcepts, selectQueue, snapExcerpt, summarisePreferences } from "../../scripts/content/editorial.mjs";
import { safeURL, publicIPv4, discoverXML, extractArticle, splitSentences } from "../../scripts/content/sources.mjs";
import { citedExcerpt, draftCandidates, settleDraft, slugs } from "../../scripts/content/engine.mjs";
import { ModelChainError, generateJSON, liveModels, modelConfig } from "../../scripts/content/model.mjs";
const now = Date.parse("2026-09-23T10:00:00Z");
const text = "A test source describes the conservation of energy. ".repeat(12);
const response = {url:"https://example.org/article",accessedAt:new Date(now).toISOString(),text:`<html><title>Energy</title><article>${text}</article></html>`};
const source = extractArticle(response,"Example");
const {text:unusedText,hash:unusedHash,...citation} = source;
void unusedText; void unusedHash;
const draft = {topic:"Science",subtopic:"Physics",title:"Energy",explanation:["A test source describes the conservation of energy."],insight:"Energy",deeper:"A source explanation",contentType:"evergreen",difficulty:2,conceptIds:["energy-conservation"],eventDate:null,articleDate:null,sources:[citation],claims:[{claim:"Energy is conserved",url:source.url,excerpt:"conservation of energy"}]};
const review = {supported:true,complete:true,misleading:false,claims:[{index:0,supported:true,reason:"The source supports it"}]};
const post = (id,extra={}) => ({id,topic:"Science",subtopic:"Physics",difficulty:2,concept_ids:[id],status:"published",verification_status:"source_checked",content_type:"evergreen",...extra});
test("retrieved citations and exact excerpts pass, invented support fails", () => {
  assert.deepEqual(checkDraft(draft,[source],now),[]);
  assert.ok(checkDraft({...draft,claims:[{...draft.claims[0],excerpt:"invented quotation"}]},[source],now).length);
  assert.ok(checkDraft({...draft,sources:[{...citation,url:"https://fake.test"}]},[source],now).length);
  assert.ok(checkDraft({...draft,claims:[null],sources:[null]},[source],now).length);
});
test("an exact quote passes despite curly-versus-straight punctuation; different words still fail", () => {
  const curly = { ...source, text:"Researchers said it’s “remarkably stable” — far more than expected… in tests." };
  const quote = (excerpt) => checkDraft({ ...draft, claims:[{ claim:"c", url:source.url, excerpt }] }, [curly], now);
  assert.deepEqual(quote(`it's "remarkably stable" - far more than expected... in tests`), []);
  assert.deepEqual(quote("Researchers said"), []);
  assert.ok(quote("it's remarkably unstable").length);
  assert.ok(quote("far more than anyone expected").length);
});
test("an ellipsis may bridge a cut between verbatim fragments, but never stitch words together", () => {
  const src = "The telescope observed the galaxy for six months. Astronomers then confirmed the signal was real and repeatable.";
  assert.equal(excerptFound(src, "The telescope observed the galaxy … confirmed the signal was real"), true);
  assert.equal(excerptFound(src, "The telescope observed the galaxy ... confirmed the signal was real"), true);
  assert.equal(excerptFound(src, "confirmed the signal was real … The telescope observed the galaxy"), false); // out of order
  assert.equal(excerptFound(src, "The telescope … was real"), false); // fragments too short to be evidence
  assert.equal(excerptFound(src, "The telescope observed the galaxy … confirmed the signal was fake"), false);
  assert.equal(excerptFound(src, '"Astronomers then confirmed the signal"'), true); // wrapping quotes ignored
});
test("a near-miss quote snaps to the passage exactly as the source has it; a paraphrase does not", () => {
  const src = "Residents say Indonesia is building a new capital city, Nusantara, right next to Abidin’s home in the forest. Other news follows here.";
  // One word changed ("close to" for "right next to"): snapped to the real words.
  assert.equal(snapExcerpt(src, "Indonesia is building a new capital city, Nusantara, next to Abidin’s home in the forest."),
    "Indonesia is building a new capital city, Nusantara, right next to Abidin’s home in the forest.");
  // A loose paraphrase is not rescued.
  assert.equal(snapExcerpt(src, "The government plans a brand-new capital called Nusantara near a village."), null);
  // Already exact: nothing to do.
  assert.equal(snapExcerpt(src, "Other news follows here."), null);
  // Too short to be evidence.
  assert.equal(snapExcerpt(src, "building a capital city"), null);
});
test("the engine stamps the article date, and relabels undated or old news as evergreen", async () => {
  const run = async (articleDate, contentType) => {
    const saved = [];
    const dated = { ...response, text:response.text.replace("<html>", `<html><meta property="article:published_time" content="${articleDate}">`) };
    await draftCandidates({ groups:[{ publisher:"Example", hosts:["example.org"], feeds:[], articles:[source.url] }], retrieve:async()=>dated,
      generate:async(args)=>args.schema.properties.supported ? review : { ...structuredClone(draft), contentType, articleDate:"garbled" }, save:async(c)=>saved.push(c) });
    return saved[0];
  };
  const fresh = new Date(Date.now() - 86400000).toISOString();
  const recentNews = await run(fresh, "news");
  assert.equal(recentNews.status, "checked"); assert.equal(recentNews.payload.contentType, "news"); assert.equal(recentNews.payload.articleDate, fresh);
  const oldNews = await run("2020-01-01T00:00:00.000Z", "news");
  assert.equal(oldNews.status, "checked"); assert.equal(oldNews.payload.contentType, "evergreen");
});
test("articles split into sentences, keeping closing quotes and not breaking on lower-case continuations", () => {
  assert.deepEqual(splitSentences("It works. “Really?” she asked. The U.S. team agreed, e.g. twice. 2026 was a year."),
    ["It works.", "“Really?” she asked.", "The U.S. team agreed, e.g. twice.", "2026 was a year."]);
});
test("claims cite sentence numbers; the engine fills in the verbatim sentences and the draft passes", async () => {
  const article = { ...response, text:`<html><title>Energy</title><article>${"Energy is neither created nor destroyed in a closed system. ".repeat(6)}Engineers rely on this principle when designing engines. It explains why perpetual motion is impossible.</article></html>` };
  const prompts = []; const saved = [];
  const cited = { ...structuredClone(draft), claims:[{ claim:"Engineers rely on it", sentences:[7] }, { claim:"Perpetual motion is impossible", sentences:[7,8] }] };
  await draftCandidates({ groups:[{ publisher:"Example", hosts:["example.org"], feeds:[], articles:[source.url] }], retrieve:async()=>article,
    generate:async(args)=>{ prompts.push(args); return args.schema.properties.supported ? { ...review, claims:[review.claims[0], { ...review.claims[0], index:1 }] } : structuredClone(cited); },
    save:async(c)=>saved.push(c) });
  // The model saw numbered sentences, not the raw text.
  assert.equal(prompts[0].input.source.text, undefined);
  assert.equal(prompts[0].input.source.sentences[6], "[7] Engineers rely on this principle when designing engines.");
  assert.equal(saved[0].status, "checked", JSON.stringify(saved[0].checks.errors));
  assert.equal(saved[0].payload.claims[0].excerpt, "Engineers rely on this principle when designing engines.");
  assert.equal(saved[0].payload.claims[1].excerpt, "Engineers rely on this principle when designing engines. It explains why perpetual motion is impossible.");
  assert.equal(saved[0].payload.claims[0].sentences, undefined);
});
test("citing a sentence that does not exist leaves the claim without evidence, so the draft is held", () => {
  const sentences = ["One sentence here.", "Another sentence there."];
  assert.equal(citedExcerpt(sentences, [9]), "");
  assert.equal(citedExcerpt(sentences, ["2", 1.5, -1]), "");
  assert.equal(citedExcerpt(sentences, [2, 1, 2]), "One sentence here. Another sentence there.");
  const settled = settleDraft({ ...structuredClone(draft), claims:[{ claim:"c", sentences:[99] }] }, source);
  assert.ok(checkDraft(settled, [source], now).includes("Claim has no exact supporting source excerpt"));
});
test("concept tags are folded to slugs rather than failing the draft", () => {
  assert.deepEqual(slugs(["Quantum Mechanics", "quantum_mechanics", "Café Science!", "x", 7, "DNA Repair"]), ["quantum-mechanics", "cafe-science", "dna-repair"]);
});
test("the engine stamps the retrieved citation itself, so a model's copying errors cannot fail a draft", async () => {
  const saved = [];
  const sloppy = { ...structuredClone(draft), sources:[{ ...citation, title:"energy (reformatted)", accessedAt:"2026-01-01" }], claims:[{ ...draft.claims[0], url:"https://example.org/article/" }] };
  await draftCandidates({ groups:[{ publisher:"Example", hosts:["example.org"], feeds:[], articles:[source.url] }], retrieve:async()=>response,
    generate:async(args)=>args.schema.properties.supported ? review : structuredClone(sloppy), save:async(c)=>saved.push(c) });
  assert.equal(saved[0].status, "checked");
  assert.equal(saved[0].payload.sources[0].title, source.title);
  assert.equal(saved[0].payload.claims[0].url, source.url);
});
test("news dates must be present, supported and recent", () => {
  assert.ok(checkDraft({...draft,contentType:"news"},[source],now).length);
  assert.ok(checkDraft({...draft,contentType:"news",articleDate:"2020-01-01"},[source],now).length);
});
test("semantic review fails closed on omitted, negative or malformed verdicts", () => {
  assert.equal(checkReview(review,draft),true);
  for (const change of [{complete:false},{misleading:true},{claims:[]},{claims:[null]}]) assert.equal(checkReview({...review,...change},draft),false);
});
test("source boundaries reject IP, HTTP, credentials, offsite URLs and private DNS", () => {
  for (const url of ["http://example.org","https://user:secret@example.org","https://127.0.0.1","https://other.test","https://example.org:8443"])
    assert.throws(()=>safeURL(url,["example.org"]));
  for (const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","100.64.1.1","::1"]) assert.equal(publicIPv4(ip),false);
  assert.equal(publicIPv4("8.8.8.8"),true);
});
test("reserved ranges are blocked at their exact size, not a whole /16 around them", () => {
  // Public hosts that the old byte checks wrongly rejected: WordPress VIP (NASA), and neighbours of the test nets.
  for (const ip of ["192.0.66.2","192.0.78.9","198.51.1.1","203.0.1.1","172.32.0.1","100.128.0.1"]) assert.equal(publicIPv4(ip),true,ip);
  for (const ip of ["0.1.2.3","192.0.0.8","192.0.2.1","192.88.99.1","198.18.0.1","198.19.255.255","198.51.100.7","203.0.113.9",
    "224.0.0.1","239.255.255.255","240.0.0.1","255.255.255.255","172.31.255.255","100.127.255.255"]) assert.equal(publicIPv4(ip),false,ip);
});
test("RSS and Atom discovery filter foreign hosts and deduplicate", () => {
  assert.deepEqual(discoverXML("<rss><channel><item><link>https://example.org/a</link></item><item><link>https://evil.test/a</link></item><item><link>https://example.org/a</link></item></channel></rss>",["example.org"]),["https://example.org/a"]);
  assert.deepEqual(discoverXML('<feed><entry><link href="https://example.org/b" rel="alternate" /></entry></feed>',["example.org"]),["https://example.org/b"]);
});
test("extraction strips scripts and navigation and refuses tiny pages", () => {
  assert.ok(!extractArticle({...response,text:`<title>Title</title><nav>NOISE</nav><article>${text}<script>BAD</script></article>`},"Example").text.includes("BAD"));
  assert.throws(()=>extractArticle({...response,text:"<title>T</title><p>Short</p>"},"Example"));
});
test("queue keeps assigned posts, removes conceptual repeats and fills unread buffer", () => {
  const assigned=[post("known")];
  const selected=selectQueue({assigned,states:[],target:3,candidates:[post("duplicate",{concept_ids:["known"]}),post("new-a"),post("new-b"),post("new-c")]});
  assert.equal(selected.length,2); assert.ok(!selected.some(p=>p.id==="duplicate")); assert.equal(assigned[0].id,"known");
  assert.deepEqual(selectQueue({assigned,states:[],target:1,candidates:[post("new")]}),[]);
});
test("harder changes future depth; bookmarks do not affect rank", () => {
  const data={assigned:[post("old")],target:2,candidates:[post("advanced",{difficulty:3}),post("basic",{difficulty:1})]};
  assert.equal(selectQueue({...data,states:[{post_id:"old",rating:"harder"}]})[0].id,"advanced");
  assert.deepEqual(selectQueue({...data,states:[]}),selectQueue({...data,states:[{post_id:"old",bookmarked:true}]}));
});
test("diversity prefers a new topic and mixes news; stale news is withheld", () => {
  const selected=selectQueue({assigned:[post("old")],states:[],target:2,now,candidates:[post("a"),post("b",{topic:"History"}),post("stale",{content_type:"news",article_date:"2020-01-01",reviewed_at:new Date(now).toISOString()})]});
  assert.equal(selected[0].id,"b");
});
test("fixture pipeline retrieves, drafts, reviews and stores without publishing", async () => {
  const saved=[]; let calls=0;
  const metrics=await draftCandidates({groups:[{publisher:"Example",hosts:["example.org"],feeds:[],articles:[source.url]}],retrieve:async()=>response,
    generate:async()=>++calls===1 ? structuredClone(draft) : review,save:async c=>saved.push(c)});
  assert.equal(metrics.checked,1); assert.equal(saved[0].status,"checked"); assert.equal(calls,2);
});
test("bad evidence is held without spending a second model call", async () => {
  let calls=0; const saved=[];
  await draftCandidates({groups:[{publisher:"Example",hosts:["example.org"],feeds:[],articles:[source.url]}],retrieve:async()=>response,
    generate:async()=>{calls++;return {...draft,claims:[]};},save:async c=>saved.push(c)});
  assert.equal(calls,1); assert.equal(saved[0].status,"held");
});
// --- Provider chain -------------------------------------------------------------------------

// The fallback mechanics below pin their own two-provider chain, so they hold whatever the default is.
const env = {
  CONTENT_PROVIDERS:"groq,mistral",
  GROQ_API_KEY:"q-key", CONTENT_GROQ_MODEL:"qwen/qwen3.8-27b,qwen/qwen3-32b",
  MISTRAL_API_KEY:"m-key", CONTENT_MISTRAL_MODEL:"mistral-test",
};
const chatOK = (json, content = JSON.stringify(json)) => ({ ok:true, json:async()=>({ choices:[{ finish_reason:"stop", message:{ content } }], usage:{ prompt_tokens:10, completion_tokens:5 } }) });
const fail = (status, code = null, retryAfter = null) => ({ ok:false, status,
  headers:{ get:(name)=> name === "retry-after" && retryAfter !== null ? String(retryAfter) : null },
  json:async()=>({ error:{ message:"SECRET PROMPT TEXT", code } }) });
// A clock that jumps an hour per reading, so pacing never kicks in unless a test wants it to.
const farApart = () => { let t = 0; return () => (t += 3_600_000); };
const call = (fetchImpl, reserve = async () => {}, trace = [], config = modelConfig(env), sleep = async () => {}, now = farApart()) =>
  generateJSON({ config, reserve, trace, sleep, now, instruction:"test", input:{ a:1 }, schema:{ type:"object" }, fetchImpl });
const budgetRefusal = (provider = "groq") => () => { throw new Error(`Daily call limit reached for ${provider}`); };
const modelOf = (init) => JSON.parse(init.body).model;
const hostOf = (url) => new URL(url).hostname;

test("the default chain is Mistral first, OpenRouter second, and free by default", () => {
  const config = modelConfig({ MISTRAL_API_KEY:"m", CONTENT_MISTRAL_MODEL:"mistral-small-latest", OPENROUTER_API_KEY:"r", CONTENT_OPENROUTER_MODEL:"a:free,b:free" });
  assert.deepEqual(config.chain.map((p) => `${p.name}/${p.model}`), ["mistral/mistral-small-latest","openrouter/a:free","openrouter/b:free"]);
  assert.equal(config.dailyUsd, 0);
  assert.ok(config.chain.every((p) => p.inputPrice === 0 && p.outputPrice === 0));
});
test("per-model preference lists keep their order within each provider", () => {
  assert.deepEqual(modelConfig(env).chain.map((p) => `${p.name}/${p.model}`), ["groq/qwen/qwen3.8-27b","groq/qwen/qwen3-32b","mistral/mistral-test"]);
});
test("an unconfigured provider is skipped, and nothing configured fails closed", () => {
  const onlyMistral = modelConfig({ MISTRAL_API_KEY:"m", CONTENT_MISTRAL_MODEL:"x" });
  assert.deepEqual(onlyMistral.chain.map((p) => p.name), ["mistral"]);
  assert.match(onlyMistral.skipped[0], /OPENROUTER_API_KEY/);
  assert.throws(() => modelConfig({}), /Configure at least one/);
});
test("the chain is swappable by configuration alone", () => {
  const config = modelConfig({ ...env, CONTENT_PROVIDERS:"mistral,groq" });
  assert.equal(config.chain[0].name, "mistral");
  assert.throws(() => modelConfig({ ...env, CONTENT_PROVIDERS:"groq,nope" }), /Unknown content provider "nope"/);
  assert.throws(() => modelConfig({ ...env, CONTENT_PROVIDERS:"groq,groq" }), /twice/);
  assert.throws(() => modelConfig({ ...env, CONTENT_GROQ_MODEL:"a,a" }), /lists a model twice/);
});
test("a priced provider under a zero budget is refused up front", () => {
  assert.throws(() => modelConfig({ ...env, CONTENT_GROQ_INPUT_USD_PER_MILLION:"0.1" }), /CONTENT_DAILY_USD is 0/);
  assert.equal(modelConfig({ ...env, CONTENT_GROQ_INPUT_USD_PER_MILLION:"0.1", CONTENT_DAILY_USD:"1" }).dailyUsd, 1);
});
test("a retired model falls through to the next preferred model on the same provider", async () => {
  const tried = [];
  const json = await call(async (url, init) => {
    tried.push(modelOf(init));
    return modelOf(init) === "qwen/qwen3.8-27b" ? fail(404, "model_not_found") : chatOK({ answer:"second model" });
  });
  assert.deepEqual(json, { answer:"second model" });
  assert.deepEqual(tried, ["qwen/qwen3.8-27b","qwen/qwen3-32b"]);
});
test("a decommissioned model is skipped for the rest of the run without another call", async () => {
  const config = modelConfig(env); const tried = [];
  const fetchImpl = async (url, init) => { tried.push(modelOf(init)); return modelOf(init) === "qwen/qwen3.8-27b" ? fail(400, "model_decommissioned") : chatOK({ ok:true }); };
  await call(fetchImpl, undefined, [], config);
  await call(fetchImpl, undefined, [], config);
  assert.deepEqual(tried, ["qwen/qwen3.8-27b","qwen/qwen3-32b","qwen/qwen3-32b"]);
});
test("a model outside your subscription tier (403) is skipped for the rest of the run", async () => {
  const config = only("groq"); const tried = [];
  const fetchImpl = async (url, init) => { tried.push(modelOf(init)); return modelOf(init) === "qwen/qwen3.8-27b" ? fail(403, "1910") : chatOK({ ok:true }); };
  await call(fetchImpl, undefined, [], config);
  await call(fetchImpl, undefined, [], config);
  assert.deepEqual(tried, ["qwen/qwen3.8-27b","qwen/qwen3-32b","qwen/qwen3-32b"]);
});
test("Groq failure falls back to Mistral, and the trace records every attempt", async () => {
  const hosts = []; const trace = [];
  const json = await call(async (url) => { hosts.push(hostOf(url)); return url.includes("groq") ? fail(503) : chatOK({ answer:"from mistral" }); }, undefined, trace);
  assert.deepEqual(json, { answer:"from mistral" });
  assert.deepEqual(hosts, ["api.groq.com","api.groq.com","api.mistral.ai"]);
  assert.deepEqual(trace.map((t) => [t.provider, t.ok]), [["groq",false],["groq",false],["mistral",true]]);
});
test("a short retry-after is honoured once on the same model before falling back", async () => {
  const waits = []; let calls = 0;
  const json = await call(async () => (++calls === 1 ? fail(429, "rate_limit_exceeded", 7) : chatOK({ answer:"after waiting" })),
    undefined, [], modelConfig(env), async (seconds) => { waits.push(seconds); });
  assert.deepEqual(json, { answer:"after waiting" }); assert.deepEqual(waits, [7]); assert.equal(calls, 2);
});
test("a long retry-after, or a second 429, moves on rather than waiting", async () => {
  const waits = []; const tried = [];
  await call(async (url, init) => { tried.push(`${hostOf(url)}:${modelOf(init)}`); return url.includes("groq") ? fail(429, null, 3600) : chatOK({ ok:true }); },
    undefined, [], modelConfig(env), async (seconds) => { waits.push(seconds); });
  assert.deepEqual(waits, []); assert.equal(tried.at(-1), "api.mistral.ai:mistral-test");
  const again = []; let n = 0;
  await call(async (url) => { n++; return url.includes("groq") ? fail(429, null, 1) : chatOK({ ok:true }); },
    undefined, [], modelConfig(env), async (seconds) => { again.push(seconds); });
  assert.deepEqual(again, [1, 1]); assert.equal(n, 5); // each Groq model: one wait, one retry; then Mistral
});
test("a 429 with no retry-after still waits once, for the default, before moving on", async () => {
  const waits = []; let calls = 0;
  const json = await call(async () => (++calls === 1 ? fail(429) : chatOK({ answer:"after waiting" })),
    undefined, [], only("mistral"), async (seconds) => { waits.push(seconds); });
  assert.deepEqual(json, { answer:"after waiting" }); assert.deepEqual(waits, [60]);
});
test("calls to the same provider are spaced by its minimum interval", async () => {
  const config = only("mistral"); const waits = []; let t = 1000;
  const clock = () => t;
  const sleep = async (seconds) => { waits.push(seconds); t += seconds * 1000; };
  await call(async () => chatOK({ ok:1 }), undefined, [], config, sleep, clock);
  t += 500; // the next request arrives half a second later
  await call(async () => chatOK({ ok:2 }), undefined, [], config, sleep, clock);
  assert.deepEqual(waits, [2.5]);
});
test("when every provider is rate-limiting, the error says so, so the run can stop", async () => {
  const error = await call(async () => fail(429, null, 3600)).catch((caught) => caught);
  assert.equal(error.rateLimited, true); assert.equal(error.exhausted, false);
});
test("a model answering in a Markdown code fence is unwrapped, not rejected", async () => {
  assert.deepEqual(await call(async () => chatOK(null, '```json\n{"fine":true}\n```'), undefined, [], only("mistral")), { fine:true });
  assert.deepEqual(await call(async () => chatOK(null, '```\n{"fine":true}\n```'), undefined, [], only("mistral")), { fine:true });
});
test("a waited retry reserves budget again, so waiting cannot exceed the call limit", async () => {
  const reserved = [];
  await call(async (url) => (url.includes("groq") ? fail(429, null, 1) : chatOK({ ok:true })),
    async ({ provider }) => { reserved.push(provider); }, [], modelConfig({ ...env, CONTENT_GROQ_MODEL:"only-one" }));
  assert.deepEqual(reserved, ["groq","groq","mistral"]);
});
test("a provider over its quota is never called; the fallback is", async () => {
  const hosts = [];
  const reserve = async ({ provider }) => { if (provider === "groq") budgetRefusal()(); };
  await call(async (url) => { hosts.push(hostOf(url)); return chatOK({ ok:true }); }, reserve);
  assert.deepEqual(hosts, ["api.mistral.ai"]);
});
test("every provider over quota ends as exhausted, so the run can stop cleanly", async () => {
  let requests = 0;
  const error = await call(async () => { requests++; }, budgetRefusal()).catch((caught) => caught);
  assert.ok(error instanceof ModelChainError); assert.equal(error.exhausted, true); assert.equal(requests, 0);
});
test("mixed failures are not exhaustion, so the next article is still tried", async () => {
  const reserve = async ({ provider }) => { if (provider === "mistral") budgetRefusal("mistral")(); };
  const error = await call(async () => fail(503), reserve).catch((caught) => caught);
  assert.equal(error.exhausted, false);
});
test("a database failure while reserving stops the call rather than spending unreserved", async () => {
  let requests = 0;
  await assert.rejects(call(async () => { requests++; }, async () => { throw new Error("connection reset"); }), /connection reset/);
  assert.equal(requests, 0);
});

// --- Adapters: wire format ------------------------------------------------------------------

const capture = (reply) => { const seen = {}; return { seen, fetchImpl: async (url, init) => { Object.assign(seen, { url, method:init.method, headers:init.headers, body:init.body ? JSON.parse(init.body) : null }); return reply; } }; };
const only = (name, extra = {}) => modelConfig({ ...env, CONTENT_PROVIDERS:name, ...extra });

test("Groq uses chat completions with a strict schema, bearer auth and max_completion_tokens", async () => {
  const { seen, fetchImpl } = capture(chatOK({ fine:true }));
  assert.deepEqual(await call(fetchImpl, undefined, [], only("groq", { CONTENT_GROQ_MODEL:"qwen/qwen3.8-27b" })), { fine:true });
  assert.equal(seen.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(seen.headers.Authorization, "Bearer q-key");
  assert.equal(seen.body.model, "qwen/qwen3.8-27b");
  assert.deepEqual(seen.body.messages.map((m) => m.role), ["system","user"]);
  assert.deepEqual(seen.body.response_format, { type:"json_schema", json_schema:{ name:"editorial_result", schema:{ type:"object" }, strict:true } });
  assert.equal(seen.body.max_completion_tokens, 2500); assert.equal(seen.body.max_tokens, undefined);
  assert.equal(seen.body.reasoning_effort, undefined);
});
test("model-specific options are sent only when configured", async () => {
  const { seen, fetchImpl } = capture(chatOK({ fine:true }));
  await call(fetchImpl, undefined, [], only("groq", { CONTENT_GROQ_MODEL:"qwen/qwen3.8-27b", CONTENT_GROQ_REASONING_EFFORT:"none" }));
  assert.equal(seen.body.reasoning_effort, "none");
});
test("Mistral uses the same adapter with its own endpoint and max_tokens", async () => {
  const { seen, fetchImpl } = capture(chatOK({ fine:true }));
  assert.deepEqual(await call(fetchImpl, undefined, [], only("mistral")), { fine:true });
  assert.equal(seen.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(seen.headers.Authorization, "Bearer m-key");
  assert.equal(seen.body.max_tokens, 2500); assert.equal(seen.body.response_format.json_schema.strict, true);
});
test("OpenRouter works through the same adapter, as a configurable fallback", async () => {
  const { seen, fetchImpl } = capture(chatOK({ fine:true }));
  const config = modelConfig({ OPENROUTER_API_KEY:"r-key", CONTENT_OPENROUTER_MODEL:"qwen/some-model:free", CONTENT_PROVIDERS:"openrouter" });
  assert.deepEqual(await call(fetchImpl, undefined, [], config), { fine:true });
  assert.equal(seen.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen.headers.Authorization, "Bearer r-key"); assert.equal(seen.body.model, "qwen/some-model:free");
  // Only hosts that honour the schema may serve the request.
  assert.deepEqual(seen.body.provider, { require_parameters:true });
  assert.equal(seen.body.response_format.type, "json_schema");
});
const listing = async () => ({ ok:true, json:async()=>({ data:[{ id:"a:free" },{ id:"paid-model" },{ id:"b:free" }] }) });
test("OpenRouter's model listing shows only free models", async () => {
  const [report] = await liveModels({ OPENROUTER_API_KEY:"r", CONTENT_OPENROUTER_MODEL:"b:free", CONTENT_PROVIDERS:"openrouter" }, listing);
  assert.deepEqual(report.available, ["a:free","b:free"]);
  assert.deepEqual(report.preferred, [{ model:"b:free", live:true }]);
});
test("the models command lists a provider that has a key but no model yet, so one can be chosen", async () => {
  const report = await liveModels({ MISTRAL_API_KEY:"m", CONTENT_MISTRAL_MODEL:"mistral-small-latest", OPENROUTER_API_KEY:"r" }, listing);
  const openrouter = report.find((r) => r.provider === "openrouter");
  assert.deepEqual(openrouter.available, ["a:free","b:free"]);
  assert.deepEqual(openrouter.preferred, []);
  assert.match(openrouter.note, /CONTENT_OPENROUTER_MODEL/);
});
test("the models command says which key is missing rather than failing", async () => {
  const report = await liveModels({ MISTRAL_API_KEY:"m" }, listing);
  assert.match(report.find((r) => r.provider === "openrouter").error, /OPENROUTER_API_KEY/);
  assert.ok(report.find((r) => r.provider === "mistral").available);
});
test("provider-specific body fields stay with their provider", async () => {
  const { seen, fetchImpl } = capture(chatOK({ fine:true }));
  await call(fetchImpl, undefined, [], only("mistral"));
  assert.equal(seen.body.provider, undefined);
});
test("Gemini and OpenAI remain available as drop-in providers", async () => {
  const gem = capture({ ok:true, json:async()=>({ status:"completed", steps:[{ type:"model_output", content:[{ type:"text", text:'{"fine":true}' }] }] }) });
  assert.deepEqual(await call(gem.fetchImpl, undefined, [], modelConfig({ GEMINI_API_KEY:"g", CONTENT_GEMINI_MODEL:"gm", CONTENT_PROVIDERS:"gemini" })), { fine:true });
  assert.equal(gem.seen.url, "https://generativelanguage.googleapis.com/v1beta/interactions"); assert.equal(gem.seen.body.store, false);
  const oai = capture({ ok:true, json:async()=>({ status:"completed", output:[{ content:[{ type:"output_text", text:'{"fine":true}' }] }] }) });
  assert.deepEqual(await call(oai.fetchImpl, undefined, [], modelConfig({ OPENAI_API_KEY:"o", CONTENT_OPENAI_MODEL:"om", CONTENT_PROVIDERS:"openai" })), { fine:true });
  assert.equal(oai.seen.url, "https://api.openai.com/v1/responses");
});
test("reasoning text in <think> tags ahead of the answer is dropped", async () => {
  const json = await call(async () => chatOK(null, '<think>Let me consider the source…</think>\n{"fine":true}'), undefined, [], only("groq"));
  assert.deepEqual(json, { fine:true });
});
test("truncated or malformed answers never reach the editorial checks", async () => {
  const error = await call(async () => ({ ok:true, json:async()=>({ choices:[{ finish_reason:"length", message:{ content:'{"half":' } }] }) }), undefined, [], only("mistral")).catch((caught) => caught);
  assert.equal(error.attempts[0].reason, "incomplete");
  const garbled = await call(async () => chatOK(null, "Sure! Here is JSON:"), undefined, [], only("mistral")).catch((caught) => caught);
  assert.equal(garbled.attempts[0].reason, "malformed");
});
test("provider error messages are never echoed; only the status and error code", async () => {
  const error = await call(async () => fail(400, "invalid_request_error"), undefined, [], only("mistral")).catch((caught) => caught);
  assert.doesNotMatch(error.message, /SECRET/); assert.match(error.message, /400/);
  assert.equal(error.attempts[0].reason, "rejected");
  // Nor through serialisation: the trace is saved to the database with each candidate.
  const trace = [];
  await call(async () => fail(400, "invalid_request_error"), undefined, trace, only("mistral")).catch(() => {});
  assert.doesNotMatch(JSON.stringify(trace), /SECRET/);
});
test("a non-JSON error page is identified as probably not from the provider", async () => {
  const { mistral } = await import("../../scripts/content/providers/mistral.mjs");
  const page = { ok:false, status:429, headers:{ get:(n)=> n === "content-type" ? "text/html" : null }, text:async()=>"<html><body><h1>Blocked by your organisation's web gateway</h1></body></html>" };
  const error = await mistral.request({ model:"m", key:"k", instruction:"i", input:{}, schema:{}, maxOutputTokens:10, fetchImpl:async()=>page }).catch((caught) => caught);
  assert.equal(error.reason, "rate_limited");
  assert.match(error.detail, /non-JSON reply \(text\/html\).*Blocked by your organisation's web gateway/);
});
test("the provider's own message is kept apart for the probe, and never serialised", async () => {
  const { mistral } = await import("../../scripts/content/providers/mistral.mjs");
  const error = await mistral.request({ model:"m", key:"k", instruction:"i", input:{}, schema:{}, maxOutputTokens:10, fetchImpl:async()=>fail(400,"invalid_request_error") }).catch((caught) => caught);
  assert.equal(error.detail, "SECRET PROMPT TEXT");
  assert.doesNotMatch(JSON.stringify(error), /SECRET/);
  assert.doesNotMatch(JSON.stringify({ ...error }), /SECRET/);
});
test("the models command reports which preferred models are still served", async () => {
  const report = await liveModels(env, async (url, init) => {
    assert.equal(init.method, "GET");
    return { ok:true, json:async()=>({ data: url.includes("groq") ? [{ id:"qwen/qwen3.8-27b" },{ id:"openai/gpt-oss-120b" }] : [{ id:"mistral-test" }] }) };
  });
  assert.deepEqual(report[0].preferred, [{ model:"qwen/qwen3.8-27b", live:true },{ model:"qwen/qwen3-32b", live:false }]);
  assert.deepEqual(report[1].preferred, [{ model:"mistral-test", live:true }]);
});

// --- Request size ---------------------------------------------------------------------------

test("source text is capped so both calls fit a small per-minute token allowance", () => {
  const long = { ...response, text:`<title>Long</title><article>${"word ".repeat(10000)}</article>` };
  assert.equal(extractArticle(long, "Example").text.length, 10000);
  assert.equal(extractArticle(long, "Example", 4000).text.length, 4000);
});
test("only recent concepts are sent, however large the catalogue grows", () => {
  const posts = Array.from({ length:500 }, (_, i) => ({ id:`p${i}`, published_at:new Date(Date.UTC(2026,0,1) + i * 60000).toISOString(), concept_ids:[`c${i}`] }));
  const concepts = recentConcepts(posts);
  assert.equal(concepts.length, 80); assert.equal(concepts[0], "c499");
});
test("a worst-case draft and review each fit Groq's ~8K tokens a minute, output cap included", async () => {
  // Capture the engine's real prompts at their largest: a full-length source, a full concept list, full preferences.
  const long = { ...response, text:`<title>${"T".repeat(190)}</title><article>${"lengthy words ".repeat(2000)}</article>` };
  const bigSource = extractArticle(long, "Example");
  const concepts = recentConcepts(Array.from({ length:200 }, (_, i) => ({ id:`p${i}`, published_at:new Date(Date.UTC(2026,0,1)+i*60000).toISOString(), concept_ids:[`a-fairly-long-canonical-concept-${i}`] })));
  const preferences = Array.from({ length:20 }, (_, i) => ({ topic:"A reasonably long topic", subtopic:`A reasonably long subtopic ${i}`, more:3, harder:2, uninteresting:1, averageDifficulty:2.5 }));
  const { text:_t, hash:_h, ...bigCitation } = bigSource; void _t; void _h;
  // Quotes and citation must genuinely come from the source, or the engine rightly skips the review call.
  const bigDraft = { ...structuredClone(draft), explanation:["x".repeat(1100)], deeper:"y".repeat(1500), sources:[bigCitation],
    claims:Array.from({ length:10 }, () => ({ claim:"c".repeat(150), url:bigSource.url, excerpt:"lengthy words ".repeat(11).trim() })) };
  const prompts = [];
  await draftCandidates({ groups:[group], retrieve:async()=>long, concepts, preferences,
    generate:async(args)=>{ prompts.push(args); return prompts.length === 1 ? bigDraft : review; }, save:async()=>{} });
  assert.equal(prompts.length, 2);
  const { maxOutputTokens } = modelConfig(env);
  for (const { instruction, input, schema } of prompts) {
    // ~4 bytes a token for English and JSON; generous, since model tokenisers usually do better.
    const inputTokens = Buffer.byteLength(JSON.stringify({ instruction, input, schema })) / 4;
    assert.ok(inputTokens + maxOutputTokens < 8000, `request ~${Math.round(inputTokens + maxOutputTokens)} tokens exceeds 8K`);
  }
});
test("ratings are summarised per subtopic, newest first, instead of one entry each", () => {
  const posts = [{ id:"a", topic:"Science", subtopic:"Physics", difficulty:2 }, { id:"b", topic:"Science", subtopic:"Physics", difficulty:4 }, { id:"c", topic:"History", subtopic:"Rome", difficulty:1 }];
  const states = [
    { post_id:"a", rating:"more", updated_at:"2026-09-01T00:00:00Z" }, { post_id:"b", rating:"harder", updated_at:"2026-09-02T00:00:00Z" },
    { post_id:"c", rating:"uninteresting", updated_at:"2026-09-03T00:00:00Z" }, { post_id:"c", bookmarked:true, rating:null },
  ];
  assert.deepEqual(summarisePreferences(states, posts), [
    { topic:"History", subtopic:"Rome", more:0, harder:0, uninteresting:1, averageDifficulty:1 },
    { topic:"Science", subtopic:"Physics", more:1, harder:1, uninteresting:0, averageDifficulty:3 },
  ]);
});

// --- Engine: continuous running -------------------------------------------------------------

const group = { publisher:"Example", hosts:["example.org"], feeds:[], articles:[source.url] };
test("a source already drafted on an earlier run costs no model call", async () => {
  let calls = 0;
  const metrics = await draftCandidates({ groups:[group], retrieve:async()=>response, known:new Set([source.url]), generate:async()=>{ calls++; }, save:async()=>{} });
  assert.equal(calls, 0); assert.equal(metrics.alreadyDrafted, 1);
});
test("one failed article does not end the run", async () => {
  const two = { ...group, articles:["https://example.org/one","https://example.org/two"] };
  let calls = 0; const saved = [];
  const metrics = await draftCandidates({ groups:[two], retrieve:async(url)=>({ ...response, url }),
    generate:async(args)=>{ calls++; if (calls === 1) throw new ModelChainError([{ provider:"groq", model:"qwen/qwen3.8-27b", reason:"unavailable" }]);
      return args.schema.properties.supported ? review : { ...structuredClone(draft), sources:[{ ...citation, url:"https://example.org/two" }], claims:[{ ...draft.claims[0], url:"https://example.org/two" }] }; },
    save:async(c)=>saved.push(c) });
  assert.equal(metrics.modelFailures, 1); assert.equal(saved.length, 1); assert.equal(metrics.stopped, null);
});
test("running out of quota everywhere stops the run and keeps what was saved", async () => {
  const two = { ...group, articles:["https://example.org/one","https://example.org/two"] };
  let calls = 0; const saved = [];
  const metrics = await draftCandidates({ groups:[two], retrieve:async()=>response,
    generate:async()=>{ calls++; if (calls > 2) throw new ModelChainError([{ provider:"groq", model:"qwen/qwen3.8-27b", reason:"budget" }]); return calls === 1 ? structuredClone(draft) : review; },
    save:async(c)=>saved.push(c) });
  assert.equal(metrics.stopped, "quota"); assert.equal(saved.length, 1); assert.equal(calls, 3);
});
test("progress reports publisher and outcome only, never article text", async () => {
  const events = [];
  await draftCandidates({ groups:[group], retrieve:async()=>response, onProgress:(e)=>events.push(e),
    generate:async(args)=>args.schema.properties.supported ? review : structuredClone(draft), save:async()=>{} });
  assert.deepEqual(events, [{ n:1, limit:4, publisher:"Example", outcome:"passed checks" }]);
  assert.doesNotMatch(JSON.stringify(events), /conservation of energy/);
});
test("rate-limiting everywhere stops the run instead of hammering the remaining articles", async () => {
  const two = { ...group, articles:["https://example.org/one","https://example.org/two"] };
  let calls = 0;
  const metrics = await draftCandidates({ groups:[two], retrieve:async(url)=>({ ...response, url }),
    generate:async()=>{ calls++; throw new ModelChainError([{ provider:"mistral", model:"m", reason:"rate_limited", status:429 }]); },
    save:async()=>{} });
  assert.equal(metrics.stopped, "rate_limited"); assert.equal(calls, 1);
});
test("a bug is not mistaken for a provider failure", async () => {
  await assert.rejects(draftCandidates({ groups:[group], retrieve:async()=>response, generate:async()=>{ throw new TypeError("bug"); }, save:async()=>{} }), /bug/);
});
