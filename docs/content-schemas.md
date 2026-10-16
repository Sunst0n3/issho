# Issho v2 content schemas (source of truth for content authors and the engine)

All Japanese text with kanji uses ruby markup `{漢字|かんじ}` (see src/lib/ruby.ts). Every kanji
must carry a reading. Kana-only text needs no markup. JSON files are UTF-8, pretty-printed with
2-space indent, arrays in the stated order.

## content/core-words.json — CoreWord[] (~1,500, replaces survival-words.json)
```ts
interface CoreWord {
  id: string;            // 'cw-0001' … stable, zero-padded, in `order`
  order: number;         // teaching order, 1-based, no gaps
  kana: string;          // how it is read: hiragana, or katakana for loanwords ('コーヒー')
  written?: string;      // usual written form when it is normally written with kanji ('食べる'); omit for usually-kana words
  jmdict?: string;       // JMdict ent_seq of the entry (look it up in data-raw/JMdict_e.gz)
  en: string;            // short English gloss, ≤ 40 chars; verbs 'to eat'; disambiguate homonyms
  pos: 'noun' | 'verb-ru' | 'verb-u' | 'verb-irr' | 'adj-i' | 'adj-na' | 'adverb' | 'particle-phrase' | 'expression' | 'pronoun' | 'demonstrative' | 'counter' | 'number' | 'conjunction' | 'interjection' | 'suffix' | 'prefix';
  register: 'polite' | 'plain' | 'both';
  topic: string;         // one of: conversation, greetings, people, family, home, food, drink, shopping, money, time, calendar, numbers, places, transport, travel, weather, body, health, feelings, work, school, hobbies, nature, animals, clothes, colors, actions, describing, questions, function
  use: boolean;          // true = the learner should be able to SAY/WRITE it (active); false = recognise only. ~first 400 are true.
  note?: string;         // usage nuance in ≤ 80 chars ('casual between friends/partners', 'humble')
  survival?: string;     // old survival-words.json id when this entry replaces one ('sw-arigatou')
}
```
Ordering: conversation-control phrases and greetings first (もう一度お願いします, ゆっくり話してください, 〜って何？, どういう意味？, すみません, ありがとう…), then core function words (これ/それ/あれ, ある/いる, する, この, もう, まだ, でも, とても…), then frequency weighted by topic usefulness for a couple's daily life at home (food, home, time, feelings, plans). Everything must be genuinely common, everyday Japanese; no newspaper/formal-only vocabulary in the first 800.

## content/kana-rules.json — KanaRule[] (rule lessons for the 14-day kana sprint)
```ts
interface KanaRule {
  id: 'hira-dakuten' | 'hira-yoon' | 'kata-dakuten-yoon' | 'kata-extended';
  day: number;           // 6, 7, 13, 14
  title: string;         // 'Voiced sounds: ゛ and ゜'
  explanation: string;   // 2–4 plain sentences
  pairs: { from: string; to: string; romaji: string }[];   // e.g. か→が 'ga' (covers every character of the rule)
  practiceWords: { kana: string; en: string }[];            // 8 real, common words using only kana taught by that day
}
```

## content/grammar-v2.json — GrammarPoint[] (~115; replaces grammar.json)
```ts
interface GrammarPointV2 {
  id: string;            // kebab-case, stable; keep the ids of existing points that survive
  order: number;         // teaching order, 1-based
  level: 'N5' | 'N4';
  title: string;         // 'X が あります — "there is X" (things)'
  pattern: RubyText;
  register: 'polite' | 'plain' | 'both';
  recognitionOnly?: boolean;   // passive/causative/keigo set phrases: comprehend cards only, no build cards
  prerequisites: string[];     // ids that must be taught first (direct prerequisites only)
  contrastWith: string[];      // easily-confused points (は/が, に/で …)
  explanation: string;   // 2–5 plain-English sentences, beginner-friendly, no unexplained jargon
  examples: { jp: RubyText; en: string }[];      // ≥ 8, natural, couple/daily-life contexts, vocabulary from core-words where possible
  buildItems: { en: string; jp: RubyText; tiles: string[]; alternatives: string[] }[];   // ≥ 4 (0 when recognitionOnly)
  //   tiles = the jp sentence split into 3–7 chunks in correct order (plain text, no ruby, kanji allowed);
  //   alternatives = other fully-acceptable answers as plain text (no ruby)
  drills: { prompt: RubyText; options: string[]; answer: number; en: string }[];   // ≥ 4 lesson-practice gap-fills (one blank ＿＿), answers vary
}
```
Scope (must include): です/じゃないです, は, が, の, も, を, に (time/place/target), で (place/means), へ, と, から/まで, や, か, ね/よ, こ/そ/あ/ど series, ある/いる, counters + numbers + time + price, い/な adjectives (present/past/negative), adverbs (とても/あまり〜ない/ぜんぜん〜ない), ます forms (present/past/negative/volitional ましょう/ませんか), たい, て-form (request てください, ている, てもいい, てはいけない, てから), ないでください, plain forms (dictionary/ない/た) for casual speech (register 'plain', taught by ~order 45), noun-modifying clauses, あげる/くれる/もらう, たら/ば/と/なら (conditionals), ほうがいい, たり〜たり, ながら, そう (looks like / hearsay), よう (seems), つもり, と思う, と言う, ことができる, たことがある, まえに/あとで, とき, けど/が, から (because), ので, より/ほう, のが好き/上手, もう/まだ, でしょう/だろう, かもしれない, recognition-only: passive, causative, set keigo phrases (いらっしゃいませ, お願いします, …ございます).

