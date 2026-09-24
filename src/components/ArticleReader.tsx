"use client";
import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { BodyBlock, Post } from "@/types/post";
import { coerceBlocks } from "@/lib/storage";

const day = (iso: string | null | undefined) =>
  iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null;

/** One block of a saved article. Text only: React escapes it, and nothing from the feed is ever markup. */
function Block({ block }: { block: BodyBlock }) {
  switch (block.t) {
    case "h": return <h2>{block.text}</h2>;
    case "q": return <blockquote><p>{block.text}</p></blockquote>;
    case "ul": return <ul>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
    case "ol": return <ol>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ol>;
    case "table": return <div className="reader-table" role="region" aria-label="Table" tabIndex={0}>
      <table><tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c} scope="col">{cell}</th> : <td key={c}>{cell}</td>)}</tr>)}</tbody></table>
    </div>;
    default: return <p>{block.text}</p>;
  }
}

/**
 * The article as its publisher's feed carried it, laid out for reading, for sites behind a sign-in or
 * subscription. Opens over the feed; Back (or the phone's back gesture) returns to the same place.
 */
export function ArticleReader({ client, post, onClose }: { client: SupabaseClient; post: Post; onClose: () => void }) {
  const [blocks, setBlocks] = useState<BodyBlock[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const back = useRef<HTMLButtonElement | null>(null);
  const source = post.sources?.[0];
  const url = source?.url ?? post.source?.url;
  const publisher = source?.publisher ?? "the publisher";

  // Load on open and on each retry; state is set only in the promise callbacks.
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => client.rpc("post_body", { p_post_id: post.id }))
      .then(({ data, error }) => {
        if (!active) return;
        const loaded = error ? null : coerceBlocks(data);
        if (!loaded) throw new Error("No saved article");
        setBlocks(loaded);
        setFailed(false);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [client, post.id, attempt]);

  // Focus Back on open; Escape closes; the page behind does not scroll while this is open.
  useEffect(() => {
    back.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; };
  }, [onClose]);

  const original = url && <a className="source" href={url} target="_blank" rel="noreferrer noopener">
    Open the original on {publisher}<ArrowUpRight size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>;
  return <div className="reader" role="dialog" aria-modal="true" aria-labelledby="reader-title">
    <div className="reader-bar">
      <button ref={back} type="button" className="text-button reader-back" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" /> Back to your feed</button>
    </div>
    <article className="reader-column">
      <p className="eyebrow">{publisher.toUpperCase()}</p>
      <h1 id="reader-title">{source?.title ?? post.title}</h1>
      <p className="reader-byline">{[source?.author && `By ${source.author}`, day(source?.articleDate)].filter(Boolean).join(" · ")}</p>
      {blocks ? <div className="reader-text">{blocks.map((block, i) => <Block key={i} block={block} />)}</div>
        : failed ? <p role="alert" className="storage-warning">The saved article could not be loaded. Check your connection.{" "}
            <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></p>
        : <p role="status" className="reader-loading">Loading the article…</p>}
      <footer className="reader-note">
        <p>Saved from {publisher}&apos;s feed for your own reading. Images, links and layout are left out.</p>
        {original}
      </footer>
    </article>
  </div>;
}
