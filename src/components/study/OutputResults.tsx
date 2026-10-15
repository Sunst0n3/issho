// "From yesterday: …". A sentence sent while the home server's AI couldn't be reached is checked later (the sync
// layer retries it); the next session opens with that check: what was sent, the correction as a diff, the one-line
// rule, and whether it became a card. Each result is shown once.

import type { AiDiffOp } from '../../../shared/api.ts';
import { dayKey, db } from '../../lib/db.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import type { OutputSentenceRecord } from '../../lib/types.ts';
import { addDays, daysBetween } from '../../srs/days.ts';
import { Ruby } from '../ui.tsx';
import { MixedText } from './MixedText.tsx';
import { weekdayOf } from './SessionSummary.tsx';

/** Longest text the character diff compares; longer ones show as a whole replacement. */
const MAX_DIFF_CHARS = 200;

/** Checks that finished after their sentence was sent and haven't been shown yet, oldest first. */
export async function unseenOutputResults(): Promise<OutputSentenceRecord[]> {
  const done = await db.outputs.where('check').equals('done').toArray();
  return done.filter((r) => !r.resultSeen).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Shown: never again. */
export async function markOutputResultsSeen(ids: readonly string[]): Promise<void> {
  await db.transaction('rw', db.outputs, async () => {
    for (const id of ids) await db.outputs.update(id, { resultSeen: true });
  });
}

/** pure: a character diff from `from` to `to` (longest common subsequence), adjacent runs merged. */
export function charDiff(from: string, to: string): AiDiffOp[] {
  const a = [...from];
  const b = [...to];
  if (a.length > MAX_DIFF_CHARS || b.length > MAX_DIFF_CHARS) {
    return [...(from ? [{ op: 'del' as const, text: from }] : []), ...(to ? [{ op: 'ins' as const, text: to }] : [])];
  }
  // lcs[i][j]: common subsequence length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: AiDiffOp[] = [];
  const push = (op: AiDiffOp['op'], ch: string) => {
    const last = ops[ops.length - 1];
    if (last?.op === op) last.text += ch;
    else ops.push({ op, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // What goes comes before what replaces it.
      push('del', a[i++]);
    } else {
      push('ins', b[j++]);
    }
  }
  return ops;
}

/** 'From yesterday', 'From earlier today', 'From Tuesday' (within the week), else 'From earlier'. */
export function fromLabel(day: string, today: string = dayKey()): string {
  if (day === today) return 'From earlier today';
  if (day === addDays(today, -1)) return 'From yesterday';
  if (daysBetween(day, today) < 7) return `From ${weekdayOf(day)}`;
  return 'From earlier';
}

function Result({ rec }: { rec: OutputSentenceRecord }) {
  const corrected = rec.corrected ? rubyToPlain(rec.corrected) : rec.text;
  const ok = corrected === rec.text;
  return (
    <article className="card st-output-result">
      <p className="label">{fromLabel(rec.day)} · using <Ruby text={rec.target.label} show="all" /></p>
      {ok ? (
        <>
          <p className="st-output-text" lang="ja">{rec.text}</p>
          <p className="feedback good st-fb-title">Natural and correct</p>
        </>
      ) : (
        <p className="st-output-text st-diff" lang="ja">
          {charDiff(rec.text, corrected).map((op, k) => {
            if (op.op === 'del') return <del key={k}>{op.text}</del>;
            if (op.op === 'ins') return <ins key={k}>{op.text}</ins>;
            return <span key={k}>{op.text}</span>;
          })}
        </p>
      )}
      {rec.rule && <p className="st-fb-note"><MixedText text={rec.rule} /></p>}
      {rec.cardId && <p className="st-fb-note">The corrected sentence is now a card.</p>}
    </article>
  );
}

/** The checks that came back since the learner's last session, before today's steps. */
export function OutputResults({ results, onDone }: { results: readonly OutputSentenceRecord[]; onDone: () => void }) {
  return (
    <section className="st-output" aria-labelledby="st-output-results-title">
      <p className="st-eyebrow" lang="ja">チェック</p>
      <h2 id="st-output-results-title" className="st-ask">
        {results.length === 1 ? 'Your sentence was checked' : 'Your sentences were checked'}
      </h2>
      {results.map((rec) => <Result key={rec.id} rec={rec} />)}
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button>
      </div>
    </section>
  );
}
