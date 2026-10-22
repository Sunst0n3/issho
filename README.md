# Issho (一緒)

Issho ("together") is a Japanese course for two people learning side by side. It is an installable web app (PWA) that takes a beginner from kana to the 2,136 jōyō kanji. Every character is written from memory on a handwriting pad, vocabulary and grammar are scheduled with spaced repetition (FSRS), and each day includes reading and listening at the learner's level. Partners on the same household server also share a chat, quiz each other and run short weekly sessions together. Each phone keeps its own progress offline. A small self-hosted server links the phones and serves the app, and it can add natural Japanese speech (VOICEVOX) and an optional AI tutor (a local model through Ollama, or the Anthropic API).

Built by Carter Caldwell.

## Features

### Learning

- **A daily plan measured in minutes** (25 by default), not card counts: warm-up reviews, a few new items at a time, an ungraded memory pass, reading and listening, a first graded check of the day's new cards, and one sentence written for your partner.
- **Kana first.** A two-week sprint teaches hiragana, then katakana, row by row. An optional placement check skips what you already know.
- **Kanji handwriting from memory.** Each lesson shows the kanji's parts, a keyword, a mnemonic and an anchor word with audio. You then write it on a touch pad. A stroke matcher compares each stroke with KanjiVG data and catches the wrong direction, order, position or shape, while still accepting shaky finger strokes. Stroke-order animations show how to write each character.
- **Spaced repetition with FSRS** (ts-fsrs). Production cards (write, say) and recognition cards (read, listen) have separate retention targets. You can type answers in kana with built-in romaji input, write them by hand, say them aloud or grade yourself.
- **Words and grammar.** The course has 1,580 core words taught audio-first and about 23,500 JMdict words introduced after their kanji. It also has 115 grammar points with examples and sentence-building exercises.
- **Reading and listening.** You start with short sentences just above your level. Graded stories (64 of them) unlock once you know at least 98% of a story's words and all of its grammar. You read while listening, with phrase highlighting and furigana over kanji you haven't learned yet. There is also shadowing, pitch-accent lines, a pitch-ear drill and short drills for numbers, times and prices.
- **Habits without guilt.** Rest tokens, a short welcome-back plan after missed days, a travel mode, and calendar reminders exported as an `.ics` file.

### Together

- **Household pairing.** Each phone joins once with a shared household code. The server gives the phone a device token and stores only a hash of it.
- **Chat** with text and voice messages, automatic furigana and a "How do I say this?" helper. Messages wait in an offline outbox until they can be sent, and they arrive live over a WebSocket.
- **Shared progress.** Each partner can see the other's study days. A shared streak counts study days, which end at 4 a.m. in the household's time zone, and a weekly couple quest tracks goals for both partners.
- **Together sessions.** Three 15-minute sessions a week and one monthly session. They include partner quizzes built from each other's recent items, whose results count toward the answerer's reviews. Partners also explain a kanji to each other from memory, act out scripted conversations, work through task cards with an information gap, do role-plays, retell stories and take dictation.

### Speech and AI

- **Natural voices.** The course comes with 8,816 pre-generated VOICEVOX clips in two voices. The server's VOICEVOX engine reads everything else, such as chat lines and AI replies, and caches the audio on disk. Without it, the phone's own Japanese voice is used.
- **Speech recognition** through the browser's Web Speech API, for spoken answers, shadowing and role-plays. This needs a network connection.
- **Optional AI tutor**, running on the server:
  - It marks up to two problems in a sentence without fixing them, and after one retry it shows the corrections and a one-line rule.
  - It translates English into casual Japanese.
  - It plays a third role in task cards.
  - It writes a private recap after a task.
  - It checks speaking and writing tasks against a rubric.

  The tutor runs on a local model through Ollama (Qwen 3.5 4B by default) or on the Anthropic API. Ollama gets one request at a time, one queued request and a 40-second time limit per call. With AI off or unreachable, these checks are skipped or replaced by scripted versions, and the rest of the app works the same.

### Offline

- The service worker caches the app and all study data in advance, so lessons and reviews work without a connection. Voice clips are cached the first time they play and are downloaded ahead of time in packs per unit.
- Progress is stored in IndexedDB on the phone. You can export and import it by hand. When the phone is paired with a server, the app also uploads snapshots there, and the server keeps the latest 14 for each member.

