# jqweb frontend and TypeScript migration plan

> Review draft. This file collects the current plan for discussion. It is not
> intended to become permanent project documentation in its present form.
> Durable build instructions belong in `CONTRIBUTING.md`; architectural rules
> that prevent future mistakes belong in `CLAUDE.md`; the reasoning for each
> stage belongs in that stage's pull request description.

## Status

Issue: [#34, Switch to typescript](https://github.com/zafnz/jqweb/issues/34)

Current stage: [PR #53, Compile page scripts into committed bundles](https://github.com/zafnz/jqweb/pull/53)

PR #53 establishes the build boundary described below. It intentionally does
not reorganize or convert the existing JavaScript.

## Goals

The migration should leave jqweb with:

- reasonably sized TypeScript modules with explicit imports and exports;
- source boundaries that match the value model, page UI, query UI, suggestion
  logic, and jq engine rather than a few large global scripts;
- distinct `theme.js`, `simple.js`, and `full.js` production outputs;
- a genuinely independent `--simple` build that cannot accidentally acquire
  the jq engine through source ordering or a shared runtime chunk;
- deterministic, minified output committed for Go to embed;
- useful unit and browser coverage around every structural change;
- no Node, npm, or browser requirement for people installing or running
  jqweb;
- no network requirement for a generated page;
- no change to the JSON value model, jq behavior, key order, number spelling,
  or visible UI unless a separate PR explicitly sets out to make one.

The migration is primarily about maintainability. The smaller output is a
useful consequence, not permission to trade correctness for bytes.

## Constraints that remain non-negotiable

### Installation remains Go-only

These must continue to work without Node or `node_modules`:

```sh
go install github.com/zafnz/jqweb@latest
go build .
```

That also preserves existing downstream Dockerfiles:

```dockerfile
FROM golang:1.24 AS build
RUN go install github.com/zafnz/jqweb@latest
```

The exact Go image and final copy path vary by consumer, but the important
property is that their build does not acquire a Node stage merely because the
jqweb sources are authored in TypeScript.

### Generated pages remain self-contained

The browser must not fetch code, styles, fonts, images, source maps, or shared
chunks. The output remains one HTML file that works from `file://` and with no
network.

### The value model does not get normalized into JavaScript values

The following representation remains load-bearing:

```text
{t:'o', k:[keys], v:[children]}
{t:'a', v:[children]}
{t:'l', r:<scalar>, n:<number as written>, h:<rendered html>}
```

It preserves object order, duplicate keys, and the exact spelling of numbers.
The jq engine consumes and produces the same nodes so results can be rendered
without reparsing or losing those properties.

### `simple` and `full` are separate products

They may share source modules, but they must be independently bundled. Runtime
code splitting would create additional files and break the single-file output,
so shared code is deliberately duplicated between the two bundles.

### Refactors and behavior changes stay separate

Moving, splitting, importing, typing, and minifying code already create large
reviews. A stage should not also redesign behavior unless that behavior has its
own issue, tests, rationale, and PR.

## Installation and distribution options

The need to compile TypeScript creates several possible installation models.
Only one preserves all current installation paths.

| option | advantages | costs | decision |
|---|---|---|---|
| Commit compiled scripts and embed them from Go | `go install`, source builds, cross-compilation, and existing Dockerfiles keep working | generated diffs must be committed and verified | **Chosen** |
| Build the frontend from Go with `go generate` | one documented generation command | `go install` does not run `go generate`; users would still receive missing or stale assets | Rejected |
| Require Node during `go build` | output always comes directly from source | Go has no normal package hook for this; it breaks Go-only installs and downstream builders | Rejected |
| Stop supporting `go install` and distribute release binaries only | no generated frontend in source | changes a well-used installation path and complicates version/platform selection in Dockerfiles | Rejected |
| Require source-building Docker users to add a Node stage | avoids committed output | every downstream user inherits jqweb's authoring toolchain | Rejected |
| Implement or vendor a TypeScript compiler in Go | superficially keeps one toolchain | large, unnecessary maintenance burden and still complicates reproducibility | Rejected |

If committed output were ever abandoned, the two realistic replacements would
be downloading the correct release archive or cloning a tagged source tree and
running Node before Go in a multi-stage build. Neither is as simple or as
compatible as retaining `go install`, so they are fallback options rather than
the plan.

## npm footprint

npm is used as a development tool, not an application dependency. Its files
stay under `web/`:

```text
web/
  package.json
  package-lock.json
  tsconfig.json
  build.mjs
  node_modules/       # ignored, local only
```

There is no root `package.json`, root `node_modules`, npm workspace, frontend
framework, or runtime package loader. At the repository root the build rigging
only needs the existing Go changes plus `.gitignore` and `.gitattributes`
entries.

Node 24.12 or later is the frontend development baseline. It is not an install
or runtime requirement for jqweb users.

### Why keep `package.json` and the lockfile

Running globally installed `tsc` and `esbuild`, or fetching floating versions
with `npx`, would avoid two small files but make generated output depend on the
developer's machine and the day on which it was built. The manifest provides
named commands; the lockfile makes the compiler and bundler reproducible.

The lockfile is therefore part of the generated-output trust model, not npm
baggage added for its own sake.

## Tool choices

### Package manager: npm

npm is already supplied with Node, is understood by GitHub Actions, and needs
no additional bootstrap tool. `npm --prefix web ...` keeps the frontend scope
visible in every command.

Alternatives such as pnpm or Yarn may offer workspace or large-monorepo
advantages, but jqweb has one small frontend package and would not use those
advantages.

### Type checker: TypeScript

`tsc --noEmit` owns type checking. It does not produce the files Go embeds.
This keeps type semantics independent from production bundling and prevents two
tools from competing to write output.

During migration:

- `allowJs` remains enabled;
- JavaScript and TypeScript may coexist;
- `erasableSyntaxOnly` prevents source syntax that Node cannot execute by
  stripping types;
- `verbatimModuleSyntax` makes type-only imports explicit;
- `strict` applies to converted TypeScript;
- temporary boundary types are acceptable when they isolate unconverted code;
- `any` should be a local escape hatch, not the representation of the value
  model or jq streams.

At the end:

- application sources under `web/src` are TypeScript;
- `allowJs` can be removed or disabled for application code;
- `tsc --noEmit` succeeds with strict checking;
- esbuild remains the only production emitter.

### Bundler and minifier: esbuild

esbuild can consume the present JavaScript and the eventual TypeScript, bundle
ES modules, target the supported browser level, remove comments, and minify the
three classic scripts.

The alternatives are less well matched:

| tool | issue for jqweb |
|---|---|
| `tsc` alone | transpiles but does not provide the desired bundling and minification workflow |
| Rollup | capable, but adds more configuration and plugin choices than these three entry points need |
| Vite | optimized around an application/dev-server workflow jqweb does not have |
| hand-written concatenation forever | preserves implicit global ordering and blocks useful module boundaries |

The eventual esbuild build should use three entry points, bundling enabled,
runtime splitting disabled, browser platform, the agreed browser target, and a
classic self-contained output format such as an IIFE. The source can use ES
modules without making the generated page load modules from separate files.

### Unit tests: Node's built-in test runner

There is no immediate reason to add Jest or Vitest. The existing DOM-free tests
are fast and expressive enough.

Node 24.12 has stable native TypeScript stripping, and its test runner discovers
`.test.ts` files directly. Unit tests will therefore continue to run with:

```sh
npm --prefix web test
```

That command is `node --test`; there is no test compiler, `tsx`, Jest or Vitest.
`tsc --noEmit` performs type checking separately. Because Node ignores
`tsconfig.json` while executing TypeScript, source run by the test runner must
use erasable syntax, explicit `.ts` import extensions and explicit `import type`
where needed. PR 3 must prove this path with a small TypeScript test before PR 4
starts converting application modules.

### Browser tests: Playwright Test

Now that a frontend package and lockfile exist, avoiding a browser automation
dependency is no longer valuable enough to justify maintaining the custom
Chrome process protocol.

Playwright should replace that protocol in its own PR. The initial migration
should:

- use the existing system Google Chrome with `channel: "chrome"`;
- avoid downloading Playwright's bundled browsers at first;
- preserve the default, simple, light, narrow, phone, and committed-docs cases;
- preserve the path lookup and contrast helpers;
- map every existing named check to an equivalent assertion;
- use isolated browser contexts rather than hand-made Chrome profiles;
- use Playwright clock control for debounce and copy-state timers;
- retain traces and screenshots on failure;
- keep retries disabled initially so a flaky test remains visible;
- continue to load generated pages offline, preferably using the current
  `file://` model.

The system Chrome version follows the `ubuntu-latest` runner image. A runner
update can therefore make an unrelated PR red; that already happens with the
current Chrome runner and is the accepted price of testing the current stable
browser. The first such failure is investigated as a browser-version change,
not evidence that the Playwright port failed, and retries are not enabled to
hide it. If runner-driven failures become recurrent, the alternative is to pin
Playwright's bundled Chromium and accept its download cost.

Bundled Chromium, Firefox, and WebKit are later options. They should be added
only when the additional download and CI cost buys coverage the project wants.
Cross-browser support is an available benefit, not a prerequisite for the
TypeScript migration.

Puppeteer would remove some process plumbing, but Playwright Test provides the
test isolation, assertions, projects, clock controls, failure artifacts, and
multi-browser path together.

## Production outputs

The production boundary is:

```text
TypeScript/JavaScript source
          |
          v
      web/build.mjs
          |
          +--> web/dist/theme.js
          +--> web/dist/simple.js
          +--> web/dist/full.js
                       |
                       v
                  Go embed.FS
                       |
                       v
             one self-contained HTML file
```

### `theme.js`

This is separate because it runs in `<head>` before the body is parsed. It
chooses the palette soon enough to avoid painting the wrong theme first. It
must not import page startup code or anything that expects body elements.

### `simple.js`

This contains the value model, parser, renderer, paths, tree UI, text search,
copying, folding, and theme button. It must not import the jq engine,
suggestions, or query UI.

### `full.js`

This contains everything in the simple experience plus the jq engine,
suggestion logic, and query UI. `full` is clearer than `normal`: it describes
what is included without implying that `--simple` is abnormal.

### CSS

CSS remains as `page.css` and `query.css` initially. A CSS build would add
scope without helping the TypeScript migration. The existing Go selection of
base and query styles already gives `--simple` the correct CSS boundary.

CSS minification can be evaluated later as an independent, measured change.

## Generated-file policy

Only production output is committed:

```text
web/dist/theme.js
web/dist/simple.js
web/dist/full.js
docs/index.html
```

The source is the reviewable representation. Committing both pretty-printed
and minified generated JavaScript would double generated churn without making
the authored change easier to understand, so only minified bundles are kept.

Generated files are marked with `linguist-generated` in `.gitattributes`. A
reviewer can hide them on GitHub, while CI still proves that the committed
bytes were produced by the pinned toolchain.

Every source change must leave these checks clean:

```sh
npm --prefix web run check
npm --prefix web run build
git diff --exit-code -- web/dist
```

Changes under `web/` that affect output also require regenerating
`docs/index.html`. CI renders it independently and compares the result.

Source maps should not be embedded in production output. If they prove useful
for local debugging, they should be temporary build artifacts or CI failure
artifacts rather than extra files shipped inside every jqweb page.

## Current transitional layout

PR #53 creates this intermediate state:

```text
web/
  build.mjs
  package.json
  package-lock.json
  tsconfig.json
  page.html

  theme.js
  core.js
  page.js
  jq.js
  suggest.js
  query.js

  page.css
  query.css
  page.html

  dist/
    theme.js
    simple.js
    full.js

  browser-test/
  testdata/
```

`build.mjs` currently concatenates the source files in their established order
and asks esbuild to transform and minify them. That is intentionally temporary:
it changes the build and embedding boundary without changing application code.

## Proposed end-state layout

There are three broad layout choices:

| layout | advantage | problem | decision |
|---|---|---|---|
| Keep a flat `src/` with one module per current file | smallest initial rename | retains the large files and makes ownership less clear | useful only as a transition |
| Group modules by responsibility | imports reveal the boundaries between model, page, and query code | requires judgment about where helpers belong | **Recommended end state** |
| Split into very small utility modules | each file appears simple | navigation and dependency overhead can exceed the code being organized | Rejected as a goal |

The exact split should follow the dependencies found during conversion rather
than forcing every name below, but this is the intended shape:

```text
web/
  build.mjs
  package.json
  package-lock.json
  tsconfig.json

  src/
    entries/
      theme.ts
      simple.ts
      full.ts

    model/
      node.ts
      parse.ts
      render.ts
      path.ts

    page/
      bootstrap.ts
      tree.ts
      filter.ts
      folding.ts
      clipboard.ts
      theme.ts

    query/
      engine/
        index.ts
        lexer.ts
        parser.ts
        evaluate.ts
        builtins.ts
      suggest.ts
      ui.ts

  styles/
    page.css
    query.css

  test/
    unit/
    browser/
    testdata/

  dist/
    theme.js
    simple.js
    full.js
```

This layout is a direction, not a quota for tiny files. A module should own a
coherent responsibility or enforce a useful dependency boundary. Splitting a
ten-line helper into its own file merely to match this tree would make the code
harder to navigate.

### Mapping from present files

| current file | likely destination |
|---|---|
| `page.html` | remains `web/page.html`; it is a Go-consumed template rather than a TypeScript build input |
| `theme.js` | `entries/theme.ts` plus reusable preference/palette code in `page/theme.ts` |
| `core.js` | the node types, parser, renderer, and path modules under `model/` |
| `page.js` | bootstrap, tree DOM, filtering, folding, clipboard, and theme control under `page/` |
| `jq.js` | query engine modules; initially it may remain one imported module before being split |
| `suggest.js` | `query/suggest.ts` |
| `query.js` | `query/ui.ts` and any small UI-specific helpers |

### Entry-point rules

`entries/theme.ts` imports only early theme initialization.

`entries/simple.ts` imports the model and ordinary page bootstrap. Nothing
reachable from this entry may import from `query/`.

`entries/full.ts` imports the same ordinary page bootstrap, then wires in the
query engine, suggestions, and query UI explicitly.

The page layer should receive query behavior through an interface or callback,
not discover a global `jqui` function. This turns the current optional-global
relationship into an explicit entry-point decision.

## Conversion-order options

The source can be reorganized and converted in several orders:

| strategy | advantage | cost |
|---|---|---|
| Rename the present large files to TypeScript, then split them | reaches an all-TypeScript headline quickly | asks TypeScript to describe poor boundaries and leaves the largest reviews until later |
| Fully split the JavaScript, then convert every module | each structural PR can be behavior-only | moves most code twice and creates repetitive generated churn |
| Establish a minimal JavaScript module graph, then split and convert one subsystem at a time | validates entry points first while avoiding a second full-tree move | later subsystem PRs contain both a focused split and focused typing |

The third, hybrid strategy is recommended. PR 3 establishes entry points and
explicit imports without attempting the final fine-grained layout. Later PRs
can then split and type one coherent area at a time, with the core value model
first and the jq engine last.

The Playwright migration belongs before those application conversions. Doing
it after the refactor would leave the custom runner in place during the riskiest
work; doing it in the same PR would make a failure ambiguous. A separate
preparatory PR gives later stages better diagnostics without mixing test-runner
and application changes.

## Important TypeScript types

The first types should describe stable domain boundaries rather than every
local variable:

- `ObjectNode`, `ArrayNode`, `LeafNode`, and their `Node` union;
- the raw scalar and exact-number fields on a leaf;
- path segments and resolved paths;
- rendered query results and their optional source paths;
- a jq stream, which remains an array of nodes;
- the function shape for an expression that maps one input to many outputs;
- query errors with their source position;
- the small interface through which page startup enables full query behavior.

Discriminated unions should make `t: "o" | "a" | "l"` do useful narrowing.
Typing must preserve the difference between a computed number and its original
written representation.

DOM lookup helpers should either prove the expected element type or fail with
a useful message. Scattering non-null assertions and casts across the UI would
silence TypeScript without improving the design.

## Pull-request stages

Each stage should merge before the next is based on `main`. That keeps PRs
linear and avoids asking reviewers to understand stacked generated diffs.

### PR 1 — Build and embedding boundary

Status: open as PR #53.

Scope:

- add the package manifest, lockfile, Node 24.12 baseline, TypeScript
  configuration, and esbuild;
- generate committed `theme`, `simple`, and `full` bundles;
- embed those bundles from Go;
- remove the Go comment stripper, `TestStripComments`,
  `TestStripCommentsIsIdempotent`, and `TestPageShipsWithoutComments`;
- remove the obsolete source rule about comments on lines containing `/`, but
  retain `TestPageCarriesNoComments` and the no-CSS-comments rule because CSS
  remains inlined as written;
- add `TestCompiledScriptsCannotCloseTheirElements` over all three generated
  bundles;
- verify generated bundles and the docs page in CI and release jobs;
- mark generated files for review tooling;
- leave all application JavaScript unchanged.

Acceptance:

- Go, Node, and all browser checks pass;
- rebuilding produces no diff;
- the committed docs page matches a fresh render;
- an archive containing no `node_modules` builds with Go alone;
- `--simple` contains the simple bundle and not the full bundle;
- no compiled script can close its containing `<script>` element;
- output generated by esbuild on macOS ARM64 is reproduced byte for byte by
  the pinned Linux x64 binary in CI.

Issue wording: `Part of #34`, because this does not finish the migration.

### PR 2 — Replace the custom Chrome protocol with Playwright

Scope:

- add Playwright Test as a pinned development dependency;
- port browser setup, page generation, viewports, actions, and assertions;
- retain the custom path and contrast helpers where they add domain value;
- rewrite `web/browser-test/README.md` and the corresponding `CLAUDE.md`
  guidance for the new runner;
- capture useful traces and screenshots on failure;
- run against system Chrome first;
- delete the old process, profile, `--dump-dom`, polling, and report-extraction
  machinery only after coverage is equivalent.

Acceptance:

- every current driver scenario and named assertion has an equivalent;
- default, simple, light, narrow, phone, and committed-docs behavior remains
  covered;
- local focused runs remain easy;
- CI failure artifacts are more useful than the current injected pages;
- the browser still makes no network request for application resources;
- no retry is needed for a green suite.

Issue wording: `Part of #34` if treated as migration preparation. It should not
claim to close the TypeScript issue.

### PR 3 — Introduce explicit JavaScript modules and entry points

Scope:

- move application sources under `web/src`;
- add `entries/theme.js`, `entries/simple.js`, and `entries/full.js`;
- convert the current CommonJS unit tests to ESM and mark the package as a
  module, so later `.test.ts` files and browser-source modules use the same
  import rules;
- replace concatenation and source ordering with imports and exports;
- switch `build.mjs` from transform-on-concatenated-text to bundling entry
  points;
- preserve the present large-file boundaries initially;
- replace the optional global query hook with explicit full-entry wiring.

This stage answers whether the module graph is correct before type errors and
large file splits enter the review.

Acceptance:

- all behavior and coverage remain unchanged;
- simple has no query-engine module in its esbuild dependency graph;
- all three outputs remain classic, self-contained scripts;
- a small `.test.ts` imports TypeScript directly and passes under
  `npm --prefix web test` on Node 24.12, with no test compiler or execution
  helper;
- output and rendered-page sizes are measured against PR #53;
- rebuilding and docs verification remain deterministic.

Issue wording: `Part of #34`.

### PR 4 — Convert and split the value model and core functions

Scope:

- define the discriminated node types;
- split parsing, rendering, escaping, and paths into coherent modules;
- convert those modules and their unit tests to TypeScript;
- preserve exact number text, duplicate keys, key order, escaping, and path
  round-trips.

This is the best first application conversion because it is DOM-free, has
strong unit coverage, and defines types every later layer consumes.

Acceptance:

- the current core unit cases still pass against the converted source;
- public module boundaries contain no broad `any` types;
- the browser suites pass for both simple and full pages;
- source and rendered sizes are reported, not assumed.

Issue wording: `Part of #34`.

### PR 5 — Convert and split the ordinary page UI

Scope:

- convert tree construction, filtering, path lookup, folding, copying, and
  theme controls;
- split DOM responsibilities where the present `page.js` has a real boundary;
- keep page bootstrap small;
- type DOM elements and events at helper boundaries;
- retain the phone breakpoint behavior in both CSS and TypeScript.

Acceptance:

- the simple page works with the query layer completely absent;
- simple, tree, search, scroll, phone, narrow, theme, contrast, and toolbar
  browser coverage passes;
- no query import is reachable from the simple entry point.

Issue wording: `Part of #34`.

### PR 6 — Convert suggestions and query UI

Scope:

- convert suggestion generation and partial-query completion;
- convert the mode selector, query input, results view, suggestion list, and
  error display;
- define the interface between the UI and jq engine without splitting the
  engine itself yet.

Acceptance:

- suggestion unit cases and all query-oriented browser cases pass;
- auto, text, path, and jq modes retain their current selection rules;
- the simple bundle remains unchanged except for shared code changes that are
  explicitly explained;
- before PR 7 begins, its description records whether the jq engine will be
  converted before it is split or split before it is converted, with a small
  spike and corpus, type-friction, reviewability, size, and performance evidence
  supporting the choice.

Issue wording: `Part of #34`.

### PR 7 — Convert and split the jq engine

The jq engine is the largest and most semantically sensitive file. It may need
more than one PR, for example:

1. introduce engine types and convert the existing file with minimal movement;
2. split scanning/parsing from evaluation;
3. split builtins once their shared rules are visible.

Splitting first and typing first have opposite review advantages. The decision
should be made after the model and query interfaces exist; it should not be
forced now.

Acceptance for every engine PR:

- every corpus case agrees with real jq;
- the corpus still exercises every builtin;
- stream order, errors, paths, limits, and exact-number behavior remain
  covered;
- no evaluator change creates an endless stream;
- performance and full-bundle size are measured against the previous stage.

Issue wording: `Part of #34` until the engine and remaining application source
are fully converted.

### Final PR — Remove migration allowances

Scope:

- remove application `allowJs` and temporary declarations or adapters;
- remove obsolete source files and globals;
- ensure the build has only the three intentional entry points;
- simplify scripts and CI that were transitional;
- update the short permanent architecture and contributor instructions;
- record final size and performance comparisons.

Acceptance:

- all application source is TypeScript;
- strict type checking passes without migration exclusions;
- Go-only installation and Docker behavior are unchanged;
- all unit, corpus, browser, generated-file, docs, and release checks pass;
- `simple` is demonstrably free of the jq/query graph;
- generated pages remain offline and self-contained.

Issue wording: `Closes #34` only here, once no required conversion work remains.

## Stop and rollback criteria

Acceptance criteria say what a stage must prove before merging. The migration
also needs an agreed answer when a stage cannot prove it. A stage stops and is
reverted, split smaller, or redesigned rather than pushed through when any of
the following remains unexplained:

- the pinned esbuild version produces different committed bytes on supported
  development and CI platforms;
- the Playwright suite needs retries to stay green, loses a current assertion,
  or produces less useful evidence than the runner it replaces;
- the module graph pulls jq or query code into `simple`, or `simple` grows for
  a reason the entry-point graph cannot account for;
- a movement, module, or typing stage changes observable behavior despite
  being scoped as mechanical;
- a TypeScript boundary needs broad `any`, repeated assertions, or weakened
  strictness merely to make the stage compile;
- any jq corpus case disagrees with real jq and the difference cannot be shown
  to be a defect in the existing fixture;
- page size, startup, interaction time, or suite duration regresses materially
  without a measured cause and an explicitly accepted tradeoff;
- Go-only installation, offline pages, generated-file reproduction, or docs
  reproduction stops working.

Stopping a stage does not abandon #34. It means keeping the last green boundary
and changing the next step. A failed Playwright port leaves the current runner
in place; a failed module split returns to the previous entry graph; a jq
disagreement returns to the last corpus-clean engine. Any intentional behavior
change or accepted regression moves to its own issue and PR rather than being
smuggled through as migration work.

## Review strategy

For each PR:

- explain the reason and tradeoffs in the PR description, not the changelog or
  commit message;
- state what the stage deliberately does not change;
- link #34, using a closing keyword only on the final stage;
- show authored files separately from generated output;
- use GitHub's generated-file hiding for `web/dist` and `docs/index.html`;
- report source, embedded-script, full-page, and relevant performance
  measurements when they change;
- list the exact test results;
- avoid combining a behavior fix unless it is required to make the mechanical
  migration correct and is called out explicitly.

Generated code should normally be produced in the same commit as the source
that creates it. A separate generated commit can make one unusual PR easier to
inspect, but should not become a rule that complicates rebases or allows source
and output to diverge.

## Baseline measurements from PR #53

The raw source column is unminified input. The `main` column is what the former
Go comment stripper embedded. The generated column is the committed esbuild
output.

| bundle | raw source | embedded on `main` | generated in PR #53 | change from `main` |
|---|---:|---:|---:|---:|
| theme | 1,871 B | 945 B | 610 B | -335 B (-35.4%) |
| simple | 30,156 B | 15,121 B | 8,916 B | -6,205 B (-41.0%) |
| full | 131,479 B | 86,874 B | 49,600 B | -37,274 B (-42.9%) |

| rendered page | `main` | PR #53 | change |
|---|---:|---:|---:|
| browser fixture, full | 98,361 B | 60,750 B | -37,611 B (-38.2%) |
| browser fixture, simple | 24,640 B | 18,098 B | -6,542 B (-26.6%) |
| committed `docs/index.html` | 346,244 B | 308,633 B | -37,611 B (-10.9%) |

These are baselines, not hard budgets. A later bundle may grow for a justified
reason. The rule is to measure and explain rather than assume that a refactor is
free or that a few kilobytes prove it is wrong.

Useful additional baselines before large splits:

- render and interaction time for the browser-test fixture;
- startup and interaction time for the existing 4.8 MB document;
- full and simple output size with the same input;
- browser-suite duration and flake rate;
- jq corpus duration.

## CI and release shape

The intended steady-state checks are:

```text
Go job
  gofmt
  go vet
  go test
  go build with no Node installation

Frontend job
  Node 24
  npm ci
  tsc --noEmit
  unit tests
  build theme/simple/full
  fail if web/dist changes

Browser job
  Node 24
  npm ci
  render page variants
  run Playwright against system Chrome
  verify committed docs page
  upload traces/screenshots on failure

Release job
  Node 24
  npm ci
  type-check and test
  rebuild and verify committed frontend output
  run GoReleaser against the committed assets
```

The independent Go job is useful evidence: because it never installs Node, a
successful `go build` there proves the install boundary has not regressed.

## Developer workflow

During PR #53 the complete local workflow is:

```sh
npm --prefix web ci
npm --prefix web run check
npm --prefix web run build
npm --prefix web test
go test ./...
node web/browser-test/run.js
```

After Playwright, the final command should become a named package script, for
example:

```sh
npm --prefix web run test:browser
```

After changing frontend output, regenerate the committed example:

```sh
npm --prefix web run build
go build -o jqweb .
./jqweb -o docs/index.html docs/k8s.json
```

The exact permanent commands belong in `CONTRIBUTING.md` as each stage lands.

## Risks and controls

| risk | control |
|---|---|
| Bundling changes global initialization order | make imports explicit in one behavior-neutral PR; run every browser case |
| `simple` accidentally imports jq | separate entry points, inspect the esbuild graph, and assert bundle selection/size |
| Minified output contains `</script>` | PR #53 adds a direct Go test over `theme`, `simple`, and `full`; retain it with the exact-inlining tests |
| Generated files drift from source | pinned lockfile plus a build-and-clean-diff CI check |
| Platform-specific esbuild binaries disagree | PR #53 proves Darwin ARM64 output on Linux x64; retain that CI comparison and re-check it on every esbuild upgrade |
| `docs/index.html` becomes stale | render independently in CI and compare bytes |
| Type assertions hide real model mistakes | define discriminated domain types early and keep casts at boundaries |
| Refactoring changes key order or number text | keep the parser/render unit cases and browser tree checks |
| jq behavior changes during the engine split | require the real-jq corpus and builtin coverage on every engine PR |
| Browser migration hides flakes with retries | keep retries off, retain traces, and investigate runner Chrome updates explicitly |
| Playwright adds large browser downloads | use installed Chrome first; consider bundled/cross-browser projects separately |
| Node leaks into installation | keep compiled output committed and retain a Go-only CI job |
| Generated PRs become unreadable | mark outputs generated and put measurements/reasoning in PR descriptions |
| Large rename/split destroys reviewability | preserve behavior per stage and use explicit current-to-new file maps |

## Decisions already made

- Keep `go install` working.
- Keep existing downstream Docker builds working.
- Commit generated, minified JavaScript.
- Keep all npm files under `web/`.
- Use npm with a committed lockfile.
- Require Node 24.12 or later for frontend development and CI.
- Use TypeScript for checking and esbuild for production output.
- Run erasable `.test.ts` files directly with Node's built-in test runner.
- Produce separate `theme`, `simple`, and `full` scripts.
- Call the complete bundle `full`, not `normal`.
- Keep the page offline and self-contained.
- Mark generated output so GitHub can hide it in reviews.
- Migrate browser automation to Playwright in a separate PR.
- Put migration reasoning and measurements in PR descriptions rather than the
  changelog or commit messages.
- Split the work into multiple behavior-preserving PRs linked to #34.

## Decisions to confirm later

- The exact module split inside `page.js` once its imports are explicit.
- Whether `jq.js` is easier to convert before splitting or split before
  converting; PR 6 must settle this before PR 7 starts.
- Whether local-only source maps materially improve debugging.
- Whether Playwright should eventually install bundled Chromium or add Firefox
  and WebKit projects.
- Whether CSS minification deserves a separate measured PR after the
  TypeScript migration.

None of these decisions blocks the current build-boundary PR.
