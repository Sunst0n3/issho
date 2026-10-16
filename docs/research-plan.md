# Issho research plan

The research-based redesign behind Issho v2: what the evidence says, what changed in the daily routine and why.
Detailed findings with sources are in [research-findings.md](research-findings.md); how it was built is in [tech-design.md](tech-design.md).
Written in October 2026 before v2 was built, so "today's app" below means v1.

## Summary

- Plan each day in minutes, not in item counts. You pick 20, 25 or 30 minutes; the default is 25. Today's app promises 15 minutes but actually takes about 40. After the change, the app will hold you to the number you picked, and Settings will show you the real figure.
- Every review becomes a recall. You write the kanji from memory, type the reading in kana, or say the word. Multiple-choice taps go away. Each kanji gets one handwriting card, and each word gets one card. Duplicate cards are removed. Remembering is what makes things stick, and recognising an answer does much less.
- All kana take about 2 weeks instead of 69 days. Kanji start on day 15, grammar on day 8, and everyday words on day 3. Romaji goes away by week 3.
- Two things get a lot bigger. You get about 1,500 everyday words you'll actually say to each other (ある, この, もう, でも, できる), plus about 115 grammar points instead of 37. Newspaper words like 国会 and 年金 stop showing up early.
- Every day ends with a short easy story you read while listening. Then you write one sentence in Japanese to your partner. The AI first points to where the mistake is so you can fix it yourself. Corrections it has checked become review cards.
- Together time is 3 × 15 minutes a week, each session with its own job. Tuesday: quiz each other on what you learned 2–10 days ago, then practise a conversation. Thursday: a real-life task, with the AI playing the waiter or clerk. Sunday: talk about the week's story, then a short check-in. Corrections come from the AI and stay private, so neither of you has to be the other's teacher.
- Missing a day is fine. Your streak counts any day you do a 3–5 minute minimum. You get 2 rest days a week. The first session back after a gap is a short welcome-back.
- Realistic pace at 25 min/day: about 100 kanji and 500 words by month 3. By month 12, about 270–310 kanji (all handwritten), about 1,550 words and 85–100 grammar points. That is roughly a two-year university course (Genki I and II) in one year. At 30 min/day you'd reach about 350 kanji and 1,800 words in a year.

## What the first version got wrong

An audit of v1 before the redesign:

- Too many cards per item: 8.4 cards per kanji unit drives about 140 reviews/day (about 40 min) at the default 5/day, well over the 20-30 min budget; the spec meant write cards only for kanji with 2+ lapses, but every kanji gets one
- The backlog pause (more than 150 due) decides progress, not the pace setting: new items stop on 39% of year-1 days at 5/day and 59% at 8/day; real pace falls to about 1.9 items/day; Settings promises 15 min but the real figure is about 40
- Duplicate cards: the kanji reading card reuses one of the kanji's own words (prepare.ts:163), repeating the word reading card (about 11% of reviews); 166 of the first 300 kanji duplicate their meaning card through an identical one-character word; 47 survival words come back as separate kanji-word cards
- Cards from the same unit are not kept apart: 60-72% of kanji/word reviews share a session with a sibling, and the feedback panel shows the sibling's answer (readings after meaning, meaning after reading)
- Mostly recognition: 4-choice is the default on every card; typing exists on only 3 card types; English to Japanese is never typed; a 25% lucky guess counts as Good; Easy is never given on objective cards
- Grammar is too thin and too slow: 37 points total (about 25-30% of N5, about 10% of N4); at most one every second day; no new grammar from day 85 to 161 while phase 3 waits for 300 kanji; runs out on day 190; 0.4 drills/day; the first point waits until day 25 because its examples use yōon
- Wrong vocabulary for daily life: words come only with kanji units, ranked by newspaper frequency (国会, 年金, 中立, 人口, 土木 early), and there are no kana-only words or loanwords (ある, この, とても, もう, まだ, でも, みんな, できる are never taught); the survival list (117 words) runs out on day 68
- The kana stage is very slow: 69 days at 5/day (104 at 3/day) for 208 separate items and 350 cards, with dakuten and yōon taught one by one instead of as rules; kanji start only on day 69
- Putting a kanji's parts first pulls 58 kanji that are not N5/N4 level into the first 300 (乙, 弔, 丙, 吏, 斤 with 0 words), each with 3 cards
- No listening practice: audio plays only after you answer; no dictation, no audio-to-meaning, no pitch accent; the only listen-first moment is a role-play partner's line, outside the routine
- Speaking and production are weak: shadowing is optional, ungraded and last in the session; role-play lines show Japanese, English and a hint at once; no sentence building or translation drills
- Reading content is thin: 2-4 single sentences/day (median 14 characters); none on days 1-13; the sentence check covers kanji only, not words or grammar (61 of 81 early sentences use untaught grammar); 450 sentences are recycled weekly (359 different ones in year 1); no connected text
- The first check comes seconds after the lesson, so it isn't a real memory test, yet it is each card's first FSRS grade; it adds 33-45 cards on new-item days; the 1m/10m learning steps are never used within the session
- Together features are not part of the plan: no schedule, reminders or prompts, no link to today's words or grammar, no streak credit; only 14 role-play scripts, with 3 covering everything after phase 2; quizzes never affect reviews
- Romaji stays on by default for the whole course, and kana reviews answer in romaji, which keeps romaji as a crutch

## A day in the life

How these numbers were made: I simulated the final plan with real ts-fsrs 5.4.2 at retention 0.90, the real curriculum.json (2.68 words per kanji), and per-card times measured from today's app. The script is scratchpad/final/simF5.mjs; run it as TK=0.6 TC=0.2 TG=0.2 node simF5.mjs <ROOT> 25 730 <seed> 500 8. I ran two seeds. Handwriting recall was set 6% below what FSRS predicts, so these are planning numbers, not promises.

DAY 1 (about 15 min: 4 min onboarding + 11 min study)
- Onboarding, once:
  - Each partner picks 25 min/day.
  - Each writes an if-then cue, e.g. "After I pour my evening tea at the kitchen table, I open Issho".
  - Each writes a coping plan, e.g. "If I miss it, I do 3 minutes before brushing my teeth".
  - Together you pick 3 together slots (e.g. Tue/Thu/Sun after dinner) and a dated shared goal.
  - You download the calendar reminders.
- Teach (about 8 min): the あ row and the か row, in two batches of 5. For each kana: hear the sound, see a one-line picture mnemonic, trace it once, then copy it once beside the model. After each batch, hear each sound and write it from memory, in mixed order.
- Read (about 2 min): read 6 real words made only of today's kana out loud before hearing them (あか, いえ, かお, あき, ここ, いく).
- First check (about 2 min): 10 graded cards. Hear a sound and write the kana; see a kana and type its sound.
- Summary: "You can now read あかい and かお. Tomorrow: about 14 min."
- There are no reviews, grammar or romaji labels. Romaji is used only as the typing method.

DAY 30 (about 25 min, can be split into two sittings)
Sim: about 41–46 reviews (about 10 min), about 10 min of new items, 4 min of reading and output. About 35 kanji, 150 words and 10 grammar points known so far.

Morning "anywhere" sitting, no pen needed (about 10 min). Reviews come in this order:
1. Yesterday's new cards first. This is the relearning after sleep.
2. Then the cards most at risk of being forgotten.

Card types you'll see:
- Kanji write card: shows the meaning, the anchor word with the kanji blanked (□本 にほん) and audio. You draw it from memory.
- Word read card: type the reading in kana, then confirm you knew the meaning.
- Core word cards: hear it and recall the meaning, or produce it from English.
- Grammar cards: understand a sentence, or build one.
- Kana write cards.

Only one card per kanji family shows up in a day. A missed card comes back after at least 5 other cards, and that second try is graded.

Evening "desk" sitting (about 15 min):
- Teach (about 7 min):
  - 2 kanji, each with one anchor word (e.g. 人 with 一人).
  - 1–2 "known kanji, new word" items, scheduled 3 and 8 days after their kanji.
  - 2 core words, audio first (e.g. もう, まだ).
  - Every second day, a grammar point. You try to say the sentence first, then read a one-screen rule, hear 3 examples and build 1 sentence.
  - Then you write each new kanji from memory, in mixed order.
- Read and listen (about 3 min): 2–3 study sentences that reuse words from the last 3 weeks. For each one: read it aloud before the audio, guess the target word's meaning from 3 options, then shadow and compare your recording with the model.
- First check (about 2–3 min): today's new cards, mostly production, now about 10 minutes after teaching.
- Output (about 1 min): one sentence to your partner using today's word. The AI marks where a mistake is; you fix it; then it shows the answer if you still need it.
- Summary: what you can now do, and tomorrow's minutes.

DAY 90 (about 25 min)
Known so far: about 100 kanji (old JLPT N5 had 103), about 500 words, about 35 grammar points.
- Reviews: about 55 cards, about 12–13 min.
- New (about 6 min):
  - 1–2 kanji with their anchor words.
  - About 2 staged words for earlier kanji.
  - 1–2 core words.
  - A grammar point every second day.
  - A memory write of each new kanji.
- Read and listen (about 4 min):
  - A Tadoku Start/L0-level micro-story of 200–400 characters. It is shown only if you already know at least 98% of its words.
  - You read it while listening, with each phrase highlighted.
  - Furigana appears only on words whose reading isn't solid for you yet. Your partner sees different furigana on the same story.
  - One gist question, then 1 study sentence with shadowing.
- First check: about 2 min. Output sentence: about 1 min.
- Mon/Wed/Fri: a 2-min fluency slot, such as a timed re-read of last week's story with characters per minute shown.

DAY 180 (about 25 min)
Known so far: about 175 kanji, about 900 words, about 60 grammar points.
- Reviews: about 57 cards, about 13–14 min.
- New (about 4–5 min): about 1 kanji with its anchor word, 2 staged words, 1–2 core words, grammar every second day.
- Read and listen (about 5 min): an L0–L1 story of 400–800 characters. Each story comes back on a schedule: read while listening on day 0, listen only around day +3, timed re-read around day +10.
- First check: about 2 min. Output: about 1 min. Fluency: 2 min on alternate days.
- Plus three 15-min together sessions that week.

MINUTES BY PHASE AT 25 MIN/DAY (simulated averages)

| Days | Total | Reviews | New items | Read/listen/output/fluency |
|---|---|---|---|---|
| 1–14 | 19–20 min | 7 min | 10 min | 2 min |
| 15–30 | about 25 min (cap 27) | 10 min | 11 min | 4 min |
| 31–90 | about 25 min | 12 min | 8 min | 5 min |
| 91–180 | about 25 min | 13 min | 6 min | 6 min |
| 181–365 | about 25 min | 14 min | 4 min | 7 min |
| Year 2 | about 24–25 min | 14 min | 3 min | 8 min |

Together time adds 45 min a week, which is about 6.5 min/day. The highest single day after week 4 in the simulation was 30 min; the hard cap brings that down to 27.5. Today's app averages about 40 min/day from day 90 onward.

## The weekly together routine

THE WEEK FOR EACH PARTNER
- Solo sessions run every day. Each person has 2 rest tokens a week, used by a deliberate tap, with no rollover.
- There are 3 together sessions of 15 minutes each, on the days and times you set at onboarding.
- Each together session counts as a minimum day for both of you.
- Each session uses items from about 2–21 days ago, never items introduced that day. This makes together time spaced retrieval instead of a repeat of today's lesson.