## Tech stack

- **App:** TypeScript, React 18, React Router 6, Vite 6, vite-plugin-pwa (Workbox), Dexie 4 (IndexedDB), ts-fsrs
- **Server:** Node.js 24 (runs TypeScript directly), Fastify 5 with `@fastify/websocket`, `@fastify/multipart` and `@fastify/static`, SQLite via `node:sqlite`, zod 4, Anthropic SDK
- **Speech:** VOICEVOX engine, Web Speech API (recognition and device voice), MediaRecorder (voice messages and shadowing)
- **AI:** Ollama (GPU or CPU) or the Anthropic API
- **Data pipeline:** sax (dictionary XML), kuromoji (tokenizing text for coverage checks), ffmpeg (encoding clips)
- **Testing:** Vitest, Testing Library, jsdom and fake-indexeddb for the app; `node:test` for the server
- **Deployment:** multi-stage Docker image (`node:24-slim`), Docker Compose

## Architecture

```
Phone (PWA)                                   Home server (Docker Compose)
React + Dexie (IndexedDB)    HTTP + WebSocket   issho: Fastify + SQLite, serves the app
FSRS, planner, handwriting  <---------------->    ├─ voicevox (optional speech)
clips cached by the service worker                └─ ollama   (optional AI)
```

- **Local-first app.** All learning state (cards, review logs, settings) is stored in IndexedDB through Dexie. Scheduling, planning and grading are pure TypeScript functions in `src/srs/`, with thin database wrappers around them. That keeps them easy to unit-test and lets a simulation run them over months of study. The app needs the server only for household features, server speech, AI and backups.
- **Server.** Fastify runs the TypeScript sources directly on Node 24, so there is no build step. The server uses SQLite with append-only migrations and validates every request with zod. It rate-limits pairing and AI requests, and a WebSocket hub handles live chat and presence. It also serves the built app, sending pre-compressed brotli or gzip copies of its files.
- **Shared types.** `shared/api.ts` defines the request and response types used on both sides. `shared/voicevox.ts` holds the voice settings and reading helpers that the app, the server and the audio generator all use.
- **Build-time data.** `scripts/build-data.ts` turns JMdict, KANJIDIC2, KanjiVG and the course files in `content/` into the static JSON in `public/data/`. The build fails on structural problems. `scripts/audio/generate.ts` makes the voice clips with a local VOICEVOX engine. Each clip is named after a hash of its content, so a cached clip is never out of date.
- **Audio fallback.** When a word or sentence is played, the app looks for a bundled clip first, then asks the server's VOICEVOX engine, then falls back to the phone's own voice.

## Running it locally

You need Docker with Compose. To develop without Docker, you need Node.js 24.2 or later.

### Docker Compose

```sh
cp server/.env.example server/.env   # then set HOUSEHOLD_CODE
mkdir -p issho-data                  # on Linux, make it writable by uid 1000
docker compose up -d --build
```

Open `http://localhost:8787`, finish setup, then pair from Settings or Together with the household code.

Services:

- `issho`: the app and API on port 8787 (plain HTTP). Data is stored in `./issho-data`.
- `voicevox`: the optional speech engine (a CPU image of about 2 GB). Only `issho` can reach it, over Docker's internal network. To leave it out, run `docker compose up -d --build issho`.
- `ollama-gpu` / `ollama-cpu`: optional local AI, behind the `ai-gpu` profile (needs the NVIDIA Container Toolkit) and the `ai-cpu` profile. Set the `AI_*` variables in `server/.env`, then:

  ```sh
  docker compose --profile ai-gpu up -d --build
  docker compose exec ollama-gpu ollama pull <the model in AI_MODEL>
  ```

Household admin (list, rename, revoke or remove members, or rename the household):

```sh
docker compose exec issho node server/src/admin.ts help
```

### Phones and HTTPS

Browsers allow offline use (service workers) and microphone access only on `https://` pages and `localhost`. To use Issho on phones, put the server behind a reverse proxy that handles HTTPS, such as Caddy or Tailscale Serve. Set `TRUST_PROXY` to the proxy's address so that rate limits see each phone's real IP address. If the proxy runs on the same machine, publish port 8787 on loopback only. `server/.env.example` explains both setups.

