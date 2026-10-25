# Contributing

- TypeScript only, erasable syntax (no enums, no parameter properties): Node runs the sources directly, and Bun does too.
- The core (`src/ledger`, `src/domain`, `src/tools`, `src/clock`, `src/render`, `src/views`) must not import anything from the OpenCode host. Only `src/host/opencode.ts` touches the host's types, and it types them loosely on purpose.
- A change that adds a tool, an event or a state updates the matching diagram in `docs/uml/src` and regenerates `docs/TOOLS.md`; CI fails otherwise.
- Every fix comes with a test that fails without it. Run the suite with `npm test` and the typecheck with `npm run typecheck`.
- Events are append-only. A projection (`src/ledger/projections.ts`) must be deterministic: it never reads the clock or the network, because `rebuild` replays it.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`), written in plain words.

To redraw the diagrams: `java -jar plantuml.jar -tsvg -o ../out docs/uml/src/*.puml` (needs Graphviz).
