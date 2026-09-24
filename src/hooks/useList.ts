"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Post } from "@/types/post";
import { appendPosts, coercePosts } from "@/lib/storage";

const LIST_PAGE = 20;

/**
 * Saved ("bookmarked") or Read posts, newest first, fetched when the list is opened. These come from the
 * server rather than the feed cache, since read posts leave the feed. Offline, `fallback` (what the feed
 * already holds) is shown instead.
 */
export function useList(client: SupabaseClient, kind: "bookmarked" | "read", open: boolean, fallback: Post[]) {
  const [items, setItems] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [offline, setOffline] = useState(false);
  const busy = useRef(false);
  const fallbackRef = useRef(fallback);
  useEffect(() => {
    fallbackRef.current = fallback;
  });

  const load = useCallback(
    async (offset: number) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const { data, error } = await client.rpc("saved_page", { p_kind: kind, p_offset: offset, p_limit: LIST_PAGE });
        if (error) throw error;
        const page = coercePosts(data);
        setOffline(false);
        setItems((previous) => (offset === 0 ? page : appendPosts(previous, page)));
        setAtEnd(page.length < LIST_PAGE);
      } catch {
        if (offset === 0) {
          setOffline(true);
          setItems(fallbackRef.current);
          setAtEnd(true);
        }
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [client, kind],
  );

  // Refetch on every opening, so a post read or saved a moment ago is listed.
  useEffect(() => {
    if (open) void load(0);
  }, [open, load]);

  const more = useCallback(() => void load(items.length), [load, items.length]);
  return { items, loading, atEnd, offline, more };
}
