/* Turning a line of the document into the queries you might have meant.

   Clicking the filter button on ".paths[\"/page/\"].get.tags[0]" could mean
   half a dozen things, and which one is a judgement about the document, not
   something that can be read off the path: "find the other paths tagged this"
   pivots on .paths, while "find this exact tag" pivots on the array it sits
   in. So this offers the whole ladder -- one query per ancestor the value
   could be looked for across -- and the caller runs each and labels it with
   what it returns, which is what lets someone pick by outcome instead of by
   reasoning about jq.

   project() is the other half of the same job. A reading narrows the document
   down to the records you were after; what you usually want next is one field
   out of each of them, which is a query nothing about the clicked line can
   predict. It takes the lines picked out of a result and writes the object
   construction that keeps them.

   Everything here is text in, text out, over the node form core.js parses to.
   Nothing touches the DOM and nothing runs a query. */
var jqsuggest = (function () {
  'use strict';

  var core = typeof jqweb !== 'undefined' ? jqweb : require('./core.js');
  var pathText = core.pathText, stringify = core.stringify, quote = core.quote;

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

  /* The key a segment list ends under, or null if it is reached through
     indices alone. */
  function keyOf(segs) {
    for (var i = segs.length - 1; i >= 0; i--) {
      if (segs[i].key !== undefined) return segs[i].key;
    }
    return null;
  }

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

  /* Whether a pivot is a collection of records, which is where a search of
     each member's whole subtree is worth offering. Every member being a
     container is what a list of records looks like. A container with scalars
     in it is a record itself, and one with a single member is a step on the
     way down to one; asking either which of its members holds the value fills
     the list with readings that return one. */
  function collection(n) {
    if (n.v.length < 2) return false;
    for (var i = 0; i < n.v.length; i++) if (n.v[i].t === 'l') return false;
    return true;
  }

  /* How good a reading is, all else being equal, lowest first. Counts decide
     the order the reader sees, but several readings of the same line routinely
     return the same number, and then this picks between them: a named pivot
     beats the whole document, the path the value was clicked at beats a search
     of the member holding it, that beats leaving the key open, and all of them
     beat a search that gives up on structure. */
  var RANK = { pivot: 1, deep: 2, anyKey: 3, anywhere: 4, line: 5, unnamed: 1 };

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
    /* The key the value sat under, which is all a reading that has given up
       on the path has left to ask about. Null for a value reached only
       through indices, which is nothing to search on. */
    var key = keyOf(below);

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
      /* The same question asked of each member as a whole rather than of one
         path through it. A list of records holds them in more than one shape
         often enough -- a Pod keeps its containers at .spec.containers and a
         Deployment one level further down -- and then no exact path finds all
         of them. What it returns is the member, which is the difference
         between this and the reading below: that one hands back what it
         looked inside, so the record identifying the match is gone by the
         time you have the match. */
      if (key !== null && test.length > 1 && collection(pivot)) {
        var deep = 'any(.. | objects; ' +
          condition('', [{ key: key }], literal, inArray) + ')';
        if (pivot.t === 'o') {
          add((at === '.' ? '' : at + ' | ') + 'with_entries(select(.value | ' + deep + '))',
          where + ', at any depth', 'keys', RANK.deep + unnamed);
        } else {
          add((at === '.' ? '.[]' : at + '[]') + ' | select(' + deep + ')',
          where + ', at any depth', 'results', RANK.deep + unnamed);
        }
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

  /* The names jq takes as an object key without quotes, which is the rule
     pathText applies to a path segment. */
  var identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /* The query that turns each result of base into a record holding the lines
     picked out of it. picks are segment lists relative to a result, so one
     query reads the same field out of every one of them, and there has to be
     at least one: an empty pick list is the base query itself.

     A member is named after the key its line sat under, which is the name
     someone picking .metadata.name has in mind. The path is the fallback, and
     is what a second pick under the same key gets.

     quoted writes every name as a string. jq reads a bare name as a key
     unless it is a word the parser wants for itself -- {and: .and} does not
     compile -- and which words those are is the engine's business rather than
     this file's, so a caller that finds the query will not compile asks again
     with quoted set. */
  function project(base, picks, quoted) {
    var used = {}, parts = [], i, path, name;
    for (i = 0; i < picks.length; i++) {
      path = pathText(picks[i]);
      name = keyOf(picks[i]);
      if (name === null || used[name]) name = path.replace(/^\./, '');
      used[name] = true;
      parts.push((quoted || !identRe.test(name) ? quote(name) : name) + ': ' + path);
    }
    return base + ' | {' + parts.join(', ') + '}';
  }

  return { suggest: suggest, project: project };
})();

/* Node loads this file directly to test it; browsers use the global above. */
if (typeof module === 'object' && module.exports) module.exports = jqsuggest;
