/**
 * The LLM's words, cut into sentences for speech as they stream in: Kokoro speaks one sentence at a time, so the first
 * sentence can be spoken while the model is still writing the second. A sentence ends at . ! ? … followed by a space
 * (or a newline); a long clause may end at : ; or a dash, so a first sentence of 300 characters does not hold the voice
 * back. Abbreviations like "e.g. " and numbers like "3.5" are not ends. Markdown marks are dropped from what is spoken.
 */
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|no|fig|approx|inc|ltd|st)\.$/i;

export class SentenceSplitter {
  private buf = "";
  private first = true;
  /**
   * At or past `longClause` characters, a clause end (: ; —) counts as a sentence end. The answer's first piece may end
   * earlier, at a clause (, : ; —) once it has `firstClause` characters (0: off), so the voice starts on the first clause
   * rather than waiting for the whole first sentence (owner, 27 November 2026: Bloom's first words sooner).
   */
  constructor(private longClause = 80, private firstClause = 0) {}

  /** Add streamed text; returns the sentences it completed. */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const cut = this.findEnd();
      if (cut < 0) break;
      const s = clean(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut).replace(/^\s+/, "");
      if (s) { out.push(s); this.first = false; }
    }
    return out;
  }

  /** What is left at the end of the stream. */
  flush(): string[] {
    const s = clean(this.buf);
    this.buf = "";
    return s ? [s] : [];
  }

  private findEnd(): number {
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === "\n" && b.slice(0, i).trim()) return i + 1;
      const next = b[i + 1];
      if (next === undefined) return -1; // the end of a sentence is only known once the next character is there
      if (".!?…".includes(c) && /\s/.test(next)) {
        if (c === "." && ABBREV.test(b.slice(0, i + 1))) continue;
        return i + 1;
      }
      if (":;—".includes(c) && /\s/.test(next) && i >= this.longClause) return i + 1;
      if (this.first && this.firstClause > 0 && ",:;—".includes(c) && /\s/.test(next) && i + 1 >= this.firstClause && !/\d/.test(b[i - 1] ?? "")) return i + 1;
    }
    return -1;
  }
}

/** What a voice should say: no markdown emphasis, headings, code ticks or link targets. */
export function clean(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
