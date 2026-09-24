"use client";
import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import Image from "next/image";
import { ArrowDown, Bookmark, CheckCheck, Layers2, LockKeyhole, Sprout } from "lucide-react";
import { emptyPost, type PostPatch } from "@/lib/storage";
import type { ReadingPosition } from "@/types/post";
import { useReading } from "@/hooks/useReading";
import { useList } from "@/hooks/useList";
import { PostCard } from "./PostCard";
import { ratingLabels } from "./FeedbackBar";

type View = "feed" | "library" | "read";

export function Feed({
  client,
  userId,
  onSignOut,
}: {
  client: SupabaseClient;
  userId: string;
  onSignOut: () => Promise<void>;
}) {
  const { state, posts, ready, pending, syncing, paging, atEnd, error, restore, savePost, saveProgress, loadMore, retry } =
    useReading(client, userId);
  const [view, setView] = useState<View>("feed");
  const library = useList(client, "bookmarked", view === "library", posts.filter((post) => state.posts[post.id]?.bookmarked));
  const readList = useList(client, "read", view === "read", posts.filter((post) => state.posts[post.id]?.readAt));
  const [announcement, setAnnouncement] = useState("");
  const current = useRef({ state, saveProgress, savePost, loadMore });
  useEffect(() => {
    current.current = { state, saveProgress, savePost, loadMore };
  });
  const position = useRef<ReadingPosition | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ready || view !== "feed") return;
    let restoring = true;
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const frame = requestAnimationFrame(() => {
      const saved = current.current.state.position;
      if (saved) {
        const card = document.getElementById(saved.postId);
        if (card) window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY + saved.offset));
      }
      restoring = false;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      clearTimeout(timer);
      if (position.current) {
        current.current.saveProgress(current.current.state.loadedCount, position.current);
        position.current = null;
      }
    }
    function scroll() {
      if (restoring) return;
      const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-post-id]"));
      const card = cards.find((element) => element.getBoundingClientRect().bottom > 100) ?? cards.at(-1);
      if (card)
        position.current = {
          postId: card.id,
          offset: Math.max(-2000, Math.min(10000, -card.getBoundingClientRect().top)),
        };
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
    }
    function hide() {
      if (document.visibilityState === "hidden") flush();
    }
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      cancelAnimationFrame(frame);
      flush();
      history.scrollRestoration = previous;
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [ready, view, restore]);

  useEffect(() => {
    if (!ready || view !== "feed") return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.closest("article")?.id;
          if (!id) continue;
          if (entry.isIntersecting && document.visibilityState === "visible") {
            if (!current.current.state.posts[id]?.firstSeenAt) current.current.savePost(id, { seen: true });
            if (!current.current.state.posts[id]?.readAt && !timers.has(entry.target))
              timers.set(
                entry.target,
                setTimeout(() => {
                  if (document.visibilityState === "visible") current.current.savePost(id, { read: true });
                }, 5000),
              );
          } else {
            clearTimeout(timers.get(entry.target));
            timers.delete(entry.target);
          }
        }
      },
      { threshold: 0.5 },
    );
    document.querySelectorAll(".insight").forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [ready, view, posts]);

  // Infinite scroll: pull the next page as the sentinel below the feed approaches.
  useEffect(() => {
    if (!ready || view !== "feed" || atEnd) return;
    const target = sentinel.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void current.current.loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ready, view, atEnd, posts.length]);

  function updatePost(id: string, patch: PostPatch) {
    savePost(id, patch);
    if (patch.rating !== undefined)
      setAnnouncement(patch.rating ? `${ratingLabels[patch.rating]} recorded.` : "Rating cleared.");
    else if (patch.bookmarked !== undefined)
      setAnnouncement(patch.bookmarked ? "Saved to your Library." : "Removed from your Library.");
  }
  function switchView(next: View) {
    if (next === view) return;
    setView(next);
    window.scrollTo(0, 0);
  }

  if (!ready)
    return (
      <main className="reading-column auth-panel">
        <p role="status">{error || "Loading your private feed…"}</p>
        <button className="text-button" onClick={retry}>
          Retry
        </button>
        <button className="text-button" onClick={onSignOut}>
          Sign out
        </button>
      </main>
    );

  const savedCount = Object.values(state.posts).filter((post) => post.bookmarked).length;
  const list = view === "library" ? library : view === "read" ? readList : null;
  const shown = list ? list.items : posts;
  const unread = posts.filter((post) => !state.posts[post.id]?.readAt).length;
  const status = syncing ? "Syncing…" : pending ? "Saved on this device" : "Saved to your account";

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to reading
      </a>
      <header className="site-header">
        <div className="header-inner">
          <div className="brand-lockup">
            <Link href="/" className="wordmark" aria-label="T home">
              <Image className="brand-symbol" src="/logo.svg" alt="T" width={38} height={38} priority />
            </Link>
            <p className="tagline">Know broadly. Explore deeply.</p>
          </div>
          <span className="local-label">
            <LockKeyhole size={12} aria-hidden="true" /> PRIVATE READING
          </span>
        </div>
      </header>
      <main id="main" className="reading-column">
        <section className="intro">
          <p className="eyebrow">A SPACE FOR YOUR CURIOSITY</p>
          <h1>
            A little more
            <br />
            <em>perspective.</em>
          </h1>
          <p className="intro-copy">
            Ideas worth sitting with.
            <br />
            Across disciplines, at your own pace.
          </p>
        </section>
        <div className="account-bar">
          <span role="status">{status}</span>
          <button className="text-button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <nav className="view-nav" aria-label="Reading views">
          <button type="button" aria-current={view === "feed" ? "page" : undefined} onClick={() => switchView("feed")}>
            <Layers2 size={17} aria-hidden="true" />
            Your feed
          </button>
          <button
            type="button"
            aria-current={view === "library" ? "page" : undefined}
            onClick={() => switchView("library")}
          >
            <Bookmark size={17} aria-hidden="true" />
            Library<span className="count">{savedCount}</span>
          </button>
          <button type="button" aria-current={view === "read" ? "page" : undefined} onClick={() => switchView("read")}>
            <CheckCheck size={17} aria-hidden="true" />
            Read
          </button>
        </nav>
        <div className="feed-heading">
          <h2>{view === "feed" ? "Explore something different" : view === "library" ? "Keep good ideas close" : "Already read"}</h2>
          <span>{view === "feed" ? `${unread} unread` : view === "library" ? `${savedCount} saved` : "newest first"}</span>
        </div>
        <p className="sample-note">
          Posts marked SAMPLE are illustrative, not verified editorial content. Published posts include their sources.
        </p>
        <details className="guide">
          <summary>A quick guide to the five controls</summary>
          <p>
            Thumbs up: more at the same level. Thumbs down: not interesting. Double check: keep the topic, increase
            difficulty. Bookmark: save independently. Book: open or close the deeper explanation.
          </p>
          <p>
            Posts you have read move to Read the next time you open T, so your feed starts at something new.
            Choose one rating per post; tap it again to clear. Preferences sync privately across your devices and guide
            future queue preparation. Posts already in your queue keep their order.
          </p>
        </details>
        {error && (
          <p role="alert" className="storage-warning">
            {error}{" "}
            <button className="text-button" onClick={retry}>
              Retry sync
            </button>
          </p>
        )}
        <p className="sr-only" role="status">
          {announcement}
        </p>
        <div className="posts">
          {shown.map((post, index) => (
            <PostCard
              key={post.id}
              post={post}
              index={index}
              state={state.posts[post.id] ?? emptyPost}
              disabled={!ready}
              onChange={(patch) => updatePost(post.id, patch)}
            />
          ))}
        </div>
        {list?.offline && (
          <p role="status" className="storage-warning">
            Offline: showing only what this device already holds.
          </p>
        )}
        {list && !list.atEnd && shown.length > 0 && (
          <div className="continue">
            <button className="load-button" onClick={list.more} disabled={list.loading}>
              {list.loading ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
        {view === "read" && !readList.loading && shown.length === 0 && (
          <div className="empty-state">
            <CheckCheck size={28} aria-hidden="true" />
            <h3>Nothing read yet.</h3>
            <p>Posts you read appear here, newest first.</p>
          </div>
        )}
        {view === "library" && !library.loading && shown.length === 0 && (
          <div className="empty-state">
            <Bookmark size={28} aria-hidden="true" />
            <h3>Your next good idea belongs here.</h3>
            <p>Tap the bookmark below any post to keep it.</p>
            <button className="text-button" onClick={() => switchView("feed")}>
              Explore your feed →
            </button>
          </div>
        )}
        {view === "feed" && (
          <>
            {/* Zero-content marker the observer watches; kept out of the padded blocks below. */}
            <div ref={sentinel} className="scroll-sentinel" aria-hidden="true" />
            {paging ? (
              <div className="continue">
                <p role="status">Bringing in more ideas…</p>
              </div>
            ) : atEnd ? (
              <div className="end-note">
                <Sprout size={23} aria-hidden="true" />
                <p>A good place to pause.</p>
                <span>You’re all caught up. New posts arrive every few hours; past ones are under Read.</span>
              </div>
            ) : (
              <div className="continue">
                <p>There’s more to connect.</p>
                <button className="load-button" onClick={() => void loadMore()}>
                  Keep scrolling
                  <ArrowDown size={17} aria-hidden="true" />
                </button>
              </div>
            )}
          </>
        )}
        <footer>
          Your reading, kept together.
          <br />
          <span>
            Ratings, saved posts and reading position are kept on this device and synced to your private account when
            you’re online.
          </span>
        </footer>
      </main>
    </>
  );
}
