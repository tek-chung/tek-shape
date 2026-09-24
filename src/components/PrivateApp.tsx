"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Feed } from "./Feed";
import { InstallApp } from "./InstallApp";

export function PrivateApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) { queueMicrotask(() => setLoading(false)); return; }
    let active = true;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) { setSession(next); setLoading(false); }
    });
    // A link made by `npm run signin-link` (no email sent) carries a one-time token hash. Strip it from the
    // address straight away so it never lingers in history, then exchange it for a session.
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    const type = params.get("type");
    if (tokenHash && (type === "magiclink" || type === "email")) {
      window.history.replaceState(null, "", window.location.pathname);
      void supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
        if (active && error) setMessage("That sign-in link has expired or was already used. Make a new one.");
      });
    }
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      setSession(data.session); setLoading(false);
      if (error) setMessage("Your session could not be restored. Please sign in again.");
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setMessage("");
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } });
      // Supabase's built-in email sender allows only a few emails an hour; say so rather than blame the address.
      setMessage(!error ? "If this is your authorised account, a sign-in link is on its way. Open it in this browser."
        : error.status === 429 ? "Too many sign-in emails were requested recently. Wait about an hour, then try again. The last link you received still works if it hasn’t expired."
        : "We couldn’t send a sign-in link. Check your email address and connection, then try again shortly.");
    } catch { setMessage("Unable to connect. Please try again when you’re online."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) { setMessage("Sign-out failed. Please reconnect and try again."); return; }
    setSession(null); setEmail(""); setMessage("");
  }

  if (loading) return <main className="reading-column auth-panel"><p role="status">Opening your reading space…</p></main>;
  if (session && supabase) return <><Feed key={session.user.id} client={supabase} userId={session.user.id} onSignOut={signOut} /><InstallApp />{message && <p role="alert" className="storage-warning">{message}</p>}</>;
  return <main className="reading-column auth-panel">
    <p className="eyebrow">T · KNOW BROADLY. EXPLORE DEEPLY.</p>
    <h1>Your own<br /><em>reading space.</em></h1>
    <p className="intro-copy">Sign in to keep your reading, saved ideas and place in the feed together across your devices.</p>
    {!supabase ? <p role="status" className="storage-warning">Private sign-in is not configured yet. Your feed will be available when setup is complete.</p> : <form onSubmit={signIn} className="sign-in-form">
      <label htmlFor="email">Email address</label>
      <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="load-button" disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
      <p className="sample-note">A private app for one reader. New accounts cannot be created here.</p>
    </form>}
    <p role="status">{message}</p><InstallApp />
  </main>;
}
