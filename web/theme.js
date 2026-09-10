/* Which of the two palettes the page paints in.

   This runs in the head, before the body is parsed, so a page never shows one
   theme and then swaps to the other. The preference is auto, light or dark:
   auto follows the operating system and keeps following it as it changes, the
   other two do not. --theme sets what a page starts with; the button in the
   toolbar changes it afterwards.

   Where the page can store the choice it outlasts a reload. A page opened from
   a file:// URL may have no storage at all, and then the choice lasts as long
   as the tab, which is why every use of it is guarded. */
var jqtheme = (function () {
  'use strict';
  var KEY = 'jqweb-theme';
  var ORDER = ['auto', 'light', 'dark'];
  var root = document.documentElement;
  var light = window.matchMedia('(prefers-color-scheme: light)');
  var pref = root.getAttribute('data-pref') || 'auto';

  try {
    pref = localStorage.getItem(KEY) || pref;
  } catch (e) { /* no storage here, so the flag stands */ }
  if (ORDER.indexOf(pref) < 0) pref = 'auto';

  /* data-theme is the palette in force and what the stylesheet reads;
     data-pref is what was asked for, which the button reports. */
  function paint() {
    root.setAttribute('data-theme', pref === 'auto' ? (light.matches ? 'light' : 'dark') : pref);
    root.setAttribute('data-pref', pref);
  }

  function cycle() {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    try {
      localStorage.setItem(KEY, pref);
    } catch (e) { /* as above: this one only lasts as long as the tab */ }
    paint();
    return pref;
  }

  /* Following the system means following it while the page is open. */
  if (light.addEventListener) {
    light.addEventListener('change', function () { if (pref === 'auto') paint(); });
  }
  paint();

  return { cycle: cycle, current: function () { return pref; } };
})();
