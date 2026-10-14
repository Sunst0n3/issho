// Chat with your partner, in Japanese. Messages are saved on this phone first
// and sent when the home server is reachable, so writing works offline.

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { markAiDisabled, useAiAvailable } from '../components/together/ai.ts';
import { dayLabel, localDay, MessageBubble } from '../components/together/ChatBubbles.tsx';
import { Composer, type ComposerHandle } from '../components/together/Composer.tsx';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { useFuriganaDict } from '../components/together/furigana.ts';
import { initialOf, memberName, splitHousehold } from '../components/together/household.ts';
import { TIcon } from '../components/together/icons.tsx';
import { markMessagesRead, readJson, STORAGE_KEYS, writeJson } from '../components/together/storage.ts';
import '../components/together/together.css';
import { Screen, TopBar } from '../components/ui.tsx';
import { db } from '../lib/db.ts';
import { useKnownKanji, useRubyShow, useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import { isKanji } from '../lib/ruby.ts';
import type { Settings } from '../lib/types.ts';
import { syncMessages, useChatMessages, type ChatItem } from '../sync/chat.ts';
import { useServerStatus } from '../sync/socket.ts';
import { useHousehold } from '../sync/stats.ts';

const GROUP_GAP_MS = 5 * 60_000;
const STARTERS = ['おはよう', 'こんにちは', 'げんき？'];
/**
 * The helper only needs the gist of earlier lines, and the server refuses a whole
 * check when one of them runs past 1,000 characters.
 */
const CONTEXT_LINE_MAX = 300;

const page = () => document.scrollingElement ?? document.documentElement;

/**
 * Scrolls to the newest message. The composer sticks to the bottom over the end of
 * the log, so the page goes all the way down rather than bringing the log's end into view.
 */
function scrollToNewest(behavior: ScrollBehavior = 'auto') {
  const el = page();
  el.scrollTo?.({ top: el.scrollHeight, behavior });
}

export default function Chat() {
  const settings = useSettings();
  const loaded = useSettingsLoaded();
  if (!loaded) return <Screen label="Chat"><div className="tg-skeleton-block tg-tall" aria-busy="true" /></Screen>;
  if (!settings.deviceToken) {
    return (
      <Screen label="Chat">
        <TopBar back="/together" title="Chat" />
        <div className="tg-together-intro">
          <h1 className="tg-together-title">Text each other in Japanese</h1>
          <p className="muted">
            Chat goes through your home server. Connect this phone and your messages wait here until they can be sent.
          </p>
        </div>
        <ConnectServerForm compact onConnected={() => {}} />
      </Screen>
    );
  }
  return <Conversation settings={settings} />;
}

function Conversation({ settings }: { settings: Settings }) {
  const messages = useChatMessages();
  const status = useServerStatus();
  const online = status === 'online';
  const { data } = useHousehold();
  const partnerName = splitHousehold(data).partner?.member.name ?? 'Your partner';
  const senderName = (memberId: string) => memberName(data, memberId, partnerName);
  const known = useKnownKanji();
  const rubyShow = useRubyShow();
  const [aiOff, setAiOff] = useState(false);
  const aiOn = useAiAvailable(online) && !aiOff;

  const [furigana, setFurigana] = useState(() => readJson<boolean>(STORAGE_KEYS.chatFurigana, settings.furigana !== 'never'));
  const dict = useFuriganaDict(furigana);
  const show = useMemo(() => {
    if (!furigana) return 'none' as const;
    if (settings.furigana === 'always') return 'all' as const;
    return (base: string) => [...base].some((ch) => isKanji(ch) && !known.has(ch));
  }, [furigana, settings.furigana, known]);

  const recentKanji = useLiveQuery(async () => {
    const items = await db.items.where('kind').equals('kanji').toArray();
    return items.sort((a, b) => b.introducedAt.getTime() - a.introducedAt.getTime()).slice(0, 8).map((i) => i.key);
  }, []) ?? [];

  const composer = useRef<ComposerHandle>(null);
  const atBottom = useRef(true);
  const firstScroll = useRef(true);
  const [newBelow, setNewBelow] = useState(false);

  useEffect(() => { syncMessages().catch(() => { /* offline: the cached conversation still shows */ }); }, []);

  const newestId = messages?.reduce((max, m) => Math.max(max, m.id ?? 0), 0) ?? 0;
  useEffect(() => { if (newestId) markMessagesRead(newestId); }, [newestId]);

  useEffect(() => {
    const onScroll = () => {
      const el = page();
      atBottom.current = el.scrollHeight - el.scrollTop - window.innerHeight < 120;
      if (atBottom.current) setNewBelow(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const last = messages?.[messages.length - 1];
  useLayoutEffect(() => {
    if (!last) return;
    // Follow the conversation unless the reader scrolled up to read older messages.
    if (firstScroll.current || atBottom.current || last.mine) {
      scrollToNewest(firstScroll.current ? 'auto' : 'smooth');
      setNewBelow(false);
    } else {
      setNewBelow(true);
    }
    firstScroll.current = false;
  }, [last?.key]);

  // Readings make lines taller: when the dictionary arrives (usually after the first
  // scroll) or furigana is switched on, keep a reader at the bottom there.
  useLayoutEffect(() => {
    if (atBottom.current) scrollToNewest();
  }, [dict, furigana]);

  const context = useMemo(
    () => (messages ?? [])
      .filter((m) => m.kind === 'text' && m.text)
      .slice(-6)
      .map((m) => `${m.mine ? 'Me' : memberName(data, m.memberId, partnerName)}: ${m.text}`.slice(0, CONTEXT_LINE_MAX)),
    [messages, data, partnerName],
  );

  const toggleFurigana = () => {
    setFurigana(!furigana);
    writeJson(STORAGE_KEYS.chatFurigana, !furigana);
  };

  return (
    <Screen label={`Chat with ${partnerName}`}>
      <div className="tg-chat-head">
        <TopBar back="/together"
          title={(
            <span className="tg-chat-who">
              <span className="tg-avatar" aria-hidden="true">{initialOf(partnerName)}</span>
              <span className="tg-chat-who-text">
                <span className="tg-chat-name">{partnerName}</span>
                <span className="tg-chat-sub">
                  {online ? 'Japanese only' : <><TIcon name="wifi" size={12} /> Offline · messages wait to send</>}
                </span>
              </span>
            </span>
          )}
          right={(
            <button type="button" className="tg-furigana-toggle" aria-pressed={furigana} onClick={toggleFurigana}
              aria-label="Show readings over kanji">
              <span lang="ja" aria-hidden="true">ふり</span>
              <span lang="ja" aria-hidden="true">漢</span>
            </button>
          )} />
      </div>

      <section className="tg-chat-log" role="log" aria-label="Messages">
        {messages === undefined && <ChatSkeleton />}
        {messages?.length === 0 && (
          <div className="tg-chat-empty">
            <p>Say hello in Japanese. Tap one to start:</p>
            <div className="tg-button-row tg-center">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="btn secondary small" lang="ja" onClick={() => composer.current?.insert(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages && messages.length > 0 && (
          <MessageList messages={messages} dict={dict} show={show} online={online} senderName={senderName} />
        )}
      </section>

      <div className="tg-chat-foot">
        {newBelow && (
          <button type="button" className="tg-new-pill" onClick={() => {
            scrollToNewest('smooth');
            setNewBelow(false);
          }}>
            New messages <TIcon name="down" size={16} />
          </button>
        )}
        <Composer ref={composer} online={online} aiOn={aiOn} knownKanji={[...known]}
          onAiOff={() => {
            markAiDisabled();
            setAiOff(true);
          }}
          recentKanji={recentKanji} context={context} rubyShow={rubyShow} />
      </div>
    </Screen>
  );
}

function MessageList({ messages, dict, show, online, senderName }: {
  messages: ChatItem[];
  dict: ReturnType<typeof useFuriganaDict>;
  show: 'all' | 'none' | ((base: string) => boolean);
  online: boolean;
  senderName: (memberId: string) => string;
}) {
  const rows = [];
  let day = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const d = localDay(m.createdAt);
    if (d !== day) {
      day = d;
      rows.push(<p key={`day-${d}`} className="tg-day-sep"><span>{dayLabel(m.createdAt)}</span></p>);
    }
    const next = messages[i + 1];
    const showTime = !next || next.mine !== m.mine || localDay(next.createdAt) !== d
      || Date.parse(next.createdAt) - Date.parse(m.createdAt) > GROUP_GAP_MS;
    rows.push(
      <MessageBubble key={m.key} item={m} dict={dict} show={show} online={online} showTime={showTime} senderName={senderName(m.memberId)} />,
    );
  }
  return <>{rows}</>;
}

function ChatSkeleton() {
  return (
    <div className="tg-chat-skeleton" aria-busy="true" aria-label="Loading messages">
      <span className="tg-skeleton-bubble tg-theirs" />
      <span className="tg-skeleton-bubble tg-mine" />
      <span className="tg-skeleton-bubble tg-theirs tg-short" />
    </div>
  );
}
