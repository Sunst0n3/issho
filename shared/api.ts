// HTTP + WebSocket contract between the app (src/sync) and the home server (server/src).
// Types only: erasable syntax, no runtime code, so Node can import it directly.
//
// Auth: every route except /api/health and /api/register needs the header
//   Authorization: Bearer <deviceToken>
// The WebSocket passes the token as a query parameter: /api/ws?token=<deviceToken>
// Errors are JSON { error: string } with a 4xx/5xx status.

export interface HealthResponse { ok: true; version: string; aiEnabled: boolean }

// POST /api/register — join the household from a new device.
export interface RegisterRequest {
  /** Shared secret set as HOUSEHOLD_CODE on the server. */
  householdCode: string;
  name: string;
  /** Re-register an existing member on a new device (same name = same member). */
}
export interface RegisterResponse {
  deviceToken: string;
  memberId: string;
  householdName: string;
}

export interface Member {
  id: string;
  name: string;
  joinedAt: string;          // ISO
  lastSeenAt: string | null; // ISO
}

/** A member's study summary for one day. Sent by each phone, read by the other. */
export interface DayStats {
  date: string;              // 'YYYY-MM-DD'
  studyMinutes: number;
  reviews: number;
  correct: number;
  newItems: number;
  sessionComplete: boolean;
}

// POST /api/stats — upsert this member's recent days and totals.
// Success codes: POST /api/messages → 201 new / 200 resent clientId; POST /api/voice and /api/quizzes → 201.
// Treat any 2xx as success.

/** POST /api/stats response. */
export interface StatsUploadResponse { ok: true }

export interface StatsUploadRequest {
  days: DayStats[];          // usually the last 7 days
  streak: number;
  kanjiKnown: number;
  /** Every kanji this member has been introduced to, for "you both know". */
  knownKanji: string[];
  phase: number;
}

export interface MemberStats {
  member: Member;
  days: DayStats[];          // last 7 days, oldest first, missing days filled with zeros
  streak: number;
  kanjiKnown: number;
  knownKanji: string[];
  phase: number;
  updatedAt: string | null;
}

// GET /api/household
export interface HouseholdResponse {
  householdName: string;
  me: string;                // memberId of the caller
  members: MemberStats[];
  /** Days in a row on which every member completed a session. */
  sharedStreak: number;
}

export type MessageKind = 'text' | 'voice' | 'system';

export interface ChatMessage {
  id: number;
  clientId: string;
  memberId: string;
  createdAt: string;         // ISO
  kind: MessageKind;
  text: string;              // Japanese text; for voice, optional caption
  transcript?: string;       // speech-to-text of a voice message
  audioId?: string;
}

// GET /api/messages?after=<id>&limit=<n> → ChatMessage[] oldest first (limit default 100)
// POST /api/messages
export interface SendMessageRequest {
  clientId: string;          // idempotency key: re-sending the same clientId returns the original
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audioId?: string;
}
export type SendMessageResponse = ChatMessage;

// POST /api/voice (multipart field "audio", ≤ 2 MB, audio/webm|audio/mp4|audio/ogg|audio/wav)
export interface UploadVoiceResponse { audioId: string }
// GET /api/voice/:audioId → the audio bytes with their content type

// Quiz each other: send your hardest kanji to your partner.
export interface QuizItem { char: string }
export interface Quiz {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  createdAt: string;
  items: QuizItem[];
  /** Filled in when the recipient finishes. */
  result?: { correct: number; total: number; finishedAt: string; missed: string[] };
}
// POST /api/quizzes { toMemberId, items } → Quiz
export interface CreateQuizRequest { toMemberId: string; items: QuizItem[] }
// GET /api/quizzes → { inbox: Quiz[]; sent: Quiz[] } (last 20 each, newest first)
export interface QuizzesResponse { inbox: Quiz[]; sent: Quiz[] }
// POST /api/quizzes/:id/result { correct, total, missed } → Quiz
export interface QuizResultRequest { correct: number; total: number; missed: string[] }

// AI helper (only when ANTHROPIC_API_KEY is set; otherwise 503 { error: 'ai_disabled' }).
// POST /api/ai/check — look over a learner's Japanese before sending.
export interface AiCheckRequest {
  text: string;
  /** Kanji the writer knows, so suggestions stay at their level. */
  knownKanji?: string[];
  /** Recent chat lines for context, oldest first, max 6. */
  context?: string[];
}
export interface AiTip {
  original: string;          // the part that is wrong or unnatural
  suggestion: string;        // the fix
  explanation: string;       // one short English sentence
}
export interface AiCheckResponse {
  ok: boolean;               // true = natural and correct, no tips
  corrected: string;         // whole message, fixed (same as input when ok)
  tips: AiTip[];             // max 3, most important first
  /** `corrected` in ruby markup "{漢字|かんじ}" for kanji outside knownKanji. */
  correctedRuby: string;
}

// POST /api/ai/translate — "How do I say this?"
export interface AiTranslateRequest { english: string; knownKanji?: string[] }
export interface AiTranslateResponse {
  /** Casual spoken Japanese between partners, in ruby markup. */
  japanese: string;
  romaji: string;
  /** One short note on word choice, or ''. */
  note: string;
}

/**
 * WebSocket close code (policy violation) for a device that is no longer paired: it was
 * signed out or removed with the admin CLI. The phone should pair again, not reconnect.
 */
export const WS_CLOSE_UNPAIRED = 1008;

// WebSocket /api/ws?token=… — server → client events (JSON, one per frame).
export type ServerEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'stats'; memberId: string }                 // a member uploaded new stats
  | { type: 'quiz'; quiz: Quiz }                        // new quiz or result for you
  | { type: 'presence'; memberId: string; online: boolean }
  | { type: 'roleplay'; memberId: string; state: RolePlaySyncState };

// Client → server events over the same socket.
export type ClientEvent =
  | { type: 'roleplay'; state: RolePlaySyncState }      // relayed to the other members
  | { type: 'ping' };

/** Shared position in a role-play so both phones advance together. */
export interface RolePlaySyncState {
  sessionId: string;         // random id per role-play run
  scriptId: string;
  /** Role chosen by the sender. */
  role: 'a' | 'b';
  lineIndex: number;         // index of the line currently being spoken
  status: 'waiting' | 'active' | 'done';
}
