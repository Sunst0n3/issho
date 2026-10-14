// English text with Japanese in it ("The final は is read "wa""): each run of
// Japanese gets lang="ja", so screen readers switch voice and the CJK font is
// picked on purpose.

/** Kana, kanji, 々, 〜, the long-vowel mark and Japanese punctuation. */
const JA_RUN = /([、-〃々-〇「-』〜぀-ヿ㐀-䶿一-鿿！（）？～]+)/u;

/** Splits `text` into English and Japanese runs; odd indexes are Japanese. */
export function splitJapanese(text: string): string[] {
  return text.split(JA_RUN);
}

export function MixedText({ text }: { text: string }) {
  return (
    <>
      {splitJapanese(text).map((part, i) => (i % 2 ? <span key={i} lang="ja">{part}</span> : part))}
    </>
  );
}
