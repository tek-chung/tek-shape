"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cursor, Post, ReadingPosition, ReadingState } from "@/types/post";
import {
  appendPosts,
  applyOutbox,
  applyPatch,
  coercePosts,
  coerceState,
  emptyOutbox,
  emptyPost,
  initialState,
  mergePatch,
  outboxSize,
  readOutbox,
  readPosts,
  readState,
  writeOutbox,
  writePosts,
  writeState,
  type Outbox,
  type PostPatch,
} from "@/lib/storage";

export const PAGE_SIZE = 8;
const POLL_MS = 30_000;
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];
const MAX_PASSES = 5;
// Bounds the catch-up when restoring a deep reading position on a fresh device.
const MAX_PAGES_PER_RUN = 25;

const OFFLINE_NOTICE = "Saved on this device. Your changes will sync when you’re back online.";
const LOAD_NOTICE = "Your private feed could not be refreshed. You’re reading the last copy saved on this device.";
const COLD_NOTICE = "Your private feed could not be loaded. Check your connection and account access, then retry.";

const cursorOf = (post: Post | undefined): Cursor | null =>
  post ? { publishedAt: post.publishedAt, id: post.id } : null;

/**
 * Local-first reading state and content paging.
 *
 * The UI reads and writes local state immediately. Every write is also recorded
 * in an outbox persisted to localStorage and flushed to Supabase in the
 * background, so a dropped mobile connection costs nothing and nothing is lost
 * across a reload. A refresh replays the outbox on top of the server snapshot,
 * so pulling never discards work that has not synced yet.
 *
 * Content is paged with a keyset cursor and cached alongside, so a reload
 * restores the same depth — and the same scroll position — without a network
 * round trip, and reading offline works from the cache.
 */
