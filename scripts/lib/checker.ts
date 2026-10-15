// Shared helpers for validating hand-authored content: a Checker collects errors (which fail the
// build) and warnings (in-progress content) with their location, and records the Japanese fields
// it sees so later checks (kanji, readings) can walk them.

import { validateRuby } from '../../src/lib/ruby.ts';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Japanese text field inside an entry. `ruby` fields use {漢字|かな} markup. */
export interface ContentField {
  path: string;
  text: string;
  ruby: boolean;
}

/** One entry of a content file (a sentence, a grammar point, a role-play, …). */
export interface ContentItem {
  id: string;
  /** Location used in messages, e.g. `[3] wa-desu`. */
  where: string;
  fields: ContentField[];
  /** Curriculum characters the item is about directly (a mnemonic's kanji or radical). */
  chars?: string[];
}

export interface ContentReport {
  items: ContentItem[];
  errors: string[];
  warnings: string[];
}

/** Collects problems for one file and records the Japanese fields it sees. */
export class Checker {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private readonly ids = new Set<string>();

  error(where: string, message: string) {
    this.errors.push(`${where}: ${message}`);
  }

  warn(where: string, message: string) {
    this.warnings.push(`${where}: ${message}`);
  }

  string(o: Obj, key: string, where: string, optional = false): string | undefined {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string' || !v.trim()) {
      this.error(where, `"${key}" must be a non-empty string`);
      return undefined;
    }
    return v;
  }

  /** A string that may be empty while the content is being written ('' is allowed, a missing key is not). */
  text(o: Obj, key: string, where: string): string | undefined {
    const v = o[key];
    if (typeof v !== 'string') {
      this.error(where, `"${key}" must be a string`);
      return undefined;
    }
    return v;
  }

  number(o: Obj, key: string, where: string, optional = false): number | undefined {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.error(where, `"${key}" must be a number`);
      return undefined;
    }
    return v;
  }

  boolean(o: Obj, key: string, where: string, optional = false): boolean | undefined {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'boolean') {
      this.error(where, `"${key}" must be true or false`);
      return undefined;
    }
    return v;
  }

  array(o: Obj, key: string, where: string, optional = false): unknown[] {
    const v = o[key];
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) {
      this.error(where, `"${key}" must be an array`);
      return [];
    }
    return v;
  }

  /** An array of strings (ids, tiles, options). */
  strings(o: Obj, key: string, where: string, optional = false): string[] {
    const list = this.array(o, key, where, optional);
    const out: string[] = [];
    list.forEach((v, i) => {
      if (typeof v === 'string' && v.trim()) out.push(v);
      else this.error(where, `"${key}"[${i}] must be a non-empty string`);
    });
    return out;
  }

  object(o: Obj, key: string, where: string, optional = false): Obj | undefined {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (!isObj(v)) {
      this.error(where, `"${key}" must be an object`);
      return undefined;
    }
    return v;
  }

  oneOf<T>(o: Obj, key: string, where: string, allowed: readonly T[]): T | undefined {
    const v = o[key] as T;
    if (!allowed.includes(v)) {
      this.error(where, `"${key}" must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
      return undefined;
    }
    return v;
  }

  id(o: Obj, where: string): string | undefined {
    const id = this.string(o, 'id', where);
    if (id === undefined) return undefined;
    if (this.ids.has(id)) this.error(where, `duplicate id "${id}"`);
    this.ids.add(id);
    return id;
  }

  ruby(o: Obj, key: string, where: string, fields: ContentField[], optional = false): string | undefined {
    const text = this.string(o, key, where, optional);
    if (text === undefined) return undefined;
    const path = `${where}.${key}`;
    for (const problem of validateRuby(text)) this.error(path, `${problem} in "${text}"`);
    fields.push({ path, text, ruby: true });
    return text;
  }
}

export function labelOf(index: number, id: string | number | undefined): string {
  return id !== undefined && id !== '' ? `[${index}] ${id}` : `[${index}]`;
}

/** Calls `fn` for each object of an array, reporting a non-array or a non-object entry. */
export function eachObject(data: unknown, c: Checker, what: string, fn: (o: Obj, index: number) => void): void {
  if (!Array.isArray(data)) {
    c.error('file', `must be an array of ${what}`);
    return;
  }
  data.forEach((o, i) => {
    if (isObj(o)) fn(o, i);
    else c.error(`[${i}]`, `each ${what.replace(/s$/, '')} must be an object`);
  });
}

/** JSON with object keys sorted, for comparing two copies of an entry regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}
