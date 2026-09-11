/* Turning what someone gave the search box into the queries they might have
   meant: the readings of a clicked line, and the completions of a key name
   still being typed.

   Clicking the filter button on ".paths[\"/page/\"].get.tags[0]" could mean
   half a dozen things, and which one is a judgement about the document, not
   something that can be read off the path: "find the other paths tagged this"
   pivots on .paths, while "find this exact tag" pivots on the array it sits
   in. So suggest() offers the whole ladder -- one query per ancestor the value
   could be looked for across -- and the caller runs each and labels it with
   what it returns, which is what lets someone pick by outcome instead of by
   reasoning about jq.

   splitPartial() and completions() are the other half: reading a query that
   ends in a half-typed name, and the keys that could finish it.

   Everything here is text in, text out, over the node form core.js parses to.
   Nothing touches the DOM and nothing runs a query. */
var jqsuggest = (function () {
  'use strict';

  var core = typeof jqweb !== 'undefined' ? jqweb : require('./core.js');
  var pathText = core.pathText, stringify = core.stringify;

  /* How many ancestors to offer a pivot on. The outermost are the ones worth
     asking about -- they are where "the others like this" live -- and a deeply
     nested value would otherwise fill the list with narrow readings that all
     return one result. The innermost is always kept, because it is the literal
     reading of the line. */
  var MAX_PIVOTS = 6;

  /* How long a value may be before the readings stop asking whether a line
     matches it and start asking whether the line is there at all. Pasting a
     whole subtree into a query gives something no one can read in a list, and
     "which records have this field" is the useful question about a big value
     anyway. */
  var MAX_LITERAL = 60;

  /* The node segs leads to, or null if it leads nowhere. */
  function nodeAt(doc, segs) {
    var n = doc, at, i;
    for (i = 0; i < segs.length && n; i++) {
      if (segs[i].index !== undefined) {
        n = n.t === 'a' ? n.v[segs[i].index] : null;
      } else {
        at = n.t === 'o' ? n.k.lastIndexOf(segs[i].key) : -1;
        n = at < 0 ? null : n.v[at];
      }
    }
    return n || null;
  }

  /* Segments written as a suffix onto something else: "" for none, and no
     leading dot inserted before a "[", since ".x[0]" already reads correctly
     where a standalone path would need ".[0]". */
  function suffix(segs) {
    return segs.length ? pathText(segs).replace(/^\.\[/, '[') : '';
  }

  /* The test one member of a pivot has to pass. subject is what stands for
     that member: "" when iterating, ".value" inside with_entries.

     A "?" goes on the path whenever there is a chain that could fail, which is
     what lets a pivot hold members of mixed shapes -- .paths holds 46 objects
     but the document root holds strings too. It covers everything before it,
     so one is enough, and there is nothing to guard when the path is only the
     member itself. The "?" on index covers being handed a value that is not a
     list. */
  function condition(subject, test, literal, inArray) {
    var path = subject + suffix(test) + (test.length ? '?' : '');
    if (literal === null) return path + ' != null';
    if (!inArray) return (path || '.') + ' == ' + literal;
    return path ? path + ' | index(' + literal + ')?' : 'index(' + literal + ')?';
  }

  /* Which ancestor depths to pivot on: the outermost few, and the immediate
     container whatever its depth. */
  function depths(n) {
    var out = [], d;
    for (d = 0; d < n && d < MAX_PIVOTS; d++) out.push(d);
    if (n > 0 && out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }

  /* How good a reading is, all else being equal, lowest first. Counts decide
     the order the reader sees, but several readings of the same line routinely
     return the same number, and then this picks between them: a named pivot
     beats the whole document, asking about the key the value sat under beats
     ignoring it, and both beat a search that gives up on structure. */
  var RANK = { pivot: 1, anyKey: 2, anywhere: 3, line: 4, unnamed: 1 };

  /* The queries a line might have meant, roughly widest reading first. Each is
     {q: text, why: a few words, shape: 'keys' or 'results', rank: a number}.

     shape is how to count what comes back, which the output alone does not
     say: with_entries hands back one object and the answer is how many keys it
     kept, while everything else hands back a stream and the answer is how long
     it is. A single object out of ".. | objects" is one result, not six keys.

     The caller decides what to do with them. A query that will not run against
     this document is still in the list, since running them is how the caller
     finds that out. */
  function suggest(doc, segs) {
    var out = [], seen = {}, value = nodeAt(doc, segs);
    if (!value) return out;

    /* A value too big to read is a value too big to paste into a query, so
       past a point the readings ask whether the line is there rather than
       whether it matches. condition() takes a null literal to mean that. */
    var literal = stringify(value);
    if (literal.length > MAX_LITERAL) literal = null;
    /* A value sitting in an array is asked about with index() rather than
       ==, because the question is almost always "which records list this"
       and not "which records list exactly this and nothing else". */
    var inArray = literal !== null &&
      segs.length > 0 && segs[segs.length - 1].index !== undefined;
    /* Segments from a pivot's member down to the value's own container. */
    var below = inArray ? segs.slice(0, -1) : segs;

    function add(q, why, shape, rank) {
      if (!q || seen[q]) return null;
      seen[q] = true;
      var c = { q: q, why: why, shape: shape, rank: rank };
      out.push(c);
      return c;
    }

    depths(segs.length).forEach(function (d) {
      var pivot = nodeAt(doc, segs.slice(0, d));
      if (!pivot || pivot.t === 'l') return;
      var at = pathText(segs.slice(0, d));
      var test = below.slice(d + 1);
      /* "is it there" needs somewhere to look; asking it of the member itself
         only asks whether the member is null. */
      if (literal === null && !test.length) return;
      var where = at === '.' ? 'across the document' : 'in ' + at;
      /* Pivoting on the very array the value sits in hands each element
         straight to the test, so there it is the element itself being asked
         about and the question is equality, not containment. */
      var holds = inArray && d < below.length;
      /* Pivoting on the document as a whole is a reading of last resort: it
         says nothing about where to look, and a named ancestor almost always
         reads better for the same answer. */
      var unnamed = at === '.' ? RANK.unnamed : 0;
      if (pivot.t === 'o') {
        add((at === '.' ? '' : at + ' | ') +
          'with_entries(select(' + condition('.value', test, literal, holds) + '))',
        where, 'keys', RANK.pivot + unnamed);
      } else {
        add((at === '.' ? '.[]' : at + '[]') +
          ' | select(' + condition('', test, literal, holds) + ')',
        where, 'results', RANK.pivot + unnamed);
      }
      /* The same question with the key the value happened to sit under left
         open: a tag on .get is usually wanted across .post and .delete too. */
      if (test.length > (literal === null ? 1 : 0)) {
        /* The second iterate is over whatever the members hold, which need not
           all be containers, so it is the one that needs guarding. The first
           is over the pivot, which the path already proved is one. */
        add((at === '.' ? '.[]' : at + '[]') + ' | .[]? | select(' +
          condition('', test.slice(1), literal, holds) + ')',
        where + ', any key', 'results', RANK.anyKey + unnamed);
      }
    });

    /* No pivot at all: wherever it is in the document. */
    var key = null;
    for (var i = below.length - 1; i >= 0; i--) {
      if (below[i].key !== undefined) { key = below[i].key; break; }
    }
    add(key === null ? '.. | select(. == ' + literal + ')'
      : '.. | objects | select(' + condition('', [{ key: key }], literal, inArray) + ')',
    'anywhere', 'results', RANK.anywhere);

    /* And the line itself, which is what the copy button gives you. plain marks
       it out for the caller: when no reading narrows the document down, every
       one of them returns the line that was clicked, and then this is the one
       that was meant. */
    var line = add(pathText(segs), 'this line', 'results', RANK.line);
    if (line) line.plain = true;
    return out;
  }

  /* ---- completing a half-typed key ---- */

  /* Splits a query that ends in a field access still being typed:
     ".items[].ki" is {lead: ".items[]", ctx: ".items[]", partial: "ki"}.
     lead is the text a completed name goes onto the end of; ctx is the query
     whose output holds the keys to offer. They differ when the name is the
     first thing after a pipe -- ".items[] | .na" keeps ".items[] | " as its
     lead, while the keys come from running ".items[]".

     Null for text that does not end in a field access, which runs as
     written. "." is a complete query, and a trailing ".." is recursion, not
     a name with more to come. */
  function splitPartial(raw) {
    var m = /\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(raw);
    if (!m) return null;
    var lead = raw.slice(0, m.index);
    if (lead.charAt(lead.length - 1) === '.') return null;
    if (!lead && m[1] === undefined) return null;
    var ctx = lead.replace(/\s+$/, '');
    if (ctx.charAt(ctx.length - 1) === '|') ctx = ctx.slice(0, -1).replace(/\s+$/, '');
    return { lead: lead, ctx: ctx || '.', partial: m[1] || '' };
  }

  /* Past this many completions the list stops being read and the partial is
     what narrows it, so the rest are dropped. */
  var MAX_COMPLETIONS = 200;

  /* The keys that could finish a partial name, gathered from the objects in
     the stream ctx produced: each key that starts with the partial and goes
     beyond it, with how many of the objects carry it, most common first and
     alphabetical between equals. exact says whether some object has the
     partial as a whole key, which means the text runs as written.

     The tally lives on a null-prototype object because the keys come from
     the document, and "constructor" is a name someone's data will have. */
  function completions(out, partial) {
    var tally = Object.create(null), keys = [], objects = 0, exact = false;
    var i, j, k, node;
    for (i = 0; i < out.length; i++) {
      node = out[i];
      if (node.t !== 'o') continue;
      objects++;
      for (j = 0; j < node.k.length; j++) {
        k = node.k[j];
        if (partial && k === partial) { exact = true; continue; }
        if (k.length <= partial.length || k.slice(0, partial.length) !== partial) continue;
        if (tally[k] === undefined) { tally[k] = 0; keys.push(k); }
        tally[k]++;
      }
    }
    keys.sort(function (a, b) { return tally[b] - tally[a] || (a < b ? -1 : 1); });
    if (keys.length > MAX_COMPLETIONS) keys.length = MAX_COMPLETIONS;
    return {
      exact: exact,
      objects: objects,
      keys: keys.map(function (key) { return { key: key, n: tally[key] }; })
    };
  }

  return { suggest: suggest, splitPartial: splitPartial, completions: completions };
})();

/* Node loads this file directly to test it; browsers use the global above. */
if (typeof module === 'object' && module.exports) module.exports = jqsuggest;
