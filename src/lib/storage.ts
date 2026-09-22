import { posts } from "@/data/posts";
import type { PostState, ReadingState } from "@/types/post";

export const STORAGE_KEY = "tek-shape:reading:v1";
export const emptyPost: PostState = { rating: null, bookmarked: false, expanded: false };
export const initialState: ReadingState = { posts: {}, visibleCount: 4, position: null };

// Treat browser storage as untrusted: accept only known IDs and valid fields.
export function parseState(raw: string | null): ReadingState {
  if (!raw) return initialState;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object") return initialState;
  const state: ReadingState = { posts: {}, visibleCount: value.visibleCount === 8 ? 8 : 4, position: null };
  for (const post of posts) {
    const saved = value.posts?.[post.id];
    if (saved && typeof saved === "object") {
      state.posts[post.id] = {
        rating: ["more", "uninteresting", "harder"].includes(saved.rating) ? saved.rating : null,
        bookmarked: saved.bookmarked === true,
        expanded: saved.expanded === true,
      };
    }
  }
  const position = value.position;
  const index = posts.findIndex((post) => post.id === position?.postId);
  if (index >= 0 && Number.isFinite(position.offset)) {
    state.position = { postId: position.postId, offset: Math.max(-2000, Math.min(10000, position.offset)) };
    if (index >= 4) state.visibleCount = 8;
  }
  return state;
}
