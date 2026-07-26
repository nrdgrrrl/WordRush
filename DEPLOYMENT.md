# Wordrush production deployment

Production runs at `https://wordrush.party`.

The Apache template keeps player and Cast display WebSockets open for up to 24
hours. Do not reduce the `/display` proxy timeout to a short request-style
timeout: a Cast receiver may be idle between rounds while still needing to stay
connected to the room.

## Runtime layout

- Apache is the public TLS/WSS endpoint on ports 80 and 443.
- The `wordrush` systemd service runs `/opt/node/bin/node` as the `wordrush`
  user and listens only on `127.0.0.1:8013`.
- The application lives at `/home/victoria/sites/rush/wordrush`.
- Runtime configuration lives in `/etc/wordrush/rush.env` and must remain
  `root:wordrush`, mode `0640`. Do not add it to Git or copy its contents into
  shell history, tickets, or logs.
- Google Analytics remains disabled unless `WORDRUSH_GOOGLE_ANALYTICS_ID` is
  configured. See `ANALYTICS.md`; consent is required by default.
- The source templates are `deploy/wordrush.service` and
  `deploy/wordrush.party.conf`. The dedicated LAN command is
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

The production health check is expected to return the public application:

```sh
curl -I https://wordrush.party/
```

Do not put a display token in a diagnostic command.

## Certificate renewal

Certbot renews the `wordrush.party` certificate through the webroot
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

Production is deployed through `deploy/deploy-production`, using the
`racknerd` SSH target. The live directory is an unpacked release rather than a
Git checkout, so the tool deploys an explicit committed revision. It targets
only `/home/victoria/sites/rush/wordrush` and the `wordrush` service; it does
not modify Apache, certificates, or other sites under `/home/victoria/sites`.

Run the default dry-run first. It checks the selected revision locally, reads
the remote release marker, lists the planned file changes, and determines
whether a service restart is necessary. It makes no production changes:

```sh
./deploy/deploy-production --commit HEAD --dry-run
```

After reviewing that output, deploy the exact same revision:

```sh
./deploy/deploy-production --commit HEAD --deploy
```

The deployment stages a Git-only archive remotely, installs production-only
dependencies in that staging directory, validates it, then performs a bounded
file-level activation into the WordRush directory. It creates a timestamped
`wordrush.rollback-*.tgz` sibling artifact before activation, retains the
three newest, and automatically restores it if a post-activation check fails.
Static-only changes do not restart `wordrush`; server/runtime or dependency
changes do. Output includes the revision, changed files, service action,
rollback artifact, public HTTPS health-check result, and deployed hashes.

To restore a listed rollback artifact immediately:

```sh
./deploy/rollback-production wordrush.rollback-YYYYMMDDTHHMMSSZ-<revision>.tgz
```

Both tools require passwordless SSH to `racknerd` and non-interactive sudo for
`systemctl restart wordrush`. They never transfer `.env`, display credentials,
Git metadata, local data, or ignored files.

The old manual recovery procedure remains below for emergency use only. Do not
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
curl -I https://wordrush.party/
```

Do not use `rsync --delete` for this manual deployment: the host retains
runtime data in the release directory. If the release fails, stop only the
Wordrush service, move the failed release aside, restore the selected backup,
and restart:

```sh
ssh racknerd 'set -eu; sudo systemctl stop wordrush; mv /home/victoria/sites/rush/wordrush /home/victoria/sites/rush/wordrush.failed-$(date +%Y%m%d%H%M%S); mv /home/victoria/sites/rush/wordrush.rollback-<timestamp> /home/victoria/sites/rush/wordrush; sudo systemctl start wordrush; sudo systemctl is-active --quiet wordrush'
```

Verify the service, public HTTPS response, and browser flow after every
deployment. A receiver needs a newly started Cast session to load a new
receiver bundle.

## Disable Cast without disabling multiplayer

To stop new Cast sessions while leaving the normal browser game available,
remove `WORDRUSH_CAST_APPLICATION_ID` from `/etc/wordrush/rush.env` and restart
`wordrush`. The Cast configuration endpoint will then return no
application ID, so the sender control is unavailable. The receiver's public
static URL still has no room authority without a fresh display token.

Restore the application ID and restart the service to re-enable Cast. This is
the operational rollback for a receiver-specific problem; do not remove the
Apache virtual host or change player WebSocket routes for that purpose.
