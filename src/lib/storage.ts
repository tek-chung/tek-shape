import type { BodyBlock, Post, PostSource, PostState, Rating, ReadingPosition, ReadingState } from "@/types/post";

export const emptyPost: PostState = { rating: null, bookmarked: false, expanded: false };
export const initialState: ReadingState = { posts: {}, loadedCount: 0, position: null, total: 0 };

/** Fields a device may change. `seen`, `read` and `opened` are one-way flags the server turns into timestamps. */
export type PostPatch = Partial<Pick<PostState, "rating" | "bookmarked" | "expanded">> & {
  seen?: true;
  read?: true;
  opened?: true;
};

/** Writes made on this device that the server has not acknowledged yet. */
export interface Outbox {
  posts: Record<string, PostPatch>;
  progress: { loadedCount: number; position: ReadingPosition | null } | null;
}

export const emptyOutbox: Outbox = { posts: {}, progress: null };

const RATINGS: readonly Rating[] = ["more", "uninteresting", "harder"];
const MIN_OFFSET = -2000;
const MAX_OFFSET = 10000;
const MAX_ID_LENGTH = 64;
const MAX_CACHED_POSTS = 2000;
const MAX_LOADED = 5000;

// Caches are namespaced per account so a shared browser never shows one reader
// another's state. The version suffix retires caches written by an older shape.
export const stateKey = (userId: string) => `tek-shape:state:v3:${userId}`;
export const outboxKey = (userId: string) => `tek-shape:outbox:v3:${userId}`;
export const postsKey = (userId: string) => `tek-shape:posts:v3:${userId}`;
/** When the last sitting began, so the next one can say what arrived in between. */
export const visitKey = (userId: string) => `tek-shape:visit:v1:${userId}`;

// localStorage throws in Safari private mode and when storage is blocked. Never let that break reading.
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* This session stays in memory only. */
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function coerceTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 ? value : null;
}

function coerceOffset(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, value))
    : null;
}

function coercePosition(value: unknown): ReadingPosition | null {
  if (!isObject(value) || !isId(value.postId)) return null;
  const offset = coerceOffset(value.offset);
  return offset === null ? null : { postId: value.postId, offset };
}

function coercePostState(value: unknown): PostState | null {
  if (!isObject(value)) return null;
  return {
    rating: RATINGS.includes(value.rating as Rating) ? (value.rating as Rating) : null,
    bookmarked: value.bookmarked === true,
    expanded: value.expanded === true,
    firstSeenAt: coerceTimestamp(value.firstSeenAt),
    readAt: coerceTimestamp(value.readAt),
    deeperOpenedAt: coerceTimestamp(value.deeperOpenedAt),
    openedAt: coerceTimestamp(value.openedAt),
  };
}

function coerceCount(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.trunc(value))) : 0;
}

/**
 * Validate a reading state from an untrusted source: the browser cache or the
 * `reading_state` RPC payload. Post ids are checked for shape only, not
 * membership, so content can grow without a client release.
 */
export function coerceState(value: unknown): ReadingState | null {
  if (!isObject(value)) return null;
  const state: ReadingState = {
    posts: {},
    loadedCount: coerceCount(value.loadedCount, MAX_LOADED),
    position: coercePosition(value.position),
    total: coerceCount(value.total, MAX_LOADED),
  };
  if (isObject(value.posts)) {
    for (const [id, saved] of Object.entries(value.posts)) {
      if (!isId(id)) continue;
      const post = coercePostState(saved);
      if (post) state.posts[id] = post;
    }
  }
  return state;
}

function coerceText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function coerceSource(value: unknown): PostSource | undefined {
  if (!isObject(value)) return undefined;
  const label = coerceText(value.label, 200);
  const url = coerceText(value.url, 2000);
  // Only https, and never a javascript: or data: URL reaching an href.
  return label && url && url.startsWith("https://") ? { label, url } : undefined;
}

