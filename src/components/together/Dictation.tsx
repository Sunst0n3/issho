// Session C's partner dictation: the asker reads each word's kana aloud, the answerer writes it
// in kanji (on the pad or on paper), the asker gives the verdict. Then swap. The verdict grades
// the answerer's kanji write card when it is near its due date; otherwise it counts as practice.

import { PartnerQuizStep, type QuizPerson } from './PartnerQuiz.tsx';
import type { LiveRun } from './session.ts';

export function Dictation({ duo, me, partner, partnerRecentKanji, run, online }: {
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  partnerRecentKanji: readonly string[];
  run: LiveRun;
  online: boolean;
}) {
  return (
    <>
      <header className="tg-step-head">
        <p className="label">Partner dictation</p>
        <p className="muted">One reads the word aloud; the other writes it in kanji. Then swap.</p>
      </header>
      <PartnerQuizStep kind="dictation" duo={duo} me={me} partner={partner} partnerRecentKanji={partnerRecentKanji}
        run={run} online={online} />
    </>
  );
}