SESSION A, e.g. Tuesday: Quiz and core conversation
1. Quiz each other (about 6 min, 3 min each way)
   - The app builds up to 10 items per person: things learned 2–10 days ago, plus that person's misses from the last 7 days. Item types are mixed: write a kanji on paper or phone, read a word aloud, say a word from English, build a sentence.
   - The asker's screen shows the answer. The answerer must say or write the answer before it is revealed.
   - The asker taps right, close, or wrong.
   - If that card is due within 2 days, the result goes into the answerer's FSRS schedule (right = Good, close = Hard, wrong = Again). Otherwise it is logged as practice only.
   - One "teach me this kanji" turn: one partner explains a kanji's parts and memory hook with notes hidden, then the app shows the reference.
2. Core conversation (about 8 min), a 4–8 line dialogue at your level. Each script moves through four stages, one step per session, and moves on when you both mark it "smooth":
   1. Listen to the model audio (two voices) and shadow it together.
   2. Perform it from the Japanese script; the English is hidden behind a tap.
   3. Swap roles.
   4. Perform it from keyword cue cards only.
   Because the dialogue comes back every week, this is also your spaced shadowing practice.

SESSION B, e.g. Thursday: Real-life task
- One task card. It shows:
  - the can-do, e.g. "Order for both of us at a café"
  - a goal with a check at the end, e.g. "Did you get two drinks under 1,000 yen?"
  - a register note, e.g. "the clerk uses keigo; you use です/ます"
  - 5–8 target words and grammar from both partners' recent items
- Info-gap halves: one of you sees the menu, the other sees the budget and what you each want.
- Steps:
  1. 60–90 seconds of silent planning.
  2. Run the task.
  3. Swap roles and run it again.
- The AI can play a third role (clerk or waiter) by voice or text. Without the home server, a scripted version runs instead.
- Afterwards, each partner gets a private AI recap with 1–2 points. Corrected lines become review cards only after a dictionary and grammar check.
- The same task returns 2–7 days later with one twist.

SESSION C, e.g. Sunday: Story, game and check-in
1. Talk about the week's shared story (about 3 min). Both of you read it during the week, at the slower partner's level.
2. 4/3/2 retell (about 4 min): each partner retells the story or "our week" three times, in 90, then 60, then 45 seconds, keeping the same content each time.
3. Partner dictation (about 3 min): one reads 5 words from the other's recent items aloud, the other writes them in kanji, then you swap.
4. Weekly check-in (about 5 min). Each partner sees what they learned (counts filled in automatically) and ticks one can-do they managed. Then you set next week's slots and rest tokens. Check-ins are kept as history.

MONTHLY, first weekend
- A 20-item mixed quiz from everything learned, the items most at risk first.
- A goal-setting session with a fresh start.
- When a chapter ends (and once the content units ship), a capstone skit:
  1. Co-write it using a checklist of the chapter's structures.
  2. The AI checks it.
  3. Perform it from memory and record it to your portfolio.

GROUND RULES
- Partners never correct each other's grammar. Use one agreed signal (もう一度？) and point to the word.
- Explicit corrections come from the AI, privately.
- Turns alternate.
- Neither partner sees the other's accuracy or error counts unless they choose to share them.
- The couple quest is met when both of you have at least 5 minimum days and you've done 3 together sessions that week. It has 1 reserve token.

## Milestones and pacing

TARGETS AT THE DEFAULT 25 MIN/DAY SOLO + 45 MIN/WEEK TOGETHER
That is about 190 hours a year per person. Figures are ranges across two seeds of the final-plan simulation (scratchpad/final/simF5.mjs).

| Milestone | When | What you can do |
|---|---|---|
| M0 | Day 14 | All 92 basic kana written from memory; dakuten, yōon, っ and long vowels read as rules; about 35 core words; about 2 grammar points. Can-do: read a katakana café menu aloud; say greetings and the "please repeat / slow down" phrases. |
| M1 | Day 90 | About 100 kanji (old JLPT N5 spec had 103), about 500 words, about 35 grammar points. About 74% of the words in a typical text are now decodable, based on Matsushita's kanji coverage figures. The first Tadoku "Start" story unlocks at about 200 known words, around day 40. A1 can-dos: introduce ourselves, order at a café, ask a price or the time, say what we like. |
| M2 | Day 180 | About 175 kanji, about 900 words, about 60 grammar points: Genki I grammar scope and the A1 can-dos. Reading at Tadoku L0–L1. |
| M3 | Day 365 | About 265–310 kanji, all handwritten from memory (old N4 spec: 284; Genki I+II: 317). About 1,550 words (old N4 spec: 1,409; Genki I+II: about 1,700). About 85–100 grammar points. About 82% decodable. A2 can-dos: plan a weekend, talk about yesterday. Reading at Tadoku L1–L2. |
| M4 | Day 730 | About 390–490 kanji (about 87% decodable), about 2,500 words, all about 115 grammar points. Reading at Tadoku L2–L3. |

AT 30 MIN/DAY
- Day 90: about 133 kanji.
- Day 180: about 224 kanji, about 1,090 words, about 80 grammar points.
- Day 365: about 350 kanji, about 1,800 words, all 115 grammar points (old N4 kanji scope reached around day 290).
- Day 730: about 540–610 kanji.

AT 40 MIN/DAY
- Day 365: about 530 kanji, about 2,400 words.
- Day 730: about 950 kanji.

For comparison, today's app at its real cost of about 40 min/day gives 688 kanji, about 2,000 mostly newspaper-ranked words, 37 grammar points, no reading or listening block, and recognition-graded cards.

WEEKLY PACE AT 25 MIN (what the governor produces)

| Period | Kanji/week | Words/week | Grammar points/week |
|---|---|---|---|
| Weeks 1–2 | kana only | about 15–20 core words | 1–2 |
| Days 15–90 | about 9 | about 40 | 2–3 |
| Days 90–180 | about 5.5–6 | about 30 | 2–3 |
| Days 180–365 | about 3.5 | about 25 | 2 (floor) |
| Year 2 | about 2.5 | about 20 | 2 (floor, until done) |

Ceilings: 3 kanji/day, 3 core words/day, 4 staged words/day, 1 grammar point every second study day.

Benchmarks the pace was checked against:
- Genki class density: about 5.5–7 kanji and 30–36 words per 3.5–4.25 hours. Source: Japan Times, Genki 3rd ed.
- Penn and MIT first semester: 58–110 kanji. Write targets in those courses are about 64% of read targets.
- Japanese primary schools: 80–200 kanji per year.
These are practitioner benchmarks.

TO GO FASTER WITHOUT CRAMMING
- Raise the budget to 30 min: about +30% kanji in year 1.
- Shrink the write list from 500 to 300 in year 2: about +10% (simulated).
- Allow 0.85 retention on recognition-only cards: about +10–15% (from an earlier simulation).
- Never set retention above 0.95 or add a cram mode. Workload climbs steeply above 0.95 (Anki/FSRS documentation), and learners misjudge massed practice as better (Kornell 2009).

SOURCES FOR THE TARGETS
- Coverage: Matsushita 2019, Table 1 (BCCWJ). Top 100 kanji ≈ 74%, 300 ≈ 83%, 500 ≈ 88%, 1,000 ≈ 95% of word tokens decodable.
- Old JLPT 2004 specification, via the Wikipedia JLPT article: level 4 = 103 kanji / 728 words; level 3 = 284 kanji / 1,409 words. Graded weak.
- Self-reported study hours for learners without a kanji background: about 250–400 hours for old N5, about 500–750 for old N4 (Japan Language Education Center data).
- Genki I+II: 317 kanji, about 1,700 words, about 200 class hours (Japan Times).
- Tadoku level ladder: Start = 200-word vocabulary; L0 = 350 words, 200–400 characters; L1 = 400–1,500 characters; L2 = 1,500–3,000 characters (NPO Tadoku Supporters).
- FSI: about 2,200 class hours to professional proficiency (secondary sources). This is used only as the long-view progress meter.

WHAT THE APP SHOWS
- Short chapters of about 15 kanji each, with the words and grammar introduced in that span.
- A season finale every 12 weeks.
- Coverage percentage.
- Real recall at 1 week and 1 month.
- Reading speed in characters per minute.
- Cumulative hours against the benchmarks above.
- It does not show one long bar toward 2,136 kanji.

## The changes

Priority: P0 must-do, P1 high value, P2 nice to have. Size: S/M/L implementation effort.

### 1. Set a daily time budget and let the planner fill it; drop newPerDay, the 150-card cliff and the 120-review cap

**Priority:** P0 · **Size:** M · **Learner time:** About 15 min/day less than the current real load at the default.

**Impact:** - At 25 min, simulated sessions average 24–25 min from week 3 through year 2. The worst single day before the cap is 30 min, and the cap keeps it at or under 27.5. Today's app averages about 40 min.
- New items pause gradually instead of stopping for weeks.
- The minutes the app shows are accurate.

**Evidence:** - No controlled evidence gives a best number of new items per day. Reviews settle at about 10× new cards per day, and early overload leads to backlog and burnout. [practitioner: Anki manual]
- Review debt drives spaced-repetition burnout. Throttle new items when forecast reviews pass about two-thirds of the budget. [practitioner]
- A missed day is harmless and backlogs should be spread out. Spacing has a medium-to-large effect in L2 learning. [strong: Kim & Webb 2022]
- A success rate around 85–90% is a reasonable target for the accuracy brake. [weak: Wilson et al. 2019; Eglington & Pavlik 2020]
- My simulation tested the earlier proposals' rule (full new items ≤60% of the slice, half up to 75%, none above). It switched new items fully off on 78 of days 181–365 and 207 days of year 2. Filling the budget kept sessions at 24–25 min and gave steadier progress.

SETTINGS
- Add Settings.dailyMinutes: 20, 25, 30 or 40. Default 25.
- Migrate the old pace: newPerDay 3 → 20, 5 → 25, 8 → 30.
- Remove newPerDay, maxReviewsPerDay, BACKLOG_LIMIT and backlogThreshold. Keep an internal safety cap of 400 reviews per sitting.

PLANNER (planToday, run at the start of every sitting)

1. Strand reserve R, in minutes:
   - days 1–14: 2
   - days 15–60: 4
   - from day 61 until 1,200 known words: 6
   - after that: Rmax, where Rmax is 6, 8, 9 or 10 for budgets of 20, 25, 30 or 40
   The language-focused slice is LF = dailyMinutes − R.

2. Seconds per card type (s_t):
   - Use the per-user median of reviewLogs.durationMs over the last 200 logs of that type, clamped to 3–60 s.
   - Until a type has 30 logs, use these defaults: kana read 6, kana write 12, kanji write 22, kanji meaning 8, word read 11, produce 12, listen 7, comprehend 10, build 18, cloze 15.
   - A miss costs s_t + 8 s extra.

3. Review load:
   - Today's review time: Rv = Σ over due cards of s_t + (1 − R_i)(s_t + 8), where R_i is the card's FSRS retrievability now.
   - 7-day forecast: F7 = (1/7) × Σ over cards due in the next 7 days of 1.12·s_t.

4. Time for new items: NewRoom = LF − max(Rv, F7) − 60 s.
   - Fill NewRoom with priced items: kanji 160 s plus 28 s for its anchor word; core word 35 s; staged word 28 s; grammar 200 s; kana 35 s.
   - Hard cap: the projected total (Rv + new + R) may not exceed 1.1 × dailyMinutes.
   - The kana sprint (change 5) is a fixed plan and is never throttled.

