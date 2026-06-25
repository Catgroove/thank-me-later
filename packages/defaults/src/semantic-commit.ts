const CONVENTIONAL_SUBJECT = /^[a-z]+(?:-[a-z]+)*(?:\([a-z0-9-]+\))?: .+$/;
const MAX_SUBJECT_LENGTH = 120;

export function fixCommitSubject(step: string, summary: string): string {
  const scope = commitScope(step);
  const subject = summarizeForCommit(summary);
  const commitSubject = `chore(${scope}): ${subject}`;
  assertSemanticCommitSubject(commitSubject);
  return commitSubject;
}

export function assertSemanticCommitSubject(subject: string): void {
  if (!CONVENTIONAL_SUBJECT.test(subject.trim())) {
    throw new Error(`fix commit subject is not a Conventional Commit subject: ${subject}`);
  }
}

function commitScope(step: string): string {
  const scope = step
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return scope.length > 0 ? scope : "fix";
}

function summarizeForCommit(summary: string): string {
  const oneLine = summary
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .replace(/[.。]+$/, "");
  if (oneLine.length === 0) return "apply selected fixes";
  return oneLine.length <= MAX_SUBJECT_LENGTH
    ? oneLine
    : oneLine.slice(0, MAX_SUBJECT_LENGTH - 1).trimEnd() + "…";
}
