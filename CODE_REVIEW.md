# Wordrush code review

## Fixed

- Removed the conflicting two-controller architecture. The old controller used state.gridSize, state.timerId, renderBoard, and showScreen; the new controller uses one state model and one set of event listeners.
- Added the mode UI to the actual HTML. Previously the mode extension code existed but its buttons did not.
- Added working entry points for Random Rush, Classic, Minimum Word, Sudden Death, Race Mode, Dirty Mode, and custom dictionary.
- Board size now matches the selected mode and the generated board is always filled to the requested dimensions.
- Added seeded board generation for 3-, 4-, 5-, and 6+-letter targets, followed by weighted letter fill.
- Added adjacency and no-repeat path validation. A word now has to be present in the active dictionary and traceable on the board.
- Fixed race completion and sudden-death completion so rounds end once and timers are cleared.
- Added safer local-storage parsing for custom words.
- Added LAN serving through serve-lan.sh with 0.0.0.0 binding and the machine LAN URL.
- Added solo-safe mode rules. Every mode uses the same local round engine; the opponent score is presentation-only, so no mode requires a second player to make progress.

## Remaining product boundary

The browser build is still a static prototype. The displayed opponents are simulated. Production multiplayer needs a server-authoritative room, seed, board, dictionary, timer, path validation, and score calculation. Client-submitted scores must never be trusted.

## Suggested next hardening

1. Move the word list to a versioned server-side dictionary and build a trie for fast prefix pruning.
2. Generate candidate boards server-side, solve each candidate, and reject boards that miss minimum length-bucket quotas. The current seeded generator is a good client prototype but is not a fairness guarantee.
3. Replace prompt and confirm with in-app dialogs for a better mobile experience.
4. Add automated tests for adjacency, duplicate words, mode thresholds, board quotas, timer expiry, and local-storage corruption.
5. Add a real WebSocket room service and reconnect/resume handling.

