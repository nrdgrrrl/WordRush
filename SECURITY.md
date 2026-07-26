# Wordrush production security

## Security contract

The public game does not require a site-wide password. HTTP routes and player
WebSocket upgrades remain protected by exact Host and Origin allow-lists,
request-size limits, per-IP connection limits, and per-connection message
limits. State-changing HTTP requests require an allowed Origin.

The Custom Web Receiver is deliberately different from a player. Its static
bundle may be fetched by the Cast platform, but a sender must pass it a
one-time, opaque, room-scoped display token over the Cast message channel.
Tokens expire within five minutes, are consumed on first use, authorize only a
read-only display connection, and never appear in QR codes, URLs, logs, or
player messages.

The receiver opens `wss://wordrush.party/display` and sends the token as its
first `display_hello` message. A successful connection receives sanitized
`display_state` snapshots only. Any player action from a display is rejected,
displays do not count toward room capacity, and a closed room closes its
displays. A disconnected receiver resumes with its separate, rotating display
reconnect credential.

QR codes contain only the public game URL and a room code. They grant no room
authority.

## Configure the service

Store runtime configuration in a root-readable environment file based on
`.env.example`. Set the exact public HTTPS origin and Host header expected by
Apache. Production refuses to start without an allowed origin. Node binds to
loopback by default; do not change that for the internet deployment.

`bash serve-lan.sh` explicitly starts the separate LAN mode on `0.0.0.0`. It is
for trusted local development only and must never run behind public DNS or port
forwarding.

## Apache / firewall checklist

- Expose only Apache ports 80/443. Keep the Node listener unreachable from the
  network and firewall it accordingly.
- Redirect HTTP to HTTPS and use a valid Let's Encrypt certificate.
- Proxy the application and WebSocket upgrades to the configured loopback
  listener; preserve `Host`, `Origin`, and `X-Forwarded-For`.
- Set conservative request body and timeout limits at Apache, log access/errors
  without display credentials, and apply the same TLS virtual host to WebSocket
  upgrades.
- Do not place Basic Auth in front of the Cast receiver URL. The receiver's
  authorization boundary is its room-scoped display credential.

## Release review

- [x] Public HTTP, APIs, and player WebSockets work without a main password.
      Host and Origin restrictions remain covered by regression tests.
- [x] The public receiver bundle and QR endpoint carry no player or room
      authority.
- [x] Host and Origin allow-lists, a 16 KiB WebSocket frame cap, per-IP
      connection limits, and per-connection message limits reject hostile input
      paths. Regression coverage is in `test/auth.test.js` and
      `test/server.test.js`.
- [x] Production verification found only Apache on public ports 80/443 and
      Wordrush on its loopback listener; HTTPS/WSS are reverse-proxied through
      Apache.
- [x] Invalid, expired, replayed, and cross-room display tokens are covered by
      regression tests. A display remains read-only and cannot become a player
      or creator.
