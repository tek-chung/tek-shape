export type Rating = "more" | "uninteresting" | "harder";
export interface PostSource {
  label: string;
  url: string;
}
/** Content as authored in the repository, before the database assigns an order. */
export interface SeedPost {
  id: string;
  topic: string;
  title: string;
  explanation: string[];
  insight: string;
  deeper: string;
  source?: PostSource;
}
/** Content as served by `reading_page`. */
export interface Post extends SeedPost {
  publishedAt: string;
}
export interface PostState {
  rating: Rating | null;
  bookmarked: boolean;
  expanded: boolean;
  firstSeenAt?: string | null;
  readAt?: string | null;
  deeperOpenedAt?: string | null;
}
export interface ReadingPosition {
  postId: string;
  offset: number;
}
/** Keyset cursor into the feed: the last row already held. */
export interface Cursor {
  publishedAt: string;
  id: string;
}
export interface ReadingState {
  posts: Record<string, PostState>;
  /** How many posts had been paged in, so a reload can restore the same depth. */
  loadedCount: number;
  position: ReadingPosition | null;
  total: number;
}