5. How NewRoom is shared out:
   1. First, staged words that are due (at most 4 a day).
   2. Then grammar, if the stream is under its floor of 2 points a week. Grammar never comes 2 days in a row and is at most 1 every second study day.
   3. Then a deficit round-robin over the kanji and core-word streams. Targets are shares of new-learning seconds over the last 14 days: kanji 60%, core 20%, grammar 20%. Ceilings: kanji 3 a day, core 3 a day.
   4. When a stream is most in deficit, its expensive item (a kanji or a grammar lesson) goes in first, and cheaper items fill whatever room is left.

6. Accuracy brake:
   - If first-try success on Review-state cards (first checks excluded) over the last 3 study days is below 80%, multiply NewRoom by 0.5.
   - If it is at or above 95% for 7 study days and the average session ran under budget, show the prompt "Add one more kanji today?"

7. Catch-up mode (when Rv > dailyMinutes):
   - No new items.
   - Cap the strand block at 2 min.
   - Show reviews in order of lowest retrievability, with ties broken by value: write-list kanji, then 'use' words, then the rest. Truncate to (dailyMinutes − 3) minutes; the rest stay due.
   - Leave catch-up when Rv ≤ LF.
   - Never show a card-count number during catch-up.

UI
- Today and SessionPanel show "About N min today · tomorrow about M".
- Settings and Onboarding show minutes, plus a simulated note: "about 270–310 kanji in a year at 25 min".
- Delete minutesForPace.

Sources:

- Anki Manual, Deck Options (new cards/day, FSRS desired retention): https://docs.ankiweb.net/deck-options.html
- FSRS wiki, The Optimal Retention: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Optimal-Retention
- Kim, S. K., & Webb, S. (2022). Language Learning, 72(1), 269–319. https://doi.org/10.1111/lang.12479
- Wilson, R. C., et al. (2019). The Eighty Five Percent Rule for optimal learning. Nature Communications, 10, 4646.
- Eglington, L. G., & Pavlik, P. I. (2020). npj Science of Learning, 5, 15.
- Final-plan simulation: scratchpad/final/simF5.mjs (two seeds, real ts-fsrs 5.4.2)

### 2. One card per memory trace: about 4 cards per kanji unit instead of 8.4, radical cards removed, words and grammar remodelled

**Priority:** P0 · **Size:** L · **Learner time:** Large saving: about 10 min/day of review time at a comparable kanji pace.

**Impact:** - A kanji unit introduces 2 cards on its first day and about 4.1 once its staged words arrive: 1 write + 2.68 read + about 0.4 produce.
- Simulated reviews settle at about 55–60 a day instead of about 140.
- Every remaining card trains one specific trace (form, or sound plus meaning) by recall.

**Evidence:** - Knowing a kanji is not the same as knowing its words. Make the word the main SRS unit for reading. [moderate: Matsushita 2019; Rose 2013]
- Handwriting builds memory for the form and the form–meaning link, but not the link to sound, so the typed reading lives on the word card. [moderate: Guan et al. 2011; Lyu et al. 2021; Wiley & Rapp 2021]
- Writing from memory and recognition are partly separate skills, which supports two tiers of handwriting. [moderate: Naka & Naoi 1995; Sugaya 2025]
- Courses expect more kanji read than written: Penn writes about 64% of what it reads, and Japanese schools write each grade's kanji one year after reading them. [practitioner]
- Keep production for words the learners need to use; words only needed for reading can stay receptive. [strong: Rowland 2014; Webb 2009; Webb et al. 2020]
- No study supports a separate radical SRS card. Components help most when shown at the first exposure. [moderate: Taft & Chung 1999]
- The audit found 11% of reviews are exact duplicates, and a what-if run with 2 kanji cards + 1 word card reached 1,079 kanji instead of 688 in the same time.

NEW CARD TYPES
Add 'listen', 'produce', 'comprehend', 'build' and 'cloze' to CardType. Add a 'kanaRule' ItemKind.

cardTypesFor:
1. Basic kana (92): ['read', 'write'].
2. kanaRule items: ['read']. There are 5 of them: hiragana dakuten/handakuten; hiragana yōon + small っ + long vowels; the same two for katakana; and katakana extended sounds (ティ, ファ, ー). The read card cycles through 4-kana real words that use the rule.
3. Radical: no cards. Its name and meaning live in the kanji lesson's parts panel and in the feedback shown after a miss.
4. Kanji: ['write']. Kanji with no taught words (51 of them) get ['meaning', 'write'].
   - Write prompt: English keyword, plus the anchor word with this kanji replaced by □ and its reading in kana (e.g. 'day · □本 にほん'), plus an audio button. The learner draws the kanji from memory.
   - Two tiers: every kanji is handwritten in its lesson, its memory pass, its first check and its early reviews. When a kanji ranks above the write list (default 500, slider 0–2,136, per-kanji pin to keep), its write card retires once FSRS stability is above 21 days. Retire means suspend; it is not deleted. Recognition then continues through its word cards.
5. Kanji word: ['read'], plus ['produce'] if the word is tagged use.
   - Read card: show the word, inside a known carrier phrase when one exists in the sentences data. The learner types the reading in kana using the romaji→kana converter. Then reveal the meaning, audio and pitch. The learner taps 'knew the meaning' or 'didn't'.
   - Grading: Again if the reading is wrong or the meaning was unknown; Hard if the reading took a retry; otherwise Good.
   - Store both sub-outcomes in ReviewLogRecord.parts = {reading, meaning}.
6. Core word: ['listen'], plus ['produce'] if tagged use.
   - Listen: audio plays with the text hidden. Reveal the text and meaning, then self-grade Missed (Again) or Got it (Good).
   - Produce: English gloss plus a context note (e.g. 'to your partner, casual'). The learner types the Japanese, or speaks it (see change 3).
7. Grammar: ['comprehend', 'build'] (details in change 7).
8. Sentence (saved, or a verified correction): ['cloze'].

MERGING DUPLICATES
- When a kanji unit introduces a word that is already known as a core word in kana (元気, 名前, 水 …), do not create a new word item. Add the written form to the existing item and create only its word|read card. Its first check counts as introduction.
- Never create a single-kanji word card that is identical to its kanji's prompt (166 cases today). That word becomes the kanji's anchor and is learned through the write card plus a typed reading.

MIGRATION (bump the Dexie version)
- Suspend kanji|meaning (except for zero-word kanji), kanji|reading, radical|meaning and word|meaning. Set the flag suspended:'retired-v2'.
- word|reading becomes word|read, carrying its FSRS state over.
- vocab|recall becomes vocab|produce, with stability capped at 7 days so it is retested soon (it was graded by multiple choice).
- vocab|meaning becomes vocab|listen, with the same cap.
- grammar|drill becomes grammar|comprehend; a new build card is created.
- Review logs are never touched.

Sources:

- Matsushita, T. (2019). NINJAL symposium paper, pp. 48–55.
- Guan, C. Q., et al. (2011). Journal of Educational Psychology, 103(3), 509–522.
- Lyu, B., et al. (2021). International Journal of Educational Research, 106, 101740.
- Wiley, R. W., & Rapp, B. (2021). Psychological Science, 32(7), 1086–1103.
- Naka, M., & Naoi, H. (1995). Memory & Cognition, 23, 201–212.
- Webb, S. (2009). RELC Journal, 40(3), 360–376.
- Webb, S., Yanagisawa, A., & Uchihara, T. (2020). Modern Language Journal, 104(4), 715–738.
- Taft, M., & Chung, K. (1999). Psychologia, 42(4), 243–251.
- Rose, H. (2013). Modern Language Journal, 97(4), 981–992.

### 3. Reviews ask for recall: typed, written or spoken answers by default; multiple choice only as a scaffold

**Priority:** P0 · **Size:** M · **Learner time:** About +2–3 s per typed card, roughly +1.5 min/day. Change 2 saves far more than this.

**Impact:** - Each review gives a larger testing effect.
- FSRS grades become honest, which also makes the time governor in change 1 accurate.
- Vocabulary becomes usable in chat and in role-plays.

**Evidence:** - Recall and production formats (short answer; typed, spoken or written recall) produce more durable learning than multiple choice. Without feedback, multiple-choice quizzes were no better than rereading. [strong: Rowland 2014; Kang, McDermott & Roediger 2007]
- Use multiple choice only as first-day scaffolding. [strong]
- Practice in the productive direction adds +22.4 points on form recall. [strong: Webb et al. 2020]
- Typing kana strengthens the link between sound and written form. [moderate: Lyu et al. 2021; Sugaya 2025]
- Today a 25% lucky guess is graded Good, so FSRS schedules recognition as if it were recall (audit).

1. Reviews never show 4 options by default.
   Multiple choice is allowed in only two places:
   (a) the lesson's ungraded comprehension taps
   (b) a 'Show options' hint on typed cards; the grade is then capped at Hard, and a wrong pick is Again
2. Default answer mode per card type:
   - kana read: in days 1–14, type the romaji; after that, type the reading of a short real word.
   - word read: typed kana.
   - produce: typed kana, or speech.
   - listen and comprehend: reveal, then self-grade.
   - build: tiles until 60 grammar points are known, then typed.
   - write: handwriting.
3. Kana input uses src/srs/romaji.ts as an in-field IME: n' gives ん, a doubled consonant gives っ.
   - Match on normalizeKana.
   - Accept long-vowel variants listed in the word data (おう/おお).
4. Speech on produce cards is optional. A mic button calls speech/recognition.ts and compares the kana-normalised transcript with the expected reading and alternates.
   - If recognition is unavailable or offline, fall back to typing.
   - If recognition fails twice, offer 'I said it — self-grade' (Hard at most).
5. Grading (answers.ts):
   - correct on the first try: Good
   - correct after a hint or retry: Hard
   - wrong: Again
   - objective cards never produce Easy
   - self-graded cards offer only Missed / Got it
6. Remove the per-device typing toggle in prefs.ts. Keep an accessibility 'hands busy' mode that allows choices, logs mode 'choice', and caps the grade at Hard.
7. Romaji is never displayed in reviews after day 14.

Sources:

- Rowland, C. A. (2014). Psychological Bulletin, 140(6), 1432–1463.
- Kang, S. H. K., McDermott, K. B., & Roediger, H. L. (2007). European Journal of Cognitive Psychology, 19(4–5), 528–558.
- Webb, S., Yanagisawa, A., & Uchihara, T. (2020). Modern Language Journal, 104(4), 715–738.
- Lyu, B., et al. (2021). International Journal of Educational Research, 106, 101740.
- Karpicke, J. D., & Roediger, H. L. (2008). Science, 319(5865), 966–968.

### 4. Session order with spacing inside the session: relearn first, teach in batches, delay the memory write, read before the first check, re-ask misses later and grade them, and keep sibling cards apart

**Priority:** P0 · **Size:** M · **Learner time:** Neutral. The same work is reordered. Skipping tracing for known parts saves about 20–30 s per kanji; the pre-guess adds about 5 s.

**Impact:** - The first FSRS grade becomes a real memory test.
- Every new item gets about 3 spaced retrievals on day 0 and a sleep-consolidated relearn on day 1.
- Siblings stop giving each other's answers away, so FSRS stability estimates stop being inflated.