export function useReading(client: SupabaseClient, userId: string) {
  const [state, setState] = useState<ReadingState>(initialState);
  const [posts, setPosts] = useState<Post[]>([]);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [paging, setPaging] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [error, setError] = useState("");
  const [restore, setRestore] = useState(0);

  const active = useRef(true);
  const loaded = useRef(false);
  const outbox = useRef<Outbox>(emptyOutbox);
  const held = useRef<Post[]>([]);
  const flushing = useRef(false);
  const fetching = useRef(false);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Lets the retry timer reach the current flush without the callback referencing itself.
  const flushLater = useRef<(() => Promise<boolean>) | null>(null);

  // Persisting in an effect keeps side effects out of the state updaters below,
  // which React may invoke more than once per render.
  useEffect(() => {
    if (loaded.current) writeState(userId, state);
  }, [state, userId]);

  const commit = useCallback(
    (next: Outbox) => {
      outbox.current = next;
      writeOutbox(userId, next);
      if (active.current) setPending(outboxSize(next));
    },
    [userId],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    if (flushing.current || !outboxSize(outbox.current)) return true;
    flushing.current = true;
    if (active.current) setSyncing(true);
    let failed = false;

    // Taps made mid-pass are blocked from starting their own flush, so drain
    // repeatedly rather than leaving them until the next poll. Bounded, so a
    // burst of writes can never spin here.
    for (let pass = 0; pass < MAX_PASSES && !failed && outboxSize(outbox.current); pass += 1) {
      try {
        for (const [postId, patch] of Object.entries(outbox.current.posts)) {
          const { error: rpcError } = await client.rpc("save_post", { p_post_id: postId, p_patch: patch });
          if (rpcError) {
            failed = true;
            break;
          }
          // Drop only the entry just acknowledged; a patch merged mid-flight stays queued.
          const remaining = { ...outbox.current.posts };
          if (remaining[postId] === patch) delete remaining[postId];
          commit({ ...outbox.current, posts: remaining });
        }

        const progress = outbox.current.progress;
        if (!failed && progress) {
          const { error: rpcError } = await client.rpc("save_progress", {
            p_loaded_count: progress.loadedCount,
            p_post_id: progress.position?.postId ?? null,
            p_offset: progress.position?.offset ?? 0,
          });
          if (rpcError) failed = true;
          else if (outbox.current.progress === progress) commit({ ...outbox.current, progress: null });
        }
      } catch {
        failed = true;
      }
    }

    flushing.current = false;
    if (!active.current) return !failed;
    setSyncing(false);

    if (failed) {
      failures.current += 1;
      setError(OFFLINE_NOTICE);
      clearTimeout(retry.current);
      retry.current = setTimeout(
        () => void flushLater.current?.(),
        RETRY_MS[Math.min(failures.current - 1, RETRY_MS.length - 1)],
      );
    } else {
      failures.current = 0;
      setError((previous) => (previous === OFFLINE_NOTICE ? "" : previous));
    }
    return !failed;
  }, [client, commit]);

  useEffect(() => {
    flushLater.current = flush;
  }, [flush]);

  /** Page in content until `target` posts are held, or the feed runs out. */
  const loadUpTo = useCallback(
    async (target: number) => {
      if (fetching.current || held.current.length >= target) return;
      fetching.current = true;
      if (active.current) setPaging(true);
      let list = held.current;
      let exhausted = false;

      // try/finally, so a thrown rejection can never strand the fetching guard
      // and leave paging dead for the rest of the session.
      try {
        for (let page = 0; page < MAX_PAGES_PER_RUN && list.length < target && !exhausted; page += 1) {
          const after = cursorOf(list.at(-1));
          const { data, error: rpcError } = await client.rpc("reading_page", {
            p_after_published_at: after?.publishedAt ?? null,
            p_after_id: after?.id ?? null,
            p_limit: PAGE_SIZE,
          });
          // Keep whatever is already held rather than clearing the feed on a failure.
          if (rpcError) break;
          const fetched = coercePosts(data);
          if (fetched.length < PAGE_SIZE) exhausted = true;
          const grown = appendPosts(list, fetched);
          if (grown === list) break; // A page of entirely known ids: stop rather than spin.
          list = grown;
        }
      } catch {
        // Offline or a transport failure: keep what is already held.
      } finally {
        if (active.current) {
          held.current = list;
          setPosts(list);
          writePosts(userId, list);
          if (exhausted) setAtEnd(true);
          setPaging(false);
        }
        fetching.current = false;
      }
    },
    [client, userId],
  );

  const refresh = useCallback(
    async (restorePosition = false) => {
      let server: ReadingState | null = null;
      try {
        const { data, error: rpcError } = await client.rpc("reading_state");
        if (!active.current) return false;
        if (!rpcError) server = coerceState(data);
      } catch {
        // Offline or a transport failure; fall through to the cached copy.
      }
      if (!active.current) return false;
      if (!server) {
        // A cached copy keeps the app usable, so only a cold start is a hard failure.
        setError((previous) => (previous === OFFLINE_NOTICE ? previous : loaded.current ? LOAD_NOTICE : COLD_NOTICE));
        return false;
      }
      const merged = applyOutbox(server, outbox.current, new Date().toISOString());
      setState(merged);
      loaded.current = true;
      setReady(true);
      setError((previous) => (previous === OFFLINE_NOTICE ? previous : ""));
      // Catch the content up to the depth this account had reached, so the saved
      // scroll position has something to anchor to.
      const shallow = merged.loadedCount > held.current.length;
      await loadUpTo(Math.max(PAGE_SIZE, merged.loadedCount));
      // Restore again when the server was ahead of this device's cache — otherwise
      // a position saved on another phone has nothing to scroll to on arrival.
      if ((restorePosition || shallow) && active.current) setRestore((value) => value + 1);
      return true;
    },
    [client, loadUpTo],
  );

  const sync = useCallback(
    async (restorePosition = false) => {
      // Push first, so the snapshot pulled back already reflects this device.
      await flush();
      await refresh(restorePosition);
    },
    [flush, refresh],
  );

  useEffect(() => {
    active.current = true;
    outbox.current = readOutbox(userId);
    setPending(outboxSize(outbox.current));

    // Show the cached copy straight away; the network catches up behind it.
    const cachedPosts = readPosts(userId);
    if (cachedPosts.length) {
      held.current = cachedPosts;
      setPosts(cachedPosts);
    }
    const cached = readState(userId);
    if (cached && cachedPosts.length) {
      loaded.current = true;
      setState(applyOutbox(cached, outbox.current, new Date().toISOString()));
      setReady(true);
      setRestore((value) => value + 1);
    }
    void sync(!(cached && cachedPosts.length));

    const resume = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const online = () => void sync();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, POLL_MS);

    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", online);
    return () => {
      active.current = false;
      clearInterval(timer);
      clearTimeout(retry.current);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", online);
    };
  }, [sync, userId]);

  const savePost = useCallback(
    (id: string, patch: PostPatch) => {
      const now = new Date().toISOString();
      setState((previous) => ({
        ...previous,
        posts: { ...previous.posts, [id]: applyPatch(previous.posts[id] ?? emptyPost, patch, now) },
      }));
      commit({
        ...outbox.current,
        posts: { ...outbox.current.posts, [id]: mergePatch(outbox.current.posts[id], patch) },
      });
      void flush();
    },
    [commit, flush],
  );

  const saveProgress = useCallback(
    (count: number, position: ReadingPosition | null) => {
      setState((previous) => ({
        ...previous,
        loadedCount: Math.max(previous.loadedCount, count),
        position: position ?? previous.position,
      }));
      const queued = outbox.current.progress;
      commit({
        ...outbox.current,
        progress: {
          loadedCount: Math.max(queued?.loadedCount ?? 0, count),
          position: position ?? queued?.position ?? null,
        },
      });
      void flush();
    },
    [commit, flush],
  );

  /** Pull in the next page and remember the new depth. */
  const loadMore = useCallback(async () => {
    if (fetching.current || atEnd) return;
    const target = held.current.length + PAGE_SIZE;
    await loadUpTo(target);
    if (active.current) saveProgress(held.current.length, null);
  }, [atEnd, loadUpTo, saveProgress]);

  const retryNow = useCallback(() => void sync(true), [sync]);

  return {
    state,
    posts,
    ready,
    pending,
    syncing,
    paging,
    atEnd: atEnd || (state.total > 0 && posts.length >= state.total),
    error,
    restore,
    savePost,
    saveProgress,
    loadMore,
    retry: retryNow,
  };
}
