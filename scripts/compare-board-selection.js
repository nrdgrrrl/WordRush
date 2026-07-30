const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  generateBoardCooperatively,
  getPreparedAnalysisIndex,
  getPreparedLexicon,
} = require("../game-core");
const { getDictionary } = require("../dictionary-registry");
const { analyzeBoardCooperatively } = require("../board-analysis");
const { configForPreset } = require("../game-config");
const { boardGenerationContract } = require("../server");
const { selectRoundBoard } = require("../board-selector");
const { evaluateBoardQuality, getQualityProfile } = require("../board-quality");

const SCENARIOS = Object.freeze([
  { id: "classic-4x4-min3", preset: "classic", mode: "classic", size: 4, minimum: 3 },
  { id: "standard-5x5-min3", preset: "sudden", mode: "classic", size: 5, minimum: 3 },
  { id: "dirty-5x5-min3", preset: "dirty", mode: "dirty", size: 5, minimum: 3 },
  { id: "minimum-6x6-min5", preset: "minimum", mode: "classic", size: 6, minimum: 5 },
  { id: "longhaul-6x6-min6", preset: "longhaul", mode: "classic", size: 6, minimum: 6 },
  { id: "storm-8x8-min3", preset: "storm", mode: "classic", size: 8, minimum: 3 },
]);
const STRATEGIES = Object.freeze([1, 2, 4, 6]);
const DEFAULT_SAMPLES = 10;
const DEFAULT_SEED = "phase5-selection-comparison-v1";
const PERCENTILES = Object.freeze([0, 10, 50, 90, 100]);

function usageError(message) {
  const error = new Error(message);
  error.code = "COMPARISON_ARGUMENT_INVALID";
  return error;
}
function parsePositiveInteger(value, name) {
  if (!/^[0-9]+$/.test(value || "")) throw usageError(name + " must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw usageError(name + " must be a positive integer");
  return parsed;
}
function parseArgs(argv = process.argv.slice(2)) {
  const options = { samples: DEFAULT_SAMPLES, seed: DEFAULT_SEED };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index], equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith("--")) throw usageError(name + " requires a value");
    if (name === "--output") options.output = path.resolve(value);
    else if (name === "--samples") options.samples = parsePositiveInteger(value, "--samples");
    else if (name === "--seed") options.seed = value;
    else throw usageError("unknown argument " + name);
  }
  if (!options.output) throw usageError("--output is required");
  if (!options.seed) throw usageError("--seed must not be empty");
  if (!fs.existsSync(path.dirname(options.output)))
    throw usageError("output parent directory does not exist");
  return options;
}
function deriveSeed(baseSeed, scenarioId, sampleIndex) {
  return crypto.createHash("sha256").update([
    "wordrush-board-corpus-v1", baseSeed, scenarioId, String(sampleIndex),
  ].join("\0")).digest().readUInt32BE(0);
}
function selectionLimits(candidateCount) {
  const scale = Math.max(1, candidateCount / 4);
  return {
    maxCandidates: candidateCount,
    totalGenerationAttempts: Math.ceil(128 * scale),
    totalPlacementOperations: Math.ceil(1_000_000 * scale),
    totalGenerationBacktracks: Math.ceil(500_000 * scale),
    totalAnalysisOperations: Math.ceil(1_250_000 * scale),
    totalYields: Math.ceil(1_024 * scale),
  };
}
function boardRows(board, size) {
  return Array.from({ length: size }, (_, row) =>
    board.slice(row * size, (row + 1) * size).join(""));
}
function percentile(values, point) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * point / 100) - 1)];
}
function metricSummary(records) {
  const names = ["totalWords", "mediumWords", "longWords", "ninePlusWords", "longestLength", "allCoverage", "mediumCoverage", "longCoverage", "unusedRegion", "lowValueRegion", "longSpatialReach", "mediumConcentrationPpm", "longConcentrationPpm"];
  return Object.fromEntries(names.map((name) => [
    name,
    Object.fromEntries(PERCENTILES.map((point) => [
      "p" + point,
      percentile(records.map((record) => record.metrics[name]), point),
    ])),
  ]));
}
function costSummary(records) {
  const fields = ["generationAttempts", "placementOperations", "generationBacktracks", "analysisOperations", "cooperativeYields", "elapsedMs"];
  return Object.fromEntries(fields.map((field) => [
    field,
    Object.fromEntries(PERCENTILES.map((point) => [
      "p" + point,
      percentile(records.map((record) => record.cost[field]), point),
    ])),
  ]));
}
function summary(records, candidateCount) {
  const unique = new Set(records.map((record) => record.fingerprint));
  return {
    candidateCount,
    samples: records.length,
    hardGatePassRate: records.length ? records.filter((record) => record.passed).length / records.length : 0,
    noPassingCandidateRate: records.length ? records.filter((record) => !record.passed).length / records.length : 0,
    uniqueFingerprints: unique.size,
    duplicateFingerprintCount: records.length - unique.size,
    metrics: metricSummary(records.filter((record) => record.passed)),
    cost: costSummary(records),
  };
}

