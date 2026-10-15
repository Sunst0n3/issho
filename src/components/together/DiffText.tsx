// How the AI's two-step tips look: first the problem spans in the learner's own text with a
// type label (never the fix), then, after the learner's own edit, the diff to the corrected text.

import type { AiDiffOp, AiIssue, AiIssueType } from '../../../shared/api.ts';

export const ISSUE_LABELS: Record<AiIssueType, string> = {
  particle: 'Particle',
  conjugation: 'Conjugation',
  'word-choice': 'Word choice',
  kanji: 'Kanji',
  register: 'Register',
  other: 'Other',
};

/** Splits `text` into plain runs and the located issues (1-based numbers, as in the list below it). */
export function issueRuns(text: string, issues: readonly AiIssue[]): { text: string; issue?: number }[] {
  const located = issues
    .map((issue, i) => ({ issue, n: i + 1 }))
    .filter(({ issue }) => issue.start !== null && issue.end !== null && issue.end > issue.start && issue.end <= text.length)
    .sort((a, b) => a.issue.start! - b.issue.start!);
  const runs: { text: string; issue?: number }[] = [];
  let at = 0;
  for (const { issue, n } of located) {
    if (issue.start! < at) continue; // Overlapping spans: the first one wins.
    if (issue.start! > at) runs.push({ text: text.slice(at, issue.start!) });
    runs.push({ text: text.slice(issue.start!, issue.end!), issue: n });
    at = issue.end!;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}

/** The learner's text with each issue span marked and numbered. */
export function IssueText({ text, issues }: { text: string; issues: readonly AiIssue[] }) {
  return (
    <p className="tg-issue-text" lang="ja">
      {issueRuns(text, issues).map((run, i) =>
        run.issue ? (
          <mark key={i} className="tg-issue-span">
            {run.text}
            <sup aria-hidden="true">{run.issue}</sup>
            <span className="visually-hidden"> (issue {run.issue})</span>
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ))}
    </p>
  );
}

/** One line per issue: its type ("maybe" when the AI isn't sure) and the nudge. */
export function IssueList({ issues }: { issues: readonly AiIssue[] }) {
  return (
    <ol className="tg-issue-list">
      {issues.map((issue, i) => (
        <li key={i}>
          <span className="chip">{ISSUE_LABELS[issue.type]}{issue.uncertain ? ' · maybe' : ''}</span>
          {issue.hint ? <span> {issue.hint}</span> : <span className="muted"> Look again at this part.</span>}
        </li>
      ))}
    </ol>
  );
}

/** Learner text → corrected text: removed parts struck through, added parts highlighted. */
export function DiffText({ diff }: { diff: readonly AiDiffOp[] }) {
  return (
    <p className="tg-diff" lang="ja">
      {diff.map((op, i) =>
        op.op === 'del' ? (
          <del key={i} className="tg-diff-del">{op.text}</del>
        ) : op.op === 'ins' ? (
          <ins key={i} className="tg-diff-ins">{op.text}</ins>
        ) : (
          <span key={i}>{op.text}</span>
        ))}
    </p>
  );
}
