/* Escaping text for the two places the page writes it: a JSON string literal
   and HTML. */

/* Renders a string as a JSON string literal, quotes included.
   JSON.stringify leaves U+2028 and U+2029 raw; they are escaped so the tree
   shows them instead of an invisible separator. */
export function quote(s: string): string {
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, function (c) {
    return '\\u202' + (c === '\u2028' ? '8' : '9');
  });
}

/* Escapes text for HTML. The tree is built as markup, so everything taken
   from the document goes through here first -- including anything placed in
   an attribute, hence the quote characters. */
const escMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
export function esc(s: string): string { return s.replace(/[&<>"']/g, function (c) { return escMap[c]; }); }
