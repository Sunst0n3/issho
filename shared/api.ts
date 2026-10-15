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
  /** Item ids (core:, word:, grammar:, kanji:) introduced 2–21 days ago (max 20): task-card targets. The units' authored
   *  task targets come first, then the rest, newest first within each, so a target learned two weeks ago is not cut. */
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
  /** The slots in effect this week: the latest 'slots' event filed under this week or earlier ([] until set). */
  slots: TogetherSlot[];
  /** Slots a check-in filed under next week: they take over next Monday. Absent when none are waiting. */
  nextSlots?: TogetherSlot[];
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
  /** Reveal mode: a natural English translation of `corrected` ('' in prompt mode). Optional: a server without it
   *  (older build) leaves it out, and the cloze card made from the correction then has no English line. */
  en?: string;
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
  /** A natural English translation of `corrected`. Optional like AiCheckResponse.en: an older server leaves it out. */
  en?: string;
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
