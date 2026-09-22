export type Rating = "more" | "uninteresting" | "harder";
export interface Post {
  id: string;
  topic: string;
  title: string;
  explanation: string[];
  insight: string;
  deeper: string;
  source?: { label: string; url: string };
}
export interface PostState {
  rating: Rating | null;
  bookmarked: boolean;
  expanded: boolean;
}
export interface ReadingPosition { postId: string; offset: number }
export interface ReadingState {
  posts: Record<string, PostState>;
  visibleCount: number;
  position: ReadingPosition | null;
}