**Evidence:** - Total spacing between retrievals matters, including within a session. Back-to-back repetition is the least effective arrangement. [strong: Karpicke & Bauernschmidt 2011 found about 200% better retention; Kornell 2009]
- Successive relearning: re-ask a missed item later in the same session after other items, then on spaced later days. [strong: Rawson & Dunlosky 2011; Rawson et al. 2013]
- Within-session repetitions have diminishing returns; one retrieval gives the most per minute. [moderate: Nakata 2017; Rohrer et al. 2005]
- Sleep before relearning halves relearning trials. [moderate: Mazza et al. 2016; Gais et al. 2006]
- Keyword memories fade fast unless retrieved early. [moderate: Wang & Thomas 1995]
- Tracing weakens the writing benefit; producing the character yourself is what helps. [moderate: Naka 1998]
- Guessing helps when the guess can be related in meaning to the answer. [moderate: Huelser & Metcalfe 2012; Potts & Shanks 2014]
- Learners prefer massing, so the app should control the schedule. [strong: Kornell 2009]
- Audit: 60–72% of kanji and word reviews share a session with a sibling, and the first check comes seconds after teaching.

STEP ORDER (Session.tsx)
1. Warm-up reviews.
2. Teaching batches.
3. Memory pass.
4. Read & listen.
5. First check.
6. Output sentence.
7. Fluency/pitch slot (alternate days, when available).
8. Summary.

RE-PLANNING
- planToday re-runs at the start of each sitting.
- 'Anywhere' sitting: warm-up only, plus listen cards. No pen needed.
- 'Desk' sitting: everything else.
- Either order is allowed. The day is complete when every step is done or the minimum day is met (change 8).

WARM-UP
- Order: Learning-state cards introduced yesterday first (relearning after sleep), then Review cards by ascending retrievability.
- Sibling rule:
  - A sibling group is a kanji's write card plus that kanji's word cards, or word cards that share the kanji being written.
  - At most one card per sibling group per day. Show the one with the lowest retrievability; bump the others by 1 day.
  - If siblings must appear together (catch-up mode), keep them at least 10 cards apart.
- After a miss, show full feedback (change 9). Reinsert the card after at least 5 other cards, or at the end if fewer remain. Grade it again; this second grade counts as the FSRS relearning step.
- Remove the ungraded end-of-block repeat.

TEACHING BATCHES
- Up to 4 items per batch.
- Kanji:
  - Pre-guess (5 s, ungraded). Only when curriculum flags the kanji inferable: all components already known and the meaning is semantic (休, 明, 林).
  - Lesson: parts panel (plain list with names, no colour overlays), keyword, one-line mnemonic, anchor word with audio.
  - Trace once, only if any component is new to this learner.
  - Guided copy beside the model, with the learner's own ink visible.
- Core word: audio first, then text and meaning.
- Grammar: see change 7.

MEMORY PASS (after each batch)
- Write each kanji from its write prompt, in mixed order.
- Say or type each core word from English.
- Ungraded. A miss shows the answer.

FIRST CHECK
- About 10 minutes after teaching, after the read block.
- All of today's new cards, production types first.
- This is the first FSRS grade.
- Keep the ts-fsrs default learning steps ['1m', '10m'], verified: New + Good → Learning, due in 10 min; next morning + Good → Review, interval about 2 days. So a correct first check normally next appears in tomorrow's warm-up.
- A fail is reinserted after at least 5 cards and graded.

RETRIEVAL CAP
- A new item is retrieved at most 3 times on its first day (memory pass, appearance in reading, first check), plus one graded re-ask if missed.
- No 'write it 10 times' drills.

SUMMARY
- No passive list of items.
- Shows: one 'you can now…' line, today's minutes, tomorrow's estimate.
- Once a week it also shows retention stats (change 13).
- Add one-line framing at the memory pass and the first check: 'Spaced recalls feel harder — that is why they stick.'

Sources:

- Karpicke, J. D., & Bauernschmidt, A. (2011). JEP:LMC, 37(5), 1250–1257.
- Kornell, N. (2009). Applied Cognitive Psychology, 23(9), 1297–1317.
- Rawson, K. A., & Dunlosky, J. (2011). JEP: General, 140(3), 283–302.
- Nakata, T. (2017). Studies in Second Language Acquisition, 39(4), 653–679.
- Mazza, S., et al. (2016). Psychological Science, 27(10), 1321–1330.
- Wang, A. Y., & Thomas, M. H. (1995). Journal of Educational Psychology, 87(3), 468–475.
- Naka, M. (1998). Memory & Cognition, 26(4), 804–809.
- Huelser, B. J., & Metcalfe, J. (2012). Memory & Cognition, 40(4), 514–527.

### 5. Kana in 14 days: rule lessons for dakuten and yōon, romaji helper only on unlearned characters, kanji from day 15

**Priority:** P0 · **Size:** M · **Learner time:** Days 1–14 run about 19–20 min (today: about 8). No change after that.

**Impact:** - Kanji start on day 15 instead of day 69.
- 116 fewer kana cards over the course.
- Real words are read from day 1, and short dialogues from week 2.
- Romaji dependence ends by week 3.

**Evidence:** - Courses finish each script in about 1–2 weeks and start kanji right after; romaji goes from Genki Lesson 3. [practitioner: Genki; MIT 21G.501; Auckland]
- Mnemonics help English-L1 beginners with immediate kana recall. Retention needs spaced retrieval. [moderate: Matsunaga 2003; Manalo et al. 2004]
- Kana is the reasonable exception that justifies a bit more same-day practice. [moderate, inferred]
- Kana-only words are about 64% of word tokens, so reading can start in week 1. [strong: Matsushita 2019]
- Requiring a production test before skipping material. [moderate: Kornell & Bjork 2008]
- Audit: kana takes 69 days at 5/day, and kanji start on day 69.

FIXED PLAN (outside the time governor)

Hiragana:
- D1: あ row and か row (10)
- D2: さ row and た row (10)
- D3: な row and は row (10)
- D4: ま row and や row (8)
- D5: ら row, わ, を, ん (8)
- D6: rule lesson: ゛ and ゜. One kanaRule item; practise by reading 8 words.
- D7: rule lesson: yōon (きゃ), small っ, long vowels.

Katakana:
- D8–D12: the same pattern.
- D13: rule lesson: katakana dakuten, yōon, ー.
- D14: rule lesson: extended loanword sounds (ティ, ファ, ウィ), then a 'Kana check' can-do: read 10 real katakana menu words aloud at speed.

Each kana:
1. Sound and a one-line picture mnemonic.
2. Trace once.
3. Guided copy.
4. After each batch of 5, write each from the sound, from memory, in mixed order.
5. Read 2–3 real words that use only learned kana.

Romaji:
- Remove Settings.romaji.
- Show romaji helper ruby only above kana the learner has not been taught yet, character by character. It fades on its own.
- From day 15, romaji is never displayed outside the Kana chart reference. Romaji typing stays only as the input method.

Other streams:
- Core words start on day 3, 3 per day, audio first, as kana.
- Grammar starts on day 8, after the yōon rule, since the first points' examples use きょう and かいしゃいん.
- Kanji start on day 15. The time governor runs from day 15.

'I already know kana' placement:
- 20 random kana from audio; write each one.
- 18 or more correct: create that script's cards in Review state with stability 10 days.
- Otherwise run the sprint.

Sources:

- Japan Times, GENKI 3rd ed. Introduction: https://genki3.japantimes.co.jp/en/intro/
- MIT OCW 21G.501 Japanese I, Fall 2012 calendar; Fall 2019 syllabus.
- Matsunaga, S. (2003). 世界の日本語教育, 13, 19–40.
- Manalo, E., Mizutani, S., & Trafford, J. (2004). JALT Journal, 26(1).
- Matsushita, T. (2019). NINJAL symposium paper, Table 1.
- Kornell, N., & Bjork, R. A. (2008). Memory, 16(2), 125–136.

### 6. Core vocabulary track: kana-only, function and loan words; anchor words re-ranked away from newspaper terms; a kanji's later words staged over days

**Priority:** P0 · **Size:** L · **Learner time:** About 1.5–2 min/day, inside the budget.

**Impact:** - Simulated at 25 min: about 840 core words plus about 730 kanji words by day 365, about 1,550–1,580 words in total. Today: about 2,000 newspaper-ranked words at about 40 min.
- The couple can write chat and role-play lines from week 1.
- Easy stories reach 98% coverage much sooner.

**Evidence:** - Japanese needs far more words than English for the same coverage; vocabulary size, not kanji count, is the bottleneck. [moderate: Matsushita 2012/2019]
- Kana-only words are 59.7% of word tokens. [strong: Matsushita 2019]
- Deliberate word learning yields far more per word than incidental pickup. [strong: Webb et al. 2020; Webb, Uchihara & Yanagisawa 2023]
- Introduce a kanji's words over the following days to reduce interference. [practitioner, plus moderate: Nakata & Suzuki 2019 SSLA]
- Teach conversation-control phrases and numbers to high fluency early. [moderate: Nation 1995; Long 1996]
- Teach readings selectively, through words. [practitioner: Genki; Jōyō table]
- Audit: words.json has no kana-only words; early words include 国会, 年金 and 土木; the survival list runs out on day 68; 47 words are duplicated.

CORE WORD LIST (content/core-words.json, about 1,500 entries)
- Replaces survival-words.json; all 117 survival words are merged in.
- Fields: id, kana, written? (the kanji form plus its JMdict id), en, register ('polite' | 'plain' | 'both'), topic, use (boolean, true for about the first 400), order.
- Generate from JMdict and a spoken-plus-written frequency list. Keep kana-only and usually-kana words (ある, この, とても, もう, まだ, でも, みんな, できる, する), loanwords, numbers, times, prices, counters, and couple and home topics.
- Hand-review the first 400.
- Order: conversation-control phrases and greetings first (もう一度お願いします, ゆっくり話してください, 〇〇って何？, どういう意味？), then frequency weighted by topic.
- Pace: 3/day on days 3–14, then set by the stream balancer in change 1 (about 2/day).

ANCHOR WORD RE-RANK (scripts/lib/curriculum.ts pickUnitWords)
1. Carry JMdict priority tags into WordEntry.pri at build time.
2. Score each candidate:
   - ichi1 or spec1/2: +3
   - in the core list or a role-play target: +3
   - uses the kanji's most common reading: +2
   - 3 characters or fewer: +1
   - priority only from news1/nfXX: −2
   - existing freqRank as the tie-break
3. The anchor is the top score. Keep at most 3 words per kanji, and drop words whose only priority is news.

STAGING
- The anchor word arrives with the kanji.
- The 2nd word is released 3 days later and the 3rd 8 days later, as 'known kanji, new word' items. At most 4 staged words a day.
- A staged word that is already known as a core word becomes a spelling upgrade instead (change 2 merge).
- Show related words that share the kanji on its detail screen.

Sources:

- Matsushita, T. (2019). NINJAL symposium paper, pp. 48–55.
- Webb, S., Uchihara, T., & Yanagisawa, A. (2023). Language Teaching, 56(2), 161–180.
- Webb, S., Yanagisawa, A., & Uchihara, T. (2020). Modern Language Journal, 104(4), 715–738.
- Nakata, T., & Suzuki, Y. (2019). SSLA, 41(2), 287–311.
- Nation, P. (1995). Best practice in vocabulary teaching and learning. EA Conference paper.
- 文化庁 (2010). 常用漢字表.

### 7. Grammar track: about 115 points at 2–3 a week from day 8, two cards each with rotating examples, no kanji-count gate

**Priority:** P0 · **Size:** L · **Learner time:** About 3.5 min on a grammar day, plus about 1 min/day of grammar reviews, inside the budget.

