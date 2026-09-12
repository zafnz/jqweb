/* The half of the page that reads the search box as a query and shows what one
   produces. --simple leaves it out.

   It is kept apart from page.js because page.js is inlined into every page
   whether or not the engine is, and none of this means anything without it.
   page.js calls jqui() once, with the few things it cannot look up for
   itself, and gets back the entry points it needs. */
var jqui = function (page) {
  'use strict';
  var renderTree = jqweb.renderTree, esc = jqweb.esc, pathText = jqweb.pathText;
  var tree = document.getElementById('tree');
  var results = document.getElementById('results');
  var input = document.getElementById('q');
  var mode = document.getElementById('mode');
  var stats = document.getElementById('stats');

  /* Both of these are meaningless without the engine, so the shell ships them
     hidden and unexplained and they are turned on here. */
  mode.hidden = false;
  input.placeholder = 'Text to find, a path, or a jq query such as .items[] | select(.n > 3)';
  mode.addEventListener('change', function () { input.focus(); page.rerun(); });

  /* The characters a path or a jq expression can start with. In auto mode they
     are what tells a query from plain text, so that typing a word still
     searches the document rather than being run.

     The select offers Auto, Text and jq, all three naming how the box is read
     rather than what happens next; the option value is still "filter", which
     is what the text half of the page has always been called. */
  var QUERY_START = '.[($|';

  /* A name with an argument list after it -- with_entries(...), select(...) --
     which no one types meaning to search for that text. A bare name is left
     alone: "keys" is far more likely to be a search for the word than a call,
     which is what the mode select is for. */
  var CALL = /^[a-z_][a-z0-9_]*\s*\(/;

  /* Whether the box should be read as a query rather than as text to find. */
  function wants(raw) {
    if (mode.value === 'jq') return true;
    if (mode.value !== 'auto') return false;
    return QUERY_START.indexOf(raw.charAt(0)) >= 0 || CALL.test(raw);
  }

  /* The box starts with something in it only when a query was given on the
     command line or in the page's address, and either is a jq query. One that
     auto reads as text, such as keys, starts the select on jq so that it runs
     as one. */
  var start = input.value.trim();
  if (start && !wants(start)) mode.value = 'jq';

  /* Compiles and runs the box as a query. One that only walks down the
     document is shown in place, as a pasted path always has been; anything
     else produces values that are not in the document, so its output replaces
     the view.

     A query still being typed is not run at all: while its trailing name is
     a prefix of keys that are really there, complete() offers those instead
     and the view stays as it was. force is Enter saying run it anyway. */
  function run(raw, force) {
    var query, out;
    clearFault();
    completing = !force && complete(raw);
    if (completing) return;
    showDocument();
    try {
      query = jqjs.compile(raw);
    } catch (e) {
      fault(e.message, e.pos);
      return;
    }
    if (query.path) { page.showFound(page.resolve(query.path), query.path.length); return; }
    try {
      out = query.run(page.value);
    } catch (e) {
      fault(e.message);
      return;
    }
    showResults(out);
  }

  /* Reports a query that would not compile or would not run. The message goes
     under the box: in the toolbar it was a flex item competing with the box for
     room, so a long message made the box narrow while you were still typing in
     it. */
  function fault(message, pos) {
    input.classList.add('bad');
    stats.textContent = '';
    faultBox.textContent = pos === undefined ? message : message + ' (at ' + (pos + 1) + ')';
    faultBox.hidden = false;
    hide();
  }

  /* Takes the message away again, which every path that reaches a result does
     before it says anything. */
  function clearFault() {
    input.classList.remove('bad');
    faultBox.hidden = true;
    faultBox.textContent = '';
  }

  /* Building the markup for a query's whole output is what would stall the
     page, so only this many are rendered; the count still reports them all. */
  var RESULT_CAP = 500;

  /* Shows a query's outputs in place of the document. Each carries its
     position, which the stylesheet puts in the gutter, because a query
     produces a list of values rather than one document; a single value is left
     unnumbered. The document tree is hidden rather than thrown away, so it
     comes back with its collapsed state intact and without being rendered
     again. */
  function showResults(out) {
    var shown = Math.min(out.length, RESULT_CAP), parts = [], i;
    for (i = 0; i < shown; i++) {
      parts.push('<div class="result" data-n="' + i + '">' + renderTree(out[i]) + '</div>');
    }
    results.innerHTML = parts.join('');
    results.classList.toggle('one', out.length === 1);
    results.hidden = false;
    tree.hidden = true;
    stats.textContent = shown < out.length
      ? 'first ' + shown + ' of ' + plural(out.length, 'result')
      : describe(out);
  }

  /* What a query returned. A single object or array is one result, but how
     much is inside it is the interesting number -- and it is the one the
     suggestion list counted, so saying only "1 result" would contradict the
     row that was just picked. */
  function describe(out) {
    if (out.length !== 1) return plural(out.length, 'result');
    if (out[0].t === 'o') return '1 result, ' + plural(out[0].k.length, 'key');
    if (out[0].t === 'a') return '1 result, ' + plural(out[0].v.length, 'item');
    return '1 result';
  }

  function plural(n, noun) { return n + ' ' + noun + (n === 1 ? '' : 's'); }

  /* Puts the document back. Without the engine nothing ever replaces it, so
     page.js only has this to call when there is a jqui at all. */
  function showDocument() {
    if (results.hidden) return;
    results.hidden = true;
    results.innerHTML = '';
    tree.hidden = false;
  }

  /* ---- the suggestion list ----

     Two things fill it. The filter button on a line does not know which query
     you meant, so it offers the ones it can build from that line, runs each,
     and labels it with what came back. Picking by outcome is the point: 14
     results against 1 says which reading you were after without anyone having
     to think about pivots. And typing a name one letter at a time fills it
     with the keys that could finish the name, through complete() below.

     The list belongs to the search box rather than to whatever filled it, so
     it comes back when the box is focused again and goes away when attention
     moves elsewhere. */

  var suggestions = document.getElementById('suggest');
  var faultBox = document.getElementById('fault');
  var rows = [];

  /* Running every candidate against a large document could take longer than
     anyone will wait for a menu, so counting stops after this and the rest of
     the rows are offered without one. */
  var COUNT_BUDGET_MS = 300;

  /* Builds the list for one line of the document, puts the widest reading in
     the box, and runs it. */
  function filter(node) {
    var segs = page.segsOf(node);
    var deadline = Date.now() + COUNT_BUDGET_MS;
    rows = jqsuggest.suggest(page.value, segs).map(function (c) {
      c.count = Date.now() > deadline ? null : count(c);
      return c;
    }).filter(function (c) {
      return c.count !== 0;
    });
    /* Most results first, which is what "the others like this one" means, and
       between readings that return the same number the one that reads best.
       A row left uncounted keeps its place at the end. */
    rows.sort(function (a, b) {
      var an = a.count === null ? -1 : a.count, bn = b.count === null ? -1 : b.count;
      return an === bn ? a.rank - b.rank : bn - an;
    });
    /* Nothing on the list narrowing anything means every reading found the one
       line that was clicked, and then the line itself is what was meant --
       where it otherwise sorts last, being the least general reading. */
    var narrows = false, i;
    for (i = 0; i < rows.length; i++) if (rows[i].count > 1) narrows = true;
    if (!narrows) {
      for (i = 1; i < rows.length; i++) {
        if (rows[i].plain) {
          rows.unshift(rows.splice(i, 1)[0]);
          break;
        }
      }
    }
    draw();
    if (rows.length) pick(0);
    show();
  }

  /* How much one candidate returns, or null if it will not run at all. What to
     count depends on the query rather than on its output: with_entries hands
     back a single object and the answer is how many members it kept. */
  function count(c) {
    var out;
    try {
      out = jqjs.compile(c.q).run(page.value);
    } catch (e) {
      if (e.jq) return 0;
      throw e;
    }
    if (c.shape !== 'keys') return out.length;
    return out.length && out[0].t === 'o' ? out[0].k.length : 0;
  }

  function label(c) {
    if (c.label !== undefined) return c.label;
    return c.count === null ? '' : plural(c.count, c.shape === 'keys' ? 'key' : 'result');
  }

  /* ---- completing a half-typed name ----

     jq reads a missing key as null, so ".items[].ki" run as written is one
     null per item while the "nd" of "kind" is still to come. Instead, the
     query up to the trailing name is run, and while that name is a prefix of
     keys its output really has, those go on the list and nothing else moves:
     the view keeps showing whatever last ran. A name that matches a whole key
     runs -- ".items[].kind" behaves as it always did -- and one that no key
     starts with runs too, nulls and all. */
  var completing = false;

  /* Offers completions for raw instead of running it, when there are any.
     True means it did and the caller has nothing to run. */
  function complete(raw) {
    var split = jqsuggest.splitPartial(raw), out, comp;
    if (!split) return false;
    try {
      out = jqjs.compile(split.ctx).run(page.value);
    } catch (e) {
      return false;
    }
    comp = jqsuggest.completions(out, split.partial);
    if (comp.exact || !comp.keys.length) return false;
    rows = comp.keys.map(function (k) {
      /* pathText writes the segment as jq would -- .name, or ["a b"] for a
         key that needs quoting, whose leading dot goes when it is a suffix. */
      var seg = pathText([{ key: k.key }]);
      return {
        q: split.lead ? split.lead + seg.replace(/^\.\[/, '[') : seg,
        label: k.n === comp.objects ? '' : 'on ' + k.n + ' of ' + comp.objects,
        count: null
      };
    });
    draw();
    show();
    return true;
  }

  function draw() {
    var parts = [], i;
    for (i = 0; i < rows.length; i++) {
      parts.push('<div class="sg"><button class="sgq" type="button">' +
        '<span class="sgt">' + esc(rows[i].q) + '</span>' +
        '<span class="sgn">' + esc(label(rows[i])) + '</span></button>' +
        '<button class="sgc" type="button" title="Copy this query">&#x29C9;</button></div>');
    }
    suggestions.innerHTML = parts.join('');
  }

  /* Highlights the row the box is holding. Nothing else can put text there
     that matches a row -- typing drops the list -- so it is the row that was
     picked rather than whatever happens to match. */
  function mark(at) {
    var kids = suggestions.children, i;
    for (i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i === at);
  }

  function show() {
    if (rows.length && faultBox.hidden) suggestions.hidden = false;
  }
  function hide() { suggestions.hidden = true; }

  /* Put the list away and drop what was in it. */
  function forget() {
    rows = [];
    suggestions.innerHTML = '';
    hide();
  }

  /* Picking a row leaves the list open: trying the next one is the whole
     reason there is a list.

     It runs the query itself rather than going back through the box, because
     every row is a query by construction and nothing about it should depend on
     what the mode select would have guessed. */
  function pick(i) {
    input.value = rows[i].q;
    mark(i);
    run(rows[i].q);
  }

  suggestions.addEventListener('click', function (e) {
    var row = e.target.closest('.sg');
    if (!row) return;
    var i = Array.prototype.indexOf.call(suggestions.children, row);
    if (e.target.closest('.sgc')) { page.copy(rows[i].q, e.target.closest('.sgc')); return; }
    pick(i);
    input.focus();
  });

  input.addEventListener('focus', show);

  /* Typing anything is done with the list. It offered readings of one line of
     the document, and the moment the text stops being one of them it is
     answering a question that is no longer being asked -- so the rows go, and
     focusing the box brings nothing back.

     Only a person typing gets here: filling the box from a row sets the value
     directly, which fires nothing. Escape is the one way to put the list away
     and still get it back. */
  input.addEventListener('input', function () {
    forget();
  });

  /* Up and down step through the readings, running each, which is the quick
     way to find out which one you meant. Escape puts the list away without
     clearing the box, which is what Escape does when there is no list.
     Enter runs a half-typed name as written, which nothing does for you
     while complete() is holding the run back. */
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !suggestions.hidden) {
      hide();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && completing) {
      hide();
      run(input.value.trim(), true);
      return;
    }
    if (suggestions.hidden || !rows.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    var at = -1, i;
    for (i = 0; i < rows.length; i++) if (rows[i].q === input.value.trim()) at = i;
    at = e.key === 'ArrowDown' ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
    pick(at);
  });

  /* Anywhere else in the page puts it away. mousedown rather than click, so it
     is gone before whatever was clicked responds. */
  document.addEventListener('mousedown', function (e) {
    if (!suggestions.contains(e.target) && e.target !== input) hide();
  });

  return {
    wants: wants,
    run: run,
    filter: filter,
    clearFault: clearFault,
    showDocument: showDocument
  };
};
