"use client";

import { BookOpen, Bookmark, CheckCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import type { PostState, Rating } from "@/types/post";
import type { PostPatch } from "@/lib/storage";

export const ratingLabels: Record<Rating, string> = {
  more: "More at the same level",
  uninteresting: "Not interesting",
  harder: "Keep the topic, increase difficulty",
};

interface Props {
  postId: string;
  state: PostState;
  disabled: boolean;
  onChange: (patch: PostPatch) => void;
  /** False for an excerpt, which has no deeper explanation to open. */
  canExpand?: boolean;
}

export function FeedbackBar({ postId, state, disabled, onChange, canExpand = true }: Props) {
  const ratings = [
    { value: "more" as const, Icon: ThumbsUp },
    { value: "uninteresting" as const, Icon: ThumbsDown },
    { value: "harder" as const, Icon: CheckCheck },
  ];
  return <div className="feedback" role="group" aria-label="Feedback and reading controls">
    {ratings.map(({ value, Icon }) => <button key={value} type="button" className="icon-button"
      disabled={disabled} aria-label={ratingLabels[value]} title={ratingLabels[value]}
      aria-pressed={state.rating === value}
      onClick={() => onChange({ rating: state.rating === value ? null : value })}>
      <Icon size={19} aria-hidden="true" />
    </button>)}
    <span className="control-divider" aria-hidden="true" />
    <button type="button" className="icon-button" disabled={disabled}
      aria-label={state.bookmarked ? "Remove bookmark" : "Save post"}
      title={state.bookmarked ? "Remove bookmark" : "Save post"} aria-pressed={state.bookmarked}
      onClick={() => onChange({ bookmarked: !state.bookmarked })}>
      <Bookmark size={19} fill={state.bookmarked ? "currentColor" : "none"} aria-hidden="true" />
    </button>
    {canExpand && <button type="button" className="icon-button" disabled={disabled}
      aria-label={state.expanded ? "Collapse deeper explanation" : "Expand deeper explanation"}
      title={state.expanded ? "Collapse deeper explanation" : "Expand deeper explanation"}
      aria-expanded={state.expanded} aria-controls={`deeper-${postId}`}
      onClick={() => onChange({ expanded: !state.expanded })}>
      <BookOpen size={19} aria-hidden="true" />
    </button>}
  </div>;
}
