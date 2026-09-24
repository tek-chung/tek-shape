"use client";
import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, BookOpen, CheckCheck, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { buildMap, coerceRows, type FieldNode, type KnowledgeMap as MapData, type Tally, type UmbrellaNode } from "@/lib/knowledgeMap";
import { coerceTaste, subtopicKey, type Choice, type Pause, type Preference, type TasteSnapshot } from "@/lib/taste";
import { placeOf } from "@/lib/taxonomy";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null);
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const pauseNote = (p: Pause | null) => (p ? `${p.by === "you" ? "Snoozed by you" : "Resting after repeated “Not interesting”"}${p.until ? ` until ${when(p.until)}` : ""}` : null);

/** The three ratings and deeper dives, shown only where they exist, so an untouched row stays quiet. */
function Signals({ t }: { t: Tally }) {
  const items = [
    { n: t.more, Icon: ThumbsUp, label: "rated more at the same level" },
    { n: t.harder, Icon: CheckCheck, label: "asked to go harder" },
    { n: t.uninteresting, Icon: ThumbsDown, label: "rated not interesting" },
    { n: t.deeper, Icon: BookOpen, label: "opened the deeper explanation" },
  ].filter((item) => item.n > 0);
  if (!items.length) return null;
  return <span className="map-signals">{items.map(({ n, Icon, label }) =>
    <span key={label} title={`${n} ${label}`}><Icon size={13} aria-hidden="true" />{n}<span className="sr-only"> {label}</span></span>)}</span>;
}

/** More / Less / Snooze for one field or subtopic. Tapping the active choice clears it. */
function Steer({ label, choice, busy, onChoose }: { label: string; choice: Choice | null; busy: boolean; onChoose: (c: Choice | null) => void }) {
  const options: { value: Choice; text: string; hint: string }[] = [
    { value: "more", text: "More", hint: `Show more ${label}` },
    { value: "less", text: "Less", hint: `Show less ${label}` },
    { value: "snooze", text: "Snooze", hint: `Pause ${label} for 30 days` },
  ];
  return <div className="steer" role="group" aria-label={`Steer ${label}`}>
    {options.map((o) => <button key={o.value} type="button" className="steer-button" disabled={busy} aria-pressed={choice === o.value}
      title={o.hint} aria-label={o.hint} onClick={() => onChoose(choice === o.value ? null : o.value)}>{o.text}</button>)}
  </div>;
}

/** A horizontal depth bar with its figures, used for fields and subtopics. */
function Row({ name, t, max, onOpen, note, children }: { name: string; t: Tally; max: number; onOpen?: () => void; note?: string | null; children?: React.ReactNode }) {
  const body = <>
    <span className="map-row-head"><span className="map-row-name">{name}</span><Signals t={t} /></span>
    <span className="map-bar" aria-hidden="true"><span style={{ width: `${t.read ? Math.max(4, (t.depth / max) * 100) : 0}%` }} /></span>
    <span className="map-row-meta">{t.read ? `${plural(t.read, "post")} read` : "Not explored yet"}
      {t.posts > t.read ? ` · ${t.posts - t.read} waiting` : ""}{note ? ` · ${note}` : ""}</span>
  </>;
  return <li className={t.read ? "map-row" : "map-row map-row-empty"}>
    {onOpen ? <button type="button" className="map-row-button" onClick={onOpen}>{body}</button> : <div className="map-row-button">{body}</div>}
    {children}
  </li>;
}

/**
 * The T-shape: a band across the top shows breadth (every area you have read in is tinted), and a bar hangs
 * beneath each area showing depth (read posts weighted by difficulty, plus one for each deeper dive).
 */
function TShape({ map, onOpen }: { map: MapData; onOpen: (u: UmbrellaNode) => void }) {
  return <div className="t-shape" role="list" aria-label="Your T-shape: breadth across the top, depth below">
    {map.umbrellas.map((u) => {
      const share = u.read ? 0.25 + 0.75 * Math.min(1, u.read / Math.max(1, ...map.umbrellas.map((x) => x.read))) : 0;
      return <button key={u.umbrella.id} type="button" role="listitem" className="t-column" onClick={() => onOpen(u)}
        aria-label={`${u.umbrella.label}: ${u.read ? `${plural(u.read, "post")} read, ${u.fieldsExplored} of ${u.fields.length} fields` : "not explored yet"}`}>
        <span className={share ? "t-cap" : "t-cap t-cap-empty"} style={{ ["--fill" as string]: share }}><span className="t-label">{u.umbrella.short}</span></span>
        <span className="t-stem"><span style={{ height: `${u.depth ? Math.max(6, (u.depth / map.maxDepth) * 100) : 0}%` }} /></span>
      </button>;
    })}
  </div>;
}

