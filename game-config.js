(function exposeWordrushConfig(root, factory) {
  const config = factory();
  if (typeof module === "object" && module.exports) module.exports = config;
  else root.WordrushConfig = config;
})(globalThis, () => {
  const MODE_CONFIG = {
    classic: {
      label: "CLASSIC",
      min: 3,
      size: 4,
      seconds: 120,
      rule: "Free play \u00b7 2 minutes",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    minimum: {
      label: "MINIMUM WORD",
      min: 5,
      size: 6,
      seconds: 180,
      rule: "Minimum 5 letters",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    sudden: {
      label: "SUDDEN DEATH",
      min: 3,
      size: 5,
      seconds: 180,
      rule: "One invalid word ends the round",
      target: null,
      sudden: true,
      chain: false,
      adult: false,
      party: false,
    },
    race: {
      label: "RACE MODE",
      min: 3,
      size: 4,
      seconds: 240,
      rule: "First to 500 points wins",
      target: 500,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    coop: {
      label: "CO-OP",
      min: 3,
      size: 4,
      seconds: 120,
      rule: "Shared team score \u00b7 find words together",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    dirty: {
      label: "DIRTY MODE \u00b7 18+",
      min: 3,
      size: 5,
      seconds: 180,
      rule: "Opt-in adult dictionary",
      target: null,
      sudden: false,
      chain: false,
      adult: true,
      party: false,
    },
    blitz: {
      label: "BLITZ",
      min: 3,
      size: 4,
      seconds: 60,
      rule: "60 seconds \u00b7 lightning-fast words",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    longhaul: {
      label: "LONG HAUL",
      min: 6,
      size: 6,
      seconds: 180,
      rule: "Minimum 6 letters \u00b7 big words only",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    storm: {
      label: "LETTER STORM",
      min: 3,
      size: 8,
      seconds: 120,
      rule: "8\u00d78 grid \u00b7 hunt everywhere",
      target: null,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    scoreattack: {
      label: "SCORE ATTACK",
      min: 3,
      size: 5,
      seconds: 150,
      rule: "First to 250 points wins",
      target: 250,
      sudden: false,
      chain: false,
      adult: false,
      party: false,
    },
    chain: {
      label: "WORD CHAIN",
      min: 3,
      size: 5,
      seconds: 180,
      rule: "Each word starts with the last word\u2019s letter",
      target: null,
      sudden: false,
      chain: true,
      adult: false,
      party: false,
    },
  };
  const DEFAULT_DICTIONARY_ID = "wordrush-ca-standard-v1";
  const COMMON_WORDS =
    "CAT DOG MAP SUN RED FOX STAR STARE STONE LINE LINES LION PLACE SPACE MOUSE MUSES STREAM WORDS RUSH BRAIN TRACE FIRE FINE SCORE RAIN TRAIN STAIR TONE NOTE RATE PLANE PLANT HEART HOUSE".split(
      " ",
    );
  const ADULT_WORDS = "ASS BITCH COCK DAMN DICK HELL PISS SHIT SLUT TIT".split(
    " ",
  );
  const LETTER_BAG =
    "EEEEEEEEEEEEAAAAAAAARRRRRRIIIIIIIIOOOOOOOONNNNNNTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPHHFFVVWWYYKJXQZ";
  Object.values(MODE_CONFIG).forEach(Object.freeze);
  Object.freeze(MODE_CONFIG);
  const RANDOM_RUSH_EXCLUDED_MODES = Object.freeze(["coop", "dirty"]);
  const RANDOM_RUSH_MODES = Object.freeze(
    Object.keys(MODE_CONFIG).filter(
      (mode) => !RANDOM_RUSH_EXCLUDED_MODES.includes(mode),
    ),
  );

  function configForPreset(mode) {
    return MODE_CONFIG[mode] || null;
  }

  function validateCustomConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { valid: false, error: "CUSTOM_CONFIG_MUST_BE_OBJECT" };
    if (typeof raw.label !== "string" || raw.label.length < 1 || raw.label.length > 32)
      return { valid: false, error: "CUSTOM_LABEL_INVALID" };
    if (typeof raw.rule !== "string" || raw.rule.length < 1 || raw.rule.length > 100)
      return { valid: false, error: "CUSTOM_RULE_INVALID" };
    const label = raw.label;
    const rule = raw.rule;
    if (typeof raw.min !== "number" || !Number.isInteger(raw.min) || raw.min < 3 || raw.min > 12)
      return { valid: false, error: "CUSTOM_MIN_OUT_OF_RANGE" };
    const min = raw.min;
    if (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 4 || raw.size > 8)
      return { valid: false, error: "CUSTOM_SIZE_OUT_OF_RANGE" };
    const size = raw.size;
    if (typeof raw.seconds !== "number" || !Number.isInteger(raw.seconds) || raw.seconds < 15 || raw.seconds > 600)
      return { valid: false, error: "CUSTOM_SECONDS_OUT_OF_RANGE" };
    const seconds = raw.seconds;
    if (raw.chain !== undefined && raw.chain !== true && raw.chain !== false)
      return { valid: false, error: "CUSTOM_FIELD_TYPE_ERROR" };
    if (raw.chain === true)
      return { valid: false, error: "CUSTOM_CHAIN_NOT_SUPPORTED" };
    if (raw.sudden !== undefined && raw.sudden !== true && raw.sudden !== false)
      return { valid: false, error: "CUSTOM_FIELD_TYPE_ERROR" };
    const sudden = raw.sudden === true;
    const hasRawTarget = raw.target !== undefined && raw.target !== null;
    if (hasRawTarget && (typeof raw.target !== "number" || !Number.isFinite(raw.target) || raw.target < 1 || raw.target > 100000))
      return { valid: false, error: "CUSTOM_TARGET_OUT_OF_RANGE" };
    const target = hasRawTarget ? raw.target : null;
    if (raw.adult !== undefined && raw.adult !== true && raw.adult !== false)
      return { valid: false, error: "CUSTOM_FIELD_TYPE_ERROR" };
    const adult = raw.adult === true;
    if (raw.party !== undefined && raw.party !== true && raw.party !== false)
      return { valid: false, error: "CUSTOM_FIELD_TYPE_ERROR" };
    const party = raw.party === true;
    const templateFlags = [sudden, hasRawTarget, adult, party].filter(Boolean).length;
    if (templateFlags > 1)
      return { valid: false, error: "CUSTOM_CONTRADICTORY_RULES" };
    return {
      valid: true,
      config: { label, min, size, seconds, rule, target, sudden, chain: false, adult, party },
    };
  }

  function isSuddenDeath(config) {
    return config?.sudden === true;
  }
  function requiresChain(config) {
    return config?.chain === true;
  }
  function chainWordMatches(requiredLetter, word) {
    const required = String(requiredLetter || "").toUpperCase();
    const candidate = String(word || "").toUpperCase();
    return !required || candidate.startsWith(required);
  }
  function advanceChainFields(fields, acceptedWord) {
    const word = String(acceptedWord || "").toUpperCase();
    const initial = word[0];
    const final = word.at(-1);
    fields.chainRemainingByInitial[initial] = Math.max(
      0,
      (fields.chainRemainingByInitial[initial] || 0) - 1,
    );
    fields.lastAcceptedWord = word;
    if ((fields.chainRemainingByInitial[final] || 0) > 0) {
      fields.requiredLetter = final;
      fields.chainResetLetter = "";
    } else {
      fields.requiredLetter = "";
      fields.chainResetLetter = final;
    }
    return fields;
  }
  function hasScoreTarget(config) {
    return Number.isFinite(config?.target) && config.target > 0;
  }
  function usesAdultLexicon(config) {
    return config?.adult === true;
  }
  function isPartyRound(config) {
    return config?.party === true;
  }
  function shouldEndOnRejectedWord(config, reason) {
    return isSuddenDeath(config) && reason !== "duplicate";
  }

  Object.freeze(COMMON_WORDS);
  Object.freeze(ADULT_WORDS);
  return Object.freeze({
    MODE_CONFIG,
    DEFAULT_DICTIONARY_ID,
    RANDOM_RUSH_MODES,
    RANDOM_RUSH_EXCLUDED_MODES,
    COMMON_WORDS,
    ADULT_WORDS,
    LETTER_BAG,
    configForPreset,
    validateCustomConfig,
    isSuddenDeath,
    requiresChain,
    chainWordMatches,
    advanceChainFields,
    hasScoreTarget,
    usesAdultLexicon,
    isPartyRound,
    shouldEndOnRejectedWord,
  });
});
