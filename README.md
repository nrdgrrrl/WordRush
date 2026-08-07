# Wordrush

Mobile-first Boggle-style word game with authoritative LAN multiplayer.

## Run on the LAN

From this directory run bash serve-lan.sh. The script prints the machine Wi-Fi address. On each phone connected to the same network, open http://THAT-IP:8000.

## Included

- Touch tracing across 4x4–8x8 grids
- Classic, Minimum Word, Sudden Death, Race Mode, Co-op, Dirty Mode, Blitz,
  Long Haul, Letter Storm, Score Attack, Word Chain, and Random Rush
- Balanced board generation with short, medium, and long word targets
- Canadian English Standard dictionary compiled from pinned ESDB data
- Explicit adult-word dictionary in Dirty Mode
- Legacy `wordrush-custom` localStorage value is intentionally left dormant and
  does not affect gameplay. Future controlled vocabulary work is tracked in
  [issue #41](https://github.com/nrdgrrrl/WordRush/issues/41).
- Authoritative WebSocket rooms for up to 10 players
- Shared static or animated word-by-word results with synchronized reveal speed
- Headless multi-client harness: PORT=8000 node headless-client.js --clients 10 --mode race
- Animated results, achievements, statistics, leaderboard, and guest profiles

## Maintenance notes

The SVG trace-line code is intentionally retained but visually disabled. Pointer
tracing still records its path so the trail can be re-enabled later by removing
`visibility: hidden` from `.trace-layer` in `styles.css`; this is not abandoned
or dead input code.

## Tests

Run `npm test` for unit/integration coverage or `npm run test:browser` for browser and multiplayer soak coverage. The tracked `.githooks/pre-commit` hook runs both suites before every commit.

The server validates room capacity, board paths, dictionaries, duplicate words, timers, and race completion. The client is not trusted for accepted words or scores.

The packaged `wordrush-ca-standard-v1` artifact is used by both solo and
multiplayer gameplay. Rebuilding it is an explicit networked build operation;
runtime and normal tests use only the checked-in artifact.

## Board generation contract

Boards are generated from a prepared, canonical lexicon with an explicit mode,
minimum word length, and seed. Successful boards contain a pathable target from
each available 3-, 4-, 5-, and 6-plus-letter family plus at least one word that
meets the round minimum. Dirty Mode also preserves its provisional five-playable
adult-word coverage when five eligible adult words exist. Sparse or exhausted
generation fails with bounded, reproduction-safe diagnostics; it never returns
an unplayable fallback board.
