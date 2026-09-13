/* Looking up the elements the page template always has. */

/* The element selector matches, as the type the caller needs. The template
   always has it, so a missing element or one of another kind is a broken page,
   and this names the selector rather than failing later at a read on null. */
export function find<T extends Element>(selector: string, type: { prototype: T; new (): T }): T {
  const el = document.querySelector(selector);
  if (!(el instanceof type)) throw new Error('jqweb: ' + selector + ' is not a ' + type.name);
  return el;
}
