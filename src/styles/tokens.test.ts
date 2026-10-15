// Contrast of the colour tokens in both themes, and the CSS rules behind a few
// accessibility fixes that jsdom can't lay out.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const globalCss = read('./global.css');
const homeCss = read('../components/home/home.css');
const libraryCss = read('../components/home/library.css');
const writingCss = read('../writing/writing.css');

/** Token values: the light ones from the first :root block, the dark ones from :root[data-theme="dark"]. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(globalCss.slice(globalCss.indexOf(':root {'), globalCss.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(globalCss.slice(globalCss.indexOf(':root[data-theme="dark"]'))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([['light', light], ['dark', dark]] as const)('%s theme tokens', (_, t) => {
  it('gives text fields a border of at least 3:1 on the card and the page', () => {
    expect(contrast(t['line-input'], t.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(t['line-input'], t.paper)).toBeGreaterThanOrEqual(3);
  });

  it('makes the character to trace visible (3:1, a graphic the learner needs) but still clearly lighter than ink', () => {
    expect(contrast(t.ghost, t.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(t.ink, t.ghost)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps placeholders (muted text) at 4.5:1 on the card', () => {
    expect(contrast(t.muted, t.card)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('accessibility CSS', () => {
  it('themes placeholders and uses the stronger border for text fields', () => {
    expect(globalCss).toMatch(/::placeholder\s*{\s*color:\s*var\(--muted\);\s*opacity:\s*1;/);
    expect(globalCss).toMatch(/\.text-input\s*{[^}]*border:\s*1px solid var\(--line-input\)/);
  });

  it('stops looping animations under reduced motion instead of running them every millisecond', () => {
    const reduced = globalCss.slice(globalCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/animation-iteration-count:\s*1 !important/);
  });

  it('draws the focus ring in the dark session panel in its text colour (light theme: 15:1 instead of 2.8:1)', () => {
    expect(homeCss).toMatch(/\.plan-panel\s*{[^}]*--focus-ring:\s*var\(--panel-fg\)/);
    expect(globalCss).toMatch(/:focus-visible\s*{\s*outline:\s*2px solid var\(--focus-ring\)/);
    expect(contrast(light['on-ink'], light.ink)).toBeGreaterThanOrEqual(3);
    expect(contrast(light.shu, light.ink)).toBeLessThan(3);
  });

  it('draws each streak day status its own way (goal filled, done ring-filled, rest and travel dashes, repaired dot, today ring)', () => {
    for (const status of ['goal', 'done', 'rest', 'travel', 'repaired', 'today']) {
      expect(homeCss).toMatch(new RegExp(`\\.streak-day\\.${status} \\.streak-dot`));
    }
    expect(homeCss).toMatch(/\.streak-day\.goal \.streak-dot\s*{[^}]*background:\s*var\(--shu\)/);
    expect(homeCss).toMatch(/\.streak-day\.repaired \.streak-dot::after/);
  });

  it('lets a long name wrap in the Today greeting', () => {
    expect(homeCss).toMatch(/\.today-greeting\s*{[^}]*overflow-wrap:\s*anywhere/);
    expect(homeCss).toMatch(/\.today-head > div\s*{[^}]*min-width:\s*0/);
  });

  it('dims the page behind the kana sheet in both themes', () => {
    expect(libraryCss).toMatch(/\.hm-sheet-backdrop\s*{[^}]*background:\s*var\(--ink-soft\)/);
    expect(contrast(dark['ink-soft'], '#FFFFFF')).toBeGreaterThan(10);
  });

  it('traces over the ghost token, not the faint one', () => {
    expect(writingCss).toMatch(/\.wp-ghost\s*{\s*stroke:\s*var\(--ghost\)/);
    expect(writingCss).toMatch(/\.wp-guide\s*{[^}]*stroke:\s*var\(--ghost\)/);
  });
});
