"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Post, ReadingPosition, ReadingState } from "@/types/post";
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
  readLocal,
  readOutbox,
  readPosts,
  readState,
  visitKey,
  writeLocal,
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

// Coming back to the app after this long starts a new sitting, as a reload does.
const RESUME_AFTER_MS = 30 * 60_000;

const OFFLINE_NOTICE = "Saved on this device. Your changes will sync when you’re back online.";
const LOAD_NOTICE = "Your private feed could not be refreshed. You’re reading the last copy saved on this device.";
const COLD_NOTICE = "Your private feed could not be loaded. Check your connection and account access, then retry.";

/** Read before this moment means "already read": hidden from the feed, listed under Read. */
const readBefore = (state: ReadingState | null, id: string, since: string) => {
  const readAt = state?.posts[id]?.readAt;
  // Compare as times: the server and this device write timestamps in different formats.
  return !!readAt && Date.parse(readAt) < Date.parse(since);
};

/** Posts that joined the feed after the previous sitting began. */
export interface Fresh { count: number; firstId: string }

/**
 * Local-first reading state and content paging.
 *
 * The UI reads and writes local state immediately. Every write is also recorded
 * in an outbox persisted to localStorage and flushed to Supabase in the
 * background, so a dropped mobile connection costs nothing and nothing is lost
 * across a reload. A refresh replays the outbox on top of the server snapshot,
 * so pulling never discards work that has not synced yet.
 *
 * The feed holds what you have not read. A sitting begins when the app is opened
 * or reloaded, when you tap Refresh, or when you come back after half an hour
 * away. Each sitting reloads the unread feed from the server: posts read before it
 * began move to Read, new posts are fetched, and you are told how many arrived.
 * Within a sitting, posts you read stay where they are, so nothing jumps.
 * Content is paged by queue position and cached, so reading offline works.
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
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [sitting, setSitting] = useState(0);
  const exhaustedRef = useRef(false);
  // When this sitting began (fixed for its life, so posts never vanish mid-scroll), when the previous one
  // did, and whether the feed still needs reloading from the start for this sitting.
  const sinceRef = useRef("");
  const previousVisit = useRef<string | null>(null);
  const needsRebuild = useRef(true);
  // When Refresh (or a return after a while) asked for the view to go back to the top. Honoured only if
  // the reload follows promptly, so a refresh made offline does not jump the page much later.
  const scrollToTop = useRef(0);

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
          const { data, error: rpcError } = await client.rpc("feed_page", {
            p_after_id: list.at(-1)?.id ?? null,
            p_limit: PAGE_SIZE,
            p_read_before: sinceRef.current,
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
          exhaustedRef.current = exhausted;
          setAtEnd(exhausted);
          setPaging(false);
        }
        fetching.current = false;
      }
    },
    [client, userId],
  );

  /**
   * Reload the unread feed from the start for a new sitting, to the same depth as before (at least a page):
   * read posts drop out, including reads made on this device that have not synced yet, and the server says
   * how many posts joined the feed since the previous sitting.
   */
  const rebuild = useCallback(
    async (merged: ReadingState) => {
      if (fetching.current) {
        needsRebuild.current = true;
        return;
      }
      fetching.current = true;
      if (active.current) setPaging(true);
      const since = sinceRef.current;
      const depth = Math.max(PAGE_SIZE, held.current.length);
      let list: Post[] = [];
      let exhausted = false;
      let ok = true;
      try {
        for (let page = 0; page < MAX_PAGES_PER_RUN && list.length < depth && !exhausted; page += 1) {
          const { data, error: rpcError } = await client.rpc("feed_page", {
            p_after_id: list.at(-1)?.id ?? null,
            p_limit: PAGE_SIZE,
            p_read_before: since,
          });
          if (rpcError) {
            ok = false;
            break;
          }
          const fetched = coercePosts(data);
          if (fetched.length < PAGE_SIZE) exhausted = true;
          const grown = appendPosts(list, fetched);
          if (grown === list) break;
          list = grown;
        }
      } catch {
        ok = false;
      } finally {
        if (active.current) {
          // Offline or a failed page: keep the copy on this device, and try the full reload again next sync.
          if (!ok) needsRebuild.current = true;
          const next = (ok ? list : held.current).filter((post) => !readBefore(merged, post.id, since));
          held.current = next;
          setPosts(next);
          writePosts(userId, next);
          if (ok) {
            exhaustedRef.current = exhausted;
            setAtEnd(exhausted);
            if (scrollToTop.current && Date.now() - scrollToTop.current < 15_000) setSitting((value) => value + 1);
            scrollToTop.current = 0;
          }
          setPaging(false);
        }
        fetching.current = false;
      }
      // What joined the feed since the previous sitting. Optional: without it there is simply no notice.
      if (ok && previousVisit.current && active.current) {
        try {
          const { data, error: rpcError } = await client.rpc("feed_summary", { p_read_before: since, p_since: previousVisit.current });
          const summary = !rpcError && data && typeof data === "object" ? (data as { arrivals?: unknown; firstArrival?: unknown }) : null;
          const count = typeof summary?.arrivals === "number" ? summary.arrivals : 0;
          const firstId = typeof summary?.firstArrival === "string" ? summary.firstArrival : null;
          if (active.current) setFresh(count > 0 && firstId ? { count, firstId } : null);
        } catch {
          // Offline: no notice this time.
        }
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
      if (needsRebuild.current) {
        // First sync of a sitting: reload the unread feed from the server.
        needsRebuild.current = false;
        await rebuild(merged);
      } else {
        // Drop anything another device marked read before this sitting began.
        const kept = held.current.filter((post) => !readBefore(merged, post.id, sinceRef.current));
        if (kept.length !== held.current.length) {
          held.current = kept;
          setPosts(kept);
          writePosts(userId, kept);
        }
        // At the end of the feed, look again: the scheduler adds new posts every few hours.
        await loadUpTo(Math.max(PAGE_SIZE, held.current.length + (exhaustedRef.current ? 1 : 0)));
      }
      if (restorePosition && active.current) setRestore((value) => value + 1);
      return true;
    },
    [client, loadUpTo, rebuild, userId],
  );

  const sync = useCallback(
    async (restorePosition = false) => {
      // Push first, so the snapshot pulled back already reflects this device.
      await flush();
      await refresh(restorePosition);
    },
    [flush, refresh],
  );

  /** Begin a new sitting: the next sync reloads the feed, and the view returns to the top. */
  const startSitting = useCallback(() => {
    previousVisit.current = sinceRef.current || previousVisit.current;
    sinceRef.current = new Date().toISOString();
    writeLocal(visitKey(userId), sinceRef.current);
    needsRebuild.current = true;
    scrollToTop.current = Date.now();
  }, [userId]);

  useEffect(() => {
    active.current = true;
    outbox.current = readOutbox(userId);
    setPending(outboxSize(outbox.current));

    // Opening or reloading the app starts a sitting. Remember when the last one began, to count arrivals.
    if (!sinceRef.current) {
      sinceRef.current = new Date().toISOString();
      previousVisit.current = readLocal(visitKey(userId));
      writeLocal(visitKey(userId), sinceRef.current);
      needsRebuild.current = true;
    }
    const since = sinceRef.current;

    // Show the cached copy straight away; the network catches up behind it.
    const cached = readState(userId);
    const cachedPosts = readPosts(userId).filter((post) => !readBefore(cached, post.id, since));
    if (cachedPosts.length) {
      held.current = cachedPosts;
      setPosts(cachedPosts);
    }
    if (cached && cachedPosts.length) {
      loaded.current = true;
      setState(applyOutbox(cached, outbox.current, new Date().toISOString()));
      setReady(true);
      setRestore((value) => value + 1);
    }
    void sync(!(cached && cachedPosts.length));

    // Coming back after a while counts as a new sitting, as a reload does; a quick glance away does not.
    let hiddenAt = 0;
    const resume = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt > RESUME_AFTER_MS) startSitting();
      hiddenAt = 0;
      void sync();
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
  }, [sync, userId, startSitting]);

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
  /** The Refresh button: a new sitting now. */
  const refreshFeed = useCallback(() => {
    startSitting();
    void sync();
  }, [startSitting, sync]);
  const dismissFresh = useCallback(() => setFresh(null), []);
  /** Page in until the given post is held (new posts sit at the end of the feed). True once it is. */
  const reveal = useCallback(async (postId: string) => {
    for (let page = 0; page < MAX_PAGES_PER_RUN && !held.current.some((post) => post.id === postId) && !exhaustedRef.current; page += 1) {
      const before = held.current.length;
      await loadUpTo(before + PAGE_SIZE);
      if (held.current.length === before) break;
    }
    return held.current.some((post) => post.id === postId);
  }, [loadUpTo]);

  return {
    state,
    posts,
    ready,
    pending,
    syncing,
    paging,
    atEnd,
    fresh,
    sitting,
    error,
    restore,
    savePost,
    saveProgress,
    loadMore,
    retry: retryNow,
    refreshFeed,
    dismissFresh,
    reveal,
  };
}
