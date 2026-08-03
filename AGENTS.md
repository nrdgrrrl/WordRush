# Repository Guidelines

## Project Structure & Module Organization

WordRush is a Node.js LAN multiplayer word game. Browser entry points and UI live in the repository root (`index.html`, `app.js`, `styles.css`, and feature-specific `*.js`/`*.css` files). `server.js` owns HTTP/WebSocket rooms and authoritative validation; shared rules and board logic are in `game-config.js`, `game-core.js`, `board-core.js`, and related modules. The Cast receiver is under `receiver/`, static images under `assets/`, and automated tests under `test/`. Build and maintenance utilities are in `scripts/`; deployment templates and release scripts are in `deploy/`. The checked-in `dictionaries/artifacts/` files are runtime inputs.

## Orchestration
Codex should actively delegate bounded work whenever doing so improves speed, context efficiency, specialisation or independent verification, while the primary orchestrator remains responsible for planning, safety, integration and the final result. For each delegation, the orchestrator must deliberately choose the best model and reasoning effort: Luna for clear and repeatable work, Terra for ambiguous or tool-heavy investigation and substantial implementation, and Sol for difficult or consequential judgement. Spark is reserved for tightly scoped, low-risk scans or mechanically verifiable micro-edits. Delegation should use concise briefs, limited context, explicit success criteria and clear stop conditions, with no fixed worker-model default and no unnecessary

## Build, Test, and Development Commands

- `npm ci` installs the locked dependencies.
- `npm start` runs the local server on `127.0.0.1:8000`.
- `bash serve-lan.sh` starts trusted LAN development and prints the access address.
- `npm test` runs Node unit/integration tests; `npm run test:browser` runs Playwright browser coverage; `npm run test:soak` runs multiplayer soak coverage; `npm run test:all` runs all three suites.
- `npm run check` performs syntax checks across application and script files.
- `npm run compile:dictionary` is an explicit networked dictionary rebuild; do not run it as part of ordinary tests.

## Coding Style & Naming Conventions

Use the existing JavaScript style: two-space indentation, semicolons, double-quoted strings, CommonJS `require`, and trailing commas in multiline structures. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and descriptive behavior-based test names. Prefer shared configuration and server-authoritative validation over duplicated client rules. No formatter or linter is configured; run `npm run check` and keep `git diff --check` clean.

## Testing Guidelines

Name tests `test/<feature>.test.js` and describe observable behavior with `test("...")`. Add focused Node tests for rules, board generation, protocol, and security changes; add or update Playwright coverage for browser lifecycle and multiplayer behavior. There is no stated coverage threshold. Run the narrowest relevant test first, then `npm run test:all` before handoff. The tracked pre-commit hook runs `npm test` and `npm run test:browser` when enabled.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects, optionally ending with the issue or PR number (for example, `Fix Sudden Death outcome semantics (#106)`). Keep commits focused. Pull requests should explain the behavior change, link the issue, list validation commands and results, and include screenshots or recordings for visible UI changes. Call out dictionary, security, deployment, or persistent-state implications explicitly.
