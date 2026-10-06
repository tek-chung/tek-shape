"use client";

import { useState } from "react";
import { placeOf } from "@/lib/taxonomy";
import { levelOf } from "@/lib/levels";
import { ArrowUpRight, BookText } from "lucide-react";
import type { Post, PostState } from "@/types/post";
import type { PostPatch } from "@/lib/storage";
import { FeedbackBar } from "./FeedbackBar";

interface Props {
  post: Post;
  index: number;
  state: PostState;
  disabled: boolean;
  onChange: (patch: PostPatch) => void;
  /** Open the article saved from the feed, when there is one. */
  onRead?: () => void;
  /** Feed only: fetch why the engine placed this post, as plain sentences. */
  onWhy?: () => Promise<string[]>;
}

export function PostCard({ post, index, state, disabled, onChange, onRead, onWhy }: Props) {
  // "Why this post?" opens in place, like the deeper explanation, and is fetched only when asked for.
  const [why, setWhy] = useState<string[] | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  function toggleWhy() {
    if (whyOpen) { setWhyOpen(false); return; }
    setWhyOpen(true);
    if (!why && onWhy) onWhy().then(setWhy, () => setWhy(["The reasons could not be loaded. Check your connection and try again."]));
  }
  const place = placeOf(post.field);
  const excerpt = post.kind === "excerpt";
  // Always show where a post came from. Sample posts carry `source`; generated posts carry `sources`.
  const first = post.sources?.[0];
  const link = post.source ?? (first ? { label: `${first.publisher}: ${first.title}`, url: first.url } : null);
  const extra = post.sources && post.sources.length > 1 ? post.sources : [];
  const label = post.status !== "published" ? "SAMPLE" : excerpt ? "EXCERPT" : post.contentType === "news" ? "NEWS" : "EVERGREEN";
  // The level on the difficulty scale, shown short ("L3"), named in full for screen readers and on hover.
  const level = levelOf(post.difficulty);
  return <article id={post.id} data-post-id={post.id} aria-labelledby={`title-${post.id}`} className="post-card" tabIndex={-1}>
    <div className="post-body">
      <div className="post-meta"><span className={`topic topic-${index % 4}`} title={place ? `${place.umbrella.label} › ${place.field.label}` : post.topic}>{place && place.field.id !== "general" ? place.field.label : post.topic}{post.subtopic && place?.field.id !== "general" ? <span className="subtopic"> · {post.subtopic}</span> : null}</span><span className="sample">{label}{level && <> · <abbr title={`Level ${level.level}, ${level.name}: assumes ${level.assumes}`} aria-label={`Level ${level.level}, ${level.name}`}>L{level.level}</abbr></>}</span>{onWhy && <button type="button" className="why-button" aria-expanded={whyOpen} aria-controls={`why-${post.id}`} onClick={toggleWhy}>Why?<span className="sr-only"> Why this post is in your feed</span></button>}<span className="post-number">{String(index + 1).padStart(2, "0")}</span></div>
      {whyOpen && <div id={`why-${post.id}`} className="why" role="note">
        {why ? why.map((line) => <p key={line}>{line}</p>) : <p>Loading…</p>}
      </div>}
      <h2 id={`title-${post.id}`}>{post.title}</h2>
      {excerpt
        // The publisher's own words, shown as they wrote them. The class lets the feed count it as read.
        ? <div className="explanation excerpt">{post.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            <p className="excerpt-note">From {first?.publisher ?? "the publisher"}, in their words. No AI summary for this source.</p></div>
        : <>
          <div className="explanation">{post.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
          <aside className="insight"><span className="eyebrow">KEY INSIGHT</span><p>{post.insight}</p></aside>
          <section id={`deeper-${post.id}`} className="deeper" hidden={!state.expanded} aria-labelledby={`deeper-title-${post.id}`}>
            <h3 id={`deeper-title-${post.id}`}>A little deeper</h3><p>{post.deeper}</p>
          </section>
        </>}
      {link && <a className="source" href={link.url} target="_blank" rel="noreferrer noopener" onClick={() => onChange({ read: true, opened: true })}>Read the original · {link.label}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>}
      {post.hasBody && onRead && <button type="button" className="source source-button" onClick={onRead}>
        <BookText size={15} aria-hidden="true" /> Read the full article here<span className="sr-only">, saved from {first?.publisher ?? "the publisher"}&apos;s feed</span>
      </button>}
      {first && <p className="source-meta">Published {first.articleDate?.slice(0,10) ?? "date unavailable"}{first.licence ? ` · ${first.publisher}, ${first.licence}` : ""}</p>}
      {post.eventDate && <p className="source-meta">Event date: {post.eventDate}</p>}
      {!!extra.length && <details className="post-sources"><summary>All sources · {extra.length}</summary>
        {extra.map((source) => <div key={source.url}>
          <a className="source" href={source.url} target="_blank" rel="noreferrer noopener" onClick={() => onChange({ read: true, opened: true })}>{source.publisher}: {source.title}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
          <p className="source-meta">Published {source.articleDate?.slice(0,10) ?? "date unavailable"} · Accessed {source.accessedAt.slice(0,10)}</p>
        </div>)}
      </details>}
    </div>
    <FeedbackBar postId={post.id} state={state} disabled={disabled} onChange={onChange} canExpand={!excerpt} />
  </article>;
}
