# Wordrush comprehensive code review

Reviewed: client gameplay, touch input, results, achievements, statistics, leaderboard, HTTP serving, WebSocket rooms, multiplayer rules, LAN tooling, and automated tests.

## Findings and fixes

### 1. Duplicate gameplay controllers

- Problem: `app.js` defined `make`, `clearPick`, and the pointer handlers twice. Later declarations silently replaced earlier ones.
- Cause: interaction fixes were appended instead of replacing the original implementation.
- Recommended solution: retain one implementation for each responsibility and cover pointer edge cases with browser tests.
- Fix: removed the dead board generator, selection controller, nearest-tile code, duplicate pointer handlers, duplicate navigation handlers, duplicate Random Rush handlers, and duplicate avatar/profile handlers.

### 2. Invalid document structure and hidden script dependency

- Problem: leaderboard and Random Rush scripts appeared after `</html>`, while `results.js` was injected dynamically from `random-rush.js`.
- Cause: features were added incrementally without updating the original script block.
- Recommended solution: keep all scripts inside `<body>` in explicit dependency order.
- Fix: moved every script before `</body>`, loaded `results.js` directly, removed dynamic injection, and removed duplicated inline CSS.

### 3. Brittle observer and monkey-patch integration

- Problem: results, achievements, and leaderboard updates depended on broad `MutationObserver`s and wrappers around global functions.
- Cause: there was no explicit application lifecycle for round start, accepted words, screen changes, and round completion.
- Recommended solution: publish narrow domain events and subscribe to those events.
- Fix: added `wordrush:round-started`, `wordrush:word-accepted`, `wordrush:screen-change`, and `wordrush:round-complete` events. Removed whole-document observers and online-finish monkey patches.

### 4. Multiplayer timer was not displayed or server-enforced

- Problem: online clients did not start a countdown, and the server only noticed timeout when another word was submitted.
- Cause: `endsAt` was sent but never consumed by a client timer, and no server timeout was scheduled.
- Recommended solution: derive client displays from the authoritative timestamp and schedule server completion independently.
- Fix: clients now render drift-resistant countdowns from `endsAt`; the server schedules, cancels, and cleans up authoritative round timers.

### 5. Wrong score shown after another player submitted

- Problem: every client displayed the submitting player's score as its own game score.
- Cause: the client searched score updates using `message.playerId` rather than its own guest ID.
- Recommended solution: identify the local player by stable ID.
- Fix: exposed the local guest ID and always select the local score by that ID.

### 6. Results and wins matched players by display name

- Problem: duplicate or changed names could assign the wrong final score or winner.
- Cause: the final result code used player names as identifiers.
- Recommended solution: use immutable player IDs for ownership and names only for display.
- Fix: all final-score, winner, multiplayer-stat, and leaderboard calculations now use guest IDs.

### 7. Unsafe player rendering

- Problem: multiplayer names were interpolated into `innerHTML`, allowing markup injection and broken result layouts.
- Cause: trusted and untrusted display values were mixed in HTML strings.
- Recommended solution: construct elements and assign untrusted values through `textContent`.
- Fix: live player rows, static results, and animated results now use safe DOM construction. Server identity text is also stripped of control characters and Unicode-safe length limited.

### 8. Competitive duplicate-word rule was global

- Problem: once one competitive player found a word, every other player was rejected for that word.
- Cause: all modes validated against the room-wide found set.
- Recommended solution: keep per-player found sets in competitive modes and a shared set in co-op.
- Fix: competitive players can score the same word independently; co-op still prevents team duplicates.

### 9. Any player could terminate a multiplayer round

- Problem: guests could end the game for the entire room.
- Cause: `end_round` had no authorization check.
- Recommended solution: make manual round termination creator-only and hide that control from guests.
- Fix: the server rejects guest termination and non-creators no longer see the End Round button.

### 10. Room cleanup left stale client membership

- Problem: closing a creator's room attempted to find clients by player ID in a map keyed by WebSocket, leaving guests associated with a deleted room.
- Cause: mismatched map keys and copied player/client records.
- Recommended solution: resolve client state through each member WebSocket and centralize room shutdown.
- Fix: added centralized timer-aware room cleanup that clears every member's room code. Released guests can immediately create or join another session.

### 11. Repeated room-state messages reset active games

- Problem: identity updates or late joins could reinitialize an already running board, timer, and local round tracking.
- Cause: every playing `room_state` invoked online round setup.
- Recommended solution: give rounds stable identity and ignore duplicate initialization.
- Fix: the client derives a stable round key from board and end time and only initializes a round once.

### 12. Animated results used inferred DOM state

