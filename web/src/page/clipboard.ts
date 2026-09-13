/* Copying text for a button, and showing on the button whether it worked. */

/* Copies text, reporting the outcome on the button that asked for it. */
export function copy(text: string, btn: Element): void {
  copyText(text, function (ok) { flash(btn, ok); });
}

/* Copies text, calling done(ok) when it settles. The clipboard API needs a
   secure context, which a page opened from a file:// URL is not, and can
   still be refused when it is available, so both paths fall back. */
function copyText(t: string, done: (ok: boolean) => void): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(
      function () { done(true); },
      function () { done(legacyCopy(t)); });
  } else {
    done(legacyCopy(t));
  }
}

/* The pre-clipboard-API copy: put the text in an off-screen textarea,
   select it, and have the document copy the selection. Deprecated, but it
   is what works without a secure context. */
function legacyCopy(t: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

/* The buttons mid-flash: what each showed before, and the timer that puts it
   back. A second copy from the same button before the first has settled
   restarts the timer rather than taking the tick for the thing to restore. */
const flashing = new WeakMap<Element, { text: string | null; timer: ReturnType<typeof setTimeout> }>();

/* Briefly turns a button into a tick or a cross, then restores what it
   showed. */
function flash(btn: Element, ok: boolean): void {
  const was = flashing.get(btn);
  if (was) clearTimeout(was.timer);
  const text = was ? was.text : btn.textContent;
  btn.classList.remove('ok', 'fail');
  btn.classList.add(ok ? 'ok' : 'fail');
  btn.textContent = ok ? '✓' : '✗';
  const timer = setTimeout(function () {
    btn.classList.remove('ok', 'fail');
    btn.textContent = text;
    flashing.delete(btn);
  }, 900);
  flashing.set(btn, { text: text, timer: timer });
}
