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
  status?: "sample" | "published";
  /** Where the post sits in the subject map (src/data/taxonomy.json). */
  umbrella?: string;
  field?: string;
  subtopic?: string;
  /** When the post joined this reader's feed (feed_page only). */
  queuedAt?: string;
  contentType?: "news" | "evergreen";
  eventDate?: string;
  sources?: { url: string; publisher: string; title: string; articleDate: string | null; accessedAt: string; author?: string; licence?: string }[];
  /**
   * "excerpt": the publisher's own words and a link, made without AI, for sources whose terms rule AI out.
   * An excerpt has no insight or deeper explanation (both are then empty strings).
   */
  kind?: "excerpt";
  /** The feed carried the whole article and it was saved for reading here; fetched with `post_body`. */
  hasBody?: boolean;
}
/** One block of a saved article: plain text only, so nothing from a feed can run or style anything. */
export type BodyBlock =
  | { t: "h" | "p" | "q"; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "table"; rows: string[][] };
export interface PostState {
  rating: Rating | null;
  bookmarked: boolean;
  expanded: boolean;
  firstSeenAt?: string | null;
  readAt?: string | null;
  deeperOpenedAt?: string | null;
  /** When the reader tapped through to the original article. */
  openedAt?: string | null;
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
