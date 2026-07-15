# Wordrush private-beta deployment

## Security contract

Player HTTP routes and WebSocket upgrades require the private-beta session
cookie. The server accepts only a `scrypt` password hash from environment
configuration; it never stores or logs the beta password. Sessions are opaque,
`HttpOnly`, `SameSite=Strict`, expire after eight hours by default, and can be
revoked with `POST /auth/logout`.

The Custom Web Receiver is deliberately different: its static bundle may
be fetched by the Cast platform, but it must not receive a player session. A
sender will pass it a one-time, opaque, room-scoped display token over the Cast
message channel. Tokens must expire within five minutes, be consumed on first
use, authorize only a read-only display connection, and never appear in QR
codes, URLs, logs, or player messages. Issue #7 owns that display protocol.

The receiver opens `wss://rush.nrdgrrrl.com/display` and sends the token as its
first `display_hello` message; it never uses a player cookie. A successful
connection receives sanitized `display_state` snapshots only. Any player action
from a display is rejected, displays do not count toward room capacity, and a
closed room closes its displays. A disconnected receiver needs a newly issued
token to reconnect.

QR codes contain only the public beta URL and a room code. They grant neither
beta access nor room authority.

## Configure the service

Generate a password hash on the deployment machine. This prompt avoids putting
the plaintext password in shell history or the process command line:

```sh
read -rsp 'Private-beta password: ' WORDRUSH_BETA_PASSWORD; echo
WORDRUSH_BETA_PASSWORD="$WORDRUSH_BETA_PASSWORD" node -e 'const c=require("node:crypto"),s=c.randomBytes(16),p=process.env.WORDRUSH_BETA_PASSWORD,d=c.scryptSync(p,s,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}); console.log(`scrypt$16384$8$1$${s.toString("base64")}$${d.toString("base64")}`)'
unset WORDRUSH_BETA_PASSWORD
```

Store the result in a root-readable environment file based on `.env.example`.
Set the exact public HTTPS origin and Host header expected by Apache. Production
will refuse to start without both a password hash and allowed origin. Node binds
to loopback by default; do not change that for the internet deployment.

`bash serve-lan.sh` explicitly starts the separate, unauthenticated LAN mode on
`0.0.0.0`. It is for trusted local development only and must never run behind
public DNS or port forwarding.

## Apache / firewall checklist

- Expose only Apache ports 80/443. Keep `127.0.0.1:8000` unreachable from the
  network and firewall it accordingly.
- Redirect HTTP to HTTPS and use a valid Let's Encrypt certificate.
- Proxy the application and WebSocket upgrades to `http://127.0.0.1:8000`;
  preserve `Host`, `Origin`, and `X-Forwarded-For`.
- Set conservative request body and timeout limits at Apache, log access/errors
  without cookies, authorization headers, or query-string display tokens, and
  apply the same TLS virtual host to WebSocket upgrades.
- Do not place Basic Auth in front of the Cast receiver URL. It may be an extra
  browser/admin layer but cannot be the receiver's authorization boundary.

## Release review (completed 2026-07-14)

- [x] Production requires the password hash and exact allowed origin; its
      environment file is `0640 root:wordrush`, and the checkout, service unit,
      and deployment output contain no plaintext beta password.
- [x] Unauthenticated HTTP redirects to the beta gate, APIs return `401`, and
      player WebSocket upgrades are refused. The public receiver bundle and QR
      endpoint carry no player authority.
- [x] Host and Origin allow-lists, a 16 KiB WebSocket frame cap, per-IP login /
      connection limits, and per-connection message limits reject the tested
      hostile input paths. Regression coverage is in `test/auth.test.js` and
      `test/server.test.js`.
- [x] Production verification found only Apache on public ports 80/443 and
      Wordrush on `127.0.0.1:8013`; Apache configuration validated successfully
      and Let’s Encrypt TLS is valid. HTTPS/WSS are reverse-proxied through
      Apache.
- [x] Invalid, expired, replayed, and cross-room display tokens are covered by
      regression tests. The registered Google TV was also launched successfully
      with a real one-time display token: it showed the authorized room lobby,
      and a phone QR scan passed the beta gate and joined that room. A display
      remains read-only and cannot become a player or creator.
