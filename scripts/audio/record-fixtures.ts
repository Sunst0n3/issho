// Records the VOICEVOX engine fixtures used by scripts/voicevox.test.ts and scripts/audio-jobs.test.ts.
// Run once against a local engine; the fixtures are committed, so the tests never need the engine.
//
//   node scripts/audio/record-fixtures.ts [--engine http://127.0.0.1:50021]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, type VvQuery } from '../../shared/voicevox.ts';
import { DEFAULT_ENGINE, HttpEngine } from './engine.ts';
import { wavDurationMs } from './encode.ts';

const OUT = fileURLToPath(new URL('../fixtures/voicevox/', import.meta.url));

/** Queries recorded as { [text]: query } per fixture file. */
const QUERIES: Record<string, string[]> = {
  // 箸 atamadaka, 橋 odaka, 端 heiban: 橋 and 端 alone are identical; only + が tells them apart.
  'hashi.json': ['箸', '箸が', '橋', '橋が', '端', '端が'],
  // 雨 read from its kanji (atamadaka); あめ alone takes an arbitrary homophone's accent (飴, heiban).
  'ame.json': ['雨', '雨が', 'あめ', 'あめが'],
  // 人気 with the reading ひとけ: the engine reads にんき, so the clip must come from the kana (via 'kana').
  'hitoke.json': ['人気', 'ひとけ', '人気がない。', 'ひとけがない。'],
  // Long vowels, particles and devoiced moras as the engine writes them.
  'readings.json': ['先生', '東京', 'コーヒー', '駅へ', '本を', 'は', 'ハ', 'を'],
};

/**
 * Sentences recorded with their synthesized WAV length, to check the frame timing model. `devoiceQuestionEnd` sets the
 * pitch of the question phrase's last mora to 0 before synthesis: the engine then adds no rising end to it.
 */
const SENTENCES: { file: string; text: string; phrases: string[]; devoiceQuestionEnd?: boolean }[] = [
  {
    file: 'sentence-story.json',
    text: '私は、毎朝コーヒーを飲みます。',
    phrases: ['{私|わたし}は、', '{毎朝|まいあさ}', 'コーヒーを{飲|の}みます。'],
  },
  {
    file: 'sentence-question.json',
    text: '元気ですか？はい、元気です。',
    phrases: ['{元気|げんき}ですか？', 'はい、', '{元気|げんき}です。'],
  },
  {
    file: 'sentence-question-devoiced.json',
    text: '元気ですか？はい、元気です。',
    phrases: ['{元気|げんき}ですか？', 'はい、', '{元気|げんき}です。'],
    devoiceQuestionEnd: true,
  },
];

async function main(): Promise<void> {
  const at = process.argv.indexOf('--engine');
  const engine = new HttpEngine(at > 0 ? process.argv[at + 1] : DEFAULT_ENGINE);
  const version = await engine.version();
  const speaker = VOICES.f.speaker;
  mkdirSync(OUT, { recursive: true });

  for (const [file, texts] of Object.entries(QUERIES)) {
    const queries: Record<string, VvQuery> = {};
    for (const text of texts) queries[text] = await engine.query(text, speaker);
    writeFileSync(join(OUT, file), JSON.stringify({ engine: version, speaker, queries }, null, 2) + '\n');
  }
  for (const s of SENTENCES) {
    const query = await engine.query(s.text, speaker);
    if (s.devoiceQuestionEnd) {
      const question = query.accent_phrases.find((p) => p.is_interrogative);
      if (!question) throw new Error(`${s.file}: "${s.text}" has no question phrase`);
      question.moras[question.moras.length - 1].pitch = 0;
    }
    const wavMs = wavDurationMs(await engine.synthesize(query, speaker));
    writeFileSync(
      join(OUT, s.file),
      JSON.stringify({ engine: version, speaker, text: s.text, phrases: s.phrases, wavMs, query }, null, 2) + '\n',
    );
  }
  console.log(`Recorded fixtures from VOICEVOX ${version} into ${OUT}`);
}

await main();
