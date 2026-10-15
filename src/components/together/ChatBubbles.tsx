// Chat message bubbles: text (with optional readings), voice, delivery state, and the
// "Today's sentence" label on output-step messages (with Reply on the partner's).

import { useEffect, useMemo, useRef, useState } from 'react';
import { dayKey } from '../../lib/db.ts';
import { discardMessage, retryMessage } from '../../sync/outbox.ts';
import type { ChatItem } from '../../sync/chat.ts';
import { OTHER_HOUSEHOLD } from '../../sync/client.ts';
import { useVoiceUrl } from '../../sync/voice.ts';
import { Icon } from '../ui.tsx';
import type { FuriganaDict } from './furigana.ts';
import { FuriganaText } from './FuriganaText.tsx';
import { TIcon } from './icons.tsx';

type Show = 'all' | 'none' | ((base: string) => boolean);

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * When a message was written: the time on the writer's phone (a message written
 * offline is delivered later), else when the server got it.
 */
export function shownAt(m: { createdAt: string; writtenAt?: string }): string {
  return m.writtenAt ?? m.createdAt;
}

/** Local calendar day of a timestamp, for day separators. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDay(iso) === localDay(now.toISOString())) return 'Today';
  if (localDay(iso) === localDay(yesterday.toISOString())) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Bar heights (0.25..1) for a voice message, stable per message. */
export function waveform(seed: string, bars = 28): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: bars }, (_, i) => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const r = ((h >>> 0) % 1000) / 1000;
    // Louder in the middle, like a spoken phrase.
    const envelope = Math.sin(((i + 0.5) / bars) * Math.PI);
    return 0.25 + 0.75 * (0.4 * envelope + 0.6 * r);
  });
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function VoiceBody({ item }: { item: ChatItem }) {
  const { url, error } = useVoiceUrl(item.audioId, item.audio);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [position, setPosition] = useState(0);
  const bars = useMemo(() => waveform(item.clientId), [item.clientId]);
  const progress = duration && Number.isFinite(duration) ? position / duration : 0;

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };

  return (
    <div className="tg-voice">
      <button type="button" className="tg-voice-play" onClick={toggle} disabled={!url}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}>
        {playing ? <TIcon name="pause" size={18} strokeWidth={3} /> : <Icon name="play" size={16} filled />}
      </button>
      <span className="tg-voice-wave" aria-hidden="true">
        {bars.map((b, i) => (
          <span key={i} className={(i + 0.5) / bars.length <= progress ? 'tg-played' : undefined} style={{ height: `${b * 100}%` }} />
        ))}
      </span>
      <span className="tg-voice-time">{formatDuration(playing || position > 0 ? position : duration) || 'Voice'}</span>
      {url && (
        <audio ref={audio} src={url} preload="metadata"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setPosition(0); }} />
      )}
      {error && <span className="tg-voice-error">Couldn't load the recording.</span>}
    </div>
  );
}

const FAILURE_REASONS: Record<string, string> = {
  too_large: 'It was too big to send.',
  missing_audio: 'The recording was lost.',
  invalid_request: "The server couldn't accept it.",
  [OTHER_HOUSEHOLD]: 'It was written for another household. Retry sends it here.',
};

