// JMdict: streamed entry by entry so the 60 MB dictionary never sits in memory.

import { parseXmlGz } from './xml.ts';

export interface JmKanji {
  text: string;
  /** ke_inf entity names: 'iK', 'oK', 'rK', 'sK', 'ateji', … */
  info: string[];
  /** ke_pri tags: 'news1', 'ichi1', 'nf03', … */
  pri: string[];
}

export interface JmReading {
  text: string;
  /** The reading is not a true reading of the kanji (re_nokanji). */
  noKanji: boolean;
  /** Kanji spellings this reading is restricted to (re_restr); empty = all. */
  restr: string[];
  info: string[];
  pri: string[];
}

export interface JmSense {
  /** Spellings / readings this sense is restricted to; empty = all. */
  stagk: string[];
  stagr: string[];
  /** Part-of-speech entity names; inherited from the previous sense when omitted. */
  pos: string[];
  /** Misc entity names: 'uk', 'abbr', 'arch', … */
  misc: string[];
  glosses: string[];
}

export interface JmEntry {
  id: string;
  kanji: JmKanji[];
  readings: JmReading[];
  senses: JmSense[];
}

function emptyEntry(): JmEntry {
  return { id: '', kanji: [], readings: [], senses: [] };
}

/** Streams JMdict_e.gz, calling `onEntry` for every entry in file order. */
export async function readJMdict(path: string, onEntry: (entry: JmEntry) => void): Promise<void> {
  let entry = emptyEntry();
  let kanji: JmKanji | undefined;
  let reading: JmReading | undefined;
  let sense: JmSense | undefined;
  let glossLang: string | undefined;
  let text = '';

  await parseXmlGz(path, {
    onopentag(tag) {
      text = '';
      switch (tag.name) {
        case 'entry': entry = emptyEntry(); break;
        case 'k_ele': kanji = { text: '', info: [], pri: [] }; break;
        case 'r_ele': reading = { text: '', noKanji: false, restr: [], info: [], pri: [] }; break;
        case 'sense': sense = { stagk: [], stagr: [], pos: [], misc: [], glosses: [] }; break;
        case 'gloss': glossLang = tag.attributes['xml:lang']; break;
      }
    },
    ontext(t) {
      text += t;
    },
    onclosetag(name) {
      switch (name) {
        case 'ent_seq': entry.id = text.trim(); break;
        case 'keb': if (kanji) kanji.text = text; break;
        case 'ke_inf': kanji?.info.push(text); break;
        case 'ke_pri': kanji?.pri.push(text); break;
        case 'k_ele': if (kanji) entry.kanji.push(kanji); kanji = undefined; break;
        case 'reb': if (reading) reading.text = text; break;
        case 're_nokanji': if (reading) reading.noKanji = true; break;
        case 're_restr': reading?.restr.push(text); break;
        case 're_inf': reading?.info.push(text); break;
        case 're_pri': reading?.pri.push(text); break;
        case 'r_ele': if (reading) entry.readings.push(reading); reading = undefined; break;
        case 'stagk': sense?.stagk.push(text); break;
        case 'stagr': sense?.stagr.push(text); break;
        case 'pos': sense?.pos.push(text); break;
        case 'misc': sense?.misc.push(text); break;
        case 'gloss': if (!glossLang || glossLang === 'eng') sense?.glosses.push(text); break;
        case 'sense':
          if (sense) {
            const prev = entry.senses[entry.senses.length - 1];
            if (sense.pos.length === 0 && prev) sense.pos = prev.pos;
            entry.senses.push(sense);
          }
          sense = undefined;
          break;
        case 'entry': onEntry(entry); break;
      }
    },
  });
}
