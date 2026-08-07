const RUNTIME_CONFIG_SPECS = Object.freeze({
  PORT: { defaultValue: 8000, minimum: 1, maximum: 65_535, unit: "port" },
  RANDOM_RUSH_DELAY: {
    defaultValue: 20_000,
    minimum: 1,
    maximum: 86_400_000,
    unit: "milliseconds",
  },
  WORDRUSH_DISPLAY_TOKEN_TTL_MS: {
    defaultValue: 5 * 60 * 1000,
    minimum: 1,
    maximum: 86_400_000,
    unit: "milliseconds",
  },
  WORDRUSH_DISPLAY_RECONNECT_TTL_MS: {
    defaultValue: 8 * 60 * 60 * 1000,
    minimum: 1,
    maximum: 7 * 24 * 60 * 60 * 1000,
    unit: "milliseconds",
  },
  WORDRUSH_ROOM_RECONNECT_GRACE_MS: {
    defaultValue: 15 * 60 * 1000,
    minimum: 1,
    maximum: 86_400_000,
    unit: "milliseconds",
  },
  WORDRUSH_MAX_WS_PER_IP: {
    defaultValue: 60,
    minimum: 1,
    maximum: 10_000,
    unit: "connections",
  },
  WORDRUSH_MAX_WS_MESSAGES_PER_WINDOW: {
    defaultValue: 60,
    minimum: 1,
    maximum: 100_000,
    unit: "messages",
  },
  WORDRUSH_WS_HEARTBEAT_INTERVAL_MS: {
    defaultValue: 30_000,
    minimum: 1_000,
    maximum: 3_600_000,
    unit: "milliseconds",
  },
  WORDRUSH_WS_HEARTBEAT_MISSES: {
    defaultValue: 2,
    minimum: 1,
    maximum: 10,
    unit: "misses",
  },
});

function invalidRuntimeConfig(name, reason) {
  return new Error(`Invalid ${name}: ${reason}`);
}

function parseIntegerEnv(name, rawValue, spec) {
  if (rawValue === undefined || rawValue === "") return spec.defaultValue;

  const value = String(rawValue);
  if (!/^[+-]?\d+$/.test(value))
    throw invalidRuntimeConfig(name, `expected an integer ${spec.unit}`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw invalidRuntimeConfig(name, "must be a safe integer");
  if (parsed < spec.minimum || parsed > spec.maximum)
    throw invalidRuntimeConfig(
      name,
      `must be between ${spec.minimum} and ${spec.maximum} ${spec.unit}`,
    );
  return parsed;
}

function readRuntimeConfig(env = process.env) {
  return Object.fromEntries(
    Object.entries(RUNTIME_CONFIG_SPECS).map(([name, spec]) => [
      name,
      parseIntegerEnv(name, env[name], spec),
    ]),
  );
}

const runtimeConfig = Object.freeze(readRuntimeConfig());

module.exports = {
  RUNTIME_CONFIG_SPECS,
  parseIntegerEnv,
  readRuntimeConfig,
  runtimeConfig,
};
