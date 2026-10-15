// "New today": a preview row of the items today's plan will teach. Kanji show the character and
// keyword, core words their kana and English, grammar its pattern. No romaji labels.
import { loadGrammarIndex, loadKanaRules, loadKanji, loadWordInfo } from '../../lib/data.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import type { KanaRule, KanjiEntry } from '../../lib/types.ts';
import type { NewItemKind, NewItemPlan } from '../../srs/course.ts';
import { Glyph } from '../Glyph.tsx';

export interface NewTile {
  id: string;
  kind: NewItemKind;
  /** A single character drawn with <Glyph> (kana, kanji)… */
  glyph?: string;
  /** …or a short Japanese text (words, grammar patterns). */
  text?: string;
  /** A few words of English. */
  meaning: string;
}

const firstGloss = (en: string) => en.split(/[;,(]/)[0].trim();

const SCRIPT_OF = (ch: string) => (/[゠-ヿ]/.test(ch) ? 'katakana' : 'hiragana');

export async function newItemTiles(items: readonly NewItemPlan[]): Promise<NewTile[]> {
  if (!items.length) return [];
  const has = (...kinds: NewItemKind[]) => items.some((i) => kinds.includes(i.kind));
  const [kanji, rules, grammar, wordInfo] = await Promise.all([
    has('kanji') ? loadKanji() : ({} as Record<string, KanjiEntry>),
    has('kanaRule') ? loadKanaRules() : ([] as KanaRule[]),
    has('grammar') ? loadGrammarIndex() : undefined,
    has('core', 'staged') ? loadWordInfo() : undefined,
  ]);
  return items.map((item): NewTile => {
    const base = { id: item.itemId, kind: item.kind };
    switch (item.kind) {
      case 'kana':
        return { ...base, glyph: item.key, meaning: SCRIPT_OF(item.key) };
      case 'kanaRule': {
        const rule = rules.find((r) => r.id === item.key);
        return { ...base, text: rule?.pairs[0]?.to ?? '', meaning: rule ? firstGloss(rule.title.split(':')[0]) : 'kana rule' };
      }
      case 'kanji':
        return { ...base, glyph: item.key, meaning: kanji[item.key]?.meanings[0] ?? '' };
      case 'core':
      case 'staged': {
        const word = wordInfo?.(item.itemId);
        // A core word is met by ear and in kana first; a staged word comes with its kanji spelling.
        const text = item.kind === 'core' ? word?.kana : word?.written;
        return { ...base, text: text ?? '', meaning: word ? firstGloss(word.en) : '' };
      }
      case 'grammar': {
        const point = grammar?.get(item.key);
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
