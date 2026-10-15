// One teach batch: for each item its lesson, then its copy passes (a trace when a part is new, then a guided copy for
// kana and kanji), then the item is introduced so its cards start. The memory pass comes after the batch's last item,
// in the session. An item's writing can be skipped; it is still introduced.

import { useRef, useState } from 'react';
import { db } from '../../../lib/db.ts';
import { introducePlanItem, type NewItemPlan } from '../../../srs/course.ts';
import type { TeachBatch } from '../../../srs/planner.ts';
import type { WritingMode } from '../../../writing/WritingPad.tsx';
import { kanjiTargetLabel } from '../cards/KanjiWriteCard.tsx';
import { useFocusHeading, useScrollToTop } from '../focus.ts';
import type { LearnedItem } from '../session/machine.ts';
import { useAsync } from '../useAsync.ts';
import { CoreWordLesson } from './CoreWordLesson.tsx';
import { learnedItem, loadLesson, type LessonData } from './data.ts';
import { GrammarLesson } from './GrammarLesson.tsx';
import { KanaLesson } from './KanaLesson.tsx';
import { KanaRuleLesson } from './KanaRuleLesson.tsx';
import { KanjiLesson } from './KanjiLesson.tsx';
import { StagedWordLesson } from './StagedWordLesson.tsx';
import { LESSON_PASSES, WriteSteps } from './WriteSteps.tsx';

export type { LearnedItem } from '../session/machine.ts';

/** The copy passes after a lesson: kana trace then copy; kanji trace only when a part is new; nothing for the rest. */
export function copyPasses(data: LessonData): WritingMode[] {
  if (data.kind === 'kana') return LESSON_PASSES;
  if (data.kind === 'kanji') return data.newPart ? LESSON_PASSES : ['guided'];
  return [];
}

function Writing({ data, onDone }: { data: LessonData; onDone: () => void }) {
  const passes = copyPasses(data);
  if (data.kind === 'kanji') {
    return (
      <WriteSteps char={data.kanji.char} passes={passes} ask="Write the kanji for" onDone={onDone} onSkip={onDone}
        target={<span className="st-write-keyword">{data.kanji.meanings[0]}</span>} label={kanjiTargetLabel(data.kanji.meanings[0])} />
    );
  }
  if (data.kind === 'kana') {
    return (
      <WriteSteps char={data.kana.char} passes={passes} ask={`Write the ${data.kana.script}`} onDone={onDone} onSkip={onDone}
        target={<span lang="ja">{data.kana.char}</span>} label={data.kana.char} />
    );
  }
  return null;
}

function ItemFlow({ plan, onDone }: { plan: NewItemPlan; onDone: (item: LearnedItem | null) => void }) {
  const lesson = useAsync(() => loadLesson(plan), [plan.itemId]);
  const [stage, setStage] = useState<'lesson' | 'write'>('lesson');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const hook = useRef<string | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  useScrollToTop(stage);
  useFocusHeading(root, `${stage}:${lesson.loading}`);

  const finish = async () => {
    // A double tap, or Continue pressed while the save is under way: introduce once.
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const results = await introducePlanItem(plan);
      if (hook.current !== undefined) await db.items.update(plan.itemId, { customMnemonic: hook.current || undefined });
      onDone(learnedItem(plan, results));
    } catch (e) {
      console.error('could not save the new item', e);
      busy.current = false;
      setFailed(true);
      setSaving(false);
    }
  };

  if (lesson.loading) return <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the lesson" />;
  const data = lesson.data;
  if (!data) {
    return (
      <div className="card st-error" role="alert">
        <p>{lesson.error ? "This lesson didn't load." : "This lesson isn't available on this phone yet."}</p>
        <div className="st-row">
          {lesson.error && <button type="button" className="btn secondary" onClick={lesson.retry}>Try again</button>}
          <button type="button" className="btn ink st-grow" onClick={() => onDone(null)}>Skip it for now</button>
        </div>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="card st-error" role="alert">
        <p>Couldn't save this to your phone. Check there is free space, then try again.</p>
        <button type="button" className="btn ink" onClick={() => void finish()}>Try again</button>
      </div>
    );
  }

  const next = () => void finish();
  const practice = () => (copyPasses(data).length ? setStage('write') : next());
  if (stage === 'write') {
    return <div className="st-learn" ref={root} aria-busy={saving || undefined}><Writing data={data} onDone={next} /></div>;
  }
  return (
    <div className="st-learn" ref={root} aria-busy={saving || undefined}>
      {data.kind === 'kana' && <KanaLesson kana={data.kana} example={data.example} onPractice={practice} />}
      {data.kind === 'kanaRule' && <KanaRuleLesson rule={data.rule} onDone={next} />}
      {data.kind === 'kanji' && <KanjiLesson data={data} onHookChange={(text) => { hook.current = text; }} onPractice={practice} />}
      {data.kind === 'core' && <CoreWordLesson word={data.word} display={data.display} accent={data.accent} onNext={next} />}
      {data.kind === 'staged' && <StagedWordLesson word={data.word} accent={data.accent} upgrade={data.upgrade} onNext={next} />}
      {data.kind === 'grammar' && <GrammarLesson point={data.point} examplePitch={data.examplePitch} onNext={next} />}
    </div>
  );
}

/**
 * Teaches a batch, one item after another. `onTaught` reports each item once it is introduced; `onDone` follows the
 * last one (the session then runs the batch's memory pass).
 */
export function NewItemFlow({ batch, onTaught, onDone, onProgress }: {
  batch: TeachBatch;
  onTaught: (item: LearnedItem) => void;
  onDone: () => void;
  /** 0-based index of the item on screen. */
  onProgress?: (index: number) => void;
}) {
  const [at, setAt] = useState(0);
  const plan = batch.items[at];
  if (!plan) return null;
  return (
    <ItemFlow key={plan.itemId} plan={plan}
      onDone={(item) => {
        if (item) onTaught(item);
        if (at + 1 < batch.items.length) {
          setAt(at + 1);
          onProgress?.(at + 1);
        } else onDone();
      }} />
  );
}
