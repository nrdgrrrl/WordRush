const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  generateBoardCooperatively,
  getPreparedLexicon,
  getPreparedAnalysisIndex,
} = require("../game-core");
const { getDictionary } = require("../dictionary-registry");
const {
  analyzeBoardCooperatively,
} = require("../board-analysis");

const SCENARIOS = Object.freeze([
  { id: "classic-4x4-min3", mode: "classic", size: 4, minimum: 3 },
  { id: "standard-5x5-min3", mode: "sudden", size: 5, minimum: 3 },
  { id: "dirty-5x5-min3", mode: "dirty", size: 5, minimum: 3 },
  { id: "minimum-6x6-min5", mode: "minimum", size: 6, minimum: 5 },
  { id: "longhaul-6x6-min6", mode: "longhaul", size: 6, minimum: 6 },
  { id: "storm-8x8-min3", mode: "storm", size: 8, minimum: 3 },
]);
const DEFAULT_SAMPLES = 5;
const DEFAULT_SEED = "phase5-analysis-v1";
const PERCENTILES = Object.freeze([0, 50, 90, 100]);
const SUMMARY_METRICS = Object.freeze({
  totalPlayableWords: (record) => record.report.totalPlayableWords,
  longestPlayableLength: (record) => record.report.longestPlayableLength,
  allCoveragePercentage: (record) => record.report.coverage.all.tilePercentage,
  mediumCoveragePercentage: (record) => record.report.coverage.medium.tilePercentage,
  longCoveragePercentage: (record) => record.report.coverage.long.tilePercentage,
  largestUnusedRegion: (record) => record.report.largestConnectedUnusedRegion.size,
  largestLowValueRegion: (record) => record.report.largestLowValueConnectedRegion.size,
  mediumTopQuarterPercentage:
    (record) => record.report.concentration.medium.topQuarterParticipationPercentage,
  longTopQuarterPercentage:
    (record) => record.report.concentration.long.topQuarterParticipationPercentage,
  analysisOperationCount: (record) => record.analysisDiagnostics.operationCount,
  analysisYieldCount: (record) => record.analysisDiagnostics.yieldCount,
  analysisElapsedMs: (record) => record.analysisDiagnostics.elapsedMs,
});

function usageError(message) {
  const error = new Error(message);
  error.code = "CORPUS_ARGUMENT_INVALID";
  return error;
}

function parsePositiveInteger(value, name) {
  if (!/^[0-9]+$/.test(value || "")) throw usageError(name + " must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw usageError(name + " must be a positive integer");
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    samples: DEFAULT_SAMPLES,
    seed: DEFAULT_SEED,
    dictionary: "wordrush-ca-standard-v1",
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith("--"))
      throw usageError(name + " requires a value");
    if (name === "--output") options.output = path.resolve(value);
    else if (name === "--samples") options.samples = parsePositiveInteger(value, "--samples");
    else if (name === "--seed") options.seed = value;
    else if (name === "--dictionary") options.dictionary = value;
    else if (name === "--max-operations")
      options.maxOperations = parsePositiveInteger(value, "--max-operations");
    else if (name === "--operations-per-yield")
      options.operationsPerYield = parsePositiveInteger(value, "--operations-per-yield");
    else throw usageError("unknown argument " + name);
  }
  if (!options.output) throw usageError("--output is required");
  if (!options.seed) throw usageError("--seed must not be empty");
  const parent = path.dirname(options.output);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())
    throw usageError("output parent directory does not exist: " + parent);
  if (fs.existsSync(options.output) && !options.overwrite)
    throw usageError("output exists; pass --overwrite: " + options.output);
  return options;
}

function deriveSeed(baseSeed, scenarioId, sampleIndex) {
  const input = [
    "wordrush-board-corpus-v1",
    baseSeed,
    scenarioId,
    String(sampleIndex),
  ].join("\0");
  return crypto.createHash("sha256").update(input).digest().readUInt32BE(0);
}

function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

function percentileSummary(records) {
  return Object.fromEntries(
    Object.entries(SUMMARY_METRICS).map(([name, read]) => [
      name,
      Object.fromEntries(PERCENTILES.map((percentile) => [
        "p" + percentile,
        nearestRank(records.map(read), percentile),
      ])),
    ]),
  );
}

function summarize(records) {
  return {
    successfulBoards: records.length,
    metrics: percentileSummary(records),
  };
}

