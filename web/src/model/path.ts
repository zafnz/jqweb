/* jq-style paths such as .a.b[3]["x y"]: reading one typed into the search
   box, and writing one out for the copy button. */

/* One step into a document: a key of an object or an index into an array.
   Each form declares the other's field as undefined, so testing
   seg.index !== undefined tells them apart. */
export type Segment =
  | { key: string; index?: undefined }
  | { index: number; key?: undefined };

/* What may appear unquoted in a path segment: anything that is not a
   separator, a quote or whitespace. */
const pathChar = /[^.[\]"'\s]/;

/* A key that can be written as .name rather than ["name"]. */
const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* Writes segments back out as a jq-style path -- the inverse of parsePath,
   and what a copied path looks like. */
export function pathText(segs: Segment[]): string {
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    out += s.index !== undefined ? '[' + s.index + ']'
      : identRe.test(s.key) ? '.' + s.key : '[' + JSON.stringify(s.key) + ']';
  }
  if (!out) return '.';                       /* the root itself */
  return out.charAt(0) === '[' ? '.' + out : out;   /* jq writes .[0], not [0] */
}

/* parsePath splits a jq-style path such as .a.b[3]["x y"] into key and index
   segments. The leading dot is optional. Returns null for text that is not a
   path.

   Returning null is how the search box decides the text was meant as a
   filter instead, so anything malformed has to fail rather than parse
   approximately. */
export function parsePath(str: string): Segment[] | null {
  const s = str.trim();
  if (s === '.') return [];        /* the whole document */
  const segs: Segment[] = [];
  let i = 0;
  /* A path may start with a bare key ("a.b" for ".a.b"); read it first so
     the loop below only ever starts at a separator. */
  if (s.charAt(0) !== '.' && s.charAt(0) !== '[') {
    while (i < s.length && pathChar.test(s.charAt(i))) i++;
    if (!i) return null;
    segs.push({ key: s.slice(0, i) });
  }
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '.') {
      i++;
      /* ".[" is jq's .a.["b"]: the dot is decoration, the bracket carries
         the segment, so hand it to the bracket branch on the next pass. */
      if (s.charAt(i) === '[') continue;
      const start = i;
      while (i < s.length && pathChar.test(s.charAt(i))) i++;
      if (i === start) return null;   /* a dot with no name after it */
      segs.push({ key: s.slice(start, i) });
    } else if (c === '[') {
      const q = s.charAt(i + 1);
      if (q === '"' || q === "'") {
        /* A quoted key: scan to the matching quote, stepping over
           backslash escapes, and require a "]" right after it. */
        let j = i + 2;
        while (j < s.length && s.charAt(j) !== q) j += s.charAt(j) === '\\' ? 2 : 1;
        if (s.charAt(j) !== q || s.charAt(j + 1) !== ']') return null;
        if (q === '"') {
          /* Double quotes are JSON, so JSON.parse handles the escapes --
             and rejects the ones that are not valid JSON. */
          try { segs.push({ key: JSON.parse(s.slice(i + 1, j + 1)) }); }
          catch (e) { return null; }
        } else {
          /* Single quotes are not JSON; only \' and \\ mean anything. */
          segs.push({ key: s.slice(i + 2, j).replace(/\\(['\\])/g, '$1') });
        }
        i = j + 2;
      } else {
        /* An index: whole number, optionally negative to count from the
           end. Anything else in the brackets is not a path. */
        const j = s.indexOf(']', i + 1);
        if (j < 0 || !/^-?\d+$/.test(s.slice(i + 1, j))) return null;
        segs.push({ index: parseInt(s.slice(i + 1, j), 10) });
        i = j + 1;
      }
    } else {
      return null;                 /* not a separator: not a path */
    }
  }
  return segs.length ? segs : null;
}
