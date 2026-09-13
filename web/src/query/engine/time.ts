/* Times, for gmtime, mktime, strftime and the todate and fromdate filters. */

import { leafOf } from '../../model/node.ts';
import type { ArrayNode, Node } from '../../model/node.ts';
import { runErr } from './errors.ts';
import { arrayOf, is, num, wantType } from './values.ts';

/* The broken-out time jq's gmtime returns: year, month from zero, day,
   hour, minute, second, weekday, and day of the year from zero. */
export function broken(secs: number): ArrayNode {
  const d = new Date(secs * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return arrayOf([leafOf(d.getUTCFullYear()), leafOf(d.getUTCMonth()), leafOf(d.getUTCDate()),
    leafOf(d.getUTCHours()), leafOf(d.getUTCMinutes()),
    leafOf(d.getUTCSeconds() + (secs - Math.floor(secs))),
    leafOf(d.getUTCDay()), leafOf(Math.floor((Date.UTC(d.getUTCFullYear(),
      d.getUTCMonth(), d.getUTCDate()) - start) / 86400000))]);
}

/* Seconds from a broken-out time, or from a number left as it is. */
export function seconds(x: Node, name: string): number {
  if (is(x, 'number')) return x.r;
  const v = wantType(x, 'array', name).v;
  if (v.length < 6) throw runErr(name + ' needs a broken-out time of at least six parts');
  return Date.UTC(num(v[0], name), num(v[1], name), num(v[2], name),
    num(v[3], name), num(v[4], name), Math.floor(num(v[5], name))) / 1000 +
    (num(v[5], name) % 1);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function pad(n: number, w: number): string {
  let s = String(Math.floor(Math.abs(n)));
  while (s.length < w) s = '0' + s;
  return (n < 0 ? '-' : '') + s;
}

/* The strftime specifiers people actually type. An unknown one is left as
   written rather than guessed at. */
export function strftime(secs: number, fmt: string): string {
  const t = broken(secs).v.map(function (n) { return num(n, 'strftime'); });
  const map: Record<string, string> = {
    Y: pad(t[0], 4), m: pad(t[1] + 1, 2), d: pad(t[2], 2), e: String(t[2]),
    H: pad(t[3], 2), M: pad(t[4], 2), S: pad(t[5], 2), j: pad(t[7] + 1, 3),
    a: DAYS[t[6]].slice(0, 3), A: DAYS[t[6]], b: MONTHS[t[1]].slice(0, 3),
    B: MONTHS[t[1]], y: pad(t[0] % 100, 2), Z: 'UTC', z: '+0000',
    T: pad(t[3], 2) + ':' + pad(t[4], 2) + ':' + pad(t[5], 2),
    D: pad(t[1] + 1, 2) + '/' + pad(t[2], 2) + '/' + pad(t[0] % 100, 2),
    F: pad(t[0], 4) + '-' + pad(t[1] + 1, 2) + '-' + pad(t[2], 2),
    u: String(t[6] === 0 ? 7 : t[6]), w: String(t[6]), s: String(Math.floor(secs)),
    n: '\n', t: '\t', '%': '%'
  };
  return fmt.replace(/%(.)/g, function (whole: string, c: string) {
    return map[c] === undefined ? whole : map[c];
  });
}

export function parseDate(x: Node, name: string): number {
  const s = wantType(x, 'string', name).r;
  const at = Date.parse(s);
  if (isNaN(at)) throw runErr('cannot read "' + s + '" as a date');
  return at / 1000;
}