/** Subtopics you enjoy inside areas you otherwise read or like less: what exploration has found. */
function Niches({ snapshot, onOpen }: { snapshot: TasteSnapshot; onOpen: (umbrella: string, field: string) => void }) {
  return <section className="map-section" aria-labelledby="niches-title">
    <h3 id="niches-title" className="map-subtitle"><Sparkles size={15} aria-hidden="true" /> Discovered niches</h3>
    {snapshot.niches.length
      ? <ul className="map-list">{snapshot.niches.map((n) => {
        const place = placeOf(n.field);
        return <li key={n.key} className="map-row"><button type="button" className="map-row-button" onClick={() => onOpen(n.umbrella, n.field)}>
          <span className="map-row-head"><span className="map-row-name">{n.name}</span><span className="map-row-meta">{pct(n.mean)} enjoyed</span></span>
          <span className="map-row-meta">{place ? `${place.field.label} · in ${place.umbrella.label}, an area you read less` : ""}</span>
        </button></li>;
      })}</ul>
      : <p className="map-note">None yet. Explorations in your quieter areas will surface them here.</p>}
  </section>;
}

/** The feed's own report card, once there is enough to grade. */
function ReportCard({ snapshot }: { snapshot: TasteSnapshot }) {
  const m = snapshot.metrics;
  if (m.placed < 5) return null;
  return <section className="map-section" aria-labelledby="report-title">
    <h3 id="report-title" className="map-subtitle">How your feed is doing</h3>
    <p className="map-note">Of your last {m.placed} posts, <strong>{pct(m.hitRate)}</strong> were read or better and <strong>{pct(m.delightRate)}</strong> delighted you
      (More, Harder, saved or opened). {m.explorations >= 5 ? <>Explorations landing: <strong>{pct(m.explorationHitRate)}</strong>. </> : null}
      About {pct(snapshot.exploreShare)} of each batch is exploration.</p>
  </section>;
}

