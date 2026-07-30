#!/usr/bin/env node

// Development-only evidence command. It deliberately writes no repository
// artifacts and is not part of npm test.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const WebSocket = require("ws");
const { DEFAULT_DICTIONARY_ID, getDictionary } = require("../dictionary-registry");
const {
  getPreparedAnalysisIndex,
  getPreparedLexicon,
} = require("../game-core");
const { DEFAULT_SELECTOR_LIMITS, selectRoundBoard } = require("../board-selector");
const { getQualityProfile, NAMED_PROFILES } = require("../board-quality");
const {
  generateQualityRoundBoard,
  DEFAULT_PRODUCTION_CANDIDATE_COUNT,
  PRODUCTION_CANDIDATE_COUNTS,
  PRODUCTION_SELECTOR_VERSION,
  scaleSelectorLimits,
} = require("../production-board-generator");

const ACCEPTANCE_LIMITS = Object.freeze({
  medianMs: 250,
  p90Ms: 500,
  p95Ms: 750,
  maximumMs: 1_500,
  eventLoopDelayMs: 100,
});
const SEED_BASE = 0x5eed7700;
const SEED_STEP = 0x9e3779b9;
const MODES = ["classic", "dirty"];
const UNMEASURED_SMOKE_LIMITS = Object.freeze({
  ...DEFAULT_SELECTOR_LIMITS,
  maxCandidates: 4,
  totalGenerationAttempts: 8,
  totalPlacementOperations: 100_000,
  totalGenerationBacktracks: 50_000,
  perCandidateAnalysisOperations: 50_000,
  totalAnalysisOperations: 100_000,
  totalYields: 64,
  operationsPerYield: 2_048,
});

function usage() {
  console.log(`Usage: node scripts/quality-gate.js [options]

Options:
  --mode measure|smoke  measure named profiles or run smoke corpora (default: measure)
  --scope all|production|smoke  select production, smoke, or both (default: all)
  --samples N           fixed seeds per measured profile (default: 100)
  --http-samples N      solo HTTP and multiplayer samples (default: 3)
  --output PATH         write JSON evidence to an explicitly supplied path
  --skip-http           omit HTTP and WebSocket integration measurements
  --help                show this help

Smoke mode covers every measured supplementary profile and unmeasured sizes
4-8, minimums 7-12, classic/Dirty combinations with three fixed seeds each.`);
}

function parseArgs(argv) {
  const options = {
    mode: "measure",
    scope: "all",
    samples: 100,
    httpSamples: 3,
    output: null,
    skipHttp: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--skip-http") {
      options.skipHttp = true;
      continue;
    }
    const [key, inline] = arg.split("=", 2);
    const value = inline ?? argv[++index];
    if (key === "--mode") options.mode = value;
    else if (key === "--scope") options.scope = value;
    else if (key === "--samples") options.samples = Number(value);
    else if (key === "--http-samples") options.httpSamples = Number(value);
    else if (key === "--output") options.output = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["measure", "smoke"].includes(options.mode))
    throw new Error("--mode must be measure or smoke");
  if (!["all", "production", "smoke"].includes(options.scope))
    throw new Error("--scope must be all, production, or smoke");
  for (const [name, value] of Object.entries(options))
    if (["samples", "httpSamples"].includes(name) &&
        (!Number.isInteger(value) || value < 1))
      throw new Error(`${name} must be a positive integer`);
  return options;
}

function fixedSeed(index, salt = 0) {
  return (SEED_BASE + Math.imul(index + salt, SEED_STEP)) >>> 0;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, position)];
}

function latencySummary(values) {
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95),
    maximumMs: values.length ? Math.max(...values) : null,
  };
}

function contractFor(size, minimum, validationMode) {
  const dictionary = getDictionary(DEFAULT_DICTIONARY_ID);
  return {
    size,
    minimum,
    validationMode,
    dictionary,
    prepared: getPreparedLexicon(dictionary.id, validationMode),
  };
}

function eventLoopSummary(delay) {
  if (!delay) return null;
  return {
    mean: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null,
    p95: Number.isFinite(delay.percentile(95)) ? delay.percentile(95) / 1e6 : null,
    p99: Number.isFinite(delay.percentile(99)) ? delay.percentile(99) / 1e6 : null,
    maximum: Number.isFinite(delay.max) ? delay.max / 1e6 : null,
  };
}

