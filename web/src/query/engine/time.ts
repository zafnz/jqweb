/* Times, for gmtime, mktime, strftime and the todate and fromdate filters. */

import { leafOf } from '../../model/node.ts';
import type { ArrayNode, Node } from '../../model/node.ts';
import { runErr } from './errors.ts';
import { arrayOf, is, wantType } from './values.ts';

/* Milliseconds since the epoch for a UTC date and time, with each part
   carried into the next when it is out of range, so month 12 is January
   of the next year. Date.UTC would read a year under 100 as 19xx. */
function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, mo, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
}

/* The broken-out time jq's gmtime returns: year, month from zero, day,
   hour, minute, second, weekday, and day of the year from zero. The
   fraction of a second stays on the seconds, and a negative time is
   truncated toward zero before it is broken out, so -1.5 is 23:59:59.5 on
   the last day of 1969, as in jq. */
export function parts(secs: number): number[] {
  const d = new Date(Math.trunc(secs) * 1000);
  const y = d.getUTCFullYear();
  return [y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(),
    d.getUTCSeconds() + (secs - Math.floor(secs)), d.getUTCDay(),
    Math.round((utc(y, d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) - utc(y, 0, 1, 0, 0, 0)) / 86400000)];
}

export function broken(secs: number): ArrayNode { return arrayOf(parts(secs).map(leafOf)); }

/* The eight parts of a broken-out time given as an array, which is what
   mktime and strftime take. jq wants all eight as numbers, whole ones
   apart from the seconds, and a year from 1900 on; anything out of range
   is carried into the next part rather than refused. */
export function fields(x: Node, name: string): number[] {
  const v = wantType(x, 'array', name).v;
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    const n = v[i];
    if (n === undefined || !is(n, 'number')) {
      throw runErr(name + ' needs a broken-out time of eight numbers');
    }
    out.push(i === 5 ? n.r : Math.trunc(n.r));
  }
  if (out[0] < 1900) throw runErr(name + ' cannot represent a year before 1900');
  return out;
}

/* Seconds since the epoch of a broken-out time. The weekday and the day
   of the year are ignored, and the seconds are truncated. */
export function mktime(f: number[]): number {
  return utc(f[0], f[1], f[2], f[3], f[4], Math.trunc(f[5])) / 1000;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function pad(n: number, w: number): string {
  let s = String(Math.floor(Math.abs(n)));
  while (s.length < w) s = '0' + s;
  return (n < 0 ? '-' : '') + s;
}

/* The strftime specifiers people actually type, over the parts as given
   rather than normalised, so a month of 12 prints as 13, as in jq. An
   unknown one is left as written rather than guessed at. */
export function strftime(t: number[], fmt: string): string {
  const day = DAYS[t[6]] || '?';
  const month = MONTHS[t[1]] || '?';
  const map: Record<string, string> = {
    Y: pad(t[0], 4), m: pad(t[1] + 1, 2), d: pad(t[2], 2), e: String(t[2]),
    H: pad(t[3], 2), M: pad(t[4], 2), S: pad(t[5], 2), j: pad(t[7] + 1, 3),
    a: day.slice(0, 3), A: day, b: month.slice(0, 3),
    B: month, y: pad(t[0] % 100, 2), Z: 'UTC', z: '+0000',
    T: pad(t[3], 2) + ':' + pad(t[4], 2) + ':' + pad(t[5], 2),
    D: pad(t[1] + 1, 2) + '/' + pad(t[2], 2) + '/' + pad(t[0] % 100, 2),
    F: pad(t[0], 4) + '-' + pad(t[1] + 1, 2) + '-' + pad(t[2], 2),
    u: String(t[6] === 0 ? 7 : t[6]), w: String(t[6]), s: String(Math.floor(mktime(t))),
    n: '\n', t: '\t', '%': '%'
  };
  return fmt.replace(/%(.)/g, function (whole: string, c: string) {
    return map[c] === undefined ? whole : map[c];
  });
}

/* What fromdate reads: "%Y-%m-%dT%H:%M:%SZ" as C's strptime takes it,
   with each field of one or more digits, up to four for the year, and
   only blank space allowed after the Z. The ranges are strptime's -- a
   day of 0 and a second of 60 pass -- and what passes is normalised, so
   February 30th is March 1st. */
const ISO = /^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z\s*$/;
const FORMAT = '%Y-%m-%dT%H:%M:%SZ';

export function parseDate(x: Node, name: string): number {
  const s = wantType(x, 'string', name).r;
  const m = ISO.exec(s);
  const f = m ? m.slice(1).map(Number) : null;
  if (!f || f[1] < 1 || f[1] > 12 || f[2] > 31 || f[3] > 23 || f[4] > 59 || f[5] > 60) {
    throw runErr('date "' + s + '" does not match format "' + FORMAT + '"');
  }
  if (f[0] < 1900) throw runErr(name + ' cannot represent a year before 1900');
  return utc(f[0], f[1] - 1, f[2], f[3], f[4], f[5]) / 1000;
}
