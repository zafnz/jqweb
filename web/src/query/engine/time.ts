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
  if (name !== 'mktime' && is(x, 'number')) return x.r;
  const v = wantType(x, 'array', name).v;
  if (v.length < 8) throw runErr(name + ' needs a broken-out time of at least eight parts');
  const parts = v.slice(0, 8).map(n => num(n, name));
  return utc(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
}

function utc(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  // Date.UTC treats years 0–99 as 1900–1999; setUTCFullYear does not.
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(hour, minute, Math.floor(second), 0);
  return d.getTime() / 1000 + second % 1;
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
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/.exec(s);
  if (!m) throw runErr('cannot read "' + s + '" as a date');
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    throw runErr('cannot read "' + s + '" as a date');
  }
  return utc(year, month - 1, day, hour, minute, second);
}
