// The Together tab: your week next to your partner's, and ways to practise
// together (chat, tonight's role-play, quizzing each other). Works offline from
// the last household view this phone saw.

import type { Table } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MemberStats, Quiz, QuizzesResponse } from '../../shared/api.ts';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { memberName, sharedKanji, splitHousehold, timeAgo, useNow } from '../components/together/household.ts';
import { useRolePlayInvite } from '../components/together/live.ts';
import { QuizSender } from '../components/together/QuizSender.tsx';
import { useQuizzes } from '../components/together/quizzes.ts';
import { levelForPhase, pickTonight } from '../components/together/rolePlay.ts';
import { lastReadMessageId, rolePlayHistory } from '../components/together/storage.ts';
import '../components/together/together.css';
import { WeekChart } from '../components/together/WeekChart.tsx';
import { Icon, Ruby, Screen } from '../components/ui.tsx';
import { loadRolePlays } from '../lib/data.ts';
import { db } from '../lib/db.ts';
import { useKnownKanji, useRubyShow, useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import type { RolePlay, Settings } from '../lib/types.ts';
import { currentPhase } from '../srs/course.ts';
import type { PendingMessage } from '../sync/outbox.ts';
import { onServerEvent, useServerStatus, type ServerStatus } from '../sync/socket.ts';
import { useHousehold } from '../sync/stats.ts';

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
        <h2 id="together-explain">Practise with your partner</h2>
        <ul className="tg-feature-list">
          <li><Icon name="chat" /><span><strong>Text in Japanese.</strong> A private tip can help before you send.</span></li>
          <li><Icon name="mic" /><span><strong>Act out role-plays</strong> out loud, on two phones or one.</span></li>
          <li><Icon name="pen" /><span><strong>Quiz each other</strong> on the kanji you miss most.</span></li>
          <li><Icon name="people" /><span><strong>See each other's week</strong> and keep a shared streak.</span></li>
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
  const { me, partner } = splitHousehold(data);
  const partnerName = partner?.member.name ?? 'Your partner';
  const invite = useRolePlayInvite();

  useEffect(() => onServerEvent((ev) => {
    if (ev.type === 'stats') void refresh();
  }), [refresh]);

  return (
    <Screen tabs label="Together">
      <Header status={<SyncStatus status={status} fetchedAt={fetchedAt} hasData={Boolean(data)} failed={Boolean(error)} />} />

      {invite && (!partner || invite.memberId === partner.member.id) && (
        <Link to={`/roleplay/${invite.state.scriptId}`} className="tg-invite-banner">
          <Icon name="mic" />
          <span><strong>{partnerName} started a role-play.</strong> Tap to join them.</span>
          <Icon name="forward" />
        </Link>
      )}

      {data ? (
        <WeekCard me={me} partner={partner} partnerName={partnerName} sharedStreak={data.sharedStreak} />
      ) : loading || !error ? (
        <div className="tg-skeleton-block" aria-busy="true" aria-label="Loading your week" />
      ) : (
        <div className="tg-notice-card">
          <h2>{status === 'offline' ? "You're offline" : "Couldn't reach your home server"}</h2>
          <p>Your week and your partner's show up here once this phone connects.</p>
          <button type="button" className="btn secondary small" onClick={() => void refresh()}>Try again</button>
        </div>
      )}

      <h2 className="label tg-section-label">Practice together</h2>
      <ChatCard myId={settings.memberId} />
      <RolePlayCard />
      <QuizSender partnerId={partner?.member.id} partnerName={partnerName}>
        <QuizLists data={quizzes.data} nameOf={(memberId) => memberName(data, memberId, partnerName)} />
      </QuizSender>
    </Screen>
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

function WeekCard({ me, partner, partnerName, sharedStreak }: {
  me?: MemberStats;
  partner?: MemberStats;
  partnerName: string;
  sharedStreak: number;
}) {
  const local = useKnownKanji();
  // This phone's own list is fresher than the copy it last uploaded.
  const mine = local.size ? [...local] : me?.knownKanji ?? [];
  const both = partner ? sharedKanji(mine, partner.knownKanji).length : 0;

  return (
    <section className="card" aria-labelledby="week-title">
      <div className="tg-week-head">
        <h2 id="week-title">This week</h2>
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
          <dt>Shared streak</dt>
          {/* Alone in the household, the server's "every member" streak is just your own. */}
          <dd>{partner ? <>{sharedStreak} <span className="tg-stat-unit">{sharedStreak === 1 ? 'day' : 'days'}</span></> : '–'}</dd>
        </div>
        <div className="tg-stat">
          <dt>Kanji known{partner ? <span className="tg-stat-sub"> you · {partnerName}</span> : null}</dt>
          <dd>{mine.length}{partner && <span className="tg-stat-sep"> · </span>}{partner?.kanjiKnown}</dd>
        </div>
        <div className="tg-stat">
          <dt>You both know</dt>
          <dd>{partner ? both : '–'}</dd>
        </div>
      </dl>
    </section>
  );
}

function ChatCard({ myId }: { myId?: string }) {
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

  return (
    <Link to="/chat" className="tg-chat-card">
      <span className="tg-chat-card-icon" aria-hidden="true"><Icon name="chat" size={22} /></span>
      <span className="tg-chat-card-body">
        <span className="tg-chat-card-title">Chat in Japanese</span>
        <span className="tg-chat-card-preview">
          {summary === undefined ? ' '
            : summary.failed > 0 ? `${summary.failed} not sent · open the chat to retry`
              : summary.waiting > 0 ? `${summary.waiting} waiting to send`
                : body ? <>{mine && 'You: '}<span lang="ja">{body}</span></>
                  : 'Say hello. Your messages show up here.'}
        </span>
      </span>
      {summary && summary.unread > 0 && (
        <span className="tg-unread-badge">
          <span aria-hidden="true">{summary.unread}</span>
          <span className="visually-hidden">{summary.unread} unread</span>
        </span>
      )}
      <Icon name="forward" />
    </Link>
  );
}

function RolePlayCard() {
  const rubyShow = useRubyShow();
  const [state, setState] = useState<{ script?: RolePlay; failed?: boolean }>();

  useEffect(() => {
    let live = true;
    Promise.all([loadRolePlays(), currentPhase().catch(() => 1)]).then(
      ([scripts, phase]) => { if (live) setState({ script: pickTonight(scripts, levelForPhase(phase), rolePlayHistory()) }); },
      () => { if (live) setState({ failed: true }); },
    );
    return () => { live = false; };
  }, []);

  const script = state?.script;
  return (
    <section className="card tg-roleplay-card" aria-labelledby="tonight-title">
      <p className="label" id="tonight-title">Tonight's role-play</p>
      {!state && <div className="tg-skeleton-line" aria-busy="true" />}
      {state && !script && (
        <p className="muted">Role-plays couldn't load right now. <Link to="/roleplay">See all role-plays</Link></p>
      )}
      {script && (
        <>
          <h3 className="tg-rp-card-title">{script.title}</h3>
          <p className="tg-rp-card-jp"><Ruby text={script.titleJp} show={rubyShow} /></p>
          <p className="muted">{script.setting}</p>
          <div className="tg-button-row">
            <Link className="btn indigo small" to={`/roleplay/${script.id}`}>
              <Icon name="mic" size={18} />Start role-play
            </Link>
            <Link className="btn ghost small" to="/roleplay">See all</Link>
          </div>
        </>
      )}
    </section>
  );
}

function SentResult({ quiz, partnerName }: { quiz: Quiz; partnerName: string }) {
  const chars = quiz.items.map((i) => i.char).join(' ');
  if (!quiz.result) {
    return <span>Waiting for {partnerName} · <span lang="ja">{chars}</span></span>;
  }
  const { correct, total, missed } = quiz.result;
  const fresh = quiz.items.length - total;
  if (total === 0) return <span>All {quiz.items.length} kanji were new to {partnerName}</span>;
  return (
    <span>
      {partnerName} got {correct}/{total}
      {missed.length > 0 ? <> — missed <span lang="ja" className="tg-missed-kanji">{missed.join(' ')}</span></> : ' — every one'}
      {fresh > 0 && <span className="muted"> · {fresh} new to them</span>}
    </span>
  );
}

function QuizLists({ data, nameOf }: { data?: QuizzesResponse; nameOf: (memberId: string) => string }) {
  const todo = data?.inbox.filter((q) => !q.result).slice(0, 3) ?? [];
  const sent = data?.sent.slice(0, 3) ?? [];
  if (!todo.length && !sent.length) return null;
  return (
    <div className="tg-quiz-lists">
      {todo.length > 0 && (
        <>
          <p className="label">For you</p>
          <ul className="tg-quiz-list">
            {todo.map((q) => (
              <li key={q.id}>
                <Link className="tg-quiz-row tg-todo" to={`/quiz/${q.id}`}>
                  <span>{nameOf(q.fromMemberId)} sent you {q.items.length} kanji</span>
                  <span className="tg-quiz-row-action">Take the quiz <Icon name="forward" size={16} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {sent.length > 0 && (
        <>
          <p className="label">You sent</p>
          <ul className="tg-quiz-list">
            {sent.map((q) => <li key={q.id} className="tg-quiz-row"><SentResult quiz={q} partnerName={nameOf(q.toMemberId)} /></li>)}
          </ul>
        </>
      )}
    </div>
  );
}
