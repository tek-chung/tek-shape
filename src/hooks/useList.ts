"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Post } from "@/types/post";
import { appendPosts, coercePosts } from "@/lib/storage";

const LIST_PAGE = 20;

interface ListData { items: Post[]; atEnd: boolean; offline: boolean; loaded: boolean }
const unloaded: ListData = { items: [], atEnd: false, offline: false, loaded: false };

/**
 * Saved ("bookmarked") or Read posts, newest first, fetched when the list is opened. These come from the
 * server rather than the feed cache, since read posts leave the feed. Offline, `fallback` (what the feed
 * already holds) is shown instead.
 */
export function useList(client: SupabaseClient, kind: "bookmarked" | "read", open: boolean, fallback: Post[]) {
  const [data, setData] = useState<ListData>(unloaded);
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  });

  // Fetching only: state is set by whoever awaits it, never synchronously inside an effect.
  const fetchPage = useCallback(async (offset: number) => {
    const { data: rows, error } = await client.rpc("saved_page", { p_kind: kind, p_offset: offset, p_limit: LIST_PAGE });
    if (error) throw error;
    return coercePosts(rows);
  }, [client, kind]);

  // Refetch on every opening, so a post read or saved a moment ago is listed. The previous copy stays on
  // screen until the fresh one arrives.
  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.resolve()
      .then(() => fetchPage(0))
      .then((page) => { if (active) setData({ items: page, atEnd: page.length < LIST_PAGE, offline: false, loaded: true }); })
      .catch(() => { if (active) setData({ items: fallbackRef.current, atEnd: true, offline: true, loaded: true }); });
    return () => { active = false; };
  }, [open, fetchPage]);

  const more = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchPage(data.items.length);
      setData((previous) => ({ ...previous, items: appendPosts(previous.items, page), atEnd: page.length < LIST_PAGE }));
    } catch {
      // Keep what is already listed; the button stays available to try again.
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [fetchPage, data.items.length]);

  return { items: data.items, loading: (open && !data.loaded) || loadingMore, atEnd: data.atEnd, offline: data.offline, more: () => void more() };
}