**Impact:** - Simulated at 25 min: about 35 points by day 90, about 60 by day 180, about 85–100 by day 365, and all about 115 by about day 600. At 30 min, all 115 by about day 350.
- Grammar takes about 10% of review time instead of 0.3%.
- Stories, chat and unscripted role-plays become possible by months 3–6.

**Evidence:** - Explicit, focused instruction gives large, durable gains, and explicit beats implicit. [strong: Norris & Ortega 2000; Spada & Tomita 2010]
- Comprehension-based practice serves receptive knowledge; production-based practice gives more durable productive knowledge. [moderate: Shintani, Li & Ellis 2013]
- Fill-in-the-blank was the weakest intentional activity, which is why build replaces the gap-fill drill. [strong: Webb et al. 2020]
- Introduce related grammar on different days and mix them across sessions. [moderate: Nakata & Suzuki 2019 MLJ; Pan et al. 2019]
- Trying to produce before the explanation. [moderate: Bertsch et al. 2007; Potts & Shanks 2014]
- Genki I–II covers well over 100 points. [practitioner]
- Audit: 37 points (about 25–30% of N5); none from day 85 to 161; runs out on day 190; 0.3% of review time.

CONTENT (content/grammar.json)
- Grow from 37 to about 115 points: about 80 at N5 level and about 35 core N4.
- Must include: が, ね/よ, こ/そ/あ/ど, counters, adverbs, noun-modifying clauses, あげる/くれる/もらう, たら/ば/と/なら, てはいけない, ないでください, ほうがいい, たり, ながら, てから, そう/よう, and recognition-only passive, causative and set keigo phrases.
- Teach plain-form recognition (だ, plain past, ない) by about day 60, tagged 'plain', for the spouses' chat.
- New GrammarPoint fields:
  - register
  - prerequisites[]
  - contrastWith[]
  - examples: at least 8. Each uses only core or earlier vocabulary, or shows furigana.
  - buildItems: at least 4, each {en, jp, tiles[], alternatives[]}

PACING
- From day 8.
- At most one point every second study day. Floor of 2 per ISO week: a grammar stream below the floor goes ahead of kanji that day.
- Gate only on prerequisites. Remove phase gating, including the wait for 300 kanji.
- Related points (は/が, に/で, the て-form groups) at least 5 study days apart.

LESSON (GrammarLesson.tsx)
1. 10 s 'try to say it': English shown; the learner attempts it; reveal. Ungraded.
2. One-screen explanation.
3. 3 examples with audio.
4. 2 ungraded comprehension taps.
5. 1 ungraded build.

CARDS
- comprehend: hear or read an example not seen in the last 2 reviews, recall its meaning, reveal, then Missed / Got it.
- build: English to Japanese. Tile order until 60 points are known, then typed. Compare after normalisation with alternatives allowed.
- Retire the gap-fill drill as a review card. It stays as lesson practice.

Sources:

- Norris, J. M., & Ortega, L. (2000). Language Learning, 50(3), 417–528.
- Spada, N., & Tomita, Y. (2010). Language Learning, 60(2), 263–308.
- Shintani, N., Li, S., & Ellis, R. (2013). Language Learning, 63(2), 296–329.
- Nakata, T., & Suzuki, Y. (2019). Modern Language Journal, 103(3), 629–647.
- Pan, S. C., et al. (2019). Journal of Educational Psychology, 111(7), 1172–1188.
- Webb, S., Yanagisawa, A., & Uchihara, T. (2020). Modern Language Journal, 104(4), 715–738.

### 8. Habits: minimum day, 2 rest tokens a week, streak repair, welcome-back sessions, if-then plans, calendar reminders, couple quest

**Priority:** P1 · **Size:** M · **Learner time:** About 4 minutes once at onboarding, a tap to use a token, and about 1 minute at weeks 4 and 8.

**Impact:** - Fewer gaps of 2 or more days. Those gaps are what break habits and pile up review debt.
- Faster rebounds after a missed day.
- Couple accountability without surveillance.

**Evidence:** - If-then plans raise goal attainment: d ≈ 0.65 across 94 tests. [strong: Gollwitzer & Sheeran 2006]
- Rewarding the comeback after a miss was the best of 54 nudges. [strong: Milkman et al. 2021]
- Emergency reserves: goal met on 4.0 days a week vs 2.83, and next-day rebound 55% vs 37%. [moderate: Sharif & Shu]
- Broken streaks lower later engagement; repair softens the damage; streaks tied to a demanding goal backfire. [moderate: Silverman & Barasch 2023; Duolingo practitioner data]
- Habits take months to form, and a single miss does not matter much. [moderate: Lally et al. 2010]
- Time since the last session predicts the next one. [moderate: Buyalskaya et al. 2023]
- Fresh-start effect. [moderate: Dai, Milkman & Riis 2014]
- Notification messages wear out with repetition. [moderate: Yancey & Settles 2020]
- Autonomy support from a partner, not surveillance. [moderate: Koestner et al. 2012]
- Anxiety, and keeping errors private. [strong: Teimouri et al. 2019]

MINIMUM DAY
A day counts toward the streak if any one of these happens:
- all due reviews are cleared, or 5 minutes of the most overdue reviews are done
- a 3-minute micro-session is done
- a together session is done
Finishing the full plan earns a separate 'goal met' mark.

REST TOKENS
- 2 per ISO week, with no rollover. They replace the automatic rest day in progress.ts restDaysOf.
- Applied with a deliberate tap. The morning after a missed day, Today asks 'Use a rest token for yesterday?' A token can also be set in advance.
- Repair: a missed day with no token left can be repaired by a make-up session (the full plan, or at least 10 minutes) within 48 hours.
- Travel/sick mode: pauses the streak and new items. Reviews are optional. Catch-up mode (change 1) runs on return.

DISPLAY
- Lead with 'days studied this month' and the longest streak.
- Show the current streak only while it is alive.
- Never show copy like 'you missed N days'.

COMEBACK
- After 1 or more missed days, the first open offers a 3-minute welcome-back session: the most overdue reviews only, with no new items and no handwriting, and warm copy.
- After 3 or more missed days, also offer a fresh start at the next Monday or the 1st of the month, with catch-up mode.

ONBOARDING
Each partner enters:
- an if-then cue ('After I ___ at ___, I open Issho') and a cue time
- a coping plan
The couple enters:
- together days and times
- a shared goal with a target date
At weeks 4 and 8, prompt both to review their plans.

REMINDERS
- v1: generate a .ics file with recurring events at each partner's cue time and the together slots. It works offline and needs no server.
- v2 (later): web push from the home server. One message a day at the cue time, rotating content (e.g. the kanji of the day), no guilt copy. After 5 ignored days, switch to one fresh-start message a week.

COUPLE QUEST
- Each week: both partners have at least 5 minimum days, plus 3 together sessions.
- 1 couple reserve token.
- server sharedStreak uses this rule instead of 'both every day'.

PRIVACY
- By default the partner sees days studied, minutes, together sessions and stamps.
- Accuracy and error counts stay private.

Sources:

- Gollwitzer, P. M., & Sheeran, P. (2006). Advances in Experimental Social Psychology, 38, 69–119.
- Milkman, K. L., et al. (2021). Nature, 600, 478–483.
- Sharif, M. A., & Shu, S. B. Emergency reserves field experiment (Wharton working paper); OBHDP version.
- Silverman, J., & Barasch, A. (2023). Journal of Consumer Research, 49(6), 1095–1117.
- Lally, P., et al. (2010). European Journal of Social Psychology, 40(6), 998–1009.
- Buyalskaya, A., et al. (2023). PNAS, 120(17), e2216115120.
- Dai, H., Milkman, K. L., & Riis, J. (2014). Management Science, 60(10), 2563–2582.
- Yancey, K. P., & Settles, B. (2020). KDD '20.
- Koestner, R., et al. (2012). PSPB, 38(12).
- Teimouri, Y., Goetze, J., & Plonsky, L. (2019). SSLA, 41(2), 363–387.

### 9. Feedback that teaches, and handwriting judged as a whole character (stroke order is coaching, not a fail)

**Priority:** P1 · **Size:** M · **Learner time:** About +5 s per miss and about −1.5 s per fast correct answer. Roughly neutral overall.

**Impact:** - Misses become learning events.
- Write-card lapses measure memory rather than stroke convention, so there are fewer wasted reviews.
- Fast correct cards take about 1–2 s less.

**Evidence:** - Showing the correct answer after an error raised 1-week retention by 494%; feedback after correct answers adds little. [strong: Pashler et al. 2005]
- Errors made with high confidence are the most likely to be corrected after feedback. [moderate: Butterfield & Metcalfe 2001]
- Evidence that stroke order helps retention is weak and mixed, and animations during study can interfere. [weak: Naka 1998; Hou & Jiang 2022]
- Writing helps because the learner produces the character and sees their own strokes. [moderate: Naka 1998]
- Feedback timing matters little for vocabulary, so marking after the whole character is fine. [strong: Nakata 2015; Metcalfe et al. 2009]
- Show the mnemonic only after a failed recall, never as the test cue. [moderate: Rose 2013]

AFTER ANY MISS (or a Hard)
Show the full answer:
- the kanji with its stroke animation, played once
- the reading with audio and a pitch line (once accent data exists)
- the anchor word inside a known sentence
- the parts with their names
- the mnemonic

AFTER A CORRECT ANSWER
- Faster than the user's median for that card type: play audio, show a one-line answer, and continue automatically after 1.2 s or on tap.
- Slower: show the answer line and audio.

SURPRISE MISS
- Trigger: the last grade was Good, the last durationMs was under 0.6 × the user's median for the type, and now the answer is Again.
- Flag 'surprise miss'. Add the parts breakdown, 2 related words and a 'write your own hook' field.

LEAK GUARD
FeedbackPanel never shows a field that a sibling card due today asks for. For example, it does not show a word's reading while that word's read card is still due.

WRITING IN RECALL MODE (memory pass and write reviews)
1. While the learner writes: no per-stroke marks and no model or animation on screen.
2. When the learner taps Done, run a new matchCharacterUnordered(strokes, userStrokes) in writing/matcher.ts:
   - Build a cost matrix from matchStrokeOf scores against every expected stroke, with the frame estimated from the strokes accepted so far.
   - Solve it with the Hungarian algorithm (n ≤ 30).
   - Return missing, extra, unmatched and orderSlips (matched strokes drawn at a different index).
3. Grade with gradeForRecallWriting:
   - Again: missing + extra is 1 or more; or 2 or more strokes unmatched; or exactly 1 unmatched in a kanji of 6 strokes or fewer.
   - Hard: 1 unmatched in a kanji of 7 or more strokes, or a hint was used.
   - Good: otherwise.
4. Stroke-order slips do not affect the grade. They produce a coaching note ('stroke 3 usually comes before 2') with a replay button.
5. Then show the model over the learner's ink.
6. Override: an 'I wrote it right' tap grades Hard and logs the override. If a user's overrides pass 10% of their write reviews, show a calibration tip.
7. The existing per-stroke guided mode stays for trace and copy passes.

Sources:

- Pashler, H., Cepeda, N. J., Wixted, J. T., & Rohrer, D. (2005). JEP:LMC, 31(1), 3–8.
- Butterfield, B., & Metcalfe, J. (2001). JEP:LMC, 27(6), 1491–1494.
- Hou, F., & Jiang, X. (2022). Frontiers in Psychology, 13, 783613.
- Naka, M. (1998). Memory & Cognition, 26(4), 804–809.
- Nakata, T. (2015). Language Teaching Research, 19(4), 416–434.
- Rose, H. (2013). Modern Language Journal, 97(4), 981–992.

