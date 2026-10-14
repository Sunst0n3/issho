// "New today": a preview row of the items today's session will teach.
import { loadGrammar, loadKana, loadKanji, loadRadicals, loadSurvivalWords } from '../../lib/data.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import type { GrammarPoint, KanaEntry, KanjiEntry, RadicalEntry, SurvivalWord } from '../../lib/types.ts';
import type { NewItemKind, NewItemPlan } from '../../srs/course.ts';
import { Glyph } from '../Glyph.tsx';

export interface NewTile {
  id: string;
  kind: NewItemKind;
  /** A single character drawn with <Glyph> (kana, radicals, kanji)… */
  glyph?: string;
  /** …or a short Japanese text (survival words, grammar patterns). */
  text?: string;
  /** One word of English (romaji for kana). */
  meaning: string;
}

const firstGloss = (en: string) => en.split(/[;,(]/)[0].trim();

export async function newItemTiles(items: readonly NewItemPlan[]): Promise<NewTile[]> {
  if (!items.length) return [];
  const has = (kind: NewItemKind) => items.some((i) => i.kind === kind);
  const [kana, kanji, radicals, survival, grammar] = await Promise.all([
    has('kana') ? loadKana() : ([] as KanaEntry[]),
    has('kanji') ? loadKanji() : ({} as Record<string, KanjiEntry>),
    has('radical') ? loadRadicals() : ([] as RadicalEntry[]),
    has('vocab') ? loadSurvivalWords() : ([] as SurvivalWord[]),
    has('grammar') ? loadGrammar() : ([] as GrammarPoint[]),
  ]);
  return items.map((item): NewTile => {
    const base = { id: item.itemId, kind: item.kind };
    switch (item.kind) {
      case 'kana':
        return { ...base, glyph: item.key, meaning: kana.find((k) => k.char === item.key)?.romaji ?? '' };
      case 'kanji':
        return { ...base, glyph: item.key, meaning: kanji[item.key]?.meanings[0] ?? '' };
      case 'radical':
        return { ...base, glyph: item.key, meaning: radicals.find((r) => r.char === item.key)?.meaning ?? 'part' };
      case 'vocab': {
        const word = survival.find((w) => w.id === item.key);
        return { ...base, text: word?.kana ?? '', meaning: word ? firstGloss(word.en) : '' };
      }
      case 'grammar': {
        const point = grammar.find((g) => g.id === item.key);
        return { ...base, text: point ? rubyToPlain(point.pattern) : '', meaning: 'grammar' };
      }
    }
  });
}

export function NewToday({ tiles }: { tiles: readonly NewTile[] }) {
  if (!tiles.length) return null;
  return (
    <section className="newtoday" aria-labelledby="new-today-title">
      <h2 id="new-today-title" className="hm-section-title">New today</h2>
      <ul className="newtoday-tiles">
        {tiles.map((t) => (
          <li key={t.id} className={t.text && [...t.text].length > 2 ? 'newtoday-tile wide' : 'newtoday-tile'}>
            {t.glyph ? <Glyph char={t.glyph} size={30} /> : <span className="newtoday-text" lang="ja">{t.text}</span>}
            <span className="newtoday-meaning">{t.meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
