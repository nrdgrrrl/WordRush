# Wordrush

Mobile-first Boggle-style word game with cat artwork and authoritative LAN multiplayer.

## Run on the LAN

From this directory run bash serve-lan.sh. The script prints the machine Wi-Fi address. On each phone connected to the same network, open http://THAT-IP:8000.

## Included

- Touch tracing across 4x4–8x8 grids
- Classic, Minimum Word, Sudden Death, Race Mode, Dirty Mode, and Random Rush
- Balanced board generation with short, medium, and long word targets
- Personal custom dictionary stored in browser local storage
- Opt-in adult dictionary for Dirty Mode
- Authoritative WebSocket rooms for up to 10 players
- Headless multi-client harness: PORT=8000 node headless-client.js --clients 10 --mode race
- Results, achievements, guest profile shell, and cat artwork

## Tests

Run npm test. The tracked .githooks/pre-commit hook runs the complete test suite before every commit.

The server validates room capacity, board paths, dictionaries, duplicate words, timers, and race completion. The client is not trusted for accepted words or scores.
