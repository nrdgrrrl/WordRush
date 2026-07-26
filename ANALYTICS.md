# Wordrush analytics plan

## Activation

Analytics is intentionally disabled unless the server has a valid GA4
Measurement ID. When the ID is available, add it to the protected production
environment file:

```sh
WORDRUSH_GOOGLE_ANALYTICS_ID=G-XXXXXXXXXX
WORDRUSH_ANALYTICS_REQUIRE_CONSENT=1
```

Restart the `wordrush` service after changing the environment. The browser
loads the ID from `/api/analytics-config`; the ID is configuration, not a
secret. `WORDRUSH_ANALYTICS_REQUIRE_CONSENT` defaults to `1`. Set it to `0`
only after confirming that doing so matches the applicable privacy policy and
legal requirements.

The implementation follows Google's gtag.js event API and uses basic consent:
the Google tag is not loaded until the player accepts analytics. Advertising
storage, advertising user data, advertising personalization, Google signals,
and ad-personalization signals remain disabled.

Accept and deny clicks are also counted by the first-party
`/api/analytics-consent` endpoint. That endpoint records only aggregate
`granted` and `denied` totals in `WORDRUSH_ANALYTICS_CONSENT_FILE`, defaulting
to `/var/lib/wordrush/analytics-consent.json`, so denied players are not sent
to Google Analytics just to count the denial.

Official references:

- https://developers.google.com/analytics/devguides/collection/ga4/events
- https://developers.google.com/analytics/devguides/collection/ga4/reference/events
- https://developers.google.com/tag-platform/security/concepts/consent-mode
- https://support.google.com/analytics/answer/10000067

## Data minimization

Never send these values to Google Analytics:

- player names or avatars;
- guest IDs, reconnect tokens, Cast tokens, or room codes;
- submitted words, custom dictionary entries, or board letters;
- full URLs, query strings, exception messages, or free-form text;
- IP addresses collected by application code.

Words are represented only by length, points, result, and rejection category.
Rooms are represented only by player count and lifecycle action. JavaScript
errors include only the error class, local source filename, line number, and
active screen.

## Event catalog

### Navigation and interaction

- `page_view`: initial application load without query parameters.
- `analytics_consent_choice`: granted consent only. Denials are counted only by
  the first-party aggregate endpoint.
- `screen_view`: active Wordrush screen.
- `ui_action`: stable button ID, active screen, selected mode, or destination.
- `theme_change`: selected light/dark theme.
- `session_engagement`: elapsed visit time and last active screen.

### Gameplay

- `round_intro_view`: mode, multiplayer/Random Rush/Party flags, grid size,
  minimum word length, and intro duration.
- `game_round_start`: mode, flags, grid size, minimum length, and configured
  duration.
- `word_accepted`: mode, word length, points, and multiplayer/Random Rush flags.
- `word_rejected`: mode, word length, rejection reason, and flags.
- `game_round_complete`: mode, score, word count, player count, completion
  reason, game duration, multiplayer/co-op/Random Rush flags.
- `random_rush_action`: upcoming mode, continue, automatic advance, and stop.
- `achievement_unlocked`: stable achievement ID only.

### Multiplayer and device features

- `multiplayer_action`: room create/join/resume/leave/close requests and
  outcomes, start requests, player count, mode, reconnects, and safe error code.
- QR scan start, success, unsupported browser, camera failure, and denied
  permission are represented as multiplayer actions.
- Cast request, connection, initialization, handoff, and error outcomes are
  tracked without receiver tokens or room identifiers.

### Reliability and performance

- `performance_load`: DNS, connection, response, DOM-ready, and load timings.
- `javascript_error`: error class, local source file, line, and active screen.
- `promise_rejection`: rejection class and active screen.

## GA4 administration checklist

After the Measurement ID is installed:

1. Verify consent accept/decline behavior with Tag Assistant and GA4 DebugView.
2. Register useful event parameters as custom dimensions/metrics. Prioritize
   `mode`, `multiplayer`, `random_rush`, `grid_size`, `minimum_length`,
   `player_count`, `reason`, `word_length`, `score`, and `game_seconds`.
3. Mark only meaningful outcomes as key events, such as first completed round,
   multiplayer room creation, and multiplayer round completion.
4. Configure data retention, internal/developer traffic filtering, and unwanted
   referral handling in the GA4 property.
5. Publish a privacy notice describing Google Analytics, retention, consent,
   and how a player can change their choice.
6. Monitor event cardinality and quotas before adding new parameters.

## Verification without a Measurement ID

`window.wordrushAnalytics.status()` should return `enabled: false` and no
consent prompt or Google request should appear. This is the expected production
state until the ID is provided.
