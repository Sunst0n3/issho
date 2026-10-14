// Streaming XML helpers for the gzipped dictionary files in data-raw/.

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import sax from 'sax';

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** Longest entity reference we hold back while waiting for the next chunk. */
const MAX_ENTITY_LENGTH = 64;

const ENTITY_RE = /&([A-Za-z_][\w.-]*);/g;

/**
 * JMdict marks part of speech, misc tags etc. with entities declared in its DTD
 * (`<pos>&v1;</pos>`). sax does not expand DTD entities and rejects them in
 * strict mode, so we rewrite `&name;` to the bare name (`v1`) before parsing.
 * The five predefined XML entities and numeric references are left alone.
 * References split across chunk boundaries are carried over to the next chunk.
 */
export class EntityRewriter {
  private carry = '';

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = '';
    const amp = text.lastIndexOf('&');
    if (amp !== -1 && text.length - amp < MAX_ENTITY_LENGTH && !text.includes(';', amp)) {
      this.carry = text.slice(amp);
      text = text.slice(0, amp);
    }
    return rewriteEntities(text);
  }

  end(): string {
    const rest = this.carry;
    this.carry = '';
    return rewriteEntities(rest);
  }
}

export function rewriteEntities(text: string): string {
  return text.replace(ENTITY_RE, (ref, name: string) => (XML_ENTITIES.has(name) ? ref : name));
}

export interface XmlHandlers {
  onopentag?(tag: sax.Tag): void;
  onclosetag?(name: string): void;
  ontext?(text: string): void;
}

/** Parses a gzipped XML file with a strict sax parser, feeding it in chunks. */
export async function parseXmlGz(path: string, handlers: XmlHandlers): Promise<void> {
  const parser = sax.parser(true, { trim: false, normalize: false, position: true });
  let failure: Error | undefined;
  parser.onerror = (err) => {
    failure ??= new Error(`${path}: ${err.message.split('\n')[0]} (line ${parser.line + 1})`);
  };
  if (handlers.onopentag) parser.onopentag = handlers.onopentag as (tag: sax.Tag | sax.QualifiedTag) => void;
  if (handlers.onclosetag) parser.onclosetag = handlers.onclosetag;
  if (handlers.ontext) parser.ontext = handlers.ontext;

  const rewriter = new EntityRewriter();
  const input = createReadStream(path).pipe(createGunzip());
  input.setEncoding('utf8');
  for await (const chunk of input as AsyncIterable<string>) {
    parser.write(rewriter.push(chunk));
    if (failure) {
      input.destroy();
      throw failure;
    }
  }
  parser.write(rewriter.end()).close();
  if (failure) throw failure;
}
