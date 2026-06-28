// Pure ANSI helpers shared by the terminal renderers: SGR styling and visible-width measurement
// that steps over zero-width color codes, so width math (truncation, padding) stays correct whether
// or not color is on. Manual scans instead of a regex, which can't carry a control character.

const ESC = "\x1b";

// Length of the SGR escape sequence (`ESC [ … m`) starting at `i`, or 0 if none does. Used to step
// over zero-width color codes when measuring/truncating by visible columns.
export function sgrAt(line: string, i: number): number {
  if (line[i] !== ESC || line[i + 1] !== "[") return 0;
  let j = i + 2;
  while (j < line.length && line[j] !== "m") {
    const c = line[j] ?? "";
    if (c !== ";" && (c < "0" || c > "9")) return 0; // not an SGR sequence after all
    j += 1;
  }
  return j < line.length ? j - i + 1 : 0; // include the trailing `m`
}

/** Visible column count, ignoring SGR color codes. */
export function visibleLen(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; ) {
    const len = sgrAt(line, i);
    if (len > 0) i += len;
    else {
      n += 1;
      i += 1;
    }
  }
  return n;
}

/** Truncate to `width` visible columns (ignoring SGR codes) so a line can't soft-wrap. */
export function clip(line: string, width: number): string {
  if (visibleLen(line) <= width) return line;
  let out = "";
  let shown = 0;
  for (let i = 0; i < line.length; ) {
    const len = sgrAt(line, i);
    if (len > 0) {
      out += line.slice(i, i + len);
      i += len;
      continue;
    }
    if (shown >= width) break;
    out += line[i];
    shown += 1;
    i += 1;
  }
  if (out.includes(ESC)) out += `${ESC}[0m`; // close any SGR left open by truncation
  return out;
}

export interface Style {
  /** Wrap `s` in an SGR sequence with the given codes; identity when color is off. */
  readonly sgr: (codes: string, s: string) => string;
  readonly dim: (s: string) => string;
  readonly bold: (s: string) => string;
  readonly red: (s: string) => string;
  readonly green: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly cyan: (s: string) => string;
}

/** SGR helpers that are identities when `color` is off, so plain output (and tests) is untouched. */
export function makeStyle(color: boolean): Style {
  const sgr = (codes: string, s: string): string => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  return {
    sgr,
    dim: (s) => sgr("2", s),
    bold: (s) => sgr("1", s),
    red: (s) => sgr("31", s),
    green: (s) => sgr("32", s),
    yellow: (s) => sgr("33", s),
    cyan: (s) => sgr("36", s),
  };
}
