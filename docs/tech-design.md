# Issho v2 — Technical Design

Single source of truth for the six v2 implementers. Product spec: `research-plan.md` (changes 1–19). Content formats: `content-schemas.md`. Where this document and the plan differ, this document wins (each difference is listed in §6.3).

Project root: the repository root.

Baseline: git HEAD `900cbfc` ("Checkpoint v2 content"), 921 app tests and 136 server tests passing. The working tree has further uncommitted content edits (units, role-plays, stories, core words).

## 0. Conventions

- **Scope.** All P0 and P1 changes (1–14). From P2: 15 (pitch lines and the pitch-ear drill on VOICEVOX audio), 16 (fluency micro-drills), 17 (unit spine: can-dos with performance checks, core conversation stages, task cards, capstones; **no** AI oral interview, **no** portfolio blobs), 19 (mnemonic refresh plus the existing "write your own"). From 18: separate FSRS presets per card family with a desired retention per preset. **No** on-device optimizer and no WASM.
- **No new runtime npm dependencies**, in the app or the server. kuromoji stays build-time only (`scripts/`).
- **Progress reset.** Dexie v2 wipes learning progress (items, cards, logs, days, saved sentences). It keeps settings (transformed), pairing, chat and outbox. Server migrations are additive only.
- **Item refs.** An item id is `${kind}:${key}`; a card id is `${itemId}|${cardType}`. Both are unchanged from v1. Words have two possible kinds: `word:<JMdict ent_seq>` and `core:<core id>`. A word that is both a JMdict kanji word and a core word has **one** identity, `core:<id>` (the build resolves this, see §3.6.3).
- **Day keys.** These are `'YYYY-MM-DD'` from `dayKey()`, with rollover at 4 a.m. local time (unchanged). A **course day** is the 1-based count of distinct study days up to and including today (§3.1.1). Phase gates count course days, not calendar days. The kana sprint's **content** is planned from progress (what is not yet introduced), so a missed teach step never loses a row (§3.1.1).
- **Pure core, thin DB shell.** Every algorithm with numbers in it is a pure function with an exported input type, so it can be tested and simulated without IndexedDB. A DB-backed wrapper assembles the input.
- **Time.** Every DB-backed function takes `now: Date = new Date()` as its last parameter. Nothing reads the clock elsewhere.
- **Idempotent side effects.** Every DB write that a screen triggers must be safe to run twice (React StrictMode effects, double taps, two sittings racing, a WebSocket event plus a refresh). Rules: write absolute targets, never increments of increments (a bury sets `due = max(due, nextStudyDayStart(now))`); count only what was created (`IntroduceResult.created`); record steps and credits as set-adds; check-then-write inside one `rw` transaction. Screens keep v1 Session's `started` ref guard for start-up side effects.
- **Copy rules.** Never show "you missed N days". Show no card counts during catch-up. Show no romaji outside the kana chart once the kana sprint is over (course day 14 unless rows were missed; `CourseSnapshot.inSprint`). No emoji.
- **Browser QA.** Use only the internal browser tools (`mcp__Claude_Browser__*`), and only at exactly `http://localhost:<port>`. Never use Chrome, `127.0.0.1` or LAN IPs in the browser. Ports are allocated per implementer (§4.3). Browser QA runs on the integration commit, not on half-merged branches (§6.1).

---

## 1. The v2 daily experience, mapped to plan changes

### 1.1 One day at the default 25 min/day

| Moment | What happens | Plan change | Owner(s) |
|---|---|---|---|
| Open the app | **Today** shows "About 25 min today · tomorrow about 24" (after an earlier sitting: "About 12 min left today") plus the session panel. It shows the streak card only while the streak is alive. It leads with "days studied this month" and the longest streak. On a scheduled day it shows the together session card. After a missed day it asks "Use a rest token for yesterday?" when tokens are left; with none left, it offers a 10-minute make-up once today's goal is met. After ≥1 missed day it offers a 3-minute welcome-back (on request; the normal plan stays available). After ≥3 missed days it also offers a fresh start (next Monday or the 1st of the month). | 1, 8, 11, 13 | D (UI), B (habits, planner) |
| Start a sitting | `planToday()` runs again for each sitting and plans only what is left today. **Anywhere** sitting: the whole warm-up (handwriting on the phone's recall pad included; only "write on paper" is hidden). **Desk** sitting: everything else, plus any warm-up cards still due. **Any** (default single sitting): everything. | 1, 4 | B, C |
| Warm-up | Every due card not yet reviewed today, never New cards and never cards of items introduced today. Order: yesterday's introduced cards that are still in Learning, then Review cards by ascending retrievability. At most one card per sibling group per day; the rest are buried until the next study day. A miss shows teaching feedback, and the card comes back ≥5 cards later for a **graded** re-ask. Answers are typed kana (romaji IME), handwriting, speech, or reveal plus self-grade. Multiple choice is only a capped hint. | 2, 3, 4, 9 | B (order, grading), C (cards) |
| Teach | Up to 4 items per batch. The governor prices them within the time budget left today. Kanji: an optional 5-s pre-guess, a lesson with parts panel, keyword, one-line hook and anchor word with audio and pitch line, a trace (only if a part is new), then a guided copy. Core words: audio first, then text. Grammar (every 2nd study day, at least 2 a week): try-to-say, rule, 3 examples, 2 taps, 1 build. Staged words arrive 3 and 8 calendar days after their kanji. During the kana sprint (normally days 1–14) the sprint content is taught instead, from progress: a missed row is taught the next day. | 1, 2, 5, 6, 7, 14, 15, 19 | B (plan), C (lessons) |
| Memory pass | After each batch: write each kanji (and each sprint kana) from its prompt, and say or type each core word from English, in mixed order. Ungraded. | 4 | C |
| Read & listen | Sprint days: read real words made of taught kana aloud, then hear them; on the day the sprint ends, the "Kana check" (10 katakana menu words read aloud at speed). From about day 5: 1–3 i+1 study sentences (read aloud → listen with a phrase pitch line → guess-first gloss → shadow). From about 200 known words: an Easy story (≥98 % coverage) read while listening, with phrase highlighting and per-partner furigana, one gist question, and a ladder (day 0 read-while-listening, about +3 listen only, about +10 timed re-read). | 5, 10, 15 | B (selection, coverage), C (UI), F (audio) |
| First check | Every New card (today's, plus any never checked), production first, about 10 minutes after teaching. This is the first FSRS grade. A fail is re-asked ≥5 cards later and graded. | 4 | B, C |
| Output | One sentence to the partner using a recent word or grammar point. AI prompt mode marks ≤2 issue spans with a type label and no fix. The learner edits once, then reveal mode shows a diff plus a one-line rule. The sentence goes to chat as "today's sentence"; the partner's checked reply to it counts as the partner's output for the day. A verified correction becomes a cloze card, but only after the card guard passes. | 12 | C (UI), B (target, guard), E (server AI, Composer), F (client) |
| Fluency / pitch slot | 2 min, from the time the strand reserve reaches 6 min (about course day 61) and never in catch-up, travel or micro plans. Mon/Wed/Fri: pitch-ear drill (verified VOICEVOX audio of the word plus が). Tue/Thu/Sat: rotation of timed re-read → 60-s speed round → numbers/time/price drill. None of it is graded into FSRS. | 15, 16 | B (selection), C (UI) |
| Summary | One "you can now…" line, today's minutes and tomorrow's estimate. Once a week: real retention at about 1 week and about 1 month by card family. The day counts as a minimum day as soon as the minimum rule is met, and "goal met" when a full plan's steps are all done. | 4, 8, 13 | C, B |
| Together (3 × 15 min a week, plus a monthly session) | Session A: partner quiz (feeds the answerer's FSRS within ±2 days of due) plus a core-conversation stage S1–S4. Session B: task card (targets from both partners' items of the last 2–21 days) with info-gap, silent planning, the AI as third role, and a private recap. Session C: shared story talk, 4/3/2 retell, dictation (or the season showcase) and weekly check-in. Monthly session (first weekend): a 20-item quiz each way, goal setting with a fresh-start framing, and the capstone when one is due. The couple quest is ≥5 minimum days each plus sessions A, B and C (the monthly session can stand in for one missing letter), with 1 reserve a month. | 8, 11, 17 | E (UI and server), B (pools, plan), F (sync) |

### 1.2 Day-0 retrieval budget for a new card

The cap is counted **per card** (one card is one memory trace), not per item. Each new card gets at most 4 retrievals on its first day, and by construction no card can get more than 3:

1. Memory pass (ungraded). It counts for the item's **production** card: kanji write, kana write, core produce (or core listen for a word without a produce card: the memory pass then plays the audio and asks for the meaning).
2. An appearance in reading, when a sentence, story or sprint word uses it. It counts for the item's **receptive** card: word/core read, core listen, kana read.
3. First check (graded), once per card.
4. One graded re-ask, only for a card the first check missed.

There are no other same-day retrievals. Warm-up never contains New cards or cards of items introduced today; they wait for the first check and then for tomorrow's relearn after sleep. Every New card (reps 0) goes to the first check, including a spelling-upgrade read card created today for a word introduced earlier.

Day 1 therefore has a first check of 20 cards: 10 hear→write and 10 see→type-romaji (2 per kana, about 3 min, already inside the 53-s kana price). The plan's "10 graded cards" counted kana, not cards (§6.3).

### 1.3 Phase timeline (course days, both kana scripts unknown)

| Course day | Stream gates |
|---|---|
| 1–5 | Hiragana rows: D1 あ+か, D2 さ+た, D3 な+は, D4 ま+や, D5 ら+わ+を+ん (46 kana) |
| 3 → | Core words, 3 a day during the sprint, audio first, shown in kana |
| 6, 7 | Hiragana rule lessons: `hira-dakuten`, `hira-yoon` |
| 8 → | Grammar: at most 1 every 2nd study day, never on consecutive study days, floor 2 per ISO week |
| 8–12 | Katakana rows, same pattern as hiragana |
| 13, 14 | `kata-dakuten-yoon`, then `kata-extended` plus the "Kana check" can-do |
| 15 → | Kanji (anchor word with each), staged words, the time governor and the output step. Both conditions must hold: course day ≥ 15 **and** every sprint row and rule introduced |
| about 35–45 → | Easy stories, once about 200 words are known and a story reaches ≥98 % coverage (the read block has 3 min from day 15) |
| about 61 → | Fluency/pitch slot (strand reserve ≥ 6 min) |

The placement check moves these gates; the rules are in §3.1.1. A missed sprint teach step shifts the remaining sprint content by a day; it is never skipped.

---

## 2. Data model

### 2.1 Static files produced by the build (owner A)

`npm run build:data` (`scripts/build-data.ts`) writes `public/data/**`. `node scripts/audio/generate.ts` (`npm run build:audio`) writes `public/audio/**` and `public/data/accent.json`. Every file is committed, and the Docker image ships the committed files (unchanged policy). Every type named here is defined in `src/lib/types.ts` (§2.4.1).

| Published file | Type | Source | Notes |
|---|---|---|---|
| `data/kana.json` | `KanaEntry[]` | `scripts/lib/kana.ts` | All 208 kana. Only the 92 `basic` ones have `sprintDay` (hiragana 1–5, katakana 8–12) |
| `data/kanji.json` | `Record<char, KanjiEntry>` | KANJIDIC2 + KanjiVG | Adds `parts` (named parts) and `rank` (curriculum position, 1-based) |
| `data/radicals.json` | `RadicalEntry[]` | `content/radicals.json` + build | Now means **named parts**: no unit, no cards. Includes every rare component (jōyō rank > 1,000 or no useful words: 乙 弔 丙 吏 斤 丈 巾 旦 …) |
| `data/words.json` | `WordEntry[]` | JMdict | Adds `pri`, `core`, `use`, `altKana`. Keeps every word the curriculum, content or chat furigana needs (about the current 23.5k) |
| `data/curriculum.json` | `Curriculum` (version 2) | `scripts/lib/curriculum.ts` | Kanji units only. Each unit has an `anchor` and up to 2 `staged` words (`WordRef`), plus `inferable` and `chapter`. Carries the `confusables` sets. `phaseEnds` is removed |
| `data/strokes.json` | `StrokesFile` | KanjiVG | Unchanged |
| `data/accent.json` | `AccentFile` | VOICEVOX at audio-generation time | Keyed by `core:<id>`, `word:<id>`. Only verified, single-accent-phrase words, and only when the word's clip was read from its kanji spelling (`via 'text'`) or the word is kana-only. Never from a `via 'kana'` fallback, because a kana-only query takes an arbitrary homophone's accent (あめ → 飴, not 雨) |
| `data/content/core-words.json` | `CoreWord[]` | `content/core-words.json` | Adds `kanji[]`, `unit` and `altKana`. Replaces survival-words.json, which is deleted. Ids are frozen at release (`scripts/data/core-ids.lock.json`, §3.6.3) |
| `data/content/kana-rules.json` | `KanaRule[]` | `content/kana-rules.json` | Adds `script`, and `checkWords` (10 katakana menu words, build-derived) on the rule taught last in the sprint |
| `data/content/kana-examples.json` | `KanaExamplesFile` | `content/kana-examples.json` | Adds `hook`: a one-line picture mnemonic for each of the 92 basic kana (A authors them, §3.6.1 step 2) |
| `data/content/grammar.json` | `GrammarPoint[]` | `content/grammar-v2.json` | Adds `unit`; each `buildItems[i].answers` is the accepted typed kana (§3.6.4) |
| `data/content/sentences.json` | `SentenceEntry[]` | `content/sentences/*.json` | Pre-tokenised: `tokens` and `refs`. Adds `unit` (its audio pack). Grammar tags must be grammar-v2 ids |
| `data/content/stories.json` | `StoryEntry[]` | `content/stories/*.json` | Pre-tokenised with phrase indexes and `chars`. Written as `[]` while no stories exist |
| `data/content/roleplays.json` | `RolePlay[]` | `content/roleplays-v2/*.json` (today: `legacy.json`, an array of the 14 upgraded v1 scripts, plus `rp-u01.json`–`rp-u25.json`, one object each). Only when that folder is missing: `content/roleplays-v2.json`; only when neither exists: v1 `content/roleplays.json` upgraded | Each file holds one `RolePlay` or an array. The folder is the source: when it exists, `content/roleplays-v2.json` (an older combined export, 31 of 39 scripts now differ) is ignored with a warning. Duplicate ids inside the chosen source fail the build. v1 upgrade (fallback only): `cue: ''`, `targets: []`, `register: 'mixed'` |
| `data/content/units.json` | `UnitSpec[]` | `content/units/u*.json`; only when that folder is missing, `content/units.json` | The folder wins; a stale `units.json` is ignored with a warning when it differs. Each can-do and task carries `ready`: false when the authored material is still empty |
| `data/content/mnemonics.json` | `MnemonicsFile` | `content/mnemonics.json` | Accepts the old `string` values and the new `{ meaning, sound? }` values. Published as `MnemonicEntry` |
| `audio/manifest.json` | `AudioManifest` | `scripts/audio/generate.ts` | Precached, because it matches `**/*.json` (about 2–3 MB raw; served precompressed) |
| `audio/<aa>/<hash16>.m4a` | AAC-LC, mono, 32 kbps, 24 kHz | VOICEVOX + `ffmpeg` (preferred: about half the container overhead of `afconvert`), else `afconvert` | **Not** precached. Cached at runtime in packs (§3.5.2) |

Missing optional content (stories, units, roleplays-v2, accent, audio) never fails the build. The build writes the empty or legacy form and prints a warning. The app hides the feature until the content exists:

- No stories → the read block uses sentences only.
- A can-do with `ready: false` → shown as "check coming soon" and cannot be awarded.

### 2.2 Audio model

- **Voices.** `VoiceId = 'f' | 'm'`.
  - `f` = VOICEVOX speaker 30, No.7 アナウンス. This is the main voice.
  - `m` = speaker 13, 青山龍星 ノーマル. Used for role `b` in role-plays and task scripts, and for quoted second speakers.
  - Credits shown in Settings → About (D), and carried in `manifest.credits`: `VOICEVOX:No.7`, `VOICEVOX:青山龍星`.
- **Clip ref strings** (`AudioManifest.byRef` keys), built by A:

| Ref | Meaning |
|---|---|
| `kana:<char>` | sound of a kana: **all 208** (basic, voiced, yōon), so rule lessons, pair grids and the kana chart have clips |
| `kanaEx:<char>` | the kana's example word from `kana-examples.json` (142), used by `KanaLesson`, `KanaWordsRead` and post-sprint kana cards |
| `kanaRule:<id>#<n>` | practice word n |
| `core:<id>` | core word |
| `word:<id>` | JMdict word |
| `pitch:<ref>` | the word followed by が (`pitch:core:cw-0042`), for noun-like words with a verified accent. It is the only way to hear heiban against odaka (橋が vs 端が); the pitch-ear drill plays these |
| `grammar:<id>#ex<n>` | example n |
| `grammar:<id>#build<n>` | build item n |
| `sentence:<id>` | study sentence |
| `story:<id>#<n>` | story sentence n, with phrase offsets |
| `rp:<id>#<n>` | role-play line n (role a → `f`, role b → `m`) |
| `task:<taskId>#<n>` | scripted task line n |
| `cando:<id>` | listen-check material |

- **Text lookup.** `byText` maps `clipTextKey(voice, text)` (in `shared/voicevox.ts`) to a clip id. The key is `` `${voice}|${plain}|${reading}` ``: `plain` = `rubyPlain(text)` with `／` removed, NFKC-normalised, whitespace collapsed and trimmed; `reading` = the hiragana of `rubyKana(text)` normalised the same way, or `''` when the text still has a kanji without ruby. So `{食|た}べる` and `{食べる|たべる}` share a key, and 箸 and 橋 (with ruby) differ. Word, core and kana-example jobs use `{written|kana}` as their text (plain kana when there is no written form). The manifest indexes every clip under its full key and, only when exactly one clip of that voice has the same `plain`, also under `` `${voice}|${plain}|` `` so plain-kanji callers still hit; homographs never collide.
- **Packs** (runtime prefetch units):

| Pack | Contents |
|---|---|
| `kana` | all kana sounds, kana example words, rule practice words |
| `u01`…`u25` | grammar examples and build items of the unit; stories, role-plays, task and can-do material tagged with that unit; study sentences by `SentenceEntry.unit` (the highest unit of its grammar tags and of its core refs); core words with `unit === n` and their `pitch:` clips |
| `c01`… | JMdict words of the kanji in kanji chapter n (15 kanji per chapter) and their `pitch:` clips |
| `misc` | anything without a unit or chapter (expected to be nearly empty); `packsFor` always includes it |

- **Generation scope (decision).** The default scope generates clips for everything above, except that **JMdict kanji words are limited to the anchor and staged words of the first 600 curriculum kanji**, about 1,600 words. Measured on the local engine (VOICEVOX 0.25.2, speaker 30) with `ffmpeg` AAC-LC 32 kbps mono: a one-word clip is about 3.5 KB and a 3.7-s sentence about 16.5 KB (`afconvert` gives 7.2 KB and 20.7 KB, because of its container overhead). Today's content needs about 4,100 sentence-type clips (about 11,300 s of audio), about 3,400 word and kana clips, about 260 more kana and kana-example clips and about 1,900 `pitch:` clips: **about 9,700 clips and about 70–78 MB** with `ffmpeg` (about 100 MB with `afconvert`). Words outside the scope play through server TTS, then the device voice. `--scope` and `--kanji-limit` can widen this later.

### 2.3 IndexedDB v2 (summary; full listing in §2.4.2)

| Table | Key, indexes | Record | Kept on upgrade? |
|---|---|---|---|
| items | `id`, kind, introducedAt | `ItemRecord` | wiped |
| cards | `id`, itemId, kind, type, due, state | `CardRecord` | wiped |
| reviewLogs | `++id`, cardId, itemId, reviewedAt, `[type+reviewedAt]` | `ReviewLogRecord` | wiped |
| days | `date` | `DayRecord` | wiped |
| settings | `id` | `Settings` | **kept**, transformed by `migrateSettings` |
| outbox | `clientId`, createdAt | `OutboxRecord` | **kept** |
| messages | `id`, clientId, createdAt | `ChatMessageRecord` | **kept** |
| savedSentences | `id`, savedAt | `SavedSentenceRecord` | wiped |
| encounters (new) | `++id`, itemId, day, `[itemId+day]` | `EncounterRecord` | — |
| shownSentences (new) | `id`, day | `SentenceShownRecord` (replaces localStorage `issho.srs.sentencesShown`) | — |
| staged (new) | `itemId`, releaseDay | `StagedWordRecord` | — |
| stories (new) | `storyId`, nextDay | `StoryProgressRecord` | — |
| restTokens (new) | `date`, week | `RestTokenRecord` | — |
| outputs (new) | `id`, day, check | `OutputSentenceRecord` | — |
| canDos (new) | `id`, unit | `CanDoRecord` | — |
| milestones (new) | `id` | `MilestoneRecord` | — |
| togetherPlans (new) | `week` | `TogetherPlanRecord` | — |
| togetherOutbox (new) | `clientId`, createdAt | `TogetherOutboxRecord` | — |
| partnerQuizzes (new) | `quizId` | `PartnerQuizRecord` | — |
| pitchBoxes (new) | `ref`, nextDay | `PitchBoxRecord` | — |
| fluency (new) | `++id`, kind, day | `FluencyLogRecord` | — |

Migration rules:

- `newPerDay` maps to `dailyMinutes`: ≤3 → 20, 4–6 → 25, ≥7 → 30. So 3 → 20, 5 → 25 and 8 → 30, as in the plan.
- `romaji`, `newPerDay`, `maxReviewsPerDay` and `desiredRetention` are dropped.
- `knowsHiragana` and `knowsKatakana` reset to false; the placement check decides again.
- `onboarded` becomes `false`, so both partners go through the v2 onboarding (habits, slots, minutes, placement). Name and pairing are pre-filled from the kept fields.
- The localStorage key `issho.srs.sentencesShown` is removed.

Backups: `src/lib/backup.ts` goes to `VERSION = 2`. A v1 backup restores only settings (through `migrateSettings`) and chat, and the import summary says why.

### 2.4 Shared contract files (written first, verbatim, by the contracts step)

These four files are the whole compile-time contract. After the contracts step they are **frozen**. A change needs the lead's sign-off and is append-only. B is the steward for `src/lib/*`; E is the steward for `shared/api.ts`.

#### 2.4.1 `src/lib/types.ts` (complete v2 content)

```ts
// Shared data contracts for Issho v2.
// Static data lives in public/data (scripts/build-data.ts) and public/audio (scripts/audio/generate.ts).
// Per-device progress lives in IndexedDB (src/lib/db.ts). The HTTP/WebSocket contract is shared/api.ts.

import type { Card as FsrsCard, Grade } from 'ts-fsrs';
import type {
  AiIssue,
  QuizVerdict,
  SharedGoal,
  TogetherSessionId,
  TogetherSlot,
  VoiceId,
} from '../../shared/api.ts';

export type { AiIssue, QuizVerdict, SharedGoal, TogetherSessionId, TogetherSlot, VoiceId };

// ===========================================================================
// Static data: public/data/**.json and public/audio/manifest.json
// ===========================================================================

/** SVG path data for each stroke, in stroke order, in KanjiVG's 109×109 box. */
export type StrokePaths = string[];

/** public/data/strokes.json */
export type StrokesFile = Record<string, StrokePaths>;

export type KanaScript = 'hiragana' | 'katakana';
export type KanaKind = 'basic' | 'dakuten' | 'handakuten' | 'yoon';

/**
 * public/data/kana.json: all 208 kana in chart order. Only the 92 basic kana are taught as items
 * (they have `sprintDay`); voiced kana and yōon are taught by the kana-rule lessons. The chart,
 * the romaji helper and the IME use every entry.
 */
export interface KanaEntry {
  char: string;            // 'あ', 'きゃ'
  script: KanaScript;
  romaji: string;          // Hepburn: 'a', 'shi', 'kya'
  /** Row id used to group lessons: 'a', 'ka', … ('wa' holds わ and を; 'n' holds ん). Repeats across scripts. */
  group: string;
  kind: KanaKind;
  /** Chart order within the whole kana table (0-based). */
  order: number;
  /** Romaji alternatives accepted when typing ('si' for し, 'tu' for つ). */
  altRomaji?: string[];
  /** Basic kana only: the sprint day that teaches it (hiragana 1–5, katakana 8–12). */
  sprintDay?: number;
}

export type KanaRuleId = 'hira-dakuten' | 'hira-yoon' | 'kata-dakuten-yoon' | 'kata-extended';

/** public/data/content/kana-rules.json: the four rule lessons of the kana sprint, in day order. */
export interface KanaRule {
  id: KanaRuleId;
  day: 6 | 7 | 13 | 14;
  script: KanaScript;
  title: string;           // 'Voiced sounds: ゛ and ゜'
  explanation: string;     // 2–4 plain sentences
  /** Every character of the rule: か→が 'ga'. */
  pairs: { from: string; to: string; romaji: string }[];
  /** 8 real words using only kana taught by `day`; the rule's read card cycles through them. */
  practiceWords: { kana: string; en: string }[];
  /**
   * Build-time, only on 'kata-extended' (the last sprint lesson): the day-14 "Kana check" can-do,
   * 10 katakana core words of topic food/drink (topped up from other katakana core words), menu order.
   */
  checkWords?: { kana: string; en: string; ref: `core:${string}` }[];
}

/** public/data/kanji.json is Record<char, KanjiEntry> for every curriculum kanji and every component. */
export interface KanjiEntry {
  char: string;
  meanings: string[];      // English, most important first (max 4); meanings[0] is the keyword
  on: string[];            // katakana
  kun: string[];           // hiragana, '.' marks okurigana
  strokeCount: number;
  grade?: number;
  /** Old JLPT level from KANJIDIC2 (4 = easiest). Shown as a label only. */
  jlptOld?: number;
  /** Newspaper frequency rank 1..2500. */
  freq?: number;
  /** Component kanji taught as kanji units before this one. */
  components: string[];
  /** Named parts (radicals.json) that are not kanji units: shown in the parts panel only. */
  parts: string[];
  /** Curriculum position, 1-based; the write-list rank. Absent for components outside the curriculum. */
  rank?: number;
}

/**
 * public/data/radicals.json: named parts. They have no unit and no cards; their name and meaning
 * show in the kanji lesson's parts panel and in the feedback after a miss.
 */
export interface RadicalEntry {
  char: string;            // '氵'
  name: string;            // 'water (side)'
  meaning: string;
  /** Full kanji this is a variant of, if any ('水' for '氵'). */
  variantOf?: string;
}

/** public/data/words.json is WordEntry[] (JMdict words using curriculum kanji). */
export interface WordEntry {
  id: string;              // JMdict ent_seq
  written: string;
  kana: string;
  meanings: string[];      // first sense glosses, max 3
  pos: string[];
  /** 1 (most common) .. 48 from JMdict nfXX, 49 = common without nf, 99 = other. */
  freqRank: number;
  kanji: string[];         // distinct kanji chars in `written`
  /** JMdict priority tags of this spelling: 'ichi1', 'spec2', 'news1', 'nf12' … */
  pri?: string[];
  /** Core word id when this entry is also a core word: the learner's item is then `core:<id>`. */
  core?: string;
  /** The learner should produce it (it appears in a role-play or task line): adds a produce card. */
  use?: boolean;
  /** Other kana accepted when typing the reading (long-vowel variants, JMdict alternates). */
  altKana?: string[];
}

/** A word taught as an item: a JMdict word or a core word. */
export type WordRef = `word:${string}` | `core:${string}`;
/** A unit/role-play target. */
export type TargetRef = `core:${string}` | `grammar:${string}`;
export type Register = 'polite' | 'plain' | 'both';

export type CorePos =
  | 'noun' | 'verb-ru' | 'verb-u' | 'verb-irr' | 'adj-i' | 'adj-na' | 'adverb' | 'particle-phrase'
  | 'expression' | 'pronoun' | 'demonstrative' | 'counter' | 'number' | 'conjunction'
  | 'interjection' | 'suffix' | 'prefix';

/** public/data/content/core-words.json: CoreWord[] in `order` (1,577 today; the count may still change). */
export interface CoreWord {
  /** 'cw-0001'. May be renumbered by content authors until release; frozen after it (ids are durable keys on
   *  the device: items, cards, pitch boxes, staged rows, partner-quiz keys). Later reorders change `order` only. */
  id: string;
  order: number;           // teaching order, 1-based, no gaps
  kana: string;            // reading: hiragana, or katakana for loanwords
  /** Usual written form when normally written with kanji ('食べる'). */
  written?: string;
  jmdict?: string;
  en: string;
  pos: CorePos;
  register: Register;
  topic: string;
  /** Learner should say/write it: adds a produce card. */
  use: boolean;
  note?: string;
  /** Old survival-words.json id it replaces. */
  survival?: string;
  /** Build-time: kanji in `written`, in order ([] for kana-only words). */
  kanji: string[];
  /** Build-time: the first unit whose coreWordCeiling covers `order`. */
  unit: number;
  /** Build-time: other accepted kana for typed answers (おう/おお variants). */
  altKana?: string[];
}

/** One kanji unit of public/data/curriculum.json. Named parts are never units. */
export interface CurriculumUnit {
  /** 0-based teaching order. `index + 1` is KanjiEntry.rank. */
  index: number;
  char: string;
  /** Taught with the kanji; its write prompt shows this word with the kanji blanked. Null for zero-word kanji. */
  anchor: WordRef | null;
  /** Released 3 and 8 calendar days after the kanji (max 2; released on the first study day on or after that
   *  date). A core ref already introduced becomes a spelling upgrade. */
  staged: WordRef[];
  /** Every component is known and the meaning is semantic (休, 明, 林): offer the 5-s pre-guess. */
  inferable: boolean;
  /** Chapter number, 1-based, 15 kanji each (chapter 0 is kana). */
  chapter: number;
}

export interface ConfusableSet {
  id: string;              // 'v-未末', 'm-numbers'
  chars: string[];
  /** visual: members ≥ 5 study days apart; meaning (numbers, weekdays): at most 3 members per day. */
  kind: 'visual' | 'meaning';
}

/** public/data/curriculum.json */
export interface Curriculum {
  version: 2;
  units: CurriculumUnit[];
  confusables: ConfusableSet[];
}

/**
 * Ruby markup used in all authored Japanese text: "{明日|あした}は{水曜日|すいようび}です。"
 * Parse with src/lib/ruby.ts.
 */
export type RubyText = string;

/** public/data/content/mnemonics.json values. Never shown as the cue during a test. */
export interface MnemonicEntry {
  /** One sentence, ≤ 20 words, built only from part names met earlier. */
  meaning: string;
  /** Sound hook for the anchor word's reading. */
  sound?: string;
}
export type MnemonicsFile = Record<string, MnemonicEntry>;

export interface GrammarExample { jp: RubyText; en: string }

/** Lesson practice only (no longer a review card). */
export interface GrammarDrill {
  prompt: RubyText;        // one blank written as ＿＿
  options: string[];
  answer: number;
  en: string;
}

export interface GrammarBuildItem {
  en: string;
  jp: RubyText;
  /** jp split into 3–7 chunks in order (plain text, kanji allowed). */
  tiles: string[];
  /** Other fully acceptable answers, plain text. */
  alternatives: string[];
  /** Build-time: accepted typed answers as hiragana (jp and alternatives, with は/わ, へ/え, を/お variants). */
  answers: string[];
}

/** public/data/content/grammar.json is GrammarPoint[] sorted by `order` (about 115). */
export interface GrammarPoint {
  id: string;              // kebab-case: 'wa-desu'
  order: number;
  level: 'N5' | 'N4';
  title: string;
  pattern: RubyText;
  register: Register;
  /** Passive/causative/keigo set phrases: comprehend card only. */
  recognitionOnly?: boolean;
  /** Direct prerequisites (ids). The only gate on teaching it. */
  prerequisites: string[];
  /** Easily confused points: taught ≥ 5 study days apart. */
  contrastWith: string[];
  explanation: string;
  examples: GrammarExample[];      // ≥ 8
  buildItems: GrammarBuildItem[];  // ≥ 4 (0 when recognitionOnly)
  drills: GrammarDrill[];          // ≥ 4, lesson practice
  /** Build-time: UnitSpec.id that teaches it. */
  unit: number;
}

/** A pre-tokenised word of a sentence or story (scripts/v2/tokenize.ts at build time). */
export interface PreToken {
  /** Surface as written, no ruby. */
  s: string;
  /** Hiragana reading, present when the surface has kanji. */
  r?: string;
  /** The item it belongs to (content words found in the core list or JMdict). */
  ref?: WordRef;
  /** 'c' content word, 'f' function (particle, auxiliary, prefix…), 'p' punctuation or space. */
  k: 'c' | 'f' | 'p';
  /** A person or place name: never counted for coverage, always shown with its reading. */
  name?: true;
  /** 0-based phrase index ('／' breaks). Stories only. */
  ph?: number;
}

/** public/data/content/sentences.json: fixed i+1 study sentences. */
export interface SentenceEntry {
  id: string;              // 's-s1-001'
  jp: RubyText;
  en: string;
  /** grammar-v2 ids the sentence uses (all must be introduced before it is picked). */
  grammar: string[];
  tokens: PreToken[];
  /** Distinct content refs in the sentence. */
  refs: WordRef[];
  /** Build-time: the highest unit of its grammar tags and of its core refs (CoreWord.unit); 1 when none. Its audio pack. */
  unit: number;
}

export type StoryLevel = 'start' | 'L0' | 'L1';

export interface StorySentence {
  jp: RubyText;            // without '／'
  en: string;
  tokens: PreToken[];      // with `ph`
  /** The sentence's phrases (ruby), split at the author's '／' marks. */
  phrases: RubyText[];
}

/** public/data/content/stories.json: StoryEntry[] sorted by level then id. */
export interface StoryEntry {
  id: string;              // 'st-l0-07'
  level: StoryLevel;
  unit: number;
  title: string;
  titleJp: RubyText;
  topic: string;
  grammar: string[];
  sentences: StorySentence[];
  gist: { q: string; options: string[]; answer: number };
  /** Characters with ruby, phrase marks and spaces removed (for characters per minute). */
  chars: number;
  /** Distinct content refs. */
  refs: WordRef[];
}

export interface RolePlayLine {
  role: 'a' | 'b';
  jp: RubyText;
  en: string;
  hint?: string;
  /** 2–4 English keywords for the cue-card stage (S4); '' in upgraded v1 scripts. */
  cue: string;
}

/**
 * public/data/content/roleplays.json: core conversations and free role-plays. A **core conversation** is a
 * script that some UnitSpec.conversation names (rp-u01…rp-u25 today); every other script is a free role-play.
 */
export interface RolePlay {
  id: string;
  /** The unit it fits (level gate): offered once the couple reached this unit. Not what makes it a core conversation. */
  unit?: number;
  title: string;
  titleJp: RubyText;
  setting: string;
  level: 1 | 2 | 3;
  register: 'polite' | 'plain' | 'mixed';
  targets: TargetRef[];
  roles: { a: { name: string; nameJp: RubyText }; b: { name: string; nameJp: RubyText } };
  lines: RolePlayLine[];
}

export type CanDoCheckKind = 'read' | 'listen' | 'speak' | 'write';

export interface CanDoQuestion { q: string; options: string[]; answer: number }

export interface CanDo {
  id: string;              // 'u03-cd2'
  text: string;
  check: {
    kind: CanDoCheckKind;
    instructions: string;
    /** Menu/sign/message, or the TTS script for listen. */
    material: RubyText;
    /** read/listen: 2–3 questions. */
    questions: CanDoQuestion[];
    /** speak/write: 2–4 observable criteria. */
    rubric?: string[];
  };
  /** Build-time: the check has its material and questions (or rubric). False while content is in progress. */
  ready: boolean;
}

export interface TaskCard {
  id: string;
  canDo: string;
  goal: string;
  outcomeQuestion: string;
  roles: { a: string; b: string };
  infoA: string;
  infoB: string;
  targets: TargetRef[];
  register: 'polite' | 'plain' | 'mixed';
  twist: string;
  aiRole?: string;
  /** Offline fallback script, 8–14 lines. */
  scripted: { role: 'a' | 'b'; jp: RubyText; en: string }[];
  /** Build-time: goal, info halves and script present. */
  ready: boolean;
}

/** public/data/content/units.json: UnitSpec[] by id (25). */
export interface UnitSpec {
  id: number;
  title: string;
  titleJp: RubyText;
  level: 'A1' | 'A2' | 'N3-path';
  topic: string;
  /** grammar-v2 ids taught in this unit, in order (units partition grammar). */
  grammar: string[];
  coreWordCeiling: number;
  canDos: CanDo[];
  /** RolePlay id of its core conversation. */
  conversation: string;
  task: TaskCard;
  capstone: { title: string; brief: string; minLinesEach: number; structures: string[] };
}

export type AccentType = 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka';

export interface AccentInfo {
  /** Moras of the expected reading in katakana, long vowels kept as ー: ['コ','ー','ヒ','ー']. */
  moras: string[];
  /** Accent nucleus: 0 = heiban (no drop), n = the pitch drops after mora n (1-based). */
  drop: number;
  type: AccentType;
  /** Measured with が after the word (noun-like words); the 'pitch:<ref>' clip carries exactly this query. */
  withGa?: true;
}

/** public/data/accent.json: keys 'core:<id>', 'word:<id>'. Only words read from their kanji spelling or kana-only. */
export type AccentFile = Record<string, AccentInfo>;

/** One accent phrase of a sentence clip, as VOICEVOX read it: moras (katakana, joined) and the accent nucleus
 *  (1-based; equal to the mora count when the phrase has no drop inside it). Pause moras are left out. */
export type ClipAccentPhrase = [moras: string, accent: number];

export interface AudioClip {
  /** Path under public/audio: 'a3/a3f09c1e5b2d7781.m4a'. */
  file: string;
  /** Duration, ms. */
  ms: number;
  voice: VoiceId;
  /** Prefetch pack: 'kana', 'u01'…'u25', 'c01'… (kanji chapters), 'misc'. */
  pack: string;
  /** Story sentences: start offset (ms) of each '／' phrase. */
  phrases?: number[];
  /** 'text': VOICEVOX read the written text correctly; 'kana': it was given the reading. */
  via: 'text' | 'kana';
  /** Sentence-type clips (grammar examples and builds, sentences, story sentences, role-play and task lines) read
   *  via 'text' only: the accent phrases of the same audio_query, for the phrase pitch line. */
  accentPhrases?: ClipAccentPhrase[];
}

/** public/audio/manifest.json */
export interface AudioManifest {
  version: 1;
  generatedAt: string;
  /** Engine of the latest run, display only ('VOICEVOX 0.25.2'); not part of clip hashes. */
  engine: string;
  /** Shown in Settings → About: ['VOICEVOX:No.7', 'VOICEVOX:青山龍星']. */
  credits: string[];
  /** Clip id (content hash) → clip. */
  clips: Record<string, AudioClip>;
  /** Clip ref ('core:cw-0001', 'pitch:core:cw-0042', 'story:st-l0-07#3', …, see §2.2) → clip id. */
  byRef: Record<string, string>;
  /** clipTextKey(voice, text) (shared/voicevox.ts) → clip id; plain-only keys only when unambiguous (§2.2). */
  byText: Record<string, string>;
}

// ===========================================================================
// Progress: IndexedDB
// ===========================================================================

/**
 * What can be learned. Item ids:
 *   kana:あ  kanaRule:hira-dakuten  kanji:水  word:<JMdict id>  core:<core id>
 *   grammar:<id>  sentence:<saved sentence id>
 */
export type ItemKind = 'kana' | 'kanaRule' | 'kanji' | 'word' | 'core' | 'grammar' | 'sentence';
export type ItemRef = `${ItemKind}:${string}`;

export interface ItemRecord {
  id: string;              // `${kind}:${key}`
  kind: ItemKind;
  key: string;
  introducedAt: Date;
  /** How it arrived: a lesson, a staged release, the placement check, or a saved/corrected sentence. */
  via?: 'lesson' | 'staged' | 'placement' | 'saved';
  /** core items: when the kanji spelling was taught (its read card was created). */
  spelledAt?: Date;
  /** kanji items: kept on the handwriting list beyond Settings.writeList. */
  pinned?: boolean;
  /** User-written memory hook (overrides content/mnemonics.json). */
  customMnemonic?: string;
  hideMnemonic?: boolean;
}

/**
 * Card types per item kind (src/srs/items.ts cardTypesFor):
 *   kana: read, write            kanaRule: read
 *   kanji: write (+ meaning when the kanji has no taught word)
 *   word: read (+ produce when WordEntry.use)
 *   core: listen (+ produce when use) (+ read once spelled with kanji)
 *   grammar: comprehend (+ build unless recognitionOnly)
 *   sentence: cloze
 */
export type CardType = 'read' | 'write' | 'meaning' | 'listen' | 'produce' | 'comprehend' | 'build' | 'cloze';

/** Retention breakdown families (change 13). */
export type CardFamily = 'write' | 'read' | 'listen' | 'produce' | 'grammar';

/** FSRS parameter presets: production = write, produce, build, cloze; receptive = read, meaning, listen, comprehend. */
export type FsrsPreset = 'production' | 'receptive';

/** 'retired': a write card past the write list (still kept, restored when the list grows or the kanji is pinned).
 *  There is no "suspend by hand" (rejected: retire-this-card modes). */
export type SuspendReason = 'retired';

export interface CardRecord extends FsrsCard {
  id: string;              // `${itemId}|${cardType}`
  itemId: string;
  kind: ItemKind;
  type: CardType;
  /** Suspended cards are never scheduled. */
  suspended?: SuspendReason;
}

/**
 * How the answer was given. choice = 'Show options' hint or hands-busy mode (graded at most Hard);
 * self = reveal + Missed/Got it; paper = written on paper and self-checked; partner = graded by the
 * partner (Session A quiz, Session C dictation, monthly quiz).
 */
export type AnswerMode = 'typed' | 'written' | 'spoken' | 'self' | 'choice' | 'partner' | 'paper';

/**
 * 'review': a warm-up (or make-up) answer. 're-ask': the graded retry after a warm-up miss.
 * 'first-check': a New card's first graded answer, and also its graded retry inside the first check.
 * 'partner': applied from a partner's verdict.
 */
export type ReviewContext = 'review' | 'first-check' | 're-ask' | 'partner';

export interface ReviewLogRecord {
  id?: number;             // auto-increment
  cardId: string;
  itemId: string;
  kind: ItemKind;
  type: CardType;
  grade: Grade;            // 1 Again, 2 Hard, 3 Good (objective cards never give 4 Easy)
  reviewedAt: Date;
  /** Time spent answering, ms (real value; the day total caps each answer at 2 min). */
  durationMs: number;
  mode: AnswerMode;
  /** FSRS state before this review (ts-fsrs State). */
  prevState: number;
  /** Whole days since the card's previous review (0 for a new card): real-retention buckets. */
  elapsedDays: number;
  context: ReviewContext;
  /** Word read cards: both sub-outcomes. */
  parts?: { reading: boolean; meaning: boolean };
  /** Writing cards: what the learner wrote with. */
  input?: 'finger' | 'stylus' | 'paper';
  /** The learner overrode the writing judgement ('I wrote it right'). */
  override?: true;
  /** Flagged surprise miss (last Good was fast, now Again). */
  surprise?: true;
}

/** Steps of a study day (src/components/study/session/machine.ts). */
export type SessionStepId = 'warmup' | 'teach' | 'memory' | 'read' | 'check' | 'output' | 'fluency' | 'summary';
/** The once-a-day steps that DayRecord.steps records. Warm-up, teach, memory and check are content-driven:
 *  planToday recomputes them from what is due, what is left to introduce and which New cards are unchecked. */
export type DailyStepId = 'read' | 'output' | 'fluency';

/** Where new-learning time goes. Only kanji, core and grammar enter the 60/20/20 shares. */
export type NewStream = 'sprint' | 'kanji' | 'staged' | 'core' | 'grammar';
/** Priced new-learning seconds by stream (lesson + first check). */
export type StreamSeconds = Record<NewStream, number>;

/** One row per study day, key 'YYYY-MM-DD'. */
export interface DayRecord {
  date: string;
  /** Solo study time, ms (graded answers capped at 2 min each, plus lessons, reading, output, make-up). */
  studyMs: number;
  /** Together sessions, ms. */
  togetherMs: number;
  /** Reviews done (graded answers of every context). */
  reviews: number;
  /** Of those, graded Hard or Good. */
  correct: number;
  /** Warm-up review time, ms: graded answers with context 'review' or 're-ask' outside a make-up session (capped at
   *  2 min each). First checks and partner grades are excluded. Feeds the minimum rule and the governor's day total. */
  reviewMs: number;
  /** Read, output and fluency time, ms (counted against the day's strand reserve). */
  strandMs: number;
  /** Items introduced through lessons and staged releases (only when the item was created). */
  newItems: number;
  /** Priced seconds of everything introduced today, by stream (sprint and staged included). */
  newSec: StreamSeconds;
  /** Counts toward the streak (change 8 minimum rule). */
  minimumDone: boolean;
  /** Every step of a full (any/desk) plan finished. Implies minimumDone. */
  goalMet: boolean;
  /** A missed day restored by a make-up session within 48 h (set on the missed day's row). */
  repaired?: boolean;
  /** Time spent in make-up sessions today, ms (§3.1.11). */
  makeupMs?: number;
  /** Travel/sick mode: neither counts nor breaks the streak. */
  travel?: boolean;
  /** The planner ran in catch-up mode today. Sticky for the rest of the day; tomorrow's hysteresis reads it. */
  catchUp?: boolean;
  /** Once-a-day steps finished today (set-add), so a later sitting skips them. */
  steps: DailyStepId[];
  /** Together sessions credited to this member on this date (set-add): creditTogetherSession is idempotent on it. */
  together?: TogetherSessionId[];
}

/** A rest token covering one day (2 per ISO week, no rollover). */
export interface RestTokenRecord {
  /** The covered day, 'YYYY-MM-DD'. */
  date: string;
  /** Monday of its ISO week. */
  week: string;
  /** When it was spent; before `date` means planned in advance. */
  usedAt: Date;
}

export type EncounterSource = 'sentence' | 'story' | 'output' | 'partner' | 'chat' | 'fluency';

/** One contextual encounter with an introduced item (target: ≥ 8 per word over 6 weeks). */
export interface EncounterRecord {
  id?: number;
  itemId: string;
  day: string;
  source: EncounterSource;
  at: Date;
}

/** A kanji's later word, waiting for its release day. */
export interface StagedWordRecord {
  /** 'word:1463770' or 'core:cw-0123'. */
  itemId: string;
  kanji: string;
  /** First study day on which it may be released. */
  releaseDay: string;
  slot: 2 | 3;
  releasedAt?: Date;
}

/** Story ladder: 1 read-while-listening done, 2 listen-only done, 3 timed re-read done. */
export interface StoryProgressRecord {
  storyId: string;
  stage: 0 | 1 | 2 | 3;
  firstDay?: string;
  /** Day the next ladder step is due: listen-only at firstDay + 3, timed re-read at firstDay + 10. */
  nextDay?: string;
  /** Gist answers, one per attempt (true = right). */
  gist: boolean[];
  /** Characters per minute of timed re-reads, oldest first. */
  cpm: number[];
  /** ISO week it was the couple's shared story. */
  sharedWeek?: string;
}

/** Replaces localStorage 'issho.srs.sentencesShown': 7-day rest after a sentence is shown. */
export interface SentenceShownRecord {
  id: string;              // SentenceEntry.id
  day: string;             // last shown
  count: number;
}

/** What the output step asked for. */
export interface OutputTarget {
  /** Item id of the target word or grammar point. */
  ref: string;
  /** Shown in the prompt ('もう', '〜たい'). */
  label: RubyText;
  en: string;
}

/** One output-step sentence ('today's sentence' to the partner). */
export interface OutputSentenceRecord {
  id: string;              // uuid
  day: string;
  target: OutputTarget;
  /** First attempt, before any edit. */
  draft: string;
  /** What was sent. */
  text: string;
  /** 'pending': queued until the AI is reachable; 'unavailable': AI disabled; 'skipped': just show me / no check. */
  check: 'pending' | 'done' | 'skipped' | 'unavailable';
  issues?: AiIssue[];
  corrected?: RubyText;
  rule?: string;
  /** Cloze card made from the verified correction (only when the card guard passed). */
  cardId?: string;
  /** Outbox clientId of the chat message. */
  chatClientId?: string;
  /** 'This tip seems wrong' was tapped. */
  reported?: boolean;
  /** A result that arrived after sending (queued check) has been shown to the learner. */
  resultSeen?: boolean;
  createdAt: Date;
}

/** A passed can-do (only passed checks award; attempts are counted). */
export interface CanDoRecord {
  id: string;              // 'u03-cd2'
  unit: number;
  attempts: number;
  passedAt?: Date;
  /** auto = read/listen questions; ai = AI rubric check (speak/write). Partners never judge each other's Japanese. */
  via?: 'auto' | 'ai';
}

/** Milestones already celebrated, so each shows once: 'chapter:7', 'season:2', 'M1', 'kana-check'. */
export interface MilestoneRecord {
  id: string;
  reachedAt: Date;
  seenAt?: Date;
}

/** The together week as this phone computed it (src/srs/together.ts buildWeekPlan). In a duo run the opener's
 *  choices travel in TogetherLiveState.plan and the joiner follows them. */
export interface TogetherWeekPlan {
  week: string;            // Monday
  /** One per slot, plus { id: 'monthly' } on the month's first Saturday when it falls in this week. */
  sessions: { id: TogetherSessionId; day: string; time: string; doneAt?: string; minutes?: number }[];
  /** The couple's settled unit: the highest unit whose grammar both partners introduced ≥ 2 days ago (0 = none). */
  settledUnit: number;
  /** Session A: core conversation and its stage (1–4). Stage is capped at 1 for a unit above settledUnit. */
  conversation?: { scriptId: string; stage: 1 | 2 | 3 | 4 };
  /** Session B: task card of a settled unit; `repeat` = the 2–7-day return with its twist. */
  task?: { unit: number; taskId: string; repeat: boolean };
  /** Session B without a task (no settled unit yet, or every task run): the first eligible free role-play, else the
   *  core conversation of unit settledUnit + 1; run at stage 1 and never stage-marked by Session B. */
  rolePlayId?: string;
  /** Shared weekly story (first story ready for both partners). */
  storyId?: string;
  /** The month's first Saturday is in this week: the separate monthly session is scheduled. */
  monthly: boolean;
  /** Monthly session: capstone skit for the most recent settled unit whose capstone isn't done. */
  capstoneUnit?: number;
  /** A season finale is due: Session C runs the can-do showcase instead of dictation. */
  showcase: boolean;
}

export interface TogetherPlanRecord {
  week: string;
  plan: TogetherWeekPlan;
  updatedAt: Date;
}

/** Together events waiting to be posted (POST /api/together/events), like the chat outbox. */
export interface TogetherOutboxRecord {
  clientId: string;
  createdAt: Date;
  week: string;
  /** JSON of shared/api.ts TogetherEvent. */
  event: string;
  attempts: number;
  failed?: string;
}

/** A partner quiz this phone took part in; idempotency for applying verdicts. */
export interface PartnerQuizRecord {
  quizId: string;
  /** answerer: the pool came from this phone's cards; asker: this phone showed the answers. */
  role: 'answerer' | 'asker';
  createdAt: Date;
  appliedAt?: Date;
  graded: number;
  practiced: number;
}

/** Pitch-ear drill: a simple Leitner box per word (not FSRS). */
export interface PitchBoxRecord {
  ref: string;             // 'core:cw-0042' | 'word:…'
  box: 0 | 1 | 2 | 3 | 4;
  nextDay: string;
  seen: number;
  correct: number;
}

export type FluencyKind = 'reread' | 'speed' | 'numbers' | 'pitch';

/** One fluency slot result. reread: value = chars/min; speed: cards read; numbers/pitch: correct. */
export interface FluencyLogRecord {
  id?: number;
  kind: FluencyKind;
  day: string;
  at: Date;
  value: number;
  /** Story id for rereads. */
  ref?: string;
}

export type DailyMinutes = 20 | 25 | 30 | 40;

/** If-then plan: 'After I pour my evening tea at the kitchen table, I open Issho'. */
export interface HabitCue {
  text: string;
  /** 'HH:MM' local: reminder time. */
  time: string;
}

export interface Settings {
  id: 'me';
  name: string;
  onboarded: boolean;
  /** Daily study budget (time governor). Default 25. */
  dailyMinutes: DailyMinutes;
  /** Kanji ranked above this keep a write card only until stable (stability > 21 d). 0–2136, default 500. */
  writeList: number;
  /** Desired retention of receptive cards: one of RECEPTIVE_RETENTIONS. Production cards use PRODUCTION_RETENTION. */
  receptiveRetention: number;
  /** FSRS weights per preset (never fitted on the device in v2; absent = ts-fsrs defaults). */
  fsrsWeights?: Partial<Record<FsrsPreset, number[]>>;
  furigana: 'always' | 'unknown' | 'never';
  audio: boolean;
  /** Model audio playback rate; absent = automatic (0.85 for course days 1–90, then 1). */
  audioRate?: number;
  /** Device voice (SpeechSynthesisVoice.voiceURI) for the last-resort fallback. */
  ttsVoice?: string;
  writingHand: 'finger' | 'stylus';
  /** Accessibility: typed answers offer choices (logged 'choice', graded at most Hard). */
  handsBusy: boolean;
  /** Output step: skip the find-it-yourself step and show the correction at once. */
  justShowMe: boolean;
  /** Placement check passed for the script (its kana start in Review). */
  knowsHiragana: boolean;
  knowsKatakana: boolean;
  cue?: HabitCue;
  /** 'If I miss it, I do 3 minutes before brushing my teeth.' */
  coping?: string;
  /** The couple's together slots (mirrors the server's latest 'slots' event). */
  togetherSlots: TogetherSlot[];
  sharedGoal?: SharedGoal;
  /** Day keys (course weeks 4 and 8) when Today prompts both to review their plans. */
  planReviewDays: string[];
  /** Travel/sick mode until this day, inclusive: streak frozen, no new items, reviews optional. */
  travelUntil?: string;
  /** Fresh start chosen after a 3+ day gap: next Monday or the 1st of the month. From that day Today shows a
   *  fresh-start header and the week view starts on that day, and the governor stays in catch-up until Rv ≤ LF
   *  (no new items before that). Cleared after the first normal-mode day on or after it. */
  freshStart?: string;
  /** Partner may see accuracy (correct counts). Default false: effort only. */
  shareAccuracy: boolean;
  // Home server (together features)
  serverUrl?: string;          // '' = same origin
  deviceToken?: string;
  memberId?: string;
  householdName?: string;
  /** Kept across unpairing: the chat cache and unsent messages belong to that household. */
  lastPairing?: LastPairing;
}

export interface LastPairing {
  householdId?: string;
  memberId: string;
  serverUrl: string;
}

/** Chat messages waiting to be sent while offline. */
export interface OutboxRecord {
  clientId: string;
  createdAt: Date;
  householdId?: string;
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audio?: Blob;
  audioId?: string;
  /** 'daily' = the output step's sentence of the day. */
  tag?: 'daily';
  attempts: number;
  failed?: string;
}

/** Local cache of chat messages (mirrors server). */
export interface ChatMessageRecord {
  id: number;
  clientId: string;
  memberId: string;
  createdAt: string;
  writtenAt?: string;
  kind: 'text' | 'voice' | 'system';
  text: string;
  transcript?: string;
  audioId?: string;
  tag?: 'daily';
}

/** A sentence kept for a cloze card: saved from reading, or a verified AI correction. */
export interface SavedSentenceRecord {
  id: string;              // SentenceEntry.id, or 'custom-<uuid>'
  jp: RubyText;
  en: string;
  savedAt: Date;
  source: 'reading' | 'story' | 'correction' | 'recap';
  /** The word the cloze card blanks (first occurrence of `surface` in rubyToPlain(jp)). */
  blank: { surface: string; reading: string; ref?: WordRef };
}
```

#### 2.4.2 `src/lib/db.ts` (complete v2 content)

```ts
import Dexie, { type EntityTable, type Transaction } from 'dexie';
import type {
  CanDoRecord,
  CardRecord,
  ChatMessageRecord,
  DailyMinutes,
  DayRecord,
  EncounterRecord,
  FluencyLogRecord,
  ItemKind,
  ItemRecord,
  MilestoneRecord,
  OutboxRecord,
  OutputSentenceRecord,
  PartnerQuizRecord,
  PitchBoxRecord,
  RestTokenRecord,
  ReviewLogRecord,
  SavedSentenceRecord,
  SentenceShownRecord,
  Settings,
  StagedWordRecord,
  StoryProgressRecord,
  TogetherOutboxRecord,
  TogetherPlanRecord,
} from './types.ts';

/** Production cards (write, produce, build, cloze) always use this desired retention. */
export const PRODUCTION_RETENTION = 0.9;
/** Desired retentions offered for receptive cards (read, meaning, listen, comprehend). Never above 0.95. */
export const RECEPTIVE_RETENTIONS = [0.85, 0.88, 0.9, 0.93] as const;
export const DAILY_MINUTES: readonly DailyMinutes[] = [20, 25, 30, 40];
export const DEFAULT_WRITE_LIST = 500;
export const MAX_WRITE_LIST = 2136;

/** v1 progress tables the v2 upgrade empties: the course changed, so v1 progress does not carry over. */
export const PROGRESS_TABLES = ['items', 'cards', 'reviewLogs', 'days', 'savedSentences'] as const;

const V1_STORES = {
  items: 'id, kind, introducedAt',
  cards: 'id, itemId, kind, type, due, state, suspended',
  reviewLogs: '++id, cardId, itemId, reviewedAt',
  days: 'date',
  settings: 'id',
  outbox: 'clientId, createdAt',
  messages: 'id, clientId, createdAt',
  savedSentences: 'id, savedAt',
};

const V2_STORES = {
  items: 'id, kind, introducedAt',
  cards: 'id, itemId, kind, type, due, state',
  reviewLogs: '++id, cardId, itemId, reviewedAt, [type+reviewedAt]',
  days: 'date',
  settings: 'id',
  outbox: 'clientId, createdAt',
  messages: 'id, clientId, createdAt',
  savedSentences: 'id, savedAt',
  encounters: '++id, itemId, day, [itemId+day]',
  shownSentences: 'id, day',
  staged: 'itemId, releaseDay',
  stories: 'storyId, nextDay',
  restTokens: 'date, week',
  outputs: 'id, day, check',
  canDos: 'id, unit',
  milestones: 'id',
  togetherPlans: 'week',
  togetherOutbox: 'clientId, createdAt',
  partnerQuizzes: 'quizId',
  pitchBoxes: 'ref, nextDay',
  fluency: '++id, kind, day',
};

export class IsshoDB extends Dexie {
  items!: EntityTable<ItemRecord, 'id'>;
  cards!: EntityTable<CardRecord, 'id'>;
  reviewLogs!: EntityTable<ReviewLogRecord, 'id'>;
  days!: EntityTable<DayRecord, 'date'>;
  settings!: EntityTable<Settings, 'id'>;
  outbox!: EntityTable<OutboxRecord, 'clientId'>;
  messages!: EntityTable<ChatMessageRecord, 'id'>;
  savedSentences!: EntityTable<SavedSentenceRecord, 'id'>;
  encounters!: EntityTable<EncounterRecord, 'id'>;
  shownSentences!: EntityTable<SentenceShownRecord, 'id'>;
  staged!: EntityTable<StagedWordRecord, 'itemId'>;
  stories!: EntityTable<StoryProgressRecord, 'storyId'>;
  restTokens!: EntityTable<RestTokenRecord, 'date'>;
  outputs!: EntityTable<OutputSentenceRecord, 'id'>;
  canDos!: EntityTable<CanDoRecord, 'id'>;
  milestones!: EntityTable<MilestoneRecord, 'id'>;
  togetherPlans!: EntityTable<TogetherPlanRecord, 'week'>;
  togetherOutbox!: EntityTable<TogetherOutboxRecord, 'clientId'>;
  partnerQuizzes!: EntityTable<PartnerQuizRecord, 'quizId'>;
  pitchBoxes!: EntityTable<PitchBoxRecord, 'ref'>;
  fluency!: EntityTable<FluencyLogRecord, 'id'>;

  constructor(name = 'issho') {
    super(name);
    this.version(1).stores(V1_STORES);
    this.version(2).stores(V2_STORES).upgrade(upgradeToV2);
  }
}

export const db = new IsshoDB();

export const DEFAULT_SETTINGS: Settings = {
  id: 'me',
  name: '',
  onboarded: false,
  dailyMinutes: 25,
  writeList: DEFAULT_WRITE_LIST,
  receptiveRetention: 0.9,
  furigana: 'unknown',
  audio: true,
  writingHand: 'finger',
  handsBusy: false,
  justShowMe: false,
  knowsHiragana: false,
  knowsKatakana: false,
  togetherSlots: [],
  planReviewDays: [],
  shareAccuracy: false,
  serverUrl: '',
};

/** Fields a v1 settings row keeps in v2; everything else is reset. */
const KEPT_V1_KEYS = [
  'name', 'furigana', 'audio', 'ttsVoice', 'writingHand',
  'serverUrl', 'deviceToken', 'memberId', 'householdName', 'lastPairing',
] as const;

/** v1 newPerDay → v2 dailyMinutes: 3 → 20, 5 → 25, 8 → 30 (≤ 3 → 20, 4–6 → 25, ≥ 7 → 30; missing → 25). */
export function minutesForOldPace(newPerDay: unknown): DailyMinutes {
  const pace = typeof newPerDay === 'number' && Number.isFinite(newPerDay) ? newPerDay : 5;
  return pace <= 3 ? 20 : pace <= 6 ? 25 : 30;
}

/**
 * A v1 settings row as v2 Settings. Learning progress is reset by the upgrade, so onboarding runs
 * again (the name and the pairing are kept and pre-filled); romaji, newPerDay, maxReviewsPerDay and
 * desiredRetention are dropped; knowsHiragana/knowsKatakana go back to false (placement decides).
 */
export function migrateSettings(old: Readonly<Record<string, unknown>>): Settings {
  const kept: Record<string, unknown> = {};
  for (const key of KEPT_V1_KEYS) if (old[key] !== undefined) kept[key] = old[key];
  return {
    ...DEFAULT_SETTINGS,
    ...(kept as Partial<Settings>),
    id: 'me',
    onboarded: false,
    dailyMinutes: minutesForOldPace(old.newPerDay),
  };
}

/** The nearest offered receptive retention (so never above 0.95); 0.9 for nonsense. */
export function normalizeRetention(value: number): number {
  if (!Number.isFinite(value)) return 0.9;
  let best: number = RECEPTIVE_RETENTIONS[0];
  for (const r of RECEPTIVE_RETENTIONS) if (Math.abs(r - value) < Math.abs(best - value)) best = r;
  return best;
}

/** Dexie upgrade 1 → 2: empties the progress tables, migrates settings, drops the old localStorage key. */
export async function upgradeToV2(tx: Transaction): Promise<void> {
  for (const name of PROGRESS_TABLES) await tx.table(name).clear();
  await tx.table('settings').toCollection().modify((row: Record<string, unknown>, ctx: { value: unknown }) => {
    ctx.value = migrateSettings(row);
  });
  try {
    localStorage.removeItem('issho.srs.sentencesShown');
  } catch {
    // Storage blocked: nothing to remove.
  }
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('me');
  return { ...DEFAULT_SETTINGS, ...s };
}

/** Merges `patch` into the stored settings. One transaction, so two quick changes can't both read the old row. */
export function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const next = { ...(await getSettings()), ...patch, id: 'me' as const };
    await db.settings.put(next);
    return next;
  });
}

/** Local calendar date key, 'YYYY-MM-DD'. A study day rolls over at 4 a.m. local time (DST-safe). */
export function dayKey(d: Date = new Date()): string {
  const shifted = new Date(d);
  if (shifted.getHours() < 4) shifted.setDate(shifted.getDate() - 1);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function itemId(kind: ItemRecord['kind'], key: string): string {
  return `${kind}:${key}`;
}

export function cardId(item: string, type: CardRecord['type']): string {
  return `${item}|${type}`;
}

const ITEM_KINDS: readonly ItemKind[] = ['kana', 'kanaRule', 'kanji', 'word', 'core', 'grammar', 'sentence'];

/** 'kanji:水' → { kind: 'kanji', key: '水' }; null when the kind is unknown. */
export function parseItemId(id: string): { kind: ItemKind; key: string } | null {
  const at = id.indexOf(':');
  const kind = id.slice(0, at) as ItemKind;
  return at > 0 && ITEM_KINDS.includes(kind) ? { kind, key: id.slice(at + 1) } : null;
}

/** 'kanji:水|write' → 'kanji:水'. */
export function itemIdOfCard(id: string): string {
  return id.slice(0, id.lastIndexOf('|'));
}
```

#### 2.4.3 `src/lib/data.ts` (complete v2 content)

```ts
// Loads the static study data from public/data and public/audio/manifest.json (precached by the
// service worker, so this works offline). Every loader is memoized for the life of the page.
// Optional content (stories, units, role-plays, accent, audio) loads as empty when not built yet.

import type {
  AccentFile,
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicsFile,
  RadicalEntry,
  Register,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  StrokesFile,
  UnitSpec,
  WordEntry,
  WordRef,
} from './types.ts';

const BASE = `${import.meta.env.BASE_URL}data/`;
const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`;

/** A short word on a kana's learn card (content/kana-examples.json); its clip ref is 'kanaEx:<char>'. */
export interface KanaExample {
  kana: string;
  written?: string;
  en: string;
  /** Basic kana: one-line picture mnemonic (≤ 12 words), shown in KanaLesson and after a kana-write miss. */
  hook?: string;
}

/** content/kana-examples.json: one example per basic, dakuten and handakuten kana, keyed by the kana. */
export type KanaExamplesFile = Record<string, KanaExample>;

export const EMPTY_MANIFEST: AudioManifest = {
  version: 1,
  generatedAt: '',
  engine: '',
  credits: [],
  clips: {},
  byRef: {},
  byText: {},
};

const cache = new Map<string, Promise<unknown>>();

function memo<T>(url: string, fetcher: () => Promise<T>): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetcher();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

function load<T>(url: string): Promise<T> {
  return memo(url, () =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
      return r.json() as Promise<T>;
    }),
  );
}

/** Like load, but a file that is not there (404, or an HTML fallback page) is `empty`. */
function loadOptional<T>(url: string, empty: T): Promise<T> {
  return memo(url, () =>
    fetch(url).then((r) => {
      const json = (r.headers.get('content-type') ?? '').includes('json');
      if (r.status === 404 || (r.ok && !json)) {
        console.warn(`${url} is not built yet`);
        return empty;
      }
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
      return r.json() as Promise<T>;
    }),
  );
}

export const loadKana = () => load<KanaEntry[]>(`${BASE}kana.json`);
export const loadKanji = () => load<Record<string, KanjiEntry>>(`${BASE}kanji.json`);
export const loadRadicals = () => load<RadicalEntry[]>(`${BASE}radicals.json`);
export const loadWords = () => load<WordEntry[]>(`${BASE}words.json`);
export const loadCurriculum = () => load<Curriculum>(`${BASE}curriculum.json`);
export const loadStrokes = () => load<StrokesFile>(`${BASE}strokes.json`);
export const loadAccent = () => loadOptional<AccentFile>(`${BASE}accent.json`, {});
export const loadCoreWords = () => load<CoreWord[]>(`${BASE}content/core-words.json`);
export const loadKanaRules = () => load<KanaRule[]>(`${BASE}content/kana-rules.json`);
export const loadKanaExamples = () => load<KanaExamplesFile>(`${BASE}content/kana-examples.json`);
export const loadMnemonics = () => load<MnemonicsFile>(`${BASE}content/mnemonics.json`);
export const loadGrammar = () => load<GrammarPoint[]>(`${BASE}content/grammar.json`);
export const loadSentences = () => load<SentenceEntry[]>(`${BASE}content/sentences.json`);
export const loadStories = () => loadOptional<StoryEntry[]>(`${BASE}content/stories.json`, []);
export const loadRolePlays = () => loadOptional<RolePlay[]>(`${BASE}content/roleplays.json`, []);
export const loadUnits = () => loadOptional<UnitSpec[]>(`${BASE}content/units.json`, []);
export const loadAudioManifest = () => loadOptional<AudioManifest>(`${AUDIO_BASE}manifest.json`, EMPTY_MANIFEST);

/** URL of a clip file from the manifest ('a3/a3f0….m4a'). */
export function audioUrl(file: string): string {
  return AUDIO_BASE + file;
}

let wordIndex: Promise<Map<string, WordEntry>> | undefined;
/** JMdict words by id. */
export function loadWordIndex(): Promise<Map<string, WordEntry>> {
  wordIndex ??= loadWords().then((ws) => new Map(ws.map((w) => [w.id, w])));
  wordIndex.catch(() => (wordIndex = undefined));
  return wordIndex;
}

let coreIndex: Promise<Map<string, CoreWord>> | undefined;
/** Core words by id. */
export function loadCoreIndex(): Promise<Map<string, CoreWord>> {
  coreIndex ??= loadCoreWords().then((ws) => new Map(ws.map((w) => [w.id, w])));
  coreIndex.catch(() => (coreIndex = undefined));
  return coreIndex;
}

let grammarIndex: Promise<Map<string, GrammarPoint>> | undefined;
/** Grammar points by id. */
export function loadGrammarIndex(): Promise<Map<string, GrammarPoint>> {
  grammarIndex ??= loadGrammar().then((gs) => new Map(gs.map((g) => [g.id, g])));
  grammarIndex.catch(() => (grammarIndex = undefined));
  return grammarIndex;
}

/** One word as every screen shows it, whether it is a core word or a JMdict word. */
export interface WordInfo {
  ref: WordRef;
  /** Usual written form: the kanji spelling when there is one, else the kana. */
  written: string;
  kana: string;
  en: string;
  kanji: string[];
  /** The learner should produce it (produce card). */
  use: boolean;
  /** Accepted typed readings: kana first, then alternates. */
  readings: string[];
  register?: Register;
  note?: string;
  core?: CoreWord;
  entry?: WordEntry;
}

let wordInfo: Promise<(ref: string) => WordInfo | undefined> | undefined;
/** Resolves 'core:<id>' and 'word:<id>' refs. */
export function loadWordInfo(): Promise<(ref: string) => WordInfo | undefined> {
  wordInfo ??= Promise.all([loadCoreIndex(), loadWordIndex()]).then(([cores, words]) => {
    const infos = new Map<string, WordInfo>();
    for (const c of cores.values()) {
      infos.set(`core:${c.id}`, {
        ref: `core:${c.id}`,
        written: c.written ?? c.kana,
        kana: c.kana,
        en: c.en,
        kanji: c.kanji,
        use: c.use,
        readings: [c.kana, ...(c.altKana ?? [])],
        register: c.register,
        note: c.note,
        core: c,
      });
    }
    for (const w of words.values()) {
      infos.set(`word:${w.id}`, {
        ref: `word:${w.id}`,
        written: w.written,
        kana: w.kana,
        en: w.meanings.join('; '),
        kanji: w.kanji,
        use: w.use ?? false,
        readings: [w.kana, ...(w.altKana ?? [])],
        entry: w,
      });
    }
    return (ref: string) => infos.get(ref);
  });
  wordInfo.catch(() => (wordInfo = undefined));
  return wordInfo;
}

/** Stroke paths for one character, or undefined when KanjiVG has none. */
export async function strokesFor(char: string): Promise<string[] | undefined> {
  return (await loadStrokes())[char];
}

/** Tests: forget every memoized load and index. */
export function clearDataCache(): void {
  cache.clear();
  wordIndex = undefined;
  coreIndex = undefined;
  grammarIndex = undefined;
  wordInfo = undefined;
}
```

`data.ts` keeps **no** v1 exports (`loadSurvivalWords` and the rest are gone). Until the integration merge, other owners' unchanged files that still import them fail to link in Vite; that is why browser QA waits for integration (§6.1), while unit tests (which mock `data.ts`) run per owner.

Test mocks: every test file that `vi.mock`s `data.ts` must provide each loader its code path calls. `src/srs/test-fixtures.ts` (B), `src/components/study/test-utils.tsx` (C) and `src/components/home/test-fixtures.tsx` (D) each export a complete `dataMock` covering every export above. Each implementer updates their own fixture.

#### 2.4.4 `shared/api.ts` (complete v2 content)

```ts
// HTTP + WebSocket contract between the app (src/sync) and the home server (server/src).
// Types only, plus constants: erasable syntax, so Node can import it directly.
//
// Auth: every route except /api/health and /api/register needs the header
//   Authorization: Bearer <deviceToken>
// The WebSocket passes the token as a query parameter: /api/ws?token=<deviceToken>
// Errors are JSON { error: string } with a 4xx/5xx status.
// Any origin may call /api/* (CORS): the app can live at one address and talk to the home server
// at another ("Advanced: server address"). Auth is a bearer token, never a cookie.

export interface HealthResponse {
  ok: true;
  version: string;
  aiEnabled: boolean;
  /** A VOICEVOX engine answered recently: POST /api/tts works. */
  ttsEnabled: boolean;
}

// POST /api/register — join the household from a new device.
export interface RegisterRequest {
  /** Shared secret set as HOUSEHOLD_CODE on the server. */
  householdCode: string;
  /** Re-registering an existing member on a new device: same name = same member. */
  name: string;
  /** The member this phone was before it disconnected or was signed out. */
  memberId?: string;
}
export interface RegisterResponse {
  deviceToken: string;
  memberId: string;
  householdName: string;
  /** Identifies this household's data; it changes only if the server starts afresh. */
  householdId: string;
}

// PATCH /api/me { name } → Member — renames the caller's member (1–40 characters).
// 409 { error: 'name_taken' } when another member has that name.
export interface RenameMemberRequest { name: string }
export type RenameMemberResponse = Member;

// POST /api/signout → { ok: true } — signs this device out (its WebSocket closes with WS_CLOSE_UNPAIRED).
export interface SignOutResponse { ok: true }

export interface Member {
  id: string;
  name: string;
  joinedAt: string;          // ISO
  lastSeenAt: string | null; // ISO
}

/** A member's study summary for one day. Sent by each phone, read by the other. */
export interface DayStats {
  date: string;              // 'YYYY-MM-DD'
  /** Solo study minutes. */
  studyMinutes: number;
  reviews: number;
  /** ≤ reviews. Sent as 0 unless the member turned on Settings.shareAccuracy (accuracy is private by default). */
  correct: number;
  newItems: number;
  /** v2: the whole plan was finished ("goal met"). */
  sessionComplete: boolean;
  /** v2: the day counts toward the streak (minimum day). Absent from v1 phones (read as sessionComplete). */
  minimumDone?: boolean;
  /** v2: together-session minutes. */
  togetherMinutes?: number;
  /** v2: a rest token covers the day. */
  restToken?: boolean;
  /** v2: true when `correct` is real (shareAccuracy on). */
  accuracyShared?: boolean;
}

/** v2 progress summary a phone uploads with its stats: effort and milestones, never error counts. */
export interface MemberProgress {
  /** Current unit (the unit of the next grammar point to teach), 1-based. */
  unit: number;
  /** Current kanji chapter (0 = kana). */
  chapter: number;
  kanjiCanWrite: number;
  kanjiCanRead: number;
  wordsKnown: number;
  grammarKnown: number;
  /** Solo + together, whole course. */
  hoursTotal: number;
  daysThisMonth: number;
  longestStreak: number;
  /** Story ids this member reads at ≥ 98 % coverage (max 60): the shared weekly story is the first ready for everyone. */
  readyStories: string[];
  /** Kanji introduced 2–21 days ago, newest first (max 20): partner-side games without the server pool. */
  recentKanji: string[];
  /** Item ids (core:, word:, grammar:, kanji:) introduced 2–21 days ago, newest first (max 20): task-card targets. */
  recentItems: string[];
  /** Highest unit whose grammar points were all introduced ≥ 2 days ago (0 = none): together tasks and stages. */
  settledUnit: number;
  /** Highest CoreWord.order introduced (core words are taught in order): partner-side "introduced" checks. */
  coreReached: number;
  /** Highest GrammarPoint.order introduced. */
  grammarReached: number;
}

// POST /api/stats — upsert this member's recent days and totals. Each device's upload replaces
// its own earlier one; the household view merges the member's devices, taking the largest value per day.
// Success codes: POST /api/messages → 201 new / 200 resent clientId; POST /api/voice, /api/quizzes and
// /api/together/events → 201 (200 for a resent clientId). Treat any 2xx as success.

/** POST /api/stats response. */
export interface StatsUploadResponse { ok: true }

export interface StatsUploadRequest {
  days: DayStats[];          // usually the last 14 days (max 62)
  /** Current streak (minimum days; 0 when broken). */
  streak: number;
  kanjiKnown: number;
  /** Every kanji this member has been introduced to, for "you both know". */
  knownKanji: string[];
  /** v1 field; v2 phones omit it (the server stores 1). */
  phase?: number;
  /** v2 summary. */
  progress?: MemberProgress;
}

export interface MemberStats {
  member: Member;
  days: DayStats[];          // last 7 days, oldest first, missing days filled with zeros
  streak: number;
  kanjiKnown: number;
  knownKanji: string[];
  phase: number;
  /** v2 summary, null until the member's phone has sent one. */
  progress: MemberProgress | null;
  updatedAt: string | null;
}

/** The weekly couple quest: every member ≥ 5 minimum days and sessions A, B and C; one reserve a month. */
export interface CoupleQuest {
  week: string;              // Monday 'YYYY-MM-DD'
  /** memberId → minimum days this week (a together session counts for every member that day). */
  minimumDays: Record<string, number>;
  /** Distinct letters A, B, C done this week (0–3). A monthly session stands in for one missing letter; it never adds beyond 3. */
  togetherSessions: number;
  /** Shortfalls before the reserve: Σ max(0, 5 − minimumDays) + max(0, 3 − togetherSessions). */
  shortfall: number;
  /** shortfall === 0, or shortfall === 1 covered by the month's reserve. */
  met: boolean;
  reserveUsed: boolean;
  /** The calendar month's reserve is still unused (as of this week). */
  reserveLeft: boolean;
  /** Days left in the week including today (household time). */
  daysLeft: number;
}

// GET /api/household
export interface HouseholdResponse {
  householdName: string;
  me: string;                // memberId of the caller
  members: MemberStats[];
  /** v1 clients only (v2 clients never render it): consecutive days on which every member had a minimum day
   *  (v1 phones: a completed session) or a together session. */
  sharedStreak: number;
  /** This week's couple quest. */
  quest: CoupleQuest;
  /** Consecutive weeks with the quest met, ending this week or last week. The v2 "shared streak" display. */
  questStreakWeeks: number;
}

export type MessageKind = 'text' | 'voice' | 'system';

export interface ChatMessage {
  id: number;
  clientId: string;
  memberId: string;
  createdAt: string;         // ISO, when the server received it (orders the chat)
  /** ISO, when the sender wrote it; never after createdAt nor more than 7 days before it. */
  writtenAt?: string;
  kind: MessageKind;
  text: string;
  transcript?: string;
  audioId?: string;
  /** 'daily' = the sender's output-step sentence of the day. */
  tag?: 'daily';
}

// GET /api/messages?after=<id>&limit=<n> → ChatMessage[] oldest first (limit default 100)
// POST /api/messages
export interface SendMessageRequest {
  clientId: string;
  writtenAt?: string;
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audioId?: string;
  tag?: 'daily';
}
export type SendMessageResponse = ChatMessage;

// POST /api/voice (multipart field "audio", ≤ 2 MB, audio/webm|audio/mp4|audio/ogg|audio/wav)
export interface UploadVoiceResponse { audioId: string }
// GET /api/voice/:audioId → the audio bytes with their content type

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------
// kind 'kanji' (v1): fromMember sends kanji to toMember, who answers on their phone.
// kind 'partner' (Session A, ≤ 10 items), 'dictation' (Session C, ≤ 5 kanji write items) and 'monthly'
// (≤ 20 items): fromMember is the ANSWERER, whose phone built the pool from its own cards; toMember is
// the ASKER, whose phone shows each item's prompt and answer and posts the verdicts. The answerer's phone
// applies the verdicts to its FSRS cards (src/srs/together.ts applyPartnerVerdicts).

/** v1: one kanji (a single Han character). */
export interface KanjiQuizItem { char: string }
export type PartnerQuizKind = 'write' | 'read' | 'produce' | 'build';
export interface PartnerQuizItem {
  /** The answerer's card id ('kanji:水|write'), max 80 chars. */
  key: string;
  kind: PartnerQuizKind;
  /** What the asker reads out or shows, max 200 chars ('Write the kanji for "water" · □ みず'). */
  prompt: string;
  /** What the asker checks against, ruby allowed, max 200 chars. */
  answer: string;
}
export type QuizItem = KanjiQuizItem | PartnerQuizItem;
export type QuizKind = 'kanji' | 'partner' | 'dictation' | 'monthly';
export type QuizVerdict = 'right' | 'close' | 'wrong';
export interface QuizItemVerdict { key: string; verdict: QuizVerdict }

export interface Quiz {
  id: string;
  kind: QuizKind;
  fromMemberId: string;
  toMemberId: string;
  createdAt: string;
  items: QuizItem[];
  /** Filled in when the recipient finishes. */
  result?: { correct: number; total: number; finishedAt: string; missed: string[]; verdicts?: QuizItemVerdict[] };
}
// POST /api/quizzes { toMemberId, kind?, items } → Quiz (kind defaults to 'kanji')
export interface CreateQuizRequest { toMemberId: string; kind?: QuizKind; items: QuizItem[] }
// GET /api/quizzes → { inbox: Quiz[]; sent: Quiz[] } (last 20 each, newest first)
export interface QuizzesResponse { inbox: Quiz[]; sent: Quiz[] }
// POST /api/quizzes/:id/result → Quiz. For partner/dictation/monthly quizzes `verdicts` is required (one per item key);
// correct = number of 'right', missed = keys not 'right'.
export interface QuizResultRequest { correct: number; total: number; missed: string[]; verdicts?: QuizItemVerdict[] }

// ---------------------------------------------------------------------------
// Together routine (household-wide state, event-sourced on the server)
// ---------------------------------------------------------------------------

export type TogetherSessionId = 'A' | 'B' | 'C' | 'monthly';

/** A weekly together slot. weekday is ISO: 1 = Monday … 7 = Sunday. */
export interface TogetherSlot { session: 'A' | 'B' | 'C'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; time: string /* 'HH:MM' */ }

export interface SharedGoal { text: string; targetDate: string /* 'YYYY-MM-DD' */ }

export interface WeeklyCheckin {
  /** Auto-filled counts for the week. */
  counts: { kanji: number; words: number; grammar: number; minutes: number };
  /** The can-do this member ticked as managed this week. */
  canDo?: string;
  note?: string;
  /** Rest-token days planned for next week. */
  plannedRest?: string[];
}

export type TogetherEvent =
  | { type: 'slots'; slots: TogetherSlot[] }
  | { type: 'goal'; goal: SharedGoal }
  | { type: 'session-done'; session: TogetherSessionId; date: string; minutes: number }
  /** The sender marked the conversation run at `stage` smooth; both = both partners tapped on this one phone. */
  | { type: 'smooth'; scriptId: string; stage: 1 | 2 | 3 | 4; both?: boolean }
  | { type: 'task-done'; taskId: string; date: string; repeat: boolean }
  | { type: 'checkin'; checkin: WeeklyCheckin }
  | { type: 'capstone-done'; unit: number; date: string };

// POST /api/together/events → TogetherState (201; 200 when clientId was already applied)
export interface TogetherEventRequest {
  /** Idempotency key (uuid), like chat messages. */
  clientId: string;
  /** ISO week (Monday) the event belongs to. */
  week: string;
  event: TogetherEvent;
}

// GET /api/together → TogetherState
export interface TogetherState {
  /** Latest 'slots' event ([] until set). */
  slots: TogetherSlot[];
  goal: SharedGoal | null;
  /** scriptId → current stage 1–4, or 5 when finished. Missing = 1. */
  stages: Record<string, number>;
  /** scriptId → memberIds who marked the current stage smooth (cleared when the stage advances). */
  smooth: Record<string, string[]>;
  /** Together sessions done in the last 12 weeks. */
  sessions: { week: string; session: TogetherSessionId; date: string; minutes: number; memberId: string }[];
  /** Tasks run in the last 60 days. */
  tasks: { taskId: string; date: string; repeat: boolean }[];
  /** Check-ins of the last 26 weeks. */
  checkins: { week: string; memberId: string; checkin: WeeklyCheckin }[];
  capstones: { unit: number; date: string }[];
}

// ---------------------------------------------------------------------------
// Text-to-speech (server proxy to a VOICEVOX engine)
// ---------------------------------------------------------------------------
// POST /api/tts with a JSON TtsQuery body → audio/wav (24 kHz mono). A POST body, never a query string,
// so private chat text and AI replies never reach the request log.
// 503 { error: 'tts_unavailable' } when no engine answers; 400 bad text; 429 rate_limited.
export type VoiceId = 'f' | 'm';
export const TTS_MAX_CHARS = 200;
/** text: ruby markup or plain, 1–200 characters after trimming. */
export interface TtsQuery { text: string; voice?: VoiceId }

// ---------------------------------------------------------------------------
// AI helper (only when ANTHROPIC_API_KEY is set; otherwise 503 { error: 'ai_disabled' })
// ---------------------------------------------------------------------------

/** What the AI may assume the learner knows. Every field optional. */
export interface AiLearnerContext {
  knownKanji?: string[];
  /** grammar-v2 ids introduced so far. */
  knownGrammar?: string[];
  /** Known words as written (kana or kanji), max 3000. */
  knownWords?: string[];
  register?: 'plain' | 'polite';
}

export type AiIssueType = 'particle' | 'conjugation' | 'word-choice' | 'kanji' | 'register' | 'other';

export interface AiIssue {
  /** The exact part of the learner's text with the problem (a substring of it). */
  quote: string;
  /** Character offsets of `quote` in the submitted text (found by the server); null when not found. */
  start: number | null;
  end: number | null;
  type: AiIssueType;
  /** The AI is not sure: shown as "maybe". */
  uncertain: boolean;
  /** Prompt mode: a nudge naming what to look at, never the fix ("Check the particle after 駅"). */
  hint: string;
}

export interface AiDiffOp { op: 'same' | 'del' | 'ins'; text: string }

/** A corrected sentence broken into words, for the client's card guard (dictionary check). */
export interface AiWord { surface: string; lemma: string; reading: string }

// POST /api/ai/check — look over a learner's Japanese (output step and chat composer).
export interface AiCheckRequest extends AiLearnerContext {
  text: string;
  /** Recent chat lines for context, oldest first, max 6. */
  context?: string[];
  /** 'prompt': up to 2 issues and no corrected text. 'reveal': corrected text, diff and rule. Default 'reveal'. */
  mode?: 'prompt' | 'reveal';
  /** The word or grammar the sentence should use (output step). */
  target?: string;
  /** Reveal after an edit: the learner's first attempt. */
  firstAttempt?: string;
}
/** v1 tip, kept for older clients (filled in reveal mode, max 2). */
export interface AiTip {
  original: string;
  suggestion: string;
  explanation: string;
}
export interface AiCheckResponse {
  ok: boolean;               // true = natural and correct
  issues: AiIssue[];         // max 2, most important first
  /** Reveal mode: the whole text fixed ('' in prompt mode; equal to text when ok). */
  corrected: string;
  /** Reveal mode: `corrected` with ruby for kanji outside knownKanji. */
  correctedRuby: string;
  /** Reveal mode: learner text → corrected, computed by the server (character LCS). [] in prompt mode. */
  diff: AiDiffOp[];
  /** Reveal mode: one-line rule ('' when ok or in prompt mode). */
  rule: string;
  /** Reveal mode: grammar ids the corrected text uses (ids from knownGrammar, else 'other'). */
  grammarUsed: string[];
  /** Reveal mode: the corrected text as words. */
  words: AiWord[];
  /** v1 compatibility. */
  tips: AiTip[];
}

// POST /api/ai/translate — "How do I say this?"
export interface AiTranslateRequest { english: string; knownKanji?: string[] }
export interface AiTranslateResponse {
  /** Casual spoken Japanese between partners, in ruby markup. */
  japanese: string;
  /** Hepburn romaji (v2 clients show it only during the kana sprint). */
  romaji: string;
  note: string;
}

// POST /api/ai/roleplay — the AI plays a third role (clerk, waiter) in a Session B task.
export interface AiRolePlayRequest extends AiLearnerContext {
  taskId: string;
  aiRole: string;
  goal: string;
  /** Conversation so far, oldest first, max 30 turns. */
  history: { speaker: 'ai' | 'a' | 'b'; text: string }[];
}
export interface AiRolePlayResponse {
  /** The AI's next line in ruby markup (short, at the learners' level). */
  reply: string;
  en: string;
  /** The task's goal has been reached or the scene ended. */
  done: boolean;
}

// POST /api/ai/recap — private recap of one member's lines after a task (1–2 points).
export interface AiRecapRequest extends AiLearnerContext {
  goal: string;
  /** This member's own lines, max 30. */
  lines: string[];
}
export interface AiRecapPoint {
  quote: string;
  corrected: string;
  rule: string;
  grammarUsed: string[];
  words: AiWord[];
}
export interface AiRecapResponse { points: AiRecapPoint[] /* max 2 */; praise: string }

// POST /api/ai/cando — rubric check of a speak/write can-do (transcript or text).
export interface AiCanDoRequest {
  canDoId: string;
  kind: 'speak' | 'write';
  rubric: string[];
  /** What the learner said (speech-recognition transcript) or wrote. */
  text: string;
}
export interface AiCanDoResponse { met: boolean[]; passed: boolean; feedback: string }

// POST /api/ai/report → 204 — "This tip seems wrong".
export interface AiReportRequest {
  kind: 'check' | 'recap' | 'roleplay' | 'cando';
  text: string;
  issue?: AiIssue;
  note?: string;
}

/**
 * WebSocket close code (policy violation) for a device that is no longer paired. The phone should
 * pair again, not reconnect.
 */
export const WS_CLOSE_UNPAIRED = 1008;

/**
 * What the opener's phone chose for this run. The joining phone follows it instead of its own week plan,
 * so both phones run the same script, stage, task, story and capstone.
 */
export interface TogetherRunPlan {
  conversation?: { scriptId: string; stage: 1 | 2 | 3 | 4 };
  task?: { unit: number; taskId: string; repeat: boolean };
  /** Free role-play (stage 1) when there is no task. */
  rolePlayId?: string;
  storyId?: string;
  capstoneUnit?: number;
  showcase?: boolean;
}

/** Live state of a together session shared between the two phones (relayed, not stored). */
export interface TogetherLiveState {
  sessionId: string;
  session: TogetherSessionId;
  /** memberId of the phone that created sessionId. Its plan, step, turn, index and timer are authoritative. */
  opener: string;
  /** Sent by the opener from its first live event on; a joiner never sends its own. */
  plan?: TogetherRunPlan;
  /** answerer memberId → quiz id of the current quiz step (partner, dictation or monthly). Each phone adds its own
   *  entry after createQuiz; receivers merge entries (union), so the asker knows which quiz to grade. */
  quizIds?: Record<string, string>;
  /** 'quiz', 'teach-me', 'conversation', 'plan', 'task', 'swap', 'recap', 'story', 'retell', 'dictation',
   *  'showcase', 'checkin', 'goal', 'capstone', 'done'. */
  step: string;
  /** memberId whose turn it is to answer (quiz, dictation, retell). */
  turn?: string;
  /** Index within the step (quiz item, retell round 0–2, dictation word). */
  index?: number;
  /** Epoch ms when the step's timer started (planning 60–90 s, retell 90/60/45 s). */
  timerStartedAt?: number;
  status: 'waiting' | 'active' | 'done';
}

// WebSocket /api/ws?token=… — server → client events (JSON, one per frame).
export type ServerEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'stats'; memberId: string }
  | { type: 'quiz'; quiz: Quiz }
  | { type: 'presence'; memberId: string; online: boolean }
  | { type: 'roleplay'; memberId: string; state: RolePlaySyncState }
  /** The together state changed: GET /api/together. Sent to every device of every member, the sender's included. */
  | { type: 'together' }
  | { type: 'live'; memberId: string; state: TogetherLiveState };

// Client → server events over the same socket.
export type ClientEvent =
  | { type: 'roleplay'; state: RolePlaySyncState }
  | { type: 'live'; state: TogetherLiveState }
  | { type: 'ping' };

/** Shared position in a role-play so both phones advance together. */
export interface RolePlaySyncState {
  sessionId: string;
  scriptId: string;
  role: 'a' | 'b';
  lineIndex: number;
  status: 'waiting' | 'active' | 'done';
  /** v2: conversation stage of this run (S1 listen & shadow … S4 cue cards). */
  stage?: 1 | 2 | 3 | 4;
}
```

---

## 3. Module contracts

Signatures here are exact: names, parameters, return types. Behaviour is normative. Anything an implementer adds beyond this stays private to their own files. A function marked *pure* has no I/O and takes every input as a parameter.

### 3.1 Engine — owner B (`src/srs/**`, `src/lib/hooks.ts`, `src/lib/ruby.ts`, `src/lib/backup.ts`)

#### 3.1.1 Course day, kana sprint, gates, placement — `src/srs/course.ts`

```ts
export type KnownScripts = Partial<Record<KanaScript, boolean>>;

export interface SprintDay {
  /** Course day (1-based). */
  day: number;
  script: KanaScript;
  /** Basic kana taught today (row lessons), chart order. */
  kana: string[];
  rule?: KanaRuleId;
  /** Last sprint day: the 'Kana check' can-do (read 10 katakana menu words aloud at speed). */
  kanaCheck?: boolean;
}

/** pure. Hiragana: days 1–5 rows (KanaEntry.sprintDay), 6 hira-dakuten, 7 hira-yoon; katakana: 8–12 rows,
 *  13 kata-dakuten-yoon, 14 kata-extended. A known script is left out and the other moves to days 1–7. */
export function kanaSprint(kana: readonly KanaEntry[], rules: readonly KanaRule[], known: KnownScripts): SprintDay[];

export interface CourseGates { coreFrom: number; grammarFrom: number; kanjiFrom: number; governorFrom: number }
/** pure. Neither script known: core 3, grammar 8, kanji/governor 15. Hiragana known: core 1, grammar 1,
 *  kanji/governor 8. Only katakana known: core 3, grammar 8, kanji/governor 8. Both known: all 1.
 *  kanjiFrom and governorFrom apply only once the sprint content is complete (CourseSnapshot.sprintComplete). */
export function courseGates(known: KnownScripts): CourseGates;

export interface SprintPick { kana: string[]; rule: KanaRuleId | null }
/** pure. Sprint content from progress, not from the calendar. Walk the sprint days 1..min(courseDay, sprint.length) in
 *  order and collect their basic kana not yet introduced, in chart order, at most 10. rule: the first rule of a walked
 *  day not yet introduced, only when no rule was introduced today and every basic kana of its script is introduced or
 *  in `kana`; at most one a day (taught after the rows). */
export function sprintPick(sprint: readonly SprintDay[], introduced: ReadonlyMap<string, string>, today: string, courseDay: number): SprintPick;

/** pure. 1 + the number of distinct study days (DayRecord isStudyDay) strictly before `today`. */
export function courseDayFrom(studyDays: readonly string[], today: string): number;
export async function courseDay(now?: Date): Promise<number>;

export type NewItemKind = 'kana' | 'kanaRule' | 'kanji' | 'core' | 'grammar' | 'staged';
export interface NewItemPlan {
  itemId: string;           // 'kana:あ', 'kanaRule:hira-yoon', 'kanji:水', 'core:cw-0012', 'grammar:wa-desu', staged: 'word:…'|'core:…'
  kind: NewItemKind;
  key: string;
  /** kanji: its anchor word, introduced with it (null for zero-word kanji). */
  anchor?: WordRef | null;
  /** staged: the kanji it belongs to. */
  kanji?: string;
  /** staged core ref that is already an introduced core item: spelling upgrade (adds its read card only). */
  upgrade?: boolean;
  /** Seconds the governor priced it at (PRICE_SEC). */
  priceSec: number;
  /** kana/kanaRule → 'sprint'; staged → 'staged' (outside the 60/20/20 shares); else its own stream. */
  stream: NewStream;
}

export interface CourseSnapshot {
  today: string;
  courseDay: number;
  known: KnownScripts;
  sprint: SprintDay[];
  gates: CourseGates;
  /** Every basic kana and rule of `sprint` is introduced (true when the sprint is empty). */
  sprintComplete: boolean;
  /** Sprint display rules apply (romaji typing on kana-read cards, the romaji helper): sprint content is incomplete,
   *  or it was completed today. False when both scripts are known. */
  inSprint: boolean;
  kana: KanaEntry[];
  rules: KanaRule[];
  curriculum: Curriculum;
  core: CoreWord[];
  grammar: GrammarPoint[];
  /** itemId → day key it was introduced. */
  introduced: ReadonlyMap<string, string>;
  /** Sorted study days before today (for "study days apart" rules). */
  studyDays: readonly string[];
  staged: readonly StagedWordRecord[];
  travel: boolean;
}

export interface StreamCandidates {
  kana: NewItemPlan[];             // sprintPick().kana (≤ 10, oldest sprint day first)
  kanaRule: NewItemPlan | null;    // sprintPick().rule
  kanji: NewItemPlan[];            // up to 4 eligible kanji (lookahead applied), price 160 (+28 with anchor)
  core: NewItemPlan[];             // up to 3 next core words, price 35
  grammar: NewItemPlan | null;     // next eligible point if allowed today, price 200
  /** True when this ISO week has fewer than 2 grammar points (floor): grammar goes ahead of kanji. */
  grammarBelowFloor: boolean;
  staged: NewItemPlan[];           // due releases (releaseDay ≤ today), oldest first, up to 4, price 28
}
/** pure */
export function streamCandidates(s: CourseSnapshot): StreamCandidates;
export async function loadCourseSnapshot(now?: Date): Promise<CourseSnapshot>;

/** Introduces a planned item, its anchor and its staged rows in one rw transaction (rules below). Idempotent: a
 *  second call for the same plan creates nothing and changes no DayRecord counter. */
export async function introducePlanItem(plan: NewItemPlan, now?: Date): Promise<IntroduceResult[]>;

export const PLACEMENT_ITEMS = 20;
export const PLACEMENT_PASS = 18;
export const PLACEMENT_STABILITY_DAYS = 10;
/** pure: 20 random basic kana of the script, seeded. */
export function placementSet(kana: readonly KanaEntry[], script: KanaScript, random?: () => number): KanaEntry[];
/** ≥ 18 correct → 'known': the script's 46 basic kana (read + write) and its two kana-rule items go to Review
 *  (stability 10 d, due spread over 1–10 d, ItemRecord.via 'placement'), and knowsHiragana/knowsKatakana is set.
 *  Otherwise 'sprint' (nothing created). */
export async function applyPlacement(script: KanaScript, correct: number, now?: Date): Promise<'known' | 'sprint'>;

/** The unit of the next grammar point to teach (25 when all are taught; 1 before any). */
export async function currentUnit(now?: Date): Promise<number>;
export interface CourseProgressV2 {
  courseDay: number;
  /** = CourseSnapshot.sprintComplete. */
  sprintDone: boolean;
  kanaIntroduced: number;   // of 92 basic
  kanaTotal: number;        // 92
  kanjiIntroduced: number;
  kanjiTotal: number;       // curriculum units
  coreIntroduced: number;
  grammarIntroduced: number;
  unit: number;
  courseComplete: boolean;  // every stream exhausted
}
export async function courseProgress(now?: Date): Promise<CourseProgressV2>;
/** Next n kanji units not introduced (Library "Next up"). */
export async function nextUnits(n: number): Promise<CurriculumUnit[]>;
```

Candidate rules for `streamCandidates`. Every "study days apart" uses the index distance in `studyDays + [today]`.

- **Sprint.** While `!sprintComplete`: `kana` and `kanaRule` come from `sprintPick` (`priceSec` 53 per kana: a 35-s lesson plus 18 s for its two first-check cards; 150 for a rule). The pick is computed from progress, so a sprint day with only reviews, an anywhere sitting, a micro session or a sitting that stops after the warm-up never loses a row: the next teach step takes the oldest untaught row first. Kana already introduced (re-plan in a later sitting) are left out.
- **Kanji.** Allowed when `courseDay ≥ kanjiFrom`, `sprintComplete`, and not `travel`.
  - Units are taken in index order, not yet introduced.
  - A unit is skipped (lookahead window of 10 units) when a member of its `visual` confusable set was introduced fewer than 5 study days ago.
  - A unit is also skipped when 3 members of its `meaning` set were already introduced today (so at most 3 numbers, or 3 weekdays, on any one day, counting today's earlier sittings and today's plan).
- **Core.** Allowed when `courseDay ≥ coreFrom`. Core words are taken by `order`, not introduced, and not reached by a merge.
- **Grammar.** Allowed when `courseDay ≥ grammarFrom` and not `travel`. The point is allowed today only if no grammar point was introduced today **and** none on the previous study day.
  - Candidate: the first point by `order`, not introduced, with every prerequisite introduced and no `contrastWith` point introduced in the last 5 study days. Lookahead is 3 points.
  - `grammarBelowFloor = (points introduced in today's ISO week, before today) < 2`.
- **Staged.** `StagedWordRecord` rows with `releaseDay ≤ today` and no `releasedAt`, ordered by `releaseDay`. `upgrade = ref is core:… && introduced`.

`introducePlanItem` rules (merge rules from change 2):

| plan.kind | Creates |
|---|---|
| `kana` | item `kana:<c>`; cards read, write |
| `kanaRule` | item; card read |
| `kanji` | item (cards: `write`, plus `meaning` when `anchor === null`) and its anchor (see the anchor rows below); a `StagedWordRecord` for `unit.staged[0]` (`releaseDay = addDays(today, 3)`, calendar days, slot 2) and `unit.staged[1]` (`+8`, slot 3). It is released on the first study day with `releaseDay ≤ today` |
| anchor `word:<id>` | item `word:<id>`; cards read (+ produce when `use`) |
| anchor `core:<id>`, not introduced | item `core:<id>`; cards listen (+ produce when `use`) + read; `spelledAt = now` |
| anchor `core:<id>`, already introduced | **spelling upgrade**: card `read` only, `spelledAt = now`. Never a second item |
| `core` | item; cards listen (+ produce when `use`). Also `read` when the word has a `written` form whose kanji are **all** introduced (`spelledAt = now`) |
| `grammar` | item; cards comprehend (+ build unless `recognitionOnly`) |
| `staged` | same as the anchor rows; `via: 'staged'`; sets the staged row's `releasedAt` |

Accounting, inside the same transaction and **only when the plan's own item was created** (`IntroduceResult.created`): a non-upgrade introduction adds 1 to `DayRecord.newItems`, and the plan adds `priceSec` to `DayRecord.newSec[plan.stream]` (an upgrade adds its price too, since it costs a lesson). A repeated call (StrictMode effect, double tap, a second sitting racing) changes nothing. `newSec.sprint` and `newSec.staged` count toward today's total time but not toward the 60/20/20 shares. A single-kanji word identical to its kanji (水 = みず) is the kanji's anchor: it gets a `word|read` card and never a separate meaning card. That removes the 166 duplicates from v1.

#### 3.1.2 Seconds per card — `src/srs/timing.ts`

```ts
export type TimingKey =
  | 'kanaRead' | 'kanaWrite' | 'kanjiWrite' | 'kanjiMeaning' | 'wordRead'
  | 'produce' | 'listen' | 'comprehend' | 'build' | 'cloze';
export const DEFAULT_SECONDS: Record<TimingKey, number> = {
  kanaRead: 6, kanaWrite: 12, kanjiWrite: 22, kanjiMeaning: 8, wordRead: 11,
  produce: 12, listen: 7, comprehend: 10, build: 18, cloze: 15,
};
export const MEDIAN_WINDOW = 200;      // last N logs of the key
export const MEDIAN_MIN_LOGS = 30;     // below this, the default
export const SECONDS_MIN = 3;
export const SECONDS_MAX = 60;
/** pure: kana|read, kanaRule|read → kanaRead; kana|write → kanaWrite; kanji|write → kanjiWrite;
 *  kanji|meaning → kanjiMeaning; word|read, core|read → wordRead; *|produce → produce; core|listen → listen;
 *  grammar|comprehend → comprehend; grammar|build → build; sentence|cloze → cloze. */
export function timingKeyOf(kind: ItemKind, type: CardType): TimingKey;
/** pure: median of the durations in seconds clamped to 3–60, or null with fewer than 30. */
export function medianSeconds(durationsMs: readonly number[]): number | null;
/** Per-user seconds per key: median of the last 200 logs of that key when ≥ 30, else DEFAULT_SECONDS. */
export async function secondsPerKey(now?: Date): Promise<Record<TimingKey, number>>;
```

`src/srs/days.ts`:

- `emptyDay(date)` returns every v2 field: `studyMs`, `togetherMs`, `reviews`, `correct`, `reviewMs`, `strandMs` and `newItems` at 0; `newSec` with all five streams at 0; `minimumDone` and `goalMet` false; `steps: []`.
- `isStudyDay(d)` = `reviews > 0 || newItems > 0 || studyMs > 0 || togetherMs > 0 || minimumDone`.
- `weekStart`, `addDays`, `daysBetween`, `updateDay` and `countableMs` are kept.
- `progress.ts` `addStudyTime(ms: number, kind: 'lesson' | 'strand' | 'makeup', now?)` (changed signature): every kind adds `countableMs(ms)` (the v1 idle cap, unchanged) to `studyMs`; `strand` also adds it to `strandMs`, `makeup` to `makeupMs`. C reports read, output and fluency time as `strand`.

#### 3.1.3 Time governor and stream balancer — `src/srs/governor.ts` (pure)

```ts
export const MISS_EXTRA_SEC = 8;
export const PRICE_SEC = { kanji: 160, anchor: 28, core: 35, staged: 28, grammar: 200, kana: 53, kanaRule: 150 } as const;
// kana 53 = the plan's 35-s lesson + its first-check cards (read 6 + write 12); other prices already include the check.
export type SharedStream = 'kanji' | 'core' | 'grammar';
export const STREAM_TARGETS: Record<SharedStream, number> = { kanji: 0.6, core: 0.2, grammar: 0.2 };
export const CEILINGS = { kanji: 3, core: 3, staged: 4, grammar: 1 } as const;
export const GRAMMAR_FLOOR_PER_WEEK = 2;
export const RMAX: Record<DailyMinutes, number> = { 20: 6, 25: 8, 30: 9, 40: 10 };
export const WORDS_FOR_RMAX = 1200;
export const FORECAST_FACTOR = 1.12;
export const HARD_CAP_FACTOR = 1.1;
export const SAFETY_CAP_REVIEWS = 400;
export const BRAKE_BELOW = 0.8;
export const EXTRA_KANJI_AT = 0.95;
export const CATCH_UP_STRAND_MIN = 2;
export const CATCH_UP_MARGIN_MIN = 3;

/** R in minutes: d ≤ 14 → 2; d ≤ 60 → 4; until 1,200 known words → 6; then RMAX[budget]; never above RMAX. */
export function strandMinutes(courseDay: number, wordsKnown: number, budget: DailyMinutes): number;

export interface GovDueCard { id: string; key: TimingKey; /** retrievability now */ r: number; /** catch-up tie-break: 2 write-list kanji, 1 'use' word, 0 rest */ value: 0 | 1 | 2 }

/** Rv = Σ s_t + (1 − R_i)(s_t + 8). */
export function reviewSeconds(due: readonly GovDueCard[], sec: Record<TimingKey, number>): number;
/** F7 = (1/7) Σ 1.12 · s_t over cards due in the next 7 days (not due now). */
export function forecastSeconds(upcoming: readonly TimingKey[], sec: Record<TimingKey, number>): number;

/** What earlier sittings already did today (from DayRecord). */
export interface GovToday {
  kanji: number; core: number; staged: number; grammar: number;
  /** DayRecord.newSec: priced seconds already introduced today, all five streams. */
  newSec: StreamSeconds;
  /** DayRecord.reviewMs / 1000: warm-up review time already spent today. */
  reviewSec: number;
  /** DayRecord.strandMs / 1000: read, output and fluency time already spent today. */
  strandSec: number;
  /** DayRecord.catchUp: an earlier sitting ran in catch-up mode (sticky for the day). */
  catchUp: boolean;
}

export interface GovernorInput {
  budgetMin: DailyMinutes;
  courseDay: number;
  gates: CourseGates;
  sprintComplete: boolean;
  wordsKnown: number;
  seconds: Record<TimingKey, number>;
  /** Due now and not yet reviewed today, siblings already resolved, in warm-up order. */
  due: GovDueCard[];
  upcoming: TimingKey[];
  candidates: StreamCandidates;
  /** New-learning seconds per shared stream over the 14 days before today. */
  spent14: Record<SharedStream, number>;
  today: GovToday;
  /** First-try success on Review-state cards (context 'review'), last 3 / 7 study days; null when < 20 reviews. */
  accuracy3: number | null;
  accuracy7: number | null;
  /** Actual study time: mean DayRecord.studyMs over the last 7 study days before today ≤ budgetMin · 60 000. */
  underBudget7: boolean;
  /** The previous study day ran in catch-up mode, or a fresh start is active (Settings.freshStart ≤ today). */
  catchUpBefore: boolean;
  travel: boolean;
  /** The learner accepted "Add one more kanji today?". */
  extraKanji: boolean;
}

export interface GovernorOutput {
  mode: 'sprint' | 'normal' | 'catch-up' | 'travel';
  strandMin: number;
  /** In input (warm-up) order, also in catch-up: the governor chooses the subset, never the order. */
  reviews: string[];
  newItems: NewItemPlan[];
  seconds: {
    /** Remaining warm-up seconds (truncated in catch-up). */
    reviews: number;
    forecast7: number;
    newRoom: number;
    newPlanned: number;
    /** Remaining strand seconds: max(0, 60·strandMin − today.strandSec). */
    strands: number;
    /** today.reviewSec + today.strandSec + Σ today.newSec. */
    doneToday: number;
    /** Remaining: reviews + newPlanned + strands. "About N min (left) today" = ceil(total / 60). */
    total: number;
    /** doneToday + total. */
    dayTotal: number;
  };
  brake: boolean;
  offerExtraKanji: boolean;
}
export function govern(input: GovernorInput): GovernorOutput;
```

Algorithm. `B = budgetMin·60`, `R = strandMinutes(…)`, `LF = B − 60R`, `Rv = reviewSeconds(due)` (still due), `RvDay = Rv + today.reviewSec` (today's whole review load), `NewDone = Σ today.newSec` (all five streams), `StrandDay = max(60R, today.strandSec)`, `F7 = forecastSeconds(upcoming)`. Every sitting re-plans with these, so a day split into sittings has the same budget as one sitting.

1. **Travel.** `mode 'travel'`, no new items, reviews in order (they are optional), `strandMin 0`.
2. **Sprint**, when `courseDay < gates.governorFrom` or `!sprintComplete`. Fixed and never throttled:
   - all of `candidates.kana` and `kanaRule`;
   - core words up to `3 − today.core`, when `courseDay ≥ coreFrom`;
   - the grammar candidate, if any, unless `RvDay + NewDone + Σprices + 60R > 1.1·B` (then grammar waits).
   - Reviews: all due, capped at 400.
3. **Catch-up** (only after the sprint) is entered when `RvDay > B`, or `catchUpBefore && RvDay > LF` (hysteresis: leave only when the load is ≤ LF), or `today.catchUp` (once a sitting ran in catch-up, the rest of the day stays in catch-up and adds no new items).
   - No new items; `strandMin = 2`.
   - The subset: cards ranked by `r` ascending, ties by `value` descending then input order, taken while the running `Σ s_t + (1 − r)(s_t + 8) ≤ max(0, (budgetMin − 3)·60 − today.reviewSec)`. The chosen cards are then output **in input (warm-up) order**, so `orderWarmup`'s sibling spacing (≥ 10 apart) survives.
   - The rest stay due. `seconds.total = chosen Rv + max(0, 120 − today.strandSec)`.
4. **Normal.**
   - `NewRoom = LF − max(RvDay, F7) − 60 − NewDone − max(0, today.strandSec − 60R)`.
   - If `accuracy3 !== null && accuracy3 < 0.8`: `NewRoom *= 0.5` and `brake = true` (only when NewRoom > 0).
   - Hard cap: `NewRoom = min(NewRoom, 1.1·B − RvDay − StrandDay − NewDone)`.
   - Strand squeeze: when `RvDay + NewDone + 60R > 1.1·B` (so `NewRoom ≤ 0`), the strand reserve shrinks to `max(2, floor((1.1·B − RvDay − NewDone) / 60))` minutes. The projected day total therefore stays ≤ 1.1·B unless `RvDay > B`, and then catch-up applies.
   - Fill in this order, adding an item only when its price fits the room left:
     1. Staged releases, up to `4 − today.staged` (stream `staged`).
     2. If `grammarBelowFloor` and there is a grammar candidate: grammar first.
     3. **Deficit round-robin** over kanji, core and grammar.
        - `share_k = (spent14_k + today.newSec_k + planned_k) / Σ` over the three shared streams only, using 1 when Σ = 0; `deficit_k = target_k − share_k`.
        - Repeat: take the eligible stream with the largest deficit and add its **next** item in curriculum order (a kanji with anchor costs 188 s, a zero-word kanji 160 s; a grammar lesson 200 s; a core word 35 s). If that item does not fit, the stream is **closed for the rest of the fill** and the next stream is tried. This guarantees termination and keeps curriculum order (a later, cheaper zero-word kanji never jumps ahead).
        - Eligible: open, under its ceiling (kanji 3, or 4 with `extraKanji`; core 3; grammar 1, counting today) and a candidate left.
        - Stop when no stream can add.
   - `extraKanji` raises the kanji ceiling to 4; the extra kanji still has to fit the room and the hard cap. It never pushes the day above 1.1·B.
   - `offerExtraKanji = !extraKanji && accuracy7 ≥ 0.95 && underBudget7 && a kanji candidate is left && dayTotal + 188 ≤ 1.1·B`.
   - Reviews: all due, capped at 400, in input order.
5. `seconds.total = Rv(shown) + newPlanned + max(0, 60·strandMin − today.strandSec)`; `seconds.dayTotal = doneToday + total`. The UI shows `ceil(total / 60)` as "About N min today", or "About N min left today" when `doneToday > 0`.

Reference checks, which are unit tests (§5.1):

- Day 20, 25 min, nothing due: `LF = 1260`, so `NewRoom = 1200`. The plan is 3 kanji with anchors (564) + 3 core (105) + 1 grammar (200) + staged (≤112) = at most 981 s; total ≤ 16.4 + 4 = 20.4 min ≤ 27.5, with ≥ 1 kanji.
- `Rv = 1600 s` at 25 min (> 1500): catch-up, 0 new, reviews within 1320 s chosen by `r` and output in warm-up order.
- Split day at 25 min (R = 4): morning sitting `Rv = 1200`, `F7 = 500` → `NewRoom = 1260 − 1200 − 60 = 0`. Evening re-plan with `today.reviewSec = 1200`, `Rv = 0` → `NewRoom = 1260 − max(1200, 500) − 60 = 0`, so the day stays at about 24 min (without `today.reviewSec` it would have planned 700 s more, 35.7 min).

#### 3.1.4 Card model — `src/srs/items.ts`

```ts
export interface CardTypeContext {
  /** kanji: no taught word (51 kanji) → add 'meaning'. */
  zeroWord?: boolean;
  /** word/core: produce card. */
  use?: boolean;
  /** core: spelled with kanji (read card). */
  spelled?: boolean;
  /** grammar: comprehend only. */
  recognitionOnly?: boolean;
}
/** pure */
export function cardTypesFor(kind: ItemKind, key: string, ctx?: CardTypeContext): CardType[];
export function countsAsNew(kind: ItemKind): boolean;      // false for 'sentence'
export interface IntroduceResult { item: ItemRecord; cards: CardRecord[]; created: boolean }
export async function introduceItem(kind: ItemKind, key: string, now?: Date, opts?: { ctx?: CardTypeContext; via?: ItemRecord['via'] }): Promise<IntroduceResult>;
/** core spelling upgrade: adds the read card (idempotent) and sets spelledAt. */
export async function upgradeSpelling(coreId: string, now?: Date): Promise<IntroduceResult>;
export interface ItemRef2 { kind: ItemKind; key: string }
/** Placement: introduce and move to Review with the given stability, due spread over 1..stabilityDays. */
export async function markKnownMany(refs: readonly ItemRef2[], now?: Date, stabilityDays?: number): Promise<void>;
export const RETIRE_STABILITY_DAYS = 21;
/** pure: rank > writeList && !pinned && stability > 21. */
export function shouldRetire(card: Pick<CardRecord, 'stability' | 'type' | 'kind'>, rank: number, writeList: number, pinned: boolean): boolean;
/** Retires (suspended 'retired') or un-retires every kanji write card for the current writeList and pins. Returns changes. */
export async function syncWriteRetirement(now?: Date): Promise<{ retired: number; restored: number }>;
export async function setPinned(char: string, pinned: boolean): Promise<void>;
export async function isIntroduced(id: string): Promise<boolean>;
```

| Item | Card | Prompt → answer (C renders) | Default mode | Grade function | Preset / family / key |
|---|---|---|---|---|---|
| kana | read | While `inSprint`: kana → type romaji (`romajiMatches`; romaji is the typing method only). Later: the kana inside a short real word (`kana-examples`, clip `kanaEx:<c>`) → type the word's reading (IME, `kanaMatches`) | typed | `gradeFor` | receptive / read / kanaRead |
| kana | write | During the sprint: audio of the sound only (auto-play plus a replay button; **no romaji label**). After it: the kana's example word with the kana as □ plus its English (`□さ · umbrella`) and the word's audio. Handwrite on the recall pad | written | `gradeForRecallWriting` | production / write / kanaWrite |
| kanaRule | read | `practiceWords[(reps) % 8]` → type its reading | typed | `gradeFor` | receptive / read / kanaRead |
| kanji | write | Keyword + anchor with the kanji as □ + anchor kana + audio button (`day · □本 にほん`). Zero-word kanji: keyword + first kun (or on) reading. Recall-mode handwriting with a finger or stylus; "write on paper" self-check (hidden in an anywhere sitting) | written / paper | `gradeForRecallWriting` (paper: `selfGrade`, max Good) | production / write / kanjiWrite |
| kanji | meaning (zero-word only) | kanji → recall the meaning → reveal | self | `selfGrade` | receptive / read / kanjiMeaning |
| word | read | The word inside a known carrier phrase when `exampleSentenceFor` finds one, else alone → type the reading (IME) → reveal meaning, audio, pitch line → "Knew the meaning?" | typed | `gradeWordRead`; logs `parts` | receptive / read / wordRead |
| word | produce (`use`) | English + context note → type kana, or speak | typed / spoken | `gradeFor` (spoken failed twice → "I said it" `selfGrade` capped Hard) | production / produce / produce |
| core | listen | Audio plays, text hidden → reveal kana/written + meaning | self | `selfGrade` | receptive / listen / listen |
| core | produce (`use`) | English + note (register, e.g. "to your partner, casual") → type or speak | typed / spoken | `gradeFor` | production / produce / produce |
| core | read (spelled) | Same as word read, showing the kanji spelling | typed | `gradeWordRead` | receptive / read / wordRead |
| grammar | comprehend | `examples[(3 + reps) % n]` with audio (examples 0–2 belong to the lesson) → recall the meaning → reveal | self | `selfGrade` | receptive / grammar / comprehend |
| grammar | build | English → tiles while < 60 grammar points are introduced, then typed (IME) against `answers` | typed | `gradeFor` | production / grammar / build |
| sentence | cloze | Sentence with `blank` as ＿＿ + English → type the blank's reading | typed | `gradeFor` | production / produce / cloze |

Card rules:

- **Rotation.** The comprehend example index `(3 + reps) % n` never repeats either of the last 2 shown when n ≥ 3. Content guarantees n ≥ 8.
- **Multiple choice** appears only in two places.
  - The "Show options" hint on a typed card: 4 options from `choicesFrom`; a correct pick is Hard, a wrong pick Again.
  - `Settings.handsBusy`: typed cards render options up front, log `mode: 'choice'` and cap at Hard.
  - Lesson taps are never graded.
- **Retirement.** A kanji write card retires (`suspended: 'retired'`, never deleted) when `rank > writeList`, the item isn't `pinned`, and stability > 21 d. It is restored when `writeList` grows or the kanji is pinned. Recognition continues through the kanji's word cards. `syncWriteRetirement` runs in `startSitting` and after a Settings change.
- **Merge.** One identity per word (§3.6.3). A core anchor or staged ref that is already introduced becomes a spelling upgrade (1 new card). Test: introducing 元気's kanji after 元気 is known as a core word creates exactly 1 card (`core:<id>|read`).

#### 3.1.5 Scheduler — `src/srs/scheduler.ts`

```ts
/** pure: write, produce, build, cloze → 'production'; read, meaning, listen, comprehend → 'receptive'. */
export function presetOf(type: CardType): FsrsPreset;
/** pure: production → PRODUCTION_RETENTION (0.9); receptive → normalizeRetention(settings.receptiveRetention). */
export function retentionFor(preset: FsrsPreset, settings: Pick<Settings, 'receptiveRetention'>): number;
/** Memoized per (retention, weights). enable_fuzz true, maximum_interval 36500, learning_steps ['1m','10m'],
 *  relearning_steps ['10m'] (ts-fsrs defaults). Throws RangeError when retention > 0.95 or < 0.7. */
export function getScheduler(retention: number, weights?: readonly number[]): FSRS;
export function newCardRecord(itemId: string, kind: ItemKind, type: CardType, now?: Date): CardRecord;
export interface GradeOptions {
  durationMs: number;
  mode: AnswerMode;
  context?: ReviewContext;                 // default 'review'
  parts?: ReviewLogRecord['parts'];
  input?: ReviewLogRecord['input'];
  override?: boolean;
  surprise?: boolean;
  /** Answered inside a make-up session (§3.1.11): its time goes to DayRecord.makeupMs, not reviewMs. */
  makeup?: boolean;
  now?: Date;
}
export const MAX_COUNTED_ANSWER_MS = 120_000;
/** One rw transaction over [cards, reviewLogs, days, settings, items] (it joins an enclosing transaction that covers
 *  those tables): FSRS next() with the card's preset retention (and Settings.fsrsWeights[preset]), appends the full
 *  ReviewLogRecord (kind, type, elapsedDays = whole days since last_review, context), updates DayRecord:
 *  reviews +1, correct +(grade > 1), studyMs += min(durationMs, 2 min); the same amount goes to reviewMs for
 *  contexts 'review' and 're-ask', or to makeupMs when opts.makeup. Partner mode adds no study time (the together
 *  session accounts for it). */
export async function gradeCard(id: string, grade: Grade, opts: GradeOptions): Promise<CardRecord>;
export function previewDue(card: CardRecord, now?: Date, retention?: number): Record<1 | 2 | 3 | 4, Date>;
/** pure: 1 for New cards, else ts-fsrs get_retrievability(card, now, false) at the card's preset retention. */
export function retrievability(card: CardRecord, now: Date): number;
export const PARTNER_GRADE: Record<QuizVerdict, Grade>;        // right → Good, close → Hard, wrong → Again
export const PARTNER_WINDOW_DAYS = 2;
/** pure: |due − now| ≤ 2 days, not suspended, not New. */
export function inPartnerWindow(card: CardRecord, now: Date): boolean;
```

`scheduler.test.ts` locks in the observed ts-fsrs 5.4.2 behaviour:

- New + Good → Learning, due +10 min.
- Next day + Good → Review, interval ≥ 1 day.
- Again on Review → Relearning +10 min; a re-ask Good → Review.

#### 3.1.6 Answers and grades — `src/srs/answers.ts`, `src/srs/romaji.ts`

```ts
export interface AnswerOutcome { correct: boolean; usedHint?: boolean; retries?: number; /** 'Show options' or hands-busy */ choice?: boolean }
/** wrong → Again; right with choice, hint or retry → Hard; right first try → Good. Never Easy. */
export function gradeFor(o: AnswerOutcome): Grade;
/** Missed → Again, Got it → Good. */
export function selfGrade(gotIt: boolean): Grade;
/** Again if the reading is wrong or the meaning was unknown; Hard after a retry, hint or choice; else Good. */
export function gradeWordRead(o: { readingCorrect: boolean; retries: number; usedHint?: boolean; choice?: boolean; knewMeaning: boolean }): Grade;
export interface RecallWritingOutcome {
  strokeCount: number;
  missing: number;      // expected strokes not drawn
  extra: number;        // drawn strokes matching nothing
  unmatched: number;    // expected strokes drawn badly
  hintUsed: boolean;
  /** 'I wrote it right' after an Again. */
  override?: boolean;
}
/** override → Hard. Again: missing + extra ≥ 1, or unmatched ≥ 2, or unmatched = 1 with ≤ 6 strokes.
 *  Hard: unmatched = 1 with ≥ 7 strokes, or a hint. Good otherwise. Stroke order never affects it. */
export function gradeForRecallWriting(o: RecallWritingOutcome): Grade;
/** Typed sentence (grammar build, cloze): input converted with toKana, compared with kanaKey against each accepted hiragana answer. */
export function sentenceMatches(input: string, accepted: readonly string[]): boolean;
/** prev was Good, prev.durationMs < 0.6 × medianMs, and now Again. */
export function isSurpriseMiss(prev: Pick<ReviewLogRecord, 'grade' | 'durationMs'> | undefined, medianMs: number, grade: Grade): boolean;
export const OVERRIDE_TIP_SHARE = 0.1;
/** ≥ 20 write logs and overrides / write logs > 10 %: show the calibration tip. */
export function needsCalibrationTip(writeLogs: readonly Pick<ReviewLogRecord, 'override'>[]): boolean;
// kept: normalizeKana, romajiMatches, kanaMatches, meaningMatches, slipCount, choicesFrom, shuffle, seededRandom, gradeForWriting (free practice only)

// romaji.ts — in-field IME
/** Live conversion while typing: complete syllables become kana, an unfinished tail stays as letters
 *  ('kit' → 'きt'); "n'" and "nn" → ん; a doubled consonant → っ ('kitte' → 'きって'). Katakana with opts.katakana. */
export function imeConvert(raw: string, opts?: { katakana?: boolean }): string;
// kept: toKana, toHiragana, toKatakana
```

Accepted typed readings come from `WordInfo.readings` (kana plus `altKana`, which includes the おう/おお and えい/ええ variants), and `kanaMatches` folds hiragana and katakana together.

#### 3.1.7 Planner, sittings, warm-up order, siblings, leak guard — `src/srs/planner.ts`

```ts
export type Sitting = 'any' | 'anywhere' | 'desk';
/** planToday returns sprint | normal | catch-up | travel. micro, welcome-back and makeup come only from planMicro / planMakeup. */
export type DayMode = 'sprint' | 'normal' | 'catch-up' | 'travel' | 'micro' | 'welcome-back' | 'makeup';

export interface TeachBatch { items: NewItemPlan[] }
export interface ReadPlan {
  kind: 'kana-words' | 'kana-check' | 'sentences' | 'story';
  /** Sprint: 2–3 real words per kana lesson, made only of taught kana (kana-examples + rule practice words), each
   *  with its clip ref ('kanaEx:<c>' or 'kanaRule:<id>#<n>'). kana-check: KanaRule.checkWords (refs 'core:<id>'). */
  kanaWords: { kana: string; en: string; ref: string }[];
  sentences: { id: string; target: WordRef }[];
  story?: { storyId: string; step: 'rwl' | 'listen'; shared: boolean };
  /** Planned minutes (≤ the read-block minutes; a sentence ≈ 1 min, a story its clip length / rate + 1 min). */
  minutes: number;
}
export interface OutputPlan { target: OutputTarget }
export interface FluencyPlan { kind: FluencyKind; storyId?: string; cardIds?: string[] }

export interface DayPlan {
  day: string;
  courseDay: number;
  mode: DayMode;
  sitting: Sitting;
  budgetMin: DailyMinutes;
  /** "About N min (left) today": ceil(GovernorOutput.seconds.total / 60). */
  estimateMin: number;
  /** An earlier sitting already did something today: the UI says "left today". */
  partOfDayDone: boolean;
  /** "tomorrow about M": cards due by tomorrow's rollover + 7-day mean new seconds + R. */
  tomorrowMin: number;
  strandMin: number;
  /** Due cards not yet reviewed today (never New, never of items introduced today), in warm-up order. */
  warmup: string[];
  /** Siblings to bury until the next study day; applied by startSitting. */
  bury: string[];
  /** Only items not yet introduced today; batches of today's earlier sittings are never repeated. */
  teach: TeachBatch[];
  /** Every New card (reps 0, not suspended): today's earlier sittings, upgrades, or never checked. First-checked this sitting. */
  pendingCheck: string[];
  read: ReadPlan | null;
  output: OutputPlan | null;
  fluency: FluencyPlan | null;
  /** DayRecord.steps: once-a-day steps already finished. */
  doneSteps: DailyStepId[];
  /** For display. Undefined during catch-up: never show a card count then. */
  counts?: { reviews: number; newItems: number };
  brake: boolean;
  offerExtraKanji: boolean;
  /** "Write on paper" is offered (false in an anywhere sitting). */
  paperAllowed: boolean;
  courseComplete: boolean;
}

/** Read-only. Re-runs at the start of every sitting (Session) and on Today. */
export async function planToday(now?: Date, opts?: { sitting?: Sitting; extraKanji?: boolean }): Promise<DayPlan>;
/** Side effects at sitting start, all idempotent: bury (due = max(due, nextStudyDayStart(now)), an absolute target, so a
 *  second call changes nothing), syncWriteRetirement, DayRecord.catchUp = true when plan.mode is 'catch-up' (never reset
 *  to false within the day), and Settings.freshStart cleared when plan.mode is 'normal' on or after that date. */
export async function startSitting(plan: DayPlan, now?: Date): Promise<void>;
export const MICRO_SECONDS = 180;
/** 3-minute plan, only when the learner asks (Today's micro link or the welcome-back offer): most overdue (lowest r)
 *  non-write cards, truncated to 180 s; no new items, no reading, no output. */
export async function planMicro(now?: Date, opts?: { welcomeBack?: boolean }): Promise<DayPlan>;
export const MAKEUP_SECONDS = 600;
/** Make-up session for a streak repair (§3.1.11), offered once today's goal is met: review-ahead of cards due before
 *  the next rollover + 24 h (lowest r first, siblings and today's items excluded), then sentence reading (resting rule
 *  ignored) and, when eligible, a speed round. About 600 s; graded answers carry `makeup: true`. */
export async function planMakeup(now?: Date): Promise<DayPlan>;
/** Records a once-a-day step in DayRecord.steps (set-add; a second call is a no-op). */
export async function finishStep(step: DailyStepId, now?: Date): Promise<void>;

export interface WarmupCard {
  id: string;
  itemId: string;
  type: CardType;
  state: State;
  r: number;
  due: Date;
  /** Day key the card's item was introduced. */
  introducedDay: string;
  groups: string[];
  value: 0 | 1 | 2;
}
/** pure: sibling groups of a card: `item:<itemId>`; kanji write → `k:<char>`; word/core cards → `k:<c>` for each kanji c of the word. */
export function siblingGroups(card: Pick<CardRecord, 'itemId' | 'kind' | 'type'>, wordKanji: readonly string[]): string[];
/** pure. Order: Learning/Relearning cards introduced yesterday (by due), other Learning/Relearning (by due),
 *  then Review by ascending r (ties: value desc, due asc). Not catch-up: a card whose group is in
 *  takenGroups (reviewed earlier today) or already taken in this order is buried. Catch-up: nothing is
 *  buried; cards sharing a group are kept ≥ 10 positions apart when possible (greedy deferral). */
export function orderWarmup(cards: readonly WarmupCard[], opts: { yesterday: string | null; takenGroups: ReadonlySet<string>; catchUp: boolean }): { order: string[]; bury: string[] };

export interface LeakMask {
  /** Item ids whose reading must not be shown (their read card is due today, unanswered). */
  readings: Set<string>;
  /** Item ids whose meaning must not be shown (listen/meaning/comprehend due, unanswered). */
  meanings: Set<string>;
  /** Kanji whose written form must not be shown (write card due, unanswered). */
  kanji: Set<string>;
}
/** Cards due before the next 4 a.m. rollover and not reviewed today. */
export async function leakMask(now?: Date): Promise<LeakMask>;
export function nextStudyDayStart(now: Date): Date;   // kept
```

How `planToday` builds the plan:

1. **Inputs.** Load settings, today's `DayRecord`, `courseDay`, `loadCourseSnapshot`, `secondsPerKey`, `travel = travelUntil ≥ today`, `freshStartActive = freshStart ≤ today`.
2. **Card routing.**
   - **Warm-up candidates:** not suspended, state ≠ New, `due ≤ now`, the item **not introduced today**. A card already reviewed today is no longer due, except a relearning card after a miss; its group is in `takenGroups`, so it is buried. So the warm-up is always "due cards not yet reviewed today", whatever earlier sittings did. It never depends on `doneSteps`.
   - **`pendingCheck`:** every New card (reps 0, not suspended), whatever day its item was introduced. That includes a spelling-upgrade read card created today for a core word introduced earlier. New cards never enter the warm-up.
3. **Order.** `orderWarmup` takes `takenGroups` from today's review logs.
4. **Sitting filter.**
   - `anywhere`: the **whole** warm-up, write cards included (handwriting is a finger on the phone's recall pad; `paperAllowed = false` hides "write on paper"). Teach, check, read, output and fluency are all null.
   - `desk` and `any`: the full plan. A desk sitting after an anywhere sitting simply has whatever warm-up cards are still due (usually none or a few that became due since).
   - Teach plans only items not yet introduced (the governor's room already subtracts what earlier sittings introduced and reviewed). Check holds `pendingCheck`. Read, output and fluency are null when they are in `doneSteps`.
5. **Governor.** Call `govern` with `today` from the DayRecord (§3.1.3), then batch the new items:
   - sprint kana in batches of 5 (oldest row first);
   - a rule lesson as its own batch, after the rows;
   - otherwise up to 4 items per batch in this order: kanji (each with its anchor), staged, core, grammar (grammar always last in its batch).
6. **Read block.**
   - While `inSprint`: `kana-words` (from taught kana only), plus sentences when `pickIPlusOne` finds kana-only ones (from about day 5). On the day the sprint completes (today's teach holds the last sprint items, or `sprintComplete` became true today) and milestone `kana-check` is not recorded: `kana-check` instead.
   - After the sprint: `pickRead({ minutes })` (§3.1.9) with `minutes = strandMin − (output ? 1 : 0) − (fluency ? 2 : 0)`. pickRead never plans more than those minutes. At 25 min the read block is 3 min on every day 15–60 (R = 4, no fluency slot yet) and ≥ 3 min once fluency starts (R ≥ 6).
7. **Output.** Only when the sprint is over (`sprintComplete && courseDay ≥ gates.kanjiFrom`), the sitting isn't `anywhere`, `output` isn't in `doneSteps`, and `pickOutputTarget` returns a target.
8. **Fluency.** `pickFluency` (§3.1.12): null before `strandMin ≥ 6`, on Sundays, in catch-up, travel, micro and make-up plans, and whenever `strandMin − 1 − 2 < 3`.
9. **Display.** `estimateMin = ceil(total / 60)`; `partOfDayDone = doneToday > 0`. `counts` is set except in catch-up mode.

`planToday` never returns `micro` or `welcome-back`: a missed day does not replace the full plan. The welcome-back is `planMicro({ welcomeBack: true })`, run only when the learner taps the offer (it has no handwriting).

**Steps and reloads.** Warm-up, teach, memory and check are content-driven, so a reload or a later sitting continues correctly without step records: teach resumes with the items not yet introduced, and the check holds every New card. `finishStep` is called only for `read`, `output` and `fluency`. Accepted losses on a reload in the middle of a sitting: the memory pass of a batch that was taught but not yet memory-passed (ungraded), the session's retrieval counters and pending re-asks. None of these can break the day-0 cap: after a reload, already-checked cards are no longer New (so not in the check) and belong to today's items (so not in the warm-up), and a warm-up card missed before the reload is in a taken group (so buried).

**Goal met.** `completeDay` (§3.1.11) is called when a sitting with `sitting !== 'anywhere'` and mode sprint/normal/catch-up/travel has finished every one of its steps. It is idempotent.

#### 3.1.8 Encounters — `src/srs/encounters.ts`

```ts
export const ENCOUNTER_TARGET = 8;
export const ENCOUNTER_WINDOW_DAYS = 42;
/** Logs one row per (item, day, source) for introduced items only; returns rows written. */
export async function logEncounters(itemIds: readonly string[], source: EncounterSource, now?: Date): Promise<number>;
/** Encounters in the last 42 days per item (all items when itemIds is omitted). */
export async function encounterCounts(itemIds?: readonly string[], now?: Date): Promise<Map<string, number>>;
```

Sources and when C/E call it:

- `sentence`: every ref of a study sentence after it is shown.
- `story`: every ref of a story after a ladder step.
- `output`: the target, after a send.
- `partner`: a partner-quiz item outside the grading window.
- `fluency`: re-read refs.

#### 3.1.9 Read & listen selection, coverage, furigana — `src/srs/readListen.ts`, `src/lib/hooks.ts`

```ts
export interface KnownWords {
  /** Introduced, and its read card (word, spelled core) or listen card (core) has a log with grade ≥ 2. */
  isKnown(ref: string): boolean;
  /** Day key introduced, if introduced. */
  introducedDay(ref: string): string | undefined;
}
export async function loadKnownWords(now?: Date): Promise<KnownWords>;
export const EASY_COVERAGE = 0.98;
export const STRETCH_COVERAGE = 0.95;
/** pure: content = tokens with k === 'c' and not name; known = those with a ref that isKnown; ratio = known/content (1 when content = 0). */
export function coverage(tokens: readonly PreToken[], isKnown: (ref: string) => boolean): { content: number; known: number; ratio: number };
export function storyCoverage(story: StoryEntry, isKnown: (ref: string) => boolean): number;

export interface IPlusOneContext {
  known: KnownWords;
  grammarKnown: ReadonlySet<string>;
  today: string;
  encounters: ReadonlyMap<string, number>;
  /** Shown in the last 7 days. */
  resting: ReadonlySet<string>;
}
export interface PickedSentence { id: string; target: WordRef }
/** pure. A sentence qualifies when: not resting; every grammar tag is introduced; every content token (non-name) has a ref;
 *  exactly one target is chosen among its refs introduced 1–21 days ago (the one with the fewest encounters);
 *  every other content ref is known. Ranking: target encounters < 8 first (ascending), then file order.
 *  Distinct targets across the picks. */
export function pickIPlusOne(sentences: readonly SentenceEntry[], ctx: IPlusOneContext, n: number): PickedSentence[];
/** A known sentence that contains the ref and whose other words are known (carrier phrase / feedback example). */
export function exampleSentenceFor(ref: string, sentences: readonly SentenceEntry[], known: KnownWords): SentenceEntry | undefined;

export const STORY_LADDER = { listen: 3, reread: 10 } as const;
export interface StoryPick { storyId: string; step: 'rwl' | 'listen'; shared: boolean }
/** pure. Priority: (1) a 'listen' step due (stage 1, nextDay ≤ today); (2) the shared weekly story at stage 0
 *  with coverage ≥ 0.98; (3) a stage-0 story with coverage ≥ 0.98, by level (start, L0, L1), unit, id. Never below 0.98. */
export function pickStory(stories: readonly StoryEntry[], ctx: { isKnown: (ref: string) => boolean; progress: ReadonlyMap<string, StoryProgressRecord>; today: string; sharedStoryId?: string }): StoryPick | null;
/** pure: coverage in [0.95, 0.98) — offered in the Library with tap glosses. */
export function stretchStories(stories: readonly StoryEntry[], isKnown: (ref: string) => boolean): StoryEntry[];
/** Stories at ≥ 98 % for this learner (MemberProgress.readyStories, max 60). */
export async function readyStoryIds(now?: Date): Promise<string[]>;
/** Advances the ladder: rwl → stage 1 (firstDay = today, nextDay = firstDay + 3), listen → stage 2 (nextDay =
 *  firstDay + 10), reread → stage 3; logs story encounters. Idempotent per (story, step, day). */
export async function recordStoryStep(storyId: string, step: 'rwl' | 'listen' | 'reread', result: { gistCorrect?: boolean; cpm?: number }, now?: Date): Promise<void>;
/** Fits the plan into `minutes` (never more): a story when one qualifies and its estimate (Σ clip ms / rate / 60 000
 *  + 1 min for the gist, at least 2) fits, then sentences (≈ 1 min each) in the minutes left, at most 1 with a story;
 *  without a story, min(floor(minutes), courseDay ≤ 60 ? 2 : 3) sentences (at least 1). ReadPlan.minutes = the estimate. */
export async function pickRead(opts: { minutes: number; sharedStoryId?: string }, now?: Date): Promise<ReadPlan>;
export async function markSentencesShown(ids: readonly string[], now?: Date): Promise<void>;
export async function resetReadingMemory(): Promise<void>;
```

Furigana (in `src/lib/hooks.ts`; B):

```ts
export const MATURE_STABILITY_DAYS = 21;
export interface FuriganaPolicy {
  /** Tokens: show the reading over a kanji-bearing token unless its ref's read card is mature. Names: always. */
  forRef(ref: string | undefined, hasKanji: boolean, isName?: boolean): boolean;
  /** Ruby text: exact `${written}|${kana}` of a mature word hides it; also a mature word whose written starts with
   *  base and whose kana starts with reading (okurigana: {食|た}べる). Otherwise shown. */
  forRuby(base: string, reading: string): boolean;
}
/** pure: settings 'always' → always true; 'never' → false; 'unknown' → per maturity sets. */
export function furiganaPolicy(furigana: Settings['furigana'], matureRefs: ReadonlySet<string>, matureKeys: ReadonlySet<string>): FuriganaPolicy;
/** Live (read cards of word/core items with stability ≥ 21 d). Each partner's phone has its own cards, so the two see different furigana. */
export function useFuriganaPolicy(): FuriganaPolicy;
/** For <Ruby show>: (base, reading) => policy.forRuby(base, reading). */
export function useRubyShow(): 'all' | 'none' | ((base: string, reading?: string) => boolean);
/** Deliberate cards and the first check: a reading only for words containing a kanji the learner has not been introduced to. */
export function useCardRubyShow(): (base: string, reading?: string) => boolean;
// kept: useSettings, useSettingsLoaded, useKnownKanji
```

#### 3.1.10 Output target and card guard — `src/srs/output.ts`, `src/srs/sentenceGuard.ts`

```ts
// output.ts
/** null until the sprint is over (sprintComplete && courseDay ≥ kanjiFrom). Every 3rd study day: a grammar point introduced 1–14 days ago (not recognitionOnly);
 *  otherwise a word introduced 1–7 days ago with use = true (core or JMdict), fewest 'output' encounters first.
 *  The label is the word as the learner knows it (kana until spelled) or the grammar pattern. */
export async function pickOutputTarget(now?: Date): Promise<OutputTarget | null>;
export async function saveOutput(rec: Omit<OutputSentenceRecord, 'id' | 'createdAt'>, now?: Date): Promise<OutputSentenceRecord>;
/** Checks still waiting for the AI (check 'pending'), oldest first. F's sync retries them when the server is reachable. */
export async function pendingOutputChecks(): Promise<OutputSentenceRecord[]>;
/** Stores the reveal result; runs the guard; on success creates the cloze card and returns its id. */
export async function completeOutputCheck(id: string, result: AiCheckResponse, now?: Date): Promise<{ cardId?: string }>;
/** The learner's AI context (known kanji, grammar ids, known words as written, register 'plain'). */
export async function learnerAiContext(now?: Date): Promise<AiLearnerContext>;

// sentenceGuard.ts
export interface GrammarMarker { id: string; pattern: RegExp }
/** ~20 rule-based markers (ids are grammar-v2 ids): passive, causative, ba-conditional, tara-conditional, nara,
 *  temo-even-if, sou-looks, sou-hearsay, you-da, te-shimau (ちゃう/じゃう), te-oku (とく), te-miru, nagara,
 *  tsumori, kamoshirenai, nakereba-naranai, potential-form, volitional, tari-tari, sugiru. */
export const GRAMMAR_MARKERS: readonly GrammarMarker[];
/** Particles, copula and auxiliary forms counted as resolved without a dictionary entry. */
export const FUNCTION_WORDS: ReadonlySet<string>;
export interface GuardInput { corrected: string; en: string; words: readonly AiWord[]; grammarUsed: readonly string[]; target?: string }
export interface GuardContext {
  /** Resolves a lemma or surface (written or kana) to a core/JMdict ref. */
  lookup(form: string): WordRef | undefined;
  known: KnownWords;
  grammarKnown: ReadonlySet<string>;
}
export interface GuardResult { ok: boolean; reasons: string[]; blank?: SavedSentenceRecord['blank'] }
/** pure. The AI's word list is never trusted on its own. ok only when all of these hold:
 *  1. Coverage: the AiWord surfaces, in order, plus punctuation/spaces and FUNCTION_WORDS between them, concatenate
 *     exactly to rubyPlain(corrected) (NFKC). A token the model left out of `words` fails this check.
 *  2. Dictionary: every content surface resolves through lookup(surface) or lookup(lemma) to a core/JMdict ref
 *     (or is a FUNCTION_WORDS entry), and that ref is introduced.
 *  3. Grammar: GRAMMAR_MARKERS are run on `corrected` itself, independently of the AI; every match must be introduced.
 *  4. grammarUsed is only an extra fail signal: any id not introduced, or 'other', fails; it can never make a sentence pass.
 *  blank = the target word when present, else the first known content word introduced in the last 21 days, else the
 *  first known word. */
export function guardSentence(input: GuardInput, ctx: GuardContext): GuardResult;
/** Guard + SavedSentenceRecord + introduce 'sentence' item (cloze). Uncorrected learner text never becomes a card. */
export async function createGuardedCloze(input: GuardInput, source: 'correction' | 'recap', now?: Date): Promise<string | null>;
```

#### 3.1.11 Habits: minimum day, rest tokens, repair, comeback, travel — `src/srs/habits.ts`

```ts
export const TOKENS_PER_WEEK = 2;
export const REPAIR_HOURS = 48;
export const REPAIR_MIN_MS = 10 * 60_000;
export const MINIMUM_REVIEW_MS = 5 * 60_000;

export type HabitDayStatus = 'goal' | 'done' | 'rest' | 'repaired' | 'travel' | 'missed' | 'today' | 'future' | 'before';
export interface HabitDay { date: string; minimumDone: boolean; goalMet: boolean; token: boolean; repaired: boolean; travel: boolean }
export interface StreakV2 {
  /** Minimum days in the current run (rest tokens keep it alive but add nothing). 0 when broken. */
  current: number;
  /** current > 0 or today is the run's first day: the UI shows the current streak only when alive. */
  alive: boolean;
  longest: number;
  daysThisMonth: number;
  todayMinimum: boolean;
  todayGoal: boolean;
  tokensLeftThisWeek: number;
  /** Most recent uncovered missed day still repairable, with its deadline (4 a.m. after that day + 48 h). Only when
   *  that day's ISO week has no rest token left (the token is always offered first). */
  repairable?: { date: string; deadline: Date };
  /** repairable is set and today's goal is met: Today and the Session summary offer the 10-minute make-up. */
  makeupOffer: boolean;
  /** Yesterday was missed, uncovered, and its week has a token left: Today asks "Use a rest token for yesterday?". */
  offerTokenFor?: string;
  /** Monday → Sunday of this week. */
  week: { date: string; status: HabitDayStatus }[];
}
/** pure. Walks start → today: a day keeps the run when minimumDone, token or repaired; travel days neither break nor count;
 *  any other past day breaks it; today never breaks it. */
export function streakFromHabitDays(days: readonly HabitDay[], today: string, start: string, now: Date): StreakV2;
export async function streak(now?: Date): Promise<StreakV2>;

/** A token for `date`: allowed for a missed past day (within its own ISO week's limit) or a future day (planned).
 *  The third token in one ISO week → 'none-left'. */
export async function spendRestToken(date: string, now?: Date): Promise<'ok' | 'none-left' | 'already' | 'not-allowed'>;
export async function cancelPlannedToken(date: string, now?: Date): Promise<void>;

/** After every graded answer: minimumDone when reviewMs today ≥ 5 min, or ≥ 1 review today and the warm-up candidate
 *  list is empty (the planToday filter: not New, not of an item introduced today, not buried until a later day). */
export async function noteReviewProgress(now?: Date): Promise<boolean>;
/** A 3-minute micro or welcome-back session finished: minimumDone. Idempotent. */
export async function completeMicro(now?: Date): Promise<void>;
/** A full plan's steps are all done: goalMet + minimumDone. Idempotent. It never repairs a missed day. */
export async function completeDay(now?: Date): Promise<StreakV2>;
/** End of a make-up session: when DayRecord.makeupMs today ≥ REPAIR_MIN_MS and `repairable` is set, the missed day's
 *  row gets repaired = true. Idempotent; returns whether a day was repaired. */
export async function completeMakeup(now?: Date): Promise<boolean>;
/** A together session counted for this member on `date` (it counts for both partners, whoever's phone ran it):
 *  togetherMs += minutes·60 000 and minimumDone, only when `session` is not yet in DayRecord(date).together (then
 *  added). Idempotent, so E (the phone that ran it) and F (every 'together' event and refresh) can both call it. */
export async function creditTogetherSession(session: TogetherSessionId, minutes: number, date: string, now?: Date): Promise<boolean>;

export interface ComebackOffer { kind: 'none' | 'welcome-back' | 'fresh-start'; missedDays: number; freshStart?: string }
/** pure. Consecutive uncovered missed days right before today (travel and token days don't count):
 *  ≥ 1 → welcome-back; ≥ 3 → fresh-start, freshStart = whichever comes first after today: next Monday or the 1st. */
export function comebackOffer(days: readonly HabitDay[], today: string): ComebackOffer;
/** Travel/sick mode: Settings.travelUntil (null ends it). Days inside get DayRecord.travel when they pass. Catch-up runs on return. */
export async function setTravel(until: string | null, now?: Date): Promise<void>;
/** Saves Settings.freshStart (the offer's date). */
export async function chooseFreshStart(date: string, now?: Date): Promise<void>;
/** pure: course weeks 4 and 8 from the first study day: [+28 d, +56 d]. */
export function planReviewDays(firstDay: string): string[];
```

**Repair** (plan change 8: "a missed day with no token left can be repaired by a make-up session within 48 hours"). The make-up must be work beyond today's own plan, or rest tokens would mean nothing: one ordinary session the next day must not repair anything.

- The token comes first: `repairable` is set only when the missed day's week has no token left.
- The make-up is offered (`makeupOffer`) only after today's goal is met. It runs `/session?mode=makeup` (`planMakeup`, about 10 min of review-ahead, reading and a speed round).
- Its time goes to `DayRecord.makeupMs` (graded answers with `makeup: true`, other time through `addStudyTime(ms, 'makeup')`). `completeMakeup` repairs the day once `makeupMs ≥ 10 min` before the deadline.
- A second full plan is not offered as a repair path (the governor has no second plan to give).

**Fresh start.** `chooseFreshStart` saves the date. From that date: Today shows a fresh-start header ("A fresh start — this week begins today"), `StreakCard`'s week view starts on that date, and `catchUpBefore` is forced true for the governor until the first normal-mode day, after which `freshStart` is cleared. So the governor stays in catch-up, with no new items, until the review load is ≤ LF.

Copy rule for D: show "N days studied this month" and "Longest streak N"; show the current streak only when `alive`; never show a missed-days count.

#### 3.1.12 Fluency, numbers drill, pitch drill — `src/srs/fluency.ts`, `src/srs/numbersDrill.ts`, `src/srs/pitch.ts`

```ts
// fluency.ts
/** pure: ISO weekday 1 Mon, 3 Wed, 5 Fri → 'pitch'; 2 Tue, 4 Thu, 6 Sat → 'rotation'; 7 Sun → null. */
export function fluencyKindFor(isoWeekday: number): 'pitch' | 'rotation' | null;
/** pure: reread → speed → numbers → reread …, skipping ineligible kinds. */
export function nextRotation(last: FluencyKind | undefined, eligible: { reread: boolean; speed: boolean; numbers: boolean }): 'reread' | 'speed' | 'numbers' | null;
export const FLUENCY_MIN_STRAND = 6;
/** null on Sundays, in catch-up/travel/micro/make-up plans, when strandMin < 6 (before about course day 61), and
 *  whenever strandMin − 1 (output) − 2 < 3 (the read block keeps ≥ 3 min). pitch is eligible with ≥ 8 pitch items
 *  (pitchCandidates); reread with a story at stage ≥ 1 first read 7–21 days ago and stage < 3; speed with ≥ 20
 *  receptive cards of stability > 21 d; numbers once 'numbers-prices' is introduced. If today's kind is ineligible,
 *  another eligible kind is used. */
export async function pickFluency(ctx: { strandMin: number; mode: DayMode }, now?: Date): Promise<FluencyPlan | null>;
export const SPEED_ROUND_MS = 60_000;
/** Receptive cards with stability > 21 d (read, listen, meaning, kana read), random, max 40. Never graded. */
export async function speedRoundCards(now?: Date, max?: number): Promise<string[]>;
export async function logFluency(kind: FluencyKind, value: number, ref?: string, now?: Date): Promise<void>;

// numbersDrill.ts (pure)
export type NumberDrillKind = 'number' | 'price' | 'time' | 'counter';
export interface NumberDrillItem { kind: NumberDrillKind; prompt: string; answers: string[] }
/** Hiragana reading of 0..99,999,999 with sound changes: 三百 さんびゃく, 六百 ろっぴゃく, 八百 はっぴゃく,
 *  三千 さんぜん, 八千 はっせん, 一万 いちまん, 十 じゅう. */
export function readNumber(n: number): string;
export function readPrice(yen: number): string;                // readNumber + えん
/** 4時 よじ, 7時 しちじ, 9時 くじ; minutes: いっぷん, にふん, さんぷん, よんぷん, ごふん, ろっぷん, ななふん, はっぷん/はちふん, きゅうふん, じゅっぷん/じっぷん; 30 → はん also accepted. */
export function readTime(h: number, m: number): string[];
export type Counter = 'つ' | '人' | '枚' | '本' | '杯' | '匹' | '個' | '回';
/** Grammar id that must be introduced before a counter, time or price item is drilled ("only known material"). */
export const NUMBER_DRILL_GRAMMAR: { prices: 'numbers-prices'; time: 'time-telling'; counters: Record<Counter, string> };
//   counters: つ → 'counting-tsu'; 人 → 'counters-people'; 枚 本 杯 匹 個 回 → 'counters-objects'
export function readCounter(n: number, counter: Counter): string[];
export function numbersDrill(random: () => number, opts: { counters: Counter[]; time: boolean; prices: boolean; count?: number }): NumberDrillItem[];
// pickFluency passes only the counters, time and prices whose NUMBER_DRILL_GRAMMAR id is introduced.

// pitch.ts
export const PITCH_BOX_DAYS = [0, 1, 3, 7, 14] as const;
/** clipRef is always 'pitch:<ref>' (the word followed by が); the diagram has moras.length + 1 positions. */
export interface PitchItem { ref: string; written: string; kana: string; accent: AccentInfo; clipRef: string }
/** pure: known words with an accent entry measured with が (`accent.withGa`) and a 'pitch:<ref>' clip in the manifest.
 *  Words without that clip (verbs, adjectives, words outside the clip scope) are never drilled: in isolation heiban and
 *  odaka sound the same, so the drill could not be answered by ear. They still get a PitchLine. */
export function pitchCandidates(accent: AccentFile, manifest: AudioManifest, isKnown: (ref: string) => boolean, info: (ref: string) => WordInfo | undefined): PitchItem[];
/** pure: 8–12 items due by box. Weights: heiban ×2; a long vowel (ー, おう, えい) ×1.5; ん or っ ×1.5. Minimal-pair
 *  groups (same kana, different drop, e.g. はし 箸/橋/端) go in together when ≥ 2 members are known. */
export function pickPitchDrill(cands: readonly PitchItem[], boxes: ReadonlyMap<string, PitchBoxRecord>, today: string, random: () => number, n?: number): PitchItem[];
/** Right → box + 1 (max 4), wrong → box 0; nextDay = today + PITCH_BOX_DAYS[box]. Never FSRS. */
export async function recordPitch(ref: string, correct: boolean, now?: Date): Promise<void>;
/** pure: the options for a word of n moras heard with が: drop 0 (heiban: が stays high), 1..n (n = odaka: が is low). */
export function pitchOptions(moraCount: number): number[];
```

#### 3.1.13 Learned, retention, hours, chapters, coverage — `src/srs/progress.ts`, `src/srs/milestones.ts`

```ts
// progress.ts
export const LEARNED_SUCCESSES = 3;
/** pure: ≥ 3 reviews with grade ≥ 2 on 3 distinct day keys strictly after introducedDay (so the first check never counts). */
export function isLearned(logs: readonly Pick<ReviewLogRecord, 'grade' | 'reviewedAt'>[], introducedDay: string): boolean;
export interface LearnedCounts {
  kanaLearned: number;
  /** Write card learned (a retired card that was learned still counts). */
  kanjiCanWrite: number;
  /** The anchor word (or any word with the kanji) is learned through its read card. */
  kanjiCanRead: number;
  /** word|read learned, or core|listen learned (each word once). */
  wordsLearned: number;
  /** grammar|comprehend learned. */
  grammarLearned: number;
  kanjiIntroduced: number;
  wordsIntroduced: number;
  grammarIntroduced: number;
}
export async function learnedCounts(now?: Date): Promise<LearnedCounts>;
export interface RetentionStat { family: CardFamily; week: { n: number; rate: number | null }; month: { n: number; rate: number | null } }
/** pure: logs of the last 30 days with prevState Review and context 'review' or 'partner'; week bucket = elapsedDays 5–10,
 *  month bucket = 21–45; rate = share with grade ≥ 2, null when n < 10. Families: write (kana/kanji write), read
 *  (kana read, kanaRule, word/core read, kanji meaning), listen, produce (produce, cloze), grammar (comprehend, build). */
export function retentionFrom(logs: readonly ReviewLogRecord[], now: Date): RetentionStat[];
export async function retention(now?: Date): Promise<RetentionStat[]>;
/** Σ (studyMs + togetherMs) over all days, in hours. */
export async function hoursTotal(): Promise<number>;
/** pure: round(chars / minutes); 0 when ms ≤ 0. */
export function charsPerMinute(chars: number, ms: number): number;
export async function readingSpeed(): Promise<{ latest: number | null; best: number | null }>;
// kept: knownKanji, learnedToday, addStudyTime (new `kind` parameter, §3.1.2), weekStats (now 14 days), rankHardKanji, hardestKanji (write cards only)
// moved to habits.ts (removed here): streakFromDays, restDaysOf, streak, completeSession, firstStudyDay

// memberProgress.ts (its own module: it needs progress.ts, milestones.ts, course.ts and readListen.ts, and none of
// them imports it, so there is no import cycle)
/** Summary for POST /api/stats (F maps it): every MemberProgress field, including recentItems, settledUnit,
 *  coreReached and grammarReached. */
export async function memberProgress(now?: Date): Promise<MemberProgress>;

// milestones.ts
export const COVERAGE_TABLE: readonly (readonly [kanji: number, share: number])[] =
  [[100, 0.74], [200, 0.79], [300, 0.83], [500, 0.88], [700, 0.92], [1000, 0.95]];
/** pure: linear interpolation of the table; null below 100 kanji (the UI shows "100 kanji ≈ 74 %" as the next goal); 0.95 from 1,000. */
export function coverageShare(kanjiLearned: number): number | null;
export const CHAPTER_SIZE = 15;
export interface ChapterInfo { chapter: number; done: number; size: number; half: 'done' | 'left'; text: string }
/** pure. Kana phase (no kanji yet): chapter 0, size 92, 'Chapter 0 · Kana · 46 of 92'. Then chapter = floor(k / 15) + 1,
 *  done = k % 15; done ≤ 7 → 'Chapter 7 · 5 of 15 done'; done ≥ 8 → 'Chapter 7 · 6 to go'. */
export function chapterInfo(kanjiIntroduced: number, kanaIntroduced: number, kanaTotal: number): ChapterInfo;
/** What a chapter taught: its span runs from the day its first kanji was introduced (chapter 0: the first study day) to
 *  the day before the next chapter's first kanji (open-ended for the current chapter). Lists the kanji of the chapter
 *  and every word (core/word) and grammar item whose introducedAt falls in the span. */
export async function chapterItems(chapter: number, now?: Date): Promise<{ from: string; to: string | null; kanji: string[]; words: WordRef[]; grammar: string[] }>;
export const SEASON_WEEKS = 12;
/** pure: the season number whose finale is due (12·n weeks after the first study day, not yet seen), else null. */
export function seasonFinaleDue(firstDay: string, today: string, seen: ReadonlySet<string>): number | null;
export const HOUR_BENCHMARKS: readonly { id: 'n5' | 'n4' | 'fsi'; label: string; from: number; to: number }[];
//   n5: 'old JLPT N5', 250–400 h; n4: 'old JLPT N4', 500–750 h; fsi: 'FSI professional (long view)', 2,200 h
export const PLAN_MILESTONES: readonly { id: 'M0' | 'M1' | 'M2' | 'M3' | 'M4'; day: number; kanji: [number, number]; words: number; grammar: [number, number] }[];
//   M0 day 14: 0 kanji, 35 words, 2 grammar; M1 90: 100, 500, 35; M2 180: 175, 900, 60; M3 365: 265–310, 1550, 85–100; M4 730: 390–490, 2500, 115
/** Records a reached milestone (idempotent: an existing row is kept). */
export async function recordMilestone(id: string, now?: Date): Promise<void>;
export async function markMilestoneSeen(id: string, now?: Date): Promise<void>;
export async function unseenMilestones(now?: Date): Promise<MilestoneRecord[]>;
```

#### 3.1.14 Together engine — `src/srs/together.ts`

B's together engine never imports `src/sync/**` or `src/components/**` (F's `sync/together.ts` imports B, not the other way round). Callers pass the server state and the partner's progress in.

```ts
export const QUIZ_MAX = 10;
export const MONTHLY_QUIZ_MAX = 20;
export const DICTATION_WORDS = 5;
export const QUIZ_AGE = [2, 10] as const;      // days since introduction
export const RECENT_AGE = [2, 21] as const;    // task targets, dictation, teach-me
export const QUIZ_LAPSE_DAYS = 7;
/** This phone's answerer pool (the learner's own cards).
 *  partner: cards of items introduced 2–10 days ago plus cards with an Again in the last 7 days, never items introduced
 *  today, lapses first then oldest, kinds mixed round-robin (write → read → produce → build), max 10.
 *  monthly: non-suspended Review cards, lowest retrievability first, max 20.
 *  dictation: up to 5 kanji introduced 2–21 days ago that have an anchor word and a non-retired write card, lowest write
 *  stability first. Item key = the kanji's write card ('kanji:水|write'), kind 'write'; prompt = the anchor's kana plus
 *  its English (the asker reads the kana aloud); answer = the anchor written ('水'). */
export async function buildQuizPool(kind: 'partner' | 'monthly' | 'dictation', now?: Date): Promise<PartnerQuizItem[]>;
/** pure: the asker's prompt/answer for one card (write: 'Write the kanji for "water" · □本 にほん' / '水';
 *  read: written word / kana; produce: English + note / Japanese; build: English / jp). */
export function partnerPrompt(card: Pick<CardRecord, 'id' | 'itemId' | 'kind' | 'type'>, info: { kanji?: KanjiEntry; word?: WordInfo; grammar?: GrammarPoint; anchor?: WordInfo }): PartnerQuizItem;
/** Answerer side, for kinds partner, dictation and monthly. One rw transaction over [partnerQuizzes, cards, reviewLogs,
 *  days, encounters, settings, items]: if partnerQuizzes[quiz.id].appliedAt is set, return the stored counts and change
 *  nothing; else each verdict whose key is one of this phone's cards → gradeCard(mode 'partner', context 'partner',
 *  PARTNER_GRADE) when inPartnerWindow(card, now), else logEncounters(…, 'partner'); then set appliedAt. A quiz arriving
 *  twice (the 'quiz' WS event and a refresh, or two tabs) is applied once. */
export async function applyPartnerVerdicts(quiz: Quiz, now?: Date): Promise<{ graded: number; practiced: number }>;
/** Pass-and-play: verdicts for the device owner's pool applied at once (same transaction rule, keyed by a local quiz id). */
export async function applyLocalVerdicts(quizId: string, items: readonly PartnerQuizItem[], verdicts: readonly QuizItemVerdict[], now?: Date): Promise<{ graded: number; practiced: number }>;
/** A kanji introduced 2–21 days ago with the lowest write stability, for the teach-me turn. */
export async function teachMeKanji(now?: Date): Promise<string | null>;
/** pure: the couple's settled unit: min(mine, partner ?? mine) of MemberProgress.settledUnit. */
export function coupleSettledUnit(mine: number, partner?: number): number;
/** pure: 5–8 task-card targets (item ids). First the authored targets that either partner introduced 2–21 days ago, then
 *  topped up alternately from my recent items and the partner's recentItems (both 2–21 days old, so never today's
 *  items), no duplicates, max 8. Fewer than 5 only when both lists run out. */
export function taskTargets(authored: readonly TargetRef[], mineRecent: readonly string[], partnerRecent: readonly string[]): string[];
export interface WeekPlanInput {
  week: string;
  slots: readonly TogetherSlot[];
  state: TogetherState | null;
  units: readonly UnitSpec[];
  roleplays: readonly RolePlay[];
  stories: readonly StoryEntry[];
  me: { settledUnit: number; readyStories: readonly string[]; coreReached: number; grammarReached: number };
  partner?: { settledUnit: number; readyStories: readonly string[]; coreReached: number; grammarReached: number };
  /** Story ids already used as a shared story. */
  usedShared: ReadonlySet<string>;
  /** seasonFinaleDue(...) is not null on this phone. */
  seasonFinale: boolean;
}
/** pure.
 *  Sessions: one per slot on its weekday this week, plus { id: 'monthly', day: the month's first Saturday, time: the C
 *  slot's time or '10:00' } when that Saturday is in this week.
 *  settledUnit = coupleSettledUnit(me, partner).
 *  Conversation: the script named by the lowest unit ≤ settledUnit + 1 whose stage < 5 (missing = 1); its stage is
 *  capped at 1 (listen and shadow) when that unit > settledUnit, because S2–S4 need the unit's grammar.
 *  Task: only from units ≤ settledUnit: the settled unit's task if not run; else its repeat (twist) once the first run is
 *  ≥ 2 days old (and ≤ 7 when possible); else the newest earlier unit's task not run. With no task (no settled unit
 *  yet, every task run, or the task not `ready`): rolePlayId = the first eligibleRolePlays script, else the core conversation of unit settledUnit + 1 (in
 *  weeks 1–3 no free role-play is eligible, since the legacy scripts sit at units 2–24); run at stage 1.
 *  storyId: first story by level/unit/id in both partners' readyStories and not in usedShared.
 *  capstoneUnit (monthly weeks only): the highest unit ≤ settledUnit whose capstone isn't done.
 *  showcase = seasonFinale. */
export function buildWeekPlan(input: WeekPlanInput): TogetherWeekPlan;
/** Assembles WeekPlanInput from local data plus the caller's `state` (F's useTogetherState) and `partner` (the household's
 *  MemberProgress, through E), and caches it in togetherPlans. */
export async function loadWeekPlan(input: { state: TogetherState | null; partner?: MemberProgress }, now?: Date): Promise<TogetherWeekPlan>;
/** pure: free role-plays (not core conversations) with unit ≤ settledUnit + 1, or without a unit, and ≤ 2 targets that
 *  are not introduced for **both** partners (core targets by `order ≤ coreReached`, grammar by `order ≤ grammarReached`,
 *  min over the two partners). */
export function eligibleRolePlays(scripts: readonly RolePlay[], coreConversationIds: ReadonlySet<string>, introducedForBoth: (t: TargetRef) => boolean, settledUnit: number): RolePlay[];
export async function weeklyCheckinCounts(week: string, now?: Date): Promise<WeeklyCheckin['counts']>;
```

#### 3.1.15 Can-dos — `src/srs/candos.ts`

```ts
/** pure: ready, and every grammar id of its unit is introduced. */
export function canDoAvailable(cd: CanDo, unit: UnitSpec, grammarIntroduced: ReadonlySet<string>): boolean;
/** pure: read/listen checks pass with correct ≥ ceil(2/3 · n) (2 of 2, 2 of 3). */
export function gradeCanDoQuestions(cd: CanDo, answers: readonly number[]): { correct: number; passed: boolean };
/** Records an attempt; sets passedAt only when passed. There is no API that awards a can-do without a check (no self-rating). */
export async function recordCanDoAttempt(id: string, unit: number, passed: boolean, via: 'auto' | 'ai', now?: Date): Promise<CanDoRecord>;
export async function canDoStatus(): Promise<Map<string, CanDoRecord>>;
```

speak/write checks pass **only** through `/api/ai/cando` (`via 'ai'`). Without the home server's AI they show "Needs the home server" and cannot be awarded. A partner never ticks rubric items: the authored rubrics are grammar judgements ("uses 夫の…/妻の…"), and the ground rules say partners never correct each other's Japanese.

#### 3.1.16 `src/lib/ruby.ts` and `src/lib/backup.ts` additions (B)

```ts
// ruby.ts (existing exports kept)
export interface KanaHelperSegment { text: string; romaji?: string }
/** Kana units (yōon and small-kana pairs together, っ and ー on their own); romaji only on units containing a kana
 *  the learner has not been taught (`taught` holds basic kana chars; voiced/yōon units count as taught once their
 *  rule lesson is introduced). Non-kana passes through. Rendered by C's <KanaText> while CourseSnapshot.inSprint; never after. */
export function romajiHelper(text: string, taught: ReadonlySet<string>, kana: readonly KanaEntry[]): KanaHelperSegment[];
/** The taught set for romajiHelper (introduced basic kana, plus every voiced/yōon kana whose rule is introduced). */
export async function taughtKana(now?: Date): Promise<Set<string>>;   // in src/srs/course.ts

// backup.ts: VERSION = 2. Row validators for every v2 table. A v1 file restores settings (migrateSettings) and chat only,
// and BackupImport gains `progressDropped: boolean` so Settings can say why.
```

#### 3.1.17 Simulation harness and dev seeding — `src/srs/simulate.ts`, `src/srs/devSeed.ts`

The simulator drives the **real** candidate logic: each simulated day builds a `CourseSnapshot` and calls `streamCandidates` (so the sprint pick, grammar every-other-day, prerequisite, contrast and confusable rules are the production ones), then `govern`, `orderWarmup`, `cardTypesFor`, `presetOf` and ts-fsrs. The same run can hand back its final state with real ids, which is what `devSeed` writes.

```ts
/** The static course the simulator teaches: the real data, or a synthetic stand-in for fast tests. */
export interface SimCourse {
  kana: KanaEntry[];
  rules: KanaRule[];
  curriculum: Curriculum;
  core: CoreWord[];
  grammar: GrammarPoint[];
  /** WordEntry.use for JMdict refs (produce cards). */
  wordUse: (ref: WordRef) => boolean;
}
/** pure: the real kana table and rules plus a synthetic curriculum of 2,136 kanji (51 zero-word at fixed positions, the
 *  rest with an anchor and 0–2 staged words: mean 2.68 words per kanji), 1,577 core words (use = 409 words spread over
 *  orders 1–415, as authored) and 115 grammar points (4 recognitionOnly, prerequisites in a chain). */
export function syntheticCourse(kana: readonly KanaEntry[], rules: readonly KanaRule[]): SimCourse;
/** Loads the real course from data.ts. */
export async function loadSimCourse(): Promise<SimCourse>;

export interface SimOptions {
  course: SimCourse;
  budgetMin: DailyMinutes;
  days: number;
  seed: number;
  /** Calendar date of course day 1 (default '2026-01-05'). */
  startDate?: string;
  writeList?: number;            // default 500
  writeHandicap?: number;        // default 0.94 (handwriting recall below FSRS prediction)
  firstCheckPass?: number;       // default 0.8
  missDayEvery?: number;         // skip every Nth day (comeback tests); default none
  /** Return the final progress state (real ids) as well. */
  keepState?: boolean;
}
export interface SimDay {
  day: number; mode: GovernorOutput['mode']; reviews: number;
  reviewSec: number; newSec: number; strandSec: number; totalSec: number;
  kana: number; kanji: number; words: number; grammar: number; newKanjiToday: number; newGrammarToday: number;
  /** Meaning-confusable members (numbers, weekdays) introduced that day. */
  numbersToday: number;
}
export interface SimState {
  items: ItemRecord[];
  cards: CardRecord[];
  logs: ReviewLogRecord[];
  days: DayRecord[];
  staged: StagedWordRecord[];
}
/** pure, deterministic. Learner: a review passes with probability r (× writeHandicap for write cards); the first check
 *  passes with firstCheckPass; seconds = DEFAULT_SECONDS (+ 8 s per miss). 365 days on the synthetic course run in
 *  well under 3 s. */
export function simulate(opts: SimOptions): { days: SimDay[]; state?: SimState };

/** DEV only (never reached from production code): wipes the progress tables, runs simulate({ course: await
 *  loadSimCourse(), days: courseDay − 1, startDate: dayKey(now) − (courseDay − 1) days, keepState: true }) and writes
 *  its state, so that today is course day N with real kanji, core and grammar ids. */
export async function devSeed(courseDay: number, opts?: { budgetMin?: DailyMinutes; seed?: number }): Promise<void>;
```

`simulate.test.ts` sets an explicit timeout (`{ timeout: 20_000 }`), since 2 seeds × 365 days exceeds vitest's 5-s default on slow machines.

### 3.2 Study and session UI — owner C

C's files: `src/screens/{Session,WritePractice,GrammarList,GrammarDetail,Reading,CanDoCheck}.tsx`, `src/components/study/**` and `src/writing/**`.

#### 3.2.1 Session step machine — `src/components/study/session/machine.ts` (pure, with tests)

`machine.ts` is pure and imports no `.tsx`. `LearnedItem` moves here from `learn/NewItemFlow.tsx` (which now imports it), in the v2 shape:

```ts
/** One item taught this sitting, with every card it created (upgrades: the one read card). */
export interface LearnedItem {
  plan: NewItemPlan;
  itemIds: string[];        // the item and, for a kanji, its anchor
  cardIds: string[];
  /** The card the memory pass retrieves (kanji/kana write, core produce, else core listen); none for grammar/staged. */
  memoryCardId?: string;
}
export interface SessionStep { id: SessionStepId; /** teach/memory: batch index */ batch?: number }
/** pure. Order: warmup → (teach b, memory b) for each batch → read → check → output → fluency → summary.
 *  A step is included only when the plan has content for it: warmup (warmup.length), teach/memory (teach[b]),
 *  read (read != null), check (cards created this sitting or plan.pendingCheck), output, fluency.
 *  read/output/fluency in plan.doneSteps are skipped. 'anywhere' sitting and micro/welcome-back/makeup: warmup → summary.
 *  The memory step for batch b exists only when batch b has a kanji, sprint kana or core word. */
export function sessionSteps(plan: DayPlan): SessionStep[];
export interface SessionState {
  steps: SessionStep[];
  index: number;
  /** Items taught this sitting (filled by 'taught'). */
  learned: LearnedItem[];
  /** First-check card ids, fixed when the check step starts. */
  checkIds: string[] | null;
  /** Day-0 retrievals per **card** id (memory → the production card, reading → the receptive card, first check, re-ask).
   *  React state only: lost on reload, which cannot break the cap (§3.1.7 "Steps and reloads"). */
  retrievals: Record<string, number>;
}
export type SessionEvent =
  | { type: 'next' }
  | { type: 'taught'; item: LearnedItem }
  | { type: 'retrieved'; cardId: string }
  | { type: 'start-check'; ids: string[] };
export function initialSession(plan: DayPlan): SessionState;
export function sessionReducer(s: SessionState, e: SessionEvent): SessionState;
/** pure: every New card of the sitting (learned cardIds + pendingCheck, deduplicated): production types first (write,
 *  produce, build, cloze), then the rest (read, listen, comprehend, meaning); shuffled within each group with `random`. */
export function firstCheckIds(learned: readonly LearnedItem[], pendingCheck: readonly string[], random: () => number): string[];
/** Per card. By construction a card reaches at most 3 (memory or reading, check, re-ask); a 'retrieved' event that would
 *  exceed 4 is ignored and the caller skips that retrieval. */
export const MAX_DAY0_RETRIEVALS = 4;
```

`Session.tsx`:

1. **Open.** Show a sitting choice: "Anywhere (no pen)", "At my desk" and "All of it" (the default). Then call `planToday(now, { sitting })`, then `startSitting(plan)`. Start-up side effects run once, behind v1's `started` ref guard; a double tap on the sitting choice is ignored while planning.
   - Micro and welcome-back sessions arrive with `?mode=micro|welcome` from Today, and use `planMicro`. The make-up arrives with `?mode=makeup` and uses `planMakeup`.
   - `?extra=1` (the learner accepted "Add one more kanji today?") plans with `{ extraKanji: true }`.
2. **Steps.** `finishStep(step)` only for `read`, `output` and `fluency`. Read/output/fluency time is reported with `addStudyTime(ms, 'strand')`, lesson time with `'lesson'`, make-up time with `'makeup'`.
3. **Summary.**
   - `completeDay()` when every step of a plan with sitting `any`/`desk` and mode sprint/normal/catch-up/travel is done; `completeMicro()` for micro and welcome-back; `completeMakeup()` for a make-up. All idempotent.
   - When `streak().makeupOffer` is true after `completeDay`, the summary offers "Make up <weekday>: 10 more minutes" → `/session?mode=makeup`.
   - Then `pushStats({ immediate: true })` (F).
4. **Re-plan.** Re-opening the session re-plans. Session.test asserts that `planToday` is called again.
5. **Header.** The progress label shows step names. During catch-up it never shows a card count ("Catching up" plus a time bar).
6. **Framing.** One line at the memory pass and at the first check: "Spaced recalls feel harder — that is why they stick."
7. **Stopping.** The existing back-guard and "Stop for now?" stay. Stopping keeps what was done; the next sitting re-plans from it (§3.1.7).

#### 3.2.2 Review block — `ReviewBlock.tsx`

```ts
export function ReviewBlock(props: {
  cardIds: readonly string[];
  timer: StudyTimer;
  context: 'review' | 'first-check';
  /** Never show counts (catch-up). */
  hideCounts?: boolean;
  onProgress?: (p: BlockProgress) => void;
  onAnswered?: (correct: boolean) => void;
  /** First check: each retrieval of a new card (for the per-card day-0 cap). */
  onRetrieved?: (cardId: string) => void;
  /** Make-up session: grades carry `makeup: true`. */
  makeup?: boolean;
  /** Anywhere sitting: hide "Write on paper". */
  paperAllowed?: boolean;
  onDone: () => void;
}): JSX.Element;
export const REASK_GAP = 5;
```

- A graded `Again` puts the card back once, after at least 5 other cards: at `min(index + 1 + REASK_GAP, queue.length)`, or at the end when fewer remain. The re-ask is **graded**, so `gradeCard` is called twice: with `context: 're-ask'` in the warm-up, and with `context: 'first-check'` again inside the first check (its time then stays out of `reviewMs`). A missed re-ask is not re-asked again. The v1 ungraded end-of-block repeat is gone.
- Each grade is applied once: the card's grade button disables on the first tap, and the block ignores a second `onGrade` for the same queue position.
- After each grade: `noteReviewProgress()` (B), and `pushStats()` debounced (F).
- A **surprise miss** is detected with `isSurpriseMiss(lastLogOfCard, medianMs)` and passed to the grade (`surprise`) and to the feedback.

#### 3.2.3 Cards — `cards/prepare.ts`, `cards/types.ts`, `cards/*.tsx`

```ts
export type PreparedCard =
  | (Base & { view: 'kana-read'; kana: KanaEntry; mode: 'romaji' | 'word'; word?: KanaExample })
  | (Base & { view: 'kana-write'; kana: KanaEntry; /** sprint: sound only (auto-play + replay); after: example word with □ */ prompt: 'sound' | 'word'; word?: KanaExample; row?: string })
  | (Base & { view: 'kana-rule'; rule: KanaRule; word: { kana: string; en: string } })
  | (Base & { view: 'kanji-write'; kanji: KanjiEntry; anchor?: WordInfo; /** anchor written with the kanji as □ */ blanked?: string; reading: string })
  | (Base & { view: 'kanji-meaning'; kanji: KanjiEntry })
  | (Base & { view: 'word-read'; word: WordInfo; carrier?: SentenceEntry; accent?: AccentInfo })
  | (Base & { view: 'produce'; word: WordInfo })
  | (Base & { view: 'listen'; word: WordInfo; accent?: AccentInfo })
  | (Base & { view: 'grammar-comprehend'; point: GrammarPoint; example: GrammarExample; exampleIndex: number })
  | (Base & { view: 'grammar-build'; point: GrammarPoint; item: GrammarBuildItem; itemIndex: number; tiles: boolean; shuffledTiles: string[] })
  | (Base & { view: 'cloze'; sentence: SavedSentenceRecord });
export interface PrepareContext {
  courseDay: number;
  /** CourseSnapshot.inSprint: kana-read cards take romaji and kana-write cards are sound-only while true. */
  inSprint: boolean;
  /** Taught kana for <KanaText>'s romaji helper (taughtKana()). */
  taught: ReadonlySet<string>;
  grammarIntroduced: number;
  handsBusy: boolean;
  known: KnownWords;
  random?: () => number;
}
export async function prepareCard(card: CardRecord, ctx: PrepareContext): Promise<PreparedCard | null>;
/** '□本' for anchor 日本 and kanji 日 (every occurrence of the kanji). Never contains the target kanji. */
export function blankKanji(written: string, char: string): string;
```

New and renamed files:

- **Renamed:** `WordReadingCard.tsx` → `WordReadCard.tsx`; `SentenceReadCard.tsx` → `ClozeCard.tsx`.
- **New:** `KanaRuleCard.tsx`, `ListenCard.tsx`, `ProduceCard.tsx`, `GrammarComprehendCard.tsx`, `GrammarBuildCard.tsx`, `KanaText.tsx` and `KanaInput.tsx`.
  - **`KanaInput`**, the IME field, with `lang="ja"`, `autocapitalize="off"`, `autocomplete="off"`, `autocorrect="off"` and `spellCheck={false}` (iOS would otherwise rewrite romaji: "kitte" → "kitten"); Enter submits (not while composing). It runs `imeConvert` on `input` events **only when not composing**: between `compositionstart` and `compositionend` (or while `event.isComposing`) it leaves the value alone, and it converts once on `compositionend`. Kana typed on a native Japanese keyboard (flick or kana input) passes through unchanged, since `imeConvert` leaves kana as it is. Tests: a composition sequence (`compositionstart`, inputs with `isComposing`, `compositionend`) yields the composed kana untouched; romaji typed without composition converts live.
  - **`KanaText`** (`{ text: RubyText }`): while `ctx.inSprint`, renders kana with `romajiHelper(text, taught)` ruby (romaji only over kana not yet taught); otherwise plain `Ruby`. Used by CoreWordLesson, the Listen and Produce reveals, GrammarLesson examples and drills, the grammar comprehend card, KanaRuleLesson words and KanaWordsRead. Test: ありがとう on course day 3 shows romaji over り and が only.
- **Deleted:** `KanjiReadingCard`, `WordMeaningCard`, `RadicalMeaningCard`, `VocabMeaningCard`, `VocabRecallCard`, `GrammarDrillCard` and `src/components/study/prefs.ts` (the per-device typing toggle is gone).

Answer-mode rules:

- **Typed cards** show **no options by default**. A small "Show options" link reveals 4 choices: a correct pick grades Hard, a wrong pick Again, and both log `mode 'choice'`. In `Settings.handsBusy`, the choices are shown at once (`mode 'choice'`, capped at Hard).
- **Wrong typed answer:** one retry is allowed for kana/word readings (`retries: 1` → Hard). A second wrong answer → Again.
- **Self-graded cards** (listen, comprehend, kanji meaning, paper writing): reveal, then two buttons, "Missed" and "Got it". There is no Easy anywhere.
- **Produce speech:**
  - The mic button appears only when `recognitionAvailable()` and online.
  - `listen()` gives a transcript, and `spokenMatches(transcript, word.readings)` (F) decides.
  - After 2 failed recognitions, offer "I said it — self-grade", which is graded with `selfGrade` capped at Hard and logs `mode 'spoken'`.
  - Offline or unsupported: the typed input only. A test asserts the typed input renders when recognition is offline.
- **Word read:**
  1. Type the reading.
  2. Reveal the meaning, audio and PitchLine.
  3. "Knew the meaning?" with Yes and No.
  4. `gradeWordRead`, logging `parts: { reading, meaning }`.
- **Grammar build:** tiles while `ctx.grammarIntroduced < 60` (tap the tiles in order; graded with `gradeFor`, and a retry counts); after that, typed with `sentenceMatches(input, item.answers)`.
- **Kanji write:** the WritingPad in recall mode (§3.2.5). "Write on paper" (only when `paperAllowed`) shows the answer after the learner taps "Done", then "Missed" or "Got it" (`mode 'paper'`, `input 'paper'`).
- **Romaji.** Kana write cards never show a romaji label: during the sprint the prompt is the sound only. Romaji appears only as the typed answer of sprint kana-read cards and in `KanaText`'s helper ruby over untaught kana, and nowhere once `inSprint` is false (except the kana chart).
- **Readings on deliberate cards.** `useCardRubyShow` gives a reading only for words that contain a kanji the learner has not been introduced to; the card's own target word never gets ruby (prepare.test asserts it for every view).

#### 3.2.4 Feedback — `cards/FeedbackPanel.tsx`

```ts
export function FeedbackPanel(props: {
  prepared: PreparedCard;
  grade: Grade;
  durationMs: number;
  /** Per-user median for the card's timing key, ms. */
  medianMs: number;
  surprise: boolean;
  due?: Date;
  mask: LeakMask;
  onContinue: () => void;
}): JSX.Element;
export const FAST_AUTO_ADVANCE_MS = 1200;
```

| Case | Shows |
|---|---|
| Again or Hard | The full answer: kanji stroke animation **once** (for kanji and kana), the reading with audio (`play`) and PitchLine (when accent exists), the anchor word inside a known sentence (`exampleSentenceFor`), the parts with names (components + named parts), and the mnemonic (custom first; for a kana, its picture hook `KanaExample.hook`) |
| Good, faster than `medianMs` | Plays the audio and shows a one-line answer. Continues automatically after 1.2 s, or on a tap |
| Good, slower than the median | Answer line + audio + Continue |
| Surprise miss | The Again content plus a parts breakdown, 2 related words that share the kanji, and a "write your own hook" field (saves `ItemRecord.customMnemonic`) |

- **Leak guard:** the panel never shows a field that the mask blocks for an item other than the card's own. Example: a word's reading while that word's read card is still due today.
- **Mnemonics** appear only in lessons and in miss feedback, never on the cue side of a test card.
- **Calibration tip:** when `needsCalibrationTip(...)`, the write-card feedback shows "Your 'I wrote it right' taps are above 10 % — try writing a little slower."

#### 3.2.5 Writing in recall mode — `src/writing/matcher.ts`, `WritingPad.tsx`

```ts
// matcher.ts (added)
export interface UnorderedMatch {
  ok: boolean;                         // no missing, no extra, no unmatched
  missing: number[];                   // expected stroke indexes with no drawn stroke
  extra: number[];                     // drawn stroke indexes matching nothing
  unmatched: number[];                 // expected strokes paired with a drawn stroke that failed matchStrokeOf
  orderSlips: { expected: number; drawnAt: number }[];  // matched strokes drawn out of order (not in the LIS)
  /** assignment[expected] = drawn index or null. */
  assignment: (number | null)[];
}
/** Builds a cost matrix from matchStrokeOf scores (frame estimated from the strokes accepted so far, two passes:
 *  bounding-box frame → assign → re-estimate from ok pairs → assign), pads it square with MISSING_COST, and solves it
 *  with the Hungarian algorithm (n ≤ 30). */
export function matchCharacterUnordered(expected: readonly string[], drawn: readonly (readonly Point[])[], opts?: MatchOptions): UnorderedMatch;
/** Min-cost assignment for a square matrix (n ≤ 30): returns col index per row. */
export function hungarian(cost: readonly (readonly number[])[]): number[];
export const MISSING_COST = 10;

// WritingPad.tsx: WritingMode gains 'recall'.
//   recall: no per-stroke marks, no model and no animation while writing; Undo/Clear available; a "Done" button calls
//   onRecallDone({ strokes: Point[][], match: UnorderedMatch, hintUsed }). Afterwards the model is drawn over the ink, and
//   each orderSlip gives a coaching note ("stroke 3 usually comes before 2") with a replay button.
//   trace/guided/memory keep the per-stroke behaviour (lessons and free practice).
```

The grade is `gradeForRecallWriting({ strokeCount, missing: m.missing.length, extra: m.extra.length, unmatched: m.unmatched.length, hintUsed })`. When it is Again, an "I wrote it right" button re-grades the card as Hard with `override: true`. The grade is applied once: the card is graded only after the learner chooses, or after "Continue".

#### 3.2.6 Lessons — `learn/*`

- **`NewItemFlow`** takes a `TeachBatch`. For each item it shows the lesson, then the item's copy passes. After the **last** item of the batch, the session moves to the memory step. Test: the memory pass for item 1 renders only after item 4's guided copy.
- **`KanaLesson`**, a row lesson with 5 kana per batch. Each kana:
  1. Sound (clip `kana:<c>`) and the one-line picture mnemonic (`KanaExample.hook`), with the example word (clip `kanaEx:<c>`).
  2. Trace once.
  3. Guided copy.

  After the batch comes the memory step (each kana written from its sound, mixed order). Then 2–3 real words that use only taught kana (in `ReadPlan.kanaWords`).
- **`KanaRuleLesson`** (new): title and explanation; pairs as a grid (か→が) with audio (`kana:<to>` clips, which exist for all 208 kana); read 8 practice words aloud and hear each. One `kanaRule` item.
- **`KanaCheck`** (new; the read block when `ReadPlan.kind === 'kana-check'`): the day-14 can-do. Each of the 10 `kanaWords` (from `KanaRule.checkWords`) is shown on a 3-s timer; the learner reads it aloud, then its clip (`core:<id>`) plays. Ungraded. At the end: `recordMilestone('kana-check')` (B) and the M0 card ("You can read a katakana menu").
- **`KanjiLesson`**:
  - **Pre-guess**, only when `unit.inferable`: show the parts and their meanings, the learner guesses (5 s, ungraded), then reveal.
  - **Parts panel:** a plain list of component kanji and named parts with their names; no colour overlays.
  - Keyword; the hook (`MnemonicEntry.meaning`, plus `sound` under the anchor word); the anchor word with audio, PitchLine and meaning.
  - **Trace** only when some component or named part is new to the learner (a component kanji not introduced, or a named part not seen in an earlier lesson). Then a **guided copy** beside the model with the learner's ink visible.
  - The "write your own" hook field stays.
  - JLPT only as a label.
- **`CoreWordLesson`** (renamed from `VocabLesson`): audio first, a pause, then the text (kana; the spelled form when it is spelled), meaning, register note and PitchLine.
- **`StagedWordLesson`** (new), "known kanji, new word": the word, its reading, audio, meaning and PitchLine. For an upgrade it says: "You know げんき — here is how it is written: 元気".
- **`GrammarLesson`** v2:
  1. A 10-s "try to say it" (English shown; ungraded; reveal).
  2. One-screen explanation.
  3. Examples 0–2 with audio, each with its phrase pitch line (`PhrasePitchLine`, when the clip has `accentPhrases`).
  4. Two ungraded comprehension taps (drills).
  5. One ungraded build (`buildItems[0]`, tiles).
- **`MemoryPass`** (new): kanji written from the write prompt (recall pad, ungraded; a miss shows the answer), core words said or typed from English (ungraded; a core word without a produce card plays its audio and asks for the meaning instead), sprint kana written from the sound. Mixed order. Reports `retrieved(cardId)` with `LearnedItem.memoryCardId`.
- `RadicalLesson` is deleted.

#### 3.2.7 Read block — `ReadingDrill.tsx`, `StoryReader.tsx`, `KanaWordsRead.tsx`

- **`KanaWordsRead`** (sprint): read each word aloud before hearing it, then play it (`play({ ref })`, the word's `kanaEx:`/`kanaRule:` clip). Ungraded. Words render through `KanaText`, so romaji appears only over untaught kana. Each word counts as a reading retrieval for its kana's read card when that kana was introduced today.
- **`ReadingDrill`** (study sentences). Per sentence:
  1. Read aloud first; the mic is optional (`Shadow`).
  2. Listen (`play({ ref: 'sentence:<id>' })`), then show the sentence's `PhrasePitchLine` (when the clip has `accentPhrases`).
  3. Guess-first gloss: 3 English options for the target (the target's `en` plus 2 from other known words), then reveal.
  4. Shadow and compare.

  Save as cloze from the first day (`SAVE_FROM_COURSE_DAY = 1`), blanking the target. It is never graded. After each sentence: `logEncounters(refs, 'sentence')` and `markSentencesShown`.
- **`StoryReader`** (new), with props `{ story: StoryEntry; step: 'rwl' | 'listen' | 'reread' | 'library'; onDone(result) }`.
  - **rwl:** plays `story:<id>#<n>` clips sentence by sentence and highlights the phrase at each `phrases` offset (the device fallback speaks one utterance per phrase). Rate: `Settings.audioRate ?? (courseDay ≤ 90 ? 0.85 : 1)`. Tokens render with `useFuriganaPolicy().forRef`. Then the gist question.
  - **listen:** the text is hidden and the audio plays, then the gist question.
  - **reread:** text only and a start/stop timer. Shows chars/min and the personal best, then `logFluency('reread', cpm, id)` and `recordStoryStep(...,'reread')`.
  - **library:** Stretch stories, where tapping a word shows its English (`loadWordInfo`).
- After each step: `recordStoryStep` and story encounters.

#### 3.2.8 Output step — `OutputStep.tsx`

```ts
export function OutputStep(props: { target: OutputTarget; partnerName: string; onDone(): void }): JSX.Element;
```

1. Prompt: "Tell {partner} something using {target}". The learner types in a `KanaInput` (IME). Kanji are not required.
2. If AI is available, not `justShowMe` and online: `aiCheck({ mode: 'prompt', text, target, ...learnerAiContext() })`.
   - The issue spans are highlighted, with a type label (Particle, Conjugation, Word choice, Kanji, Register, Other); `uncertain` shows as "maybe". The fix is not shown.
   - The learner edits **once** and resubmits.
3. Reveal: `aiCheck({ mode: 'reveal', text: edited, firstAttempt })` shows the diff (del struck through, ins in shu) plus the one-line rule.
   - Grammar-type issues are revealed automatically after one failed edit.
   - A `word-choice`-only issue is flagged first and revealed only when the learner taps "Show me".
   - `justShowMe` goes straight to reveal.
4. "This tip seems wrong" posts `/api/ai/report` (F's `aiReport`) and sets `reported`.
5. **Send.** It is never blocked: `queueChatMessage({ text, tag: 'daily' })` (F). Offline or AI-down: the check is saved as `pending` and F retries `completeOutputCheck` later. The send happens whatever the check result.
6. `saveOutput`, `logEncounters([target.ref], 'output')`, `completeOutputCheck` (card guard → cloze only on success).

Unit-test copy: no corrected text ever appears before reveal.

#### 3.2.9 Fluency and pitch — `FluencySprint.tsx`, `PitchLine.tsx`, `PitchDrill.tsx`

- **`FluencySprint`** with props `{ plan: FluencyPlan; onDone }`.
  - **reread:** StoryReader in reread mode.
  - **speed:** a 60-s round over `speedRoundCards`. Each card shows its prompt; the learner reads aloud and taps Next. Count shown. **No `gradeCard` call** (a test spies on it). `logFluency('speed', n)`.
  - **numbers:** `numbersDrill` items against a 60-s timer, typed (IME) or spoken; `logFluency('numbers', correct)`.
- **`PitchLine`** with props `{ accent: AccentInfo; kana?: string; size?: 'sm' | 'md'; particle?: boolean }`. An inline SVG height line over the moras, never H/L letters: high/low per mora from `drop` (heiban: low-high-high…; atamadaka: high-low…; nakadaka/odaka: low-high… to the drop, then low). For heiban and odaka it adds a trailing particle dot that shows the difference (`particle` draws it as a full が mora, for the drill). Snapshot tests cover the 4 types.
- **`PhrasePitchLine`** (new) with props `{ phrases: ClipAccentPhrase[] }`: one small height line per accent phrase of a sentence (moras split with `splitMoras`; mora 1 low unless the accent is 1, high up to the accent, low after it), with a gap between phrases. Shown in `ReadingDrill` after the Listen step and under `GrammarLesson` examples. Snapshot test on a fixture sentence.
- **`PitchDrill`**: `pickPitchDrill` items. Each one:
  1. Play the item's `pitch:<ref>` clip (the word followed by が).
  2. The learner taps one of the `pitchOptions(n)` diagrams, each drawn over n + 1 moras (the word plus が), so heiban (が high) and odaka (が low) look and sound different.
  3. Instant feedback, replay.
  4. `recordPitch`.

  It is shown only when F's `hasClip` is true for every item. Browser TTS is never used for the drill.

#### 3.2.10 Other C screens

- **`CanDoCheck.tsx`** (route `/cando/:id`):
  - read: show the material, then the questions.
  - listen: play the material (clip `cando:<id>`, else server TTS, else device), then the questions.
  - Grade with `gradeCanDoQuestions` and `recordCanDoAttempt(..., 'auto')`.
  - speak/write: the learner records (speech → transcript) or types. `aiCanDo` (F client) decides (`via 'ai'`). Without the AI (offline, no server, `ai_disabled`): "Needs the home server — try again when you're connected", and nothing is recorded. There is no partner path.
  - A can-do with `ready: false` shows "Check coming soon".
- **`Reading.tsx`**: the library reader for `/read` (the story list is shown by D's Library) and `/read/:storyId` (StoryReader in `library` mode for Stretch stories, or `rwl` for an Easy story outside the plan).
- **`GrammarList` / `GrammarDetail`**: v2 fields (register, prerequisites, contrast links, examples with audio, build items as practice).
- **`WritePractice`** (`/write/:char`, reached only from KanjiDetail and the kana chart; no lists, no "Needs work", no cramming): one **ungraded** recall attempt per character per day, only for a kana or kanji introduced before today (so it never adds a day-0 retrieval). After that attempt, or for any other character, it shows the stroke-order animation and the guided pad only. The day's attempts are kept in localStorage (`issho.write.tried.<day>`), which may be lost harmlessly.
- **`SessionSummary`**:
  - "You can now …": one line from the day's items. Kana: "read あかい and かお". Kanji: "write 休 and read 休み". Grammar: "say what you want to do (〜たい)".
  - Today's minutes and tomorrow's estimate.
  - On the first sitting of each ISO week, the `retention()` card ("real recall: about 1 week 91 %, about 1 month 87 %" by family; hidden when n < 10).
  - No passive item list.

### 3.3 Home, progress, onboarding and settings UI — owner D

D's files: `src/App.tsx`, `src/screens/{Today,Onboarding,Settings,LearnHub,Library,KanjiDetail,KanaChart}.tsx`, `src/components/home/**`, `src/components/ui.tsx`, `src/lib/ics.ts`, `src/styles/**`.

#### 3.3.1 Routes — `src/App.tsx`

| Path | Screen (owner) |
|---|---|
| `/` | Today (D) |
| `/welcome` | Onboarding (D) |
| `/learn` | LearnHub (D) |
| `/library`, `/library/:tab` | Library (D) |
| `/kanji/:char` | KanjiDetail (D) |
| `/kana` | KanaChart (D) |
| `/settings` | Settings (D) |
| `/session` | Session (C). Query `?mode=micro\|welcome\|makeup`, `?extra=1` |
| `/write/:char` | WritePractice (C), one character, from KanjiDetail or the kana chart |
| `/grammar`, `/grammar/:id` | GrammarList, GrammarDetail (C) |
| `/read`, `/read/:storyId` | Reading (C) |
| `/cando/:id` | CanDoCheck (C) |
| `/together` | Together (E) |
| `/together/session/:id` | TogetherSession (E). `:id` = A, B, C or monthly |
| `/chat` | Chat (E) |
| `/roleplay`, `/roleplay/:id` | RolePlayList, RolePlayRun (E) |
| `/quiz/:id` | QuizRun (E) |

The lazy-loading, route announcer and error boundary pattern stays.

#### 3.3.2 Today — `Today.tsx` and `components/home/*`

Top to bottom:

1. **Header**: date and greeting (unchanged).
2. **`StreakCard`** (v2, from `streak()`):
   - "12 days studied this month · longest 21".
   - The current streak only when `alive`.
   - The week dots use the status colours: goal = filled, done = ring-filled, rest = dash, repaired = dot, travel = plane-free neutral dash, today = ring.
   - It never renders a broken streak or a count of missed days. Test: a broken streak is not rendered.
3. **Prompts**, at most one at a time, in this order:
   - (a) `RestTokenPrompt` when `offerTokenFor` is set: "Use a rest token for yesterday? (1 left this week)" → `spendRestToken`.
   - (b) `ComebackCard` when `comebackOffer().kind !== 'none'`: "Welcome back — a 3-minute warm-up?" → `/session?mode=welcome`. It is an offer: the PlanPanel below still shows the normal plan. For a fresh start it adds: "Fresh start on Monday 20 Oct — catch-up first, new items after", which calls `chooseFreshStart`.
   - (c) `TravelBanner` while `travelUntil ≥ today`.
   - (d) The plan-review prompt on `Settings.planReviewDays`.
   - (e) A make-up offer when `makeupOffer` (a missed day with no token left, today's goal met): "Make up Tuesday: 10 more minutes before Thursday 4 a.m. keeps your streak" → `/session?mode=makeup`. Before today's goal is met, a quiet line says the make-up opens after today's session.
   - On or after `Settings.freshStart`: a fresh-start header above the prompts ("A fresh start — this week begins today"), and StreakCard's week dots start at that date.
4. **`PlanPanel`** (replaces `SessionPanel`):
   - "About N min today · tomorrow about M" ("About N min left today" when `plan.partOfDayDone`).
   - Tiles: reviews (hidden during catch-up), new items, read and listen.
   - The `offerExtraKanji` prompt: "Add one more kanji today?" → `/session?extra=1` (Session plans with `{ extraKanji: true }`).
   - "Start session" → `/session`. "Short on time? 3-minute session" → `/session?mode=micro`.
   - The brake shows one quiet line: "New items are lighter today while reviews settle".
   - No "N/2,136" and no card counts during catch-up.
5. **`TogetherTodayCard`**, imported from E's `src/components/together/TogetherTodayCard.tsx` (props: none). Shown on the scheduled day.
6. **`NewToday`**: tiles for today's planned items. Kanji show the character and keyword; core words show kana and English; grammar shows the pattern.
7. **Partner card**: effort only — days studied, minutes, together sessions and stamps. Accuracy shows only when the partner's `accuracyShared` is true.
8. **`ChapterLine`**: `chapterInfo(...)`, linking to `/learn`. This replaces PhaseLine and `phaseProgressText`. `minutesForPace` is deleted.
9. **Footer** (unchanged).

#### 3.3.3 Onboarding — `Onboarding.tsx`

The steps stay as history entries (the existing pattern):

1. `welcome`
2. `name`
3. **`minutes`**: 20 / 25 / 30 / 40 with simulated notes. 20: "about 165–175 kanji, 1,300 words in a year". 25 (default): "about 270–310 kanji, 1,550 words in a year". 30: "about 350 kanji, 1,800 words". 40: "about 530 kanji, 2,400 words". These figures come from the final-plan simulation (`scratchpad/final/simF5.mjs`, 2 seeds).
4. **`kana`**: "Do you already know hiragana / katakana?" For each script answered "yes", a **placement check** (`PlacementCheck`, D): 20 kana from `placementSet`. Each plays its sound (`play({ ref: 'kana:<c>' })`) and the learner writes it on a recall WritingPad. Correct = `matchCharacterUnordered(...).ok`. Then `applyPlacement(script, correct)`. The result screen shows "18/20 — you're past hiragana" or "Let's do the 14-day sprint".
5. **`habit`**: the if-then cue ("After I ___ at ___, I open Issho" + time) and the coping plan.
6. **`together`**:
   - Slots: 3 sessions with weekday and time; Tue/Thu/Sun 20:00 pre-filled.
   - A shared goal with a target date.
   - The partner rules card: one signal (もう一度？) and pointing at the word; never explain grammar to each other; turns alternate.
   - If paired, saved through F's `postTogetherEvent({ type: 'slots' })` and `{ type: 'goal' }`.
7. **`reminders`**: the "Add to calendar" button downloads `issho-reminders.ics` from `buildIcs`. It works offline.
8. **`connect`** (unchanged).

At the end: `planReviewDays(firstDay)` is saved, and `onboarded: true`.

#### 3.3.4 `src/lib/ics.ts` (D)

```ts
export interface IcsInput {
  /** Daily cue reminder ('HH:MM'). */
  cue?: HabitCue;
  slots: readonly TogetherSlot[];
  /** First day of the reminders ('YYYY-MM-DD'). */
  start: string;
  name: string;
  partnerName?: string;
  /** For stable UIDs. */
  uidSeed: string;
}
/** RFC 5545 text, CRLF line endings, lines folded at 75 octets. Floating local times (no TZID, no Z).
 *  The cue is a DAILY event ("Issho — <cue text>", 10 min) with a 0-min VALARM.
 *  Slots: one WEEKLY event per session letter (RRULE:FREQ=WEEKLY;BYDAY=TU…) at its time, 15 min, VALARM -PT10M.
 *  No guilt copy. */
export function buildIcs(input: IcsInput): string;
export function downloadIcs(text: string, fileName?: string): void;
```

Test: slots Tue 20:00, Thu 20:00, Sun 19:30 → three VEVENTs with `RRULE:FREQ=WEEKLY;BYDAY=TU`, `…=TH`, `…=SU`, `DTSTART:20261020T200000` and so on.

#### 3.3.5 Settings — `Settings.tsx`, `components/home/Settings*.tsx`

- **Study:**
  - Daily minutes (20/25/30/40, with the simulated notes).
  - Write list: a slider 0–2,136 (default 500) showing "N kanji kept in handwriting" and the pinned count. On change, call `syncWriteRetirement`.
  - Receptive retention: 0.85 / 0.88 / 0.90 / 0.93 with a note ("lower = fewer reviews of reading/listening cards; handwriting and production stay at 0.90"). Values above 0.95 can never be chosen.
  - Hands-busy mode.
  - Furigana: always / for words not yet solid / never.
  - Audio on/off, audio speed (Auto, 0.85, 1.0), and the device voice for the last-resort fallback.
  - Writing hand.
  - Placement re-check (re-runs `PlacementCheck` for a script).
  - Removed: new items/day, max reviews, romaji, "I know kana" toggles.
- **Habits:** cue and time, coping plan, plan rest tokens for days ahead (shows 2 a week), travel/sick mode (until date), and re-download reminders (.ics).
- **Together:** slots and shared goal (posted as events when paired), share accuracy with partner (default off), pairing (unchanged).
- **Data:**
  - Backup and restore (B's v2 backup). The import notice says when a v1 file's progress was dropped.
  - Reset progress, which clears every progress table, including encounters, shownSentences, staged, stories, restTokens, outputs, canDos, milestones, pitchBoxes, fluency, partnerQuizzes and togetherPlans. It keeps settings, chat, outbox and togetherOutbox.
- **About:** credits — KanjiVG; KANJIDIC2/JMdict; "VOICEVOX:No.7" and "VOICEVOX:青山龍星" (from `manifest.credits`, with these two as the fallback) and a link to voicevox.hiroshiba.jp.

#### 3.3.6 Learn hub, library and kanji detail

- **`LearnHub`**:
  - The chapter card (`chapterInfo`, the current unit's title as its theme) with what the chapter taught (`chapterItems`: its kanji, words and grammar points, expandable), and the same list for earlier chapters.
  - The season finale card when `seasonFinaleDue`: the season's numbers and a link to the showcase in this week's Session C (`/together/session/C`); when unpaired, a link to re-run a passed can-do.
  - The **unit** card (current unit title, its can-dos with status: passed, available → `/cando/:id`, "coming soon").
  - The **coverage** card ("You can decode about 79 % of the words in a typical text", `coverageShare(kanjiCanRead)`; below 100 kanji: "At 100 kanji: about 74 %") plus the known-word count.
  - The **retention** card (weekly).
  - **Hours** (`hoursTotal`) against `HOUR_BENCHMARKS`.
  - **Reading speed** (latest/best chars/min).
  - Milestones M0–M4 as targets.
  - No 2,136 bar.
- **`Library`**, with tabs:
  - Kanji (grid by chapter; each tile shows status: learned/can write, retired = "reading only", pinned, next up).
  - Words (core + kanji words introduced, searchable).
  - Grammar → C's GrammarList.
  - Stories (Easy, Stretch with "tap words for English", and Read; each links to `/read/:id`).
- **`KanjiDetail`**:
  - The parts panel (components + named parts with names).
  - Keyword and readings (no romaji).
  - Stroke order.
  - The anchor and staged words, plus related words that share the kanji (from words.json, known first), each with audio and `PitchLine` when accent exists.
  - The mnemonic plus write-your-own.
  - "Keep in handwriting" pin (`setPinned`).
  - "Practice writing" → `/write/:char` (C's single-character recall, §3.2.10).
  - Card status.
  - JLPT as a label.
- **`KanaChart`** is the only place romaji is shown after the sprint. Tapping a kana plays `kana:<c>` (all 208 have clips) and offers "Practice writing" → `/write/:char`.

#### 3.3.7 `src/components/ui.tsx`

`Ruby` takes `show: 'all' | 'none' | ((base: string, reading?: string) => boolean)` and passes the segment reading as the second argument. Existing callers keep working. Add icons for: rest, travel, repair, pitch and quest.

### 3.4 Together client and server — owner E

E's files: `src/screens/{Together,TogetherSession,Chat,RolePlayList,RolePlayRun,QuizRun}.tsx`, `src/components/together/**`, `server/src/**` (except F's `tts.ts`, `tts-routes.ts`, `config.ts`, `index.ts`, `static.ts`, `precompress.ts`) and `server/test/**` (except F's `tts.test.ts`, `config.test.ts`, `static.test.ts`).

#### 3.4.1 Together hub — `Together.tsx`

- **This week:** the three slots with day and time, the monthly session when `plan.monthly`, and the status of each session (planned, today, done). The data comes from `loadWeekPlan({ state, partner })` (B), with `state` from F's `useTogetherState()` and `partner` from the household's `MemberProgress` (E's `household.ts`). B never reads `src/sync`.
- **Couple quest card** (`CoupleQuestCard`): "Quest: 4 of 5 days each · sessions A and B done, C left · reserve available". From `HouseholdResponse.quest`.
- **Quest streak:** the v1 `WeekCard` "N days" shared-streak stat is replaced by `questStreakWeeks` ("Quest met 3 weeks running"). `HouseholdResponse.sharedStreak` is never rendered by v2.
- The shared weekly story ("Read during the week: <title>") with a link to `/read/:id`.
- Partner effort (the existing week chart: minutes, days studied; accuracy only if shared).
- Check-in history (last 8 weeks).
- Chat entry and the free role-play list.
- **Offline:** the plan still shows, built from the cached state. Server-only parts show "Needs the home server".

`TogetherTodayCard` (exported for D's Today; no props; it reads F's state and E's household itself): shown when a session is scheduled today or is overdue this week. "Session A tonight · 20:00 · Quiz & conversation" → `/together/session/A`. On the monthly weekend: "Monthly session this weekend · quiz, goals, skit" → `/together/session/monthly`.

#### 3.4.2 Session runner — `TogetherSession.tsx` (route `/together/session/:id`)

**Modes.**
- **Duo:** both phones are online and paired. State syncs through the `live` WS event (`TogetherLiveState`) via F's `sendLive` / `onLive`. The phone that opens first creates `sessionId` and is the **opener** (`TogetherLiveState.opener`); the other joins through an invite banner (the role-play invite pattern).
  - The opener sends `plan` (a `TogetherRunPlan` copied from its week plan) with its first live event. The joiner runs exactly that plan (script, stage, task, role-play, story, capstone, showcase), never its own week plan, so the two phones cannot diverge.
  - Step, turn, index and timer come from the opener. Either phone may send a `next` intent; the opener applies it and broadcasts the new state.
  - Quiz steps: each answerer's phone builds its own pool, calls `createQuiz`, and adds `quizIds[myMemberId] = quiz.id` to a live event. Receivers merge `quizIds` (union), so the asker's phone knows which quiz to show and grade.
- **Pass-and-play:** one phone, used when the partner is offline or not paired.

At the start, a "Together rules" card (`rules.tsx`) is shown the first 3 times, then it collapses: one signal (もう一度？) and point at the word; no explaining grammar to each other; turns alternate; corrections come from the AI, privately.

**Crediting, once per session and date.** At the end of any session, the phone that ran it (both phones in duo) calls `postTogetherEvent({ type: 'session-done', session, date, minutes })` (F, queued offline) and `creditTogetherSession(session, minutes, date)` (B). The server stores the first `session-done` per `(week, session, date)` and broadcasts `{ type: 'together' }` to every device of every member, the sender's included. F's together sync then calls `creditTogetherSession` for every session in the state dated today or yesterday. Crediting is idempotent on `DayRecord.together`, so a member is credited once however many events, refreshes or phones report the session.

**Session A — quiz and core conversation (about 15 min).**

1. **Partner quiz, about 3 min each way.**
   - *Duo.* Each phone runs `buildQuizPool('partner')` (B) and posts `createQuiz({ toMemberId: partner, kind: 'partner', items })`. The answerer's phone shows only "Your turn: answer out loud or write" plus a WritingPad for `write` items (paper is allowed). The asker's phone shows `prompt` and `answer` with ✓ / close / ✗. Verdicts are posted with `submitQuizResult(id, { correct, total, missed, verdicts })`. The answerer's phone applies them through `applyPartnerVerdicts(quiz)` (B), triggered by the `quiz` WS event or by a refresh; it is applied once (§3.1.14).
   - *Pass-and-play.* The owner's pool comes from `buildQuizPool`. The partner holds the phone as asker, and the verdicts are applied at once with `applyLocalVerdicts`. For the other direction (the partner answers), the phone uses the partner's newest unanswered `partner` quiz in the inbox (`getQuizzes`) when there is one; its verdicts are posted so the partner's phone applies them later. With no such quiz, the phone builds a practice-only pool from the partner's `MemberProgress.recentKanji` (write items, no FSRS effect), or skips that direction offline.
   - The grading window lives in `applyPartnerVerdicts`. A card due within ±2 days is graded (right = Good, close = Hard, wrong = Again). Any other card is logged only as an exposure.
2. **Teach-me turn.** `teachMeKanji()` (B) for the answerer. Notes are hidden while they explain the parts and the hook; "Show reference" then reveals the parts panel, hook and anchor word.
3. **Core conversation.** `plan.conversation` (scriptId, stage) runs in `ConversationStage`, a `RolePlayRun` variant.

| Stage | What happens |
|---|---|
| S1 | Listen to the model audio (two voices: `rp:<id>#<n>` clips, role a = `f`, role b = `m`) and shadow together, line by line |
| S2 | Perform from the Japanese only; the English is behind a tap |
| S3 | Swap roles |
| S4 | Keyword cue cards only (`line.cue`, or the first 3 English words when `cue` is empty) |

   At the end both mark "smooth" or "again next time". Smooth from both posts `{ type: 'smooth', scriptId, stage, both? }`: two events in duo, or one with `both: true` in pass-and-play. The server advances the stage when every member has marked it (§3.4.6). English is hidden in S2–S4. While the script's unit is above the settled unit, the week plan keeps the stage at 1 (listen and shadow) whatever the server stage is.

**Session B — task (about 15 min).**

1. **Task card** (`TaskCardView`), from `plan.task`, i.e. a settled unit → `UnitSpec.task`:
   - the can-do text, the goal plus the outcome question, and a register note;
   - 5–8 target items from `taskTargets(task.targets, myRecentItems, partner.recentItems)` (B): the authored targets either partner introduced 2–21 days ago, topped up with each partner's own items of that age, never today's items; each partner's own items highlighted on their phone;
   - the info-gap half for this partner (A or B). In duo each phone shows its own half; in pass-and-play the halves sit behind "Partner A only" and "Partner B only" taps.
2. **Silent planning:** a 60–90 s timer (`PlanningTimer`; 90 s by default, skippable after 60 s).
3. **Run the task.** When the AI is available and `task.aiRole` is set, the AI plays the third role:
   - `aiRolePlay({ taskId, aiRole, goal, history, ...context })` (F client);
   - its replies are spoken through `play({ text: reply, voice: 'm' })` (server TTS → device);
   - the learners answer by voice (speech recognition transcript) or by typing.
   Without the AI, or offline, it runs the **scripted** version (`task.scripted`), read in roles.
4. **Swap** roles and run it again.
5. **Outcome check:** the outcome question, answered together.
6. **Private recap**, on each phone, from that member's own lines (transcripts or typed). `aiRecap` gives 1–2 points (quote → corrected + rule). Each point runs `createGuardedCloze(..., 'recap')` (B); only points that pass the guard become cards. Offline: there is no recap and nothing is queued.
7. `postTogetherEvent({ type: 'task-done', taskId, date, repeat })`. The next week's plan schedules the repeat with `twist` 2–7 days later (B's `buildWeekPlan`). The repeat shows "Twist: …" on the card.

Without a task (`plan.rolePlayId`: no settled unit yet, as in weeks 1–3, or every task run or not `ready`), Session B runs that script at stage 1 (listen, shadow, then read in roles with the English shown): a free role-play when one is eligible, else the next unit's core conversation. Session B never posts `smooth`, so it does not move Session A's stages.

**Session C — story, game and check-in (about 15 min).**

1. **Story talk (about 3 min).** The shared weekly story (`plan.storyId`): the title, 3 prompt questions in English, and a "Listen again" button.
2. **4/3/2 retell (about 4 min).** Each partner retells the story, or "our week", three times with timers of 90, 60 and 45 s (`Retell`), keeping the same content. Turns alternate.
3. **Partner dictation (about 3 min).** `buildQuizPool('dictation')` per answerer, posted as a `dictation` quiz (`quizIds` in duo). The asker reads each anchor word's kana aloud; the answerer writes the word in kanji on the phone (WritingPad recall) or on paper; the asker gives the verdict. The verdict grades the kanji's write card when it is within ±2 days of due, otherwise it is logged as an encounter (§3.1.14). Then swap.
   - **Showcase** (`plan.showcase`, the week a season finale is due), instead of the dictation: each partner picks one can-do they passed this season and runs its check again for the other to watch (`CanDoCheck` in showcase mode: nothing is recorded, nothing is graded by the partner).
4. **Weekly check-in (about 5 min).**
   - Auto-filled counts (`weeklyCheckinCounts`).
   - Each partner ticks one can-do they managed. That ticks only the check-in; awarding a can-do still needs its own check (read/listen questions, or the AI for speak/write).
   - Next week's slots and planned rest tokens (`spendRestToken` for future days).
   - Saved as `{ type: 'checkin' }`, and `{ type: 'slots' }` when they changed.

**Monthly session** (`/together/session/monthly`, its own session on the month's first weekend; it posts `session-done` with session `monthly`).

1. A 20-item mixed quiz each way (`buildQuizPool('monthly')`, same asker/answerer flow, about 8 min).
2. Goal setting with a fresh-start framing ("New month, fresh start: what's our goal for November?"), saved as `{ type: 'goal' }`.
3. **Capstone** when `plan.capstoneUnit` is set (about 10–15 min):
   - Co-write a skit with a checklist of the unit's `capstone.structures` (≥ 6) and ≥ 8 lines each.
   - Optional AI check of each line (`aiCheck` reveal), privately per partner.
   - Perform it from memory.
   - Post `{ type: 'capstone-done' }`. No portfolio recording in v2.

#### 3.4.3 Quiz screen and role-play screens

- **`QuizRun.tsx`** handles kind `kanji` (v1 flow, kept for old inbox items) plus `partner`, `dictation` and `monthly`, in the asker and answerer views described above. `QuizSender` (send hardest kanji) is removed from the Together hub.
- **`rolePlay.ts`** keeps `runReducer` and adds the stage reducer:

```ts
export type Stage = 1 | 2 | 3 | 4;
export interface StageState { scriptId: string; stage: Stage; smooth: Record<string, boolean> /* memberId → marked */; finished: boolean }
/** Advances only when every member in `members` marked smooth; stage 4 smooth → finished. */
export function stageReducer(s: StageState, a: { type: 'smooth'; memberId: string; members: readonly string[] } | { type: 'again' } | { type: 'sync'; stage: number; smooth: readonly string[] }): StageState;
export function englishHidden(stage: Stage): boolean;   // stage ≥ 2
export function swapRoles(stage: Stage): boolean;       // stage === 3
export function cueOnly(stage: Stage): boolean;         // stage === 4
```

- `levelForPhase` is removed. The free list (`RolePlayList`) shows `eligibleRolePlays(scripts, coreConversationIds, introducedForBoth, settledUnit)` (B). `coreConversationIds` = the ids named by `UnitSpec.conversation`; `introducedForBoth` uses this phone's items and the partner's `coreReached`/`grammarReached` (this phone alone when unpaired).

#### 3.4.4 Chat composer — `Composer.tsx`, `ai.ts`

- **Two-step tips**, the same flow as the output step:
  1. "Check" → `aiCheck({ mode: 'prompt' })` → spans plus type labels, no fix.
  2. The learner edits once, then reveal → diff plus rule.
  The tip bubble says "Only you can see this tip". At most 2 issues.
- Sending is never blocked, offline included.
- "This tip seems wrong" → `aiReport`.
- Messages tagged `daily` show a small "Today's sentence" label.
- **The partner's reply counts as their output.** When the member replies to the partner's `daily` message of today (the composer is opened from that message's "Reply" action) and today's `output` step is not in `DayRecord.steps`, the Composer runs the output-step check on the reply: prompt → one edit → reveal (or reveal at once with `justShowMe`; queued as `pending` offline). The reply is sent tagged `daily` (never blocked), then `saveOutput` (target: the partner's message's target when known, else the reply's first introduced word), `logEncounters([target.ref], 'output')`, `completeOutputCheck` and `finishStep('output')`. That day's Session then skips its output step. Composer test: replying to a daily message with the output step open records the output and `finishStep('output')`; a reply after the output step is done is a normal message.
- `TranslateSheet` hides `romaji` after the sprint.

#### 3.4.5 Server migrations — `server/src/db.ts` (append migration 4; never edit shipped entries)

```sql
ALTER TABLE day_stats ADD COLUMN minimum_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE day_stats ADD COLUMN together_minutes REAL NOT NULL DEFAULT 0;
ALTER TABLE day_stats ADD COLUMN rest_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE day_stats ADD COLUMN accuracy_shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_day_stats ADD COLUMN minimum_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_day_stats ADD COLUMN together_minutes REAL NOT NULL DEFAULT 0;
ALTER TABLE device_day_stats ADD COLUMN rest_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_day_stats ADD COLUMN accuracy_shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_stats ADD COLUMN progress TEXT;          -- JSON MemberProgress
ALTER TABLE device_stats ADD COLUMN progress TEXT;
ALTER TABLE quizzes ADD COLUMN kind TEXT NOT NULL DEFAULT 'kanji';
ALTER TABLE messages ADD COLUMN tag TEXT;
CREATE TABLE together_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  week TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event TEXT NOT NULL,                                       -- JSON TogetherEvent
  UNIQUE (member_id, client_id)
);
CREATE INDEX together_events_week ON together_events(week);
CREATE TABLE ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  report TEXT NOT NULL                                       -- JSON AiReportRequest
);
```

The merge of a member's devices takes the MAX per day of every new column, as for the existing ones. A v1 row reads `minimum_done` as `session_complete` (the merge sets `minimum_done = MAX(minimum_done, session_complete)`).

#### 3.4.6 Server routes

| Route | Change |
|---|---|
| `GET /api/health` | Adds `ttsEnabled: ctx.tts?.available() ?? false`. The value is cached by F's service and never blocks |
| `POST /api/stats` | Accepts `phase` as optional, the optional `progress` (`readyStories` max 60, `recentKanji` max 20, `recentItems` max 20, `settledUnit` 0–25, `coreReached`/`grammarReached` ≥ 0; unknown fields dropped) and the optional new `DayStats` fields. `days` max stays 62 |
| `GET /api/household` | Adds `progress` per member, `quest` and `questStreakWeeks`. `sharedStreak` stays for v1 clients (consecutive days on which every member had `minimum_done` or `session_complete`, or a together session, ending today or yesterday); v2 clients do not render it |
| `POST /api/quizzes` | `kind` (default `kanji`). `kanji`: items `{char}` only (as now, ≤ 50). `partner`: ≤ 10 `PartnerQuizItem`. `dictation`: ≤ 5, kind `write`. `monthly`: ≤ 20. Item key ≤ 80, prompt/answer ≤ 200 |
| `POST /api/quizzes/:id/result` | `verdicts` is required for `partner`/`dictation`/`monthly`: each key must be an item key, one verdict per item; `correct` = #right, `total` = #items |
| `GET /api/quizzes` | Includes `kind` |
| `POST /api/messages` | Optional `tag: 'daily'`, stored and returned |
| `GET /api/together` | `TogetherState`, folded from `together_events` (below) |
| `POST /api/together/events` | Validates the `TogetherEvent` (zod). Idempotent on `(member, clientId)`: a resend returns 200 and the current state. Stores the event, broadcasts `{type:'together'}` to every member with no exception (`ctx.hub.broadcast(event)` without `exceptMemberId`, so the sender's other devices refresh too), returns 201 with the state |
| `POST /api/ai/check` | v2 (§3.4.7) |
| `POST /api/ai/roleplay`, `/api/ai/recap`, `/api/ai/cando` | New. Same guard: 503 `ai_disabled`, 30/min per member |
| `POST /api/ai/report` | Stores a row in `ai_reports` → 204 |
| `POST /api/tts` | Registered from F's `ttsRoutes(api, ctx)` inside the authenticated block (JSON body; the text never appears in the URL, so the request log never holds it) |
| WS | The `live` client event is relayed to the other members as `{type:'live', memberId, state}`, exactly like `roleplay` |

**Folding `together_events` into `TogetherState`** (pure; `server/src/together.ts`):

- Process events in id order.
- `slots`: latest. `goal`: latest.
- `smooth`: add the member to `smooth[scriptId]` when `event.stage === (stages[scriptId] ?? 1)` (mind the parentheses: without them `??` never applies and the first smooth of a new script would never count). When every current member is in the set, or the event had `both: true`, then `stages[scriptId] += 1` (5 = finished) and the set is cleared.
- `session-done`: an entry in `sessions`, deduplicated by `(week, session, date)` (the first one wins).
- `task-done`, `checkin` and `capstone-done` are appended.
- Windows: sessions in the last 12 weeks, tasks in the last 60 days, check-ins in the last 26 weeks.

**Couple quest** (pure; `server/src/days.ts` `coupleQuest`):

```ts
export function coupleQuest(input: {
  week: string;                                   // Monday
  today: string;
  members: string[];
  minimumDates: Record<string, Set<string>>;      // memberId → dates with minimum_done or session_complete
  togetherDates: Set<string>;                     // dates with any together session (counts for every member)
  sessionsDone: ReadonlySet<TogetherSessionId>;   // session ids with a session-done this week
  reserveUsedEarlierThisMonth: boolean;
}): CoupleQuest;
```

- `togetherSessions = min(3, |sessionsDone ∩ {A, B, C}| + (sessionsDone has 'monthly' && |sessionsDone ∩ {A, B, C}| < 3 ? 1 : 0))`. The monthly session stands in for one missing letter and never adds a count beyond that, so two evenings never make three sessions.
- `minimumDays[m]` = count of the week's dates in `minimumDates[m] ∪ togetherDates`.
- `shortfall = Σ_m max(0, 5 − minimumDays[m]) + max(0, 3 − togetherSessions)`.
- `met = shortfall === 0 || (shortfall === 1 && !reserveUsedEarlierThisMonth)`.
- `reserveUsed = (shortfall === 1 && met)`.
- The reserve is **one per calendar month** (the month of the week's Monday). Earlier weeks of the month are evaluated in order, so "used earlier" is deterministic.
- `questStreakWeeks` walks back from this week. This week counts only if `met`; otherwise counting starts at last week.

Tests: 5+5 minimum days and A, B, C → met; 4+5 and A, B, C → met with the reserve; 4+4 and A, B, C → not met; a second reserve in the same month → not met; A, C and monthly → 3 sessions; A, B, C and monthly → still 3; A twice on two dates → 1.

#### 3.4.7 AI v2 — `server/src/ai.ts`

- `MAX_TIPS = 2` everywhere.
- Every system prompt receives the learner context: known grammar ids with titles (the server loads `public/data/content/grammar.json` from `STATIC_DIR`/data, or the repo path in dev; missing → ids only), known words (≤ 3,000) and known kanji, plus the register (plain between spouses). It must say when it is unsure (`uncertain: true`), and it prefers explaining over rewriting.
- The learner's text sits inside `<message>` / `<context>` tags marked as data, not instructions (as now).
- **Check — prompt mode** (zod schema): `{ ok, issues: [{ quote, type, uncertain, hint }] }`, sliced to 2.
  - The server locates each `quote` in the text with `indexOf` to fill `start`/`end` (null when not found).
  - It returns `corrected: ''`, `correctedRuby: ''`, `diff: []`, `rule: ''`, `grammarUsed: []`, `words: []` and `tips: []`.
  - The prompt forbids putting the fix in `hint`. The server also blanks any `hint` that contains the corrected substring.
- **Check — reveal mode:** `{ ok, issues, corrected, correctedRuby, rule, grammarUsed, words: [{surface, lemma, reading}] }`.
  - The server computes `diff` with a character LCS between `text` and `corrected` (merging consecutive ops).
  - `tips` (legacy) = issues mapped to `{ original: quote, suggestion: '', explanation: hint }`.
  - Legacy requests without `mode` get reveal.
- **Roleplay:** `{ reply (ruby), en, done }`. Short lines (≤ 25 characters), only known grammar where possible, in character, never correcting.
- **Recap:** `{ points: [{ quote, corrected, rule, grammarUsed, words }], praise }`, at most 2 points, only real errors.
- **Can-do:** `{ met: boolean[] (one per rubric item), feedback }`; `passed = met.every(Boolean)`, computed by the server.
- Deadlines and error mapping stay as they are (`DEADLINE_MS` 40 s; AiError codes).
- Server tests use a stubbed client. They check: prompt mode never returns corrected text, and ≤ 2 issues even when the model sends 3; reveal returns a diff; quote location; schema rejection → `ai_bad_output`.

### 3.5 Audio playback, server TTS, sync and platform — owner F

F's files: `src/speech/**`, `src/sync/**`, `src/components/SpeakButton.tsx`, `src/components/UpdatePrompt.tsx` and `UpdatePrompt.test.tsx`, `src/main.tsx`, `src/devSilence.ts`, `src/test-setup.ts`, `vite.config.ts`, `package.json`, `.gitignore`, `.dockerignore`, `docker-compose.yml`, `Dockerfile`, `server/src/{tts.ts,tts-routes.ts,config.ts,index.ts,static.ts,precompress.ts}`, `server/.env.example`, `server/test/{tts,config,static}.test.ts`.

#### 3.5.1 Playback API — `src/speech/audio.ts`

```ts
export type AudioSource =
  | { ref: string }                          // clip ref (§2.2): 'core:cw-0001', 'story:st-l0-07#3', 'kana:あ' …
  | { text: RubyText; voice?: VoiceId };     // any Japanese text (ruby markup gives exact readings)
export interface PlayOptions {
  voice?: VoiceId;                            // default 'f' (clip refs carry their own voice)
  /** Default: the automatic rate (setDefaultAudioRate). */
  rate?: number;
  signal?: AbortSignal;
  /** Story sentences: called with each phrase index as playback reaches its offset. */
  onPhrase?: (index: number) => void;
  /** Phrase texts, for the device fallback (one utterance per phrase) and for clips without offsets. */
  phrases?: readonly RubyText[];
  /** For { ref } sources without a clip: the text to synthesize instead. */
  fallbackText?: RubyText;
}
export type PlayVia = 'clip' | 'server' | 'device' | 'none';
export interface PlayResult { via: PlayVia; ms: number; interrupted: boolean }
/** Resolution: clip by ref → clip by byText[clipTextKey(voice, text)] (plain kanji text without ruby has key reading ''
 *  and so hits only the unambiguous plain index, §2.2; a text with a reading never gets a clip of another reading) →
 *  server TTS (paired, health.ttsEnabled, online) → device speechSynthesis (tts.ts speak) → none. Cancels whatever is
 *  playing. Never rejects. */
export function play(source: AudioSource, opts?: PlayOptions): Promise<PlayResult>;
export function stopAudio(): void;
/** A verified pre-generated clip exists (the pitch drill only runs on these). */
export function hasClip(source: AudioSource): Promise<boolean>;
/** Settings.audioRate when set, else 0.85 until course day 90, then 1. Session and Today call it after planning. */
export function setDefaultAudioRate(courseDay: number, audioRate?: number): void;
/** Packs to keep warm, always including 'misc': sprint → ['kana', 'u01', 'misc']; after it → current and next unit
 *  ('u03','u04'), current and next kanji chapter ('c05','c06') and 'misc'. */
export function packsFor(p: { sprint: boolean; unit: number; chapter: number }): string[];
/** Fetches the packs' clips into the runtime cache (4 at a time, skipping cached ones; stops when offline or saveData). Returns the number fetched. */
export function prefetchPacks(packs: readonly string[], opts?: { max?: number; signal?: AbortSignal }): Promise<number>;
/** iOS: unlock HTMLAudioElement playback on the first gesture (plays 100 ms of silence). Returns cleanup. */
export function installAudioUnlock(): () => void;
/** React: { play, stop, playing, via }. */
export function usePlayback(): { play: typeof play; stop: () => void; playing: boolean; via?: PlayVia };
```

Behaviour:

- **One element.** A single shared `HTMLAudioElement` with `preservesPitch = true` and `playbackRate = rate`.
- **Clips.** Fetched with `fetch(audioUrl(file))`; the service worker answers with CacheFirst. The page plays a Blob URL, which avoids Range-request problems on iOS.
- **Phrase timing.** Story phrase offsets are compared with `currentTime·1000`. Media time already includes the rate, so no extra scaling is needed.
- **Server TTS.**
  - `fetchTts({ text, voice })` (client.ts, `POST /api/tts` with a JSON body) returns a WAV Blob.
  - The Blob is cached in Cache Storage `issho-tts-v1` under the synthetic URL `/__tts/<voice>/<sha-256 hex of the text>` (the text itself never becomes a URL), capped by **bytes**: at most 20 MB in total (a WAV is about 50–150 KB). An index in localStorage `issho.tts.index` (`[key, bytes, at][]`) drops the oldest entries while the total is over 20 MB; a lost index just rebuilds from `cache.keys()` sizes on the next write.
  - Errors: a 503 marks TTS unavailable for 5 minutes; a 429 falls through to the device voice.
- **Device fallback.** `speak(rubyText, { rate })` from `tts.ts` (kept), one utterance per phrase when `phrases` is given. The device voice is never used by the pitch drill.
- **Feature detection.** `typeof caches === 'undefined'` (jsdom, old browsers) skips caching.
- **Dev silence.** `silenceInDev()` mutes media elements (unchanged); `audio.ts` needs nothing special.

Also in `src/speech`:

- **`compare.ts`** adds `spokenMatches(transcript: string, expected: { written?: string; readings: readonly string[] }): boolean`. It is true when the NFKC transcript, without punctuation, equals `written` or any reading (kana folded), or when `similarity(...)` ≥ 0.75 against either.
- **`tts.ts`** stays the device engine.
- **`SpeakButton`** calls `play`. It takes `source` or `text`, `compact`, `rate` and `label`.

#### 3.5.2 Service worker and static serving — `vite.config.ts`, `server/src/static.ts`

- **Precache** `globPatterns` stays `['**/*.{js,css,html,svg,png,json}']`. That includes `audio/manifest.json` but no `.m4a`.
- **`runtimeCaching`** adds:

```ts
{
  urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/audio/') && url.pathname.endsWith('.m4a'),
  handler: 'CacheFirst',
  options: { cacheName: 'issho-audio-v1', expiration: { maxEntries: 15000 }, cacheableResponse: { statuses: [200] } },
},
```

- `navigateFallbackDenylist` adds `/^\/audio\//`.
- **`static.ts`**:
  - `/audio/**/*.m4a` gets `cache-control: public, max-age=31536000, immutable` (the names are content hashes);
  - `/audio/manifest.json` gets `no-cache`;
  - unknown `/audio/*` and `/data/*` files return 404, never the SPA `index.html`.
- **`precompress.ts`** never compresses `.m4a`.

#### 3.5.3 Server TTS — `server/src/tts.ts`, `server/src/tts-routes.ts`, `server/src/config.ts`, `server/src/index.ts`

```ts
// tts.ts
export interface TtsService {
  /** Last health check (GET /version, refreshed in the background at most every 60 s). Never blocks. */
  available(): boolean;
  /** WAV for the text. Throws TtsError(503, 'tts_unavailable') when the engine fails, TtsError(400, 'bad_text'). */
  synthesize(text: string, voice: VoiceId): Promise<{ wav: Buffer; cached: boolean }>;
  close(): void;
}
export class TtsError extends Error { readonly status: number; readonly code: string }
export function createVoicevoxTts(opts: {
  baseUrl: string;            // VOICEVOX_URL, e.g. http://voicevox:50021
  cacheDir: string;           // DATA_DIR/tts
  maxCacheMb: number;         // TTS_CACHE_MB, default 300
  fetch?: typeof fetch;
  now?: () => Date;
}): TtsService;

// tts-routes.ts
/** POST /api/tts with a JSON TtsQuery body (inside E's authenticated block). zod: text trimmed 1–TTS_MAX_CHARS,
 *  voice 'f'|'m' (default 'f'). Never logs the text (the request log has only the URL, which holds no text).
 *  Own RateLimiter: 120 calls/min per member → 429 rate_limited. 200 audio/wav, cache-control: private, max-age=604800. */
export function ttsRoutes(app: FastifyInstance, ctx: AppContext): void;

// config.ts additions
//   voicevoxUrl: string | null    (VOICEVOX_URL; unset = TTS off)
//   ttsCacheMb: number            (TTS_CACHE_MB, default 300, 10–5000)
//   dataPaths(dataDir).tts = <dataDir>/tts
// index.ts: buildApp({ ..., tts: config.voicevoxUrl ? createVoicevoxTts({...}) : null })
```

How `synthesize` works:

1. **Cache key** = `sha256(voice|engineVersion|text)`. A file in `cacheDir` is a hit.
2. **Query.** `POST /audio_query?speaker=<30|13>&text=<rubyPlain(text)>`. When the text has ruby, verify with `readingMatches(query, rubyKana(text))` (`shared/voicevox.ts`). On a mismatch, query again with the hiragana reading as text.
3. **Synthesis.** `POST /synthesis?speaker=…` with the query → WAV.
4. **Write.** Write the file atomically (tmp + rename).
5. **Limits.** One synthesis at a time (a queue); 15 s timeout per engine call.
6. **Pruning.** At most hourly: delete the oldest files by mtime while the total is over `maxCacheMb`.

E's `app.ts` adds `tts?: TtsService | null` to `BuildAppOptions`, `tts` to `AppContext`, and calls `ttsRoutes(api, ctx)`. `/api/health` reports `ttsEnabled`. Engine errors are logged with the error code only, never the text. `tts.test.ts` captures the logger output of a request and asserts it does not contain the synthesized text.

#### 3.5.4 Docker

`docker-compose.yml` adds a service (internal only):

```yaml
  voicevox:
    image: voicevox/voicevox_engine:cpu-latest
    restart: unless-stopped
    # Internal: issho reaches it at http://voicevox:50021. Not published to the network.
    expose: ["50021"]
```

The `issho` service's `environment` adds `VOICEVOX_URL: http://voicevox:50021`. There is no `depends_on` gate, because the app works without TTS. Comments explain that the engine image is about 2 GB and uses CPU only while synthesizing. `server/.env.example` documents `VOICEVOX_URL` and `TTS_CACHE_MB`.

The `Dockerfile` is unchanged, except a non-fatal warning when `public/audio/manifest.json` is missing. The app then falls back to server TTS and the device voice.

`.dockerignore` (F) adds `.cache` (the WAV temp folder of audio generation) and `scripts/audio/last-run.json`, so neither enters the build context.

#### 3.5.5 Sync layer — `src/sync/**`

`client.ts` adds (all go through the existing `request()`, with types from `shared/api.ts`):

```ts
export function getTogether(): Promise<TogetherState>;
export function postTogetherEventRaw(req: TogetherEventRequest): Promise<TogetherState>;
export function aiRolePlay(req: AiRolePlayRequest): Promise<AiRolePlayResponse>;     // 45 s timeout like aiCheck
export function aiRecap(req: AiRecapRequest): Promise<AiRecapResponse>;
export function aiCanDo(req: AiCanDoRequest): Promise<AiCanDoResponse>;
export function aiReport(req: AiReportRequest): Promise<void>;
export function fetchTts(q: TtsQuery, opts?: { signal?: AbortSignal }): Promise<Blob>;   // POST JSON body, as: 'blob', 15 s timeout
// existing, with v2 types: health, createQuiz (kind), submitQuizResult (verdicts), aiCheck (mode), sendMessage (tag), getQuizzes
```

`together.ts` (new):

```ts
/** Queues the event in togetherOutbox (uuid clientId, ISO week of `now`) and flushes when online; resolves once queued. */
export function postTogetherEvent(event: TogetherEvent, now?: Date): Promise<void>;
export function flushTogetherOutbox(): Promise<number>;
/** Cached state (localStorage 'issho.together.v1'), refreshed on mount when older than 60 s and on 'together' events. */
export function useTogetherState(): { state: TogetherState | null; offline: boolean; refresh: () => Promise<void> };
/** Starts: outbox flush on reconnect; 'together' (and every refresh) → refresh, then creditTogetherSession(session,
 *  minutes, date) for every state.sessions entry dated today or yesterday (idempotent in B, so repeats are harmless; a
 *  together session counts for both members whoever posted it); 'quiz' with a result where fromMemberId === me and kind
 *  partner/dictation/monthly → applyPartnerVerdicts (applied once in B); pending output checks → reveal + completeOutputCheck. */
export function startTogetherSync(): () => void;
export function sendLive(state: TogetherLiveState): boolean;
export function onLive(cb: (memberId: string, state: TogetherLiveState) => void): () => void;
/** Retries B's pendingOutputChecks with aiCheck({ mode: 'reveal' }) when the server is reachable. */
export function flushPendingOutputChecks(): Promise<number>;
```

Other sync changes:

- **`stats.ts` / `statsPayload.ts`:**

```ts
export interface StatsInputs {
  days: DayRecord[];                // last 14
  tokens: ReadonlySet<string>;      // rest-token dates
  streak: number;                   // StreakV2.current
  knownKanji: Iterable<string>;
  progress: MemberProgress;         // B memberProgress()
  shareAccuracy: boolean;
}
export function toDayStats(d: DayRecord, opts: { token: boolean; shareAccuracy: boolean }): DayStats;
export function buildStatsPayload(inputs: StatsInputs): StatsUploadRequest;
```

  - `toDayStats` sets `sessionComplete = goalMet`, `minimumDone`, `togetherMinutes = togetherMs / 60000`, `restToken` and `accuracyShared`.
  - `correct = shareAccuracy ? clamp(correct) : 0`.
  - `studyMinutes = studyMs / 60000`.
  - `phase` is omitted.
  - `collectStats()` uses B's `weekStats`, `streak`, `knownKanji` and `memberProgress`.
- **`socket.ts`** handles the `together` and `live` server events and sends `live` client events.
- **`outbox.ts`:** `NewChatMessage` gains `tag?: 'daily'`, stored in `OutboxRecord.tag` and sent.
- **`chat.ts`** stores `tag`.
- **`index.ts`:** `startSync()` also starts `startTogetherSync()`.

#### 3.5.6 App start, dev and tests — `src/main.tsx`, `src/devSilence.ts`, `src/test-setup.ts`, `package.json`

- **`main.tsx`**:
  - **Remove** the temporary localhost-silence block (`if (import.meta.env.DEV || ['localhost','127.0.0.1'].includes(location.hostname))`). Keep `if (import.meta.env.DEV) silenceInDev();`; the opt-in through localStorage `issho.dev-sound = '1'` still works.
  - Add `installAudioUnlock()`.
  - DEV only: `void import('./srs/devSeed.ts').then((m) => { (window as any).__issho = { devSeed: m.devSeed }; })`.
  - Do this removal in the **final** integration step, after browser QA (§6.1 step 3), so QA stays silent.
- **`test-setup.ts`** adds jsdom stubs:
  - `HTMLMediaElement.prototype.play`: resolves and dispatches `ended` after a microtask.
  - `pause` and `load`: no-ops.
  - `URL.createObjectURL` / `revokeObjectURL`, if missing.
  - No `caches` global.
- **`package.json`** scripts add:
  - `"build:audio": "node scripts/audio/generate.ts"`
  - `"check:content": "node scripts/check-content.ts"`
  - `"coverage": "node scripts/v2/coverage.ts"`

  No dependency changes.
- **`.gitignore`** adds `.cache/` (temporary WAVs from audio generation) and `scripts/audio/last-run.json`.

### 3.6 Data pipeline and audio generation — owner A

A's files: `scripts/**` (including `scripts/data/core-ids.lock.json`, written at release), `public/data/**`, `public/audio/**`, `shared/voicevox.ts`, and the content files A authors: `content/confusables.json` (new), `content/mnemonics.json` (the refresh: a one-sentence meaning hook of ≤ 20 words for every curriculum kanji of rank ≤ 500, and sound hooks for them), `content/radicals.json`, `content/kana-examples.json` (adding the 92 one-line kana picture hooks, `hook`, ≤ 12 words each) and `content/sentences/*.json` (re-tagging only).

A must **not** edit the files that content authors are still writing: `content/core-words.json` (+ `core-words/`), `content/grammar-v2.json` (+ `grammar-v2/`), `content/units/*.json` (+ `units.json`), `content/stories/*.json`, `content/roleplays-v2/*.json` (+ `roleplays-v2.json`) and `content/kana-rules.json`. Problems found in them go into the build report and to the lead.

#### 3.6.1 `npm run build:data` (`scripts/build-data.ts` v2) — order of work

1. **Raw dictionaries** (unchanged readers).
   - JMdict keeps **all** `ke_pri`/`re_pri` tags as `pri` on the chosen spelling, plus the alternate readings (`altKana`).
   - JMdict lookups also index kana-only entries, so core words can resolve `jmdict` ids.
2. **Content loading.** Read whatever is present:
   - `core-words.json`, else the merged `core-words/part*.json` sorted by `order`;
   - `grammar-v2.json`, else `grammar-v2/part*.json`;
   - `kana-rules.json`, `kana-examples.json`, `mnemonics.json`, `radicals.json`, `confusables.json`;
   - `units/u*.json`; only when that folder is missing, `units.json`;
   - `stories/*.json` (each file a `StoryEntry` or an array);
   - `roleplays-v2/*.json` (each file a `RolePlay` or an array; today `legacy.json` + `rp-u01.json`–`rp-u25.json`); only when that folder is missing, `roleplays-v2.json`; only when neither exists, v1 `roleplays.json`;
   - `sentences/*.json`.

   Directory readers take every `*.json` file in the folder, sorted by file name, and ignore other files. Every reader accepts "one object or an array" per file. **A folder wins over the matching single file**: today both `content/roleplays-v2/` and `content/roleplays-v2.json` exist with the same 39 ids, and 31 scripts differ because the folder was edited after the combined export. Merging them would fail on duplicate ids, and preferring the file would ship stale scripts. When the folder exists, the single file (`roleplays-v2.json`, `units.json`) is ignored, with a warning that lists the ids whose content differs.

   **Structural errors fail the build**: bad JSON, missing required fields, duplicate ids (including the same id in two files), broken ruby (`validateRuby`), unknown references. **In-progress content only warns**: empty can-do material, missing stories, task fields left blank, missing roleplays-v2.
3. **Core words → `CoreWord[]`.**
   - Validate: `id` unique, `order` 1..N without gaps, `en` ≤ 40, `pos`/`register`/`topic` enums, `use` boolean, every `survival` id unique. All 117 v1 survival ids must be present, or it warns with the missing list.
   - **Id lock** (§3.6.3): when `scripts/data/core-ids.lock.json` exists, every locked id must still exist with the same `kana` and `written` (hiragana-folded); a changed meaning or a removed id fails the build. New ids are allowed. `npm run build:data -- --lock-core-ids` writes the lock (at release only).
   - Derive `kanji` from `written`; `unit` = the first unit whose `coreWordCeiling ≥ order` (25 when beyond); `altKana` = JMdict alternate readings of the entry plus the おう↔おお and えい↔ええ variants **only when JMdict lists them**.
4. **Word identity** (§3.6.3), then `words.json` with `pri`, `core`, `use` and `altKana`.
5. **Curriculum v2** (§3.6.2) → `curriculum.json`, `kanji.json` (`parts`, `rank`) and `radicals.json` (named parts, adding name and meaning for every rare component; names from `content/radicals.json`, else the KANJIDIC meaning).
6. **Grammar** → `grammar.json`.
   - `unit` from the units' grammar lists.
   - Each build item gets `answers` (§3.6.4).
   - Validate: ≥ 110 points; ≥ 8 examples each; ≥ 4 build items each unless `recognitionOnly`; the tiles join to exactly `rubyPlain(jp)`; prerequisites exist, come earlier by `order` and form no cycle; `contrastWith` ids exist.
   - **Plain-form pacing warning** (plan change 7: plain-form recognition by about day 60): warn when any of `dictionary-form`, `casual-speech`, `nai-form`, `casual-past` has `order > 22` (about course day 60 at the governed pace of 2–3.5 points a week from day 8). Today they are at 29, 33, 38 and 44, so the build warns; the reorder is the content authors' call (§6.4 question 2).
7. **Units** → `units.json`, sorted by `id`.
   - Validate: the units partition all grammar ids exactly once, in `order`; `coreWordCeiling` strictly increasing; `conversation` resolves to a role-play (warn when it is missing); `targets` resolve; capstone `structures` ≥ 6 and all are grammar ids of that unit or earlier.
   - `ready` per can-do: `material` is non-empty, and there are 2–3 `questions` (read/listen) or 2–4 `rubric` items (speak/write). `ready` per task: `goal`, `infoA`, `infoB`, ≥ 8 `scripted` lines and a valid `register`.
   - **Kana check words:** `KanaRule.checkWords` on `kata-extended` = 10 core words whose kana are all katakana, topic `food` or `drink`, lowest `order` first (44 exist today: コーヒー, パン, ケーキ, ラーメン, …), topped up from other katakana core words when fewer than 10.
   - A `register` value of `''` becomes `'mixed'` plus a warning.
8. **Role-plays** → `roleplays.json` (v2 shape), sorted with the core conversations first (by the unit that names them), then the others by id.
   - A **core conversation** is a script named by some `UnitSpec.conversation`; nothing else is. `RolePlay.unit` is only a level gate: the 14 legacy scripts carry units 2–24 and 9–14 lines and are free role-plays.
   - Validate: ids unique within the chosen source; `targets` resolve (`core:` ids exist after any renumbering, `grammar:` ids exist); every line has `role`, `jp` and `en` (errors); an empty `cue`, or a core conversation outside 4–8 lines, only warns; each unit's `conversation` resolves (warns when missing, as in step 7).
   - The v1 upgrade (`cue ''`, `targets []`, `register 'mixed'`) runs only on the v1 fallback path. `legacy.json` is already in the v2 shape and is not upgraded.
9. **Sentences** → `sentences.json`.
   - Grammar tags are mapped v1 → v2 with `scripts/lib/grammar-map.ts` (A writes it: an explicit table of the 37 v1 ids; an id with no v2 equivalent is dropped). Then validated. A sentence with an unknown tag is **dropped** with a warning.
   - Tokenized with `scripts/v2/tokenize.ts` into `tokens` and `refs`.
   - `unit` = the highest unit among its grammar tags' units and its core refs' `CoreWord.unit` (1 when none).
10. **Stories** → `stories.json`.
    - Validate with the rules in `scripts/v2/coverage.ts`: level vs character count (start 100–300 and ≤ 200 distinct words; L0 200–400; L1 400–1,200), the gist (3 options), grammar ids taught by the unit's last point.
    - Split `／` into `phrases`; tokenize each phrase with `ph`; compute `chars` and `refs`.
    - Warn when coverage at the unit's core ceiling is < 98 %.
11. **Mnemonics** → `mnemonics.json`. Values are normalized to `{ meaning, sound? }`. The lint is a warning in the build and an error in `content-mnemonics.test.ts` (§5.1):
    - every curriculum kanji with rank ≤ 500 has a `meaning` hook (today 363 entries exist, so at least 137 of the first 500 have none);
    - each hook is **exactly one sentence** (one terminal `.`, `!` or `?`, none inside) of ≤ 20 words (today 18 are multi-sentence, e.g. 日 with 2 sentences and 23 words);
    - a part name it mentions must belong to a component or named part of that kanji, introduced earlier (by curriculum position);
    - every kanji of rank ≤ 500 has a `sound` hook.
    The kana picture hooks are linted the same way: all 92 basic kana have `hook`, one line of ≤ 12 words.
12. **Write** every file (2-space JSON, stable key order) and print the report: counts, warnings, and the top anchor changes compared with v1.

#### 3.6.2 Curriculum v2 — `scripts/lib/curriculum.ts`

- **Spine.** The jōyō kanji, sorted by `effectiveRank = freqRank − boost`, ties broken by `freqRank`, then codepoint. `boost` is:
  - 150 when the kanji appears in a core word with `order ≤ 400`, or in a role-play/task target word;
  - 100 for core `order` 401–1,000;
  - 50 for any other core word;
  - otherwise 0.
- **Components.** Before placing a kanji, place its jōyō components that are not yet placed (recursively, existing behaviour), **except rare components**. A component is rare when its `freqRank > 1000`, or when it has no useful word (no candidate word with `ichi1`/`spec1`/`spec2` or a core link). A rare component becomes a **named part**: it goes into `KanjiEntry.parts` of its users and gets a `radicals.json` entry. It keeps its own frequency position as a kanji unit later. Non-jōyō components are always named parts. Test: none of 乙 弔 丙 吏 斤 丈 巾 旦 is a unit in the first 300.
- **Words per kanji.** `pickUnitWords(char, candidates)` takes words containing the kanji whose other kanji are all placed at or before this unit, and not used by an earlier unit.

  Score:

  | Condition | Points |
  |---|---|
  | `ichi1` or `spec1`/`spec2` | +3 |
  | core word or role-play/task target | +3 |
  | uses the kanji's most common reading in the word set | +2 |
  | ≤ 3 characters | +1 |
  | priority only from `news1`/`news2`/`nfXX` | −2 |

  Ties go to the lower `freqRank`. Words whose only priority is news are dropped. The top word is the `anchor`; the next two are `staged`. Each JMdict word becomes `core:<id>` when it is a core word. `MAX_UNIT_WORDS = 3`.

  Test: none of 国会, 年金, 中立, 土木, 会長, 本山 is an anchor in the first 150 kanji. Every anchor has `ichi1`/`spec`, or is a core word, wherever such a candidate exists.
- **`inferable`.** ≥ 2 components; every component kanji placed earlier, or a named part; and no component marked phonetic in KanjiVG (`kvg:phon`).
- **Confusables.** `content/confusables.json` (A authors about 60 sets) holds `ConfusableSet[]`. Examples:
  - visual: 未末, 土士, 人入八, 大犬太, 日目, 己已巳, 休体, 待持特, …
  - meaning: `m-numbers` 一二三四五六七八九十 and `m-weekdays` 日月火水木金土.

  The build makes the members of each `visual` set ≥ 10 positions apart: a later member moves down until the gap holds. The runtime guarantees ≥ 5 study days (§3.1.1). `meaning` sets have no build constraint; the runtime allows ≤ 3 members a day.
- **`chapter`** = `floor(index / 15) + 1`. `phaseEnds` is removed.

#### 3.6.3 Word identity: one item per word

A JMdict entry `e` and a core word `c` are the **same word** when any of these holds:

- `c.jmdict === e.id`;
- `c.written === e.written && c.kana === e.kana` (hiragana-folded);
- `!c.written && c.kana === e.kana && e.kanji.length > 0` and the entry is that kana word's usual-kanji spelling (`e.id` is the entry whose reading list starts with `c.kana`).

Then `words.json` sets `e.core = c.id`. **Every** reference to the word (curriculum anchor/staged, sentence and story tokens, targets, `accent.json`, the audio `byRef`) uses `core:<c.id>`.

**Core ids before and after release.** Until release, the authors may renumber core ids once more and nothing breaks: refs are recomputed on each build, and audio clips are keyed by text hash. From release on, core ids are durable keys on each phone (`ItemRecord`/`CardRecord` ids `core:<id>`, `PitchBoxRecord.ref`, `StagedWordRecord.itemId`, `PartnerQuizItem.key`, plus the authored unit and role-play targets), so a renumber would silently reattach progress to different words. So:

- at release (§6.1 step 3) A runs `npm run build:data -- --lock-core-ids`, which commits `scripts/data/core-ids.lock.json` (`id → { kana, written }`);
- every later build checks it (§3.6.1 step 3) and `content-core.test.ts` asserts it: a changed meaning or a removed id fails;
- later reorders change `order` only; a real id change would need a one-time id-map migration (not planned).

#### 3.6.4 Typed answers for grammar build items

`answers` holds the hiragana for `jp` and for each alternative:

- `rubyKana(jp)` for `jp`;
- the tokenizer's readings for alternatives, which are plain text that may contain kanji;
- for every particle token (kuromoji `助詞`) は/へ/を, also the variant with わ/え/お;
- punctuation and spaces removed; deduplicated; at most 16 per item.

When an alternative cannot be read, it is left out and the report warns.

#### 3.6.5 `shared/voicevox.ts` (A; dependency-free; erasable TypeScript only)

```ts
import type { VoiceId } from './api.ts';
export const VOICES: Record<VoiceId, { speaker: number; style: string; credit: string }> = {
  f: { speaker: 30, style: 'No.7 アナウンス', credit: 'VOICEVOX:No.7' },
  m: { speaker: 13, style: '青山龍星 ノーマル', credit: 'VOICEVOX:青山龍星' },
};
/** Same semantics as src/lib/ruby.ts (kept dependency-free so the server can use it); '／' removed. */
export function rubyPlain(text: string): string;
export function rubyKana(text: string): string;
/** `${voice}|${plain}|${reading}`: plain = rubyPlain(text) without '／', NFKC, whitespace collapsed, trimmed; reading =
 *  hiragana of rubyKana(text) normalised the same way, or '' when it still contains a kanji (text without full ruby).
 *  '{食|た}べる' and '{食べる|たべる}' → 'f|食べる|たべる'; '食べる' → 'f|食べる|'; 'ありがとう' → 'f|ありがとう|ありがとう'. */
export function clipTextKey(voice: VoiceId, text: string): string;
export function toKatakana(s: string): string;
/** Kana → moras: small ゃゅょぁぃぅぇぉゎ (and katakana) join the previous kana; っ, ん, ー are moras of their own. */
export function splitMoras(kana: string): string[];
/** Comparison form (both sides): katakana; punctuation and spaces removed; ー → the previous mora's vowel; ハ→ワ, ヘ→エ,
 *  ヲ→オ; ヅ→ズ, ヂ→ジ; after an e-column mora イ→エ; after an o-column mora ウ→オ. (VOICEVOX writes 先生 センセエ,
 *  東京 トオキョオ, コーヒー コオヒイ, 駅へ エキエ, 本を ホンオ.) */
export function normalizeMoras(kana: string): string;
export interface VvMora { text: string; consonant?: string | null; consonant_length?: number | null; vowel: string; vowel_length: number; pitch: number }
export interface VvAccentPhrase { moras: VvMora[]; accent: number; pause_mora: VvMora | null; is_interrogative?: boolean }
export interface VvQuery {
  accent_phrases: VvAccentPhrase[];
  speedScale: number; pitchScale: number; intonationScale: number; volumeScale: number;
  prePhonemeLength: number; postPhonemeLength: number; outputSamplingRate: number; outputStereo: boolean;
  kana?: string;
  [key: string]: unknown;
}
export function queryMoras(q: VvQuery): string;                       // concatenated mora texts
export function readingMatches(q: VvQuery, expectedKana: string): boolean;   // normalizeMoras equality
export interface AccentInfoShared { moras: string[]; drop: number; type: 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka' }
/** alone: query of the word; withGa: query of word + 'が' (nouns, pronouns, na-adjectives, numbers, counters), else null.
 *  n = moras of the expected reading. withGa with one accent phrase of n+1 moras: accent n+1 → drop 0 (heiban), else
 *  drop = accent. Otherwise alone with one phrase of n moras: accent n → 0, else accent. Types: 0 heiban, 1 atamadaka,
 *  n odaka, else nakadaka (1-mora words: 0 heiban, else atamadaka). null when the phrases don't line up. */
export function accentFromQueries(expectedKana: string, alone: VvQuery, withGa: VvQuery | null): AccentInfoShared | null;
/** Start offsets (ms) of the author's phrases inside the query: each phrase's normalized mora count is walked over the
 *  query's moras (pause_mora included where present); offset = 1000·(prePhonemeLength + Σ consonant_length + vowel_length
 *  of earlier moras and pauses) / speedScale. aligned = false (proportional offsets by mora count) when counts don't match. */
export function phraseOffsetsMs(q: VvQuery, phrasesKana: readonly string[]): { offsets: number[]; aligned: boolean };
/** Accent phrases of a sentence query as [joined katakana moras, accent] (pause moras left out): AudioClip.accentPhrases. */
export function phraseAccents(q: VvQuery): [string, number][];
```

A delivers this file **first** in step 1a (with `voicevox.test.ts`), before the rest of the pipeline: F's `audio.ts` needs `clipTextKey`, and F's `server/src/tts.ts` needs `rubyPlain`, `rubyKana` and `readingMatches`. Until it lands, F codes against these signatures with a local stub.

#### 3.6.6 `npm run build:audio` — `scripts/audio/generate.ts`

**CLI:** `node scripts/audio/generate.ts [--scope all|kana|core|words|pitch|grammar|sentences|stories|roleplays|units] [--kanji-limit 600] [--engine http://127.0.0.1:50021] [--concurrency 2] [--dry-run] [--limit N]`.

**Prerequisites:**

- `public/data` must be built first.
- The engine must answer `GET /version`, and `GET /speakers` must list style ids 30 and 13; otherwise exit 2.
- An encoder must exist: `ffmpeg` (preferred), else `afconvert` (macOS); otherwise exit 2. Both are installed on the build Mac; `ffmpeg` output is about half the size for word clips.

**Jobs.** One per clip ref (§2.2), each with its text (ruby), expected reading (`rubyKana`; for words the entry's kana), voice, pack, and kind (`word`, `pitch`, `sentence`, `story`, `line`, `kana`).

| Ref | Voice and text |
|---|---|
| `kana:<c>` | `f`; all 208 kana |
| `kanaEx:<c>` | `f`; text `{written\|kana}` (or `kana`), reading `kana` |
| `kanaRule:<id>#<n>` | `f` |
| `core:<id>` | `f`; text `{written\|kana}` (or `kana` when there is no written form), reading `kana` |
| `word:<id>` | `f`; text `{written\|kana}`; only anchor/staged words of the first `--kanji-limit` (600) curriculum kanji |
| `pitch:<ref>` | `f`; text `{written\|kana}が`, reading `kana + が`; for noun-like `core:`/`word:` refs in scope (core `pos` in noun/pronoun/adj-na/number/counter/demonstrative; JMdict `pos` starting with `n`) whose accent is recorded (step 3) |
| `grammar:<id>#ex<n>`, `#build<n>` | `f` |
| `sentence:<id>` | `f`; pack `u<SentenceEntry.unit>` |
| `story:<id>#<n>` | `f`, with phrases |
| `rp:<id>#<n>` | role a → `f`, b → `m` |
| `task:<taskId>#<n>` | role a → `f`, b → `m` |
| `cando:<id>` | `f`; listen checks with material only |

**Per job:**

1. `hash = sha256(JSON.stringify({ v: GEN_VERSION, speaker, text: rubyPlain(text), reading }))`, first 16 hex characters, with `GEN_VERSION = 1` in `scripts/audio/jobs.ts`. The engine version is **not** in the hash: an engine upgrade does not regenerate (and re-commit) every clip; bumping `GEN_VERSION` does, on purpose (new encoder settings, a better voice). The file is `public/audio/<hash[0..2]>/<hash>.m4a`. If the manifest already has this clip id and the file exists, reuse it (with its `phrases` and `accentPhrases`; the accent file entries are kept in a sidecar `scripts/audio/accent-cache.json` keyed by clip id).
2. `q = POST /audio_query?speaker=S&text=<rubyPlain(text)>`. If `readingMatches(q, reading)` → `via 'text'`. Otherwise `q = POST /audio_query?speaker=S&text=<hiragana reading>`; if that matches → `via 'kana'`. Otherwise the job **fails**: it is recorded in `scripts/audio/last-run.json` (not published), there is no clip, and the runtime falls back to server TTS or the device voice.
3. **Word accent** (`core:`, `word:`), only when the clip went `via 'text'` with its kanji spelling, or the word is kana-only (its text is its kana). A `via 'kana'` fallback never records accent: a kana-only query takes an arbitrary homophone's accent (the engine reads あめが with accent 3, which is 飴, wrong for 雨). Then `qGa` = the same text with `が` appended (noun-like POS only), checked with `readingMatches(qGa, reading + 'が')`; the accent is `accentFromQueries(reading, q, qGa)` (with `qGa = null` for other POS). A non-null result goes into `accent.json` under the ref, with `withGa: true` when `qGa` was used.
4. **Pitch clips** (`pitch:<ref>`): synthesized from that same verified `qGa`, so the drill's audio and its answer come from one query by construction. No accent with が → no pitch clip → the word is never drilled.
5. `POST /synthesis?speaker=S` with `q` (`speedScale` 1, `prePhonemeLength` 0.1, `postPhonemeLength` 0.1, `outputSamplingRate` 24000) → WAV in `.cache/audio-tmp/`. `ms` comes from the WAV header.
6. Encode: `ffmpeg -y -loglevel error -i in.wav -ac 1 -c:a aac -b:a 32k -map_metadata -1 -fflags +bitexact out.m4a` (bit-exact output, so identical input gives identical bytes and git sees no churn), or `afconvert -f m4af -d aac -b 32000 -c 1 in.wav out.m4a`.
7. **Sentence-type clips** (grammar examples and builds, sentences, story sentences, role-play and task lines) read `via 'text'`: `accentPhrases = phraseAccents(q)`. A `via 'kana'` clip gets none.
8. **Stories:** `phrases = phraseOffsetsMs(q, phraseReadings).offsets`. A failed alignment warns.

**Manifest.**

- Written every 200 clips and at the end, so a run can be resumed.
- Keys are sorted.
- `byRef` and `byText` are rebuilt from the current jobs; clips no longer referenced are removed from the manifest and their files deleted. `byText` holds each clip's full `clipTextKey` and, only when exactly one clip of that voice has that plain text, the plain-only key (§2.2).
- `credits = [VOICES.f.credit, VOICES.m.credit]`, `engine = 'VOICEVOX <version>'` (display only).

**Expected size and time.** About 9,700 clips and about 70–78 MB with `ffmpeg` (about 100 MB with `afconvert`): about 4,100 sentence-type clips (≈ 11,300 s of audio, ≈ 50 MB), about 3,400 word and kana clips (≈ 12 MB), about 260 extra kana and kana-example clips (≈ 1 MB) and about 1,900 pitch clips (≈ 8 MB). Measured per clip on the local engine: query + synthesis + encode ≈ 0.3 s for a word and 0.6–1.5 s for a sentence, so a first full run takes about 1.5–2 h sequential (less at concurrency 2), and later runs are incremental. Whether the clips are committed to git is §6.4 question 1; the default is to commit them (Docker ships committed data, and the build machine has no VOICEVOX).

---

## 4. File ownership partition

### 4.1 Rules

- **Contracts step (step 0, one engineer).** Writes `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/data.ts` and `shared/api.ts` **verbatim** from §2.4, then commits "v2 contracts". After that the files are frozen (§2.4).
  - Expected side effect: `npm run typecheck` fails across the tree until integration, because old types are gone (`vocab`, `newPerDay`, `phase` and so on). Each implementer keeps **their own files** type-clean: `npx tsc --noEmit 2>&1 | grep -F '<my paths>'` must be empty before they hand over.
  - Vitest does not type-check, so each module's tests run green on its own.
  - The contract files keep no v1 compatibility exports (`loadSurvivalWords`, `currentPhase` and the rest are gone). Unchanged files of other owners that still import them stop the app from linking in Vite until they are updated, so **nobody does browser QA before the integration merge** (§6.1 step 2). Unit tests mock `data.ts` and other owners' modules and are unaffected.
- **One owner per file.** Each changed, new or deleted file belongs to exactly one implementer, as listed below. Importing (read-only) another owner's exports is expected; editing their files is not. If a needed export is missing, ask its owner, and meanwhile code against the signature in §3 with a local test stub.
- **Unlisted files** under an owner's directory belong to that owner: `src/srs/**` → B, `src/components/study/**` and `src/writing/**` → C, `src/components/home/**` → D, `src/components/together/**` → E, `src/speech/**` and `src/sync/**` → F, `scripts/**` and `public/data/**` and `public/audio/**` → A.
- **Unchanged files** (they need no owner): `src/components/Glyph.tsx`, `server/src/{auth,errors,rate-limit,voice-cleanup,hub}.ts` (E only if touched), `index.html`, `tsconfig.json`, `server/tsconfig.json`, `data-raw/**`.

### 4.2 Partition

**Step 0 — contracts:** `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/data.ts`, `shared/api.ts`.

**A — data pipeline and audio generation**

| Status | Files |
|---|---|
| Changed | `scripts/build-data.ts`, `scripts/check-content.ts`, `scripts/lib/content.ts`, `scripts/lib/curriculum.ts`, `scripts/lib/words.ts`, `scripts/lib/jmdict.ts`, `scripts/lib/kana.ts` (`sprintDay`), `scripts/lib/kanjivg.ts` (`kvg:phon`), `scripts/lib/kanjidic.ts` (if needed), `scripts/v2/tokenize.ts`, `scripts/v2/coverage.ts` |
| New | `shared/voicevox.ts` (delivered first), `scripts/lib/core.ts`, `scripts/lib/units.ts`, `scripts/lib/stories.ts`, `scripts/lib/identity.ts`, `scripts/lib/grammar-map.ts`, `scripts/lib/answers.ts`, `scripts/audio/generate.ts`, `scripts/audio/encode.ts`, `scripts/audio/jobs.ts`, `scripts/data/core-ids.lock.json` (at release), `scripts/fixtures/voicevox/*.json` |
| Tests | `scripts/*.test.ts` (all existing, updated) + new `scripts/content-core.test.ts`, `scripts/content-units.test.ts`, `scripts/content-stories.test.ts`, `scripts/identity.test.ts`, `scripts/voicevox.test.ts`, `scripts/audio-jobs.test.ts` |
| Content | `content/confusables.json` (new), `content/mnemonics.json` (refresh), `content/radicals.json`, `content/kana-examples.json` (+ 92 `hook`s), `content/sentences/*.json` (re-tag only); **delete** `content/survival-words.json` and `content/grammar.json` once v2 is wired (the survival ids live in core words) |
| Outputs | `public/data/**` (all), `public/audio/**` (all) |

**B — SRS, course, planner and progress engine**

| Status | Files |
|---|---|
| Changed | `src/srs/course.ts`, `items.ts`, `scheduler.ts`, `answers.ts`, `romaji.ts`, `planner.ts`, `progress.ts`, `days.ts`, `random.ts` (if needed), `test-fixtures.ts`; `src/lib/hooks.ts`, `src/lib/ruby.ts`, `src/lib/backup.ts` |
| New | `src/srs/governor.ts`, `timing.ts`, `habits.ts`, `milestones.ts`, `memberProgress.ts`, `together.ts`, `encounters.ts`, `readListen.ts`, `output.ts`, `sentenceGuard.ts`, `fluency.ts`, `numbersDrill.ts`, `pitch.ts`, `candos.ts`, `simulate.ts`, `devSeed.ts` |
| Tests | All `src/srs/*.test.ts` (updated + one per new module, `simulate.test.ts` included), `src/lib/backup.test.ts`, `src/lib/data.test.ts`, new `src/lib/db.test.ts` (migration), `src/lib/ruby.test.ts`, `src/lib/hooks.test.ts` |

**C — study and session UI**

| Status | Files |
|---|---|
| Changed | `src/screens/Session.tsx`, `WritePractice.tsx`, `GrammarList.tsx`, `GrammarDetail.tsx`, `Reading.tsx`; `src/components/study/{ReviewBlock,ReadingDrill,readingQuestion,sentences,SessionSummary,SessionChrome,Shadow,PracticePad,DrillPractice,MixedText,format,time,focus,useAsync}.tsx/ts`, `study.css`; `src/components/study/cards/{prepare,types,ReviewCard,FeedbackPanel,KanaReadCard,KanaWriteCard,KanjiWriteCard,KanjiMeaningCard,WriteQuestion,parts}`; `src/components/study/learn/{NewItemFlow,data,KanaLesson,KanjiLesson,GrammarLesson,WriteSteps,Readings}`; `src/writing/{matcher,WritingPad,index,describe,synthetic,useStrokes,StrokeOrder}.ts(x)` |
| Renamed | `cards/WordReadingCard.tsx` → `cards/WordReadCard.tsx`; `cards/SentenceReadCard.tsx` → `cards/ClozeCard.tsx`; `learn/VocabLesson.tsx` → `learn/CoreWordLesson.tsx` |
| New | `src/screens/CanDoCheck.tsx`; `src/components/study/session/machine.ts` (also home of `LearnedItem`); `cards/{KanaRuleCard,ListenCard,ProduceCard,GrammarComprehendCard,GrammarBuildCard,KanaInput,KanaText,ShowOptions}.tsx`; `learn/{KanaRuleLesson,StagedWordLesson,MemoryPass,KanaCheck}.tsx`; `src/components/study/{StoryReader,KanaWordsRead,OutputStep,FluencySprint,PitchLine,PhrasePitchLine,PitchDrill}.tsx` |
| Deleted | `cards/{KanjiReadingCard,WordMeaningCard,RadicalMeaningCard,VocabMeaningCard,VocabRecallCard,GrammarDrillCard}.tsx`, `learn/RadicalLesson.tsx`, `src/components/study/prefs.ts` |
| Tests | All `src/components/study/**/*.test.tsx`, `src/writing/*.test.ts(x)`, `src/components/study/test-utils.tsx` |

**D — home, progress, onboarding and settings UI**

| Status | Files |
|---|---|
| Changed | `src/App.tsx`; `src/screens/{Today,Onboarding,Settings,LearnHub,Library,KanjiDetail,KanaChart}.tsx`; `src/components/home/{SessionPanel→PlanPanel,StreakCard,PartnerCard,NewToday,SettingsStudy,SettingsTogether,SettingsData,KanjiParts,labels,library,controls,kanaChart,home.css,library.css,settings.css,...}`; `src/components/ui.tsx`; `src/styles/global.css` |
| New | `src/lib/ics.ts`; `src/components/home/{RestTokenPrompt,ComebackCard,TravelBanner,ChapterLine,CoverageCard,RetentionCard,HoursCard,SpeedCard,CanDoList,PlacementCheck,HabitStep,TogetherStep,RemindersStep,SettingsHabits,PartsPanel}.tsx` |
| Tests | All `src/components/home/*.test.tsx`, `src/components/home/test-fixtures.tsx`, `src/App.test.tsx`, `src/components/ui.test.tsx`, `src/styles/tokens.test.ts`, new `src/lib/ics.test.ts` |

**E — together client and server**

| Status | Files |
|---|---|
| Changed | `src/screens/{Together,Chat,RolePlayList,RolePlayRun,QuizRun}.tsx`; `src/components/together/{Composer,ai,rolePlay,quizzes,QuizSender (removed from hub; delete if unused),RolePlayLine,ChatBubbles,TranslateSheet,household,live,storage,together.css,...}`; `server/src/{app,context,db,days,ai,ws}.ts`, `server/src/routes/{ai,quizzes,stats,messages,health}.ts` |
| New | `src/screens/TogetherSession.tsx`; `src/components/together/{TogetherTodayCard,CoupleQuestCard,SessionA,SessionB,SessionC,MonthlySession,PartnerQuiz,TeachMe,ConversationStage,TaskCardView,PlanningTimer,Retell,Dictation,CheckIn,Capstone,rules}.tsx`; `server/src/together.ts`, `server/src/routes/together.ts` |
| Tests | All `src/components/together/*.test.ts(x)`; `server/test/*.test.ts` except `tts`, `config`, `static`; new `server/test/together.test.ts`, `server/test/quest.test.ts` |

**F — audio playback, server TTS, sync, Docker and platform**

| Status | Files |
|---|---|
| Changed | `src/speech/{tts,recognition,compare,recorder}.ts`; `src/sync/{client,stats,statsPayload,socket,chat,outbox,index,voice}.ts`; `src/components/SpeakButton.tsx`; `src/main.tsx`; `src/devSilence.ts`; `src/test-setup.ts`; `vite.config.ts`; `package.json` (scripts only); `.gitignore`; `.dockerignore` (adds `.cache` and `scripts/audio/last-run.json`); `docker-compose.yml`; `Dockerfile`; `server/src/{config,index,static,precompress}.ts`; `server/.env.example`; `src/components/UpdatePrompt.tsx` and `UpdatePrompt.test.tsx` (only if the SW config needs it) |
| New | `src/speech/audio.ts`; `src/sync/together.ts`; `server/src/tts.ts`; `server/src/tts-routes.ts` |
| Tests | `src/speech/*.test.ts`, `src/sync/*.test.ts`, `src/main.test.tsx`, new `src/speech/audio.test.ts`, `src/sync/together.test.ts`, `server/test/tts.test.ts`, `server/test/config.test.ts`, `server/test/static.test.ts` |

### 4.3 Local ports and environments (browser QA)

| Implementer | Web (Vite) | Home server | Server data dir |
|---|---|---|---|
| A | 5181 (lent to E as the partner copy; A rarely needs the browser) | 8791 | a local `srv-a/` folder |
| B | 5182 | 8792 | `srv-b/` |
| C | 5183 | 8793 | `srv-c/` |
| D | 5184 | 8794 | `srv-d/` |
| E | 5185, plus a partner copy on 5181 (`ISSHO_API_PORT=8795`), a separate origin and so a separate IndexedDB | 8795 | `srv-e/` |
| F | 5186 | 8796 | `srv-f/` |

- **Web:** `ISSHO_API_PORT=879x npx vite --port 518x --strictPort`.
- **Server:** `cd server && PORT=879x HOST=127.0.0.1 DATA_DIR=<a local folder>/srv-x HOUSEHOLD_CODE=test-household node src/index.ts`. Add `VOICEVOX_URL=http://127.0.0.1:50021` only for TTS testing; that is a server-side call, never from the browser.
- **Browser:** open exactly `http://localhost:518x` with the `mcp__Claude_Browser__*` tools.
- **Which commit:** every owner runs browser QA on a worktree of the integration commit tagged `v2-int` (§6.1 step 2), never on their own branch alone. Fixes go into their own files and are merged back to the integration branch; QA is then repeated on the new tag.
- **Seeding:** use `window.__issho.devSeed(N)` (DEV build) to reach course day N.
- **Two-partner tests** use two browser tabs on two web ports, each paired as a different member.
- Never use Chrome, `127.0.0.1` or LAN IPs in the browser.

---

## 5. Test plan

Conventions:

- Vitest with fake-indexeddb, and time given through the `now` parameters.
- Fixed fixtures; random paths use `seededRandom`.
- Server tests use `node --test` with `buildApp` and a temp store.
- Every number below is an assertion.

### 5.1 Unit tests by module

**B — engine**

| File | Scenarios |
|---|---|
| `governor.test.ts` | **(a)** Day 20, 25 min, nothing due: `seconds.total ≤ 1650` and ≥ 1 kanji with its anchor (priced 188). **(b)** 25 min, due = 120 listen cards at r = 0.5 (Rv = 1740 > 1500): `mode 'catch-up'`, 0 new, Σ ≤ 1320 s, the chosen cards are the lowest-r ones and appear in input order, `strandMin 2`. **(b2)** Hysteresis: `catchUpBefore` with RvDay between LF and B → still catch-up; ≤ LF → normal. **(c)** `strandMinutes`: (10, 0, 25) = 2; (30, 0, 25) = 4; (61, 500, 25) = 6; (61, 1300, 25) = 8; (61, 1300, 20) = 6; (61, 1300, 40) = 10. **(d)** `accuracy3 = 0.79` → `brake` and `newRoom` exactly half of the 0.81 case. **(e)** `grammarBelowFloor` → grammar is planned before kanji even when kanji has the larger deficit; never 2 grammar points in one plan. **(f)** Shares, room-limited: 28 days at 25 min with Rv = 700 s every day (NewRoom = 500 s), unlimited candidates, grammar allowed every other day: stream seconds kanji 0.5–0.7, core 0.1–0.3, grammar 0.1–0.3 (a reference run gives 0.59/0.22/0.19). **(f2)** Ceiling-bound: nothing due (NewRoom 1200): every day has exactly 3 kanji and 3 core, grammar every other study day; shares are then ceiling-derived (kanji ≈ 0.73, core ≈ 0.14, grammar ≈ 0.13), not 60/20/20. **(f3)** Staged words are planned with `stream 'staged'` and never change the shares. **(f4)** Stream closing: room 170 s with the next kanji priced 188 and a later zero-word kanji priced 160 → no kanji (the stream closes), core fills. **(g)** Hard cap and squeeze: Rv = 1300 s, R = 6 at 25 min → 0 new, `strandMin 5`, total ≤ 1650. **(h)** Sprint day 3: 10 kana + 3 core even with Rv = 1600 (never throttled; never catch-up); course day 16 with `sprintComplete false` → still sprint mode, no kanji. **(i)** `accuracy7 0.96` with `underBudget7` and room → `offerExtraKanji`; with `dayTotal + 188 > 1.1·B` → no offer; with `extraKanji` the ceiling is 4 but the 4th kanji is added only when it fits room and cap. **(j)** Over 300 random first-sitting inputs (`today` empty), with or without `extraKanji`, no non-sprint output has `dayTotal > 1.1·B`. **(k)** Split day: morning Rv 1200, F7 500 → NewRoom 0; evening `today.reviewSec 1200`, Rv 0 → NewRoom 0 and `dayTotal ≤ 1.1·B` (without `today.reviewSec` it would be 700). Evening after a morning that introduced 3 kanji (`today.newSec.kanji 564`) → no 4th kanji beyond the ceiling and the room shrinks by 564. **(l)** Sticky catch-up: `today.catchUp` with a small Rv → catch-up, 0 new; catch-up truncation subtracts `today.reviewSec`. **(m)** Fresh start: `catchUpBefore` true with RvDay between LF and B → catch-up |
| `simulate.test.ts` (synthetic course, seeds 1 and 2, 25 min, 365 days; `{ timeout: 20_000 }`) | **Planned minutes:** day 1 within 11 min ± 10 % (9.9–12.1); the means of days 15–17, 60–62 and 180–182 within 25 min ± 10 % (22.5–27.5); the mean of days 31–365 within 23–27; **no day > 27.5**. **Kana sprint:** 46 hiragana introduced by day 5; 92 kana by day 12; kana rules on days 6, 7, 13, 14 exactly; the sprint finishes on day 14; no kanji before day 15; ≥ 1 kanji on day 15. With `missDayEvery` such that day 3's teach step is skipped: no kana row is lost and kanji start only after the last row and rule. **Core words:** 3 a day on days 3–14 (36 by day 14). **Grammar:** first point on day 8; never on 2 consecutive study days; every complete ISO week from day 8 to 180 has ≥ 2 points unless it had a catch-up day. **Numbers:** `numbersToday ≤ 3` on every day. **Day 365:** ≥ 240 kanji and ≥ 1,300 words. **State:** with `keepState`, every card id has a matching item, every log a matching card, and the ids are real course ids (kanji chars, `cw-…`, grammar ids). **Speed:** it runs in < 5 s |
| `course.test.ts` | `kanaSprint`: 14 days with neither script known; 7 days (katakana 1–7) with hiragana known; [] with both known. `courseGates` for the 4 combinations. `sprintPick`: day 2 after a day 1 with only reviews (no teach) → day 1's あ and か rows (10 kana), and day 3 then teaches day 2's rows; at most 10 kana a day; a rule only after its script's rows (and at most one a day). Kanji are not candidates on course day 15 while a row is untaught; they are once it is taught. `inSprint` is true on the completing day and false the next. Staged words released on +3 and +8 calendar days; ≤ 4 staged a day. Introducing 元気's kanji after 元気 (core) is known creates exactly 1 card (`core:…\|read`). `introducePlanItem` called twice for one plan → one item, `newItems` +1 and `newSec` + price once. A visual confusable introduced 4 study days ago defers the unit (lookahead picks the next); 5 days ago does not. No more than 3 members of `m-numbers` on any one day, counting an earlier sitting's introductions. は/が (`wa-desu`, `ga-subject`) ≥ 5 study days apart. A point with an untaught prerequisite is skipped. Travel → no kanji and no grammar. `applyPlacement` 18 → 'known' (92 kana cards in Review, stability 10); 17 → 'sprint' (nothing created) |
| `items.test.ts` | `SuspendReason` has only `'retired'`. `cardTypesFor` snapshot: kana, kanaRule, kanji (zero-word: meaning + write), word (use: read + produce), core (use / spelled combinations), grammar (recognitionOnly: comprehend only), sentence. Retirement: rank 501 with stability 22 → retired; rank 499 → not; pinned → never; raising writeList restores |
| `scheduler.test.ts` | `presetOf` mapping; write cards always use 0.90 even with `receptiveRetention` 0.85; read cards use 0.85 when set; `getScheduler(0.96)` throws. ts-fsrs lock-in: New + Good → Learning +10 min; next day Good → Review ≥ 1 d; Review + Again → Relearning; re-ask Good → Review. Partner window: due in +3 d → false, +1 d → true, −2 d → true, New → false. `PARTNER_GRADE`. `gradeCard` writes `kind`, `type`, `elapsedDays`, `context`; partner mode adds no `studyMs`; `reviewMs` grows only for contexts `review`/`re-ask` (a first-check answer adds to `studyMs` only); `makeup: true` adds to `makeupMs`; `gradeCard` inside an enclosing transaction over its tables joins it |
| `answers.test.ts` | Grade matrix: typed right → Good; after hint → Hard; after a choice hint → Hard; wrong → Again; exhaustive over all flags, no path returns Easy. `gradeWordRead` matrix (right + unknown meaning → Again). `gradeForRecallWriting`: missing 1 → Again; extra 1 → Again; unmatched 2 → Again; unmatched 1 at 6 strokes → Again; unmatched 1 at 10 strokes → Hard; hint → Hard; clean → Good; override → Hard. `sentenceMatches('watashiwakaishaindesu', answers)` with the は→わ variant → true. `isSurpriseMiss` (Good at 2 s with median 5 s, now Again → true; 4 s → false). `needsCalibrationTip` (3/20 → true; 2/20 → false) |
| `romaji.test.ts` | `kon'nichiha` → こんにちは; `kitte` → きって; `nn` → ん; `imeConvert('kit')` → 'きt'; `kanaMatches('ookii', ['おおきい'])`; `kanaMatches('toukyou', ['とうきょう'])`; long-vowel `altKana` accepted |
| `planner.test.ts` | Siblings: the write card of 日 and the read card of 日本 both due → one in `warmup`, the other in `bury`, and `startSitting` moves its due to the next study day start; calling `startSitting` twice leaves the same due. A group already reviewed today buries the new card. Yesterday's Learning cards sort first. New cards never appear in warm-up and all appear in `pendingCheck`, including a spelling-upgrade read card created today for a core word introduced last week. Cards of items introduced today never appear in warm-up. `anywhere` → the whole warm-up **including kanji write cards**, `paperAllowed false`, and no teach/check/read/output/fluency. An anywhere sitting, then a desk plan the same day: the desk plan still contains due write cards that the anywhere sitting did not review (warm-up never depends on `doneSteps`), plus teach, read, check and output. Teach in a later sitting holds only items not yet introduced; `finishStep('read')` twice → one entry. Catch-up → no bury, siblings ≥ 10 apart, `counts` undefined. A day with `comebackOffer` welcome-back still plans mode normal or catch-up (never `welcome-back`). Read block ≥ 3 min on every course day 15–60 at 25 min (no fluency slot); fluency null before strandMin 6, in catch-up and in micro. `leakMask` lists a due read card's item in `readings`. `planMicro` ≤ 180 s, no write cards, no new. Re-planning per sitting gives the same plan when nothing changed |
| `readListen.test.ts` | `pickIPlusOne` never picks: an untaught grammar tag; two unknown words; a target introduced 0 or 22 days ago; a resting sentence. It picks a target 1 or 21 days old, and prefers encounter-starved words (2 encounters before 9). `coverage` of a fixture with 49 known of 50 content tokens plus 3 names → 0.98. `pickStory` never returns a story at 0.979; it prefers a due listen step, then the shared story; `stretchStories` = [0.95, 0.98). `pickRead({ minutes: 3 })` plans a story only when its estimate fits and never more than 3 minutes; `{ minutes: 1 }` → 1 sentence. `recordStoryStep`: rwl on day 0 → listen due day 3; listen on day 4 → re-read due firstDay + 10 (day 10), not day 14 |
| `hooks.test.ts` | `furiganaPolicy`: stability 22 → hidden; 20 → shown; two learners with different mature sets → different answers for the same token; 'always'/'never'; the okurigana prefix rule ({食|た}べる hidden when 食べる is mature); names always shown |
| `habits.test.ts` | A missed day with a token keeps the streak; a third token in one ISO week → 'none-left'. `repairable` is unset while the missed day's week has a token left. **One normal 25-min session the next day (goal met, no make-up) does not repair yesterday.** A make-up whose `makeupMs` reaches 10 min, 47 h 59 min after the 4 a.m. that ends the missed day → repaired; at 49 h → refused; with 9 min → not repaired; `completeMakeup` twice → one repair. `makeupOffer` only after today's goal is met. A minimum day counts for the streak but `todayGoal` stays false. `noteReviewProgress`: after 1 review with only New cards and today's items left due → minimumDone; a buried sibling does not count as due. Travel freezes (neither breaks nor adds). `creditTogetherSession` sets `minimumDone`; the same (session, date) twice → `togetherMs` once. `completeDay` twice → same result. `comebackOffer`: 1 missed → welcome-back; a 5-day gap → fresh-start with freshStart = the next Monday or the 1st, whichever is first. A broken streak → `alive false`. `offerTokenFor` only when yesterday was missed and the week has a token left |
| `progress.test.ts` / `memberProgress.test.ts` | `isLearned`: successes on days 1, 1, 3 → false; on 1, 3, 9 → true; the introduction day never counts. `retentionFrom` on fixture logs: week bucket (elapsed 5–10) 9 of 10 → 0.9; month bucket (21–45); families mapped; n < 10 → null. `charsPerMinute(300, 60000) = 300`. `addStudyTime(…, 'strand')` grows `strandMs`. `memberProgress` fields: `settledUnit` counts a unit only when all its grammar was introduced ≥ 2 days ago; `recentItems` holds only items 2–21 days old (max 20); `coreReached`/`grammarReached` |
| `milestones.test.ts` | `coverageShare(300) = 0.83`, `(250) = 0.81`, `(99) = null`, `(1500) = 0.95`. Chapters: kanji 15 → chapter 2 done 0; done 7 → "done" text; done 8 → "to go" text; kana → "Chapter 0 · Kana · 46 of 92". `chapterItems(2)` lists the words and grammar introduced between chapter 2's first kanji and chapter 3's. `recordMilestone` twice → one row. `seasonFinaleDue` at week 12, not again once seen |
| `together.test.ts` | Pool: only items 2–10 days old plus 7-day lapses, max 10, nothing introduced today, kinds mixed; monthly: 20, lowest r first; dictation: ≤ 5 kanji introduced 2–21 days ago, keys `kanji:X\|write`, prompt = the anchor's kana, a retired write card left out. `applyPartnerVerdicts`: a card due in 3 days is **not** rescheduled (an encounter is logged); a card due in 1 day is rescheduled — right → Good, close → Hard, wrong → Again, with `mode 'partner'`; a second apply (and two concurrent applies) change nothing; a dictation verdict grades the kanji's write card. `buildWeekPlan`: stage from state, capped at 1 above the settled unit; the task comes only from a settled unit (none → `rolePlayId`); task repeat after ≥ 2 days; the shared story is the intersection, first by level; a `monthly` session on the first Saturday's week; `capstoneUnit` only in monthly weeks; `showcase` follows `seasonFinale`. `taskTargets`: authored ∩ recent first, topped up from both partners, max 8, never an item outside 2–21 days. `eligibleRolePlays` drops a script with 3 targets not introduced for both partners, and never lists a core conversation |
| `sentenceGuard.test.ts` / `output.test.ts` | An unknown token → no card. **The model leaves an unknown word out of `words` → the surfaces don't cover `corrected` → no card.** A passive marker found in `corrected` while passive is not introduced → no card, even when `grammarUsed` is empty. `grammarUsed` containing 'other' → no card. Everything known → card created, and `blank` is the target word. `pickOutputTarget` is null before the sprint is over |
| `numbersDrill.test.ts` | 300 さんびゃく; 600 ろっぴゃく; 800 はっぴゃく; 3,000 さんぜん; 8,000 はっせん; 1,000,000 ひゃくまん; ¥1,500 せんごひゃくえん; 4:00 よじ; 9:00 くじ; 7:10 includes しちじじゅっぷん; 一人 ひとり; 二人 ふたり; 三本 さんぼん; 一杯 いっぱい |
| `fluency.test.ts` / `pitch.test.ts` | `fluencyKindFor` per weekday; `nextRotation` skips ineligible kinds; `pickFluency` null with strandMin 4, in catch-up and micro; `speedRoundCards` only stability > 21 and receptive types; the numbers drill uses only counters/time/prices whose grammar is introduced (only つ with `counting-tsu` alone). `pitchCandidates` includes only words with `withGa` and a `pitch:` clip (a verb with accent but no pitch clip is left out). `pickPitchDrill` over 100 seeded draws: the heiban share is ≥ 1.6× its base share; minimal-pair members come together. `pitchOptions(2)` = [0, 1, 2]. `recordPitch` box moves |
| `candos.test.ts` | 2/3 passes; 1/3 fails; 2/2 passes; not available until the unit's grammar is introduced; a failed attempt never sets `passedAt`; `recordCanDoAttempt` accepts only `'auto' \| 'ai'` |
| `db.test.ts` | A v1 database (Dexie v1 schema) holding every old card type, logs, days, saved sentences, settings {newPerDay 5, romaji true, maxReviewsPerDay 120, deviceToken, memberId, lastPairing}, 3 messages and 2 outbox rows → opened as v2: progress tables empty; settings `dailyMinutes 25`, no `romaji`/`newPerDay`/`maxReviewsPerDay`, `onboarded false`, pairing kept; messages and outbox unchanged; the localStorage key removed. `minutesForOldPace` 3 → 20, 5 → 25, 8 → 30; `normalizeRetention(0.97) = 0.93` |
| `backup.test.ts` | v2 round trip of every table. A v1 file restores settings and chat only, with `progressDropped: true` |

**C — study UI**

| File | Scenarios |
|---|---|
| `session/machine.test.ts` | The order is warm-up → (teach, memory) per batch → read → check → output → fluency → summary; anywhere → warm-up → summary; read/output/fluency in `doneSteps` are skipped; `firstCheckIds` puts production cards first and includes every `pendingCheck` card once; the retrieval counter is per card and never goes above 4: for a kanji (write + anchor read) the memory pass counts only for the write card and a reading appearance only for the read card, so each card can still get its check and one re-ask |
| `Session.test.tsx` | The steps render in order. The memory pass for item 1 renders only after item 4's guided copy. A missed review reappears ≥ 5 positions later, and `gradeCard` is called twice (the second with `context 're-ask'`); a first-check miss is re-asked with `context 'first-check'`. No new card is retrieved more than 4 times on day 0 (per card). Reopening re-plans (`planToday` called again). StrictMode double mount and a double tap on the sitting choice → `startSitting` and `introducePlanItem` effects run once. `finishStep` is called only for read, output and fluency. No card counts in catch-up. The make-up offer appears in the summary when `makeupOffer` |
| `cards.test.tsx` | No choice buttons by default in review. "Show options" → `mode 'choice'` and at most Hard. Hands-busy shows options and logs `'choice'`. Recognition offline → typed input. Word read logs `parts`. A sprint kana-write card shows no romaji anywhere and auto-plays the sound; romaji is hidden on kana cards once `inSprint` is false. "Write on paper" is hidden when `paperAllowed` is false. Speech fails twice → "I said it" grades Hard. `KanaInput`: a composition sequence keeps the composed kana untouched, romaji converts live outside composition, `autocorrect="off"` and `spellcheck="false"` are set. `KanaText`: ありがとう on course day 3 shows romaji over り and が only |
| `prepare.test.ts` | `blankKanji('日本', '日') = '□本'`. For every fixture kanji, the write prompt never contains the target kanji. For every view, the card's own target word never gets ruby. Comprehend example rotation: over reps 0–20, never the last 2 shown and never examples 0–2 within the first n − 3 reviews |
| `FeedbackPanel.test.tsx` | A miss renders animation, audio, the sentence and parts. A fast correct answer renders the one-line answer only and auto-continues at 1.2 s (fake timers). The leak guard hides a sibling's reading that is due today. A surprise miss shows the hook field. The hook is hidden on the test card and shown after a miss |
| `matcher.test.ts` (with `writing/synthetic.ts`) | Correct strokes in shuffled order → ok with `orderSlips`. One stroke of 木 left out → `missing 1` → Again. One sloppy stroke in a 10-stroke kanji (書) → `unmatched 1` → Hard. One extra stroke → Again. `hungarian` on a known 4×4 matrix |
| `WritingPad.test.tsx` | Recall mode draws no per-stroke marks and no model while writing; Done → `onRecallDone`; the model is drawn afterwards; the slip note is shown |
| `GrammarCards.test.tsx` | Comprehend rotation; build uses tiles when < 60 points are known and typed at ≥ 60; typed `answers` with particle variants |
| `StoryReader.test.tsx` | With mocked `play`: phrases are highlighted in order on `onPhrase`; the gist is recorded; reread computes cpm; listen mode hides the text |
| `ReadingDrill.test.tsx` | The gloss is guessed before the reveal; saving is possible from day 1; encounters are logged; `markSentencesShown` is called |
| `OutputStep.test.tsx` | prompt → edit → reveal; no corrected text before reveal; offline → sent, and the check is `pending`; report button; just-show-me skips the prompt |
| `Fluency.test.tsx` | Speed round uses only stability > 21 cards and never calls `gradeCard`; `PitchLine` snapshots for the 4 types; `PhrasePitchLine` snapshot on a fixture sentence; `PitchDrill` plays the `pitch:` clip, draws n + 1 moras and gives feedback on tap |
| `CanDoCheck.test.tsx` | Passes only with ≥ 2/3; `ready: false` → "coming soon"; a speak check without AI shows "Needs the home server" and records nothing; showcase mode records nothing |

**D — home UI**

| File | Scenarios |
|---|---|
| `Today.test.tsx` | "About N min today · tomorrow about M" and "About N min left today" after an earlier sitting; catch-up shows no counts; the rest-token prompt calls `spendRestToken`; the comeback card links to `/session?mode=welcome` while the plan panel still shows the normal plan; the make-up offer appears only with `makeupOffer`; the fresh-start header from `freshStart`; a broken streak is not rendered; the chapter line; no "/ 2,136"; `TogetherTodayCard` is shown on a slot day |
| `Onboarding.test.tsx` | Placement 18/20 → `applyPlacement` returns known (Review cards); 17/20 → sprint; default 25 min; habit and together steps saved; `.ics` download called |
| `Settings.test.tsx` | Minutes; a write-list change calls `syncWriteRetirement`; retention options are exactly 0.85/0.88/0.90/0.93; no new-per-day or romaji controls; reset clears every v2 progress table; About lists "VOICEVOX:No.7" and "VOICEVOX:青山龍星" |
| `ics.test.ts` | Slots Tue 20:00, Thu 20:00, Sun 19:30 → `RRULE:FREQ=WEEKLY;BYDAY=TU` / `TH` / `SU` with the matching DTSTART times; a daily cue; CRLF endings; lines folded at 75 octets |
| `LearnHub.test.tsx` | Coverage shows 83 % at 300 can-read kanji; below 100 shows the next goal; the retention card is hidden when null; hours against benchmarks; can-do statuses; a chapter lists its kanji, words and grammar from `chapterItems`; the season finale card links to Session C |
| `KanjiDetail.test.tsx` | Pin toggles `setPinned`; parts panel names; related words; pitch line when accent exists |

**E — together**

| File | Scenarios |
|---|---|
| `rolePlay.test.ts` | The stage reducer advances only when both partners mark smooth; English is hidden at S2–S4; roles swap at S3; cue-only at S4 |
| `TogetherSession.test.tsx` | Session A pass-and-play runs on one device **offline**: the owner's pool is graded with `applyLocalVerdicts`, the partner direction is practice only, and the session finishes with a queued `session-done` plus `creditTogetherSession`. Duo: the joiner follows the opener's `plan` even when its own week plan differs (other script, stage and story); `quizIds` from both phones merge; the asker posts verdicts. Session B: targets from `taskTargets`; scripted fallback without AI; recap cards only through the guard; no task → the free role-play at stage 1. Session C: retell timers 90/60/45; dictation posts a `dictation` quiz; showcase replaces dictation when `plan.showcase`; the check-in never records a can-do. The monthly session runs quiz, goal and capstone and posts `monthly` |
| `QuizRun.test.tsx` | The asker sees the answer and the ✓ / close / ✗ buttons; the answerer never sees the answer; kanji quizzes from v1 still run |
| `Chat.test.tsx` / `Composer.test.tsx` | Two-step tips; send never blocked offline; at most 2 issues; the daily tag label; replying to today's partner `daily` message with the output step open → check flow, tagged `daily`, `saveOutput` and `finishStep('output')`; with the output step done → a normal message |
| `server/test/quizzes.test.ts` | Partner kind: ≤ 10 items, key ≤ 80, verdicts required and matching the item keys, `correct` = #right; dictation ≤ 5 write items; monthly ≤ 20; the kanji kind is unchanged |
| `server/test/together.test.ts` | The fold: latest slots; the first smooth for a new script (no stage yet) counts as stage 1; smooth from both advances the stage; `both: true` advances; `session-done` deduplicated; a resent clientId → 200 with no duplicate; the `together` broadcast reaches the sender's other device too |
| `server/test/quest.test.ts` | 5+5 minimum days and A, B, C → met; 4+5 and A, B, C → met, reserve used; a second reserve in the same month → not met; 4+4 → not met; A + C + monthly → 3 sessions; A + B + C + monthly → 3; A on two dates → 1; a together date counts as a minimum day for both; `questStreakWeeks` |
| `server/test/stats.test.ts` | v2 fields stored and merged with MAX across devices; `phase` optional; `progress` round trip with `recentItems`, `settledUnit`, `coreReached`, `grammarReached` (and an over-long `recentItems` rejected); `sharedStreak` still computed for v1 clients from `minimum_done` |
| `server/test/ai.test.ts` | Stubbed model. Prompt mode: ≤ 2 issues even when the model returns 3, never corrected text, `start`/`end` located, a hint containing the fix is blanked. Reveal: the diff is computed. A legacy request without mode → reveal with `tips` ≤ 2. roleplay, recap and cando schemas. Report → 204 and a stored row |
| `server/test/db.test.ts`, `messages.test.ts`, `ws.test.ts` | Migration 4 on a v3 file keeps every row, with defaults; the `tag` round trip; the `live` relay |

**F — audio, sync, platform**

| File | Scenarios |
|---|---|
| `audio.test.ts` | Resolution order: clip by ref → clip by text key → server (paired, `ttsEnabled`, online) → device → none. `{食\|た}べる` hits the clip made from `{食べる\|たべる}`; a plain `橋` with two homograph clips does not hit either (it goes to the server); a text with ruby for はし never plays a clip of another reading. A 503 makes the server path unavailable for 5 min. The TTS cache keeps its total ≤ 20 MB (oldest out) and keys by hash, never by text. Default rate 0.85 up to course day 90, then 1, with Settings overriding. Phrase callbacks fire in order on `timeupdate`. `hasClip`; `packsFor` always includes `misc`; `prefetchPacks` skips cached clips and stops offline |
| `compare.test.ts` | `spokenMatches` on the written form, on the kana, and on the similarity threshold |
| `statsPayload.test.ts` | `correct` is 0 unless `shareAccuracy`; `sessionComplete = goalMet`; `minimumDone`; `togetherMinutes`; `restToken`; no `phase`; `progress` passed through with its v2 fields |
| `sync/together.test.ts` | Events queued offline are flushed in order with stable clientIds on reconnect. **Duo crediting:** both phones post `session-done` for A, each phone gets two `together` events plus a refresh → each member's `togetherMs` is credited exactly once. A quiz result arriving by WS and again by refresh calls `applyPartnerVerdicts` but grades once |
| `server/test/tts.test.ts` | `POST /api/tts` with a JSON body; a cache hit skips the engine; a reading mismatch → kana re-query; engine down → 503 `tts_unavailable` and `available()` false; 201 characters → 400; pruning by mtime; 121st call in a minute → 429; **the captured request log of a call does not contain the text** |
| `server/test/config.test.ts`, `static.test.ts`, `src/main.test.tsx` | `VOICEVOX_URL` and `TTS_CACHE_MB` parsing; `.m4a` served immutable; a missing `/audio/x.m4a` → 404 (not `index.html`); manifest `no-cache`; a production build on localhost is **not** silenced |

**A — data pipeline**

| File | Scenarios |
|---|---|
| `data.test.ts` (built outputs) | kana.json has 92 basic kana with `sprintDay` 1–5 / 8–12; curriculum `version 2` with no radical units, chapters every 15, and every anchor/staged ref resolving; no `WordRef` in two units; `kanji.json` rank = index + 1; `radicals.json` contains every named part used; every sentence has `unit`; `kata-extended` has 10 `checkWords`; roleplays.json comes from the `roleplays-v2/` folder when it exists (a fixture where `roleplays-v2.json` differs → the folder's version, with a warning) |
| `curriculum.test.ts` | None of 乙 弔 丙 吏 斤 丈 巾 旦 is a unit in the first 300; every component precedes its first use; visual confusable members ≥ 10 positions apart; the boost moves a core kanji up by ≤ 150; none of 国会, 年金, 中立, 土木, 会長, 本山 is an anchor in the first 150 kanji; every anchor has `ichi1`/`spec` or is core where such a candidate exists |
| `identity.test.ts` | 元気 (core with jmdict) → one identity `core:<id>` in words.json, curriculum and tokens; a kana-only core word links to its usual-kanji entry |
| `content-core.test.ts` | Every core word has `en`, `register`, `use`; all 117 survival ids are present; `order` is contiguous; `unit` derived. When `scripts/data/core-ids.lock.json` exists: every locked id exists with the same `kana` and `written` (a fixture with a swapped meaning fails) |
| `content-grammar.test.ts` | ≥ 110 points; ≥ 8 examples; ≥ 4 build items unless `recognitionOnly`; tiles join to the plain jp; prerequisites acyclic and earlier; example vocabulary core or earlier, or kanji with furigana; `answers` contain the particle variants; the plain-form pacing check reports dictionary-form/casual-speech/nai-form/casual-past with `order > 22` (a warning, `it.todo` until the authors decide, §6.4) |
| `content-units.test.ts` | The grammar partition is exact and in order; ceilings strictly increase; the core conversations are exactly the scripts named by `UnitSpec.conversation`; each one uses only its unit's or earlier vocabulary (100 % coverage at its unit's ceiling, names excepted; true today for rp-u01–rp-u25); capstone `structures` ≥ 6; `ready` flags match the content |
| `content-stories.test.ts` | Each story's level matches its character count; every content token resolves to a ref or is a name; coverage at the unit ceiling ≥ 98 % |
| `content-mnemonics.test.ts` | Every curriculum kanji of rank ≤ 500 has a meaning hook; each hook is exactly one sentence of ≤ 20 words and mentions only parts introduced earlier; every kanji of rank ≤ 500 has a `sound` hook; all 92 basic kana have a `hook` of ≤ 12 words. All are hard tests once A's refresh lands in step 1d (until then `it.todo`, tracked in §6.1) |
| `voicevox.test.ts` | `normalizeMoras` pairs: せんせい ↔ センセエ, とうきょう ↔ トオキョオ, コーヒー ↔ コオヒイ, えきへ ↔ エキエ, ほんを ↔ ホンオ. `splitMoras('きょうはっ')` = ['きょ','う','は','っ']. `clipTextKey('f', '{食\|た}べる') === clipTextKey('f', '{食べる\|たべる}')`; `clipTextKey('f', '食べる')` ends in `\|`. `accentFromQueries` on captured engine fixtures (`scripts/fixtures/voicevox/*.json`, recorded once from the local engine): 箸 atamadaka (drop 1), 橋 odaka (drop 2), 端 heiban (0), using the が queries (橋 and 端 alone are identical). `phraseOffsetsMs` aligned on a fixture sentence; `phraseAccents` on the same fixture |
| `audio-jobs.test.ts` | Refs, voices and packs per job type (all 208 `kana:`, 142 `kanaEx:`, sentences in their unit pack); stable hash without the engine version; reuse when unchanged; `byText` keys equal `clipTextKey` and plain-only keys exist only when unambiguous. Accent: a fixture word read `via 'kana'` gets no accent.json entry and no `pitch:` clip; a noun read `via 'text'` gets `withGa` accent and a `pitch:` job whose reading ends in が; a sentence read `via 'kana'` gets no `accentPhrases` |

### 5.2 Integration tests (vitest, real modules, mocked data and network)

1. **Course days 1 → 16** (B + data fixtures): loop `planToday` → `introducePlanItem` for each plan item → grade the first checks → advance the clock 1 day. Assert:
   - each sprint day's kana and rules;
   - core words from day 3; grammar from day 8;
   - the first kanji on day 15 with its anchor;
   - staged rows released on day 18 (+3) and 23 (+8).
   A second run skips the teach step on course day 4 (reviews only): day 5 teaches day 4's rows, every row and rule is still taught exactly once, and the first kanji comes the day after the last sprint item, not on day 15.
2. **One full desk sitting** (C on the real B) at seeded course day 20. Warm-up with one miss (graded re-ask) → teach batch → memory → read → check → output (AI mocked: prompt then reveal, guard passes) → summary. Then:
   - `DayRecord.goalMet` and `minimumDone` are true and `steps` contains `read` and `output`; `reviewMs` holds only the warm-up answers and `strandMs` the read and output time;
   - the cloze card exists;
   - the outbox has a `daily` message.
3. **Partner quiz round trip** (E server in process + F client + B). Phone A builds its pool and creates the quiz → the asker posts verdicts through `app.inject` → phone A's sync receives the quiz → only the in-window cards are rescheduled; a repeat delivery (WS and refresh at once) changes nothing.
3b. **Split day** (C on the real B): an anywhere sitting at seeded course day 30 (warm-up with kanji write cards, no paper option), then a desk sitting the same evening: the desk plan's new items fit what is left of the budget (`dayTotal ≤ 1.1·B`), its warm-up has only cards that became due since, and teach, read, check and output all run; the day ends with `goalMet`.
3c. **Duo session plan** (E + F, two in-process clients with different cached states): the joiner runs the opener's script, stage and story, and both members are credited once.
4. **Offline output** (C + B + F): sent offline → `check 'pending'` → back online → `flushPendingOutputChecks` → `completeOutputCheck` → a cloze is created only when the guard passes, and the next session shows "From yesterday: …".
5. **Quest across two members** (E server): two members upload v2 stats (5 and 4 minimum days) plus 3 `session-done` events → household `quest.met` with `reserveUsed`.
6. **Dexie v1 → v2 upgrade with chat continuity** (B + F): after the upgrade, `syncMessages` keeps the cached chat, and the outbox flushes.
7. **Backup**: export v2 → reset → import → `planToday` gives the same plan.

### 5.3 Browser QA checklist (`http://localhost:<port>`, internal browser tools only)

Setup:

- QA runs on the integration commit tagged `v2-int` (§6.1 step 2), in a worktree, never on an owner's branch alone. Each owner runs their own pair of ports (§4.3), at mobile width (`resize_window` preset mobile) and desktop.
- Use `window.__issho.devSeed(N)` to reach a course day; check each screen in light and dark.
- Read the console with `read_console_messages`; no errors are allowed.

1. **Fresh install (D):** onboarding steps in order; 20/25/30/40 with notes; the placement check plays kana audio and judges with the recall pad; habit and together steps saved; the `.ics` download (check the network request or blob); pairing.
2. **Day 1 (C):** あ and か rows in 2 batches of 5 (sound, picture hook, trace, copy); the memory pass after each batch; read 6 real words; the first check has 20 cards: 10 hear→write (sound only, no romaji label) and 10 see→type-romaji; the summary shows "You can now read…" and tomorrow's minutes; there are no reviews and no grammar.
3. **Day 3, day 6 / day 7, day 14:** core words on day 3 show romaji only over untaught kana (ありがとう: over り and が); rule lessons (dakuten, yōon) with 8 practice words and audio for every pair; on day 14 the Kana check (10 katakana menu words on a timer, each clip played afterwards) records the milestone and shows the M0 card. Seed a day with reviews only during the sprint: the next day teaches the missed row.
4. **Day 15:** the first kanji. Pre-guess only when inferable; parts panel names; anchor audio and pitch line; trace only when a part is new; recall writing judged as a whole with stroke-order coaching. The write prompt shows `□`.
5. **Day 30 (seeded):** Today shows "About 25 min today · tomorrow about N". An anywhere sitting shows kanji write cards on the recall pad with no paper option; then Today says "About N min left today" and a desk sitting teaches, reads, checks and sends the output. Siblings are not shown together; a miss comes back after ≥ 5 cards; fast correct answers auto-advance. The "Show options" hint is graded at most Hard.
6. **Catch-up** (seed day 60 and skip 6 days by seeding with gaps): the welcome-back offer (the normal plan is still there), then a 3-minute micro session without handwriting. A fresh-start offer after ≥ 3 days; on its date the fresh-start header shows and no new items appear until reviews settle. In catch-up, no card counts are visible anywhere.
7. **Rest token and repair:** a missed yesterday → the prompt → the token is used → the streak card stays alive, and a third token in the week is refused. With no token left: a normal session does not repair; after the goal is met, the 10-minute make-up does.
8. **Read & listen (day 45+):** the story plays clips with phrase highlighting at 0.85×; the gist question; furigana differ between two seeded partners on two origins; a Stretch story in the Library shows tap glosses.
9. **Output step:** prompt mode marks the span with no fix; one edit, then reveal with a diff; "This tip seems wrong"; with the server stopped, sending still works and the check is pending.
10. **Together (E, two origins 5185 and 5181 paired as two members to server 8795):**
    - Session A duo: the joiner shows the opener's script and stage even when its own seeded state differs; the partner quiz with the asker view and verdicts, and the answerer's cards updated; the conversation at stage S1 with two voices; "smooth" from both → S2 next week.
    - Session B with the AI (or scripted without `ANTHROPIC_API_KEY`); the task card's targets are items of the last 2–21 days.
    - Session C retell timers, dictation (a `dictation` quiz), check-in with no can-do award.
    - The monthly session (quiz, goal, capstone when due).
    - The quest card updates on both phones and counts A, B, C (monthly only as a stand-in); "Quest met N weeks running" replaces the shared-streak days.
    - Pass-and-play with the server stopped.
11. **Audio (F):**
    - The first play fetches `/audio/xx/<hash>.m4a` (200); a replay is served from the SW cache.
    - Words outside the clip scope use `POST /api/tts` when the server has `VOICEVOX_URL`, else the device voice; the server log shows no text.
    - The pitch drill (seed day 70+, a Monday) plays word + が clips.
    - `prefetchPacks` after the session.
    - Settings → About shows the VOICEVOX credits.
    - DEV is silent unless `localStorage['issho.dev-sound'] = '1'`.
12. **Settings (D):** minutes change Today's estimate; the write-list slider retires and restores cards; travel mode banner; reset progress; v1 backup import notice.
13. **PWA (F):** `npm run build && npm run preview -- --port 518x`. The SW installs; offline reload works (server stopped); audio clips played before still play; manifest precached.
14. **Docker (F, outside the browser):** `docker compose up -d --build` starts `issho` and `voicevox`; `/api/health` reports `ttsEnabled: true` after the engine warms up; `docker compose stop voicevox` → `ttsEnabled: false` and the app falls back to the device voice.

---

## 6. Sequencing, risks, decisions and open questions

### 6.1 Sequencing

| Step | Who | What | Done when |
|---|---|---|---|
| 0. Contracts | one engineer (the lead's choice) | Write §2.4.1–2.4.4 verbatim; commit "v2 contracts" | The four files compile on their own (`npx tsc --noEmit` shows errors only in non-contract files) |
| 1a. Early unblockers (first ~25 % of the fan-out) | A | **First** `shared/voicevox.ts` with `voicevox.test.ts` (F needs it); then `build:data` v2 writes every `public/data` file in the v2 shapes (audio not yet) | `voicevox.test.ts` green; `npm run build:data` passes; `data.test.ts` green |
| | B | `course`, `governor`, `timing`, `items`, `scheduler`, `answers`, `planner` (`DayPlan`), `memberProgress`, `simulate` (synthetic course), `test-fixtures` | Their tests green |
| | F | `test-setup` audio stubs; `client.ts` functions (§3.5.5); the `audio.ts` `play` API (clip → device first, server path next); `sync/stats.ts` and `index.ts` moved off v1 engine exports (`currentPhase` and the rest) | E and C can import them |
| | E | Server migration 4 and routes (it needs only `shared/api.ts`) | `server` tests green |
| 1b. Fan-out | all six, in parallel | Everything else in §3. C, D and E code against B's and F's signatures, with local stubs until 1a lands. **No browser QA in this step**: until every owner's files are on v2, unchanged v1 files still import removed exports and the app does not link | Each owner: own unit tests green; own paths type-clean (§4.1) |
| 1c. Audio | A | Generator; first full run against the local engine (about 1.5–2 h); `public/audio` + `accent.json` written locally (committed in step 4) | `audio-jobs.test.ts` green; manifest has about 9.7k clips; failures < 1 % |
| 1d. Content follow-ups | A | `confusables.json`; mnemonic refresh (a one-sentence meaning hook of ≤ 20 words for every kanji of rank ≤ 500, the 18 multi-sentence hooks rewritten, sound hooks); the 92 kana picture hooks; sentence re-tagging; `devSeed` smoke on the real course (with B) | `content-mnemonics.test.ts` fully hard (the `todo`s removed) |
| 2. Integration merge | lead + F | Merge all branches in the order A, B, F, E, C, D; `npm run typecheck` on the whole tree; `npm test`; `cd server && npm test`; §5.2 integration tests; `npm run build:data && npm run build:audio` when content changed; `npm run build`. Tag the result **`v2-int`** | Everything green; tag pushed |
| 3. Browser QA | all six, in parallel | Each owner checks out `v2-int` in a worktree and runs the §5.3 items for their area on their own ports (§4.3). Fixes go into their own files on their branch, the lead merges them and tags `v2-int.2`, `v2-int.3` …; affected items are re-run on the new tag | QA checklist signed off on the last tag |
| 4. Release | lead + A + F | A runs `npm run build:data -- --lock-core-ids` and commits `scripts/data/core-ids.lock.json` (core ids frozen from here); `public/audio` committed as decided in §6.4; `docker compose build`. **Last commit:** F removes the temporary localhost-silence block in `src/main.tsx` (DEV silence and its opt-in stay) | Image builds; lock committed |

Critical path: step 0 → B's planner and A's data v2 → C's Session → integration → QA.

E's server work and F's TTS server can start at step 0.

Content that authors are still writing (units, stories, roleplays-v2, core reordering) flows in at any time until step 4: re-run `build:data` (+ `build:audio`), and `ready` flags turn features on. After step 4, core ids are locked.

### 6.2 Risks and mitigations

1. **Content still being written.** As of 2026-10-15 the content is checkpointed in `900cbfc` (all 25 units with every can-do check and task, 60 stories, `content/roleplays-v2/` with 14 legacy scripts plus 25 core conversations), and the working tree has further edits. Core ids may be renumbered once more before release. A stale combined `content/roleplays-v2.json` sits next to the folder.
   - The pipeline is tolerant: optional files, `ready` flags, warnings rather than errors; a folder wins over its stale single file.
   - Before release, refs are recomputed every build and audio is keyed by text hash, so a renumber is free. From release on, core ids are locked (§3.6.3); a renumber after that would silently move progress to other words, and the lock test fails it.
   - The UI hides what is missing: "check coming soon", sentences-only read blocks.
2. **Whole-tree typecheck is red, and the app does not link, during the fan-out.** Each owner keeps their own paths type-clean (§4.1) and their unit tests green; integration owns the final green, and browser QA waits for it (§6.1 steps 2–3).
3. **VOICEVOX misreadings and accent errors.**
   - Each clip's moras are checked against the expected reading, with a kana re-query on a mismatch.
   - Failures are listed and skipped, never shipped.
   - Accent is recorded only for single-accent-phrase words with aligned moras, only from the kanji spelling (`via 'text'`) or kana-only words, and noun accent is measured with が to tell heiban from odaka.
   - The pitch drill plays only the word + が clips synthesized from that same query, so what is heard and what is marked right always agree.
4. **Repository and image size.** About 70–78 MB of `.m4a` clips (about 9,700 files, measured sizes, §2.2) if committed (§6.4 question 1). The hash leaves out the engine version and `ffmpeg` output is bit-exact, so an engine upgrade or a re-run adds nothing to git; only changed content does. The kanji-word scope is limited to the first 600 kanji, widened later with `--kanji-limit`. The VOICEVOX CPU image is about 2 GB on the home server; it is optional, and the app degrades to the device voice.
5. **iOS audio policies.** A single audio element unlocked on the first gesture, Blob URLs (no Range issues), and the device fallback.
6. **Speech recognition returns kanji.** `spokenMatches` compares against both the written form and the readings, and typing is always available.
7. **FSRS lives on each phone.** Partner verdicts are posted by the asker and applied idempotently by the answerer within ±2 days of due. In pass-and-play without a cached partner pool, the partner direction is practice only (no FSRS effect). This is documented in the UI as "your partner's results count when their phone syncs".
8. **Governor fidelity versus the plan's simulation.** `simulate.test.ts` locks in the minutes and pace bands. The numbers are planning figures; per-user medians replace the defaults after 30 logs per card type.
9. **jsdom has no media playback.** `test-setup` stubs it; audio code guards `caches`.
10. **Progress reset on upgrade.** Acceptable, because the couple has not started (lead decision). Backups from v1 restore settings and chat only, with a clear notice.
11. **Two AI calls per output sentence** (prompt, then reveal). Effort stays low and the 30/min limit applies; `justShowMe` uses one call; offline it queues.
12. **Server AI context needs `grammar.json`.** In Docker it is read from `STATIC_DIR/data/content/grammar.json`; when missing, prompts use the ids only.
13. **Duplicate side effects.** StrictMode, double taps, two sittings, and a WebSocket event racing a refresh could double-count. Every write is idempotent (§0) and has a test (introduce twice, bury twice, credit twice, apply verdicts twice, finishStep twice).
14. **Phone storage.** Runtime audio packs cost a few MB each; the server-TTS cache is capped at 20 MB by bytes.

### 6.3 Decisions made in this design (where it refines or departs from the plan)

1. **Progress reset instead of card migration.** This was the lead's call. The plan's card-type migration and its test are replaced by `upgradeToV2` and the `db.test.ts` checks (§5.1). Onboarding re-runs, with name and pairing kept.
2. **Kana rules.** There are 4 rule items (as authored in `content/kana-rules.json`), not 5. Katakana voiced and yōon share one lesson on day 13.
3. **FSRS presets.** `production` (write, produce, build, cloze) is fixed at 0.90. `receptive` (read, meaning, listen, comprehend) is selectable at 0.85, 0.88, 0.90 or 0.93, never above 0.95. No on-device optimizer. Settings shows a static explanation, not per-retention projected minutes. `fsrsWeights` exists in Settings for future use only.
4. **Kana price is 53 s** (the plan's 35-s lesson plus its two first-check cards), so day 1 estimates about 11 min, as in the plan's day-in-the-life.
5. **Strand squeeze.** When reviews plus the strand reserve exceed 1.1 × budget, the reserve shrinks to no less than 2 min. Without it, the plan's 27.5-min cap could not hold between LF and B.
6. **Sprint before catch-up.** Sprint days are never throttled and never catch-up.
7. **Warm-up excludes New cards and cards of items introduced today, and the day-0 cap counts per card.** The plan states the cap per item ("memory pass, reading, first check, plus one re-ask"); with two cards per item that cannot hold, so it is counted per card (memory → the production card, reading → the receptive card). Every New card goes to the first check. Day 1's first check is therefore 20 cards (10 hear→write, 10 see→type), where the plan's day-1 text says "10 graded cards" (it counted kana); the time (about 3 min) is already in the 53-s kana price.
8. **Phase gates follow placement.** With hiragana known, core words and grammar start on day 1 and kanji on day 8.
9. **Produce cards for JMdict words** only when the word appears in a role-play or task line (`use`). Core words follow their authored `use`.
10. **Comprehend rotation** is `(3 + reps) % n`: never one of the last 2 shown, and never the 3 lesson examples first.
11. **Grammar build input.** Tiles until 60 points are introduced, then typed against build-time `answers` that include the は/わ, へ/え and を/お variants.
12. **Fluency days.** The plan names different days in different places. Pitch drill on Mon/Wed/Fri; rotation (re-read → speed → numbers) on Tue/Thu/Sat; nothing on Sunday (Session C day). The slot starts only when the strand reserve reaches 6 min (about course day 61, as in the plan's day-90 description), never in catch-up, travel, micro or make-up plans, and only when the read block keeps ≥ 3 min. Starting at day 15 would have left a 1-minute read block until day 61.
13. **Story audio** is one clip per sentence with phrase offsets from VOICEVOX mora timings, which sounds more natural than one utterance per phrase. The device fallback still speaks phrase by phrase.
14. **Pitch accent comes from VOICEVOX** at generation time (lead decision), so there is no Kanjium import and no CC BY-SA accent file. Pitch lines appear only for words with verified accent (read from the kanji spelling, or kana-only words), and as phrase lines on study sentences and grammar examples whose clip was read from the text. The pitch-ear drill plays the word + が, because heiban and odaka words sound the same alone; verbs and adjectives get pitch lines but are not drilled.
15. **Server TTS returns WAV.** There is no ffmpeg in the server image; WAV over the LAN is fine. Pre-generated clips are AAC.
16. **Couple quest.** Every member ≥ 5 minimum days, plus sessions A, B and C (a monthly session stands in for one missing letter, never more). **One reserve per calendar month** covers a single shortfall. A together session counts as a minimum day for every member on that date. The server's v1 `sharedStreak` stays for v1 clients only; v2 shows "Quest met N weeks running".
17. **Privacy.** `DayStats.correct` is sent as 0 unless `shareAccuracy` is on; the partner card shows effort only.
18. **Monthly session** is its own session (`/together/session/monthly`) on the month's first Saturday: the monthly quiz, goal setting with a fresh-start framing, and the capstone when one is due. Session C keeps its 15 minutes. Capstones have no recording (no portfolio blobs).
19. **Quiz storage.** The server keeps the v1 `kanji` quiz kind for old items. The "send your hardest kanji" sender is removed; the partner quiz replaces it.
20. **`inferable` kanji** use KanjiVG's phonetic marks (`kvg:phon`). Confusable spacing is ≥ 10 curriculum positions at build time and ≥ 5 study days at runtime.
21. **Word identity.** A word that is both a JMdict kanji word and a core word is always `core:<id>`. A spelling upgrade adds one read card, never a second item.
22. **Ownership deviation.** `src/lib/hooks.ts`, `ruby.ts` and `backup.ts` belong to B (engine logic). `src/lib/ics.ts` belongs to D. `shared/voicevox.ts` belongs to A, its first consumer, and A delivers it first; F imports it.
23. **Units are paced by grammar, not by kanji chapters.** The plan maps units onto the 15-kanji chapters by curriculum position; here a unit is "current" when its grammar is being taught, and "settled" when both partners introduced all its grammar ≥ 2 days ago. Tasks, conversation stages S2–S4 and capstones follow settled units (capstones in the monthly session), because they need the unit's grammar. Chapters stay the kanji progress display.
24. **Readings on deliberate cards.** The plan says "never show furigana" on review cards. Here a deliberate card or first-check card shows a reading only for a word containing a kanji the learner has not been introduced to (it would otherwise be unreadable); the card's own target word never gets ruby (asserted in `prepare.test.ts`).
25. **Streak repair** needs a 10-minute make-up session after today's goal is met, offered only once the week's tokens are gone. The plan's "a second full plan" path is not offered (the governor has no second plan to give).
26. **Speak/write can-dos are judged only by the AI** (`/api/ai/cando`); without the home server they wait. No partner rubric path: the rubrics are grammar judgements, and partners never correct each other.
27. **Free writing practice** is one ungraded recall per character per day, for items introduced before today, opened from a character's page. There are no practice lists and no "suspend by hand" (the plan rejects cram, study-by-list and retire-this-card modes).
28. **TTS is `POST /api/tts`**, not GET, so chat text and AI replies never reach the server's request log.
29. **Audio hashes leave out the engine version**, and `ffmpeg` (bit-exact) is the preferred encoder, so re-runs and engine upgrades do not churn git; `GEN_VERSION` forces a regeneration on purpose.

30. **Explicitly out of scope for v2.**
    - Web-push reminders (`.ics` only).
    - AI-generated stories.
    - Confusable discrimination items (change 14, phase 2).
    - The together pitch game.
    - The AI oral interview and the portfolio.
    - The on-device FSRS optimizer.
    - Per-retention projected minutes.

    The data shapes leave room for each of them.

### 6.4 Questions for the user (minimal)

1. **Where should about 70–78 MB of generated voice clips live?** (About 9,700 small `.m4a` files, measured on the local engine; it grows only when content changes, because re-runs and engine upgrades produce the same files.) Options: (a) commit them to git, the default, as `public/data` ships today; (b) Git LFS; (c) keep `public/audio` out of git and generate it on the machine that builds the Docker image (that machine then needs VOICEVOX). Nothing waits on the answer until the release step (§6.1 step 4).
2. **For the lead / content authors: move plain-form recognition earlier?** The plan wants plain forms (だ, plain past, ない) recognised by about day 60. In `grammar-v2.json`, `dictionary-form` is order 29, `casual-speech` 33, `nai-form` 38 and `casual-past` 44, which the governed pace reaches around days 75–130. Reordering them (with their prerequisites) to order ≤ 22 is a content change in the authors' file; the build warns until then (§3.6.1 step 6).

---

## 7. Revision notes

**Revision 3, 2026-10-15** (two reviews: 27 findings from reviewer 1, 23 from reviewer 2). Every finding was checked against the plan, the code and the content. All were valid. They were accepted, a few with a different fix than proposed, as noted. The previous revision's notes (role-play folder layout, content status, core-word counts) are folded into the text.

**Day flow, planner and governor (B, C)**

- **Anywhere sitting and warm-up** (R1 HIGH, R2). The anywhere sitting now has the whole warm-up, kanji write cards included, on the phone's recall pad; only "write on paper" is hidden (the plan's day 30 has write cards in the morning sitting). The warm-up is content-driven, "due cards not yet reviewed today", and never skipped because of `doneSteps`. `DayRecord.steps` records only read, output and fluency (§3.1.7). Planner test added.
- **Multi-batch steps and reloads** (R1). Teach and check are recomputed from progress, so `finishStep` is never called for them. The losses on a reload (a pending memory pass, counters, re-asks) are documented, and none of them can break the cap.
- **Sprint from progress** (R1 HIGH). `sprintPick` teaches the oldest untaught rows first (≤ 10 kana a day, one rule a day after its rows). Kanji and the governor also need `sprintComplete`, and `inSprint` drives the romaji rules. Course, simulate and integration tests added.
- **Budget across sittings** (R1 HIGH). The governor adds today's actual review time (`reviewMs`, now warm-up only) and strand time (`strandMs`, new) to the day's load, both in NewRoom and in the hard cap (which now also subtracts today's new seconds). Catch-up is sticky for the day. `seconds.dayTotal` is new. Split-day and sticky tests added.
- **Shares test and staged accounting** (R1). New `'staged'` and `'sprint'` streams, outside the 60/20/20 shares. Test (f) is now room-limited (NewRoom 500 s; a reference run gives 0.59/0.22/0.19), and (f2) covers the ceiling-bound case. A stream whose next item does not fit is closed for the rest of the fill.
- **Catch-up order** (R1). The governor picks the subset by r and keeps warm-up order.
- **extraKanji and underBudget7** (R1, R2). The extra kanji must fit the room and the 1.1·B cap; the offer requires `dayTotal + 188 ≤ 1.1·B`. `underBudget7` uses actual `studyMs`.
- **Day-0 cap per card** (R2). Memory counts for the production card and reading for the receptive card. Every New card goes to the first check (the spelling-upgrade leak is fixed). Day 1's check is 20 cards; §6.3 #7 explains the plan's "10".
- **Fluency slot** (R1, R2). It starts at strand ≥ 6 min (about day 61), never in catch-up, travel, micro or make-up, and only when the read block keeps ≥ 3 min. `pickRead` fits its minutes.
- **Idempotency** (R1). Absolute bury target, created-only counting, set-add steps and credits, idempotent `completeDay`/`completeMakeup`, and one transaction for `applyPartnerVerdicts` (with `gradeCard` joining it). The `started` ref guard is kept (§0, §6.2 #13).
- **Smaller planner fixes** (R1, R2). Welcome-back is on request only. `freshStart` now has an effect. `noteReviewProgress` uses the warm-up filter. Staged release uses calendar days. The story re-read is at firstDay + 10. At most 3 numbers a day is tested. The numbers drill uses only introduced counters, time and prices.
- **Simulation and devSeed** (R1). `simulate` drives the real `streamCandidates` on a `SimCourse` (real or synthetic) and can return its state with real ids, which `devSeed` writes. Explicit 20-s test timeout.
- **memberProgress** moved to its own module (R1: import cycle).

**Habits (B, D)**

- **Streak repair** (R2). It is no longer automatic. It needs a 10-minute make-up session (`planMakeup`, `makeupMs`), offered only after today's goal is met and only when the week has no token left. A test checks that a normal session never repairs. I did not adopt the reviewer's "second full plan" path, because the governor has no second plan to give (§6.3 #25).

**Cards and input (C)**

- **KanaInput** (R1). No conversion while composing (convert on `compositionend`), kana passes through, and `autocorrect="off"` and `spellCheck={false}` are set. Test added.
- **Kana write cards** have no romaji label (R2). `KanaText` applies the romaji helper to every kana string during the sprint (R2).
- **Kana content** (R2). Picture hooks are authored by A in `kana-examples.json`. The Kana check is a read step on the day the sprint completes, with build-derived `checkWords` and a milestone.
- **WritePractice** (R2) is now one ungraded recall per character per day, for items introduced before today, with no lists. `SuspendReason` is `'retired'` only.
- **LearnedItem** moved into `machine.ts` with card ids (R1).

**Card guard and output (B, E)**

- **Guard** (R2). The AI word list must cover `corrected` exactly, markers run on `corrected` itself, and `grammarUsed` can only fail a sentence.
- **Partner's reply** to today's daily sentence runs the output check and counts as their output (R2).

**Pitch and audio (A, C, F)**

- **Pitch drill** (R2 HIGH). It plays the new `pitch:<ref>` clips (word + が, synthesized from the same query that sets the accent). Words without one are not drilled. Accent is recorded only via the kanji spelling or for kana-only words, never from a `via 'kana'` fallback. Tests added.
- **Phrase pitch lines** (R2). `AudioClip.accentPhrases` plus `PhrasePitchLine` in ReadingDrill and GrammarLesson.
- **Audio size** (R1). Re-measured locally: `ffmpeg` word 3.5 KB, sentence 16.5 KB; `afconvert` 7.2 / 20.7 KB. The new totals are about 9,700 clips and 70–78 MB with `ffmpeg`, which is now preferred and bit-exact. The engine version is out of the hash, so upgrades do not churn git. HE-AAC was not adopted: `afconvert` HE-AAC measured 18.5 KB per sentence, larger than `ffmpeg` LC, and it adds a compatibility risk. §6.4 question 1 now uses the real numbers.
- **Clip coverage** (R1). `kanaEx:` refs, clips for all 208 kana, `SentenceEntry.unit` as the sentence pack, and `misc` always prefetched.
- **byText homographs** (R1). The key now carries the reading; plain-only keys exist only when unambiguous.
- **TTS privacy** (R1). `POST /api/tts` with a JSON body, plus a log test. The client cache is keyed by hash and capped at 20 MB by bytes (R1).
- **shared/voicevox.ts** is delivered first by A in step 1a (R1). It stays out of the frozen contracts because it contains code.

**Together (B, E, F)**

- **Duo divergence** (R1). `TogetherLiveState.opener`, `plan` (`TogetherRunPlan`) and `quizIds` are added before the freeze; the joiner follows the opener.
- **loadWeekPlan** takes `{ state, partner }`; B never imports sync (R1).
- **Crediting** is idempotent on `DayRecord.together`, and the `together` broadcast includes the sender. Duo test added (R1).
- **Tasks and stages** (R2). They follow the couple's settled unit (new `MemberProgress.settledUnit`, `recentItems`, `coreReached`, `grammarReached`), and `taskTargets` builds targets from both partners' 2–21-day items. Without a task, Session B runs a free role-play, or the next core conversation, at stage 1. I did not adopt the reviewer's "greetings task" option, because no such task is authored.
- **Monthly session** is its own session. Quest counts distinct A/B/C, with monthly standing in for one missing letter (R1, R2).
- **Shared streak** (R2). v2 shows `questStreakWeeks`; `sharedStreak` is v1-only.
- **Can-dos** (R2). Speak/write can-dos are awarded only by the AI; `via 'partner'` is removed. The season showcase step is defined in Session C (R2).
- **Dictation** (R2). New `dictation` quiz kind; it grades the kanji's write card in window and logs an encounter otherwise.
- **eligibleRolePlays** (R2) checks both partners. It uses "introduced" (from `coreReached`/`grammarReached`) rather than "known", because the partner's per-item state is not synced.
- **Fold precedence** fixed (R1).
- **Legacy role-plays** (R1). A core conversation is a script named by a `UnitSpec.conversation`; `RolePlay.unit` is a level gate.

**Data pipeline (A)**

- **Core ids** are locked at release, with a lock file and test; later reorders change `order` only (R1).
- **Mnemonic lint** (R2). Hard checks: a hook for every kanji of rank ≤ 500, each exactly one sentence of ≤ 20 words. Kana hooks are checked too.
- **Plain-form pacing** (R2). A build warning plus §6.4 question 2. Reordering is the content authors' call.
- **Core conversations** must have 100 % coverage. The current content already meets it (R2).

**Process and ownership (all)**

- **Browser QA** (R1 HIGH). It now runs only on the integration tag `v2-int`, after all six branches merge (§6.1 steps 2–3), because removed v1 exports stop the app linking until every owner is on v2. I chose this over compatibility shims, which would have had to cover files of four owners.
- **Ownership gaps** (R1). F owns `.dockerignore` (which adds `.cache`) and `UpdatePrompt.test.tsx`.
- **Undocumented departures** (R2) are now listed in §6.3 #23–29.
- **Chapters** list their words and grammar (`chapterItems`) (R2).

**Drift found while revising (not in the reviews)**

1. HEAD is now `900cbfc` (content checkpoint).
2. `content/roleplays-v2.json` (a stale combined export: same 39 ids, 31 scripts differ) sits next to the edited folder. The old "merge both, duplicate ids fail" rule would have failed the build. Now the folder wins and the file is ignored with a warning. `units/` takes precedence over `units.json` in the same way.