export function KnowledgeMap({ client }: { client: SupabaseClient }) {
  const [map, setMap] = useState<MapData | null>(null);
  const [snapshot, setSnapshot] = useState<TasteSnapshot | null>(null);
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [umbrellaId, setUmbrellaId] = useState<string | null>(null);
  const [fieldId, setFieldId] = useState<string | null>(null);

  // Load on open and on each retry. State is set only in the promise callbacks, never synchronously in the effect.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => Promise.all([client.rpc("knowledge_map"), client.rpc("taste_view")]))
      .then(([mapResult, tasteResult]) => {
        if (!active) return;
        if (mapResult.error) throw mapResult.error;
        setMap(buildMap(coerceRows(mapResult.data))); setError("");
        // Taste is optional: before the first scheduled run, or before its migration, the map still works.
        const taste = tasteResult.error ? { snapshot: null, preferences: [] } : coerceTaste(tasteResult.data);
        setSnapshot(taste.snapshot); setPrefs(taste.preferences);
      })
      .catch(() => { if (active) setError("Your knowledge map could not be loaded. Check your connection and try again."); });
    return () => { active = false; };
  }, [client, attempt]);
  const retry = () => { setError(""); setMap(null); setAttempt((n) => n + 1); };

  const go = (u: string | null, f: string | null = null) => { setUmbrellaId(u); setFieldId(f); setNotice(""); window.scrollTo(0, 0); };
  const choiceOf = (scope: Preference["scope"], key: string) => prefs.find((p) => p.scope === scope && p.key === key)?.choice ?? null;

  async function steer(scope: Preference["scope"], key: string, label: string, choice: Choice | null) {
    const before = prefs;
    const others = prefs.filter((p) => !(p.scope === scope && p.key === key));
    setPrefs(choice ? [...others, { scope, key, choice, until: null }] : others);
    setBusy(true);
    try {
      const { error: rpcError } = await client.rpc("set_topic_preference", { p_scope: scope, p_key: key, p_choice: choice });
      if (rpcError) throw rpcError;
      setNotice(choice === "more" ? `More ${label} from the next update.` : choice === "less" ? `Less ${label} from the next update.`
        : choice === "snooze" ? `${label} paused for 30 days.` : `${label}: back to normal.`);
    } catch {
      setPrefs(before);
      setNotice("That change could not be saved. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  if (error) return <div className="empty-state"><p role="alert">{error}</p><button className="text-button" onClick={retry}>Retry</button></div>;
  if (!map) return <p role="status" className="map-note">Drawing your map…</p>;

  const umbrella = map.umbrellas.find((u) => u.umbrella.id === umbrellaId);
  const field: FieldNode | undefined = umbrella?.fields.find((f) => f.field.id === fieldId);
  const status = notice ? <p className="map-notice" role="status">{notice}</p> : <p className="sr-only" role="status" />;

  if (umbrella && field) {
    const max = Math.max(1, ...field.subtopics.map((s) => s.depth));
    const taste = snapshot?.fields.find((f) => f.field === field.field.id);
    const fieldLabel = field.field.label.toLowerCase();
    return <section className="knowledge-map" aria-labelledby="map-title">
      <button type="button" className="text-button map-back" onClick={() => go(umbrella.umbrella.id)}><ArrowLeft size={15} aria-hidden="true" /> {umbrella.umbrella.label}</button>
      <h2 id="map-title" className="map-title">{field.field.label}</h2>
      <p className="map-note">{field.read ? `${plural(field.read, "post")} read across ${plural(field.subtopics.filter((s) => s.read).length, "subtopic")}.` : "Nothing read here yet. Posts in this field will appear in your feed as they arrive."}
        {taste ? ` You enjoy about ${pct(taste.mean)} of what you read here; posts aim at difficulty ${taste.targetDifficulty.toFixed(1)} of 5.` : ""}</p>
      {pauseNote(taste?.paused ?? null) ? <p className="map-note map-paused">{pauseNote(taste?.paused ?? null)}. Tap More to bring it back.</p> : null}
      <Steer label={fieldLabel} choice={choiceOf("field", field.field.id)} busy={busy} onChoose={(c) => void steer("field", field.field.id, field.field.label, c)} />
      {status}
      <ul className="map-list">{field.subtopics.map((s) => {
        const key = subtopicKey(field.field.id, s.name);
        const t = snapshot?.subtopics.find((x) => x.key === key);
        const notes = [when(s.lastRead) ? `last ${when(s.lastRead)}` : null, t && t.weight >= 0.5 ? `${pct(t.mean)} enjoyed` : null, pauseNote(t?.paused ?? null)].filter(Boolean).join(" · ");
        return <Row key={s.name} name={s.name} t={s} max={max} note={notes}>
          <Steer label={s.name} choice={choiceOf("subtopic", key)} busy={busy} onChoose={(c) => void steer("subtopic", key, s.name, c)} />
        </Row>;
      })}</ul>
    </section>;
  }

  if (umbrella) {
    const max = Math.max(1, ...umbrella.fields.map((f) => f.depth));
    const fields = [...umbrella.fields].sort((a, b) => b.depth - a.depth || b.posts - a.posts);
    return <section className="knowledge-map" aria-labelledby="map-title">
      <button type="button" className="text-button map-back" onClick={() => go(null)}><ArrowLeft size={15} aria-hidden="true" /> All areas</button>
      <h2 id="map-title" className="map-title">{umbrella.umbrella.label}</h2>
      <p className="map-note">{umbrella.read ? `${plural(umbrella.read, "post")} read · ${umbrella.fieldsExplored} of ${umbrella.fields.length} fields explored.` : "Not explored yet."} Tap a field to steer it.</p>
      <ul className="map-list">{fields.map((f) => {
        const taste = snapshot?.fields.find((x) => x.field === f.field.id);
        const choice = choiceOf("field", f.field.id);
        const notes = [taste && taste.weight >= 0.5 ? `${pct(taste.mean)} enjoyed` : null, pauseNote(taste?.paused ?? null),
          choice ? `you asked for ${choice === "snooze" ? "a pause" : choice}` : null].filter(Boolean).join(" · ");
        return <Row key={f.field.id} name={f.field.label} t={f} max={max} note={notes} onOpen={() => go(umbrella.umbrella.id, f.field.id)} />;
      })}</ul>
    </section>;
  }

  return <section className="knowledge-map" aria-labelledby="map-title">
    <h2 id="map-title" className="map-title">Your T-shape</h2>
    {map.totalRead === 0
      ? <p className="map-note">Read a few posts and your map will start to take shape here.</p>
      : <p className="map-note"><strong>Breadth:</strong> {map.breadth} of {map.areas} areas. {map.deepest ? <><strong>Deepest:</strong> {map.deepest.umbrella.label}.</> : null}</p>}
    <TShape map={map} onOpen={(u) => go(u.umbrella.id)} />
    <p className="map-legend">Across the top: breadth, tinted where you have read. Hanging below: depth, from the number and difficulty of posts read and the deeper explanations opened. Tap an area to see its fields, then a field to see and steer its subtopics.</p>
    {snapshot ? <><Niches snapshot={snapshot} onOpen={(u, f) => go(u, f)} /><ReportCard snapshot={snapshot} /></> : null}
  </section>;
}
