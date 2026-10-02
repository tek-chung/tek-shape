"use client";
import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Post } from "@/types/post";
import { coercePost, coercePosts } from "@/lib/storage";
import { POST_COLUMNS, asPostJson, type Row } from "@/lib/postRows";

/** An insight brought back for recall, at a stage from 0 (first return) to 3. */
export interface Echo { post: Post; stage: number }

const DAY = 86_400_000;

/**
 * The two things around the feed that are not the feed: today's Briefing ring and the Echo cards due. Both are
 * fetched once per sitting (`sitting` changes on Refresh and on return after a while), and both are optional:
 * offline, or before migration 202610060001, there is simply no ring and no echoes.
 */
export function useExtras(client: SupabaseClient, ready: boolean, sitting: number) {
  const [briefing, setBriefing] = useState<Post[]>([]);
  const [echoes, setEchoes] = useState<Echo[]>([]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    Promise.resolve()
      .then(() => client.from("briefing").select(`rank,prepared_at,post:post_id(${POST_COLUMNS})`).order("rank"))
      .then(({ data, error }) => {
        if (!active || error || !Array.isArray(data)) return;
        // A ring lasts a day: one prepared longer ago than that (no run since) is not shown.
        const fresh = (data as Row[]).filter((row) => Date.now() - Date.parse(String(row.prepared_at)) < DAY);
        setBriefing(coercePosts(fresh.map((row) => (row.post && typeof row.post === "object" ? asPostJson(row.post as Row) : null))));
      })
      .catch(() => {});
    Promise.resolve()
      .then(() => client.rpc("echo_due", { p_limit: 3 }))
      .then(({ data, error }) => {
        if (!active || error || !Array.isArray(data)) return;
        setEchoes(data.flatMap((entry: unknown) => {
          const post = coercePost(entry);
          const stage = (entry as { echoStage?: unknown })?.echoStage;
          return post && typeof stage === "number" && stage >= 0 && stage <= 3 && post.insight ? [{ post, stage }] : [];
        }));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [client, ready, sitting]);

  /** Record whether an echo was remembered; it leaves the feed either way. Returns false if not saved. */
  const answer = useCallback(async (postId: string, remembered: boolean) => {
    try {
      const { error } = await client.rpc("echo_answer", { p_post_id: postId, p_remembered: remembered });
      return !error || /Not due/.test(error.message ?? "");
    } catch {
      return false;
    }
  }, [client]);
  const dismiss = useCallback((postId: string) => setEchoes((list) => list.filter((echo) => echo.post.id !== postId)), []);

  return { briefing, echoes, answer, dismiss };
}