async function selectOne({ size, minimum, validationMode, requestedSeed, candidateCount, production, limits, includeDetails = true }) {
  const contract = contractFor(size, minimum, validationMode);
  const started = performance.now();
  let result;
  try {
    if (production) {
      result = await generateQualityRoundBoard(contract, { requestedSeed });
    } else {
      result = await selectRoundBoard(contract, {
        requestedSeed,
        candidateCount,
        limits: limits || scaleSelectorLimits(candidateCount),
        analysisIndex: getPreparedAnalysisIndex(contract.dictionary.id, validationMode),
      });
    }
  } catch (error) {
    result = {
      ok: false,
      error: { code: "UNEXPECTED_EXCEPTION", message: error.message },
      diagnostics: {},
    };
  }
  const elapsedMs = performance.now() - started;
  const diagnostics = result.diagnostics || {};
  const work = diagnostics.aggregateWork || {};
  return {
    profileId: diagnostics.profileId || getQualityProfile(size, minimum, validationMode)?.profileId || null,
    requestedSeed,
    candidateCount,
    ok: Boolean(result.ok),
    errorCode: result.ok ? null : result.error?.code || "UNEXPECTED_EXCEPTION",
    elapsedMs,
    selectedCandidateIndex: diagnostics.selectedCandidateIndex ?? null,
    selectedCandidateSeed: result.selectedCandidateSeed ?? diagnostics.selectedCandidateSeed ?? null,
    selectedFingerprint: diagnostics.selectedFingerprint ?? null,
    ranking: diagnostics.selectedRanking ?? null,
    candidateSeeds: diagnostics.candidateSeeds || [],
    ...(includeDetails ? { candidateOutcomes: diagnostics.candidates || [] } : {}),
    generationAttempts: work.generationAttempts || 0,
    placementOperations: work.placementOperations || 0,
    generationBacktracks: work.generationBacktracks || 0,
    analysisOperations: work.analysisOperations || 0,
    cooperativeYields: work.cooperativeYields || 0,
  };
}

function measuredSupplementaryProfiles() {
  const named = new Set(Object.keys(NAMED_PROFILES));
  const profiles = [];
  for (const size of [4, 5, 6, 7, 8]) {
    for (const minimum of Array.from({ length: 10 }, (_, index) => index + 3)) {
      for (const validationMode of MODES) {
        const profile = getQualityProfile(size, minimum, validationMode);
        if (profile?.measured && !named.has(profile.profileId)) profiles.push(profile);
      }
    }
  }
  return profiles;
}

function unmeasuredSmokeProfiles() {
  // Small reproducible representative set: the diagonal covers every size
  // 4-8 and every minimum 7-12 without creating a 60-profile Cartesian run.
  const cases = [
    [4, 7], [5, 8], [6, 9], [7, 10], [8, 11], [8, 12],
  ];
  const profiles = [];
  for (const [size, minimum] of cases) {
    for (const validationMode of MODES) {
      const profile = getQualityProfile(size, minimum, validationMode);
      if (profile && !profile.measured) profiles.push(profile);
    }
  }
  return profiles;
}

async function runProfileCorpus(
  profiles,
  samples,
  production,
  candidateCountFor,
  limits = null,
  { isolatedEventLoop = false, retainDetails = false } = {},
) {
  const results = [];
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    const profile = profiles[profileIndex];
    const records = [];
    const profileDelay = isolatedEventLoop
      ? monitorEventLoopDelay({ resolution: 10 })
      : null;
    profileDelay?.enable();
    try {
      for (let index = 0; index < samples; index++) {
        records.push(await selectOne({
          size: profile.size,
          minimum: profile.minimum,
          validationMode: profile.validationMode,
          requestedSeed: fixedSeed(index, profileIndex * 97),
          candidateCount: candidateCountFor(profile),
          production,
          limits,
          includeDetails: retainDetails,
        }));
      }
    } finally {
      profileDelay?.disable();
    }
    const latencies = records.map((record) => record.elapsedMs);
    results.push({
      profileId: profile.profileId,
      size: profile.size,
      minimum: profile.minimum,
      validationMode: profile.validationMode,
      measured: profile.measured === true,
      candidateCount: candidateCountFor(profile),
      successCount: records.filter((record) => record.ok).length,
      noPassCount: records.filter((record) => record.errorCode === "NO_QUALITY_CANDIDATE").length,
      unexpectedExceptionCount: records.filter((record) => record.errorCode === "UNEXPECTED_EXCEPTION" || record.errorCode === "QUALITY_SELECTION_EXCEPTION").length,
      latency: latencySummary(latencies),
      generationAttempts: records.reduce((sum, record) => sum + record.generationAttempts, 0),
      placementOperations: records.reduce((sum, record) => sum + record.placementOperations, 0),
      generationBacktracks: records.reduce((sum, record) => sum + record.generationBacktracks, 0),
      analysisOperations: records.reduce((sum, record) => sum + record.analysisOperations, 0),
      cooperativeYields: records.reduce((sum, record) => sum + record.cooperativeYields, 0),
      ...(profileDelay ? { eventLoopDelayMs: eventLoopSummary(profileDelay) } : {}),
      ...(retainDetails ? { records } : {}),
    });
  }
  return results;
}

