"use client";

import { ArrowUpRight } from "lucide-react";
import type { Post, PostState } from "@/types/post";
import { FeedbackBar } from "./FeedbackBar";

interface Props {
  post: Post;
  index: number;
  state: PostState;
  disabled: boolean;
  onChange: (patch: Partial<PostState>) => void;
}

export function PostCard({ post, index, state, disabled, onChange }: Props) {
  return <article id={post.id} data-post-id={post.id} aria-labelledby={`title-${post.id}`} className="post-card" tabIndex={-1}>
    <div className="post-body">
      <div className="post-meta"><span className={`topic topic-${index % 4}`}>{post.topic}</span><span className="sample">SAMPLE</span><span className="post-number">{String(index + 1).padStart(2, "0")}</span></div>
      <h2 id={`title-${post.id}`}>{post.title}</h2>
      <div className="explanation">{post.explanation.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
      <aside className="insight"><span className="eyebrow">KEY INSIGHT</span><p>{post.insight}</p></aside>
      <section id={`deeper-${post.id}`} className="deeper" hidden={!state.expanded} aria-labelledby={`deeper-title-${post.id}`}>
        <h3 id={`deeper-title-${post.id}`}>A little deeper</h3><p>{post.deeper}</p>
      </section>
      {post.source && <a className="source" href={post.source.url} target="_blank" rel="noreferrer noopener">{post.source.label}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>}
    </div>
    <FeedbackBar postId={post.id} state={state} disabled={disabled} onChange={onChange} />
  </article>;
}
