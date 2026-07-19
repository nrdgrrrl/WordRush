# Cast release checklist

## Automated / production checks — completed

- [x] Room-scoped display-token, display read-only, origin/host,
  rate-limit, capacity, and cross-room authorization tests pass.
- [x] HTTPS/WSS reverse proxy, loopback-only Node listener, service hardening,
  valid certificate, renewal timer, and rollback copies are present.
- [x] Registered device launched Custom Receiver `87810A91`; it showed the
  authorized lobby and QR code. A real phone scan opened the game and joined
  the intended room.
- [x] Receiver browser coverage renders ten long-name score cards at 1080p and
  clears stale score state on a display connection drop. Sender/receiver token
  handoff retries a dropped display connection.
- [x] Cast controls are restricted to HTTPS and an active room; the display
  cannot control games or consume a player slot.

## Real-device matrix — run before broad receiver publication

- [ ] Start and stop a Cast session; re-open it from the same Chrome profile.
- [ ] Test one, two, five, and ten players with long names; confirm live score
  changes and final results are readable from normal viewing distance.
- [ ] Scan the lobby QR code from a separate phone and confirm the game opens
  and the intended room join works.
- [ ] While the room is cast, refresh the sender browser, reload/restart the
  receiver, and briefly interrupt Wi-Fi; confirm the display clears stale state
  and a new Cast handoff restores the current room.
- [ ] Leave as room host and confirm the TV returns to the closed-room state.
- [ ] Review receiver diagnostics in the Cast developer console.

## Known operational limitation

Rooms are in-memory. A Wordrush service restart closes active rooms and
disconnects players/displays; start a new room and Cast it again afterwards.
This does not affect the normal service restart/rollback procedure, but it
should be communicated before any planned maintenance.

## Publication

The registered device can use the unpublished receiver. Publishing in the Cast
SDK Developer Console makes the receiver available beyond registered test
devices and is an account-owner decision. Before publishing, complete the
real-device matrix above and confirm the receiver URL remains
`https://rush.nrdgrrrl.com/receiver/`.

For the console entry, use Custom Receiver, the receiver URL above, and the
web sender URL `https://rush.nrdgrrrl.com/`. Keep **Supports casting to
audio-only devices** unchecked: Wordrush is a visual TV companion, not an
audio receiver. Enable relay casting only if cross-network casting is an
intended, tested feature.
