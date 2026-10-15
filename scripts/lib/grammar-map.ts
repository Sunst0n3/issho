// v1 grammar ids (content/grammar.json, 37 points) → grammar-v2 ids, for re-tagging content that
// was written against v1 (content/sentences/*.json). Every v1 point survives in grammar-v2 under
// the same id; an id mapped to null has no v2 equivalent and is dropped from the tags.

export const V1_TO_V2_GRAMMAR: Readonly<Record<string, string | null>> = {
  'wa-desu': 'wa-desu',
  'ka-question': 'ka-question',
  'kore-sore-are': 'kore-sore-are',
  'no-possession': 'no-possession',
  'ja-nai-desu': 'ja-nai-desu',
  'mo-also': 'mo-also',
  'i-adjectives': 'i-adjectives',
  'na-adjectives': 'na-adjectives',
  'counting-tsu': 'counting-tsu',
  'masu-forms': 'masu-forms',
  'wo-object': 'wo-object',
  'ni-time-place': 'ni-time-place',
  'he-direction': 'he-direction',
  'de-place-means': 'de-place-means',
  'to-with': 'to-with',
  'kara-made': 'kara-made',
  'arimasu-imasu': 'arimasu-imasu',
  'adjective-past': 'adjective-past',
  'tai-want': 'tai-want',
  'masenka-mashou': 'masenka-mashou',
  'dictionary-form': 'dictionary-form',
  'te-form': 'te-form',
  'te-kudasai': 'te-kudasai',
  'te-imasu': 'te-imasu',
  'casual-speech': 'casual-speech',
  'nai-form': 'nai-form',
  'casual-past': 'casual-past',
  'ta-koto-ga-aru': 'ta-koto-ga-aru',
  'to-omou': 'to-omou',
  'kara-because': 'kara-because',
  'kedo-but': 'kedo-but',
  'toki-when': 'toki-when',
  'mae-ni-ato-de': 'mae-ni-ato-de',
  'yori-hou': 'yori-hou',
  'temo-ii': 'temo-ii',
  'nakereba-naranai': 'nakereba-naranai',
  'potential-form': 'potential-form',
};

/**
 * Grammar tags in v2 ids: a v1 id is mapped (and dropped when it has no v2 equivalent), anything
 * else is kept as written for validation, without duplicates.
 */
export function mapGrammarTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const mapped = Object.hasOwn(V1_TO_V2_GRAMMAR, tag) ? V1_TO_V2_GRAMMAR[tag] : tag;
    if (mapped !== null && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}