### 10. Daily Read & Listen block: easy stories read while listening, per-partner furigana, and fixed i+1 study sentences

**Priority:** P1 · **Size:** L · **Learner time:** Uses the strand reserve from change 1: 2 min/day early, 4 by day 15, 6 by day 61, 8 later.

**Impact:** - Adds the missing input strand.
- Every SRS word gets spaced encounters in context.
- Listening practice on known material.
- Reading speed becomes a metric that keeps rising in year 2.
- Removes untaught grammar from sentences: today 61 of 81 early sentences use grammar the learner hasn't met.

**Evidence:** - The input and fluency strands are nearly missing from the current routine. [practitioner: Nation 2007]
- About 98% known words is the target for unassisted reading; 95% is a workable minimum. [moderate: Hu & Nation 2000; Laufer & Ravenhorst-Kalovski 2010; Schmitt et al. 2011]
- Reading while listening is the best bridge for beginners; learners preferred it 72%, and the ladder is read → read while listening → listen only. [moderate: Brown, Waring & Donkaewbua 2008; Webb et al. 2023]
- Extensive reading has larger effects for adults and inside the curriculum: d = 0.91. [strong: Jeon & Day 2016; Nakanishi 2015]
- Japanese tadoku is feasible for beginners. [weak: Hitosugi & Day 2004]
- Words met fewer than about 8 times are rarely retained; spacing roughly triples the delayed effect. [strong: Waring & Takaki 2003; Webb et al. 2023]
- Glosses: L1 beats L2, and multiple choice works best (45% vs 27% learned). [strong: Yanagisawa, Webb & Uchihara 2020]
- Read aloud before hearing the audio, so the sentence is a retrieval attempt. [strong: Rowland 2014]
- Shadowing with feedback. [moderate: Hamada 2016; Lee, Jang & Plonsky 2015]
- Furigana-first reading. [practitioner: NPO Tadoku]

PART A: STUDY SENTENCES (1–3 per day, from day 2)

Selection (pickIPlusOne):
- Exactly one target: a word introduced 1–21 days ago. Prefer words below their encounter target.
- Every other token must be a known word.
- Every grammar tag on the sentence must already be introduced.
- Kanji must be known or shown with furigana.

Flow:
1. Read the sentence aloud. The mic is optional.
2. Tap Listen to hear the audio.
3. Guess-first gloss for the target: pick from 3 English options, then the answer is revealed.
4. Shadow: record, then play the recording back to back with the model.

The learner can save the sentence as a cloze card from phase 1 (SAVE_FROM_PHASE goes from 3 to 1). Sentences are not graded. Each one logs an encounter for its words.

PART B: EASY READ (from about 200 known words, roughly day 35–45)

