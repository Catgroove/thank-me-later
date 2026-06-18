// Pure helpers for the finding↔thread mapping: a stable dedup key, the HTML-comment marker that
// stamps tml's own finding threads, marker parsing, and the dedup set. No `ctx`, no Forge — all
// unit-tested directly. `review` posts `ask-user` findings as threads carrying the marker;
// re-runs use these to recognise and skip findings that already have a thread (open or resolved).

import type { ReviewThread } from "@tml/core";
import type { Finding, Severity } from "./synthesize.ts";

/** The invisible marker stamped on a tml-authored finding thread, carrying its dedup key. */
export function findingMarker(key: string): string {
  return `<!-- tml:finding key=${key} -->`;
}

const FINDING_RE = /<!-- tml:finding key=(\S+) -->/;

/** FNV-1a → base36: deterministic, dependency-free, stable across runs. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Stable key for a finding — `hash(path:line:title)` — so the same finding dedups across runs. */
export function findingKey(f: Finding): string {
  return hash(`${f.location ?? ""}:${f.title}`);
}

/** A thread is tml's own when its root body carries the finding marker. */
export function isTmlThread(t: ReviewThread): boolean {
  return FINDING_RE.test(t.body);
}

/** The dedup key embedded in a thread's marker, or `null` when it carries none. */
export function threadKey(t: ReviewThread): string | null {
  return t.body.match(FINDING_RE)?.[1] ?? null;
}

/** Keys of every tml finding thread (open or resolved) — the dedup set a re-run skips against. */
export function existingKeys(threads: readonly ReviewThread[]): Set<string> {
  const keys = new Set<string>();
  for (const t of threads) {
    const k = threadKey(t);
    if (k !== null) keys.add(k);
  }
  return keys;
}

/** Split a `"path:line"` finding location into its parts, or `null` when it can't be anchored. */
export function parseLocation(location: string | undefined): { path: string; line: number } | null {
  if (location === undefined) return null;
  const m = location.match(/^(.*):(\d+)$/);
  return m === null ? null : { path: m[1] ?? "", line: Number(m[2]) };
}

/** A CodeRabbit-style severity badge that heads each posted thread. */
const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴 **Critical**",
  warning: "🟠 **Warning**",
  nit: "🔵 **Nit**",
};

/** The thread body for an `ask-user` finding: the marker, a severity badge + title, then detail. */
export function findingThreadBody(f: Finding): string {
  const loc = f.location ? ` \`${f.location}\`` : "";
  return `${findingMarker(findingKey(f))}\n${SEVERITY_BADGE[f.severity]} — ${f.title}${loc}\n\n${f.detail}`;
}

// --- The reconciliation protocol (read by `respond-comments`) ----------------------------------
// Every tml-authored comment carries a `<!-- tml:… -->` marker, so the loop can tell its own
// turns from a human's/bot's without a bot identity — used both to detect replies and to cap the
// per-thread ping-pong.

export const TML_REPLY_MARKER = "<!-- tml:reply -->";
export const TML_HANDOFF_MARKER = "<!-- tml:handoff -->";

const TML_COMMENT_RE = /<!-- tml:/;

/** True when a comment was authored by tml (it carries a `tml:…` marker). */
export function isTmlComment(comment: { body: string }): boolean {
  return TML_COMMENT_RE.test(comment.body);
}

/** Number of tml-authored comments in a thread — the ping-pong counter. */
export function tmlRoundCount(t: ReviewThread): number {
  return t.comments.filter(isTmlComment).length;
}

/** True when the latest reply beyond the root comment was authored by someone other than tml. */
export function hasHumanReply(t: ReviewThread): boolean {
  const latestReply = t.comments.slice(1).at(-1);
  return latestReply !== undefined && !isTmlComment(latestReply);
}

/** True when the latest comment in the thread is one of tml's own replies. */
export function latestCommentIsTml(t: ReviewThread): boolean {
  const latest = t.comments.at(-1);
  return latest !== undefined && isTmlComment(latest);
}

/** The ack signal carried by the thread root's reactions (👍 approve, 👎 dismiss). */
export function ackOf(t: ReviewThread): "approve" | "dismiss" | "none" {
  const reactions = t.comments[0]?.reactions;
  if (reactions === undefined) return "none";
  if (reactions.thumbsUp > 0) return "approve";
  if (reactions.thumbsDown > 0) return "dismiss";
  return "none";
}

/** What to do with one of tml's own threads. A reply outweighs a reaction when both are present. */
export function tmlThreadAction(t: ReviewThread): "fix" | "dismiss" | "interpret-reply" | "park" {
  if (hasHumanReply(t)) return "interpret-reply";
  const ack = ackOf(t);
  if (ack === "approve") return "fix";
  if (ack === "dismiss") return "dismiss";
  return "park";
}

/** Wrap a reply body with the tml-reply marker so it counts toward the ping-pong cap. */
export function tmlReply(body: string): string {
  return `${TML_REPLY_MARKER}\n\n${body}`;
}

/** The hand-off reply posted when a thread has churned past the ping-pong ceiling. */
export function handoffReply(): string {
  return (
    `${TML_HANDOFF_MARKER}\n\n` +
    "I've responded to this a few times without converging — handing it to a human."
  );
}

/** True once a thread already carries tml's hand-off reply — so re-entries leave it untouched. */
export function isHandedOff(t: ReviewThread): boolean {
  return t.comments.some((c) => c.body.includes(TML_HANDOFF_MARKER));
}

/** Render a thread's comments as plain text for an agent prompt. */
export function renderThread(t: ReviewThread): string {
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "(general)";
  const comments = t.comments.map((c) => `- ${c.author || "unknown"}: ${c.body}`).join("\n");
  return `Thread on ${where}:\n${comments}`;
}
