# Wordrush production deployment

Production runs at `https://rush.nrdgrrrl.com`.

## Runtime layout

- Apache is the public TLS/WSS endpoint on ports 80 and 443.
- The `wordrush` systemd service runs `/opt/node/bin/node` as the `wordrush`
  user and listens only on `127.0.0.1:8013`.
- The application lives at `/home/victoria/sites/rush/wordrush`.
- Runtime configuration lives in `/etc/wordrush/rush.env` and must remain
  `root:wordrush`, mode `0640`. Do not add it to Git or copy its contents into
  shell history, tickets, or logs.
- Beta sessions are opaque token records in `/var/lib/wordrush/sessions.json`,
  written with owner-only permissions. This preserves a valid login through a
  normal Wordrush restart; it contains neither the beta password nor browser
  readable credentials.
- The source templates are `deploy/wordrush.service` and
  `deploy/rush.nrdgrrrl.com.conf`. The dedicated LAN command is
  `bash serve-lan.sh`; it is intentionally not a public deployment mode.
- Install `wamerican` on the host. Wordrush uses `/usr/share/dict/words` as the
  authoritative normal-word dictionary; production intentionally refuses to
  start without it so the browser and multiplayer server cannot silently use
  different vocabularies.

## Health and logs

```sh
sudo systemctl status wordrush
sudo journalctl -u wordrush -n 100 --no-pager
sudo apache2ctl configtest
sudo tail -n 100 /var/log/apache2/rush-error.log
sudo certbot certificates
```

The unauthenticated production health check is expected to redirect to the
beta login page:

```sh
curl -I https://rush.nrdgrrrl.com/
```

Do not put a beta password, cookie, or display token in a diagnostic command.

## Certificate renewal

Certbot renews the `rush.nrdgrrrl.com` certificate through the webroot
`/var/www/letsencrypt`, which matches the Apache ACME challenge alias. Check
the timer and test renewal without changing certificates:

```sh
sudo systemctl status certbot.timer
sudo certbot renew --dry-run --no-random-sleep-on-renew
```

Keep the HTTP ACME challenge alias in the Apache virtual host. After an Apache
configuration change, always run `sudo apache2ctl configtest` before
`sudo systemctl reload apache2`.

## Deploy and rollback

Production is currently deployed manually to the RackNerd host, available as
the `racknerd` SSH target. The live directory is an unpacked release rather
than a Git checkout, so deploy from a clean, committed local checkout. Do not
run broad commands against `/home/victoria/sites`—that parent contains other
sites.

Before updating the app, create a dated sibling backup such as
`/home/victoria/sites/rush/wordrush.rollback-YYYYMMDDHHMMSS`; keep at least the
most recent known-good backup. Sync only the Wordrush source, preserving the
server's runtime data and its external `/etc/wordrush/rush.env` configuration:

```sh
ssh racknerd 'set -eu; stamp=$(date +%Y%m%d%H%M%S); cp -a /home/victoria/sites/rush/wordrush /home/victoria/sites/rush/wordrush.rollback-$stamp; echo "Backup: /home/victoria/sites/rush/wordrush.rollback-$stamp"'
rsync -a \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='*.log' \
  ./ racknerd:/home/victoria/sites/rush/wordrush/
```

Install production dependencies, then restart only the Wordrush service:

```sh
ssh racknerd 'set -eu; cd /home/victoria/sites/rush/wordrush; PATH=/opt/node/bin:$PATH npm ci --omit=dev; sudo systemctl restart wordrush; sudo systemctl is-active --quiet wordrush'
curl -I https://rush.nrdgrrrl.com/
```

Do not use `rsync --delete` for this manual deployment: the host retains
runtime data in the release directory. If the release fails, stop only the
Wordrush service, move the failed release aside, restore the selected backup,
and restart:

```sh
ssh racknerd 'set -eu; sudo systemctl stop wordrush; mv /home/victoria/sites/rush/wordrush /home/victoria/sites/rush/wordrush.failed-$(date +%Y%m%d%H%M%S); mv /home/victoria/sites/rush/wordrush.rollback-<timestamp> /home/victoria/sites/rush/wordrush; sudo systemctl start wordrush; sudo systemctl is-active --quiet wordrush'
```

Verify the service, HTTPS redirect, and intended authenticated browser flow
after every deployment. A receiver needs a newly started Cast session to load a
new receiver bundle.

## Disable Cast without disabling multiplayer

To stop new Cast sessions while leaving the normal browser game available,
remove `WORDRUSH_CAST_APPLICATION_ID` from `/etc/wordrush/rush.env` and restart
`wordrush`. The authenticated Cast configuration endpoint will then return no
application ID, so the sender control is unavailable. The receiver's public
static URL still has no room authority without a fresh display token.

Restore the application ID and restart the service to re-enable Cast. This is
the operational rollback for a receiver-specific problem; do not remove the
Apache virtual host or change player WebSocket routes for that purpose.