Story content:
- Micro-stories in content/stories/*.json, written to the Tadoku specs: Start ≤200 vocabulary; L0 200–400 characters; L1 400–1,500 characters.
- Each story is tokenised to item ids, split into phrases (bunsetsu), and given 1 gist question.

Coverage, computed per partner:
- A token counts as known if its item has been introduced and its read or listen card has had at least one successful review.
- Daily input block: only stories at 98% coverage or higher (Easy).
- Stories at 95–98% (Stretch) are offered in the Library with tap glosses in English.

Mode and schedule:
- Read-while-listening: speak one phrase per TTS utterance and highlight it. Rate is 0.85× for the first 3 months.
- Each story follows a ladder:
  1. Day 0: read while listening, then the gist question.
  2. About day +3: listen only, text hidden, then the gist question.
  3. About day +10: timed re-read, showing characters per minute (this is the fluency slot).

Furigana:
- Shown on a kanji word only if that partner's read card for the word is not mature (stability under 21 days). The two partners therefore see different furigana on the same story.
- Deliberate cards and the first check never show furigana.

Shared weekly story: one story for both partners, chosen by the slower partner's coverage.

CONTENT PLAN
- Author 60 stories for Start, L0 and L1.
- Later, the server may generate stories with the AI, constrained to the couple's known lists. A generated story is shown only if the checker (tokeniser + dictionary lookup) finds at least 98% known words for both partners and every grammar point already introduced. Otherwise it is discarded.

ENCOUNTERS
- New Dexie table encounters(itemId, day, source).
- Target: at least 8 contextual encounters per word over 6 weeks.
- Move the sentencesShown record from localStorage into IndexedDB.

Sources:

- Nation, P. (2007). The four strands. Innovation in Language Learning and Teaching, 1(1), 2–13.
- Laufer, B., & Ravenhorst-Kalovski, G. C. (2010). Reading in a Foreign Language, 22(1), 15–30.
- Schmitt, N., Jiang, X., & Grabe, W. (2011). Modern Language Journal, 95(1), 26–43.
- Brown, R., Waring, R., & Donkaewbua, S. (2008). Reading in a Foreign Language, 20(2), 136–163.
- Jeon, E.-Y., & Day, R. R. (2016). Reading in a Foreign Language, 28(2), 246–265.
- Waring, R., & Takaki, M. (2003). Reading in a Foreign Language, 15(2), 130–163.
- Webb, S., Uchihara, T., & Yanagisawa, A. (2023). Language Teaching, 56(2), 161–180.
- Yanagisawa, A., Webb, S., & Uchihara, T. (2020). SSLA, 42(2), 411–438.
- Hitosugi, C. I., & Day, R. R. (2004). Reading in a Foreign Language, 16(1), 20–39.
- NPO Tadoku Supporters, Levels: https://tadoku.org/japanese/en/levels-en/

### 11. Together routine in the plan: 3 × 15 min sessions with fixed jobs, a partner quiz that feeds FSRS, fading role-play scaffolds, AI as the neutral corrector

**Priority:** P1 · **Size:** L · **Learner time:** 45 min/week, already in the stated budget. On together days the quiz grades replace some solo reviews.

**Impact:** - 45 minutes a week of output, fluency and spaced retrieval, linked to recent learning.
- Retrieval done together is counted by the scheduler.
- Accuracy feedback without straining the relationship.
- Ends the loop where the same 3 scripts repeat after day 161.

**Evidence:** - Interaction helps L2 development, in text chat about as much as face to face. [strong: Loewen & Sato 2018; Ziegler 2016]
- Task-supported teaching works best when items are taught first, then used. [moderate: Bryfonski & McKay 2019 re-analysed by Xuan et al. 2025]
- Peers trained to give corrective feedback gain accuracy as well as fluency. [moderate: Sato & Lyster 2012]
- Explicit corrections from a peer can backfire. [moderate: Adams, Nuevo & Egi 2011]
- Goal-oriented AI dialogue gives g = 0.61 on speaking. [moderate: Bibauw et al. 2022; Hou & Min 2025]
- Build together sessions from items 2–10 days old. [strong: Cepeda et al. 2008]
- Teaching helps mainly through retrieval. [weak: Koh et al. 2018]
- 4/3/2 retelling. [moderate: de Jong & Perfetti 2011]
- Planning and repeating a task raise fluency. [moderate: Bygate 2001]
- Explicit teaching of pragmatics and register. [moderate: Shakki 2022]
- Jorden core conversations and skits. [practitioner]
- Joint goals and the Köhler effect. [moderate: Feltz et al. 2012]

WEEKLY PLAN
- New src/srs/together.ts builds the plan every Monday from both partners' synced stats.
- Today shows the session on its scheduled day.
- A completed session logs minutes and counts as a minimum day for both partners.

SESSION A: QUIZ & CORE CONVERSATION
1. Quiz pool, per answerer:
   - items introduced 2–10 days ago, plus lapses (Again grades) from the last 7 days
   - at most 10 items, mixed types: write a kanji (on phone, or on paper with self-check), read a word aloud, produce from English, build a sentence
2. The asker's screen shows the answer. The answerer must say or write before the reveal. The asker taps ✓, close, or ✗.
3. If the card is due within ±2 days, call gradeCard with mode 'partner': ✓ = Good, close = Hard, ✗ = Again. Otherwise log it as an exposure only.
4. Teach-me turn: one recent kanji. The answerer explains its parts and mnemonic with notes hidden, then the app shows the reference.
5. Core conversation: a 4–8 line roleplays.json script at the couple's level. Per-script stages:
   - S1: listen and shadow together (two voices)
   - S2: perform with the Japanese only (English behind a tap)
   - S3: swap roles
   - S4: keyword cue cards only
   The stage is saved and advances when both partners mark the run 'smooth'.

SESSION B: TASK
1. Task card shows:
   - the can-do
   - the goal, with an outcome-check question
   - info-gap halves for partners A and B
   - 5–8 target items from both partners' items 2–21 days old
   - a register note
2. 60–90 s silent-planning timer.
3. Run the task, then swap roles.
4. The AI may play a third role (clerk, waiter) through TTS plus speech recognition, or typed.
5. Private AI recap: 1–2 points per person. Corrected lines become cards only through the change 12 guard.
6. The same task returns 2–7 days later with one twist.
7. Offline fallback: a scripted version.

SESSION C: STORY & GAME + CHECK-IN
1. Talk about the shared weekly story.
2. 4/3/2 retell with timers of 90, 60 and 45 s, same content each time.
3. Partner dictation: 5 words from each partner's recent items. One reads aloud, the other handwrites. On the phone path it is graded like the quiz.
4. Weekly check-in screen: auto-filled counts, one can-do ticked, next week's slots and rest tokens. Saved as history.

MONTHLY (first weekend)
- A 20-item mixed quiz from all history, lowest retrievability first.
- Goal-setting.

PARTNER RULES (onboarding card)
- One signal (もう一度？) and pointing at the word.
- Never explain grammar to each other.
- Turns alternate.

ROLE-PLAY LEVELS
levelForPhase is replaced by the couple's known-item counts. Scripts with more than 2 unknown target items are skipped.

Sources:

- Loewen, S., & Sato, M. (2018). Language Teaching, 51(3), 285–329.
- Ziegler, N. (2016). SSLA, 38(3), 553–586.
- Sato, M., & Lyster, R. (2012). SSLA, 34(4), 591–626.
- Adams, R., Nuevo, A., & Egi, T. (2011). Modern Language Journal, 95(Suppl.), 42–63.
- Bibauw, S., et al. (2022). Language Learning & Technology, 26(1), 1–24.
- Hou & Min (2025). ReCALL. https://doi.org/10.1017/S0958344025100268
- Cepeda, N. J., et al. (2008). Psychological Science, 19(11), 1095–1102.
- de Jong, N., & Perfetti, C. A. (2011). Language Learning, 61(2), 533–568.
- Koh, A. W. L., Lee, S. C., & Lim, S. W. H. (2018). Applied Cognitive Psychology, 32(3), 401–410.
- Feltz, D. L., Irwin, B., & Kerr, N. (2012). J Diabetes Sci Technol, 6(4), 820–827.

### 12. One sentence a day to your partner, with AI tips that point to the error first

**Priority:** P1 · **Size:** M · **Learner time:** About 1–2 min/day, inside the strand reserve.

**Impact:** - Daily production with feedback that shows the gap.
- A daily Japanese exchange between the spouses, which supports the habit.
- The learner's own errors come back as spaced items.

**Evidence:** - Prompts beat recasts, especially on free production. [strong: Lyster & Saito 2010; Lyster & Ranta 1997]
- Explicit feedback gives bigger short-term gains; implicit feedback lasts longer. [strong: Li 2010]
- Written corrective feedback works: direct correction for grammar, indirect flagging for word choice, and feedback during writing beats feedback later. [moderate: Van Beuningen et al. 2012; Shintani & Aubrey 2016]
- Producing language makes learners notice gaps. [moderate: Swain & Lapkin 1995; Shintani et al. 2013]
- LLM feedback for East Asian languages is unverified. [weak: 2025 ChatGPT L2 Chinese study]
- Never make cards from uncorrected peer text. [weak: peer-error risk]
- Text chat carries over to speaking and lowers anxiety. [moderate: Satar & Özdener 2008; Payne & Whitney 2002]

OUTPUT STEP (1–2 min, after the first check)
- Prompt: 'Tell {partner} something using {target}'. The target is one recent word or grammar point.
- The learner types with the IME.

AI CHECK, TWO STEPS (server/src/ai.ts)
1. Prompt mode returns at most 2 issues. Each issue has:
   - span
   - type: particle | conjugation | word-choice | kanji | register | other
   - uncertain: boolean
2. The UI highlights the span and shows the type label, without the fix.
3. The learner edits once and resubmits.
4. Reveal mode returns a diff against the corrected sentence plus a one-line rule.

How each error type is handled:
- Grammar types: reveal after one failed edit.
- Word choice: flagged first; reveal only on request.
- Uncertain issues are shown as 'maybe'.

Constraints on the AI:
- The system prompt receives the known grammar ids, the known words and the target register. It must say when it is unsure.
- Prefer explaining over rewriting.

Also in the step:
- A 'This tip seems wrong' button logs a report.
- A 'Just show me' toggle is available for tired days.
- Tips never block sending. When offline, the check is queued.

The sentence goes to the partner chat as 'today's sentence'. The partner's reply counts as their output.

CARD GUARD
A corrected sentence becomes a cloze card only if:
- every token resolves in words.json or the core list, and
- its grammar maps to known point ids (rule-based tag check).
Uncorrected learner text never becomes a card.

MAX_TIPS goes from 3 to 2 everywhere in chat.

Sources:

- Lyster, R., & Saito, K. (2010). SSLA, 32(2), 265–302.
- Lyster, R., & Ranta, L. (1997). SSLA, 19(1), 37–66.
- Li, S. (2010). Language Learning, 60(2), 309–365.
- Van Beuningen, C. G., De Jong, N. H., & Kuiken, F. (2012). Language Learning, 62(1), 1–41.
- Shintani, N., & Aubrey, S. (2016). Modern Language Journal, 100(1), 296–319.
- Satar, H. M., & Özdener, N. (2008). Modern Language Journal, 92(4), 595–613.

### 13. Progress that rewards lasting learning: learned after 3 spaced successes, real retention, coverage, short chapters, honest hours

**Priority:** P1 · **Size:** M · **Learner time:** None.

**Impact:** - Durable knowledge is rewarded instead of cramming.
- A visible win every 2–3 weeks for 2 years.
- Year-2 progress is shown as coverage and reading speed rather than slowing item counts.

**Evidence:** - Successive relearning: count an item as learned only after spaced successes. [strong: Rawson & Dunlosky 2011]
- Learners misjudge what works, so show them their real retention. [strong: Kornell 2009]
- Monitoring progress raises goal attainment (d = 0.40), more so when the record is reported or kept. [strong: Harkin et al. 2016]
- Goal-gradient, small-area and stuck-in-the-middle effects. [moderate: Kivetz et al. 2006; Koo & Fishbach 2012; Bonezzi et al. 2011]
- Coverage figures. [strong: Matsushita 2019]
- Self-efficacy correlates with achievement (r = .46). [moderate: Goetze & Driver 2022]
- Study-hour benchmarks. [weak/practitioner]

LEARNED
- An item counts as 'learned' after 3 or more successful reviews on 3 different days after it was introduced. The first check does not count.
- 'Can write' kanji: the write card meets the same rule.
- 'Can read' kanji: through its word cards.
- Replace knownKanji in summary with these definitions.

RETENTION (shown weekly)
- Real recall rate at about 1 week (reviews with elapsed time of 5–10 days) and about 1 month (21–45 days).
- Broken down by card family: write, read, listen, produce, grammar.
- Rolling 30 days.

COVERAGE
Map learned kanji to Matsushita's Table 1 and show 'share of words in a typical text you can now decode':

| Kanji | Share |
|---|---|
| 100 | 74% |
| 200 | 79% |
| 300 | 83% |
| 500 | 88% |
| 700 | 92% |
| 1,000 | 95% |

Also show the count of known words.

CHAPTERS
- Auto-segment the curriculum every 15 kanji, together with the words and grammar introduced in that span.
- Text reads like 'Chapter 7 · 9 of 15'.
- In the first half of a chapter show what's done; in the second half show what's left.
- Kana counts as chapter 0, so the learner starts with a real head start.
- Every 12 weeks: a 'season finale' card that points to a can-do showcase in Session C.

HOURS
Cumulative study plus together minutes, compared with:
- old N5: about 250–400 h for non-kanji-background learners
- old N4: about 500–750 h
- FSI: about 2,200 class hours, as the long view only

READING SPEED
Characters per minute on Easy re-reads.

Remove the 'N / 2,136' phase bar.

Sources:

- Rawson, K. A., & Dunlosky, J. (2011). JEP: General, 140(3), 283–302.
- Harkin, B., et al. (2016). Psychological Bulletin, 142(2), 198–229.
- Kivetz, R., Urminsky, O., & Zheng, Y. (2006). JMR, 43(1), 39–58.
- Koo, M., & Fishbach, A. (2012). JCR, 39(3), 493–509.
- Bonezzi, A., Brendl, C. M., & De Angelis, M. (2011). Psychological Science, 22(5), 607–612.
- Matsushita, T. (2019). NINJAL symposium paper, Table 1.
- Goetze, J., & Driver, M. (2022). SSLLT, 12(2).

### 14. Kanji order: frequency plus a boost for the couple's words, rare components taught as parts, look-alikes kept apart

**Priority:** P1 · **Size:** M · **Learner time:** None.

**Impact:** - About 58 more useful kanji in the first 300, so each kanji learned covers more text.
- About 170 fewer wasted cards.
- Fewer interference errors between look-alikes.

**Evidence:** - No validated kanji order exists. The most defensible approach is frequency plus component prerequisites. [practitioner: Paxton; JLPT FAQ]
- Coverage rises steeply with frequency order. [strong: Matsushita 2019]
- Components help most at the first exposure. [moderate: Taft & Chung 1999]
- Similar items introduced together cause interference errors; interleaving helps telling similar categories apart, but only after both are learned. [moderate: Nakata & Suzuki 2019 SSLA; Brunmair & Richter 2019]
- Audit: 58 off-level kanji in the first 300, including 斤, which has 0 words.

ORDERING (buildCurriculum)
- Keep frequency rank as the spine.
- Move up a kanji that appears in core words or role-play targets, by up to 150 ranks.

COMPONENTS
- A component that is a jōyō kanji with frequency rank above 1,000, or with no useful words (乙 弔 丙 吏 斤 丈 巾 旦 …), becomes a named part. It appears in the parts panel with a name and meaning, and has no unit and no cards.
- Other components stay as kanji units, inserted just before their first use (current behaviour).

CONFUSABLES
- New content/confusables.json with about 60 sets, e.g. 未末, 土士, 人入八, 大犬太, 日目, 己已巳, 休体, 待持特.
- Members of a set are introduced at least 5 study days apart.
- Tight meaning sets (numbers 一–十, weekdays) are split across at least 3 days, no more than 3 per day.

LABELS
JLPT levels are shown only as labels.

PHASE 2 OF THIS CHANGE (P2, later)
Once both members of a confusable pair are learned, add one discrimination item, e.g. 'which is まつ = end? 末 / 未'. Do the same for grammar pairs listed in contrastWith.

Sources:

- Paxton, S. R. Tackling the kanji hurdle. Macquarie University thesis.
- Matsushita, T. (2019). NINJAL symposium paper.
- Taft, M., & Chung, K. (1999). Psychologia, 42(4), 243–251.
- Nakata, T., & Suzuki, Y. (2019). SSLA, 41(2), 287–311.
- Brunmair, M., & Richter, T. (2019). Psychological Bulletin, 145(11), 1029–1052.

### 15. Pitch accent: pitch lines on every word, and a short pitch-ear drill once verified audio exists

**Priority:** P2 · **Size:** L · **Learner time:** About 1 min/day on average.

**Impact:** - Pitch becomes visible from day 1, so a wrong pattern isn't locked in by habit.
- Trained perception generalises to new words.

**Evidence:** - English speakers do not acquire Tokyo pitch accent from input alone; they stay near chance even after hundreds of hours. [moderate: Shport 2008; Muradás-Taylor 2022]
- Perceptual training with many voices and immediate feedback generalises to new words; pitch-height notation beats H/L letters. [moderate: Shport 2016; Hirata et al. 2024]
- Pronunciation instruction with feedback works. [strong: Lee, Jang & Plonsky 2015]
- It ranks P2 because comprehension and vocabulary matter more for communication at this stage, and the drill depends on verified audio content.

DATA
- At build time, import an accent dataset (Kanjium accents, CC BY-SA 4.0). Check the licence and attribution first; share-alike applies to the data file.
- Add WordEntry.accent with the mora index and type: heiban, atamadaka, nakadaka or odaka.

DISPLAY
- New PitchLine.tsx draws a height line, not H/L letters.
- Shown on every lesson, on feedback after a miss, and on study sentences.

DRILL (2–3 min, Mon/Wed/Fri, in the fluency slot)
- Hear a known word, tap its pattern on a pitch-line diagram, get instant feedback, replay.
- Weight heiban words, long vowels, ん and っ. Include minimal pairs (箸/橋/端).
- Results go into a simple per-word box, not FSRS.
- Ship the drill only with a small recorded or verified audio pack cached offline. Browser TTS pitch is unreliable.

TOGETHER GAME
One partner says a word, the other taps its pattern, and the dictionary decides.

Sources:

- Shport, I. A. (2008). DIJ Monograph 43, 165–187.
- Muradás-Taylor, B. (2022). Language and Speech, 65(2), 377–403.
- Shport, I. A. (2016). SSLA, 38(4), 739–769.
- Hirata, Y., et al. (2024). Language and Cognition, 16(4), 1718–1755.
- Lee, J., Jang, J., & Plonsky, L. (2015). Applied Linguistics, 36(3), 345–366.

### 16. Solo fluency micro-drills: timed re-reads, speed rounds, numbers/time/price

**Priority:** P2 · **Size:** S · **Learner time:** About 1 min/day on average, inside the strand reserve.

**Impact:** - Faster recognition of known material, which makes together sessions usable.
- A progress metric that keeps rising.

**Evidence:** - Fluency work uses only known material, focuses on meaning and adds pressure to go faster. Nation's four strands is practitioner guidance.
- Repetition under shrinking time gives lasting gains when the topic is repeated. [moderate: de Jong & Perfetti 2011; Arevart & Nation 1991]
- Extensive reading improves reading rate. [strong: Nakanishi 2015]
- Numbers and polite formulas should become very fluent early. [practitioner: Nation 1995]

A 2-minute fluency slot on Tue/Thu/Sat, rotating through:
(a) Timed re-read of an Easy story finished 1–3 weeks ago, with characters per minute shown and the personal best kept.
(b) 60-second speed round on mature cards (stability over 21 days), read aloud, ungraded.
(c) Generated drill on numbers, times, prices and counters, typed or spoken against a timer.

Rules:
- Only known material.
- Never graded into FSRS.
- Reading speed feeds the progress screen (change 13).

Sources:

- Nation, P. (2007). The four strands.
- de Jong, N., & Perfetti, C. A. (2011). Language Learning, 61(2), 533–568.
- Arevart, S., & Nation, P. (1991). RELC Journal, 22(1), 84–94.
- Nakanishi, T. (2015). TESOL Quarterly, 49(1), 6–37.

### 17. Course spine content: units with couple can-dos, core conversations, capstone skits and performance checks

**Priority:** P2 · **Size:** L · **Learner time:** About 5 minutes per unit for checks; about 15 minutes per capstone inside a together session.

**Impact:** - Balanced milestones in speaking and listening, not only in counts.
- About 25 core conversations replace the 3-script loop.

**Evidence:** - Can-do and topic-based course design (Marugoto, the JF Standard) and partner skits performed from memory (MIT, SJSU) are practitioner practice.
- Self-ratings match tested ability only moderately, so each can-do is checked by a task. [moderate: Brown, Dewey & Cox 2014]
- Task input sheets largely decide which words get used. [weak: Newton 1995, via Nation]
- Mastery experiences build self-efficacy. [moderate: Goetze & Driver 2022]
- This is P2 because it is mostly practitioner-backed and content-heavy, while changes 11 and 13 already deliver the spacing and progress benefits.

CONTENT
- New content/units.json with about 25 units:
  - units 1–8: about A1/N5
  - units 9–20: about A2/N4
  - units 21+: N3 path
- Each unit has:
  - topic
  - 3–6 couple can-dos (from JF Standard examples, e.g. 'comment on items while shopping together', 'plan a weekend date')
  - grammar ids
  - one 4–8 line core conversation (this becomes the Session A script)
  - one task card (Session B)
  - 2–4 stories
  - a capstone skit spec: at least 8 lines per person, using at least 6 of the unit's structures
- Units map onto the automatic 15-kanji chapters from change 13 by curriculum position.

CAN-DO CHECKS
- A can-do is awarded only after a 1–2 minute performance check: read a real-style menu or sign and answer 2 questions, or answer 3 AI questions by voice.
- Self-rating alone never awards a can-do.

OTHER
- AI oral interview about every 6 weeks (5 min, recorded to the portfolio).
- Portfolio in IndexedDB blobs: handwriting samples and recordings.

Sources:

- The Japan Foundation, Concept of Marugoto: https://marugoto.jpf.go.jp/en/teacher/feature/
- The Japan Foundation, JF Standard pamphlet (2024).
- SJSU JPN101C syllabus (partner skit spec).
- Brown, N. A., Dewey, D. P., & Cox, T. L. (2014). Language Testing.
- Goetze, J., & Driver, M. (2022). SSLLT, 12(2).

### 18. FSRS per partner: fit parameters after about 1,000 reviews, separate presets for handwriting and recognition, optional 0.85 for recognition cards

**Priority:** P2 · **Size:** M · **Learner time:** None.

**Impact:** - Intervals fitted to each person.
- About 10–15% more items at the same minutes for partners who choose 0.85 on recognition cards.

**Evidence:** - FSRS predicts each learner's forgetting better than other models. Fitting separate parameters per partner and per preset is recommended practice, not tested by trial. [practitioner: srs-benchmark; Anki manual]
- 0.85–0.92 is the efficient zone; failing a handwriting card costs more, which argues for keeping it at 0.90. [moderate: Eglington & Pavlik 2020]
- Let intervals grow to months. [strong: Bahrick et al. 1993; Kim & Webb 2022]
- Pen input may keep the encoding benefit of handwriting. [weak: Ihara et al. 2021]
- An earlier simulation found +10–15% kanji at 0.85 for receptive cards.

RETENTION SETTINGS
- Desired retention defaults to 0.90.
- Settings allow 0.85–0.93 and show the projected minutes/day at each value, from the governor's forecast.
- 0.85 can be applied only to receptive cards (read, listen, comprehend). Production cards (write, produce, build) stay at 0.90.
- Never above 0.95.
- maximum_interval stays at the ts-fsrs default of 36,500 days.
- getScheduler takes a preset: 'production' or 'receptive'.

PARAMETER FITTING
- After 1,000 or more reviews per partner, and again monthly, fit FSRS weights on the device in a web worker (FSRS optimizer WASM binding), separately for each preset that has at least 400 reviews.
- Store the weights in Settings.fsrsWeights[preset].
- Show the fitting status in SettingsStudy.
- Log the writing input type (finger or stylus) in reviewLogs, so each partner can compare retention by device.

Sources:

- open-spaced-repetition/srs-benchmark: https://github.com/open-spaced-repetition/srs-benchmark
- Anki Manual, Deck Options.
- Eglington, L. G., & Pavlik, P. I. (2020). npj Science of Learning, 5, 15.
- Bahrick, H. P., et al. (1993). Psychological Science, 4(5), 316–321.
- Ihara, A. S., et al. (2021). Frontiers in Human Neuroscience, 15, 679191.

### 19. Mnemonics done right: short hooks built from known parts, a sound hook for the reading, a 'write your own' field

**Priority:** P2 · **Size:** S · **Learner time:** About 5 s per new kanji, already counted in the lesson time.

**Impact:** - Better first encoding of meaning and reading.
- Fewer kanji that can be explained but not read.

**Evidence:** - Mnemonics help English-L1 beginners but backfire when they are complex or cover meaning only. [moderate: Rose 2013; Manalo et al. 2004]
- Keyword memories fade fast without retrieval. [moderate: Wang & Thomas 1995]
- Explicit strategy instruction helps. [weak: Oxford CORDIS project]

CONTENT (content/mnemonics.json)
- Each kanji gets a one-sentence meaning hook, at most 20 words, built only from part names the learner has already met.
- Plus a sound hook for the anchor word's reading.
- Lint content-mnemonics.test so a hook mentions only parts that come earlier in the curriculum.

WHERE HOOKS APPEAR
- In the lesson and in feedback after a miss.
- Never as the cue during a test.

PERSONAL HOOKS
- A 'write your own' field, stored per user; it takes precedence over the default.

NO SOCIAL FEATURES
No sharing or voting on hooks between partners (rejected; see the rejected list).

Sources:

- Rose, H. (2013). Modern Language Journal, 97(4), 981–992.
- Wang, A. Y., & Thomas, M. H. (1995). Journal of Educational Psychology, 87(3), 468–475.
- Manalo, E., Mizutani, S., & Trafford, J. (2004). JALT Journal, 26(1).
- CORDIS project 333171 results summary.

## Ideas considered and rejected

- Hard on/off bands in the time governor (full new items while reviews are at or below 60% of the slice, half up to 75%, none above), from proposals 1 and 2. In my simulation, new items switched fully off on 78 of days 181–365 and on 207 days in year 2. That is the same stop-start problem today's 150-card cliff has. I used a governor that fills the budget smoothly instead.
- The pace projections in the three proposals (about 535 kanji at 25 min, or 1,040–1,185 at 40 min). Those simulations taught fewer words per kanji, gave less time to reading and listening, or assumed handwriting recall would match FSRS. My single reconciled simulation is lower and is the honest planning number: about 265–310 kanji, about 1,550 words and 85–100 grammar points in year 1 at 25 min.
- Automatically grading a fast correct answer as Easy (proposals 2 and 3). No evidence supports it, and it would stretch intervals on noisy timing data. Grades stay Again, Hard or Good. Fitting FSRS to each partner (change 18) calibrates intervals instead.
- A separate radical SRS card, or one only for high-use parts (proposals 2 and 3). No study supports drilling radicals on their own. Parts work best when shown at the first exposure (Taft & Chung 1999), and they are retrieved again whenever the kanji is written. Dropping the card saves about 75 cards.
- A bare kanji meaning card for kanji not on the write list (proposal 2). It repeats the word cards. The word should be the reading unit (Matsushita 2019).
- A third grammar card in cloze format (proposal 2). Fill-in-the-blank was the weakest deliberate activity in Webb et al. (2020). Two cards, comprehend and build, cover receptive and productive knowledge.
- A 3–5 item quick recall on the summary screen. New items already get about 3 retrievals on day one. Extra same-day retrievals give the least return per minute (Nakata 2017), so that time goes to the next morning's relearning.
- A separate spaced 'shadow set' card type (proposals 1 and 3). The pitch-gain evidence is one uncontrolled conference study (Rongna & Hayashi 2012). Each week's core conversation already brings shadowing back on a spaced schedule at no extra build cost.
- Mora dictation as a daily micro-task. Dictation as a training method has no verified controlled evidence. Dictation stays only as the together dictation game, which trains writing kanji from sound.
- Pitch-ear drills that use browser TTS audio. Device TTS often gets pitch accent wrong, so the drill would teach wrong patterns. It ships only with verified recorded audio (change 15).
- Showing AI-generated stories without a coverage and dictionary check. How accurate LLMs are on Japanese learner content is unverified (weak evidence). A generated story is shown only if both partners know at least 98% of its words and every grammar point in it has been taught.
- An audio-only-first or silent-period track (Refold or ALG style). The evidence favours pairing audio with text for beginners: listening-only gains were about 2%, against 15–16% with text (Brown et al. 2008).
- Cram, study-by-list or 'retire this card' modes, desired retention above 0.95, and capped maximum intervals. Learners misjudge massed practice as better (Kornell 2009; Kornell & Bjork 2008), and workload climbs steeply above 0.95.
- Partners correcting each other explicitly, or one partner coaching as the expert. Explicit corrections from a peer backfired (Adams et al. 2011), and dominant/passive pairs learn less (Storch 2002). Corrections come from the AI, privately, and spouses only use one signal (もう一度？).
- A 'coach week' when one partner gets far ahead (proposal 2). This is a practitioner heuristic extrapolated from a single exergame session (Feltz et al. 2012). Shared content simply uses the slower partner's known items.
- A separate weekly 'couple error clinic'. It adds a feature with only weak evidence. AI-checked corrections already become spaced cloze cards (change 12).
- Sharing and upvoting mnemonics between partners. This is practitioner-only and adds social features without evidence. A personal 'write your own' field is enough.
- A fixed weekly light day instead of rest tokens. In the field experiment, an easy 5-of-7 goal did worse than a 7-day goal with 2 reserve skips (Sharif & Shu).
- Reading, listening and output blocks of 7–10 min from week 3. For absolute beginners there is little readable input early, and Nation expects the balance to shift with proficiency. That time grows with known vocabulary instead: 2, 4, 6, then 8 min. The 25% four-strands split is an expert heuristic, not a tested rule.
- Typing English meanings, with fuzzy matching, as the default answer for meaning cards. It is slow and the matching is error-prone. Meaning recall uses reveal and self-grade, and the effort of typing goes into producing Japanese.
- Web push as the first reminder mechanism. On iOS a PWA needs to be installed on the home screen and a push service is required. Calendar (.ics) reminders ship first; push comes later.
- Dakuten and yōon taught one card per character. They follow rules and are practised through words, which saves about 116 cards.
- Ordering kanji purely by RTK components or purely by frequency. RTK order delays useful kanji, and pure frequency ignores reusable parts. A hybrid with a boost for the couple's own words is the most defensible choice (practitioner).
