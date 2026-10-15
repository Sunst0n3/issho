// Learn: the current unit's can-dos. Passed ones are ticked, available ones link to their check,
// others wait for the unit's grammar or for their check material ("coming soon").
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
        {unit.canDos.map((cd) => {
          const state = canDoState(cd, unit, status.get(cd.id), grammarIntroduced);
          const body = (
            <>
              <span className={`hm-cando-mark ${state}`} aria-hidden="true">
                {state === 'passed' ? <Icon name="check" size={14} strokeWidth={3} /> : null}
              </span>
              <span className="hm-cando-text">
                <span className="hm-cando-title">{cd.text}</span>
                <span className="hm-cando-state">{KIND_TEXT[cd.check.kind]} · {STATE_TEXT[state]}</span>
              </span>
            </>
          );
          return (
            <li key={cd.id} className={`hm-cando ${state}`}>
              {state === 'available' || state === 'passed' ? (
                <Link to={`/cando/${encodeURIComponent(cd.id)}`} className="hm-cando-link"
                  aria-label={`${cd.text}, ${STATE_TEXT[state]}`}>
                  {body}
                  <Icon name="forward" size={18} />
                </Link>
              ) : (
                <div className="hm-cando-link">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
