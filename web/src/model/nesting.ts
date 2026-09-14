import type { Node } from './node.ts';

/* A JSON level adds two HTML wrappers. This leaves room below browsers'
   HTML nesting limits as well as their call stacks. Keep in sync with
   internal/check/check.go. */
export const MAX_DEPTH = 128;

export class NestingError extends Error {
  constructor() { super('JSON nesting exceeds the supported limit of ' + MAX_DEPTH); }
}

export function checkDepth(depth: number): void {
  if (depth > MAX_DEPTH) throw new NestingError();
}

/* Nodes are not mutated after construction. Remember subtree depths so a
   query wrapping or reusing a value need not walk its descendants again. */
const depths = new WeakMap<Node, number>();

export function checkNesting<T extends Node>(node: T): T {
  depthOf(node, 0);
  return node;
}

function depthOf(node: Node, parents: number): number {
  if (node.t === 'l') return 0;
  checkDepth(parents + 1);
  let depth = depths.get(node);
  if (depth === undefined) {
    depth = 1;
    for (const child of node.v) depth = Math.max(depth, 1 + depthOf(child, parents + 1));
    depths.set(node, depth);
  }
  checkDepth(parents + depth);
  return depth;
}
