// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { composesReading, isCounterReading, readJmdictReadings, soundVariants } from './lib/readings.ts';

describe('soundVariants', () => {
  it('voices the first kana and turns a final つ/ち/く/き/う into っ', () => {
    expect(soundVariants('ほん')).toEqual(['ほん', 'ぼん', 'ぽん']);
    expect(soundVariants('いち')).toEqual(['いち', 'いっ']);
    expect(soundVariants('じゅう')).toEqual(['じゅう', 'じゅっ']);
    expect(soundVariants('かく')).toEqual(['かく', 'がく', 'かっ', 'がっ']);
    expect(soundVariants('ご')).toEqual(['ご']);
  });
});

describe('composesReading', () => {
  it('takes one candidate per part, in order, using the whole reading', () => {
    expect(composesReading([['さん'], ['じゅう', 'じゅっ'], ['ぷん']], 'さんじゅっぷん')).toBe(true);
    expect(composesReading([['さん'], ['じゅう']], 'さんじゅうぷん')).toBe(false);
    expect(composesReading([['に'], ['にん']], 'ににん')).toBe(true);
    expect(composesReading([], '')).toBe(true);
  });
});

describe('isCounterReading', () => {
  it('reads a number and counter with the usual sound changes', () => {
    expect(isCounterReading('五分', 'ごふん')).toBe(true);
    expect(isCounterReading('一本', 'いっぽん')).toBe(true);
    expect(isCounterReading('三十分', 'さんじゅっぷん')).toBe(true);
    expect(isCounterReading('三本', 'さんぼん')).toBe(true);
    expect(isCounterReading('六百円', 'ろっぴゃくえん')).toBe(true);
    expect(isCounterReading('四時', 'よじ')).toBe(true);
    expect(isCounterReading('九時', 'くじ')).toBe(true);
    expect(isCounterReading('何人', 'なんにん')).toBe(true);
    expect(isCounterReading('一週間', 'いっしゅうかん')).toBe(true);
    expect(isCounterReading('十四日', 'じゅうよっか')).toBe(true);
  });

  it('requires いっ and じゅっ before k, s, t and h', () => {
    expect(isCounterReading('一本', 'いちほん')).toBe(false);
    expect(isCounterReading('一回', 'いちかい')).toBe(false);
    expect(isCounterReading('十分', 'じゅうぶん')).toBe(false);
    expect(isCounterReading('一時', 'いちじ')).toBe(true);
    expect(isCounterReading('一枚', 'いちまい')).toBe(true);
  });

  it('reads the numeral before a counter in its set form', () => {
    expect(isCounterReading('四時', 'よんじ')).toBe(false);
    expect(isCounterReading('九時', 'きゅうじ')).toBe(false);
    expect(isCounterReading('四月', 'よんがつ')).toBe(false);
    expect(isCounterReading('九月', 'きゅうがつ')).toBe(false);
    expect(isCounterReading('四月', 'しがつ')).toBe(true);
    expect(isCounterReading('四人', 'よんにん')).toBe(false);
    expect(isCounterReading('四人', 'よにん')).toBe(true);
    expect(isCounterReading('四年', 'よんねん')).toBe(false);
    expect(isCounterReading('四分', 'よんぷん')).toBe(true);
    expect(isCounterReading('四十分', 'よんじゅっぷん')).toBe(true);
  });

  it('leaves days 2–10 and 20 to the dictionary, and reads 14 and 24 with よっか', () => {
    expect(isCounterReading('三日', 'さんにち')).toBe(false);
    expect(isCounterReading('十日', 'じゅうにち')).toBe(false);
    expect(isCounterReading('二十日', 'にじゅうにち')).toBe(false);
    expect(isCounterReading('十四日', 'じゅうよんにち')).toBe(false);
    expect(isCounterReading('二十四日', 'にじゅうよっか')).toBe(true);
    expect(isCounterReading('十一日', 'じゅういちにち')).toBe(true);
    expect(isCounterReading('十七日', 'じゅうしちにち')).toBe(true);
    expect(isCounterReading('十九日', 'じゅうくにち')).toBe(true);
    expect(isCounterReading('一日', 'いちにち')).toBe(true);
    // 二、三日 (にさんにち): a range of days is counted with にち.
    expect(isCounterReading('三日', 'さんにち', true)).toBe(true);
    expect(isCounterReading('四日', 'よっか', true)).toBe(true);
  });

  it('rejects other readings and anything that is not a number with a known counter', () => {
    expect(isCounterReading('五分', 'ごぶ')).toBe(false);
    expect(isCounterReading('五本', 'ごふん')).toBe(false);
    expect(isCounterReading('明日', 'あした')).toBe(false);
    expect(isCounterReading('三角', 'さんかく')).toBe(false);
  });
});

describe('readJmdictReadings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issho-readings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('indexes every regular reading under every spelling of the entry', async () => {
    const path = join(dir, 'jmdict.gz');
    writeFileSync(
      path,
      gzipSync(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE JMdict [
<!ENTITY sk "search-only kana form">
]>
<JMdict>
<entry><ent_seq>1</ent_seq>
<k_ele><keb>明日</keb></k_ele><k_ele><keb>翌日</keb></k_ele>
<r_ele><reb>あした</reb><re_restr>明日</re_restr></r_ele>
<r_ele><reb>みょうにち</reb></r_ele>
<r_ele><reb>あすた</reb><re_inf>&sk;</re_inf></r_ele>
</entry>
<entry><ent_seq>2</ent_seq>
<k_ele><keb>明日</keb></k_ele>
<r_ele><reb>アス</reb></r_ele>
<r_ele><reb>あしたっ</reb><re_nokanji/></r_ele>
</entry>
</JMdict>`),
    );
    const { byWritten, kana } = await readJmdictReadings(path);
    expect(byWritten.get('明日')).toEqual(['あした', 'みょうにち', 'あす']);
    expect(byWritten.get('翌日')).toEqual(['あした', 'みょうにち']);
    expect([...kana]).toEqual(['あした', 'みょうにち', 'アス', 'あしたっ']);
  });
});
