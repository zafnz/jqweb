/* jq's tonumber accepts decimal text and non-finite spellings, but not
   JavaScript's hexadecimal or binary coercions. Query tokens have their
   own grammar in lexer.ts; document numbers retain their original text. */
export function readNumber(s: string): number | undefined {
  const text = s.trim();
  if (/^[+-]?nan$/i.test(text)) return NaN;
  if (/^[+-]?inf(?:inity)?$/i.test(text)) return text[0] === '-' ? -Infinity : Infinity;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined;
  return Number(text);
}

export function roundNumber(n: number): number {
  const whole = Math.trunc(n);
  return Math.abs(n - whole) >= 0.5 ? whole + Math.sign(n) : whole;
}
