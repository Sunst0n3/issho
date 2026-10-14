// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readJMdict, type JmEntry } from './lib/jmdict.ts';
import { componentsOf, elementStrokes, ignoredElements, readKanjiVG, type KvgChar } from './lib/kanjivg.ts';
import { EntityRewriter, parseXmlGz, rewriteEntities } from './lib/xml.ts';

const dir = mkdtempSync(join(tmpdir(), 'issho-xml-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function gz(name: string, xml: string): string {
  const path = join(dir, name);
  writeFileSync(path, gzipSync(xml));
  return path;
}

describe('entity rewriting', () => {
  it('turns DTD entities into their names and keeps XML ones', () => {
    expect(rewriteEntities('<pos>&v1;</pos><misc>&uk;</misc>')).toBe('<pos>v1</pos><misc>uk</misc>');
    expect(rewriteEntities('a &amp; b &lt;c&gt; &quot;&apos; &#x41; &#65;')).toBe('a &amp; b &lt;c&gt; &quot;&apos; &#x41; &#65;');
    expect(rewriteEntities('&adj-na; &n-pref; &v5k-s;')).toBe('adj-na n-pref v5k-s');
  });

  it('handles references split across chunks', () => {
    const r = new EntityRewriter();
    const out = r.push('<pos>&ad') + r.push('j-i;</pos> &am') + r.push('p; x') + r.end();
    expect(out).toBe('<pos>adj-i</pos> &amp; x');
  });

  it('lets a strict parser read a document that uses DTD entities', async () => {
    const path = gz(
      'mini.xml.gz',
      '<?xml version="1.0"?>\n<!DOCTYPE r [\n<!ENTITY n "noun">\n]>\n<r><pos>&n;</pos><g>fish &amp; chips</g></r>',
    );
    const texts: string[] = [];
    await parseXmlGz(path, { ontext: (t) => t.trim() && texts.push(t) });
    expect(texts).toEqual(['n', 'fish & chips']);
  });

  it('reports malformed XML with the file and line', async () => {
    const path = gz('bad.xml.gz', '<r>\n<a></b></r>');
    await expect(parseXmlGz(path, {})).rejects.toThrow(/bad\.xml\.gz: .*line 2/);
  });
});

const JMDICT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE JMdict [
<!ENTITY n "noun (common) (futsuumeishi)">
<!ENTITY v1 "Ichidan verb">
<!ENTITY uk "word usually written using kana alone">
]>
<JMdict>
<entry>
<ent_seq>1259290</ent_seq>
<k_ele><keb>見る</keb><ke_pri>ichi1</ke_pri><ke_pri>news1</ke_pri><ke_pri>nf14</ke_pri></k_ele>
<k_ele><keb>観る</keb></k_ele>
<r_ele><reb>みる</reb><re_pri>ichi1</re_pri></r_ele>
<sense><pos>&v1;</pos><pos>vt</pos><gloss>to see</gloss><gloss>to look</gloss></sense>
<sense><gloss>to examine</gloss></sense>
</entry>
</JMdict>`;

describe('readJMdict', () => {
  it('streams entries with entity names, priorities and inherited part of speech', async () => {
    const entries: JmEntry[] = [];
    await readJMdict(gz('jmdict.gz', JMDICT), (e) => entries.push(e));
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.id).toBe('1259290');
    expect(e.kanji.map((k) => k.text)).toEqual(['見る', '観る']);
    expect(e.kanji[0].pri).toEqual(['ichi1', 'news1', 'nf14']);
    expect(e.readings[0]).toMatchObject({ text: 'みる', noKanji: false, restr: [] });
    expect(e.senses[0]).toMatchObject({ pos: ['v1', 'vt'], glosses: ['to see', 'to look'] });
    expect(e.senses[1].pos).toEqual(['v1', 'vt']);
  });
});

const KANJIVG = `<?xml version="1.0" encoding="UTF-8"?>
<kanjivg xmlns:kvg='http://kanjivg.tagaini.net'>
<kanji id="kvg:kanji_08a9e">
<g id="kvg:08a9e" kvg:element="語">
  <g id="kvg:08a9e-g1" kvg:element="言" kvg:position="left">
    <path id="kvg:08a9e-s1" d="M1,1"/>
    <g id="kvg:08a9e-g2" kvg:element="口"><path id="kvg:08a9e-s2" d="M2,2"/></g>
  </g>
  <g id="kvg:08a9e-g3" kvg:element="吾" kvg:position="right">
    <g id="kvg:08a9e-g4" kvg:element="五">
      <g id="kvg:08a9e-g5" kvg:element="二" kvg:part="1"><path id="kvg:08a9e-s3" d="M3,3"/></g>
      <path id="kvg:08a9e-s4" d="M4,4"/>
      <g id="kvg:08a9e-g6" kvg:element="二" kvg:part="2"><path id="kvg:08a9e-s5" d="M5,5"/></g>
    </g>
    <g id="kvg:08a9e-g7" kvg:element="口"><path id="kvg:08a9e-s6" d="M6,6"/></g>
  </g>
</g>
</kanji>
<kanji id="kvg:kanji_03042">
<g id="kvg:03042" kvg:element="あ"><path id="kvg:03042-s1" d="M7,7"/><path id="kvg:03042-s2" d="M8,8"/><path id="kvg:03042-s3" d="M9,9"/></g>
</kanji>
</kanjivg>`;

describe('KanjiVG', () => {
  let chars: Map<string, KvgChar>;
  let go: KvgChar;
  beforeAll(async () => {
    chars = await readKanjiVG(gz('kanjivg.gz', KANJIVG));
    go = chars.get('語')!;
  });

  it('reads strokes in order for kanji and kana', () => {
    expect(go.strokes).toEqual(['M1,1', 'M2,2', 'M3,3', 'M4,4', 'M5,5', 'M6,6']);
    expect(chars.get('あ')?.strokes).toHaveLength(3);
  });

  it('finds teachable components, looking through unteachable groups', () => {
    const teachable = new Set(['言', '五', '口', '二']);
    expect(componentsOf(go, (el) => teachable.has(el))).toEqual(['言', '五', '口']);
    expect(componentsOf(go, (el) => el === '口' || el === '二')).toEqual(['口', '二']);
    expect(componentsOf(go, () => false)).toEqual([]);
  });

  it('lists the elements it looks through, with their strokes', () => {
    const teachable = new Set(['言', '五', '口']);
    const ignored = (isTeachable: (el: string) => boolean) =>
      ignoredElements(go, isTeachable).map((g) => `${g.element}:${g.strokes.length}`);
    expect(ignored((el) => teachable.has(el))).toEqual(['吾:4']);
    expect(ignored((el) => el === '口')).toEqual(['言:2', '吾:4', '五:3', '二:1', '二:1']);
  });

  it('extracts the strokes of one element inside a host', () => {
    expect(elementStrokes(go, '五')).toEqual(['M3,3', 'M4,4', 'M5,5']);
    expect(elementStrokes(go, '言')).toEqual(['M1,1', 'M2,2']);
    expect(elementStrokes(go, '二')).toBeUndefined();
  });
});
