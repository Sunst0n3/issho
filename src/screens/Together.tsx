// The Together tab: this week's together sessions, the couple quest, the shared story, your
// partner's effort, the check-in history, and ways to practise (chat, free role-plays, quizzes
// waiting for you). The plan works offline from the last state this phone saw; the parts that
// come from the home server say so.

import type { Table } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { HouseholdResponse, MemberStats, Quiz, QuizzesResponse, TogetherState } from '../../shared/api.ts';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { CoupleQuestCard } from '../components/together/CoupleQuestCard.tsx';
import { focusLost } from '../components/together/focus.ts';
import { dateFromKey, memberName, PARTNER_FALLBACK, splitHousehold, timeAgo, useNow } from '../components/together/household.ts';
import { useRolePlayInvite } from '../components/together/live.ts';
import { useQuizzes } from '../components/together/quizzes.ts';
import { SESSION_TITLES, useLiveInvite } from '../components/together/session.ts';
import { lastReadMessageId } from '../components/together/storage.ts';
import '../components/together/together.css';
import { WeekChart } from '../components/together/WeekChart.tsx';
import { lettersDone, sessionStatus, useWeekPlan, type SessionStatus } from '../components/together/weekPlan.ts';
import { Icon, Screen } from '../components/ui.tsx';
import { loadStories } from '../lib/data.ts';
import { db, dayKey } from '../lib/db.ts';
import { useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import type { Settings, StoryEntry, TogetherWeekPlan } from '../lib/types.ts';
import type { PendingMessage } from '../sync/outbox.ts';
import { onServerEvent, reconnectNow, useServerStatus, type ServerStatus } from '../sync/socket.ts';
import { useHousehold } from '../sync/stats.ts';

/** Check-ins shown in the history. */
const CHECKIN_WEEKS = 8;
const WEEKDAY: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const STATUS_TEXT: Record<SessionStatus, string> = { done: 'Done', today: 'Today', overdue: 'Still open', planned: 'Planned' };

export default function Together() {
  const settings = useSettings();
  const loaded = useSettingsLoaded();
  if (!loaded) {
    return (
      <Screen tabs label="Together">
        <Header />
        <div className="tg-skeleton-block tg-tall" aria-busy="true" />
      </Screen>
    );
  }
  return settings.deviceToken ? <Paired settings={settings} /> : <Unpaired />;
}

function Header({ status }: { status?: ReactNode }) {
  return (
    <header className="tg-together-header">
      <p className="tg-eyebrow" lang="ja">いっしょに</p>
      <h1 className="tg-together-title">Together</h1>
      {status}
    </header>
  );
}

function Unpaired() {
  return (
    <Screen tabs label="Together">
      <Header />
      <section className="card tg-together-explain" aria-labelledby="together-explain">
        <h2 id="together-explain">Practice with your partner</h2>
        <ul className="tg-feature-list">
          <li><Icon name="chat" /><span><strong>Text in Japanese.</strong> A private tip can help before you send.</span></li>
          <li><Icon name="people" /><span><strong>Three short sessions a week:</strong> quiz each other, act out conversations, do a task together.</span></li>
          <li><Icon name="quest" /><span><strong>A weekly couple quest</strong> you meet together.</span></li>
          <li><Icon name="mic" /><span><strong>Act out role-plays</strong> out loud, on two phones or one.</span></li>
        </ul>
        <p className="muted tg-small">These need your home server. Everything else in Issho works on this phone alone, even offline.</p>
      </section>
      <section aria-labelledby="together-connect">
        <h2 id="together-connect" className="tg-section-title">Connect to your home server</h2>
        <ConnectServerForm onConnected={() => {}} />
      </section>
      <Link to="/roleplay" className="btn ghost block">Try a role-play on this phone</Link>
    </Screen>
  );
}

function Paired({ settings }: { settings: Settings }) {
  const status = useServerStatus();
  const { data, fetchedAt, loading, error, refresh } = useHousehold();
  const quizzes = useQuizzes();
  const week = useWeekPlan();
  const { me, partner } = splitHousehold(data);
  const partnerName = partner?.member.name ?? PARTNER_FALLBACK;
  const invite = useRolePlayInvite();
  const sessionInvite = useLiveInvite(undefined);

  useEffect(() => onServerEvent((ev) => {
    if (ev.type === 'stats' || ev.type === 'together') void refresh();
  }), [refresh]);

  // "Try again" is replaced by the quest (or by the card again when it still fails): keep focus there.
  const retried = useRef(false);
  const questHeading = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!retried.current) return;
    const target = data ? questHeading.current : retryButton.current;
    if (!target) return; // Still loading.
    retried.current = false;
    if (focusLost()) target.focus();
  }, [data, loading, error]);

  return (
    <Screen tabs label="Together">
      <Header status={<SyncStatus status={status} fetchedAt={fetchedAt} hasData={Boolean(data)} failed={Boolean(error)} />} />

      {sessionInvite && (!partner || sessionInvite.memberId === partner.member.id) && (
        <Link to={`/together/session/${sessionInvite.state.session}`} className="tg-invite-banner">
          <Icon name="people" />
          <span><strong>{partnerName} started {sessionInvite.state.session === 'monthly' ? 'the monthly session' : `Session ${sessionInvite.state.session}`}.</strong> Tap to join.</span>
          <Icon name="forward" />
        </Link>
      )}
      {invite && (!partner || invite.memberId === partner.member.id) && (
        <Link to={`/roleplay/${invite.state.scriptId}`} className="tg-invite-banner">
          <Icon name="mic" />
          <span><strong>{partnerName} started a role-play.</strong> Tap to join them.</span>
          <Icon name="forward" />
        </Link>
      )}

      <ThisWeek plan={week.plan} failed={week.failed} offline={week.offline} />

      {data ? (
        <QuestSection data={data} me={me} partner={partner} state={week.state} plan={week.plan} headingRef={questHeading} />
      ) : loading || !error ? (
        <div className="tg-skeleton-block" aria-busy="true" aria-label="Loading your week" />
      ) : (
        <div className="tg-notice-card">
          {/* The socket says 'offline' whenever the server can't be reached, even on a working network. */}
          <h2>{navigator.onLine === false ? "You're offline" : "Couldn't reach your home server"}</h2>
          <p>The couple quest and your partner's week need the home server. The plan above still works.</p>
          <button ref={retryButton} type="button" className="btn secondary small" onClick={() => {
            retried.current = true;
            // Reconnect the live connection too, rather than waiting out its backoff, so the
            // header doesn't keep saying "Offline" over freshly loaded data.
            reconnectNow();
            void refresh();
          }}>Try again</button>
        </div>
      )}

      <SharedStory storyId={week.plan?.storyId} />

      {data && <EffortCard me={me} partner={partner} partnerName={partnerName} />}

      <CheckinHistory state={week.state} data={data} myId={settings.memberId} partnerName={partnerName} />

      <h2 className="label tg-section-label">Practice together</h2>
      <ChatCard myId={settings.memberId} />
      <Link to="/roleplay" className="tg-chat-card">
        <span className="tg-chat-card-icon" aria-hidden="true"><Icon name="mic" size={22} /></span>
        <span className="tg-chat-card-body">
          <span className="tg-chat-card-title">Free role-plays</span>
          <span className="tg-chat-card-preview">Short scenes that fit what you both know</span>
        </span>
        <Icon name="forward" />
      </Link>
      <QuizLists data={quizzes.data} myId={settings.memberId} nameOf={(memberId) => memberName(data, memberId, partnerName)} />
    </Screen>
  );
}

