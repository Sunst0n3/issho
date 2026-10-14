// One new item: its lesson, then (for kana, radicals and kanji) writing it,
// then introducing it so its cards start. Writing can be skipped; the item is
// still introduced.

import { useRef, useState } from 'react';
import { db } from '../../../lib/db.ts';
import { introducePlanItem, type NewItemPlan } from '../../../srs/course.ts';
import type { IntroduceResult } from '../../../srs/items.ts';
import { KanaTarget, kanaTargetLabel } from '../cards/KanaWriteCard.tsx';
import { kanjiTargetLabel } from '../cards/KanjiWriteCard.tsx';
import { writePromptReading } from '../cards/prepare.ts';
import { useFocusHeading, useScrollToTop } from '../focus.ts';
import { sharedSoundRow } from '../format.ts';
import { useAsync } from '../useAsync.ts';
import { lessonLabel, loadLesson, type LearnedLabel, type LessonData } from './data.ts';
import { GrammarLesson } from './GrammarLesson.tsx';
import { KanaLesson } from './KanaLesson.tsx';
import { KanjiLesson } from './KanjiLesson.tsx';
import { RadicalLesson } from './RadicalLesson.tsx';
import { VocabLesson } from './VocabLesson.tsx';
import { ALL_PASSES, WriteSteps } from './WriteSteps.tsx';

export interface LearnedItem {
  label: LearnedLabel;
  results: IntroduceResult[];
}

function WritingFor({ data, onDone }: { data: LessonData; onDone: () => void }) {
  switch (data.kind) {
    case 'kanji': {
      const reading = writePromptReading(data.kanji, data.words);
      return (
        <WriteSteps char={data.kanji.char} ask="Write the kanji for" onDone={onDone} onSkip={onDone}
          target={<>{data.kanji.meanings[0]} <span lang="ja" className="st-write-reading">{reading}</span></>}
          label={kanjiTargetLabel(data.kanji.meanings[0], reading)} />
      );
    }
    case 'kana': {
      const row = sharedSoundRow(data.kana, data.all);
      return (
        <WriteSteps char={data.kana.char} ask={`Write the ${data.kana.script} for`} onDone={onDone} onSkip={onDone}
          target={<KanaTarget romaji={data.kana.romaji} row={row} />} label={kanaTargetLabel(data.kana.script, data.kana.romaji, row)} />
      );
    }
    case 'radical':
      return (
        <WriteSteps char={data.radical.char} passes={ALL_PASSES.slice(0, 1)} ask="Trace the part for" onDone={onDone} onSkip={onDone}
          target={data.radical.meaning} label={`the part for "${data.radical.meaning}"`} />
      );
    default:
      return null;
  }
}

export function NewItemFlow({ plan, onDone }: { plan: NewItemPlan; onDone: (item: LearnedItem) => void }) {
  const lesson = useAsync(() => loadLesson(plan), [plan.itemId]);
  const [stage, setStage] = useState<'lesson' | 'write'>('lesson');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const hook = useRef<string | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  useScrollToTop(stage);
  useFocusHeading(root, `${stage}:${lesson.loading}`);

  const finish = async (data: LessonData) => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const results = await introducePlanItem(plan);
      if (hook.current !== undefined) await db.items.update(plan.itemId, { customMnemonic: hook.current || undefined });
      onDone({ label: lessonLabel(plan.itemId, data), results });
    } catch (e) {
      console.error('could not save the new item', e);
      setFailed(true);
      setSaving(false);
    }
  };

  if (lesson.loading) {
    return <div className="st-skeleton st-skeleton-lesson" aria-busy="true" aria-label="Loading the lesson" />;
  }
  const data = lesson.data;
  if (!data) {
    return (
      <div className="card st-error" role="alert">
        <p>{lesson.error ? "This lesson didn't load." : "This lesson isn't available on this phone yet."}</p>
        <div className="st-row">
          {lesson.error && <button type="button" className="btn secondary" onClick={lesson.retry}>Try again</button>}
          <button type="button" className="btn ink st-grow" onClick={() => onDone({ label: { itemId: plan.itemId, text: '' }, results: [] })}>
            Skip it for now
          </button>
        </div>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="card st-error" role="alert">
        <p>Couldn't save this to your phone. Check there is free space, then try again.</p>
        <button type="button" className="btn ink" onClick={() => void finish(data)}>Try again</button>
      </div>
    );
  }

  if (stage === 'write') {
    return <div className="st-learn" ref={root}><WritingFor data={data} onDone={() => void finish(data)} /></div>;
  }

  const next = () => void finish(data);
  const practice = () => setStage('write');
  return (
    <div className="st-learn" ref={root} aria-busy={saving || undefined}>
      {data.kind === 'kanji' && (
        <KanjiLesson kanji={data.kanji} words={data.words} mnemonic={data.mnemonic} kana={data.kana}
          onHookChange={(text) => { hook.current = text; }} onPractice={practice} />
      )}
      {data.kind === 'radical' && (
        <RadicalLesson radical={data.radical} examples={data.examples} mnemonic={data.mnemonic}
          onHookChange={(text) => { hook.current = text; }} onPractice={practice} />
      )}
      {data.kind === 'kana' && <KanaLesson kana={data.kana} example={data.example} all={data.all} onPractice={practice} onNext={next} />}
      {data.kind === 'vocab' && <VocabLesson vocab={data.vocab} kana={data.kana} onNext={next} />}
      {data.kind === 'grammar' && <GrammarLesson point={data.point} onNext={next} />}
    </div>
  );
}
