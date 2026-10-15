// Who reads a script line. Role-play and task-script lines are voiced by role, not by character: role a with the
// female voice and role b with the male voice (roleVoice, TECH-DESIGN §2.2). A script that casts a woman as role b
// (or a man as role a) plays her lines in the wrong voice, so these checks catch the giveaways: a role named Ms. or
// Mr., a recurring character of the stories, and a speaker's "my husband" or "my wife".

import { parseRuby } from '../../src/lib/ruby.ts';
import type { VoiceId } from '../../src/lib/types.ts';
import { roleVoice } from '../../shared/voicevox.ts';

type Role = 'a' | 'b';

/** The recurring couple of the stories and units: Emma and her husband Ken. */
export const CAST: Readonly<Record<string, VoiceId>> = { Emma: 'f', エマ: 'f', Ken: 'm', ケン: 'm' };

/** "My husband" is said by a wife and "my wife" by a husband (ご主人 is someone else's husband). */
const SPOUSE_RUBY: Readonly<Record<string, VoiceId>> = { '夫|おっと': 'f', '主人|しゅじん': 'f', '妻|つま': 'm', '家内|かない': 'm' };
/** The same words written in kana, when a particle or です follows (not おっと! "oops", not つまり). */
const SPOUSE_KANA = /(?:^|[^ぁ-ゖ])(おっと|つま)(?=[のはがもをにと]|です)/gu;
const SPOUSE_KANA_SAID_BY: Readonly<Record<string, VoiceId>> = { おっと: 'f', つま: 'm' };

const VOICE_NAME: Record<VoiceId, string> = { f: 'female', m: 'male' };
const PERSON: Record<VoiceId, string> = { f: 'a woman', m: 'a man' };

/** The speaker's gender a line gives away, with the words that give it away. */
function lineGender(jp: string): { gender: VoiceId; word: string } | null {
  const segs = parseRuby(jp);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.reading !== undefined) {
      const gender = SPOUSE_RUBY[`${s.text}|${s.reading}`];
      if (gender && !(s.text === '主人' && segs[i - 1]?.text.endsWith('ご'))) return { gender, word: `{${s.text}|${s.reading}}` };
      continue;
    }
    for (const m of s.text.matchAll(SPOUSE_KANA)) return { gender: SPOUSE_KANA_SAID_BY[m[1]], word: m[1] };
  }
  return null;
}

/** A role's gender from its name: Ms./Mrs./Miss or Mr., or a member of the recurring cast. */
function nameGender(role: { name: string; nameJp: string }): VoiceId | null {
  if (/^(Ms|Mrs|Miss)\b/.test(role.name)) return 'f';
  if (/^Mr\b/.test(role.name)) return 'm';
  const first = role.name.split(/[\s(]/)[0];
  return CAST[first] ?? CAST[role.nameJp] ?? null;
}

/**
 * Lines and roles whose character contradicts the voice of their role. `roles` (role-plays) also checks the names;
 * task scripts have role descriptions, not names, so only their lines are checked.
 */
export function castProblems(
  lines: readonly { role: Role; jp: string }[],
  roles?: Readonly<Record<Role, { name: string; nameJp: string }>>,
): string[] {
  const problems: string[] = [];
  if (roles) {
    for (const role of ['a', 'b'] as const) {
      const gender = nameGender(roles[role]);
      const voice = roleVoice(role);
      if (gender && gender !== voice) {
        problems.push(`role ${role} "${roles[role].name}" is ${PERSON[gender]}, but role ${role} is read with the ${VOICE_NAME[voice]} voice`);
      }
    }
  }
  lines.forEach((line, i) => {
    const said = lineGender(line.jp);
    const voice = roleVoice(line.role);
    if (said && said.gender !== voice) {
      problems.push(`lines[${i}] (role ${line.role}, ${VOICE_NAME[voice]} voice) says ${said.word}, which only ${PERSON[said.gender]} says of their own spouse`);
    }
  });
  return problems;
}
