/**
 * Text normalisation with an index map back to the original string.
 *
 * Matching happens on normalised text (NFKC → full-width "ＣＯＮＦＩＤＥＮＴＩＡＬ" becomes ASCII, case folded,
 * whitespace collapsed, zero-width characters dropped), but removal must happen on the ORIGINAL text.
 * `start[i]` / `end[i]` give the original UTF-16 range that produced normalised UTF-16 unit `i`.
 */
export interface Normalized {
  text: string;
  /** original start offset of the source code point for each normalised UTF-16 unit */
  start: Int32Array;
  /** original end offset (exclusive) of the source code point for each normalised UTF-16 unit */
  end: Int32Array;
}

// Zero-width / invisible characters that are often injected by layout engines and break matching.
const INVISIBLE = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x180e]);

function isSpace(cp: number): boolean {
  return (
    cp === 0x20 ||
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

export function normalize(input: string, foldCase: boolean): Normalized {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const next = i + len;

    if (INVISIBLE.has(cp)) {
      i = next;
      continue;
    }
    if (isSpace(cp)) {
      if (!lastWasSpace) {
        out.push(' ');
        start.push(i);
        end.push(next);
        lastWasSpace = true;
      } else {
        // extend the previous space so removing it covers the whole whitespace run
        end[end.length - 1] = next;
      }
      i = next;
      continue;
    }

    let n = String.fromCodePoint(cp).normalize('NFKC');
    if (foldCase) n = n.toLowerCase();
    for (let k = 0; k < n.length; k++) {
      // NFKC may itself yield a space (e.g. U+3000 handled above, but also some compat forms)
      const ch = n[k]!;
      if (ch === ' ') {
        if (lastWasSpace) continue;
        lastWasSpace = true;
      } else lastWasSpace = false;
      out.push(ch);
      start.push(i);
      end.push(next);
    }
    i = next;
  }

  return { text: out.join(''), start: Int32Array.from(start), end: Int32Array.from(end) };
}

/** Normalise a pattern the same way as the text (without the index map). Trims surrounding whitespace. */
export function normalizePattern(pattern: string, foldCase: boolean): string {
  return normalize(pattern, foldCase).text.trim();
}
