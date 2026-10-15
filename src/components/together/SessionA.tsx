// Session A (about 15 min): the partner quiz each way, a teach-me turn, and a stage of the
// unit's core conversation.

import type { MemberProgress, TogetherRunPlan, TogetherSlot } from '../../../shared/api.ts';
import type { RolePlay, TogetherWeekPlan, UnitSpec } from '../../lib/types.ts';
import { ConversationStage } from './ConversationStage.tsx';
import { PartnerQuizStep, type QuizPerson } from './PartnerQuiz.tsx';
import type { LiveRun } from './session.ts';
import { TeachMeStep } from './TeachMe.tsx';

/** What every session's steps get from the runner. */
export interface SessionProps {
  run: LiveRun;
  /** The plan both phones run: the opener's. */
  plan: TogetherRunPlan;
  /** This phone's own week plan (settled unit, slots). */
  weekPlan: TogetherWeekPlan;
  /** This phone's slots from Settings: the couple's slots while the household has none (offline, not shared yet). */
  ownSlots: readonly TogetherSlot[];
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  partnerProgress: MemberProgress | null;
  online: boolean;
  /** The AI helper is on and reachable. */
  aiOn: boolean;
  units: readonly UnitSpec[];
  roleplays: readonly RolePlay[];
}

export function MissingContent({ what }: { what: string }) {
  return (
    <section className="card" role="status">
      <h2>{what} isn't on this phone</h2>
      <p className="muted">The content may still be on its way in an update. Skip this step for now.</p>
    </section>
  );
}

export function SessionA(props: SessionProps) {
  const { run, plan, duo, me, partner, partnerProgress, online, roleplays } = props;
  const recentKanji = partnerProgress?.recentKanji ?? [];
  switch (run.live.step) {
    case 'quiz':
      return <PartnerQuizStep kind="partner" duo={duo} me={me} partner={partner} partnerRecentKanji={recentKanji} run={run} online={online} />;
    case 'teach-me':
      return <TeachMeStep duo={duo} me={me} partner={partner} partnerRecentKanji={recentKanji} run={run} />;
    case 'conversation': {
      const script = roleplays.find((s) => s.id === plan.conversation?.scriptId);
      if (!script || !plan.conversation) return <SkipStep run={run} what="This conversation" />;
      return <ConversationStage script={script} stage={plan.conversation.stage} duo={duo} me={me} partner={partner} run={run} markStage />;
    }
    default:
      return null;
  }
}

/** A step whose content is missing: say so and let the couple move on. */
export function SkipStep({ run, what }: { run: LiveRun; what: string }) {
  return (
    <>
      <MissingContent what={what} />
      <button type="button" className="btn primary block" onClick={run.next}>Continue</button>
    </>
  );
}