/** The week's sessions with their day, time and status; each opens the session. */
function ThisWeek({ plan, failed, offline }: { plan?: TogetherWeekPlan; failed: boolean; offline: boolean }) {
  const today = dayKey();
  return (
    <section className="card" aria-labelledby="tg-this-week">
      <div className="tg-week-head">
        <h2 id="tg-this-week">This week</h2>
        {offline && <span className="tg-sync-status tg-offline"><Icon name="cloudOff" size={14} />From the last sync</span>}
      </div>
      {!plan ? (
        failed ? <p className="muted">This week's plan couldn't be worked out on this phone.</p>
          : <div className="tg-skeleton-line" aria-busy="true" />
      ) : plan.sessions.length === 0 ? (
        <p className="muted">No sessions set yet. Pick your three slots in Settings → Together, or at the next check-in.</p>
      ) : (
        <ul className="tg-session-list">
          {plan.sessions.map((s) => {
            const st = sessionStatus(s, today);
            const name = s.id === 'monthly' ? 'Monthly session' : `Session ${s.id}`;
            return (
              <li key={`${s.id}-${s.day}`}>
                <Link to={`/together/session/${s.id}`} className={`tg-session-row tg-${st}`}>
                  <span className="tg-session-when">
                    {WEEKDAY[((dateFromKey(s.day).getDay() + 6) % 7) + 1]} {s.time}
                  </span>
                  <span className="tg-session-what">
                    <strong>{name}</strong>
                    <span className="muted"> · {SESSION_TITLES[s.id]}</span>
                  </span>
                  <span className={`chip tg-status-${st}`}>{STATUS_TEXT[st]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function QuestSection({ data, me, partner, state, plan, headingRef }: {
  data: HouseholdResponse;
  me?: MemberStats;
  partner?: MemberStats;
  state: TogetherState | null;
  plan?: TogetherWeekPlan;
  headingRef?: RefObject<HTMLDivElement>;
}) {
  const members = [me, partner].filter((m): m is MemberStats => Boolean(m)).map((m) => [m.member.id, m === me ? 'You' : m.member.name] as const);
  return (
    <div ref={headingRef} tabIndex={-1} className="tg-focus-target">
      <CoupleQuestCard quest={data.quest} members={members} done={lettersDone(state, plan?.week ?? data.quest.week)}
        streakWeeks={data.questStreakWeeks} />
    </div>
  );
}

function SharedStory({ storyId }: { storyId?: string }) {
  const [story, setStory] = useState<StoryEntry | null>();
  useEffect(() => {
    if (!storyId) { setStory(null); return; }
    let alive = true;
    loadStories().then((all) => { if (alive) setStory(all.find((s) => s.id === storyId) ?? null); }, () => { if (alive) setStory(null); });
    return () => { alive = false; };
  }, [storyId]);
  if (!story) return null;
  return (
    <Link to={`/read/${story.id}`} className="tg-chat-card">
      <span className="tg-chat-card-icon" aria-hidden="true"><Icon name="book" size={22} /></span>
      <span className="tg-chat-card-body">
        <span className="tg-chat-card-title">Read during the week: {story.title}</span>
        <span className="tg-chat-card-preview">You'll talk about it in Session C</span>
      </span>
      <Icon name="forward" />
    </Link>
  );
}

/** Your week next to your partner's: minutes and days studied; accuracy only when they share it. */
function EffortCard({ me, partner, partnerName }: { me?: MemberStats; partner?: MemberStats; partnerName: string }) {
  const studied = (m?: MemberStats) => m?.days.filter((d) => d.minimumDone || d.sessionComplete || d.studyMinutes > 0).length ?? 0;
  const minutes = (m?: MemberStats) => Math.round(m?.days.reduce((sum, d) => sum + d.studyMinutes + (d.togetherMinutes ?? 0), 0) ?? 0);
  const shared = partner?.days.filter((d) => d.accuracyShared && d.reviews > 0) ?? [];
  const accuracy = shared.length
    ? Math.round((100 * shared.reduce((n, d) => n + d.correct, 0)) / Math.max(1, shared.reduce((n, d) => n + d.reviews, 0)))
    : undefined;
  return (
    <section className="card" aria-labelledby="week-title">
      <div className="tg-week-head">
        <h2 id="week-title">Your week</h2>
        <ul className="tg-legend">
          <li><span className="tg-swatch tg-you" aria-hidden="true" />You</li>
          {partner && <li><span className="tg-swatch tg-partner" aria-hidden="true" />{partnerName}</li>}
        </ul>
      </div>
      <WeekChart me={me} partner={partner} partnerName={partnerName} />
      {!partner && (
        <p className="muted tg-small">Waiting for your partner to join. They connect with the same household code.</p>
      )}
      <dl className="tg-stat-row">
        <div className="tg-stat">
          <dt>Days studied{partner ? <span className="tg-stat-sub"> you · {partnerName}</span> : null}</dt>
          <dd>{studied(me)}{partner && <><span className="tg-stat-sep"> · </span>{studied(partner)}</>}</dd>
        </div>
        <div className="tg-stat">
          <dt>Minutes{partner ? <span className="tg-stat-sub"> you · {partnerName}</span> : null}</dt>
          <dd>{minutes(me)}{partner && <><span className="tg-stat-sep"> · </span>{minutes(partner)}</>}</dd>
        </div>
        {accuracy !== undefined && (
          <div className="tg-stat">
            <dt>{partnerName}'s accuracy</dt>
            <dd>{accuracy} %</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function CheckinHistory({ state, data, myId, partnerName }: {
  state: TogetherState | null;
  data?: HouseholdResponse;
  myId?: string;
  partnerName: string;
}) {
  const weeks = [...new Set((state?.checkins ?? []).map((c) => c.week))].sort().reverse().slice(0, CHECKIN_WEEKS);
  if (!weeks.length) return null;
  return (
    <section className="card" aria-labelledby="tg-checkins">
      <h2 id="tg-checkins">Check-ins</h2>
      <ul className="tg-checkin-history">
        {weeks.map((w) => (
          <li key={w}>
            <p className="label">Week of {dateFromKey(w).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
            {state!.checkins.filter((c) => c.week === w).map((c) => (
              <p key={c.memberId} className="tg-small">
                <strong>{c.memberId === myId ? 'You' : memberName(data, c.memberId, partnerName)}</strong>
                {' '}{c.checkin.counts.kanji} kanji · {c.checkin.counts.words} words · {c.checkin.counts.grammar} grammar · {Math.round(c.checkin.counts.minutes)} min
                {c.checkin.note && <span className="muted"> · {c.checkin.note}</span>}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SyncStatus({ status, fetchedAt, hasData, failed }: {
  status: ServerStatus;
  fetchedAt?: number;
  hasData: boolean;
  failed: boolean;
}) {
  const now = useNow();
  if (status === 'offline' || (failed && hasData)) {
    return (
      <p className="tg-sync-status tg-offline">
        <Icon name="cloudOff" size={16} />
        {hasData ? `${status === 'offline' ? 'Offline' : "Couldn't refresh"} — showing what we had` : 'Offline'}
      </p>
    );
  }
  if (fetchedAt && status === 'online') {
    return <p className="tg-sync-status"><Icon name="check" size={16} />Synced {timeAgo(fetchedAt, now)}</p>;
  }
  return <p className="tg-sync-status">Connecting…</p>;
}

function ChatCard({ myId }: { myId?: string }) {
  const id = useId();
  const summary = useLiveQuery(async () => {
    const last = await db.messages.orderBy('id').last();
    const lastRead = lastReadMessageId();
    const unread = await db.messages.where('id').above(lastRead).filter((m) => m.memberId !== myId && m.kind !== 'system').count();
    const outbox = await (db.outbox as unknown as Table<PendingMessage, string>).toArray();
    const failed = outbox.filter((m) => m.failed).length;
    return { last, unread, waiting: outbox.length - failed, failed };
  }, [myId]);
  const last = summary?.last;
  const mine = last?.memberId === myId;
  const body = last
    ? last.kind === 'voice' ? `Voice message${last.transcript ? ` · ${last.transcript}` : ''}` : last.text
    : undefined;

  const unread = summary && summary.unread > 0 ? summary.unread : 0;
  return (
    // Named from its parts so screen readers hear a pause between them, not "Chat in JapaneseYou: …".
    <Link to="/chat" className="tg-chat-card"
      aria-labelledby={[`${id}-title`, `${id}-preview`, unread ? `${id}-unread` : ''].filter(Boolean).join(' ')}>
      <span className="tg-chat-card-icon" aria-hidden="true"><Icon name="chat" size={22} /></span>
      <span className="tg-chat-card-body">
        <span className="tg-chat-card-title" id={`${id}-title`}>Chat in Japanese</span>
        <span className="tg-chat-card-preview" id={`${id}-preview`}>
          {summary === undefined ? ' '
            : summary.failed > 0 ? `${summary.failed} not sent · open the chat to retry`
              : summary.waiting > 0 ? `${summary.waiting} waiting to send`
                : body ? <>{mine && 'You: '}<span lang="ja">{body}</span></>
                  : 'Say hello. Your messages show up here.'}
        </span>
      </span>
      {unread > 0 && (
        <span className="tg-unread-badge">
          <span aria-hidden="true">{unread}</span>
          <span className="visually-hidden" id={`${id}-unread`}>{unread} unread</span>
        </span>
      )}
      <Icon name="forward" />
    </Link>
  );
}

/** Quizzes waiting for this phone: together quizzes to ask (partner, dictation, monthly) and v1 kanji quizzes to take. */
function QuizLists({ data, myId, nameOf }: { data?: QuizzesResponse; myId?: string; nameOf: (memberId: string) => string }) {
  const id = useId();
  const todo = (data?.inbox ?? []).filter((q) => !q.result && q.toMemberId === myId).slice(0, 3);
  if (!todo.length) return null;
  const label = (q: Quiz) => {
    const from = nameOf(q.fromMemberId);
    if ((q.kind ?? 'kanji') === 'kanji') return `${from} sent you ${new Set(q.items.map((i) => ('char' in i ? i.char : i.key))).size} kanji`;
    const what = q.kind === 'dictation' ? 'dictation' : q.kind === 'monthly' ? 'monthly quiz' : 'quiz';
    return `${from}'s ${what} is waiting for you to ask it`;
  };
  return (
    <div className="tg-quiz-lists">
      <p className="label">Waiting for you</p>
      <ul className="tg-quiz-list">
        {todo.map((q) => (
          <li key={q.id}>
            <Link className="tg-quiz-row tg-todo" to={`/quiz/${q.id}`} aria-labelledby={`${id}-${q.id} ${id}-${q.id}-go`}>
              <span id={`${id}-${q.id}`}>{label(q)}</span>
              <span className="tg-quiz-row-action" id={`${id}-${q.id}-go`}>{(q.kind ?? 'kanji') === 'kanji' ? 'Take the quiz' : 'Open'} <Icon name="forward" size={16} /></span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