function Delivery({ item, online }: { item: ChatItem; online: boolean }) {
  // Deleting an unsent message can't be undone, so it asks once more.
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  /** Set by a tap on Delete or Keep: keyboard focus stays on the row as its buttons swap. */
  const refocus = useRef<'keep' | 'delete'>();
  const ask = (yes: boolean) => {
    refocus.current = yes ? 'keep' : 'delete';
    setConfirming(yes);
  };
  useEffect(() => {
    const target = refocus.current === 'keep' ? keepRef.current : refocus.current === 'delete' ? deleteRef.current : null;
    refocus.current = undefined;
    target?.focus();
  }, [confirming]);

  if (item.status === 'failed') {
    return (
      <div className="tg-bubble-meta tg-failed" role="alert">
        <TIcon name="alert" size={14} />
        {confirming ? (
          <>
            <span>Delete this message? It can't be undone.</span>
            <button type="button" className="tg-link-btn" onClick={() => {
              // The row goes away with its buttons: carry on writing in the composer.
              void discardMessage(item.clientId).then(() => document.querySelector<HTMLElement>('.tg-composer-input')?.focus());
            }}>Delete</button>
            <button ref={keepRef} type="button" className="tg-link-btn" onClick={() => ask(false)}>Keep</button>
          </>
        ) : (
          <>
            <span>Not sent{item.error && FAILURE_REASONS[item.error] ? `. ${FAILURE_REASONS[item.error]}` : ''}</span>
            <button type="button" className="tg-link-btn" onClick={() => void retryMessage(item.clientId)}>Retry</button>
            <button ref={deleteRef} type="button" className="tg-link-btn" onClick={() => ask(true)}>Delete</button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="tg-bubble-meta tg-pending">
      <TIcon name="clock" size={14} />
      <span>{online ? 'Sending…' : 'Waiting for connection'}</span>
    </div>
  );
}

/** The partner's "today's sentence" of today: replying to it can count as your own. */
export function isPartnersDailyToday(item: Pick<ChatItem, 'tag' | 'mine' | 'createdAt' | 'writtenAt'>, now: Date = new Date()): boolean {
  return item.tag === 'daily' && !item.mine && dayKey(new Date(shownAt(item))) === dayKey(now);
}

export function MessageBubble({ item, dict, show, online, showTime, withDate = false, senderName, onReply }: {
  item: ChatItem;
  /** Reply to the partner's daily sentence (offered on those only). */
  onReply?(item: ChatItem): void;
  dict?: FuriganaDict;
  show: Show;
  online: boolean;
  /** Show the time under this bubble (last of a run from one person). */
  showTime: boolean;
  /** Written on another day than the separator above it says (it was delivered late). */
  withDate?: boolean;
  senderName: string;
}) {
  if (item.kind === 'system') return <p className="tg-chat-system">{item.text}</p>;
  const side = item.mine ? 'mine' : 'theirs';
  const at = shownAt(item);
  return (
    <div className={`tg-bubble-row tg-${side}${item.status === 'sent' ? '' : ` tg-${item.status}`}`}>
      <div className={`tg-bubble tg-${side}${item.kind === 'voice' ? ' tg-voice-bubble' : ''}`}>
        <span className="visually-hidden">{item.mine ? 'You' : senderName}: </span>
        {item.tag === 'daily' && <span className="tg-daily-label">Today's sentence</span>}
        {item.kind === 'voice' && <VoiceBody item={item} />}
        {item.text && <FuriganaText text={item.text} dict={dict} show={show} />}
        {item.kind === 'voice' && item.transcript && (
          <FuriganaText text={item.transcript} dict={dict} show={show} className="tg-voice-transcript" />
        )}
      </div>
      {onReply && isPartnersDailyToday(item) && (
        <button type="button" className="tg-link-btn tg-reply-btn" onClick={() => onReply(item)}>Reply</button>
      )}
      {item.status !== 'sent'
        ? <Delivery item={item} online={online} />
        : (showTime || withDate) && (
          <time className="tg-bubble-meta" dateTime={at}>{withDate ? `${dayLabel(at)}, ${timeOf(at)}` : timeOf(at)}</time>
        )}
    </div>
  );
}

/** Messages from one person this close together share one time label. */
const GROUP_GAP_MS = 5 * 60_000;

/** Local midnight before `iso` (ms epoch). */
function startOfDay(iso: string): number {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The conversation: bubbles in delivery order, with day separators and grouped times. */
export function MessageList({ messages, dict, show, online, senderName, onReply }: {
  messages: ChatItem[];
  dict?: FuriganaDict;
  show: Show;
  online: boolean;
  senderName: (memberId: string) => string;
  onReply?(item: ChatItem): void;
}) {
  const rows = [];
  // The day of the last separator. Messages stay in delivery order, so one written
  // offline can come after newer ones: it goes under the current separator with its
  // own date, and separators only ever move forward (one per day).
  let day = '';
  let dayStart = -Infinity;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const at = shownAt(m);
    const d = localDay(at);
    const start = startOfDay(at);
    if (start > dayStart) {
      day = d;
      dayStart = start;
      rows.push(<p key={`day-${d}`} className="tg-day-sep"><span>{dayLabel(at)}</span></p>);
    }
    const next = messages[i + 1];
    const nextAt = next ? shownAt(next) : '';
    const showTime = !next || next.mine !== m.mine || localDay(nextAt) !== d
      || Math.abs(Date.parse(nextAt) - Date.parse(at)) > GROUP_GAP_MS;
    rows.push(
      <MessageBubble key={m.key} item={m} dict={dict} show={show} online={online} showTime={showTime}
        withDate={d !== day} senderName={senderName(m.memberId)} onReply={onReply} />,
    );
  }
  return <>{rows}</>;
}
