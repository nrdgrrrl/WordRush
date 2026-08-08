const fs = require("node:fs");
const path = require("node:path");

const CATALOG_ROOT = path.join(__dirname, "games");
const KINDS = new Set(["preset", "challenge", "builder", "multiplayer"]);
const REQUIRED_FIELDS = Object.freeze([
  "key",
  "name",
  "tagline",
  "route",
  "mechanicsKey",
  "kind",
  "availability",
]);
const AVAILABILITY_FIELDS = Object.freeze(["solo", "multiplayer", "shareable"]);

function invalid(source, message) {
  throw new Error(`Invalid game manifest (${source}): ${message}`);
}

function hasOnlyFields(value, fields) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function validDisplayText(value, maximumLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\r\n\t]/.test(value);
}

function validateManifest(raw, source, folderName) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    invalid(source, "manifest must be an object");
  if (!hasOnlyFields(raw, REQUIRED_FIELDS))
    invalid(source, `fields must be exactly: ${REQUIRED_FIELDS.join(", ")}`);
  if (typeof raw.key !== "string" || !/^[a-z][a-z0-9-]*$/.test(raw.key))
    invalid(source, "key must be a lowercase kebab-case identifier");
  if (raw.key !== folderName)
    invalid(source, "key must match its containing folder name");
  if (!validDisplayText(raw.name, 80) || !/^[A-Z0-9]/.test(raw.name))
    invalid(source, "name must be a trimmed public display name");
  if (!validDisplayText(raw.tagline, 240))
    invalid(source, "tagline must be trimmed discovery copy");
  if (raw.route !== null &&
    (typeof raw.route !== "string" || !/^\/games\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.route)))
    invalid(source, "route must be a /games/<slug> path or null");
  if (raw.mechanicsKey !== null &&
    (typeof raw.mechanicsKey !== "string" || !/^[a-z][a-z0-9_]*$/.test(raw.mechanicsKey)))
    invalid(source, "mechanicsKey must be a MODE_CONFIG-style key or null");
  if (!KINDS.has(raw.kind))
    invalid(source, "kind must be preset, challenge, builder, or multiplayer");
  if (raw.kind === "preset" && raw.mechanicsKey === null)
    invalid(source, "preset entries require a mechanicsKey");
  if (raw.kind === "builder" && raw.mechanicsKey !== null)
    invalid(source, "builder entries must not claim a mechanicsKey");
  if (!raw.availability || typeof raw.availability !== "object" || Array.isArray(raw.availability) ||
    !hasOnlyFields(raw.availability, AVAILABILITY_FIELDS))
    invalid(source, `availability fields must be exactly: ${AVAILABILITY_FIELDS.join(", ")}`);
  if (!AVAILABILITY_FIELDS.every((field) => typeof raw.availability[field] === "boolean"))
    invalid(source, "availability values must be booleans");
  if (!raw.availability.solo && !raw.availability.multiplayer)
    invalid(source, "a public game must be available solo or multiplayer");
  if (raw.availability.shareable && !raw.availability.solo)
    invalid(source, "shareable entries must support solo play");
  if (raw.kind === "multiplayer" && !raw.availability.multiplayer)
    invalid(source, "multiplayer entries must support multiplayer");

  return Object.freeze({
    key: raw.key,
    name: raw.name,
    tagline: raw.tagline,
    route: raw.route,
    mechanicsKey: raw.mechanicsKey,
    kind: raw.kind,
    availability: Object.freeze({ ...raw.availability }),
  });
}

function loadCatalog(root = CATALOG_ROOT) {
  const folders = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!folders.length) throw new Error(`No game manifests found in ${root}`);

  const rawManifests = folders.map((folder) => {
    const filename = path.join(root, folder, "manifest.json");
    if (!fs.existsSync(filename)) invalid(path.relative(__dirname, filename), "manifest.json is required");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      invalid(path.relative(__dirname, filename), `JSON could not be parsed (${error.message})`);
    }
    return { raw, source: path.relative(__dirname, filename), folder };
  });
  const rawKeys = new Set();
  for (const { raw, source } of rawManifests) {
    if (raw && typeof raw === "object" && typeof raw.key === "string") {
      if (rawKeys.has(raw.key)) invalid(source, `duplicate catalog key ${raw.key}`);
      rawKeys.add(raw.key);
    }
  }
  const games = rawManifests.map(({ raw, source, folder }) =>
    validateManifest(raw, source, folder),
  );

  const byKey = new Map();
  const byName = new Map();
  const byRoute = new Map();
  const mechanicsMatches = new Map();
  for (const game of games) {
    if (byKey.has(game.key)) invalid(game.key, "duplicate catalog key");
    byKey.set(game.key, game);
    if (byName.has(game.name)) invalid(game.key, `duplicate public name ${game.name}`);
    byName.set(game.name, game);
    if (game.route !== null) {
      if (byRoute.has(game.route)) invalid(game.key, `duplicate public route ${game.route}`);
      byRoute.set(game.route, game);
    }
    if (game.mechanicsKey !== null) {
      const matches = mechanicsMatches.get(game.mechanicsKey) || [];
      matches.push(game);
      mechanicsMatches.set(game.mechanicsKey, matches);
    }
  }

  const byMechanicsKey = new Map(
    [...mechanicsMatches].map(([mechanicsKey, matches]) => [
      mechanicsKey,
      matches.length === 1 ? matches[0] : null,
    ]),
  );
  const all = Object.freeze(games);
  return Object.freeze({
    all,
    byKey(key) {
      return byKey.get(key) || null;
    },
    byRoute(route) {
      return byRoute.get(route) || null;
    },
    byMechanicsKey(mechanicsKey) {
      return byMechanicsKey.get(mechanicsKey) || null;
    },
  });
}

function renderBrowserCatalogScript(catalog = GAME_CATALOG) {
  const games = JSON.stringify(catalog.all);
  return `(() => {\n` +
    `  const all = Object.freeze(${games}.map((game) => Object.freeze({ ...game, availability: Object.freeze({ ...game.availability }) })));\n` +
    `  const byKey = new Map(all.map((game) => [game.key, game]));\n` +
    `  const byRoute = new Map(all.filter((game) => game.route !== null).map((game) => [game.route, game]));\n` +
    `  const mechanicsMatches = new Map();\n` +
    `  for (const game of all) if (game.mechanicsKey !== null) {\n` +
    `    const matches = mechanicsMatches.get(game.mechanicsKey) || [];\n` +
    `    matches.push(game);\n` +
    `    mechanicsMatches.set(game.mechanicsKey, matches);\n` +
    `  }\n` +
    `  globalThis.WordrushGameCatalog = Object.freeze({\n` +
    `    all,\n` +
    `    byKey: (key) => byKey.get(key) || null,\n` +
    `    byRoute: (route) => byRoute.get(route) || null,\n` +
    `    byMechanicsKey: (key) => mechanicsMatches.get(key)?.length === 1 ? mechanicsMatches.get(key)[0] : null,\n` +
    `  });\n` +
    `})();\n`;
}

const GAME_CATALOG = loadCatalog();

module.exports = Object.freeze({
  ...GAME_CATALOG,
  loadCatalog,
  renderBrowserCatalogScript,
});
