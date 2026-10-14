// Shared UI primitives. Styling lives in src/styles/global.css.
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { parseRuby } from '../lib/ruby.ts';

// ---- Icons: inline stroke SVG, 24×24 viewBox, currentColor ----
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  book: 'M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM20 19v2H6',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  people: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM17 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.5 20a6.5 6.5 0 0 1 13 0M15 14.5a5 5 0 0 1 6.5 5.5',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 6l6 6-6 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M20 6L9 17l-5-5',
  speaker: 'M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  send: 'M12 19V5M5 12l7-7 7 7',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  cloudOff: 'M2 2l20 20M5.8 5.8A6 6 0 0 0 6.5 17H17M10 4.3A7 7 0 0 1 19 10a4.5 4.5 0 0 1 2.4 7.7',
  flame: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.8 1.2 2.8 2.3 3.2C11 9.5 11 6 12 3z',
  plus: 'M12 5v14M5 12h14',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, strokeWidth = 2, filled = false }: {
  name: IconName; size?: number; strokeWidth?: number; filled?: boolean;
}) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---- Ruby text: "{明日|あした}は…" ----
/**
 * Renders ruby markup. `show` decides which readings appear:
 * 'all' every reading, 'none' none, or a predicate deciding per base text
 * (e.g. show readings only for kanji the learner does not know yet).
 */
export function Ruby({ text, show = 'all', className }: {
  text: string;
  show?: 'all' | 'none' | ((base: string) => boolean);
  className?: string;
}) {
  return (
    <span lang="ja" className={className}>
      {parseRuby(text).map((seg, i) => {
        if (seg.reading === undefined) return <span key={i}>{seg.text}</span>;
        const visible = show === 'all' || (typeof show === 'function' && show(seg.text));
        return visible
          ? <ruby key={i}>{seg.text}<rt>{seg.reading}</rt></ruby>
          : <span key={i}>{seg.text}</span>;
      })}
    </span>
  );
}

// ---- Layout ----
export function Screen({ children, tabs = false, label }: { children: ReactNode; tabs?: boolean; label?: string }) {
  return <main className={tabs ? 'screen with-tabs' : 'screen'} aria-label={label}>{children}</main>;
}

/**
 * True when this page was reached by navigating inside the app, so history back
 * stays in the app. The first page of a visit (a bookmark, a reload of the
 * start page, a link from elsewhere) has React Router's 'default' key.
 */
export function useHasInAppHistory(): boolean {
  return useLocation().key !== 'default';
}

/** Reloads the app. A function of its own so tests, where jsdom can't navigate, can replace it. */
export function reloadPage(): void {
  window.location.reload();
}

/**
 * Header row with a back (or close) button, a title and optional right-side content.
 * The title is the screen's h1 unless `heading` is false.
 */
export function TopBar({ title, back, close, right, heading = true }: {
  title?: ReactNode;
  /**
   * Where Back leads. A path is the fallback: Back goes back in history when the
   * page was opened from inside the app (so the system back gesture and this
   * button agree), and replaces the page with the path otherwise (a bookmark or
   * a reload). `true` always goes back in history.
   */
  back?: string | true;
  close?: string;
  right?: ReactNode;
  /**
   * Render the title as the screen's h1 (default). Pass false when the screen
   * has its own h1, or when the title is not text (a progress bar).
   */
  heading?: boolean;
}) {
  const navigate = useNavigate();
  const inApp = useHasInAppHistory();
  const Title = heading && title !== undefined && title !== null && title !== false ? 'h1' : 'div';
  return (
    <div className="topbar">
      {back === true && (
        <button type="button" className="icon-btn" aria-label="Back" onClick={() => navigate(-1)}>
          <Icon name="back" size={22} />
        </button>
      )}
      {typeof back === 'string' && (
        <Link className="icon-btn" aria-label="Back" to={back} replace
          onClick={(e) => {
            if (!inApp || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate(-1);
          }}>
          <Icon name="back" size={22} />
        </Link>
      )}
      {close && (
        <Link className="icon-btn" aria-label="Close" to={close}><Icon name="close" size={22} /></Link>
      )}
      <Title className="title">{title}</Title>
      {right}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="progress" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

const TABS: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'Today', icon: 'home', end: true },
  { to: '/learn', label: 'Learn', icon: 'book' },
  { to: '/write', label: 'Write', icon: 'pen' },
  { to: '/together', label: 'Together', icon: 'people' },
];

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon name={t.icon} size={22} />
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
