const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  RUNTIME_CONFIG_SPECS,
  readRuntimeConfig,
} = require("../runtime-config");

test("runtime configuration keeps the existing defaults", () => {
  assert.deepEqual(readRuntimeConfig({}), {
    PORT: 8000,
    RANDOM_RUSH_DELAY: 20_000,
    WORDRUSH_CONSENT_TIMEOUT_MS: 60_000,
    WORDRUSH_CHALLENGE_TIMEOUT_MS: 30_000,
    WORDRUSH_DISPLAY_TOKEN_TTL_MS: 5 * 60 * 1000,
    WORDRUSH_DISPLAY_RECONNECT_TTL_MS: 8 * 60 * 60 * 1000,
    WORDRUSH_ROOM_RECONNECT_GRACE_MS: 15 * 60 * 1000,
    WORDRUSH_MAX_WS_PER_IP: 60,
    WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW: 60,
    WORDRUSH_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    WORDRUSH_WS_HEARTBEAT_MISSES: 2,
  });
});

test("runtime configuration accepts bounded integer overrides", () => {
  const env = Object.fromEntries(
    Object.entries(RUNTIME_CONFIG_SPECS).map(([name, spec]) => [
      name,
      String(spec.minimum),
    ]),
  );
  env.PORT = "65535";
  env.WORDRUSH_DISPLAY_RECONNECT_TTL_MS = String(
    RUNTIME_CONFIG_SPECS.WORDRUSH_DISPLAY_RECONNECT_TTL_MS.maximum,
  );

  const config = readRuntimeConfig(env);
  assert.equal(config.PORT, 65_535);
  assert.equal(config.WORDRUSH_WS_HEARTBEAT_INTERVAL_MS, 1_000);
  assert.equal(
    config.WORDRUSH_DISPLAY_RECONNECT_TTL_MS,
    7 * 24 * 60 * 60 * 1000,
  );
});

test("invalid runtime configuration names the setting and reason", () => {
  const invalidValues = {
    PORT: "0",
    RANDOM_RUSH_DELAY: "1.5",
    WORDRUSH_CONSENT_TIMEOUT_MS: "-1",
    WORDRUSH_CHALLENGE_TIMEOUT_MS: "3e4",
    WORDRUSH_DISPLAY_TOKEN_TTL_MS: "86400001",
    WORDRUSH_DISPLAY_RECONNECT_TTL_MS: "604800001",
    WORDRUSH_ROOM_RECONNECT_GRACE_MS: "0",
    WORDRUSH_MAX_WS_PER_IP: "10001",
    WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW: "100001",
    WORDRUSH_WS_HEARTBEAT_INTERVAL_MS: "999",
    WORDRUSH_WS_HEARTBEAT_MISSES: "11",
  };

  for (const [name, value] of Object.entries(invalidValues)) {
    assert.throws(
      () => readRuntimeConfig({ [name]: value }),
      (error) => {
        assert.match(error.message, new RegExp(`^Invalid ${name}: `));
        return true;
      },
    );
  }
});

test("invalid runtime configuration fails before server startup", () => {
  const invalidValues = {
    PORT: "0",
    RANDOM_RUSH_DELAY: "0",
    WORDRUSH_CONSENT_TIMEOUT_MS: "0",
    WORDRUSH_CHALLENGE_TIMEOUT_MS: "0",
    WORDRUSH_DISPLAY_TOKEN_TTL_MS: "0",
    WORDRUSH_DISPLAY_RECONNECT_TTL_MS: "0",
    WORDRUSH_ROOM_RECONNECT_GRACE_MS: "0",
    WORDRUSH_MAX_WS_PER_IP: "0",
    WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW: "0",
    WORDRUSH_WS_HEARTBEAT_INTERVAL_MS: "0",
    WORDRUSH_WS_HEARTBEAT_MISSES: "0",
  };
  const root = path.resolve(__dirname, "..");

  for (const [name, value] of Object.entries(invalidValues)) {
    const result = spawnSync(
      process.execPath,
      ["-e", "require('./server')"],
      {
        cwd: root,
        env: { ...process.env, NODE_ENV: "test", [name]: value },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, `${name} should stop startup`);
    assert.match(result.stderr, new RegExp(`Invalid ${name}:`));
    assert.equal(result.stdout, "", `${name} should fail before listen output`);
  }
});
