// Session A's teach-me turn: explain one of your newer kanji to your partner from memory (its
// parts and the story that links them), then check against the reference. Explaining is
// retrieval; the notes stay hidden until "Show reference".

import { useEffect, useState } from 'react';
import { loadCurriculum, loadKanji, loadMnemonics, loadRadicals, loadWordInfo, type WordInfo } from '../../lib/data.ts';
import type { KanjiEntry, MnemonicEntry } from '../../lib/types.ts';
import { teachMeKanji } from '../../srs/together.ts';
import { Glyph } from '../Glyph.tsx';
import { PartsPanel, partsOf, type PartView } from '../home/PartsPanel.tsx';
import { Ruby } from '../ui.tsx';
import type { QuizPerson } from './PartnerQuiz.tsx';
import type { LiveRun } from './session.ts';

interface Reference {
  char: string;
  entry?: KanjiEntry;
  parts: PartView[];
  hook?: MnemonicEntry;
  anchor?: WordInfo;
}

async function referenceFor(char: string): Promise<Reference> {
  const [kanji, radicals, mnemonics, curriculum, wordInfo] = await Promise.all([
    loadKanji(),
    loadRadicals().catch(() => []),
    loadMnemonics().catch(() => ({})),
    loadCurriculum().catch(() => undefined),
    loadWordInfo().catch(() => () => undefined),
  ]);
  const entry = kanji[char];
  const radicalMap = new Map(radicals.map((r) => [r.char, r]));
  const unit = curriculum?.units.find((u) => u.char === char);
  return {
    char,
    entry,
    parts: entry ? partsOf(entry, kanji, radicalMap) : [],
    hook: (mnemonics as Record<string, MnemonicEntry>)[char],
    anchor: unit?.anchor ? wordInfo(unit.anchor) : undefined,
  };
}

/** Whose kanji: the explainer's own (teachMeKanji on their phone), or the partner's newest on one phone. */
export function TeachMeStep({ duo, me, partner, partnerRecentKanji, run }: {
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  partnerRecentKanji: readonly string[];
  run: LiveRun;
}) {
  const { live, update, next } = run;
  const explainer = live.turn ?? live.opener;
  const mine = explainer === me.id;
  const [char, setChar] = useState<string | null>();

  useEffect(() => {
    let alive = true;
    setChar(undefined);
    if (mine) {
      teachMeKanji().then((c) => { if (alive) setChar(c); }, () => { if (alive) setChar(null); });
    } else {
      setChar(duo ? null : partnerRecentKanji[0] ?? null);
    }
    return () => { alive = false; };
  }, [mine, duo, partnerRecentKanji[0]]);

  const done = () => {
    // Opener first, then the other partner; then on to the conversation.
    if (explainer === live.opener) update((s) => ({ ...s, turn: s.opener === me.id ? partner.id : me.id, index: 0 }));
    else next();
  };

  if (duo && !mine) {
    return (
      <section className="card tg-teach" aria-live="polite">
        <p className="label">Teach me</p>
        <h2>Listen to {partner.name} explain a kanji</h2>
        <p className="muted">Ask もう一度？ if you lose them. Point at the part you want to hear about.</p>
        <button type="button" className="btn secondary block" onClick={done}>They explained it</button>
      </section>
    );
  }

  return (
    <section className="card tg-teach" aria-live="polite">
      <p className="label">Teach me · {mine ? 'your turn' : `${partner.name}'s turn`}</p>
      {char === undefined && <div className="tg-skeleton-block" aria-busy="true" />}
      {char === null && (
        <>
          <h2>No kanji to teach yet</h2>
          <p className="muted">
            {mine ? 'Kanji join the teach-me turn 2 days after you learn them.' : `Nothing of ${partner.name}'s is on this phone.`}
          </p>
        </>
      )}
      {char && (
        <>
          {!duo && !mine && <p className="tg-pass-note">Hand the phone to {partner.name}.</p>}
          <p className="tg-teach-glyph" lang="ja"><Glyph char={char} size={96} /></p>
          <h2>Explain it to {mine ? partner.name : 'your partner'}</h2>
          <p className="muted">What are its parts, and what story links them? Say it before you look.</p>
          <ReferenceReveal key={char} char={char} />
        </>
      )}
      <button type="button" className="btn primary block" onClick={done}>Done</button>
    </section>
  );
}

function ReferenceReveal({ char }: { char: string }) {
  const [shown, setShown] = useState(false);
  const [ref, setRef] = useState<Reference>();
  useEffect(() => {
    if (!shown || ref) return;
    let alive = true;
    referenceFor(char).then((r) => { if (alive) setRef(r); }, () => { if (alive) setRef({ char, parts: [] }); });
    return () => { alive = false; };
  }, [shown, char, ref]);

  if (!shown) {
    return <button type="button" className="btn secondary small" onClick={() => setShown(true)}>Show reference</button>;
  }
  if (!ref) return <div className="tg-skeleton-line" aria-busy="true" />;
  return (
    <div className="tg-teach-ref">
      {ref.entry && <p><strong>{ref.entry.meanings[0]}</strong></p>}
      <PartsPanel parts={ref.parts} />
      {ref.hook && <p className="tg-teach-hook">{ref.hook.meaning}</p>}
      {ref.anchor && (
        <p className="tg-teach-anchor">
          <span lang="ja">
            <Ruby text={ref.anchor.written === ref.anchor.kana ? ref.anchor.kana : `{${ref.anchor.written}|${ref.anchor.kana}}`} show="all" />
          </span>
          <span className="muted"> · {ref.anchor.en}</span>
        </p>
      )}
    </div>
  );
}
