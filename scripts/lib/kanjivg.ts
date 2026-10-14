// KanjiVG: stroke paths and the component (element) tree of every character.

import { parseXmlGz } from './xml.ts';

/** A `<g>` element group. `strokes` indexes into KvgChar.strokes. */
export interface KvgGroup {
  element?: string;
  /** The full form this element is a variant of ('水' for '氵'). */
  original?: string;
  variant: boolean;
  /** The group holds only some of the element's strokes. */
  partial: boolean;
  /** Set when one element is split over several groups (part 1, part 2, …). */
  part?: number;
  strokes: number[];
  children: KvgGroup[];
}

export interface KvgChar {
  char: string;
  /** Stroke paths in stroke order. */
  strokes: string[];
  root: KvgGroup;
}

const KANJI_ID_RE = /^kvg:kanji_([0-9a-f]+)$/;
const STROKE_ID_RE = /-s(\d+)$/;

function newGroup(attrs: Record<string, string>): KvgGroup {
  const part = attrs['kvg:part'];
  return {
    element: attrs['kvg:element'] || undefined,
    original: attrs['kvg:original'] || undefined,
    variant: attrs['kvg:variant'] === 'true',
    partial: attrs['kvg:partial'] === 'true',
    part: part ? Number(part) : undefined,
    strokes: [],
    children: [],
  };
}

/**
 * Reads every character in kanjivg.xml.gz. Strokes are kept in document order,
 * which is KanjiVG's stroke order; the numbered stroke ids are checked against it.
 */
export async function readKanjiVG(path: string): Promise<Map<string, KvgChar>> {
  const chars = new Map<string, KvgChar>();
  let current: KvgChar | undefined;
  let stack: KvgGroup[] = [];

  await parseXmlGz(path, {
    onopentag(tag) {
      const attrs = tag.attributes;
      if (tag.name === 'kanji') {
        const m = KANJI_ID_RE.exec(attrs.id ?? '');
        if (!m) throw new Error(`KanjiVG: unexpected kanji id "${attrs.id}"`);
        const root: KvgGroup = newGroup({});
        current = { char: String.fromCodePoint(parseInt(m[1], 16)), strokes: [], root };
        stack = [];
      } else if (tag.name === 'g' && current) {
        const group = newGroup(attrs);
        if (stack.length === 0) current.root = group;
        else stack[stack.length - 1].children.push(group);
        stack.push(group);
      } else if (tag.name === 'path' && current) {
        const index = current.strokes.length;
        const numbered = STROKE_ID_RE.exec(attrs.id ?? '');
        if (numbered && Number(numbered[1]) !== index + 1) {
          throw new Error(`KanjiVG: stroke ${attrs.id} of ${current.char} is out of document order`);
        }
        current.strokes.push(attrs.d ?? '');
        for (const g of stack) g.strokes.push(index);
      }
    },
    onclosetag(name) {
      if (name === 'g') stack.pop();
      else if (name === 'kanji' && current) {
        chars.set(current.char, current);
        current = undefined;
      }
    },
  });
  return chars;
}

/** Depth-first walk over every group below `root` (root excluded). */
export function* descendants(root: KvgGroup): Generator<KvgGroup> {
  for (const child of root.children) {
    yield child;
    yield* descendants(child);
  }
}

/**
 * The teachable components of a character, in document (roughly writing) order.
 * A group whose element is teachable (a jōyō kanji or a known radical) is taken
 * whole; any other group is looked through to the elements inside it. So 語
 * gives 言 五 口: 吾 is not teachable, but its parts are.
 */
export function componentsOf(char: KvgChar, isTeachable: (element: string) => boolean): string[] {
  const out: string[] = [];
  for (const { group, teachable } of elementGroups(char, isTeachable)) {
    if (teachable && !out.includes(group.element!)) out.push(group.element!);
  }
  return out;
}

/**
 * The element groups componentsOf looks through because they are not
 * teachable (吾 in 語, or a lone stroke such as 丿), in document order.
 */
export function ignoredElements(char: KvgChar, isTeachable: (element: string) => boolean): KvgGroup[] {
  const out: KvgGroup[] = [];
  for (const { group, teachable } of elementGroups(char, isTeachable)) if (!teachable) out.push(group);
  return out;
}

/** The walk behind componentsOf: a teachable group ends its branch, any other group is looked through. */
function* elementGroups(
  char: KvgChar,
  isTeachable: (element: string) => boolean,
): Generator<{ group: KvgGroup; teachable: boolean }> {
  function* walk(parent: KvgGroup): Generator<{ group: KvgGroup; teachable: boolean }> {
    for (const group of parent.children) {
      const el = group.element;
      const isElement = el !== undefined && el !== char.char;
      const teachable = isElement && isTeachable(el);
      if (isElement) yield { group, teachable };
      if (!teachable) yield* walk(group);
    }
  }
  yield* walk(char.root);
}

/**
 * Stroke paths of one element as drawn inside `host`, for components that have
 * no KanjiVG entry of their own. Prefers a group holding the whole element.
 */
export function elementStrokes(host: KvgChar, element: string): string[] | undefined {
  let best: KvgGroup | undefined;
  for (const g of descendants(host.root)) {
    if (g.element !== element || g.part !== undefined) continue;
    if (!g.partial) {
      best = g;
      break;
    }
    best ??= g;
  }
  return best?.strokes.map((i) => host.strokes[i]);
}