## content/stories/<id>.json — StoryEntry (authors write ruby text; the build tokenizes it)
```ts
interface StoryEntry {
  id: string;            // 'st-start-01', 'st-l0-07', 'st-l1-03'
  level: 'start' | 'L0' | 'L1';
  unit: number;          // the UnitSpec id whose vocabulary/grammar it reinforces
  title: string; titleJp: RubyText; topic: string;
  grammar: string[];     // grammar-v2 ids used (all must be at or before the unit's last grammar point)
  sentences: { jp: RubyText; en: string }[];   // one sentence per entry; use '／' inside jp to mark phrase (bunsetsu) breaks for read-while-listening, e.g. 'きのう／{駅|えき}の／{近|ちか}くで／ラーメンを／{食|た}べました。'
  gist: { q: string; options: string[]; answer: number };   // one comprehension question (English), 3 options
}
```
Length: start ≤ 200 distinct words, 100–300 characters; L0 200–400 characters; L1 400–1,200 characters.
Vocabulary: ≥ 98 % of content tokens must be core words with order ≤ the unit's core-word ceiling (see units.json) or kana-only function words; anything else must be glossed via ruby and is counted as unknown. Check with `node scripts/v2/coverage.ts <file>`.

## content/units.json — UnitSpec[] (~25)
```ts
interface UnitSpec {
  id: number;                        // 1..N, teaching order
  title: string; titleJp: RubyText;
  level: 'A1' | 'A2' | 'N3-path';     // units 1–8 ≈ A1/N5, 9–20 ≈ A2/N4, 21+ N3 path
  topic: string;                     // couple-life theme: 'Meeting & greetings', 'Our home', 'Food we like', 'Plans for the weekend', …
  grammar: string[];                 // grammar-v2 ids taught in this unit, in grammar order (units partition grammar-v2 in order)
  coreWordCeiling: number;           // highest core-word order the unit's materials may use
  canDos: CanDo[];                   // 3–6, JF-Standard style, phrased for a couple ('Ask your partner what they want to eat and suggest a place')
  conversation: string;              // id of its core conversation in content/roleplays-v2.json
  task: TaskCard;
  capstone: { title: string; brief: string; minLinesEach: number; structures: string[] };   // ≥ 8 lines per person, ≥ 6 grammar ids
}
interface CanDo {
  id: string;                        // 'u03-cd2'
  text: string;
  check: {                           // 1–2 minute performance check; a can-do is awarded only by passing it
    kind: 'read' | 'listen' | 'speak' | 'write';
    instructions: string;
    material: RubyText;              // a realistic menu/sign/message/short audio script (for listen it is the TTS script)
    questions: { q: string; options: string[]; answer: number }[];   // read/listen: 2–3 questions; speak/write: [] and `rubric` instead
    rubric?: string[];               // speak/write: 2–4 observable criteria ('says the day and time', 'uses ませんか')
  };
}
interface TaskCard {
  id: string; canDo: string;         // CanDo id
  goal: string;                      // what the pair must achieve
  outcomeQuestion: string;           // asked afterwards to check the outcome ('What time are you meeting?')
  roles: { a: string; b: string };
  infoA: string; infoB: string;      // information-gap halves (English, with key Japanese words)
  targets: string[];                 // 'core:cw-0123' | 'grammar:<id>' (5–8)
  register: 'polite' | 'plain' | 'mixed';
  twist: string;                     // variation for the repeat 2–7 days later
  aiRole?: string;                   // a third role the AI can play (clerk, waiter), else omit
  scripted: { role: 'a' | 'b'; jp: RubyText; en: string }[];   // offline fallback script, 8–14 lines
}
```

## content/roleplays-v2.json — RolePlayV2[] (core conversations; also keeps the 14 existing scripts upgraded)
```ts
interface RolePlayV2 {
  id: string; unit?: number;         // core conversations: 'rp-u03'; existing scripts keep their ids
  title: string; titleJp: RubyText; setting: string;
  level: 1 | 2 | 3; register: 'polite' | 'plain' | 'mixed';
  targets: string[];                 // 'core:…' | 'grammar:…'
  roles: { a: { name: string; nameJp: RubyText }; b: { name: string; nameJp: RubyText } };
  lines: { role: 'a' | 'b'; jp: RubyText; en: string; hint?: string; cue: string }[];   // cue = 2–4 English keywords for the cue-card stage ('coffee · two · please')
}
```
Core conversations are 4–8 lines, natural, between the couple (plain/casual register) unless the setting needs polite speech.
