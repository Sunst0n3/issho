// The monthly capstone: co-write a short skit that uses the unit's structures, check your own
// lines privately with the AI if you like, then perform it from memory. Nothing is recorded.

import { useId, useState } from 'react';
import type { AiCheckResponse } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import type { UnitSpec } from '../../lib/types.ts';
import { learnerAiContext } from '../../srs/output.ts';
import { aiCheck } from '../../sync/client.ts';
import { postTogetherEvent } from '../../sync/together.ts';
import { Ruby } from '../ui.tsx';
import { aiErrorMessage } from './ai.ts';
import { DiffText } from './DiffText.tsx';
import type { QuizPerson } from './PartnerQuiz.tsx';

interface SkitLine {
  id: number;
  who: 'me' | 'partner';
  text: string;
  check?: AiCheckResponse | 'checking' | { error: string };
}

export function Capstone({ unit, duo, me, partner, aiOn, onDone }: {
  unit: UnitSpec;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  /** The AI helper is reachable: each partner can check their own lines privately. */
  aiOn: boolean;
  onDone(): void;
}) {
  const id = useId();
  const { capstone } = unit;
  const [phase, setPhase] = useState<'write' | 'perform'>('write');
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [lines, setLines] = useState<SkitLine[]>([]);
  const [draft, setDraft] = useState('');
  const [who, setWho] = useState<'me' | 'partner'>('me');
  const [posted, setPosted] = useState(false);
  const count = (w: 'me' | 'partner') => lines.filter((l) => l.who === w && l.text.trim()).length;
  const need = capstone.minLinesEach;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setLines((list) => [...list, { id: Date.now() + list.length, who: duo ? 'me' : who, text }]);
    setDraft('');
    if (!duo) setWho(who === 'me' ? 'partner' : 'me');
  };

  const check = async (line: SkitLine) => {
    setLines((list) => list.map((l) => (l.id === line.id ? { ...l, check: 'checking' } : l)));
    try {
      const result = await aiCheck({ ...(await learnerAiContext()), text: line.text, mode: 'reveal' });
      setLines((list) => list.map((l) => (l.id === line.id ? { ...l, check: result } : l)));
    } catch (e) {
      setLines((list) => list.map((l) => (l.id === line.id ? { ...l, check: { error: aiErrorMessage(e) } } : l)));
    }
  };

  const useFix = (line: SkitLine, corrected: string) =>
    setLines((list) => list.map((l) => (l.id === line.id ? { ...l, text: corrected, check: undefined } : l)));

  const finish = () => {
    if (!posted) {
      setPosted(true);
      void postTogetherEvent({ type: 'capstone-done', unit: unit.id, date: dayKey() });
    }
    onDone();
  };

  if (phase === 'perform') {
    return (
      <section className="card tg-capstone" aria-labelledby={`${id}-perform`}>
        <p className="label">Capstone · {capstone.title}</p>
        <h2 id={`${id}-perform`}>Perform it from memory</h2>
        <p className="muted">Put the phone down and act it out. Only the first words are here as cues.</p>
        <ol className="tg-capstone-cues">
          {lines.map((l) => (
            <li key={l.id}>
              <span className="label">{l.who === 'me' ? me.name : partner.name}</span>{' '}
              <span lang="ja">{[...l.text].slice(0, 3).join('')}…</span>
            </li>
          ))}
        </ol>
        <button type="button" className="btn primary block" onClick={finish}>We performed it</button>
      </section>
    );
  }

  return (
    <section className="card tg-capstone" aria-labelledby={`${id}-title`}>
      <p className="label">Capstone · Unit {unit.id}</p>
      <h2 id={`${id}-title`}>{capstone.title}</h2>
      <p>{capstone.brief}</p>

      <fieldset className="tg-option-group">
        <legend className="label">Use these ({ticked.size} of {capstone.structures.length})</legend>
        {capstone.structures.map((s, i) => (
          <label key={s} className="tg-check-row">
            <input type="checkbox" checked={ticked.has(i)}
              onChange={() => setTicked((t) => {
                const n = new Set(t);
                if (n.has(i)) n.delete(i); else n.add(i);
                return n;
              })} />
            <span lang="ja"><Ruby text={s} show="all" /></span>
          </label>
        ))}
      </fieldset>

      <p className="tg-capstone-counts" role="status">
        {duo
          ? `Your lines: ${count('me')} of ${need}. ${partner.name} writes theirs on their phone.`
          : `${me.name}: ${count('me')} of ${need} lines · ${partner.name}: ${count('partner')} of ${need}`}
      </p>

      <ol className="tg-capstone-lines">
        {lines.map((l) => {
          const result = l.check && l.check !== 'checking' && !('error' in l.check) ? l.check : undefined;
          return (
            <li key={l.id} className={l.who === 'me' ? 'tg-mine' : 'tg-theirs'}>
              <span className="label">{l.who === 'me' ? (duo ? 'You' : me.name) : partner.name}</span>
              <p lang="ja">{l.text}</p>
              {aiOn && l.who === 'me' && !l.check && (
                <button type="button" className="tg-link-btn" onClick={() => void check(l)}>Check my line</button>
              )}
              {l.check === 'checking' && <p className="muted tg-small" role="status">Checking…</p>}
              {l.check && l.check !== 'checking' && 'error' in l.check && <p className="tg-composer-notice">{l.check.error}</p>}
              {result && (
                result.ok ? <p className="muted tg-small">Looks natural.</p> : (
                  <div className="tg-tip-panel">
                    <p className="tg-tip-private">Only you can see this tip.</p>
                    <DiffText diff={result.diff} />
                    {result.rule && <p className="tg-tip-why">{result.rule}</p>}
                    <button type="button" className="btn secondary small" onClick={() => useFix(l, result.corrected)}>Use the fix</button>
                  </div>
                )
              )}
            </li>
          );
        })}
      </ol>

      <div className="tg-composer-row">
        {!duo && (
          <button type="button" className="btn ghost small" onClick={() => setWho(who === 'me' ? 'partner' : 'me')}
            aria-label={`Next line is ${who === 'me' ? me.name : partner.name}'s; tap to switch`}>
            {who === 'me' ? me.name : partner.name}
          </button>
        )}
        <input className="tg-composer-input" lang="ja" value={draft} maxLength={200} placeholder="Next line in Japanese"
          aria-label="Next line" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
        <button type="button" className="btn secondary small" disabled={!draft.trim()} onClick={add}>Add</button>
      </div>

      <button type="button" className="btn primary block" disabled={!lines.length} onClick={() => setPhase('perform')}>
        Perform it
      </button>
    </section>
  );
}
