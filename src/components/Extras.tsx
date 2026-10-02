"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import type { Post, PostState } from "@/types/post";
import type { PostPatch } from "@/lib/storage";
import { emptyPost } from "@/lib/storage";
import { placeOf } from "@/lib/taxonomy";
import { PostCard } from "./PostCard";
import type { Echo } from "@/hooks/useExtras";

/**
 * The Briefing ring (SPEC §2): today's news, one ring per story, above the feed. A ring is "new" until its story
 * has been opened. Tapping one opens the stories one after another, as full posts with their five controls.
 */
export function BriefingRing({ posts, states, onOpen }: { posts: Post[]; states: Record<string, PostState>; onOpen: (index: number) => void }) {
  if (!posts.length) return null;
  return <section className="briefing" aria-label="Today's briefing">
    <p className="eyebrow">TODAY&apos;S BRIEFING</p>
    <ul className="briefing-rings">
      {posts.map((post, index) => {
        const opened = !!(states[post.id]?.firstSeenAt || states[post.id]?.readAt);
        const place = placeOf(post.field);
        return <li key={post.id}>
          <button type="button" className={opened ? "ring ring-seen" : "ring"} onClick={() => onOpen(index)}
            aria-label={`${post.title}${opened ? "" : ", new"}`}>
            <span className="ring-circle" aria-hidden="true">{place?.umbrella.short ?? "News"}</span>
            <span className="ring-title" aria-hidden="true">{post.title}</span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}

/**
 * One story at a time, over the feed. Opening a story marks it seen; five seconds on it count as reading, as
 * a key insight on screen for five seconds does in the feed. Back (or the phone's back gesture) closes it.
 */
export function StoryViewer({ posts, start, states, onChange, onClose }: {
  posts: Post[]; start: number; states: Record<string, PostState>;
  onChange: (id: string, patch: PostPatch) => void; onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const close = useRef<HTMLButtonElement | null>(null);
  const post = posts[index];
  const current = useRef({ onChange, states });
  useEffect(() => { current.current = { onChange, states }; });

  useEffect(() => {
    if (!post) return;
    if (!current.current.states[post.id]?.firstSeenAt) current.current.onChange(post.id, { seen: true });
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible" && !current.current.states[post.id]?.readAt) current.current.onChange(post.id, { read: true });
    }, 5000);
    return () => clearTimeout(timer);
  }, [post]);

  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((i) => Math.min(posts.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; };
  }, [onClose, posts.length]);

  if (!post) return null;
  return <div className="story-viewer" role="dialog" aria-modal="true" aria-label={`Briefing, story ${index + 1} of ${posts.length}`}>
    <div className="story-bar">
      <button ref={close} type="button" className="text-button" onClick={onClose}><ArrowLeft size={15} aria-hidden="true" /> Back to your feed</button>
      <span className="story-dots" aria-hidden="true">{posts.map((p, i) => <span key={p.id} className={i === index ? "dot dot-on" : "dot"} />)}</span>
    </div>
    <div className="story-body">
      <PostCard post={post} index={index} state={states[post.id] ?? emptyPost} disabled={false} onChange={(patch) => onChange(post.id, patch)} />
    </div>
    <div className="story-nav">
      <button type="button" className="load-button" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={17} aria-hidden="true" /> Previous</button>
      {index < posts.length - 1
        ? <button type="button" className="load-button" onClick={() => setIndex(index + 1)}>Next story <ChevronRight size={17} aria-hidden="true" /></button>
        : <button type="button" className="load-button" onClick={onClose}>Done</button>}
    </div>
  </div>;
}

const AGAIN = ["in about a week", "in about three weeks", "in about two months", "no more: it has stuck"];

/**
 * An Echo card (SPEC §2): a valued insight brought back for recall, the insight hidden until tapped. Its own
 * two answers replace the five controls, which belong to new posts. No score is kept or shown.
 */
export function EchoCard({ echo, onAnswer, onDone }: { echo: Echo; onAnswer: (remembered: boolean) => Promise<boolean>; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const [saying, setSaying] = useState<string | null>(null);
  const place = placeOf(echo.post.field);
  async function answer(remembered: boolean) {
    const saved = await onAnswer(remembered);
    setSaying(!saved ? "That could not be saved; it will come back next time." : remembered ? `Good. It will come back ${AGAIN[echo.stage]}.` : "It will come back in two days.");
    setTimeout(onDone, 2200);
  }
  return <section className="post-card echo-card" aria-labelledby={`echo-${echo.post.id}`}>
    <div className="post-body">
      <div className="post-meta"><span className="topic topic-3">{place?.field.label ?? echo.post.topic}</span><span className="sample">REMEMBER THIS?</span></div>
      <h2 id={`echo-${echo.post.id}`}>{echo.post.title}</h2>
      {!shown
        ? <button type="button" className="load-button" onClick={() => setShown(true)}>What was the key insight? Show it</button>
        : <aside className="echo-insight"><span className="eyebrow">KEY INSIGHT</span><p>{echo.post.insight}</p></aside>}
      {shown && !saying && <div className="echo-answers" role="group" aria-label="Did you remember it?">
        <button type="button" className="steer-button" onClick={() => void answer(true)}>I remembered</button>
        <button type="button" className="steer-button" onClick={() => void answer(false)}>I&apos;d forgotten</button>
      </div>}
      {saying && <p className="map-note" role="status">{saying}</p>}
    </div>
  </section>;
}
