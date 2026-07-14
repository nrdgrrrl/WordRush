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
      rule: "Free play · 2 minutes",
    },
    minimum: {
      label: "MINIMUM WORD",
      min: 5,
      size: 6,
      seconds: 180,
      rule: "Minimum 5 letters",
    },
    sudden: {
      label: "SUDDEN DEATH",
      min: 3,
      size: 5,
      seconds: 180,
      rule: "One invalid word ends the round",
    },
    race: {
      label: "RACE MODE",
      min: 3,
      size: 4,
      seconds: 240,
      rule: "First to 500 points wins",
    },
    coop: {
      label: "CO-OP",
      min: 3,
      size: 4,
      seconds: 120,
      rule: "Shared team score · find words together",
    },
    dirty: {
      label: "DIRTY MODE · 18+",
      min: 3,
      size: 5,
      seconds: 180,
      rule: "Opt-in adult dictionary",
    },
  };
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
  Object.freeze(COMMON_WORDS);
  Object.freeze(ADULT_WORDS);
  return Object.freeze({ MODE_CONFIG, COMMON_WORDS, ADULT_WORDS, LETTER_BAG });
});