async function httpPost(port, body) {
  const started = performance.now();
  return new Promise((resolve) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/solo-board",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({
        status: response.statusCode,
        elapsedMs: performance.now() - started,
      }));
    });
    request.once("error", (error) => resolve({
      status: 0,
      error: error.message,
      elapsedMs: performance.now() - started,
    }));
    request.end(JSON.stringify(body));
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      ws.terminate();
      reject(new Error("Timed out waiting for WebSocket evidence"));
    }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

async function multiplayerQueueMeasurement(port, mode = "classic") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", guestId: `quality-gate-${Date.now()}` }));
  await waitForMessage(ws, (message) => message.type === "hello_ack");
  ws.send(JSON.stringify({ type: "create_room" }));
  const created = await waitForMessage(ws, (message) => message.type === "room_created");
  const startedAt = performance.now();
  const order = [];
  let queuedActionAt = null;
  let roundStartedAt = null;
  const orderListener = (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const receivedAt = performance.now();
    if (message.type === "round_started") {
      if (roundStartedAt === null) roundStartedAt = receivedAt;
      order.push("round_started");
    }
    if (message.type === "room_state" && message.players?.some((player) => player.name === `queued-${mode}`)) {
      if (queuedActionAt === null) queuedActionAt = receivedAt;
      order.push("queued_action");
    }
  };
  ws.on("message", orderListener);
  const updatePromise = waitForMessage(ws, (message) =>
    message.type === "room_state" && message.players?.some((player) => player.name === `queued-${mode}`), 60_000);
  const startedPromiseLong = waitForMessage(ws, (message) => message.type === "round_started", 60_000);
  ws.send(JSON.stringify({ type: "start_game", mode }));
  ws.send(JSON.stringify({ type: "update_identity", name: `queued-${mode}`, avatar: "🐸" }));
  const [started, updated] = await Promise.all([startedPromiseLong, updatePromise]);
  const result = {
    roomCode: created.code,
    mode,
    roundStarted: Boolean(started.round),
    queuedActionLatencyMs: queuedActionAt === null ? null : queuedActionAt - startedAt,
    roundStartedLatencyMs: roundStartedAt === null ? null : roundStartedAt - startedAt,
    queuedActionBeforeRound: queuedActionAt !== null && roundStartedAt !== null &&
      queuedActionAt < roundStartedAt,
    updatedStateReceived: Boolean(updated),
    eventOrder: order,
  };
  ws.off("message", orderListener);
  // This is an isolated measurement socket; terminate it so server.close()
  // cannot wait on a graceful-close handshake after evidence is captured.
  ws.terminate();
  return result;
}