/** Validate one post from `reading_page` or the content cache. */
export function coercePost(value: unknown): Post | null {
  if (!isObject(value)) return null;
  const id = coerceText(value.id, MAX_ID_LENGTH);
  const topic = coerceText(value.topic, 60);
  const title = coerceText(value.title, 200);
  // An excerpt (the publisher's own words, made without AI) has no insight or deeper explanation.
  const excerpt = value.kind === "excerpt";
  const insight = excerpt ? "" : coerceText(value.insight, 400);
  const deeper = excerpt ? "" : coerceText(value.deeper, 4000);
  const publishedAt = coerceText(value.publishedAt, 40);
  if (!id || !topic || !title || insight === null || deeper === null || !publishedAt) return null;
  if (!Array.isArray(value.explanation)) return null;
  const explanation = value.explanation
    .map((paragraph) => coerceText(paragraph, 4000))
    .filter((paragraph): paragraph is string => paragraph !== null);
  if (!explanation.length) return null;
  const source = coerceSource(value.source);
  const sources: NonNullable<Post["sources"]> = [];
  if (Array.isArray(value.sources)) for (const entry of value.sources.slice(0,10)) {
    if (!isObject(entry)) return null;
    const citation = coerceSource({label:entry.title,url:entry.url});
    const publisher = coerceText(entry.publisher,200);
    const accessedAt = coerceText(entry.accessedAt,40);
    const articleDate = entry.articleDate === null ? null : coerceText(entry.articleDate,40);
    if (!citation || !publisher || !accessedAt || !Number.isFinite(Date.parse(accessedAt))
      || (entry.articleDate !== null && (!articleDate || !Number.isFinite(Date.parse(articleDate))))) return null;
    const author = coerceText(entry.author, 120);
    const licence = coerceText(entry.licence, 80);
    sources.push({url:citation.url,title:citation.label,publisher,accessedAt,articleDate,...(author ? { author } : {}),...(licence ? { licence } : {})});
  }
  const status = value.status === "published" ? "published" : "sample";
  const contentType = value.contentType === "news" ? "news" : "evergreen";
  if (status === "published" && !sources.length) return null;
  const eventDate = typeof value.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.eventDate)
    && Number.isFinite(Date.parse(value.eventDate)) ? value.eventDate : undefined;
  const slug = (text: unknown) => (typeof text === "string" && /^[a-z0-9-]{1,60}$/.test(text) ? text : undefined);
  const umbrella = slug(value.umbrella);
  const field = slug(value.field);
  const subtopic = coerceText(value.subtopic, 100) ?? undefined;
  const queued = coerceText(value.queuedAt, 40);
  const queuedAt = queued && Number.isFinite(Date.parse(queued)) ? queued : undefined;
  return { id, topic, title, explanation, insight, deeper, publishedAt, status, contentType, sources,
    ...(umbrella ? { umbrella } : {}), ...(field ? { field } : {}), ...(subtopic ? { subtopic } : {}), ...(queuedAt ? { queuedAt } : {}),
    ...(eventDate ? {eventDate} : {}), ...(source ? { source } : {}),
    ...(excerpt ? { kind: "excerpt" as const } : {}), ...(value.hasBody === true ? { hasBody: true } : {}) };
}

/**
 * Validate a saved article from `post_body`: plain text blocks only, never markup. Anything malformed is
 * dropped block by block; null when nothing readable is left.
 */
export function coerceBlocks(value: unknown): BodyBlock[] | null {
  if (!Array.isArray(value)) return null;
  const strings = (list: unknown, count: number, max: number) =>
    Array.isArray(list) ? list.slice(0, count).map((item) => coerceText(item, max)).filter((item): item is string => item !== null) : [];
  const blocks: BodyBlock[] = [];
  for (const block of value.slice(0, 300)) {
    if (!isObject(block)) continue;
    if (block.t === "h" || block.t === "p" || block.t === "q") {
      const text = coerceText(block.text, 4000);
      if (text) blocks.push({ t: block.t, text });
    } else if (block.t === "ul" || block.t === "ol") {
      const items = strings(block.items, 50, 4000);
      if (items.length) blocks.push({ t: block.t, items });
    } else if (block.t === "table" && Array.isArray(block.rows)) {
      const rows = block.rows.slice(0, 40).map((row) => strings(row, 12, 300)).filter((row) => row.length);
      if (rows.length) blocks.push({ t: "table", rows });
    }
  }
  return blocks.length ? blocks : null;
}

export function coercePosts(value: unknown): Post[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const posts: Post[] = [];
  for (const entry of value.slice(0, MAX_CACHED_POSTS)) {
    const post = coercePost(entry);
    if (post && !seen.has(post.id)) {
      seen.add(post.id);
      posts.push(post);
    }
  }
  return posts;
}

function coercePatch(value: unknown): PostPatch | null {
  if (!isObject(value)) return null;
  const patch: PostPatch = {};
  if ("rating" in value) patch.rating = RATINGS.includes(value.rating as Rating) ? (value.rating as Rating) : null;
  if (typeof value.bookmarked === "boolean") patch.bookmarked = value.bookmarked;
  if (typeof value.expanded === "boolean") patch.expanded = value.expanded;
  if (value.seen === true) patch.seen = true;
  if (value.read === true) patch.read = true;
  if (value.opened === true) patch.opened = true;
  return Object.keys(patch).length ? patch : null;
}

