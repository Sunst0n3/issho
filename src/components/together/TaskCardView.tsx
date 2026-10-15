// Session B's task card: the can-do it practises, the goal and the question to answer at the
// end, a register note, the target words and grammar (each partner's own highlighted), and this
// partner's half of the information gap.

import { useEffect, useState } from 'react';
import { loadGrammarIndex, loadKanji, loadWordInfo } from '../../lib/data.ts';
import { parseItemId } from '../../lib/db.ts';
import type { TaskCard, UnitSpec } from '../../lib/types.ts';
import { Ruby } from '../ui.tsx';

export interface TargetLabel {
  id: string;
  /** Ruby markup or plain text. */
  jp: string;
  en: string;
}

const REGISTER_NOTE: Record<TaskCard['register'], string> = {
  plain: 'Plain speech: talk the way you talk to each other.',
  polite: 'Polite speech (です/ます): you are talking to someone you don’t know.',
  mixed: 'Plain between you two, polite with anyone else in the scene.',
};

/** Labels for item ids (core:, word:, grammar:, kanji:). Unknown ids show as they are. */
export async function targetLabels(ids: readonly string[]): Promise<TargetLabel[]> {
  const [words, grammar, kanji] = await Promise.all([
    loadWordInfo().catch(() => () => undefined),
    loadGrammarIndex().catch(() => new Map()),
    loadKanji().catch(() => ({} as Awaited<ReturnType<typeof loadKanji>>)),
  ]);
  return ids.map((id) => {
    const parsed = parseItemId(id);
    if (parsed?.kind === 'grammar') {
      const point = grammar.get(parsed.key);
      return { id, jp: point?.pattern ?? parsed.key, en: point?.title ?? '' };
    }
    if (parsed?.kind === 'kanji') return { id, jp: parsed.key, en: kanji[parsed.key]?.meanings[0] ?? '' };
    const info = words(id);
    if (info) return { id, jp: info.written === info.kana ? info.kana : `{${info.written}|${info.kana}}`, en: info.en };
    return { id, jp: parsed?.key ?? id, en: '' };
  });
}

export function useTargetLabels(ids: readonly string[]): TargetLabel[] | undefined {
  const [labels, setLabels] = useState<TargetLabel[]>();
  const key = ids.join('|');
  useEffect(() => {
    let alive = true;
    targetLabels(ids).then((l) => { if (alive) setLabels(l); }, () => { if (alive) setLabels([]); });
    return () => { alive = false; };
  }, [key]);
  return labels;
}

export function TaskCardView({ task, unit, targets, mine, half, partnerName, repeat }: {
  task: TaskCard;
  unit?: UnitSpec;
  /** 5–8 item ids from taskTargets(). */
  targets: readonly string[];
  /** This partner's own recent items: highlighted. */
  mine: ReadonlySet<string>;
  /** The info-gap half this phone shows; 'both' = one phone, each half behind its own tap. */
  half: 'a' | 'b' | 'both';
  partnerName: string;
  repeat: boolean;
}) {
  const canDo = unit?.canDos.find((c) => c.id === task.canDo);
  const labels = useTargetLabels(targets);
  const [open, setOpen] = useState<'a' | 'b'>();

  return (
    <section className="card tg-task" aria-labelledby="tg-task-goal">
      {canDo && <p className="label">Can-do · {canDo.text}</p>}
      {repeat && task.twist && <p className="tg-task-twist"><strong>Twist:</strong> {task.twist}</p>}
      <h2 id="tg-task-goal">{task.goal}</h2>
      <p><strong>At the end, answer together:</strong> {task.outcomeQuestion}</p>
      <p className="muted tg-small">{REGISTER_NOTE[task.register]}</p>
      <p className="tg-task-roles">
        <span><strong>A</strong> {task.roles.a}</span>
        <span><strong>B</strong> {task.roles.b}</span>
        {task.aiRole && <span><strong>AI</strong> {task.aiRole}</span>}
      </p>

      <h3 className="label">Try to use</h3>
      {!labels ? <div className="tg-skeleton-line" aria-busy="true" /> : (
        <ul className="tg-task-targets">
          {labels.map((t) => (
            <li key={t.id} className={mine.has(t.id) ? 'tg-target tg-mine' : 'tg-target'}>
              <span lang="ja"><Ruby text={t.jp} show="all" /></span>
              {t.en && <span className="muted"> {t.en}</span>}
              {mine.has(t.id) && <span className="visually-hidden"> (one of yours)</span>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="label">Your information</h3>
      {half === 'both' ? (
        <div className="tg-task-halves">
          {(['a', 'b'] as const).map((h) => (
            <div key={h}>
              <button type="button" className="btn secondary small" aria-expanded={open === h}
                onClick={() => setOpen(open === h ? undefined : h)}>
                Partner {h.toUpperCase()} only
              </button>
              {open === h && <p className="tg-task-info">{h === 'a' ? task.infoA : task.infoB}</p>}
            </div>
          ))}
        </div>
      ) : (
        <>
          <p className="tg-task-info">{half === 'a' ? task.infoA : task.infoB}</p>
          <p className="muted tg-small">{partnerName} has the other half. Don’t show each other.</p>
        </>
      )}
    </section>
  );
}