async function integrationMeasurement(sampleCount) {
  const serverModule = require("../server");
  const { server } = serverModule;
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  try {
    const solo = [];
    for (let index = 0; index < sampleCount; index++)
      solo.push(await httpPost(port, { mode: "classic", dictionaryId: DEFAULT_DICTIONARY_ID }));
    const multiplayer = {};
    for (const mode of ["classic", "storm", "longhaul"]) {
      try {
        multiplayer[mode] = await multiplayerQueueMeasurement(port, mode);
      } catch (error) {
        multiplayer[mode] = { mode, error: error.message };
      }
    }
    return {
      solo: {
        samples: solo.length,
        statuses: solo.reduce((counts, result) => {
          counts[result.status] = (counts[result.status] || 0) + 1;
          return counts;
        }, {}),
        latency: latencySummary(solo.map((result) => result.elapsedMs)),
        records: solo,
      },
      multiplayer,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const harnessDelay = monitorEventLoopDelay({ resolution: 10 });
  harnessDelay.enable();
  const memoryBefore = process.memoryUsage();
  const startedAt = new Date().toISOString();
  const namedProfiles = Object.values(NAMED_PROFILES);
  const supplementaryProfiles = measuredSupplementaryProfiles();
  const unmeasuredProfiles = unmeasuredSmokeProfiles();
  const candidateCountFor = (profile) =>
    Object.hasOwn(PRODUCTION_CANDIDATE_COUNTS, profile.profileId)
      ? PRODUCTION_CANDIDATE_COUNTS[profile.profileId]
      : DEFAULT_PRODUCTION_CANDIDATE_COUNT;
  const report = {
    schemaVersion: "wordrush-quality-gate-v1",
    generatedAt: startedAt,
    selectorVersion: PRODUCTION_SELECTOR_VERSION,
    mode: options.mode,
    scope: options.scope,
    fixedSeedBase: SEED_BASE,
    fixedSeedStep: SEED_STEP,
    acceptanceLimits: ACCEPTANCE_LIMITS,
    policy: {
      productionCandidateCount: DEFAULT_PRODUCTION_CANDIDATE_COUNT,
      productionCandidateCounts: Object.fromEntries(
        Object.entries(PRODUCTION_CANDIDATE_COUNTS),
      ),
      longHaulComparison: "best-of-4 versus best-of-6 with identical requested seeds",
      unmeasuredProductionEnabled: false,
    },
    named: [],
    supplementary: [],
    unmeasured: [],
    longHaulComparison: null,
    integration: null,
  };

  const runProduction = options.scope !== "smoke";
  const runSmoke = options.scope !== "production";
  if (runProduction && options.mode === "measure") {
    report.named = await runProfileCorpus(
      namedProfiles,
      options.samples,
      true,
      candidateCountFor,
      null,
      { isolatedEventLoop: true, retainDetails: Boolean(options.output) },
    );
    const longHaul = namedProfiles.find((profile) => profile.profileId === "6x6-min6");
    const seeds = Array.from({ length: options.samples }, (_, index) => fixedSeed(index, namedProfiles.indexOf(longHaul) * 97));
    const comparison = {};
    for (const candidateCount of [4, 6]) {
      const comparisonDelay = monitorEventLoopDelay({ resolution: 10 });
      comparisonDelay.enable();
      const records = [];
      for (const requestedSeed of seeds)
        records.push(await selectOne({
          size: longHaul.size,
          minimum: longHaul.minimum,
          validationMode: longHaul.validationMode,
          requestedSeed,
          candidateCount,
          production: false,
        }));
      comparisonDelay.disable();
      comparison[candidateCount] = {
        candidateCount,
        successCount: records.filter((record) => record.ok).length,
        noPassCount: records.filter((record) => record.errorCode === "NO_QUALITY_CANDIDATE").length,
        latency: latencySummary(records.map((record) => record.elapsedMs)),
        eventLoopDelayMs: eventLoopSummary(comparisonDelay),
        ...(options.output ? { records } : {}),
      };
    }
    report.longHaulComparison = comparison;
  }
  if (runSmoke) {
    report.supplementary = await runProfileCorpus(
      supplementaryProfiles,
      3,
      false,
      candidateCountFor,
      UNMEASURED_SMOKE_LIMITS,
      { retainDetails: Boolean(options.output) },
    );
    report.unmeasured = await runProfileCorpus(
      unmeasuredProfiles,
      3,
      false,
      candidateCountFor,
      UNMEASURED_SMOKE_LIMITS,
      { retainDetails: Boolean(options.output) },
    );
  }
  if (!options.skipHttp) report.integration = await integrationMeasurement(options.httpSamples);
  harnessDelay.disable();
  const memoryAfter = process.memoryUsage();
  report.runtime = {
    harnessEventLoopDelay: eventLoopSummary(harnessDelay),
    memoryBefore: memoryBefore,
    memoryAfter: memoryAfter,
    rssDelta: memoryAfter.rss - memoryBefore.rss,
    heapUsedDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
  };
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
    report.output = outputPath;
  }
  console.log(JSON.stringify({
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    output: report.output || null,
    named: report.named.map(({ profileId, successCount, noPassCount, latency, eventLoopDelayMs }) => ({ profileId, successCount, noPassCount, latency, eventLoopDelayMs })),
    longHaulComparison: report.longHaulComparison && Object.fromEntries(
      Object.entries(report.longHaulComparison).map(([count, value]) => [count, {
        successCount: value.successCount,
        noPassCount: value.noPassCount,
        latency: value.latency,
        eventLoopDelayMs: value.eventLoopDelayMs,
      }]),
    ),
    supplementaryProfiles: report.supplementary.length,
    unmeasuredProfiles: report.unmeasured.length,
    integration: report.integration,
    runtime: report.runtime,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
