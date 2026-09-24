"use client";

import { ArrowUpRight } from "lucide-react";
import type { Post, PostState } from "@/types/post";
import type { PostPatch } from "@/lib/storage";
import { FeedbackBar } from "./FeedbackBar";

interface Props {
  post: Post;
  index: number;
  state: PostState;
  disabled: boolean;
  onChange: (patch: PostPatch) => void;
}

export function PostCard({ post, index, state, disabled, onChange }: Props) {
  // Always show where a post came from. Sample posts carry `source`; generated posts carry `sources`.
  const first = post.sources?.[0];
  const link = post.source ?? (first ? { label: `${first.publisher}: ${first.title}`, url: first.url } : null);
  const extra = post.sources && post.sources.length > 1 ? post.sources : [];
  return <article id={post.id} data-post-id={post.id} aria-labelledby={`title-${post.id}`} className="post-card" tabIndex={-1}>
    <div className="post-body">
      <div className="post-meta"><span className={`topic topic-${index % 4}`}>{post.topic}</span><span className="sample">{post.status === "published" ? post.contentType === "news" ? "NEWS" : "EVERGREEN" : "SAMPLE"}</span><span className="post-number">{String(index + 1).padStart(2, "0")}</span></div>
      <h2 id={`title-${post.id}`}>{post.title}</h2>
      <div className="explanation">{post.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
      <aside className="insight"><span className="eyebrow">KEY INSIGHT</span><p>{post.insight}</p></aside>
      <section id={`deeper-${post.id}`} className="deeper" hidden={!state.expanded} aria-labelledby={`deeper-title-${post.id}`}>
        <h3 id={`deeper-title-${post.id}`}>A little deeper</h3><p>{post.deeper}</p>
      </section>
      {link && <a className="source" href={link.url} target="_blank" rel="noreferrer noopener">Read the original · {link.label}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>}
      {first && <p className="source-meta">Published {first.articleDate?.slice(0,10) ?? "date unavailable"}</p>}
      {post.eventDate && <p className="source-meta">Event date: {post.eventDate}</p>}
      {!!extra.length && <details className="post-sources"><summary>All sources · {extra.length}</summary>
        {extra.map((source) => <div key={source.url}>
          <a className="source" href={source.url} target="_blank" rel="noreferrer noopener">{source.publisher}: {source.title}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
          <p className="source-meta">Published {source.articleDate?.slice(0,10) ?? "date unavailable"} · Accessed {source.accessedAt.slice(0,10)}</p>
        </div>)}
      </details>}
    </div>
    <FeedbackBar postId={post.id} state={state} disabled={disabled} onChange={onChange} />
  </article>;
}