- Problem: single-player words were recovered by parsing preview text, and reveal changes could recursively retrigger the observer.
- Cause: accepted word data was not explicitly retained by the results feature.
- Recommended solution: pass accepted `{word, points}` data through round events.
- Fix: results consume explicit word events and final rankings, cancel hidden animations, safely render cards, and reveal one word per player per animation step.

### 13. Multiplayer result controls could become stale

- Problem: late room state carried the original result settings after players changed view or speed.
- Cause: `lastResult.results` referenced an old settings object.
- Recommended solution: update the stored result snapshot whenever shared settings change.
- Fix: view and speed broadcasts update both current room settings and the late-join result snapshot.

### 14. Results displayed a nonexistent bonus

- Problem: the UI claimed a 50-point bonus that was never added to the score, profile, ranking, or word reveal total.
- Cause: placeholder presentation survived without scoring logic.
- Recommended solution: either implement a defined bonus rule everywhere or remove the claim.
- Fix: replaced the fake bonus with the actual number of words found, keeping all displayed totals consistent.

### 15. Long names caused horizontal phone overflow

- Problem: generated or user names without spaces could widen the results page beyond the viewport.
- Cause: the large results heading had no emergency wrapping rule.
- Recommended solution: allow long identifiers to wrap and test the maximum multiplayer layout at phone width.
- Fix: added overflow wrapping and a ten-player, 390-pixel browser regression test. Visual checks now show no horizontal overflow.

### 16. Achievement rules did not match their labels

- Problem: Speed Demon unlocked for 20 lifetime words instead of 20 words in a minute, and Grid Master unlocked for merely playing an 8×8 board rather than winning.
- Cause: profile data did not retain the required round-level facts.
- Recommended solution: track accepted-word times and the largest winning grid.
- Fix: added rolling one-minute word timing, `speedAchievement`, and `maxGridWin`; achievement predicates now match their descriptions.

### 17. Streak and achievement persistence were inaccurate

- Problem: simply opening the site counted as a play day, UTC could select the wrong local day, and achievement unlocks could be overwritten by the in-memory profile.
- Cause: profile rendering also mutated play history, and achievements edited a separately loaded profile object.
- Recommended solution: record local play days only at round completion and mutate the shared profile object.
- Fix: separated play-day recording, uses the local calendar date, and keeps unlock state on the live profile.

### 18. Achievement rendering did excessive work

- Problem: accepting each word rebuilt more than 200 achievement cards.
- Cause: every profile update regenerated the entire list.
- Recommended solution: evaluate progress often but rerender the list only when unlock state changes.
- Fix: added unlock-signature rendering and queued achievement notifications.

### 19. Scoreboard tests and requests raced external state

- Problem: browser tests read the production leaderboard file, and slower responses from an older tab request could overwrite a newer scoreboard selection.
- Cause: tests shared persistent data and client loads had no request ordering guard.
- Recommended solution: isolate test storage and ignore stale responses.
- Fix: every server/browser suite uses a temporary leaderboard file, and scoreboard loads use monotonically increasing request tokens.

### 20. Leaderboard payloads were weakly bounded

- Problem: non-finite or extreme client values and control characters could corrupt persisted statistics or layout.
- Cause: values were only coerced to nonnegative numbers and strings were sliced by UTF-16 code units.
- Recommended solution: sanitize text by Unicode code point and cap every numeric field.
- Fix: added control-character removal, Unicode-safe limits, invalid-date fallback, and explicit numeric caps. Multiplayer scores are now recorded from authoritative server results in one batched disk write; the client no longer submits multiplayer scores again.

### 21. Static file traversal check used a prefix comparison

- Problem: a simple string prefix is unsafe for distinguishing a root from similarly named sibling paths.
- Cause: static serving joined and compared unnormalized strings.
- Recommended solution: resolve both paths and require the requested file to begin with `root + path.sep`.
- Fix: normalized URL decoding, root-bounded resolution, safer error responses, MIME hardening, and a traversal regression test.

### 22. Dictionary validation and board verification repeated expensive work

- Problem: every submission rebuilt and linearly searched the dictionary; board generation repeatedly searched the full system dictionary.
- Cause: lexicons and coverage candidates were not cached or narrowed.
- Recommended solution: cache immutable base lexicons and verify only selected board targets.
- Fix: added cached base arrays/sets on the server, a client lexicon cache, set membership validation, and target-only board coverage checks.

### 23. Headless harness did not start a game