function defaultDependencies(dictionaryId) {
  const dictionary = getDictionary(dictionaryId);
  return {
    dictionary: dictionary.metadata,
    async generate(scenario, seed) {
      const prepared = getPreparedLexicon(dictionaryId, scenario.mode === "dirty" ? "dirty" : "classic");
      return generateBoardCooperatively(scenario.size, prepared, {
        mode: scenario.mode === "dirty" ? "dirty" : "classic",
        min: scenario.minimum,
        seed,
      });
    },
    async analyze(scenario, board, limits) {
      return analyzeBoardCooperatively({
        board,
        size: scenario.size,
        minimum: scenario.minimum,
        analysisIndex: getPreparedAnalysisIndex(
          dictionaryId,
          scenario.mode === "dirty" ? "dirty" : "classic",
        ),
        limits,
        dictionary,
        includeSolution: false,
      });
    },
  };
}

async function runCorpus(options, dependencies = defaultDependencies(options.dictionary)) {
  const temporary = options.output + "." + process.pid + ".tmp";
  const records = [];
  const failures = [];
  const scenarios = [];
  const limits = {};
  if (options.maxOperations !== undefined) limits.maxOperations = options.maxOperations;
  if (options.operationsPerYield !== undefined)
    limits.operationsPerYield = options.operationsPerYield;
  for (const scenario of SCENARIOS) {
    scenarios.push({ ...scenario, samples: options.samples });
    for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
      const seed = deriveSeed(options.seed, scenario.id, sampleIndex);
      let generated;
      try {
        generated = await dependencies.generate(scenario, seed);
      } catch (error) {
        failures.push({
          scenarioId: scenario.id,
          sampleIndex,
          seed,
          stage: "generation",
          error: { code: error.code || "GENERATION_EXCEPTION", message: error.message },
        });
        continue;
      }
      if (!generated?.ok) {
        failures.push({
          scenarioId: scenario.id,
          sampleIndex,
          seed,
          stage: "generation",
          error: generated.error || { code: "GENERATION_FAILED" },
          diagnostics: generated.diagnostics,
        });
        continue;
      }
      let analyzed;
      try {
        analyzed = await dependencies.analyze(scenario, generated.board, limits);
      } catch (error) {
        failures.push({
          scenarioId: scenario.id,
          sampleIndex,
          seed,
          stage: "analysis",
          error: { code: error.code || "ANALYSIS_EXCEPTION", message: error.message },
          generationDiagnostics: generated.diagnostics,
        });
        continue;
      }
      if (!analyzed?.ok) {
        failures.push({
          scenarioId: scenario.id,
          sampleIndex,
          seed,
          stage: "analysis",
          error: analyzed.error || { code: "ANALYSIS_FAILED" },
          diagnostics: analyzed.diagnostics,
          generationDiagnostics: generated.diagnostics,
        });
        continue;
      }
      records.push({
        scenarioId: scenario.id,
        sampleIndex,
        seed,
        board: generated.board.join(""),
        boardRows: Array.from(
          { length: scenario.size },
          (_, row) => generated.board.slice(row * scenario.size, (row + 1) * scenario.size).join(""),
        ),
        boardFingerprint: analyzed.diagnostics.boardFingerprint,
        generationDiagnostics: generated.diagnostics,
        analysisDiagnostics: analyzed.diagnostics,
        report: analyzed.report,
      });
    }
  }
  const output = {
    schemaVersion: 1,
    parameters: {
      baseSeed: options.seed,
      samplesPerScenario: options.samples,
      dictionaryId: options.dictionary,
      generationLimits: null,
      analysisLimits: limits,
    },
    dictionary: dependencies.dictionary,
    scenarios,
    boards: records,
    failures,
    summary: {
      overall: summarize(records),
      byScenario: Object.fromEntries(
        SCENARIOS.map((scenario) => [
          scenario.id,
          summarize(records.filter((record) => record.scenarioId === scenario.id)),
        ]),
      ),
    },
  };
  try {
    fs.writeFileSync(temporary, JSON.stringify(output, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporary, options.output);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return output;
}

if (require.main === module) {
  let options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  if (options) {
    runCorpus(options)
      .then((output) => {
        console.log(
          "Wrote " + output.boards.length + " boards and " +
          output.failures.length + " failures to " + options.output,
        );
        if (output.failures.length) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  DEFAULT_SEED,
  PERCENTILES,
  SCENARIOS,
  deriveSeed,
  nearestRank,
  parseArgs,
  percentileSummary,
  runCorpus,
};