export function coerceOutbox(value: unknown): Outbox {
  if (!isObject(value)) return emptyOutbox;
  const outbox: Outbox = { posts: {}, progress: null };
  if (isObject(value.posts)) {
    for (const [id, saved] of Object.entries(value.posts)) {
      if (!isId(id)) continue;
      const patch = coercePatch(saved);
      if (patch) outbox.posts[id] = patch;
    }
  }
  if (isObject(value.progress)) {
    outbox.progress = {
      loadedCount: coerceCount(value.progress.loadedCount, MAX_LOADED),
      position: coercePosition(value.progress.position),
    };
  }
  return outbox;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const readState = (userId: string) => coerceState(parseJson(readLocal(stateKey(userId))));
export const readOutbox = (userId: string) => coerceOutbox(parseJson(readLocal(outboxKey(userId))));
export const readPosts = (userId: string) => coercePosts(parseJson(readLocal(postsKey(userId))));
export const writeState = (userId: string, state: ReadingState) =>
  writeLocal(stateKey(userId), JSON.stringify(state));
export const writeOutbox = (userId: string, outbox: Outbox) =>
  writeLocal(outboxKey(userId), JSON.stringify(outbox));
export const writePosts = (userId: string, posts: Post[]) =>
  writeLocal(postsKey(userId), JSON.stringify(posts.slice(0, MAX_CACHED_POSTS)));

/**
 * Any control on a post (a rating, saving, the deeper explanation, the original) shows it was read, and
 * `save_post` records it so. Only `seen` does not.
 */
export const marksRead = (patch: PostPatch): boolean =>
  !!patch.read || !!patch.opened || patch.rating !== undefined || patch.bookmarked !== undefined || patch.expanded !== undefined;

/**
 * Apply a patch the way `save_post` does, so the optimistic view matches what the server will store.
 * First times stand. `at` supplies them for a change made earlier on this device (see applyOutbox).
 */
export function applyPatch(state: PostState, patch: PostPatch, now: string, at?: PostState): PostState {
  const next: PostState = { ...state };
  if (patch.rating !== undefined) next.rating = patch.rating;
  if (patch.bookmarked !== undefined) next.bookmarked = patch.bookmarked;
  if (patch.expanded !== undefined) {
    next.expanded = patch.expanded;
    if (patch.expanded) next.deeperOpenedAt = next.deeperOpenedAt ?? at?.deeperOpenedAt ?? now;
  }
  if (patch.seen) next.firstSeenAt = next.firstSeenAt ?? at?.firstSeenAt ?? now;
  if (marksRead(patch)) next.readAt = next.readAt ?? at?.readAt ?? now;
  if (patch.opened) next.openedAt = next.openedAt ?? at?.openedAt ?? now;
  return next;
}

/**
 * Read before `since` (when this sitting began) means "already read": hidden from the feed, listed under
 * Read. A post rated, saved or opened on an earlier version of the app, which did not yet count that as
 * reading, has no read time, but it was plainly read in an earlier sitting.
 */
export function readBefore(state: ReadingState | null, id: string, since: string): boolean {
  const post = state?.posts[id];
  if (!post) return false;
  // Compare as times: the server and this device write timestamps in different formats.
  if (post.readAt) return Date.parse(post.readAt) < Date.parse(since);
  return !!post.rating || post.bookmarked || post.expanded || !!post.deeperOpenedAt || !!post.openedAt;
}

/** Later writes win per field; `seen` and `read` are sticky because the server only ever sets them once. */
export const mergePatch = (base: PostPatch | undefined, patch: PostPatch): PostPatch => ({ ...base, ...patch });

/**
 * Replay everything still waiting to sync on top of a server snapshot, so a refresh never discards local
 * work. `local` is this device's own copy, whose times say when things were actually done: a post read
 * offline an hour ago still counts as read an hour ago, not at this merge, so it moves to Read on time.
 */
export function applyOutbox(base: ReadingState, outbox: Outbox, now: string, local?: ReadingState | null): ReadingState {
  const posts = { ...base.posts };
  for (const [id, patch] of Object.entries(outbox.posts)) {
    posts[id] = applyPatch(posts[id] ?? emptyPost, patch, now, local?.posts[id]);
  }
  const progress = outbox.progress;
  return {
    ...base,
    posts,
    loadedCount: progress ? Math.max(base.loadedCount, progress.loadedCount) : base.loadedCount,
    position: progress ? progress.position ?? base.position : base.position,
  };
}

/** Append a page, dropping anything already held so a repeated fetch cannot duplicate. */
export function appendPosts(existing: Post[], page: Post[]): Post[] {
  const seen = new Set(existing.map((post) => post.id));
  const added = page.filter((post) => !seen.has(post.id));
  return added.length ? [...existing, ...added] : existing;
}

export const outboxSize = (outbox: Outbox) => Object.keys(outbox.posts).length + (outbox.progress ? 1 : 0);