- Problem: `--mode` was sent during room creation, where the server ignores it, so the harness exited without launching a round.
- Cause: the harness relied on sleeps and did not follow the room protocol.
- Recommended solution: await protocol acknowledgements and send `start_game` after all joins complete.
- Fix: replaced sleeps with typed message waits, validates mode/count, starts the selected round, reports actual round metadata, and cleans up on failure.

### 24. LAN launcher and documentation disagreed on the default port

- Problem: the launcher used 18765 while the server and README said 8000; invalid ports were accepted.
- Cause: defaults evolved independently.
- Recommended solution: use one default and validate user input.
- Fix: standardized on port 8000, validates the port range, and handles missing LAN-address detection clearly.

### 25. Solo and multiplayer rules were duplicated

- Problem: mode labels, minimum lengths, board sizes, timers, built-in words, adult words, and letter frequencies were independently hard-coded in browser and server files.
- Cause: the shared rules module was originally Node-only, so the browser grew a parallel copy.
- Recommended solution: expose immutable game configuration through one browser/CommonJS-compatible module.
- Fix: added `game-config.js` and made both `app.js` and `game-core.js` consume the same rule and dictionary constants.

### 26. Multiplayer result details could lose the local word summary

- Problem: the static result could show a correct score with zero words, while the reveal total remained zero.
- Cause: the client retained a separate local multiplayer word list instead of normalizing and adopting the authoritative final ranking.
- Recommended solution: treat the server ranking as the result source of truth and derive the local count from the stable player ID.
- Fix: online completion now normalizes every ranked word/score, restores the local round state from the matching player, and gives the reveal view a score fallback for empty word payloads.

### 27. Normal game buttons escaped an active multiplayer room

- Problem: after one room game, Play Again and the normal home game cards started a solo game only in the creator's browser.
- Cause: only the multiplayer dialog sent `start_game`; all other launch controls called the local board generator directly.
- Recommended solution: route every launch through the active room and let only the creator request the next authoritative round.
- Fix: the central game launcher now delegates to multiplayer whenever a session exists. Standard, Random Rush, repeated, and sanitized custom rounds are broadcast to every player.

### 28. A creator refresh could leave an orphaned guest UI

- Problem: after the creator refreshed, a guest could remain displayed in a one-player room without creator controls.
- Cause: cleanup depended entirely on WebSocket close detection, which can be delayed after page navigation or an unclean network loss.
- Recommended solution: retain the creator seat through a bounded reconnect grace period and keep server-side dead-connection detection as a fallback.
- Fix: creators resume with a private reconnect token, room shutdown invalidates its state, and WebSocket heartbeat checks terminate stale connections.

## Verification

### 2026-07-18 production follow-up

The deployed multiplayer/Cast release received a second full audit. Confirmed findings were fixed individually:

- stale room sockets can no longer intercept later solo submissions;
- leaving a solo game or multiplayer room now disposes active timers, while players who open the main-screen QR can return to the live board;
- repeated WebSocket identity initialization is rejected, cross-room resume is blocked, and a disconnected seat requires its private reconnect token;
- tied top scorers all receive a win, consistently on the server, local profile, leaderboard, phone, and TV;
- completed multiplayer rounds carry stable IDs and cannot be counted twice after a results-page refresh;
- Cast health is reset when the room changes, preventing a new room from inheriting a stale “TV live” state;
- browser and server board generation now use the shared `board-core.js` implementation;
- malformed saved profile values are normalized, duplicate navigation handling and invalid result markup were removed, and redundant grid CSS was consolidated;
- expired rate-limit records are pruned, closed-room display tokens are released, and forwarded client IPs are trusted only behind the loopback proxy.

The release gate now covers 30 unit/integration tests, 35 browser tests, and 2 three-client soak tests.

- `npm test`: 30 unit/integration tests passing.
- `npm run test:browser`: 35 browser tests and 2 three-client soak tests passing.
- Syntax checks pass for server and browser JavaScript.
- `git diff --check` passes.
- `bash -n serve-lan.sh` passes.
- Manual phone and desktop visual checks cover the ten-player animated result layout; no page errors or horizontal overflow were observed.

## Architectural boundaries

- Rooms and active rounds are intentionally in-memory for this LAN application; a process restart ends them.
- Solo leaderboard submissions remain client-reported because solo rounds run entirely in the browser. Numeric caps prevent data corruption, but tamper-resistant public rankings would require authenticated accounts and server-hosted solo rounds.
- The available dictionary depends on the host OS dictionary, with a built-in fallback. A production deployment should bundle and version a complete licensed word list.
- Native prompt/confirm dialogs remain for room joining, personal dictionary entry, and adult-mode consent. Dedicated dialogs would improve polish but do not block the current workflows.
