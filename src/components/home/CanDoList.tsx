// Learn: the current unit's can-dos. Passed ones are ticked, available ones link to their check,
// others wait for the unit's grammar or for their check material ("coming soon"). The current unit is
// the one whose grammar is still being taught, so its checks open only once it is done; the checks of
// earlier units that are ready to try are listed on their own card (ReadyCanDos).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CanDo, CanDoRecord, UnitSpec } from '../../lib/types.ts';
import { canDoAvailable } from '../../srs/candos.ts';
import { Ruby, Icon } from '../ui.tsx';

export type CanDoState = 'passed' | 'available' | 'locked' | 'soon';

/** pure */
export function canDoState(cd: CanDo, unit: UnitSpec, record: CanDoRecord | undefined, grammarIntroduced: ReadonlySet<string>): CanDoState {
  if (record?.passedAt) return 'passed';
  if (!cd.ready) return 'soon';
  return canDoAvailable(cd, unit, grammarIntroduced) ? 'available' : 'locked';
}

const STATE_TEXT: Record<CanDoState, string> = {
  passed: 'Passed',
  available: 'Ready to try',
  locked: "After this unit's grammar",
  soon: 'Check coming soon',
};

const KIND_TEXT: Record<CanDo['check']['kind'], string> = {
  read: 'Reading check',
  listen: 'Listening check',
  speak: 'Speaking check',
  write: 'Writing check',
};

function CanDoItem({ cd, state, unitLabel }: { cd: CanDo; state: CanDoState; unitLabel?: string }) {
  const where = unitLabel ? `${unitLabel} · ` : '';
  const body = (
    <>
      <span className={`hm-cando-mark ${state}`} aria-hidden="true">
        {state === 'passed' ? <Icon name="check" size={14} strokeWidth={3} /> : null}
      </span>
      <span className="hm-cando-text">
        <span className="hm-cando-title">{cd.text}</span>
        <span className="hm-cando-state">{where}{KIND_TEXT[cd.check.kind]} · {STATE_TEXT[state]}</span>
      </span>
    </>
  );
  return (
    <li className={`hm-cando ${state}`}>
      {state === 'available' || state === 'passed' ? (
        <Link to={`/cando/${encodeURIComponent(cd.id)}`} className="hm-cando-link"
          aria-label={`${cd.text}, ${where}${STATE_TEXT[state]}`}>
          {body}
          <Icon name="forward" size={18} />
        </Link>
      ) : (
        <div className="hm-cando-link">{body}</div>
      )}
    </li>
  );
}

export function CanDoList({ unit, status, grammarIntroduced, current = true }: {
  unit: UnitSpec;
  status: ReadonlyMap<string, CanDoRecord>;
  grammarIntroduced: ReadonlySet<string>;
  /** The learner's current unit (not one shown for reference). */
  current?: boolean;
}) {
  const passed = unit.canDos.filter((cd) => status.get(cd.id)?.passedAt).length;
  return (
    <section className="card hm-unit" aria-labelledby={`unit-${unit.id}-title`}>
      <div className="hm-unit-head">
        <p className="label">{current ? `Unit ${unit.id} · now` : `Unit ${unit.id}`}</p>
        <h2 id={`unit-${unit.id}-title`} className="hm-notice-title">{unit.title}</h2>
        <Ruby text={unit.titleJp} className="hm-unit-jp" />
        <p className="hm-hint">{passed} of {unit.canDos.length} can-dos passed</p>
      </div>
      <ul className="hm-candos">
        {unit.canDos.map((cd) => (
          <CanDoItem key={cd.id} cd={cd} state={canDoState(cd, unit, status.get(cd.id), grammarIntroduced)} />
        ))}
      </ul>
    </section>
  );
}

export interface ReadyCanDo { unit: UnitSpec; cd: CanDo }

/** pure: can-dos of units before `currentUnit` that are ready to try and not passed yet, newest unit first. */
export function readyCanDos(
  units: readonly UnitSpec[],
  currentUnit: number,
  status: ReadonlyMap<string, CanDoRecord>,
  grammarIntroduced: ReadonlySet<string>,
): ReadyCanDo[] {
  return units
    .filter((u) => u.id < currentUnit)
    .sort((a, b) => b.id - a.id)
    .flatMap((unit) => unit.canDos
      .filter((cd) => canDoState(cd, unit, status.get(cd.id), grammarIntroduced) === 'available')
      .map((cd) => ({ unit, cd })));
}

/** Rows shown before "Show more". */
export const READY_PAGE = 5;

/** The checks of earlier units that are open now: the way in to every can-do once its unit's grammar is done. */
export function ReadyCanDos({ ready }: { ready: readonly ReadyCanDo[] }) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const expanded = useRef(false);
  // "Show more" goes away once tapped: focus moves to the first row it revealed, not to the page.
  useEffect(() => {
    if (!all || !expanded.current) return;
    expanded.current = false;
    list.current?.querySelectorAll('a')[READY_PAGE]?.focus();
  }, [all]);
  if (!ready.length) return null;
  const shown = all ? ready : ready.slice(0, READY_PAGE);
  const rest = ready.length - shown.length;
  return (
    <section className="card hm-unit" aria-labelledby="ready-candos-title">
      <div className="hm-unit-head">
        <h2 id="ready-candos-title" className="hm-notice-title">Can-dos ready to try</h2>
        <p className="hm-hint">From the units you've finished. Each is a short check of something you can do now.</p>
      </div>
      <ul className="hm-candos" ref={list}>
        {shown.map(({ unit, cd }) => <CanDoItem key={cd.id} cd={cd} state="available" unitLabel={`Unit ${unit.id}`} />)}
      </ul>
      {rest > 0 && (
        <button type="button" className="btn ghost small" onClick={() => { expanded.current = true; setAll(true); }}>
          Show {rest} more
        </button>
      )}
    </section>
  );
}