### Environment variables

Set these in `server/.env`. `server/.env.example` describes each one.

- `HOUSEHOLD_CODE` (required): the shared secret each phone types once to join.
- `HOUSEHOLD_NAME`: the name shown in the app. The admin CLI can change it later.
- `TZ`: the household time zone. A study day ends at 4 a.m. here.
- `AI_PROVIDER` (`off`, `ollama` or `anthropic`), `AI_MODEL`, `AI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`: the optional AI tutor.
- `VOICEVOX_URL`, `TTS_CACHE_MB`: server speech and the size of its disk cache. Compose sets `VOICEVOX_URL` for you.
- `TRUST_PROXY`: the reverse proxy's address, given as IPs, CIDR ranges or `loopback`.
- `LOG_LEVEL`
- `PORT`, `HOST`, `DATA_DIR`, `STATIC_DIR`: used only outside Docker. Compose sets these itself.

### Development without Docker

```sh
npm ci && npm ci --prefix server
cp server/.env.example server/.env   # set HOUSEHOLD_CODE
npm run dev --prefix server          # API on port 8787
npm run dev                          # in a second terminal: Vite, which proxies /api to port 8787
```

Tests and type checks:

```sh
npm test                    # app, data pipeline and content (Vitest)
npm test --prefix server    # server (node:test)
npm run typecheck
```

The built study data (`public/data/`) and voice clips (`public/audio/`) are committed. To rebuild them:

- `npm run build:data` needs `data-raw/` with `JMdict_e.gz`, `kanjidic2.xml.gz` and `kanjivg.xml.gz`. These files aren't committed, and the script prints where to download any that are missing.
- `npm run build:audio` needs a local VOICEVOX engine and ffmpeg (or `afconvert` on macOS).
- `npm run check:content` checks the course files in `content/`.

## Repository layout

```
src/            the PWA
  screens/        top-level screens (Today, Learn, Library, Together, Settings, ...)
  components/     study, home and together UI
  srs/            scheduling, daily planner, course gates, grading (pure functions)
  writing/        handwriting pad, stroke matcher, stroke-order display
  speech/         clip playback, server and device speech, recognition, recording
  sync/           server client, WebSocket, chat outbox, backups
  lib/            IndexedDB schema, data loading, types, backup, calendar export
server/         home server: API routes, WebSocket hub, SQLite store, speech proxy, AI, admin CLI
shared/         API types and VOICEVOX helpers used by the app, server and scripts
content/        course content: units, core words, grammar, sentences, stories, role-plays, mnemonics
scripts/        data build, audio generation, content checks
public/data/    built study data (committed)
public/audio/   pre-generated VOICEVOX clips and their manifest (committed)
docs/           research plan, research findings, technical design, content schemas
```

## Data and credits

Issho is built on open dictionary data and free voice software. These files are covered by their own licenses and terms, not by the license of the source code.

- **JMdict and KANJIDIC2**: © Electronic Dictionary Research and Development Group ([EDRDG](https://www.edrdg.org/)), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The word and kanji data in `public/data/` comes from them and is shared under the same license. Sources: [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html), [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project).
- **KanjiVG**: © Ulrich Apel, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The stroke data in `public/data/strokes.json` comes from [KanjiVG](https://kanjivg.tagaini.net/) and is shared under the same license.
- **VOICEVOX**: the voice clips in `public/audio/` and the pitch-accent data in `public/data/accent.json` were generated with the [VOICEVOX](https://voicevox.hiroshiba.jp/) engine (0.25.2). Voices: **VOICEVOX:No.7** and **VOICEVOX:青山龍星**. Use of this audio is governed by the [VOICEVOX terms](https://voicevox.hiroshiba.jp/term/) and the terms of each voice ([No.7](https://voiceseven.com/), [青山龍星](https://www.virvoxproject.com/voicevox%E3%81%AE%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84)). If you reuse the clips, keep these credits and follow those terms. In particular, the No.7 audio may be used only non-commercially unless you get permission first, and the 青山龍星 audio may not be used to train voice models.
- **Fonts**: Shippori Mincho and Zen Kaku Gothic New, [SIL Open Font License](https://openfontlicense.org/), loaded from Google Fonts.
