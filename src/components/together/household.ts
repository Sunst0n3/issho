// Helpers for reading the household view and talking about time in plain words.

import { useEffect, useState } from 'react';
import type { HouseholdResponse, MemberStats } from '../../../shared/api.ts';

export interface HouseholdPair {
  me?: MemberStats;
  /** The other member: a household is a couple, so the other one active most recently. */
  partner?: MemberStats;
}

/** Last sign of life from a member: seen online, or stats uploaded (ms epoch, 0 = never). */
function lastActive(m: MemberStats): number {
  return Math.max(Date.parse(m.member.lastSeenAt ?? '') || 0, Date.parse(m.updatedAt ?? '') || 0);
}

export function splitHousehold(data: HouseholdResponse | undefined): HouseholdPair {
  if (!data) return {};
  // Members come oldest first, so a leftover member (a test, or a name typed differently
  // on a new phone) would otherwise hide the real partner.
  const partner = data.members
    .filter((m) => m.member.id !== data.me)
    .reduce<MemberStats | undefined>((best, m) => (!best || lastActive(m) > lastActive(best) ? m : best), undefined);
  return { me: data.members.find((m) => m.member.id === data.me), partner };
}

/**
 * Who a message or quiz is from: the member's current name, or "Former member" for
 * someone removed from the household (what they sent stays). `fallback` until the
 * household has loaded.
 */
export function memberName(data: HouseholdResponse | undefined, memberId: string, fallback = 'Your partner'): string {
  if (!data) return fallback;
  const member = data.members.find((m) => m.member.id === memberId);
  return member ? member.member.name || fallback : 'Former member';
}

export function initialOf(name: string | undefined): string {
  return [...(name ?? '').trim()][0]?.toUpperCase() ?? '?';
}

/** Kanji both members have been introduced to. */
export function sharedKanji(a: readonly string[] = [], b: readonly string[] = []): string[] {
  const other = new Set(b);
  return a.filter((k) => other.has(k));
}

/** 'YYYY-MM-DD' → that calendar day at local noon (safe from DST and the 4 a.m. rollover). */
export function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
}

export function weekdayShort(key: string): string {
  return dateFromKey(key).toLocaleDateString('en-US', { weekday: 'narrow' });
}

export function weekdayLong(key: string): string {
  return dateFromKey(key).toLocaleDateString('en-US', { weekday: 'long' });
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Oct". */
export function timeAgo(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The current time, re-read every `intervalMs` so "2 min ago" labels stay true. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
