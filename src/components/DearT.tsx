"use client";
import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Steer { scope: string; key: string; choice: string; label: string }
interface Request { id: string; text: string; days: number; status: "pending" | "applied" | "failed"; steers: Steer[]; note: string | null; until: string }

const CHOICE: Record<string, string> = { more: "More", less: "Less", snooze: "Pause" };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate what the table returns; anything malformed is dropped rather than trusted. */
function coerce(rows: unknown): Request[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    if (!isObject(r) || typeof r.id !== "string" || typeof r.text !== "string" || typeof r.until !== "string") return [];
    if (r.status !== "pending" && r.status !== "applied" && r.status !== "failed") return [];
    const steers = Array.isArray(r.steers) ? r.steers.flatMap((s) => (isObject(s) && typeof s.label === "string" && typeof s.choice === "string"
      ? [{ scope: String(s.scope), key: String(s.key), choice: s.choice, label: s.label }] : [])) : [];
    return [{ id: r.id, text: r.text, days: Number(r.days) || 1, status: r.status, steers, note: typeof r.note === "string" ? r.note : null, until: r.until }];
  });
}

/**
 * Dear T (SPEC §9): tell the feed in your own words what you want more or less of, for a day, three days or a
 * week. The next update (every three hours) turns it into steers, shown as chips; remove it to stop early.
 */
export function DearT({ client }: { client: SupabaseClient }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [text, setText] = useState("");
  const [days, setDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => client.from("dear_t").select("id,text,days,status,steers,note,until").gt("until", new Date().toISOString()).order("created_at", { ascending: false }).limit(10))
      .then(({ data, error }) => { if (active && !error) setRequests(coerce(data)); })
      .catch(() => {});
    return () => { active = false; };
  }, [client, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  async function send() {
    setBusy(true);
    try {
      const { error } = await client.rpc("dear_t_send", { p_text: text, p_days: days });
      if (error) throw error;
      setText("");
      setNotice("Sent. It takes effect at the next update, within three hours.");
      reload();
    } catch (error) {
      const message = String((error as { message?: unknown })?.message ?? "");
      setNotice(/280|1, 3 or 7|Five requests/.test(message) ? message : "That could not be sent. Check your connection and try again.");
    } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      const { error } = await client.rpc("dear_t_remove", { p_id: id });
      if (error) throw error;
      setRequests((list) => list.filter((r) => r.id !== id));
      setNotice("Removed. The feed goes back to normal at the next update.");
    } catch {
      setNotice("That could not be removed. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  const ends = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return <section className="map-section dear-t" aria-labelledby="dear-title">
    <h3 id="dear-title" className="map-subtitle">Dear T</h3>
    <p className="map-note">Say what you would like more or less of, in your own words. Your request is read by the content engine&apos;s AI model to turn it into steers; it is never shown anywhere else.</p>
    <label className="sr-only" htmlFor="dear-text">Your request</label>
    <textarea id="dear-text" className="dear-text" rows={2} maxLength={280} value={text} placeholder="Dear T, less AI news this week, more Byzantine history"
      onChange={(event) => setText(event.target.value)} />
    <div className="dear-row">
      <label className="map-note" htmlFor="dear-days">For</label>
      <select id="dear-days" className="dear-days" value={days} onChange={(event) => setDays(Number(event.target.value))}>
        <option value={1}>a day</option><option value={3}>three days</option><option value={7}>a week</option>
      </select>
      <button type="button" className="steer-button" disabled={busy || text.trim().length < 3} onClick={() => void send()}>Send</button>
    </div>
    {notice && <p className="map-notice" role="status">{notice}</p>}
    {requests.length > 0 && <ul className="dear-list">{requests.map((r) => <li key={r.id}>
      <p className="dear-quote">“{r.text}”</p>
      <p className="map-note">{r.status === "pending" ? "Waiting for the next update." : r.status === "failed" ? r.note ?? "Nothing to steer was found in this." : `Until ${ends(r.until)}.`}</p>
      {r.steers.length > 0 && <p className="dear-chips">{r.steers.map((s) => <span key={`${s.scope}:${s.key}`} className="dear-chip">{CHOICE[s.choice] ?? s.choice}: {s.label}</span>)}</p>}
      <button type="button" className="text-button" disabled={busy} onClick={() => void remove(r.id)}>Remove<span className="sr-only"> this request</span></button>
    </li>)}</ul>}
  </section>;
}
