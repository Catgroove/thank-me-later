export const TML_REVIEW_MARKER = "<!-- tml:review -->";

export function markedReviewBody(body: string): string {
  return body.includes(TML_REVIEW_MARKER) ? body : `${TML_REVIEW_MARKER}\n${body}`;
}
