/* page: light

   --theme sets what a page starts with. This is the same page as theme.js
   drives, rendered with --theme light, so the only thing it can say is
   whether the flag reaches the browser. */
T.run(async (t) => {
  const root = document.documentElement;

  t.eq('the flag is written into the page', root.getAttribute('data-pref'), 'light');
  t.eq('and is what jqtheme starts from', jqtheme.current(), 'light');
  t.eq('so the page paints light', root.getAttribute('data-theme'), 'light');
  t.eq('and the button says which', t.text('#theme'), '☀');

  /* Painting light means the light palette, not merely the attribute. */
  t.atLeast('the background is a light one',
    t.ratio(t.rgba(getComputedStyle(document.body).backgroundColor), [0, 0, 0, 1]), 15);
  t.atLeast('with dark text on it', t.contrast(t.$('#tree .num')), 4.5);

  /* The flag says where to start, not where to stay. */
  await t.click(t.$('#theme'));
  t.eq('the button still moves off it', jqtheme.current(), 'dark');
  t.eq('and the page follows', root.getAttribute('data-theme'), 'dark');
});
