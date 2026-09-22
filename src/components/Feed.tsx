"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowDown, Bookmark, Layers2, LockKeyhole, Sprout } from "lucide-react";
import { posts } from "@/data/posts";
import { emptyPost, initialState, parseState, STORAGE_KEY } from "@/lib/storage";
import type { PostState, ReadingState } from "@/types/post";
import { PostCard } from "./PostCard";
import { ratingLabels } from "./FeedbackBar";

export function Feed() {
  const [state, setState] = useState<ReadingState>(initialState);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"feed" | "library">("feed");
  const [storageWarning, setStorageWarning] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef(state);
  const restoring = useRef(true);

  function persist(next: ReadingState) {
    latest.current = next;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { setStorageWarning("Browser storage is unavailable. Changes will last only while this page stays open."); }
  }

  useEffect(() => {
    let loaded = initialState;
    let warning = "";
    try { loaded = parseState(localStorage.getItem(STORAGE_KEY)); }
    catch { warning = "Saved reading data could not be loaded. You can keep reading; storage may be unavailable or damaged."; }
    latest.current = loaded;
    // Hydrate browser-only state after the server and first client render agree.
    const frame = requestAnimationFrame(() => {
      setState(loaded);
      setStorageWarning(warning);
      setReady(true);
    });
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => { cancelAnimationFrame(frame); history.scrollRestoration = previous; };
  }, []);

  useEffect(() => {
    if (!ready || view !== "feed") return;
    restoring.current = true;
    const frame = requestAnimationFrame(() => {
      const position = latest.current.position;
      if (position) {
        const element = document.getElementById(position.postId);
        if (element) window.scrollTo(0, Math.max(0, element.getBoundingClientRect().top + window.scrollY + position.offset));
      }
      restoring.current = false;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function savePosition() {
      if (restoring.current) return;
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-post-id]"));
      const card = cards.find((element) => element.getBoundingClientRect().bottom > 100) ?? cards.at(-1);
      if (!card) return;
      persist({ ...latest.current, position: { postId: card.id, offset: -card.getBoundingClientRect().top } });
    }
    function onScroll() { clearTimeout(timeout); timeout = setTimeout(savePosition, 120); }
    function onVisibility() { if (document.visibilityState === "hidden") savePosition(); }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame); clearTimeout(timeout);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", savePosition);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, view]);

  function updatePost(id: string, patch: Partial<PostState>) {
    const next = { ...latest.current, posts: { ...latest.current.posts, [id]: { ...(latest.current.posts[id] ?? emptyPost), ...patch } } };
    persist(next); setState(next);
    if (patch.rating !== undefined) setAnnouncement(patch.rating ? `${ratingLabels[patch.rating]} recorded.` : "Rating cleared.");
    else if (patch.bookmarked !== undefined) setAnnouncement(patch.bookmarked ? "Saved to your Library." : "Removed from your Library.");
  }

  function switchView(next: "feed" | "library") {
    if (next === view) return;
    setView(next);
    window.scrollTo(0, 0);
  }

  const saved = posts.filter((post) => state.posts[post.id]?.bookmarked);
  const shown = view === "feed" ? posts.slice(0, state.visibleCount) : saved;

  return <>
    <a className="skip-link" href="#main">Skip to reading</a>
    <header className="site-header"><div className="header-inner">
      <div className="brand-lockup"><Link href="/" className="wordmark" aria-label="T home"><Image className="brand-symbol" src="/logo.svg" alt="T" width={38} height={38} priority /></Link><p className="tagline">Know broadly. Explore deeply.</p></div>
      <span className="local-label"><LockKeyhole size={12} aria-hidden="true" /> SAMPLE PROTOTYPE</span>
    </div></header>
    <main id="main" className="reading-column">
      <section className="intro">
        <p className="eyebrow">A SPACE FOR YOUR CURIOSITY</p>
        <h1>A little more<br /><em>perspective.</em></h1>
        <p className="intro-copy">Ideas worth sitting with.<br />Across disciplines, at your own pace.</p>
      </section>
      <nav className="view-nav" aria-label="Reading views">
        <button type="button" aria-current={view === "feed" ? "page" : undefined} onClick={() => switchView("feed")}><Layers2 size={17} aria-hidden="true" />Your feed</button>
        <button type="button" aria-current={view === "library" ? "page" : undefined} onClick={() => switchView("library")}><Bookmark size={17} aria-hidden="true" />Library<span className="count">{saved.length}</span></button>
      </nav>
      <div className="feed-heading"><h2>{view === "feed" ? "Explore something different" : "Keep good ideas close"}</h2><span>{shown.length} {view === "feed" ? "of 8" : "saved"}</span></div>
      <p className="sample-note">SAMPLE COLLECTION · Illustrative evergreen content, not verified editorial content. Links are for further reading.</p>
      <details className="guide"><summary>A quick guide to the five controls</summary><p>Thumbs up: more at the same level. Thumbs down: not interesting. Double check: keep the topic, increase difficulty. Bookmark: save independently. Book: open or close the deeper explanation.</p><p>Choose one rating per post; tap it again to clear. Preferences are recorded locally for this prototype and do not yet change the feed.</p></details>
      {storageWarning && <p role="alert" className="storage-warning">{storageWarning}</p>}
      <p className="sr-only" role="status">{announcement}</p>
      <div className="posts" aria-busy={!ready}>
        {shown.map((post) => <PostCard key={post.id} post={post} index={posts.indexOf(post)} state={state.posts[post.id] ?? emptyPost} disabled={!ready} onChange={(patch) => updatePost(post.id, patch)} />)}
      </div>
      {view === "library" && saved.length === 0 && <div className="empty-state"><Bookmark size={28} aria-hidden="true" /><h3>Your next good idea belongs here.</h3><p>Tap the bookmark below any post to keep it.</p><button className="text-button" onClick={() => switchView("feed")}>Explore your feed →</button></div>}
      {view === "feed" && state.visibleCount < posts.length ? <div className="continue"><p>There’s more to connect.</p><button className="load-button" disabled={!ready} onClick={() => {
        const next = { ...latest.current, visibleCount: 8 };
        persist(next); setState(next); setAnnouncement("Four more sample posts revealed.");
        requestAnimationFrame(() => document.getElementById(posts[4].id)?.focus());
      }}>Keep scrolling<ArrowDown size={17} aria-hidden="true" /></button><span>4 more ideas · 4 different disciplines</span></div> : view === "feed" && <div className="end-note"><Sprout size={23} aria-hidden="true" /><p>A good place to pause.</p><span>You’ve reached all 8 sample ideas. Come back to one that stayed with you.</span></div>}
      <footer>Just for you, on this browser.<br /><span>Ratings, saved posts and reading position stay on this device. Clearing browser data removes them.</span></footer>
    </main>
  </>;
}