async function analyze(scenario, board, contract, analysisIndex, dictionary) {
  return analyzeBoardCooperatively({
    board,
    size: scenario.size,
    minimum: scenario.minimum,
    analysisIndex,
    dictionary,
    includeSolution: false,
  });
}

async function runComparison(options) {
  const dictionaryId = "wordrush-ca-standard-v1";
  const dictionary = getDictionary(dictionaryId);
  const records = Object.fromEntries(STRATEGIES.map((count) => [count, []]));
  const representatives = [];
  for (const scenario of SCENARIOS) {
    const config = configForPreset(scenario.preset);
    const contract = boardGenerationContract(config, dictionaryId);
    const prepared = getPreparedLexicon(dictionaryId, scenario.mode);
    const analysisIndex = getPreparedAnalysisIndex(dictionaryId, scenario.mode);
    const profile = getQualityProfile(scenario.size, scenario.minimum, contract.validationMode);
    for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
      const requestedSeed = deriveSeed(options.seed, scenario.id, sampleIndex);
      const startedAt = Date.now();
      const generated = await generateBoardCooperatively(scenario.size, prepared, {
        mode: scenario.mode,
        min: scenario.minimum,
        seed: requestedSeed,
      });
      const analyzed = generated.ok
        ? await analyze(scenario, generated.board, contract, analysisIndex, dictionary)
        : { ok: false, diagnostics: {} };
      const firstEvaluation = analyzed.ok
        ? evaluateBoardQuality(analyzed.report, profile, analyzed.diagnostics.boardFingerprint)
        : null;
      const first = {
        scenarioId: scenario.id,
        sampleIndex,
        requestedSeed,
        board: generated.board,
        fingerprint: analyzed.diagnostics?.boardFingerprint || null,
        passed: firstEvaluation?.passed || false,
        metrics: firstEvaluation?.metrics || {},
        cost: {
          generationAttempts: generated.diagnostics?.attemptCount || 0,
          placementOperations: generated.diagnostics?.placementOperationCount || 0,
          generationBacktracks: generated.diagnostics?.backtrackCount || 0,
          analysisOperations: analyzed.diagnostics?.operationCount || 0,
          cooperativeYields: (generated.diagnostics?.yieldCount || 0) + (analyzed.diagnostics?.yieldCount || 0),
          elapsedMs: Date.now() - startedAt,
        },
      };
      records[1].push(first);
      for (const candidateCount of STRATEGIES.slice(1)) {
        const selection = await selectRoundBoard(contract, {
          requestedSeed,
          candidateCount,
          limits: selectionLimits(candidateCount),
        });
        const selected = selection.ok ? {
          scenarioId: scenario.id,
          sampleIndex,
          requestedSeed,
          board: selection.board,
          fingerprint: selection.diagnostics.selectedFingerprint,
          passed: true,
          metrics: evaluateBoardQuality(selection.report, profile, selection.diagnostics.selectedFingerprint).metrics,
          cost: {
            ...selection.diagnostics.aggregateWork,
            elapsedMs: selection.diagnostics.elapsedMs,
          },
        } : {
          scenarioId: scenario.id,
          sampleIndex,
          requestedSeed,
          board: null,
          fingerprint: null,
          passed: false,
          metrics: {},
          cost: { ...selection.diagnostics.aggregateWork, elapsedMs: selection.diagnostics.elapsedMs },
        };
        records[candidateCount].push(selected);
        if (sampleIndex < 2 && selected.board && selected.fingerprint !== first.fingerprint)
          representatives.push({
            scenarioId: scenario.id,
            candidateCount,
            requestedSeed,
            first: { boardRows: boardRows(first.board, scenario.size), fingerprint: first.fingerprint, metrics: first.metrics },
            selected: { boardRows: boardRows(selected.board, scenario.size), fingerprint: selected.fingerprint, metrics: selected.metrics },
          });
      }
      console.log(scenario.id + " sample " + (sampleIndex + 1) + "/" + options.samples);
    }
  }
  return {
    schemaVersion: 1,
    parameters: { baseSeed: options.seed, samplesPerScenario: options.samples, dictionaryId, strategies: STRATEGIES },
    scenarios: SCENARIOS,
    strategies: Object.fromEntries(STRATEGIES.map((count) => [count, {
      overall: summary(records[count], count),
      byScenario: Object.fromEntries(SCENARIOS.map((scenario) => [
        scenario.id,
        summary(records[count].filter((record) => record.scenarioId === scenario.id), count),
      ])),
    }])),
    representatives,
  };
}

if (require.main === module) {
  let options;
  try { options = parseArgs(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options) runComparison(options).then((output) => {
    fs.writeFileSync(options.output, JSON.stringify(output, null, 2) + "\n");
    console.log("Wrote comparison to " + options.output);
  }).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { SCENARIOS, STRATEGIES, deriveSeed, parseArgs, runComparison };
