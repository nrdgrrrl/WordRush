const $ = (s) => document.querySelector(s),
  sharedConfig = window.WordrushConfig,
  sharedBoardCore = window.WordrushBoardCore,
  configForPreset = sharedConfig.configForPreset,
  validateCustomConfig = sharedConfig.validateCustomConfig,
  isSuddenDeath = sharedConfig.isSuddenDeath,
  requiresChain = sharedConfig.requiresChain,
  chainWordMatches = sharedConfig.chainWordMatches,
  advanceChainFields = sharedConfig.advanceChainFields,
  hasScoreTarget = sharedConfig.hasScoreTarget,
  DEFAULT_DICTIONARY_ID = sharedConfig.DEFAULT_DICTIONARY_ID,
  usesAdultLexicon = sharedConfig.usesAdultLexicon,
  isPartyRound = sharedConfig.isPartyRound,
  shouldEndOnRejectedWord = sharedConfig.shouldEndOnRejectedWord,
  multiplayerResultState = window.WordrushMultiplayerResultState,
  multiplayerWordReconciliation = window.WordrushMultiplayerWordReconciliation,
  cooperativeResults = window.WordrushCooperativeResults,
  roundTiming = window.WordrushRoundTiming,
  roundOutcome = window.WordrushRoundOutcome,
  profileMigration = window.WordrushProfileMigration,
  playStreak = window.WordrushPlayStreak,
  suddenDeathOutcome = window.WordrushSuddenDeathOutcome,
  suddenDeathSeries = window.WordrushSuddenDeathSeries,
  challengeRules = window.WordrushChallengeRules;
let customAdult = false;
const localGuestId =
  localStorage.getItem("wordrush-guest-id") ||
  (crypto.randomUUID
    ? crypto.randomUUID()
    : "guest-" + Math.random().toString(36).slice(2));
localStorage.setItem("wordrush-guest-id", localGuestId);
window.wordrushGuestId = localGuestId;
function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent("wordrush:" + name, { detail }));
}
const RANDOM_MODES = Object.freeze([...sharedConfig.RANDOM_RUSH_MODES]);
window.wordrushRandomRushModes = RANDOM_MODES;
let randomModeQueue = [];
function shuffledModes(modes, previous) {
  const shuffled = modes.filter((mode) => mode !== previous);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  if (modes.includes(previous)) shuffled.push(previous);
  return shuffled;
}
function nextRandomMode() {
  if (!randomModeQueue.length)
    randomModeQueue = shuffledModes(RANDOM_MODES, s.mode);
  return randomModeQueue.shift() || RANDOM_MODES[0];
}
function consumeNextRushMode() {
  const mode = s.nextRushMode || nextRandomMode();
  s.nextRushMode = null;
  return mode;
}
const adult = sharedConfig.ADULT_WORDS;
const wordCheckCache = new Map();
const dictionaryRequestCache = new Map();
async function fetchDictionary(dictionaryId = DEFAULT_DICTIONARY_ID) {
  if (dictionaryRequestCache.has(dictionaryId))
    return dictionaryRequestCache.get(dictionaryId);
  const request = fetch(
    "/api/dictionary?dictionaryId=" + encodeURIComponent(dictionaryId),
  )
    .then((response) => {
      if (!response.ok) throw new Error("Dictionary load failed");
      return response.json();
    })
    .then((payload) => {
      if (
        payload?.dictionary?.dictionaryId !== dictionaryId ||
        !Array.isArray(payload.words)
      )
        throw new Error("Dictionary response was invalid");
      return payload;
    });
  dictionaryRequestCache.set(dictionaryId, request);
  request.catch(() => dictionaryRequestCache.delete(dictionaryId));
  return request;
}
async function requestSoloBoard({ mode, config, adultMode, dictionaryId }) {
  const request = { mode, dictionaryId };
  if (mode === "custom") request.config = config;
  if (adultMode) request.adult = true;
  const response = await fetch("/api/solo-board", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Solo board response was invalid");
  }
  if (!response.ok) {
    const error = new Error(payload?.error || "Solo board request failed");
    error.code = payload?.error;
    error.failureCode = payload?.failureCode;
    throw error;
  }
  if (
    payload?.mode !== mode ||
    payload?.dictionary?.dictionaryId !== dictionaryId ||
    !payload.config ||
    !Number.isInteger(payload.seed) ||
    !Array.isArray(payload.board) ||
    payload.board.length !== payload.config.size * payload.config.size ||
    payload.board.some((letter) => !/^[A-Z]$/.test(letter))
  )
    throw new Error("Solo board response was invalid");
  if (payload.config.chain && !payload.playableWordStarts)
    throw new Error("Solo chain board response was invalid");
  return payload;
}
function validDailyChallenge(challenge) {
  return Boolean(
    challenge &&
      typeof challenge === "object" &&
      /^daily-\d{4}-\d{2}-\d{2}$/.test(challenge.id) &&
      /^\d{4}-\d{2}-\d{2}$/.test(challenge.date) &&
      challenge.mode === "daily" &&
      challenge.config &&
      Number.isInteger(challenge.config.size) &&
      Number.isInteger(challenge.config.seconds) &&
      typeof challenge.dictionary?.dictionaryId === "string" &&
      Array.isArray(challenge.board) &&
      challenge.board.length === challenge.config.size * challenge.config.size &&
      challenge.board.every((letter) => /^[A-Z]$/.test(letter)),
  );
}
async function requestDailyChallenge() {
  const response = await fetch("/api/daily-challenge");
  const payload = await response.json().catch(() => null);
  if (!response.ok || !validDailyChallenge(payload?.challenge)) {
    const error = new Error(payload?.error || "Daily Rush is unavailable");
    error.code = payload?.error;
    throw error;
  }
  return { challenge: payload.challenge, target: null, shareRef: null };
}
async function requestSharedChallenge(ref) {
  const response = await fetch("/api/challenges/" + encodeURIComponent(ref));
  const payload = await response.json().catch(() => null);
  if (!response.ok || !validDailyChallenge(payload?.challenge)) {
    const error = new Error(payload?.error || "Challenge link is unavailable");
    error.code = payload?.error;
    throw error;
  }
  return { challenge: payload.challenge, target: payload.target || null, shareRef: ref };
}
async function requestRelayChallenge(id = null) {
  const response = await fetch(
    id
      ? "/api/relay-challenges/" + encodeURIComponent(id)
      : "/api/relay-challenges",
    id ? undefined : { method: "POST" },
  );
  const payload = await response.json().catch(() => null);
  const challenge = payload && payload.id ? payload : null;
  if (
    !response.ok ||
    !challenge ||
    !/^[A-Za-z0-9_-]{20,40}$/.test(challenge.id) ||
    !challenge.config ||
    challenge.config.chain !== true ||
    !Array.isArray(challenge.board) ||
    challenge.board.length !== challenge.config.size * challenge.config.size ||
    !challenge.board.every((letter) => /^[A-Z]$/.test(letter)) ||
    !challenge.dictionary?.dictionaryId ||
    !Number.isSafeInteger(challenge.revision) ||
    !challenge.state ||
    !Array.isArray(challenge.state.found) ||
    typeof challenge.state.requiredLetter !== "string"
  ) {
    const error = new Error(payload?.error || "Word Relay is unavailable");
    error.code = payload?.error;
    throw error;
  }
  return { challenge };
}
async function applySoloBoardTestFixture(generated) {
  let fixtureRequested = false;
  try {
    fixtureRequested = Boolean(
      sessionStorage.getItem("wordrushBrowserBoardFixture"),
    );
  } catch {}
  if (!fixtureRequested) return generated;
  const fixture = await sharedBoardCore.generateBoardCooperatively(
    generated.config.size,
    null,
    {
      mode: generated.validationMode,
      min: generated.config.min,
      seed: generated.seed,
    },
  );
  return fixture?.ok && fixture.board.length === generated.board.length
    ? { ...generated, board: fixture.board }
    : generated;
}
async function isServerDictionaryWord(word, dictionaryId, adultMode) {
  const key = `${dictionaryId}:${adultMode ? "dirty" : "classic"}:${word}`;
  if (wordCheckCache.has(key)) return wordCheckCache.get(key);
  const check = fetch(
      "/api/word-check?word=" +
      encodeURIComponent(word) +
      "&dictionaryId=" +
      encodeURIComponent(dictionaryId) +
      "&adult=" +
      (adultMode ? "1" : "0"),
  )
    .then((response) => {
      if (!response.ok) throw new Error("Word check failed");
      return response.json();
    })
    .then((result) => result.valid === true)
    .catch(() => {
      wordCheckCache.delete(key);
      return lex().has(String(word || "").toUpperCase());
    });
  wordCheckCache.set(key, check);
  return check;
}
const s = {
  mode: "classic",
  n: 4,
  b: [],
  pick: [],
  found: new Set(),
  score: 0,
  time: 120,
  timer: 0,
  done: false,
  drag: false,
  pointerId: null,
  previousPointer: null,
  trace: [],
  traceFrame: 0,
  soloRoundId: 0,
  startedAt: 0,
  endsAt: 0,
  rush: false,
  rushTimer: 0,
  rushCountdown: 0,
  nextRushMode: null,
  roundWordTimes: [],
  onlineRoundKey: null,
  onlineSeries: null,
  onlineSeriesId: null,
  onlineIntroEndsAt: 0,
  onlineRandomRush: false,
  onlineResultRoundId: null,
  onlineNextRound: null,
  onlineResultAction: null,
  pendingOnlineTrace: null,
  lastAcceptedWord: "",
  requiredLetter: "",
  chainResetLetter: "",
  chainRemainingByInitial: {},
  rejectedAttempt: "",
  rejectionReason: "",
  suddenDeathEvent: null,
  suddenDeathRoundKey: null,
  acceptingSoloSubmissions: false,
  config: null,
  dictionaryId: DEFAULT_DICTIONARY_ID,
  dictionaryMetadata: null,
  dictionaryWords: [],
  dailyChallenge: null,
  echo: null,
  relayChallenge: null,
  heist: null,
  frozenIndexes: new Set(),
  bounty: null,
};
let soloGenerationRequest = 0;
let soloRoundGeneration = 0;
let soloSubmissionEpoch = 0;
let soloSubmissionTail = Promise.resolve();
let soloSubmissionErrorCount = 0;
let rushContinuationGeneration = 0;
let rushContinuationTransition = false;
let suddenDeathPresentationGeneration = 0;
let suddenDeathExplosionTimer = 0;
let suddenDeathPresentedRoundKey = null;
function logSoloSubmissionError(error) {
  if (soloSubmissionErrorCount < 3) {
    console.error("WordRush solo submission commit failed", error);
  } else if (soloSubmissionErrorCount === 3) {
    console.error("WordRush solo submission commit failures suppressed");
  }
  soloSubmissionErrorCount++;
}
function invalidateSoloSubmissionQueue() {
  soloSubmissionEpoch++;
  soloSubmissionTail = Promise.resolve();
  s.acceptingSoloSubmissions = false;
  return soloSubmissionEpoch;
}
function isCurrentSoloSubmission(epoch, roundId, startedAt, endsAt) {
  return (
    s.acceptingSoloSubmissions &&
    !s.done &&
    !s.onlineRoundKey &&
    soloSubmissionEpoch === epoch &&
    s.soloRoundId === roundId &&
    roundId > 0 &&
    s.startedAt === startedAt &&
    s.endsAt === endsAt &&
    startedAt > 0 &&
    endsAt > startedAt
  );
}
function enqueueSoloSubmission(commit) {
  const task = soloSubmissionTail.then(commit);
  soloSubmissionTail = task.catch((error) => {
    logSoloSubmissionError(error);
  });
  return soloSubmissionTail;
}
const avatarOptions = [
    "🐈",
    "🦊",
    "🐼",
    "🐸",
    "🦄",
    "🐙",
    "🐯",
    "🦁",
    "🐨",
    "🐵",
    "🙈",
    "🐔",
    "🐧",
    "🐦",
    "🦉",
    "🐝",
    "🦋",
    "🐌",
    "🐞",
    "🐢",
    "🐍",
    "🦎",
    "🐳",
    "🐬",
    "🦈",
    "🐊",
    "🦀",
    "🐿️",
    "🦔",
    "🦥",
    "🦦",
    "🦙",
    "🦘",
    "🦚",
    "🐲",
  ],
  nameAdjectives = [
    "Velvet",
    "Clever",
    "Cosmic",
    "Lucky",
    "Swift",
    "Mischief",
    "Pixel",
    "Nimble",
  ],
  nameNouns = [
    "Whisker",
    "Paw",
    "Pounce",
    "Marmalade",
    "Tuxedo",
    "Mooncat",
    "Tabby",
    "Claw",
  ];
window.wordrushAvatarOptions = avatarOptions;
function randomGuestName() {
  return (
    nameAdjectives[Math.floor(Math.random() * nameAdjectives.length)] +
    nameNouns[Math.floor(Math.random() * nameNouns.length)] +
    Math.floor(10 + Math.random() * 90)
  );
}
const profile = (() => {
  try {
    return Object.assign(
      {
        name: "",
        avatar: "🐈",
        accountId: "",
        score: 0,
        words: 0,
        streak: 0,
        longest: 0,
        rounds: 0,
        correct: 0,
        incorrect: 0,
        totalWordLength: 0,
        totalGameSeconds: 0,
        gamesWon: 0,
        gamesLost: 0,
        multiplayerWins: 0,
        multiplayerLosses: 0,
        outcomeSemanticsVersion: 1,
        speedAchievement: false,
        maxGridWin: 0,
        completedMultiplayerRounds: [],
        multiplayerWordRounds: [],
        days: [],
      },
      JSON.parse(localStorage.getItem("wordrush-profile") || "{}"),
    );
  } catch {
    return {
      name: "",
      avatar: "🐈",
      accountId: "",
      score: 0,
      words: 0,
      streak: 0,
      longest: 0,
      rounds: 0,
      correct: 0,
      incorrect: 0,
      totalWordLength: 0,
      totalGameSeconds: 0,
      gamesWon: 0,
      gamesLost: 0,
      multiplayerWins: 0,
      multiplayerLosses: 0,
      outcomeSemanticsVersion: 1,
      speedAchievement: false,
      maxGridWin: 0,
      completedMultiplayerRounds: [],
      multiplayerWordRounds: [],
      days: [],
    };
  }
})();
Object.assign(profile, profileMigration.withOutcomeSemanticsVersion(profile));
for (const key of [
  "score", "words", "streak", "longest", "rounds", "correct", "incorrect",
  "totalWordLength", "totalGameSeconds", "gamesWon", "gamesLost",
  "multiplayerWins", "multiplayerLosses", "maxGridWin",
]) {
  const value = Number(profile[key]);
  profile[key] = Number.isFinite(value) && value >= 0 ? value : 0;
}
profile.days = playStreak.normalizePlayDates(profile.days);
profile.completedMultiplayerRounds = Array.isArray(profile.completedMultiplayerRounds)
  ? profile.completedMultiplayerRounds.filter((id) => typeof id === "string").slice(-50)
  : [];
profile.multiplayerWordRounds = multiplayerWordReconciliation.normalizeRoundRecords(
  profile.multiplayerWordRounds,
);
profile.name = typeof profile.name === "string" ? profile.name.slice(0, 20) : "";
if (!profile.name || profile.name === "Jordan")
  profile.name = randomGuestName();
function isProfileAvatar(value) {
  return window.WordrushAvatarPresentation?.isSupported(value) || avatarOptions.includes(value);
}
if (!isProfileAvatar(profile.avatar)) profile.avatar = "🐈";
function renderAvatar(target, value, fallback = "🐈") {
  if (!target) return;
  if (window.WordrushAvatarPresentation)
    window.WordrushAvatarPresentation.render(target, value, fallback);
  else target.textContent = fallback;
}
window.wordrushRenderAvatar = renderAvatar;
window.wordrushAvatarLabel = (value, fallback = "🐈") =>
  window.WordrushAvatarPresentation?.describe(value, fallback).value || fallback;
function renderPlayerName(target, player) {
  if (!target) return;
  target.replaceChildren();
  if (window.WordrushAvatarPresentation)
    window.WordrushAvatarPresentation.appendInline(target, player?.avatar, player?.name || "");
  else target.textContent = (player?.avatar || "🐈") + " " + (player?.name || "");
  return true;
}
window.wordrushRenderPlayerName = renderPlayerName;
function updateIdentity() {
  renderAvatar($("#profileButton"), profile.avatar);
  if ($("#profileName")) $("#profileName").value = profile.name;
  document
    .querySelectorAll("[data-avatar]")
    .forEach((button) =>
      button.classList.toggle(
        "chosen",
        button.dataset.avatar === profile.avatar,
      ),
    );
  window.wordrushProfile = () => ({
    name: profile.name,
    avatar: profile.avatar,
  });
}
const authState = {
  loaded: false,
  account: null,
  providers: [],
};
let profileSyncBase = null;
let profileSyncEvents = [];
let profileSyncInFlight = false;
let profileSyncSequence = 0;
function profileStatsSnapshot() {
  return {
    score: profile.score,
    words: profile.words,
    streak: profile.streak,
    longest: profile.longest,
    rounds: profile.rounds,
    correct: profile.correct,
    incorrect: profile.incorrect,
    totalWordLength: profile.totalWordLength,
    totalGameSeconds: profile.totalGameSeconds,
    gamesWon: profile.gamesWon,
    gamesLost: profile.gamesLost,
    multiplayerWins: profile.multiplayerWins,
    multiplayerLosses: profile.multiplayerLosses,
    maxGridWin: profile.maxGridWin,
    speedAchievement: profile.speedAchievement === true,
    days: [...(profile.days || [])],
    completedMultiplayerRounds: [...(profile.completedMultiplayerRounds || [])],
    multiplayerWordRounds: (profile.multiplayerWordRounds || []).map((round) => ({
      roundId: round.roundId,
      words: [...(round.words || [])],
    })),
  };
}
function profileStatsDelta(current, base) {
  const delta = {};
  for (const key of [
    "score", "words", "rounds", "correct", "incorrect", "totalWordLength",
    "totalGameSeconds", "gamesWon", "gamesLost", "multiplayerWins",
    "multiplayerLosses",
  ]) {
    const change = (Number(current[key]) || 0) - (Number(base[key]) || 0);
    if (change > 0) delta[key] = change;
  }
  if ((Number(current.longest) || 0) > (Number(base.longest) || 0))
    delta.longest = current.longest;
  if ((Number(current.maxGridWin) || 0) > (Number(base.maxGridWin) || 0))
    delta.maxGridWin = current.maxGridWin;
  if (current.speedAchievement && !base.speedAchievement)
    delta.speedAchievement = true;
  for (const key of ["days", "completedMultiplayerRounds"]) {
    const oldValues = new Set(base[key] || []);
    const added = (current[key] || []).filter((value) => !oldValues.has(value));
    if (added.length) delta[key] = added;
  }
  const oldRounds = new Map((base.multiplayerWordRounds || []).map((round) => [round.roundId, round]));
  const addedRounds = (current.multiplayerWordRounds || []).map((round) => ({
    roundId: round.roundId,
    words: (round.words || []).filter((word) => !oldRounds.get(round.roundId)?.words?.includes(word)),
  })).filter((round) => round.words.length);
  if (addedRounds.length) delta.multiplayerWordRounds = addedRounds;
  return delta;
}
function profileDeltaHasValues(delta) {
  return Object.values(delta).some((value) =>
    Array.isArray(value) ? value.length > 0 : value === true || Number(value) > 0,
  );
}
function applyServerAccount(account, replaceStats = true) {
  if (!account) return;
  authState.account = account;
  profile.accountId = account.id || "";
  if (account.username) profile.name = account.username;
  else if (account.displayName) profile.name = String(account.displayName).slice(0, 20);
  if (isProfileAvatar(account.avatar)) profile.avatar = account.avatar;
  if (replaceStats && account.stats && typeof account.stats === "object")
    Object.assign(profile, account.stats);
  profile.days = playStreak.normalizePlayDates(profile.days);
  profile.completedMultiplayerRounds = Array.isArray(profile.completedMultiplayerRounds)
    ? profile.completedMultiplayerRounds.filter((id) => typeof id === "string").slice(-50)
    : [];
  profile.multiplayerWordRounds = multiplayerWordReconciliation.normalizeRoundRecords(
    profile.multiplayerWordRounds,
  );
  profileSyncBase = profileStatsSnapshot();
  updateIdentity();
  updateProfile({ sync: false });
  window.wordrushIdentityChanged?.();
}
async function flushProfileEvents() {
  if (profileSyncInFlight || !authState.account || !profileSyncEvents.length) return;
  profileSyncInFlight = true;
  const event = profileSyncEvents[0];
  let failed = false;
  try {
    const response = await fetch("/api/profile/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error("profile event failed");
    profileSyncEvents.shift();
  } catch {
    failed = true;
    setTimeout(() => flushProfileEvents(), 5000);
  } finally {
    profileSyncInFlight = false;
    if (profileSyncEvents.length && !failed) setTimeout(() => flushProfileEvents(), 0);
  }
}
function queueProfileSync() {
  if (!authState.loaded || !authState.account || !profileSyncBase) return;
  const current = profileStatsSnapshot();
  const delta = profileStatsDelta(current, profileSyncBase);
  if (!profileDeltaHasValues(delta)) return;
  profileSyncBase = current;
  profileSyncEvents.push({
    eventId: localGuestId + ":" + Date.now() + ":" + (++profileSyncSequence),
    delta,
  });
  void flushProfileEvents();
}
function updateAuthUI() {
  const account = authState.account;
  const status = $("#profileAuthStatus");
  const google = $("#profileGoogle");
  const facebook = $("#profileFacebook");
  const logout = $("#profileLogout");
  const save = $("#profileSave");
  if (status) {
    status.textContent = account
      ? account.needsUsername
        ? "Choose a unique username to finish your profile."
        : "Your profile and stats are synced across devices."
      : "Save your username, avatar, and stats by continuing with a provider.";
  }
  const updateProvider = (button, provider) => {
    if (!button) return;
    const connected = Boolean(account && account.provider === provider);
    button.hidden = account ? !connected : !authState.providers.includes(provider);
    button.disabled = connected;
    button.setAttribute("aria-disabled", String(connected));
    if (connected) button.title = "Already signed in with this provider";
    else button.removeAttribute("title");
  };
  updateProvider(google, "google");
  updateProvider(facebook, "facebook");
  if (logout) logout.hidden = !account;
  if (save) save.textContent = account ? "Save profile" : "Save guest profile";
  $("#profileProviderHint")?.toggleAttribute("hidden", !account);
}
function friendlyAuthError(code) {
  return {
    USERNAME_LENGTH: "Use 3–20 characters for your username.",
    USERNAME_CHARACTERS: "Use letters, numbers, spaces, hyphens, or underscores.",
    USERNAME_BLOCKED: "That username contains a word we do not allow.",
    USERNAME_TAKEN: "That username is already taken. Try another one.",
    "provider-unavailable": "That sign-in option is not available right now.",
  }[code] || "We could not save your profile. Try again.";
}
async function loadAuthProfile() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    const payload = await response.json();
    authState.providers = Array.isArray(payload.providers) ? payload.providers : [];
    if (payload.authenticated && payload.account) {
      const localOwner = typeof profile.accountId === "string" ? profile.accountId : "";
      const belongsToThisAccount = localOwner && localOwner === payload.account.id;
      const belongsToAnotherAccount = localOwner && localOwner !== payload.account.id;
      const migration = !belongsToAnotherAccount && !belongsToThisAccount
        ? await fetch("/api/profile/migrate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ guestId: localGuestId, profile: profileStatsSnapshot() }),
          })
        : null;
      const migrated = migration?.ok ? await migration.json() : null;
      applyServerAccount(migrated?.account || payload.account);
    } else {
      authState.account = null;
      updateAuthUI();
    }
  } catch {
    authState.account = null;
  } finally {
    authState.loaded = true;
    updateAuthUI();
    const authResult = new URLSearchParams(location.search).get("auth");
    if (authResult) {
      const next = new URL(location.href);
      next.searchParams.delete("auth");
      history.replaceState(history.state, "", next.pathname + next.search + next.hash);
      if (authResult === "signed-in" || authResult === "choose-username") {
        $("#profileDialog")?.showModal();
        if (authResult === "choose-username") $("#profileName")?.focus();
      } else if (authResult !== "complete") {
        toast("Sign-in could not be completed.");
      }
    }
  }
}
function updateProfile({ sync = true } = {}) {
  profile.days = playStreak.normalizePlayDates(profile.days);
  profile.streak = playStreak.calculateCurrentStreak(profile.days);
  localStorage.setItem("wordrush-profile", JSON.stringify(profile));
  if ($("#homeScore"))
    $("#homeScore").textContent = profile.score.toLocaleString();
  if ($("#homeWords")) $("#homeWords").textContent = profile.words;
  if ($("#homeStreak")) $("#homeStreak").textContent = profile.streak;
  window.wordrushAchievementEvent?.(profile);
  window.wordrushStatsEvent?.();
  if (sync) queueProfileSync();
}
function recordPlayDay() {
  const today = playStreak.localDateKey(new Date());
  if (today) profile.days = playStreak.normalizePlayDates([...profile.days, today]);
}
function recordAcceptedWord(word, { trackSpeed = true } = {}) {
  const elapsed = Date.now() - s.startedAt;
  if (trackSpeed) {
    s.roundWordTimes.push(elapsed);
    if (s.roundWordTimes.filter((time) => elapsed - time <= 60000).length >= 20)
      profile.speedAchievement = true;
  }
  profile.words++;
  profile.correct++;
  profile.totalWordLength += word.length;
  profile.longest = Math.max(profile.longest, word.length);
}
function dailyEchoKey(challengeId) {
  return "wordrushDailyEcho:" + String(challengeId || "");
}
function loadDailyEcho(challengeId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(dailyEchoKey(challengeId)) || "null");
    if (!parsed || !Number.isInteger(parsed.score) || parsed.score < 0) return null;
    return {
      score: parsed.score,
      checkpoints: challengeRules.normalizeEchoCheckpoints(parsed.checkpoints),
    };
  } catch {
    return null;
  }
}
function saveDailyEcho(challengeId, echo) {
  if (!challengeId || !echo) return;
  try {
    localStorage.setItem(dailyEchoKey(challengeId), JSON.stringify({
      score: Math.max(0, Math.min(1_000_000, Math.trunc(echo.score || 0))),
      checkpoints: challengeRules.normalizeEchoCheckpoints(echo.checkpoints),
    }));
  } catch {}
}
function echoScoreAt(checkpoints, elapsedMs) {
  let score = 0;
  for (const checkpoint of checkpoints || []) {
    if (checkpoint.elapsedMs > elapsedMs) break;
    score = checkpoint.score;
  }
  return score;
}
function updateEchoPace() {
  if (!s.echo?.target || !s.startedAt) return;
  const score = echoScoreAt(s.echo.target.checkpoints, Date.now() - s.startedAt);
  $("#gameHint").textContent = "Echo pace: " + score + " points";
}
function recordReconciledOnlineWords(words) {
  const delta = multiplayerWordReconciliation.wordStatsDelta(words);
  profile.words += delta.words;
  profile.correct += delta.correct;
  profile.totalWordLength += delta.totalWordLength;
  profile.longest = Math.max(profile.longest, delta.longest);
}
function formatTimer(seconds) {
  const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
  return (
    String(Math.floor(safe / 60)).padStart(2, "0") +
    ":" +
    String(safe % 60).padStart(2, "0")
  );
}
updateIdentity();
updateProfile();
let lexiconCache = null;
let lexiconCacheKey = "";
function lex() {
  const key = s.dictionaryId + ":" + s.mode + ":" + customAdult;
  if (lexiconCache && lexiconCacheKey === key) return lexiconCache;
  lexiconCacheKey = key;
  lexiconCache = new Set([
    ...s.dictionaryWords,
    ...(s.mode === "dirty" || customAdult ? adult : []),
  ]);
  return lexiconCache;
}
function near(i) {
  return sharedBoardCore.neighbors(i, s.n);
}
function render() {
  let g = $("#grid");
  g.style.gridTemplateColumns = "repeat(" + s.n + ",1fr)";
  g.innerHTML = s.b
    .map((l, i) => {
      const frozen = s.frozenIndexes.has(i);
      const bounty = s.bounty?.bountyIndexes.includes(i);
      const claimed = s.bounty?.claimedIndexes.includes(i);
      const classes = ["tile", frozen ? "tile-frozen" : "", bounty ? "tile-bounty" : "", claimed ? "tile-bounty-claimed" : ""].filter(Boolean).join(" ");
      const label = frozen ? " frozen" : claimed ? " bounty claimed" : bounty ? " charged bounty" : "";
      return '<button class="' + classes + '" data-i="' + i + '" aria-label="' + l + label + '"' + (frozen ? " disabled" : "") + ">" + l + "</button>";
    })
    .join("");
  renderChainStatus();
  renderChallengeStatus();
}
function renderChainStatus() {
  const status = $("#chainStatus");
  if (!status) return;
  const active = requiresChain(s.config);
  status.hidden = !active;
  if (!active) return;
  $("#chainLastAccepted").textContent = s.lastAcceptedWord || "None";
  $("#chainRequiredLetter").textContent = s.requiredLetter || "Any";
  const guidance = $("#chainGuidance");
  let text = "";
  if (s.rejectedAttempt) {
    const reasons = {
      minimum: "need at least " + s.config.min + " letters",
      path: "tiles must connect",
      duplicate: "that word was already used",
      dictionary: "not in the Wordrush dictionary",
    };
    text = s.rejectionReason === "chain"
      ? "Rejected: " + s.rejectedAttempt + ", must start with " + s.requiredLetter
      : "Rejected: " + s.rejectedAttempt + ", " +
        (reasons[s.rejectionReason] || "not accepted");
  } else if (s.chainResetLetter) {
    text = "No unused " + s.chainResetLetter + " words remain. Chain reset.";
  }
  guidance.hidden = !text;
  guidance.textContent = text;
}
function renderChallengeStatus() {
  const relay = $("#relayStatus");
  if (relay) {
    relay.hidden = !s.relayChallenge;
    if (s.relayChallenge) {
      const required = s.relayChallenge.state.requiredLetter || "Any";
      $("#relayRequiredLetter").textContent = required;
      $("#relayTurnCount").textContent = String(s.relayChallenge.state.turns || 0);
    }
  }
  const heist = $("#heistStatus");
  if (heist) {
    heist.hidden = !s.heist;
    if (!s.heist) return;
    const teamId = s.heist.teamByPlayer?.[window.wordrushGuestId] || "sun";
    const team = s.heist.teams?.find((entry) => entry.id === teamId);
    $("#heistTeam").textContent = teamId.toUpperCase();
    $("#heistTeamScore").textContent = String(s.heist.teamScores?.[teamId] || 0);
    $("#heistOtherTeam").textContent = teamId === "sun" ? "MOON" : "SUN";
    $("#heistOtherScore").textContent = String(s.heist.teamScores?.[teamId === "sun" ? "moon" : "sun"] || 0);
    $("#heistMembers").textContent = team?.playerIds?.length
      ? team.playerIds.length + " players"
      : "Your team";
  }
}
function renderResults(
  ranking,
  {
    skipped = false,
    onlineNextRound = null,
    onlineSourceRoundId = null,
    onlineCreator = false,
    suddenDeath = null,
    series = null,
    cooperative = false,
    teamScore = 0,
  } = {},
) {
  const sourceRows = ranking?.length
    ? ranking
    : [{
        id: "local-player",
        name: profile.name,
        avatar: profile.avatar,
        score: s.score,
        words: [...s.found].map((word) => ({ word, points: word.length ** 2 })),
      }];
  const rows = series
    ? suddenDeathSeries.rankParticipants(sourceRows)
    : sourceRows;
  if (!series) {
    const panel = $("#seriesFinalPanel");
    if (panel) panel.hidden = true;
  }
  const onlineHeading = onlineSourceRoundId
    ? multiplayerResultState.normalizeResultAction({
        sourceRoundId: onlineSourceRoundId,
        currentRoundId: onlineSourceRoundId,
        nextRound: onlineNextRound,
        isCreator: onlineCreator,
        configForPreset,
      }).heading
    : "";
  const nextRushLabel = onlineSourceRoundId
    ? onlineHeading
    : s.rush && s.nextRushMode
      ? configForPreset(s.nextRushMode)?.label
      : "";
  $("#resultName").textContent = skipped
    ? nextRushLabel || "Round skipped"
    : s.rush && !onlineSourceRoundId
    ? profile.name + "."
    : nextRushLabel
    ? onlineHeading || "Up next: " + nextRushLabel
    : profile.name + ".";
  renderHeroScores(rows, skipped, suddenDeath, series, cooperative, teamScore);
  const suddenDeathData = suddenDeathOutcome.normalizeSuddenDeathOutcome(suddenDeath);
  const target = $("#resultPlayers");
  target.replaceChildren();
  rows.forEach((player, index) => {
    const row = document.createElement("article");
    const outcomeBadge = suddenDeath
      ? suddenDeathOutcome.badgeForPlayer(suddenDeathData, player)
      : player.series?.status !== "withdrawn" && series?.winnerIds?.includes(player.id)
        ? "WINNER"
        : null;
    row.className = "result-player-card rank-" + Math.min(index + 1, 4) +
      (suddenDeathData ? " sudden-death-result-card" : "");
    const rank = document.createElement("span");
    rank.className = "result-rank";
    rank.textContent = skipped || cooperative
      ? "•"
      : outcomeBadge || (["👑", "🥈", "🥉"][index] || String(index + 1));
    if (outcomeBadge) rank.dataset.outcome = outcomeBadge.toLowerCase();
    const identity = document.createElement("div");
    const name = document.createElement("b");
    renderPlayerName(name, player);
    const wordCount = document.createElement("small");
    wordCount.textContent = series
      ? (Number(player.series?.strikes) || 0) +
        " strike" +
        (Number(player.series?.strikes) === 1 ? "" : "s") +
        " · " +
        (player.series?.status === "withdrawn" ? "withdrawn" : "active")
      : (player.words?.length || 0) + " words";
    identity.append(name, wordCount);
    if (player.session) {
      const sessionRecord = document.createElement("small");
      sessionRecord.className = "result-session-record";
      sessionRecord.textContent =
        (Number(player.session.wins) || 0) + "W · " +
        (Number(player.session.losses) || 0) + "L · " +
        (Number(player.session.points) || 0).toLocaleString() + " session pts";
      identity.append(sessionRecord);
    }
    const score = document.createElement("b");
    score.className = "result-player-score";
    score.textContent = cooperative
      ? (Number(player.contribution) || 0).toLocaleString() + " contribution"
      : series
      ? (Number(player.series?.strikes) || 0) + " STRIKES"
      : Number(player.score || 0).toLocaleString();
    row.append(rank, identity, score);
    target.append(row);
  });
}
function renderOnlineResultAction(resultAction, skipped = false) {
  $("#resultName").textContent = skipped
    ? resultAction.heading || "Round skipped"
    : resultAction.heading || profile.name + ".";
  $("#again").textContent = resultAction.label;
  $("#again").disabled = resultAction.disabled || resultAction.consumed === true;
}
function renderHeroScores(
  players,
  skipped = false,
  suddenDeath = null,
  series = null,
  cooperative = false,
  teamScore = 0,
) {
  const target = $("#resultHeroScores");
  if (!target) return;
  if (cooperative) {
    const row = document.createElement("div");
    row.className = "result-score-row is-winner";
    row.setAttribute("role", "listitem");
    const rank = document.createElement("span");
    rank.className = "result-score-rank";
    rank.textContent = "👑";
    const identity = document.createElement("span");
    identity.className = "result-score-identity";
    const name = document.createElement("b");
    name.textContent = "Shared team";
    const status = document.createElement("small");
    status.textContent = "TEAM SCORE";
    identity.append(name, status);
    const score = document.createElement("strong");
    score.className = "result-score-value";
    score.textContent = (Number(teamScore) || 0).toLocaleString();
    row.append(rank, identity, score);
    target.replaceChildren(row);
    return;
  }
  const ordered = series
    ? suddenDeathSeries.rankParticipants(players, { winnerIds: series.winnerIds })
    : [...players].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const winningScore = series
    ? Number(ordered[0]?.series?.strikes) || 0
    : Number(ordered[0]?.score) || 0;
  const tied = ordered.filter(
    (player) => (series
      ? Number(player.series?.strikes) || 0
      : Number(player.score) || 0) === winningScore,
  ).length > 1;
  const suddenDeathData = suddenDeathOutcome.normalizeSuddenDeathOutcome(suddenDeath);
  const suddenDeathWinnerIds = new Set(suddenDeathOutcome.winnerIds(suddenDeathData));
  target.replaceChildren(
    ...ordered.map((player, index) => {
      const isWinner = !skipped && suddenDeathData
        ? suddenDeathWinnerIds.has(player.id)
        : series
          ? player.series?.status !== "withdrawn" && series.winnerIds?.includes(player.id)
          : !skipped && (Number(player.score) || 0) === winningScore;
      const row = document.createElement("div");
      row.className = "result-score-row" +
        (isWinner ? " is-winner" : "") +
        (player.id === window.wordrushGuestId ? " is-you" : "");
      row.setAttribute("role", "listitem");
      const rank = document.createElement("span");
      rank.className = "result-score-rank";
      rank.textContent = skipped
        ? "•"
        : suddenDeathData
          ? suddenDeathOutcome.badgeForPlayer(suddenDeathData, player) === "WINNER"
            ? "👑"
            : String(index + 1)
          : series && isWinner
            ? "👑"
            : index === 0
              ? "👑"
              : String(index + 1);
      const identity = document.createElement("span");
      identity.className = "result-score-identity";
      const name = document.createElement("b");
      renderPlayerName(name, player);
      const status = document.createElement("small");
      status.textContent = skipped
        ? "SCORE"
        : series
          ? player.series?.status !== "withdrawn" && series.winnerIds?.includes(player.id)
            ? "WINNER"
            : "STRIKES"
        : suddenDeathData
          ? suddenDeathOutcome.badgeForPlayer(suddenDeathData, player)
          : isWinner
          ? (tied ? "LEADER" : "WINNER")
          : "PLAYER";
      identity.append(name, status);
      const score = document.createElement("strong");
      score.className = "result-score-value";
      score.textContent = series
        ? (Number(player.series?.strikes) || 0) + " strikes"
        : Number(player.score || 0).toLocaleString();
      row.append(rank, identity, score);
      return row;
    }),
  );
}
function currentSuddenDeathRoundKey() {
  if (s.onlineRoundKey) return "online:" + s.onlineRoundKey;
  return s.soloRoundId ? "solo:" + s.soloRoundId : null;
}
function renderSuddenDeath(details) {
  const callout = $("#suddenDeathCallout");
  if (!callout) return;
  const title = $("#suddenDeathCalloutTitle");
  const detail = $("#suddenDeathCalloutDetail");
  const copy = suddenDeathOutcome.formatSuddenDeathOutcome(details);
  const valid = Boolean(copy);
  callout.hidden = !valid;
  if (!valid) {
    title.textContent = "Sudden death!";
    detail.textContent = "";
    return;
  }
  title.textContent = "Sudden death outcome";
  detail.textContent = copy;
}
function renderRushNextRound(mode, seconds) {
  const card = $("#rushNextRound");
  const config = configForPreset(mode);
  const visible = Boolean(config && Number.isFinite(seconds) && seconds > 0);
  card.hidden = !visible;
  if (!visible) return;
  $("#rushNextRoundTitle").textContent = config.label;
  $("#rushNextRoundCountdown").textContent =
    "Starts in " + seconds + "s · tap to start now";
}
function clearRushNextRound() {
  $("#rushNextRound").hidden = true;
  $("#rushNextRoundTitle").textContent = "";
  $("#rushNextRoundCountdown").textContent = "";
}
function clearSuddenDeathPresentation() {
  suddenDeathPresentationGeneration++;
  clearTimeout(suddenDeathExplosionTimer);
  suddenDeathExplosionTimer = 0;
  suddenDeathPresentedRoundKey = null;
  s.suddenDeathEvent = null;
  s.suddenDeathRoundKey = null;
  s.rejectedAttempt = "";
  s.rejectionReason = "";
  renderSuddenDeath(null);
  const explosion = $("#suddenDeathExplosion");
  if (!explosion) return;
  explosion.hidden = true;
  explosion.classList.remove("is-active");
  $("#suddenDeathExplosionTitle").textContent = "💥 SUDDEN DEATH!";
  $("#suddenDeathExplosionDetail").textContent = "";
}
function clearSeriesPresentation() {
  clearTimeout(seriesTransitionTimer);
  seriesTransitionTimer = 0;
  s.onlineSeries = null;
  s.onlineSeriesId = null;
  const screen = $("#seriesTransitionScreen");
  if (screen) screen.classList.remove("active");
  const finalPanel = $("#seriesFinalPanel");
  if (finalPanel) finalPanel.hidden = true;
  $("#seriesTransitionOutcome").textContent = "";
  $("#seriesTransitionStandings")?.replaceChildren();
  $("#seriesRoundHistory")?.replaceChildren();
  clearSuddenDeathPresentation();
}
function seriesReasonText(reason, loserName, rejectedWord) {
  const name = loserName || "A player";
  if (reason === "invalid_word")
    return name + " rejected " + (rejectedWord || "a word") + " and takes a strike.";
  if (reason === "host_skip") return "The host skipped this micro-round. No strike.";
  if (reason === "timeout") return "Time expired. No strike.";
  return "The micro-round ended without a strike.";
}
function renderSeriesStandings(series, target) {
  if (!target) return;
  target.replaceChildren(
    ...(series?.participants || []).map((player) => {
      const row = document.createElement("div");
      row.className = "series-standing" +
        (player.status === "withdrawn" ? " is-withdrawn" : "");
      const identity = document.createElement("span");
      renderPlayerName(identity, player);
      const status = document.createElement("small");
      status.textContent = player.status === "withdrawn"
        ? "WITHDRAWN"
        : (Number(player.strikes) || 0) + " STRIKE" +
          (Number(player.strikes) === 1 ? "" : "S");
      row.append(identity, status);
      return row;
    }),
  );
}
function renderSeriesTransition(message = {}, series = message.series) {
  if (!series) return;
  clearTimeout(seriesTransitionTimer);
  const roundNumber = Number(message.roundNumber) ||
    Math.max(1, Number(series.currentRoundNumber) - 1);
  const history = series.history || [];
  const outcome = message.reason
    ? message
    : history.find((entry) => Number(entry.roundNumber) === roundNumber) || {};
  $("#seriesTransitionTitle").textContent =
    "Round " + roundNumber + " of " + (series.totalRounds || 10);
  $("#seriesTransitionOutcome").textContent = seriesReasonText(
    outcome.reason,
    outcome.loserName || outcome.loser?.name,
    outcome.rejectedWord,
  );
  renderSeriesStandings(series, $("#seriesTransitionStandings"));
  const deadline = Number(message.nextRoundAt || series.nextRoundAt) || Date.now();
  const update = () => {
    const remaining = Math.max(0, deadline - Date.now());
    $("#seriesTransitionNext").textContent = remaining
      ? "Next board in " + (remaining / 1000).toFixed(1) + " seconds…"
      : "Next board is starting…";
    if (remaining)
      seriesTransitionTimer = setTimeout(update, Math.min(100, remaining));
  };
  update();
  show("seriesTransitionScreen");
}
window.wordrushSeriesRoundFinished = (message) => {
  if (!message?.series?.id) return;
  if (s.onlineSeriesId && s.onlineSeriesId !== message.series.id) return;
  cancelRoundIntro();
  clearInterval(s.timer);
  clearPick(true);
  clearTrace();
  activeOnlineRoundKey = null;
  s.done = 1;
  s.onlineRoundKey = message.roundId || s.onlineRoundKey;
  s.onlineSeries = message.series;
  s.onlineSeriesId = message.series.id;
  renderSeriesTransition(message, message.series);
};
window.wordrushSeriesState = (series) => {
  if (!series?.id || series.phase !== "interstitial") return;
  if (s.onlineSeriesId && s.onlineSeriesId !== series.id) return;
  s.onlineSeries = series;
  s.onlineSeriesId = series.id;
  renderSeriesTransition({}, series);
};
window.wordrushSeriesCancelled = () => {
  clearSeriesPresentation();
  s.onlineRoundKey = null;
  s.done = 1;
};
function triggerSuddenDeathExplosion(details, roundKey = s.suddenDeathRoundKey) {
  const explosion = $("#suddenDeathExplosion");
  const copy = suddenDeathOutcome.formatSuddenDeathOutcome(details);
  if (!explosion || !copy) return;
  if (
    roundKey !== s.suddenDeathRoundKey ||
    roundKey !== currentSuddenDeathRoundKey()
  )
    return;
  if (suddenDeathPresentedRoundKey === roundKey) return;
  suddenDeathPresentedRoundKey = roundKey;
  $("#suddenDeathExplosionTitle").textContent = "💥 SUDDEN DEATH!";
  $("#suddenDeathExplosionDetail").textContent = copy;
  explosion.hidden = false;
  explosion.classList.remove("is-active");
  void explosion.offsetWidth;
  explosion.classList.add("is-active");
  clearTimeout(suddenDeathExplosionTimer);
  const presentationGeneration = suddenDeathPresentationGeneration;
  suddenDeathExplosionTimer = setTimeout(() => {
    if (
      presentationGeneration !== suddenDeathPresentationGeneration ||
      roundKey !== s.suddenDeathRoundKey ||
      roundKey !== currentSuddenDeathRoundKey()
    )
      return;
    explosion.hidden = true;
    explosion.classList.remove("is-active");
    $("#suddenDeathExplosionDetail").textContent = "";
    suddenDeathExplosionTimer = 0;
  }, 4500);
}
function end(completionReason) {
  if (
    window.wordrushSocket?.readyState === 1 &&
    window.wordrushSessionCode &&
    !s.done
  ) {
    if (!s.onlineRoundKey) {
      toast("There is no active multiplayer round to skip");
      return;
    }
    window.wordrushSocket.send(JSON.stringify({
      type: "skip_round",
      roundId: s.onlineRoundKey,
    }));
    return;
  }
  if (s.done) return;
  if (
    !s.onlineRoundKey &&
    !roundOutcome.SOLO_COMPLETION_REASONS.includes(completionReason)
  )
    return;
  if (
    !s.onlineRoundKey &&
    (!s.soloRoundId || !s.startedAt || !s.endsAt || s.endsAt <= s.startedAt)
  )
    return;
  const soloGameplaySeconds = !s.onlineRoundKey
    ? roundTiming.elapsedGameplaySeconds(s.startedAt, Date.now(), s.config?.seconds)
    : 0;
  if (!s.onlineRoundKey) invalidateSoloSubmissionQueue();
  s.done = 1;
  clearInterval(s.timer);
  if (s.rush && !s.nextRushMode) {
    s.nextRushMode = nextRandomMode();
    emit("random-rush", {
      action: "upcoming",
      current_mode: s.mode,
      upcoming_mode: s.nextRushMode,
    });
  }
  $("#finalScore").textContent = s.score;
  $("#resultWordCount").textContent = s.found.size;
  $("#resultEyebrow").textContent = "ROUND COMPLETE!";
  $("#resultScoreLabel").textContent = "FINAL SCORES";
  renderResults(null, { suddenDeath: s.suddenDeathEvent });
  renderSuddenDeath(s.suddenDeathEvent);
  if (s.suddenDeathEvent)
    triggerSuddenDeathExplosion(s.suddenDeathEvent, s.suddenDeathRoundKey);
  const dailyTarget = s.dailyChallenge?.target;
  $("#dailyChallengeResult").hidden = !s.dailyChallenge;
  $("#dailyShareLink").hidden = true;
  $("#dailyShareLink").value = "";
  $("#dailyShareStatus").textContent = "";
  if (s.dailyChallenge) {
    const comparison = dailyTarget
      ? s.score > dailyTarget.score
        ? "You beat the challenge by " + (s.score - dailyTarget.score) + " points."
        : s.score < dailyTarget.score
          ? "You are " + (dailyTarget.score - s.score) + " points from the challenge."
          : "It is a tie. One more run could settle it."
      : "Your score is ready for a friend to chase.";
    $("#dailyChallengeResultDetail").textContent = comparison;
    $("#raceDailyEcho").hidden = false;
    $("#raceDailyEcho").textContent = s.echo?.target
      ? "Race this echo again"
      : "Race your echo";
    saveDailyEcho(s.dailyChallenge.id, {
      score: s.score,
      checkpoints: s.echo?.checkpoints || [],
    });
  } else {
    $("#raceDailyEcho").hidden = true;
  }
  profile.score += s.score;
  profile.rounds++;
  profile.totalGameSeconds += soloGameplaySeconds;
  const soloOutcome = roundOutcome.classifySoloOutcome(s.config, completionReason);
  const soloDeltas = roundOutcome.outcomeAccounting(soloOutcome);
  profile.gamesWon += soloDeltas.gamesWon;
  profile.gamesLost += soloDeltas.gamesLost;
  if (soloDeltas.updatesMaxGridWin)
    profile.maxGridWin = Math.max(profile.maxGridWin || 0, s.n);
  recordPlayDay();
  updateProfile();
  $("#again").disabled = false;
  $("#again").textContent = s.dailyChallenge
    ? "Try today again →"
    : s.rush
    ? "Continue Random Rush →"
    : !s.onlineRoundKey && isPartyRound(s.config)
      ? "Continue party mode →"
      : "Play again →";
  $("#exitParty").hidden = Boolean(s.onlineRoundKey) || !isPartyRound(s.config);
  show("resultsScreen");
  emit("round-complete", {
    ranking: [
      {
        name: profile.name,
        avatar: profile.avatar,
        score: s.score,
        words: [...s.found].map((word) => ({
          word,
          points: word.length * word.length,
        })),
      },
    ],
    multiplayer: false,
    cooperative: false,
    mode: s.mode,
    randomRush: s.rush,
    suddenDeath: s.suddenDeathEvent,
    dictionary: s.dictionaryMetadata,
  });
  if (s.rush) {
    const rushDelay = window.wordrushRushDelay || 20000;
    $("#stopRushResults").hidden = false;
    let left = Math.ceil(rushDelay / 1000);
    renderRushNextRound(s.nextRushMode, left);
    s.rushCountdown = setInterval(() => {
      left--;
      if (left > 0) renderRushNextRound(s.nextRushMode, left);
    }, 1000);
    const continuationGeneration = ++rushContinuationGeneration;
    s.rushTimer = setTimeout(() => {
      if (continuationGeneration !== rushContinuationGeneration) return;
      clearInterval(s.rushCountdown);
      s.rushCountdown = 0;
      s.rushTimer = 0;
      rushContinuationGeneration++;
      if (s.rush) {
        rushContinuationTransition = true;
        emit("random-rush", { action: "auto_advance" });
        clearRushNextRound();
        start(consumeNextRushMode(), null, false, true, s.dictionaryId, true);
      }
    }, rushDelay);
  }
}
function toast(m, tone = "default") {
  const t = $("#toast");
  t.textContent = m;
  t.classList.remove("toast-duplicate", "toast-wrong");
  if (tone !== "default") t.classList.add("toast-" + tone);
  t.classList.add("show");
  clearTimeout(toast.id);
  toast.id = setTimeout(() => {
    t.classList.remove("show", "toast-duplicate", "toast-wrong");
  }, 1800);
}
function cancelSoloRushContinuation({ stop = true } = {}) {
  soloGenerationRequest++;
  rushContinuationGeneration++;
  rushContinuationTransition = false;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  s.rushTimer = 0;
  s.rushCountdown = 0;
  $("#stopRushResults").hidden = true;
  clearRushNextRound();
  if (stop) {
    s.rush = false;
    s.nextRushMode = null;
  }
}
const appRoutes = window.WordrushRoutes;
let initialAppRoute = appRoutes.routeForPath(location.pathname) || appRoutes.HOME;
window.wordrushInitialRoute = initialAppRoute;

function updateRouteMetadata(pathname) {
  const route = appRoutes.seoForPath(pathname);
  document.title = route.title;
  const description = document.querySelector('meta[name="description"]');
  const canonical = document.querySelector('link[rel="canonical"]');
  if (description) description.setAttribute("content", route.description);
  if (canonical) canonical.setAttribute("href", new URL(route.path, location.origin).href);
  for (const [selector, value] of [
    ['meta[property="og:url"]', new URL(route.path, location.origin).href],
    ['meta[property="og:title"]', route.title],
    ['meta[property="og:description"]', route.description],
    ['meta[name="twitter:title"]', route.title],
    ['meta[name="twitter:description"]', route.description],
  ]) {
    const element = document.querySelector(selector);
    if (element) element.setAttribute("content", value);
  }
}

function writeAppRoute(pathname, { replace = false } = {}) {
  const current = location.pathname + location.search + location.hash;
  if (current !== pathname)
    history[replace ? "replaceState" : "pushState"](
      { wordrushRoute: pathname },
      "",
      pathname,
    );
  updateRouteMetadata(pathname.split("?")[0]);
  document.dispatchEvent(new CustomEvent("wordrush:route-change", {
    detail: appRoutes.seoForPath(pathname.split("?")[0]),
  }));
}

function gameRoutePath(mode, { randomRush = false, config = null } = {}) {
  return appRoutes.routeForMode(mode, { randomRush, config })?.path || "/games/custom";
}

function syncGameRoute(mode, { randomRush = false, config = null } = {}) {
  let path = gameRoutePath(mode, { randomRush, config });
  const params = new URLSearchParams(location.search);
  const sharedKey = mode === "daily"
    ? "challenge"
    : mode === "relay"
      ? "relay"
      : null;
  const sharedRef = sharedKey && params.get(sharedKey);
  if (sharedRef && params.getAll(sharedKey).length === 1)
    path += "?" + sharedKey + "=" + encodeURIComponent(sharedRef);
  const current = appRoutes.routeForPath(location.pathname);
  const replacingBuilder = current?.key === "custom" || current?.key === "party";
  writeAppRoute(path, { replace: replacingBuilder });
}

function syncScreenRoute(id, currentScreen) {
  if (id === "resultsScreen") return writeAppRoute("/", { replace: true });
  const path = id === "homeScreen"
    ? "/"
    : id === "statsScreen"
      ? "/stats"
      : id === "achievementsScreen"
        ? "/progress"
        : null;
  if (!path) return;
  writeAppRoute(path, {
    replace: id === "homeScreen" &&
      ["roundIntroScreen", "gameScreen", "seriesTransitionScreen", "resultsScreen"].includes(currentScreen),
  });
}

function abandonForRouteNavigation() {
  const currentScreen = document.querySelector(".screen.active")?.id;
  if (
    ["roundIntroScreen", "gameScreen", "seriesTransitionScreen"].includes(currentScreen) &&
    !s.onlineRoundKey
  ) {
    abandonActiveRound();
    cancelSoloRushContinuation();
  }
}

function launchAppRoute(route) {
  if (route.kind === "page") {
    show(route.screen, { routeMode: "none" });
    return;
  }
  if (route.launcher === "random") return start(nextRandomMode(), null, false, true);
  if (route.launcher === "daily") {
    const ref = new URLSearchParams(location.search).get("challenge");
    if (/^[A-Za-z0-9_-]{20,40}$/.test(ref || ""))
      return requestSharedChallenge(ref)
        .then((shared) => startDailyRush(shared))
        .catch(() => toast("That challenge link is unavailable."));
    return startDailyRush();
  }
  if (route.launcher === "echo") return startDailyRush(null, true);
  if (route.launcher === "relay") {
    const ref = new URLSearchParams(location.search).get("relay");
    if (/^[A-Za-z0-9_-]{20,40}$/.test(ref || "")) return startWordRelay(ref);
    return startWordRelay();
  }
  if (route.launcher === "party") return openParty();
  if (route.launcher === "custom") return openRushBuilder();
  if (route.launcher === "multiplayer") {
    window.wordrushOpenMultiplayerRoute = true;
    document.dispatchEvent(new CustomEvent("wordrush:open-multiplayer"));
    return;
  }
  return start(route.mode);
}

function navigateAppRoute(route) {
  const currentScreen = document.querySelector(".screen.active")?.id;
  if (route.key !== "custom") $("#customDialog")?.close();
  if (route.key !== "party") $("#partyDialog")?.close();
  if (route.kind === "game") {
    if (
      ["roundIntroScreen", "gameScreen", "seriesTransitionScreen"].includes(currentScreen) &&
      (route.path !== location.pathname || !s.onlineRoundKey)
    )
      abandonForRouteNavigation();
    launchAppRoute(route);
    return;
  }
  abandonForRouteNavigation();
  show(route.screen, { routeMode: "none" });
  document.dispatchEvent(new CustomEvent("wordrush:route-change", { detail: route }));
}

function show(
  id,
  {
    preserveRushContinuation = false,
    preserveRoundIntro = false,
    routeMode = "auto",
  } = {},
) {
  const currentScreen = document.querySelector(".screen.active")?.id;
  if (
    currentScreen === "roundIntroScreen" &&
    id !== currentScreen &&
    !preserveRoundIntro
  ) {
    cancelRoundIntro();
    if (!s.onlineRoundKey) abandonActiveRound();
  }
  if (
    currentScreen === "resultsScreen" &&
    id !== currentScreen
  ) {
    clearSuddenDeathPresentation();
    if (!preserveRushContinuation && s.rush && !s.onlineRoundKey)
      cancelSoloRushContinuation();
  }
  if (id === "homeScreen") soloGenerationRequest++;
  document
    .querySelectorAll(".screen")
    .forEach((x) => x.classList.toggle("active", x.id === id));
  document
    .querySelectorAll("nav [data-screen]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.screen === id),
    );
  if (routeMode !== "none") syncScreenRoute(id, currentScreen);
  emit("screen-change", { id });
}
let roundIntroTimer = 0;
let roundIntroCountdown = 0;
let roundIntroFinish = null;
let roundIntroGeneration = 0;
let activeOnlineRoundKey = null;
let seriesTransitionTimer = 0;
function cancelRoundIntro() {
  roundIntroGeneration++;
  clearTimeout(roundIntroTimer);
  clearInterval(roundIntroCountdown);
  roundIntroTimer = 0;
  roundIntroCountdown = 0;
  roundIntroFinish = null;
}
function finishRoundIntro(generation = roundIntroGeneration) {
  if (generation !== roundIntroGeneration) return;
  const finish = roundIntroFinish;
  cancelRoundIntro();
  if (finish) finish();
}
function showRoundIntro({
  label,
  rule,
  detail,
  duration = 4000,
  analytics = {},
  onStart,
}) {
  cancelRoundIntro();
  const introGeneration = roundIntroGeneration;
  roundIntroFinish = onStart;
  $("#introMode").textContent = label || "NEXT ROUND";
  $("#introRule").textContent = rule || "Make words. Make noise.";
  $("#introDetail").textContent = detail || "Get ready to trace";
  const deadline = Date.now() + Math.max(0, duration);
  const updateCountdown = () => {
    if (introGeneration !== roundIntroGeneration) return;
    const remaining = Math.max(0, deadline - Date.now());
    $("#introCountdown").textContent = remaining
      ? String(Math.ceil(remaining / 1000))
      : "GO";
  };
  updateCountdown();
  roundIntroCountdown = setInterval(updateCountdown, 100);
  roundIntroTimer = setTimeout(
    () => finishRoundIntro(introGeneration),
    Math.max(0, duration),
  );
  emit("round-intro", {
    ...analytics,
    label,
    duration_ms: Math.round(Math.max(0, duration)),
  });
  const preserveRushContinuation = rushContinuationTransition;
  show("roundIntroScreen", { preserveRushContinuation });
  rushContinuationTransition = false;
}
$("#introStart")?.addEventListener("click", () => {
  if (window.wordrushStartRoundNow?.()) return;
  finishRoundIntro();
});
function abandonActiveRound() {
  clearSuddenDeathPresentation();
  soloGenerationRequest++;
  if (!s.onlineRoundKey) invalidateSoloSubmissionQueue();
  clearInterval(s.timer);
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  clearRushNextRound();
  cancelRoundIntro();
  s.done = 1;
  s.soloRoundId = 0;
  s.startedAt = 0;
  s.endsAt = 0;
  s.acceptingSoloSubmissions = false;
  activeOnlineRoundKey = null;
  s.onlineRoundKey = null;
  s.onlineSeries = null;
  s.onlineSeriesId = null;
  s.onlineIntroEndsAt = 0;
  s.pendingOnlineTrace = null;
  clearPick(true);
  clearTrace();
}
window.wordrushAbandonOnlineRound = () => {
  if (s.onlineRoundKey) abandonActiveRound();
  cancelSoloRushContinuation();
  s.config = null;
  s.onlineRandomRush = false;
  clearSeriesPresentation();
  s.onlineResultRoundId = null;
  s.onlineNextRound = null;
  s.onlineResultAction = null;
  s.relayChallenge = null;
  s.heist = null;
  // A host can close the room while another player is still looking at the
  // board. The room shutdown is authoritative, so do not leave that player
  // stranded on a dead game screen.
  show("homeScreen");
};
window.wordrushReturnToOnlineRound = () => {
  if (s.onlineRoundKey && !s.done) resumeOnlineRound();
};
$("#gameBack")?.addEventListener("click", () => {
  if (!window.wordrushSessionCode || !s.onlineRoundKey) abandonActiveRound();
  show("homeScreen");
});
function stopRush() {
  emit("random-rush", { action: "stop", mode: s.mode });
  cancelSoloRushContinuation();
  if (!s.done) abandonActiveRound();
  else if (!s.onlineRoundKey) invalidateSoloSubmissionQueue();
  $("#stopRush").hidden = true;
  show("homeScreen");
}
async function start(
  mode,
  rawConfig = null,
  adultMode = false,
  rush = false,
  dictionaryId = DEFAULT_DICTIONARY_ID,
  skipRoundIntro = false,
  dailyChallenge = null,
  relayChallenge = null,
) {
  const generationRequest = ++soloGenerationRequest;
  if (
    !dailyChallenge &&
    !relayChallenge &&
    window.wordrushStartSessionGame?.({
      mode,
      config: rawConfig || null,
      randomRush: rush,
      dictionaryId,
    })
  )
    return;
  const preset = configForPreset(mode);
  let nextConfig;
  let nextCustomAdult;
  if (preset) {
    nextConfig = { ...preset };
    nextCustomAdult = usesAdultLexicon(preset);
  } else if (mode === "custom") {
    const raw = { ...(rawConfig || {}), adult: adultMode || Boolean(rawConfig?.adult) };
    const result = validateCustomConfig(raw);
    if (!result.valid) {
      toast(result.error || "Invalid custom configuration");
      return;
    }
    nextConfig = { ...result.config };
    nextCustomAdult = usesAdultLexicon(result.config);
  } else if (relayChallenge) {
    nextConfig = { ...relayChallenge.challenge.config };
    nextCustomAdult = false;
  } else {
    return;
  }
  const generationInputs = Object.freeze({
    mode,
    config: Object.freeze(nextConfig),
    adultMode: nextCustomAdult,
    rush,
    dictionaryId,
  });
  const wasRush = s.rush;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  let generated;
  let dictionary;
  try {
    [generated, dictionary] = await Promise.all([
      dailyChallenge
        ? Promise.resolve(dailyChallenge.challenge)
        : relayChallenge
          ? Promise.resolve(relayChallenge.challenge)
        : requestSoloBoard({
            mode: generationInputs.mode,
            config: generationInputs.config,
            adultMode: generationInputs.adultMode,
            dictionaryId: generationInputs.dictionaryId,
          }),
      fetchDictionary(generationInputs.dictionaryId),
    ]);
    if (!dailyChallenge && !relayChallenge) generated = await applySoloBoardTestFixture(generated);
  } catch (error) {
    if (generationRequest !== soloGenerationRequest) return;
    const failureMessage =
      error.code === "BOARD_GENERATION_FAILED" &&
      error.failureCode === "QUALITY_PROFILE_UNAVAILABLE"
        ? "This configuration is not currently supported."
        : error.code === "BOARD_GENERATION_FAILED" &&
          ["NO_QUALITY_CANDIDATE", "QUALITY_SELECTION_GLOBAL_LIMIT"].includes(
            error.failureCode,
          )
          ? "No suitable board was found. Please try again."
          : "Board generation failed. Please try again.";
    toast(failureMessage);
    return;
  }
  if (generationRequest !== soloGenerationRequest) return;
  const config = generated.config;
  clearSuddenDeathPresentation();
  invalidateSoloSubmissionQueue();
  s.config = config;
  s.dictionaryId = dictionary.dictionary.dictionaryId;
  s.dictionaryMetadata = dictionary.dictionary;
  s.dictionaryWords = dictionary.words;
  customAdult = generationInputs.adultMode;
  s.mode = generationInputs.mode;
  s.rush = generationInputs.rush;
  syncGameRoute(s.mode, { randomRush: s.rush, config: nextConfig });
  s.dailyChallenge = dailyChallenge
    ? {
        id: dailyChallenge.challenge.id,
        date: dailyChallenge.challenge.date,
        target: dailyChallenge.target,
        shareRef: dailyChallenge.shareRef,
      }
    : null;
  s.relayChallenge = relayChallenge
    ? {
        id: relayChallenge.challenge.id,
        revision: relayChallenge.challenge.revision,
        state: {
          found: [...relayChallenge.challenge.state.found],
          requiredLetter: relayChallenge.challenge.state.requiredLetter,
          turns: relayChallenge.challenge.state.turns,
        },
      }
    : null;
  s.heist = null;
  s.echo = s.dailyChallenge
    ? { target: dailyChallenge?.echo || null, checkpoints: [] }
    : null;
  s.onlineRoundKey = null;
  s.onlineSeries = null;
  s.onlineSeriesId = null;
  s.onlineResultRoundId = null;
  s.onlineNextRound = null;
  s.onlineResultAction = null;
  s.pendingOnlineTrace = null;
  if (rush && !wasRush) {
    randomModeQueue = [];
    s.nextRushMode = null;
  }
  document.body.dataset.mode = mode;
  s.n = config.size;
  s.time = config.seconds;
  s.score = 0;
  s.found.clear();
  s.lastAcceptedWord = "";
  s.requiredLetter = "";
  s.chainResetLetter = "";
  s.chainRemainingByInitial = config.chain
    ? { ...generated.playableWordStarts }
    : {};
  if (s.relayChallenge) {
    s.found = new Set(s.relayChallenge.state.found);
    s.requiredLetter = s.relayChallenge.state.requiredLetter || "";
  }
  s.rejectedAttempt = "";
  s.rejectionReason = "";
  s.roundWordTimes = [];
  s.pick = [];
  s.frozenIndexes = new Set();
  s.b = generated.board;
  s.bounty = mode === "bounty"
    ? {
        bountyIndexes: challengeRules.selectBountyIndexes(
          s.b.map((_, index) => index),
          3,
          generated.seed ?? generated.quality?.selectedCandidateSeed ?? generated.id,
        ),
        claimedIndexes: [],
      }
    : null;
  s.done = 0;
  s.soloRoundId = ++soloRoundGeneration;
  s.startedAt = 0;
  s.endsAt = 0;
  s.acceptingSoloSubmissions = false;
  clearInterval(s.timer);
  s.timer = 0;
  $("#gameMode").textContent = config.label;
  $("#gameTitle").textContent = s.dailyChallenge
    ? "Daily Rush · " + s.dailyChallenge.date
    : s.relayChallenge
      ? "Word Relay · turn " + (s.relayChallenge.state.turns + 1)
    : "Round 01 · " + s.n + "×" + s.n;
  $("#ruleText").textContent = config.rule;
  $("#gameHint").textContent = s.relayChallenge
    ? "Pass the final letter · minimum " + config.min
    : "Minimum " + config.min + " letters";
  $("#gameScore").textContent = 0;
  $("#timer").textContent = formatTimer(s.time);
  $("#stopRush").hidden = !s.rush;
  $("#endGame").hidden = true;
  $("#cancelSeries").hidden = true;
  $("#cancelSeriesTransition").hidden = true;
  $("#endGame").textContent = "End Round";
  $("#endGame").setAttribute("aria-label", "End Round");
  $("#endGame").setAttribute("title", "Finish this round and show results");
  $("#gameBack").setAttribute("aria-label", "Back to home");
  $("#stopRushResults").hidden = true;
  clearRushNextRound();
  render();
  const startSoloGameplay = () => {
    const timing = roundTiming.startGameplay(Date.now(), config.seconds);
    s.startedAt = timing.startedAt;
    s.endsAt = timing.endsAt;
    s.acceptingSoloSubmissions = true;
    s.time = config.seconds;
    const preserveRushContinuation = rushContinuationTransition;
    show("gameScreen", { preserveRushContinuation, preserveRoundIntro: true });
    rushContinuationTransition = false;
    clearInterval(s.timer);
    $("#endGame").hidden = false;
    $("#timer").textContent = formatTimer(s.time);
    s.timer = setInterval(() => {
      s.time = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
      $("#timer").textContent = formatTimer(s.time);
      updateEchoPace();
      if (s.time <= 0) end("timeout");
    }, 250);
    updateEchoPace();
    emit("round-started", {
      mode,
      multiplayer: false,
      random_rush: s.rush,
      party: isPartyRound(config),
      grid_size: s.n,
      minimum_length: config.min,
      duration_seconds: config.seconds,
    });
  };
  if (skipRoundIntro && s.rush) return startSoloGameplay();
  showRoundIntro({
    label: s.config.label,
    rule: config.rule,
    detail: s.dailyChallenge
      ? "One shared board · make your mark"
      : s.rush
        ? "Random Rush · next challenge loading"
        : "Your board is ready",
    analytics: {
      mode,
      multiplayer: false,
      random_rush: s.rush,
      party: isPartyRound(config),
      grid_size: s.n,
      minimum_length: config.min,
    },
    onStart: startSoloGameplay,
  });
}
async function startDailyRush(shared = null, raceEcho = false) {
  let daily = shared;
  try {
    if (!daily) daily = await requestDailyChallenge();
  } catch (error) {
    toast(error.code === "CHALLENGE_NOT_FOUND"
      ? "That Daily Rush link has expired."
      : "Daily Rush is not ready yet. Please try again.");
    return;
  }
  const challenge = daily.challenge;
  if (raceEcho) {
    const echo = loadDailyEcho(challenge.id);
    if (!echo) {
      toast("Finish a Daily Rush first to create your echo.");
      return;
    }
    daily = { ...daily, echo };
  }
  return start(
    "daily",
    null,
    false,
    false,
    challenge.dictionary.dictionaryId,
    false,
    daily,
  );
}
async function startWordRelay(id = null) {
  try {
    const relay = await requestRelayChallenge(id);
    const challenge = relay.challenge;
    return start(
      "relay",
      null,
      false,
      false,
      challenge.dictionary.dictionaryId,
      false,
      null,
      relay,
    );
  } catch (error) {
    toast(error.code === "RELAY_NOT_FOUND"
      ? "That Word Relay link has expired."
      : "Word Relay is not ready yet. Please try again.");
  }
}
function pickedPathIsValid(trace, word) {
  return (
    trace.length === word.length &&
    trace.every(
      (index, position) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < s.b.length &&
        s.b[index] === word[position] &&
        trace.indexOf(index) === position &&
        (position === 0 || near(trace[position - 1]).includes(index)),
    )
  );
}
async function submitRelayWord(trace, word) {
  if (!s.relayChallenge || !s.acceptingSoloSubmissions || s.done) return;
  const normalized = String(word || "").toUpperCase();
  const validPath = pickedPathIsValid(trace, normalized);
  if (normalized.length < s.config.min || !validPath || s.found.has(normalized)) {
    toast(
      normalized.length < s.config.min
        ? "Wrong word · need " + s.config.min + " letters"
        : !validPath
          ? "Wrong word · tiles must connect"
          : "Already found — try a new word",
      "wrong",
    );
    pulseIncorrectWord(trace);
    return;
  }
  if (s.requiredLetter && !chainWordMatches(s.requiredLetter, normalized)) {
    toast("Wrong word · start with " + s.requiredLetter, "wrong");
    pulseIncorrectWord(trace);
    return;
  }
  const challenge = s.relayChallenge;
  try {
    const response = await fetch("/api/relay-challenges/" + encodeURIComponent(challenge.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: challenge.revision, word: normalized, path: trace }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.state) {
      const reason = payload?.error;
      toast(
        reason === "RELAY_STALE_REVISION"
          ? "Relay changed — reload the challenge"
          : reason === "chain"
            ? "Wrong word · follow the chain"
            : "That word was not accepted",
        "wrong",
      );
      pulseIncorrectWord(trace);
      return;
    }
    s.relayChallenge = {
      id: payload.id,
      revision: payload.revision,
      state: {
        found: [...payload.state.found],
        requiredLetter: payload.state.requiredLetter,
        turns: payload.state.turns,
      },
    };
    s.found = new Set(s.relayChallenge.state.found);
    s.requiredLetter = s.relayChallenge.state.requiredLetter || "";
    s.lastAcceptedWord = normalized;
    const points = normalized.length * normalized.length;
    s.score += points;
    recordAcceptedWord(normalized);
    updateProfile();
    renderChainStatus();
    renderChallengeStatus();
    $("#gameScore").textContent = s.score;
    $("#preview").textContent = normalized + " +" + points;
    $("#preview").classList.add("found");
    pulseAcceptedWord(trace);
    toast("Turn saved · share the relay link");
    emit("word-accepted", { word: normalized, points, mode: "relay", multiplayer: false, randomRush: false });
  } catch {
    toast("Relay connection failed — try again", "wrong");
    pulseIncorrectWord(trace);
  }
}
async function submit() {
  let trace = s.pick.slice(),
    w = s.pick.map((i) => s.b[i]).join("");
  if (
    window.wordrushSessionCode &&
    window.wordrushSocket?.readyState === WebSocket.OPEN
  ) {
    s.pendingOnlineTrace = { word: w, trace };
    window.wordrushSocket.send(
      JSON.stringify({
        type: "submit_word",
        word: w,
        path: trace,
        roundId: s.onlineRoundKey,
      }),
    );
    clearPick();
    return;
  }
  if (s.relayChallenge) {
    clearPick();
    await submitRelayWord(trace, w);
    return;
  }
  if (!s.acceptingSoloSubmissions) {
    clearPick();
    return;
  }
  const blocked = challengeRules.blockedTraceResult(trace, s.frozenIndexes);
  if (!blocked.valid) {
    clearPick();
    toast("That tile is frozen by the Curse.", "wrong");
    return;
  }
  const config = Object.freeze({
      min: s.config.min,
      target: s.config.target,
      chain: s.config.chain,
      sudden: s.config.sudden,
      mode: s.mode,
      randomRush: s.rush,
    }),
    validPath = pickedPathIsValid(trace, w),
    roundEpoch = soloSubmissionEpoch,
    roundId = s.soloRoundId,
    roundStartedAt = s.startedAt,
    roundEndsAt = s.endsAt,
    dictionaryId = s.dictionaryId,
    adultMode = customAdult;
  clearPick();
  const dictionaryRequest =
    w.length >= config.min && validPath
      ? isServerDictionaryWord(w, dictionaryId, adultMode)
      : Promise.resolve(false);
  void enqueueSoloSubmission(async () => {
    const inDictionary = await dictionaryRequest;
    if (!isCurrentSoloSubmission(roundEpoch, roundId, roundStartedAt, roundEndsAt)) return;
    if (roundEndsAt && Date.now() >= roundEndsAt) {
      end("timeout");
      return;
    }
    const duplicate = s.found.has(w);
    let rejectReason = null;
    if (w.length < config.min) rejectReason = "minimum";
    else if (!validPath) rejectReason = "path";
    else if (duplicate) rejectReason = "duplicate";
    else if (!inDictionary) rejectReason = "dictionary";
    else if (requiresChain(config) &&
      !chainWordMatches(s.requiredLetter, w)) rejectReason = "chain";
    if (!rejectReason) {
      let points = w.length * w.length;
      s.found.add(w);
      s.lastAcceptedWord = w;
      if (requiresChain(config)) advanceChainFields(s, w);
      s.rejectedAttempt = "";
      s.rejectionReason = "";
      if (s.mode === "curse") {
        s.frozenIndexes.add(trace.at(-1));
        render();
      }
      if (s.bounty) {
        const effect = challengeRules.bountyClaimEffect(s.bounty, trace);
        s.bounty = {
          bountyIndexes: [...s.bounty.bountyIndexes],
          claimedIndexes: [...effect.claimedIndexes],
        };
        const bountyBonus = effect.newlyClaimedIndexes.length * 25;
        points += bountyBonus;
        if (bountyBonus) render();
      }
      s.score += points;
      if (s.echo) {
        s.echo.checkpoints = challengeRules.recordEchoCheckpoint(
          s.echo.checkpoints,
          { elapsedMs: Math.max(0, Date.now() - s.startedAt), score: s.score },
        );
      }
      recordAcceptedWord(w);
      updateProfile();
      renderChainStatus();
      $("#gameScore").textContent = s.score;
      $("#preview").textContent = w + " +" + points;
      $("#preview").classList.add("found");
      pulseAcceptedWord(trace);
      emit("word-accepted", {
        word: w,
        points,
        mode: config.mode,
        multiplayer: false,
        randomRush: config.randomRush,
      });
      if (hasScoreTarget(config) && s.score >= config.target)
        end("target_reached");
    } else {
      s.rejectedAttempt = w;
      s.rejectionReason = rejectReason;
      renderChainStatus();
      if (rejectReason === "duplicate") pulseDuplicateWord(trace);
      else pulseIncorrectWord(trace);
      profile.incorrect++;
      updateProfile();
      toast(
        rejectReason === "minimum"
          ? "Wrong word · need " + config.min + " letters"
          : rejectReason === "chain"
            ? "Wrong word · chain starts with " + s.requiredLetter
            : rejectReason === "path"
              ? "Wrong word · tiles must connect"
              : rejectReason === "duplicate"
                ? "Already found — try a new word"
                : "Wrong word · not in dictionary",
        rejectReason === "duplicate" ? "duplicate" : "wrong",
      );
      emit("word-rejected", {
        mode: config.mode,
        reason: rejectReason,
        word_length: w.length,
        multiplayer: false,
        random_rush: config.randomRush,
      });
      if (shouldEndOnRejectedWord(config, rejectReason)) {
        s.suddenDeathEvent = suddenDeathOutcome.createSuddenDeathOutcome({
          loser: { id: "local-player", name: profile.name, avatar: profile.avatar },
          participants: [{ id: "local-player", name: profile.name, avatar: profile.avatar }],
          word: w,
        });
        s.suddenDeathRoundKey = currentSuddenDeathRoundKey();
        const fatalEpoch = invalidateSoloSubmissionQueue();
        const fatalRoundKey = s.suddenDeathRoundKey;
        triggerSuddenDeathExplosion(s.suddenDeathEvent, fatalRoundKey);
        setTimeout(() => {
          if (
            soloSubmissionEpoch !== fatalEpoch ||
            s.done ||
            s.soloRoundId !== roundId ||
            s.startedAt !== roundStartedAt ||
            s.suddenDeathRoundKey !== fatalRoundKey
          )
            return;
          end("fatal_rejection");
        }, 300);
      }
    }
    setTimeout(() => {
      $("#preview").classList.remove("found");
      $("#preview").textContent = "Trace a word";
    }, 900);
  });
}
function smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return "M " + points[0].x + " " + points[0].y;
  let d = "M " + points[0].x + " " + points[0].y;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2,
    };
    d += " Q " + points[i].x + " " + points[i].y + " " + mid.x + " " + mid.y;
  }
  const last = points.at(-1);
  d += " T " + last.x + " " + last.y;
  return d;
}
function tracePoint(x, y) {
  const rect = $("#traceLayer").getBoundingClientRect();
  s.trace.push({
    x: ((x - rect.left) / rect.width) * 1000,
    y: ((y - rect.top) / rect.height) * 1000,
  });
  if (!s.traceFrame) {
    s.traceFrame = requestAnimationFrame(() => {
      s.traceFrame = 0;
      $("#tracePath").setAttribute("d", smoothPath(s.trace));
    });
  }
}
function clearTrace() {
  s.previousPointer = null;
  s.trace = [];
  $("#tracePath").removeAttribute("d");
}
function pick(t) {
  if (!t || s.pick.includes(+t.dataset.i)) return;
  s.pick.push(+t.dataset.i);
  t.classList.add("selected");
  $("#preview").classList.add("is-tracing");
  $("#preview").textContent = s.pick.map((i) => s.b[i]).join("");
}
function pulseWord(trace, className) {
  const tiles = trace
    .map((index) => document.querySelector('.tile[data-i="' + index + '"]'))
    .filter(Boolean);
  tiles.forEach((tile) => {
    tile.classList.remove("word-correct", "word-incorrect", "word-duplicate");
    // Restart the animation when a player finds another word before the
    // previous completion animation has fully finished.
    void tile.offsetWidth;
    tile.classList.add(className);
  });
  setTimeout(() => {
    tiles.forEach((tile) => tile.classList.remove(className));
  }, 650);
}
function pulseAcceptedWord(trace) { pulseWord(trace, "word-correct"); }
function pulseIncorrectWord(trace) { pulseWord(trace, "word-incorrect"); }
function pulseDuplicateWord(trace) { pulseWord(trace, "word-duplicate"); }
$("#quickPlay")?.addEventListener("click", () => start("classic"));
$("#dailyRush")?.addEventListener("click", () => startDailyRush());
$("#echoRace")?.addEventListener("click", () => startDailyRush(null, true));
$("#wordRelay")?.addEventListener("click", () => startWordRelay());
$("#stopRush").onclick = stopRush;
$("#stopRushResults").onclick = stopRush;
let partyConfig = { size: 4, min: 3, seconds: 120 };
function syncPartyOptions() {
  for (const [attribute, value] of [
    ["partySize", partyConfig.size],
    ["partyMin", partyConfig.min],
    ["partyTime", partyConfig.seconds],
  ])
    document.querySelectorAll(`[data-${attribute.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}]`).forEach((button) => {
      const active = +button.dataset[attribute] === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  $("#partySummary").textContent =
    partyConfig.min + "+ letters · " + partyConfig.size + "×" + partyConfig.size +
    " · " + formatTimer(partyConfig.seconds);
}
function openParty() {
  writeAppRoute("/games/party-mode");
  syncPartyOptions();
  $("#partyDialog").showModal();
}
$("#partyMode").onclick = openParty;
document.querySelectorAll("[data-party-size]").forEach((button) => button.onclick = () => { partyConfig.size = +button.dataset.partySize; syncPartyOptions(); });
document.querySelectorAll("[data-party-min]").forEach((button) => button.onclick = () => { partyConfig.min = +button.dataset.partyMin; syncPartyOptions(); });
document.querySelectorAll("[data-party-time]").forEach((button) => button.onclick = () => { partyConfig.seconds = +button.dataset.partyTime; syncPartyOptions(); });
$("#partyForm").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "start") return;
  start("custom", {
    label: "PARTY MODE",
    min: partyConfig.min,
    size: partyConfig.size,
    seconds: partyConfig.seconds,
    rule: "Party round \u00b7 minimum " + partyConfig.min + " letters",
    party: true,
  });
});
$("#again").onclick = () => {
  if (s.onlineRoundKey && s.done) {
    const action = s.onlineResultAction;
    if (!window.wordrushSessionCreator) return;
    if (action?.nextRound) {
      if (action.consumed) return;
      const requested = window.wordrushStartNextRound?.({
        sourceRoundId: action.nextRound.sourceRoundId,
      });
      if (requested !== false) {
        action.consumed = true;
        $("#again").disabled = true;
        $("#again").textContent = "Starting " +
          configForPreset(action.nextRound.mode).label + "…";
      }
      return;
    }
    return start(s.mode, s.config, usesAdultLexicon(s.config), false, s.dictionaryId);
  }
  if (s.rush) {
    continueRandomRush();
    return;
  }
  if (s.dailyChallenge) return startDailyRush();
  if (!window.wordrushSessionCode && !s.onlineRoundKey && isPartyRound(s.config))
    return openParty();
  start(s.mode, s.config, usesAdultLexicon(s.config), false, s.dictionaryId);
};
function continueRandomRush() {
  if (!s.rush || !s.nextRushMode) return false;
  cancelSoloRushContinuation({ stop: false });
  rushContinuationTransition = true;
  emit("random-rush", { action: "continue", upcoming_mode: s.nextRushMode });
  start(consumeNextRushMode(), null, false, true, s.dictionaryId, true);
  return true;
}
$("#rushNextRound").onclick = () => {
  continueRandomRush();
};
$("#exitParty").onclick = () => {
  if (window.wordrushSessionCode || s.onlineRoundKey || !isPartyRound(s.config))
    return;
  s.config = null;
  $("#exitParty").hidden = true;
  $("#again").textContent = "Play again →";
  show("homeScreen");
};
$("#shareDailyChallenge")?.addEventListener("click", async () => {
  const challenge = s.dailyChallenge;
  if (!challenge || !s.done) return;
  const button = $("#shareDailyChallenge");
  button.disabled = true;
  $("#dailyShareStatus").textContent = "Making your challenge link…";
  try {
    const longestLength = Math.max(0, ...[...s.found].map((word) => word.length));
    const response = await fetch("/api/daily-challenge/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.id,
        score: s.score,
        wordCount: s.found.size,
        longestLength,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !/^[A-Za-z0-9_-]{20,40}$/.test(payload?.ref || ""))
      throw new Error(payload?.error || "Challenge link failed");
    const url = new URL(location.href);
    url.search = "?challenge=" + encodeURIComponent(payload.ref);
    url.hash = "";
    const link = url.toString();
    if (navigator.share) {
      await navigator.share({
        title: "WordRush Daily Rush",
        text: "Beat my " + s.score + " point Daily Rush score.",
        url: link,
      });
      $("#dailyShareStatus").textContent = "Challenge shared.";
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      $("#dailyShareStatus").textContent = "Challenge link copied.";
      return;
    }
    const input = $("#dailyShareLink");
    input.value = link;
    input.hidden = false;
    input.focus();
    input.select();
    $("#dailyShareStatus").textContent = "Copy this challenge link.";
  } catch (error) {
    if (error?.name === "AbortError") {
      $("#dailyShareStatus").textContent = "Sharing cancelled.";
    } else {
      $("#dailyShareStatus").textContent = "Could not create a challenge link.";
    }
  } finally {
    button.disabled = false;
  }
});
$("#raceDailyEcho")?.addEventListener("click", () => startDailyRush(null, true));
$("#shareRelayChallenge")?.addEventListener("click", async () => {
  if (!s.relayChallenge) return;
  const url = new URL(location.href);
  url.search = "?relay=" + encodeURIComponent(s.relayChallenge.id);
  url.hash = "";
  try {
    if (navigator.share) {
      await navigator.share({
        title: "WordRush Word Relay",
        text: "Take the next turn in my Word Relay.",
        url: url.toString(),
      });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      toast("Relay link copied.");
    } else {
      window.prompt("Copy this Word Relay link", url.toString());
    }
  } catch (error) {
    if (error?.name !== "AbortError") toast("Could not share the relay link.");
  }
});
$("#endGame").onclick = () => end("manual");
document
  .querySelectorAll("[data-mode]")
  .forEach((x) => (x.onclick = () => {
    if (x.dataset.mode === "heist" && !window.wordrushSessionCode) {
      toast("Room Heist needs an active multiplayer room.");
      return;
    }
    if (x.dataset.mode !== "classic") return start(x.dataset.mode);
    if (window.wordrushStartSessionGame?.({
      mode: "classic",
      config: null,
      randomRush: false,
    })) return;
    openRushBuilder(true);
  }));
let rushBuilder = { type: "classic", min: 3, size: 4, seconds: 120 };
function syncRushBuilder() {
  for (const [attribute, value] of [
    ["customType", rushBuilder.type],
    ["customMin", rushBuilder.min],
    ["customSize", rushBuilder.size],
    ["customTime", rushBuilder.seconds],
  ])
    document.querySelectorAll(`[data-${attribute.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}]`).forEach((button) => {
      const active = String(button.dataset[attribute]) === String(value);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  const names = {
    classic: "Classic remix",
    minimum: "Big-word stretch",
    sudden: "Sudden showdown",
    race: "Race to 500",
    dirty: "After-dark rush",
  };
  $("#customTitle").textContent = names[rushBuilder.type];
  $("#customSummary").textContent =
    rushBuilder.min + "+ letters · " + rushBuilder.size + "×" + rushBuilder.size +
    " · " + formatTimer(rushBuilder.seconds);
}
function openRushBuilder(reset = false) {
  writeAppRoute("/games/custom");
  if (reset)
    rushBuilder = { type: "classic", min: 3, size: 4, seconds: 120 };
  syncRushBuilder();
  $("#customDialog").showModal();
}
$("#customGame").onclick = () => openRushBuilder();
document.querySelectorAll("[data-custom-type]").forEach((button) => button.onclick = () => {
  rushBuilder.type = button.dataset.customType;
  if (rushBuilder.type === "minimum" && rushBuilder.min < 5) rushBuilder.min = 5;
  syncRushBuilder();
});
document.querySelectorAll("[data-custom-min]").forEach((button) => button.onclick = () => {
  rushBuilder.min = +button.dataset.customMin;
  syncRushBuilder();
});
document.querySelectorAll("[data-custom-size]").forEach((button) => button.onclick = () => {
  rushBuilder.size = +button.dataset.customSize;
  syncRushBuilder();
});
document.querySelectorAll("[data-custom-time]").forEach((button) => button.onclick = () => {
  rushBuilder.seconds = +button.dataset.customTime;
  syncRushBuilder();
});
$("#customForm")?.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "start") return;
  const { type, min, size, seconds } = rushBuilder;
  const labels = {
    classic: "CLASSIC",
    minimum: "WORD STRETCH",
    sudden: "SUDDEN DEATH",
    race: "RACE MODE",
    dirty: "DIRTY MODE \u00b7 18+",
  };
  const rule = type === "race"
    ? "First to 500 points"
    : type === "sudden"
      ? "One invalid word ends the round \u00b7 minimum " + min
      : "Minimum " + min + " letters \u00b7 " + seconds + " seconds";
  start(
    "custom",
    {
      label: labels[type],
      min,
      size,
      seconds,
      rule,
      target: type === "race" ? 500 : null,
      sudden: type === "sudden",
      adult: type === "dirty",
    },
    type === "dirty",
  );
});
async function launchSharedChallengeFromUrl() {
  const params = new URLSearchParams(location.search);
  const refs = params.getAll("challenge");
  if (
    refs.length !== 1 ||
    params.has("join") ||
    !/^[A-Za-z0-9_-]{20,40}$/.test(refs[0])
  )
    return;
  try {
    await startDailyRush(await requestSharedChallenge(refs[0]));
  } catch {
    toast("That challenge link is unavailable.");
  }
}
async function launchSharedRelayFromUrl() {
  const params = new URLSearchParams(location.search);
  const refs = params.getAll("relay");
  if (refs.length !== 1 || params.has("challenge") || params.has("join") ||
      !/^[A-Za-z0-9_-]{20,40}$/.test(refs[0])) return;
  await startWordRelay(refs[0]);
}
function initializeAppRoute() {
  const route = initialAppRoute;
  const current = location.pathname + location.search + location.hash;
  history.replaceState(
    {
      wordrushRoute: route.path,
      ...(route.kind === "game" ? { wordrushInitialGameEntry: true } : {}),
    },
    "",
    current,
  );
  updateRouteMetadata(location.pathname);
  if (route.kind === "game") {
    history.pushState(
      { wordrushRoute: route.path, wordrushGameGuard: true },
      "",
      current,
    );
    launchAppRoute(route);
  } else {
    show(route.screen, { routeMode: "none" });
    if (route.open === "multiplayer")
      window.wordrushOpenMultiplayerRoute = true;
  }
}
initializeAppRoute();
if (initialAppRoute.kind !== "game") {
  launchSharedChallengeFromUrl();
  launchSharedRelayFromUrl();
}
window.addEventListener("popstate", (event) => {
  const route = appRoutes.routeForPath(location.pathname) || appRoutes.HOME;
  updateRouteMetadata(location.pathname);
  if (event.state?.wordrushInitialGameEntry && route.kind === "game") {
    abandonForRouteNavigation();
    writeAppRoute("/", { replace: true });
    show("homeScreen", { routeMode: "none" });
    return;
  }
  navigateAppRoute(route);
});
$("#sessionCard")?.addEventListener("click", () => writeAppRoute("/multiplayer"));
document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-screen]");
  if (target) show(target.dataset.screen);
});

function applyOnlineChainState(chain, clearRejection = false) {
  if (!requiresChain(s.config) || !chain) return;
  const lastAcceptedWord = String(chain.lastAcceptedWord || "").toUpperCase();
  const requiredLetter = String(chain.requiredLetter || "").toUpperCase();
  const chainResetLetter = String(chain.chainResetLetter || "").toUpperCase();
  const acceptedChainChanged =
    lastAcceptedWord !== s.lastAcceptedWord ||
    requiredLetter !== s.requiredLetter ||
    chainResetLetter !== s.chainResetLetter;
  s.lastAcceptedWord = lastAcceptedWord;
  s.requiredLetter = requiredLetter;
  s.chainResetLetter = chainResetLetter;
  if (clearRejection || acceptedChainChanged) {
    s.rejectedAttempt = "";
    s.rejectionReason = "";
  }
  renderChainStatus();
}
window.wordrushUpdateOnlineChain = (chain, clearRejection = true) =>
  applyOnlineChainState(chain, clearRejection);
window.wordrushUpdateOnlineChallenge = ({ heist = null, bounty = null } = {}) => {
  let changed = false;
  if (heist) {
    s.heist = { ...heist, teamByPlayer: { ...(heist.teamByPlayer || {}) }, teamScores: { ...(heist.teamScores || {}) }, claims: [...(heist.claims || [])] };
    changed = true;
  }
  if (bounty) {
    s.bounty = { bountyIndexes: [...(bounty.bountyIndexes || [])], claimedIndexes: [...(bounty.claimedIndexes || [])] };
    changed = true;
  }
  if (changed) render();
};
window.wordrushRecordOnlineWord = (word, points, chain, challengeState) => {
  if (s.pendingOnlineTrace?.word === word) {
    pulseAcceptedWord(s.pendingOnlineTrace.trace);
  }
  s.pendingOnlineTrace = null;
  window.wordrushUpdateOnlineChallenge(challengeState);
  applyOnlineChainState(chain, true);
  s.lastAcceptedWord = word;
  const recorded = multiplayerWordReconciliation.recordLocalAcceptedWord(
    profile.multiplayerWordRounds,
    s.onlineRoundKey,
    word,
  );
  profile.multiplayerWordRounds = recorded.records;
  if (recorded.recorded) {
    recordAcceptedWord(word);
    updateProfile();
  }
  emit("word-accepted", {
    word,
    points: Number(points) || word.length * word.length,
    mode: s.mode,
    multiplayer: true,
    randomRush: s.onlineRandomRush,
  });
};
window.wordrushRecordOnlineIncorrect = (reason, word = "", chain, challengeState) => {
  if (s.pendingOnlineTrace) {
    if (reason === "duplicate") pulseDuplicateWord(s.pendingOnlineTrace.trace);
    else pulseIncorrectWord(s.pendingOnlineTrace.trace);
  }
  s.pendingOnlineTrace = null;
  window.wordrushUpdateOnlineChallenge(challengeState);
  applyOnlineChainState(chain, false);
  s.rejectedAttempt = String(word || "").toUpperCase();
  s.rejectionReason = reason;
  renderChainStatus();
  profile.incorrect++;
  updateProfile();
  emit("word-rejected", {
    mode: s.mode,
    reason,
    word_length: String(word).length,
    multiplayer: true,
    random_rush: s.onlineRandomRush,
  });
};
function onlineRoundAnalytics() {
  return {
    mode: s.mode,
    multiplayer: true,
    random_rush: s.onlineRandomRush,
    party: isPartyRound(s.config),
    grid_size: s.n,
    minimum_length: s.config.min,
  };
}
function updateOnlineTimer() {
  s.time = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
  $("#timer").textContent = formatTimer(s.time);
}
function activateOnlineRound({ navigate = false } = {}) {
  if (!s.onlineRoundKey || s.done) return false;
  if (navigate) show("gameScreen", { preserveRoundIntro: true });
  updateOnlineTimer();
  if (activeOnlineRoundKey === s.onlineRoundKey) return true;
  activeOnlineRoundKey = s.onlineRoundKey;
  clearInterval(s.timer);
  s.timer = setInterval(updateOnlineTimer, 250);
  emit("round-started", {
    ...onlineRoundAnalytics(),
    duration_seconds: s.config.seconds,
  });
  return true;
}
function showOnlineRoundIntro(duration) {
  showRoundIntro({
    label: s.config.label,
    rule: s.config.rule,
    detail: "Everyone is in \u00b7 start when you\u2019re ready",
    duration,
    analytics: onlineRoundAnalytics(),
    onStart: () => activateOnlineRound({ navigate: true }),
  });
}
function resumeOnlineRound() {
  const remainingIntro = Math.max(0, s.onlineIntroEndsAt - Date.now());
  if (activeOnlineRoundKey === s.onlineRoundKey || !remainingIntro) {
    cancelRoundIntro();
    return activateOnlineRound({ navigate: true });
  }
  showOnlineRoundIntro(remainingIntro);
  return true;
}
window.wordrushOnlineRound = (
  round,
  config,
  mode,
  randomRush = false,
  dictionaryMetadata = null,
  chain = null,
  series = null,
  heist = null,
  bounty = null,
) => {
  cancelSoloRushContinuation();
  randomModeQueue = [];
  const roundKey = round.id || round.endsAt + ":" + round.board.join("");
  if (s.onlineRoundKey === roundKey) {
    if (!s.done) applyOnlineChainState(chain);
    return;
  }
  clearSuddenDeathPresentation();
  activeOnlineRoundKey = null;
  s.onlineRoundKey = roundKey;
  s.onlineSeries = series?.id ? series : null;
  s.onlineSeriesId = series?.id || null;
  clearTimeout(seriesTransitionTimer);
  seriesTransitionTimer = 0;
  const seriesFinalPanel = $("#seriesFinalPanel");
  if (seriesFinalPanel) seriesFinalPanel.hidden = true;
  s.onlineIntroEndsAt = round.introEndsAt || Date.now() + 4000;
  s.mode = mode || "classic";
  s.dictionaryId = round.dictionary?.dictionaryId || dictionaryMetadata?.dictionaryId || DEFAULT_DICTIONARY_ID;
  s.dictionaryMetadata = round.dictionary || dictionaryMetadata;
  s.dictionaryWords = [];
  s.onlineRandomRush = Boolean(randomRush);
  s.onlineResultRoundId = null;
  s.onlineNextRound = null;
  s.onlineResultAction = null;
  s.pendingOnlineTrace = null;
  s.relayChallenge = null;
  s.heist = heist ? { ...heist, teamByPlayer: { ...(heist.teamByPlayer || {}) }, teamScores: { ...(heist.teamScores || {}) }, claims: [...(heist.claims || [])] } : null;
  s.bounty = bounty ? { bountyIndexes: [...(bounty.bountyIndexes || [])], claimedIndexes: [...(bounty.claimedIndexes || [])] } : null;
  s.lastAcceptedWord = "";
  s.requiredLetter = "";
  s.chainResetLetter = "";
  s.chainRemainingByInitial = {};
  s.rejectedAttempt = "";
  s.rejectionReason = "";
  s.config = config ? { ...config } : {
    label: mode?.toUpperCase() || "MULTIPLAYER",
    min: 3,
    size: round.size,
    seconds: Math.max(1, Math.ceil((round.endsAt - Date.now()) / 1000)),
    rule: "Multiplayer round",
    target: null,
    sudden: false,
    chain: false,
    adult: false,
    party: false,
  };
  customAdult = usesAdultLexicon(s.config);
  syncGameRoute(s.mode, { randomRush: s.onlineRandomRush, config: s.config });
  document.body.dataset.mode = s.mode;
  s.n = round.size;
  s.b = round.board;
  s.score = 0;
  s.found.clear();
  s.roundWordTimes = [];
  s.done = 0;
  s.startedAt = round.startsAt || Date.now();
  s.endsAt = round.endsAt || Date.now();
  $("#gameMode").textContent = s.config.label;
  $("#gameTitle").textContent = series?.id
    ? "Round " + String(round.seriesRoundNumber || series.currentRoundNumber || 1).padStart(2, "0") +
      " of " + (series.totalRounds || 10) + " · " + round.size + "×" + round.size
    : "Round 01 \u00b7 " + round.size + "\u00d7" + round.size;
  $("#ruleText").textContent = s.config.rule;
  $("#gameHint").textContent = "Minimum " + s.config.min + " letters";
  clearInterval(s.timer);
  render();
  applyOnlineChainState(chain, true);
  if (series?.id && Number(round.seriesRoundNumber) > 1) {
    cancelRoundIntro();
    activateOnlineRound({ navigate: true });
  } else {
    showOnlineRoundIntro(Math.max(0, s.onlineIntroEndsAt - Date.now()));
  }
};
window.wordrushRoundStartNow = (timing = {}) => {
  if (!s.onlineRoundKey || s.done) return;
  s.onlineIntroEndsAt = timing.startsAt || Date.now();
  if (timing.startsAt) s.startedAt = timing.startsAt;
  if (timing.endsAt) {
    s.endsAt = timing.endsAt;
    $("#timer").textContent = formatTimer(
      Math.max(0, Math.ceil((timing.endsAt - Date.now()) / 1000)),
    );
  }
  if (roundIntroFinish) finishRoundIntro();
  else activateOnlineRound();
};
window.wordrushOnlineFinish = (
  ranking,
  result = {},
  { authoritativeSnapshot = false, roomMetadata = null } = {},
) => {
  const delivery = multiplayerResultState.classifyResultDelivery({
    localRoundId: s.onlineRoundKey,
    resultRoundId: result.roundId,
    completed: Boolean(s.done),
    authoritativeSnapshot,
    activeSoloRound:
      s.soloRoundId > 0 &&
      !s.done &&
      !s.onlineRoundKey &&
      !window.wordrushSessionCode,
  });
  if (delivery === "stale")
    return false;
  if (delivery === "refresh") {
    const resultAction = multiplayerResultState.reconcileResultAction({
      sourceRoundId: result.roundId,
      currentRoundId: s.onlineRoundKey,
      nextRound: result.nextRound,
      isCreator: Boolean(window.wordrushSessionCreator),
      configForPreset,
      previousAction: s.onlineResultAction,
    });
    s.onlineNextRound = resultAction.nextRound;
    s.onlineResultAction = resultAction;
    renderOnlineResultAction(resultAction, result.reason === "skipped");
    return true;
  }
  if (s.done && !result.roundId)
    return true;
  if (delivery === "replace") {
    if (authoritativeSnapshot) {
      const metadata = multiplayerResultState.normalizeAuthoritativeRoundMetadata(
        roomMetadata,
      );
      if (metadata) {
        s.mode = metadata.mode;
        s.config = metadata.config;
        s.n = metadata.size;
        document.body.dataset.mode = s.mode;
      }
    }
    s.onlineRoundKey = result.roundId;
    s.onlineResultRoundId = null;
    s.onlineNextRound = null;
    s.onlineResultAction = null;
    s.onlineRandomRush = Boolean(result.randomRush);
    s.startedAt = 0;
  }
  cancelSoloRushContinuation();
  if (!s.onlineRoundKey && result.roundId) s.onlineRoundKey = result.roundId;
  cancelRoundIntro();
  s.done = 1;
  activeOnlineRoundKey = null;
  s.onlineIntroEndsAt = 0;
  const series = result.series?.id ? result.series : null;
  if (series) {
    clearTimeout(seriesTransitionTimer);
    seriesTransitionTimer = 0;
    s.onlineSeries = series;
    s.onlineSeriesId = series.id;
  } else {
    clearSeriesPresentation();
  }
  clearInterval(s.timer);
  const guestId = window.wordrushGuestId;
  const skipped = result.reason === "skipped" || result.recorded === false;
  const normalizedRanking = (ranking || []).map((player) => ({
    ...player,
    score: Number(player.score) || 0,
    words: Array.isArray(player.words)
      ? player.words.map((item) => ({
          word: String(item.word || ""),
          points: Number(item.points) || 0,
        }))
      : [],
    series: player.series
      ? {
          status: player.series.status === "withdrawn" ? "withdrawn" : "active",
          strikes: Number(player.series.strikes) || 0,
          aggregateScore: Number(player.series.aggregateScore) || 0,
          acceptedWordCount: Number(player.series.acceptedWordCount) || 0,
          gameplaySeconds: Number(player.series.gameplaySeconds) || 0,
        }
      : null,
  }));
  const resultPresentation = cooperativeResults.normalizeResultPresentation({
    result,
    ranking: normalizedRanking,
  });
  const presentationRanking = resultPresentation.players;
  const accountingParticipant = multiplayerResultState.resultAccountingParticipant(
    presentationRanking,
    guestId,
    series,
  );
  const mine = series
    ? Number(accountingParticipant?.score) || 0
    : accountingParticipant?.score ?? s.score;
  const ownWords = accountingParticipant?.words || [];
  const wordReconciliation = accountingParticipant
    ? multiplayerWordReconciliation.reconcileAcceptedWords(
        profile.multiplayerWordRounds,
        result.roundId || s.onlineRoundKey,
        ownWords,
      )
    : null;
  if (wordReconciliation) {
    profile.multiplayerWordRounds = wordReconciliation.records;
    recordReconciledOnlineWords(wordReconciliation.missingWords);
  }
  const suddenDeath =
    result.reason === "invalid_word" ? result.suddenDeath : null;
  const resultAction = multiplayerResultState.reconcileResultAction({
    sourceRoundId: result.roundId || s.onlineRoundKey,
    currentRoundId: s.onlineRoundKey,
    nextRound: result.nextRound,
    isCreator: Boolean(window.wordrushSessionCreator),
    configForPreset,
    previousAction: s.onlineResultAction,
  });
  s.onlineResultRoundId = result.roundId || s.onlineRoundKey;
  s.onlineNextRound = resultAction.nextRound;
  s.onlineResultAction = { ...resultAction };
  s.suddenDeathEvent = suddenDeath || null;
  s.suddenDeathRoundKey = suddenDeath ? currentSuddenDeathRoundKey() : null;
  s.dictionaryMetadata = result.dictionary || s.dictionaryMetadata;
  s.dictionaryId = s.dictionaryMetadata?.dictionaryId || s.dictionaryId;
  s.score = mine;
  s.found.clear();
  ownWords.forEach((item) => s.found.add(item.word));
  $("#finalScore").textContent = mine;
  $("#resultWordCount").textContent = ownWords.length;
  $("#resultEyebrow").textContent = skipped
    ? "ROUND SKIPPED"
    : "ROUND COMPLETE!";
  $("#resultScoreLabel").textContent = skipped
    ? "CURRENT SCORES"
    : resultPresentation.cooperative
    ? "TEAM SCORE"
    : "FINAL SCORES";
  renderResults(presentationRanking, {
    skipped,
    onlineNextRound: resultAction.nextRound,
    onlineSourceRoundId: result.roundId || s.onlineRoundKey,
    onlineCreator: Boolean(window.wordrushSessionCreator),
    suddenDeath,
    series,
    cooperative: resultPresentation.cooperative,
    teamScore: resultPresentation.teamScore,
  });
  renderSuddenDeath(suddenDeath);
  if (suddenDeath && multiplayerResultState.shouldReplaySuddenDeath(delivery))
    triggerSuddenDeathExplosion(suddenDeath, s.suddenDeathRoundKey);
  profile.completedMultiplayerRounds = Array.isArray(
    profile.completedMultiplayerRounds,
  ) ? profile.completedMultiplayerRounds : [];
  const accountingResultId = result.resultId || result.accountingId || result.roundId;
  const participantGameplaySeconds = Number(
    accountingParticipant?.series?.gameplaySeconds,
  );
  const authoritativeGameSeconds = series
    ? roundTiming.authoritativeGameplaySeconds(
        Number.isFinite(participantGameplaySeconds) && participantGameplaySeconds >= 0
          ? participantGameplaySeconds
          : result.gameSeconds,
      )
    : roundTiming.authoritativeGameplaySeconds(
        result.gameSeconds,
        s.config?.seconds,
      );
  const shouldRecord = multiplayerResultState.shouldRecordMultiplayerResult({
    ranking: presentationRanking,
    guestId,
    series,
    skipped,
    resultId: accountingResultId,
    completedResultIds: profile.completedMultiplayerRounds,
  });
  if (shouldRecord) {
    const outcome = roundOutcome.classifyMultiplayerParticipant({
      participantId: guestId,
      ranking: normalizedRanking,
      cooperative: Boolean(result.cooperative),
      suddenDeath: result.suddenDeath,
      series,
      seriesComplete: Boolean(result.seriesComplete),
      reason: result.reason,
      recorded: !skipped,
    });
    const deltas = roundOutcome.outcomeAccounting(outcome, { multiplayer: true });
    profile.score += mine;
    profile.rounds++;
    profile.totalGameSeconds += authoritativeGameSeconds;
    profile.gamesWon += deltas.gamesWon;
    profile.gamesLost += deltas.gamesLost;
    profile.multiplayerWins = (profile.multiplayerWins || 0) + deltas.multiplayerWins;
    profile.multiplayerLosses = (profile.multiplayerLosses || 0) + deltas.multiplayerLosses;
    if (deltas.updatesMaxGridWin)
      profile.maxGridWin = Math.max(profile.maxGridWin || 0, s.n);
    if (accountingResultId)
      profile.completedMultiplayerRounds = [
        ...profile.completedMultiplayerRounds,
        accountingResultId,
      ].slice(-50);
    recordPlayDay();
  }
  if (shouldRecord || wordReconciliation?.changed) updateProfile();
  show("resultsScreen");
  renderOnlineResultAction(resultAction, skipped);
  $("#exitParty").hidden = true;
  emit("round-complete", {
    ranking: normalizedRanking,
    multiplayer: true,
    cooperative: Boolean(result.cooperative),
    mode: s.mode,
    randomRush: Boolean(result.randomRush || s.onlineRandomRush),
    result,
    dictionary: s.dictionaryMetadata,
  });
  return true;
};

const themePreference = localStorage.getItem("wordrush-theme");
if (themePreference) document.documentElement.dataset.theme = themePreference;

$("#profileButton")?.addEventListener("click", () => {
  updateIdentity();
  $("#profileDialog").showModal();
});
$("#avatarPicker")?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-avatar]");
  if (!button) return;
  profile.avatar = button.dataset.avatar;
  document
    .querySelectorAll("[data-avatar]")
    .forEach((x) =>
      x.classList.toggle("chosen", x.dataset.avatar === profile.avatar),
    );
  renderAvatar($("#profileButton"), profile.avatar);
});
async function saveProfile(event) {
  event.preventDefault();
  const name = $("#profileName").value.trim();
  $("#profileError")?.replaceChildren();
  if (authState.account) {
    const saveButton = $("#profileSave");
    if (saveButton) saveButton.disabled = true;
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: name, avatar: profile.avatar }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "PROFILE_UPDATE_FAILED");
      applyServerAccount(payload.account, false);
      $("#profileDialog")?.close();
    } catch (error) {
      const errorNode = $("#profileError");
      if (errorNode) errorNode.textContent = friendlyAuthError(error.message);
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
    return;
  }
  if (name) profile.name = name;
  localStorage.setItem("wordrush-profile", JSON.stringify(profile));
  updateIdentity();
  window.wordrushIdentityChanged?.();
  $("#profileDialog")?.close();
}
$("#profileForm")?.addEventListener("submit", saveProfile);
document.querySelectorAll("[data-auth-provider]").forEach((button) => {
  button.addEventListener("click", () => {
    const provider = button.dataset.authProvider;
    const returnTo = location.pathname + location.search + location.hash;
    location.assign("/auth/" + provider + "?returnTo=" + encodeURIComponent(returnTo));
  });
});
$("#profileLogout")?.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  authState.account = null;
  for (const key of [
    "score", "words", "streak", "longest", "rounds", "correct", "incorrect",
    "totalWordLength", "totalGameSeconds", "gamesWon", "gamesLost",
    "multiplayerWins", "multiplayerLosses", "maxGridWin",
  ]) profile[key] = 0;
  profile.speedAchievement = false;
  profile.completedMultiplayerRounds = [];
  profile.multiplayerWordRounds = [];
  profile.days = [];
  profile.name = randomGuestName();
  profile.avatar = "🐈";
  profile.accountId = "";
  profileSyncBase = null;
  profileSyncEvents = [];
  profileSyncInFlight = false;
  updateAuthUI();
  updateIdentity();
  updateProfile({ sync: false });
  $("#profileDialog")?.close();
  toast("Signed out. You can keep playing as a guest.");
});
void loadAuthProfile();
let selectionClearTimer = null;
function clearPick(immediate = false) {
  clearTimeout(selectionClearTimer);
  const clear = () => {
    document
      .querySelectorAll(".selected")
      .forEach((x) => x.classList.remove("selected"));
    s.pick = [];
    $("#preview")?.classList.remove("is-tracing");
    selectionClearTimer = null;
  };
  if (immediate || s.drag) {
    clear();
    return;
  }
  selectionClearTimer = setTimeout(clear, 250);
}

// Pointer input is intentionally conservative: select only the tile actually under the
// pointer, never the nearest tile across a diagonal gap. This keeps edge touches usable
// without making fast diagonal traces select an unintended letter.
function safeCandidateAt(x, y, target = null, starting = false) {
  const grid = $("#grid"),
    direct =
      target?.closest?.(".tile") ||
      document.elementFromPoint(x, y)?.closest?.(".tile");
  if (starting) {
    if (direct && grid.contains(direct)) return direct;
    // Rounded tile corners can make the browser report the board as the
    // target. Keep the full tile rectangle touchable at the start of a trace.
    const gridRect = grid.getBoundingClientRect();
    return (
      [...grid.querySelectorAll(".tile")].find((candidate) => {
        const left = gridRect.left + candidate.offsetLeft;
        const top = gridRect.top + candidate.offsetTop;
        return (
          x >= left &&
          x <= left + candidate.offsetWidth &&
          y >= top &&
          y <= top + candidate.offsetHeight
        );
      }) || null
    );
  }
  const gridRect = grid.getBoundingClientRect(),
    tile = [...grid.querySelectorAll(".tile")].find((candidate) => {
      const left = gridRect.left + candidate.offsetLeft,
        top = gridRect.top + candidate.offsetTop,
        w = candidate.offsetWidth,
        h = candidate.offsetHeight;
      return x >= left && x <= left + w && y >= top && y <= top + h;
    });
  if (!tile) return null;
  const left = gridRect.left + tile.offsetLeft,
    top = gridRect.top + tile.offsetTop,
    w = tile.offsetWidth,
    h = tile.offsetHeight;
  return window.WordRushTraceGeometry.pointInMovementRegion(
    { x, y },
    { left, top, width: w, height: h },
  )
    ? tile
    : null;
}
function traceTileRects() {
  const grid = $("#grid"),
    gridRect = grid.getBoundingClientRect();
  return [...grid.querySelectorAll(".tile")].map((tile) => ({
    index: +tile.dataset.i,
    left: gridRect.left + tile.offsetLeft,
    top: gridRect.top + tile.offsetTop,
    width: tile.offsetWidth,
    height: tile.offsetHeight,
  }));
}
function applyTraceSegment(x, y) {
  const point = { x, y };
  if (s.previousPointer) {
    const nextPick = window.WordRushTraceGeometry.applyTraceSegment(
      s.pick,
      s.previousPointer,
      point,
      traceTileRects(),
      (from, to) => near(from).includes(to),
    );
    nextPick.slice(s.pick.length).forEach((index) => {
      pick(document.querySelector('.tile[data-i="' + index + '"]'));
    });
  }
  s.previousPointer = point;
}
function resetTrace(pointerId = null) {
  if (!s.drag || (pointerId !== null && pointerId !== s.pointerId)) return;
  s.drag = 0;
  s.pointerId = null;
  s.previousPointer = null;
  clearPick(true);
  if (s.traceFrame) {
    cancelAnimationFrame(s.traceFrame);
    s.traceFrame = 0;
  }
  s.trace = [];
  $("#tracePath").removeAttribute("d");
}
const originalClearTrace = clearTrace;
clearTrace = () => {
  if (s.traceFrame) {
    cancelAnimationFrame(s.traceFrame);
    s.traceFrame = 0;
  }
  originalClearTrace();
};
$("#grid").onpointerdown = (e) => {
  if (s.drag) return;
  const tile = safeCandidateAt(e.clientX, e.clientY, e.target, true);
  if (!tile) return;
  s.drag = 1;
  s.pointerId = e.pointerId;
  clearPick(true);
  clearTrace();
  pick(tile);
  tracePoint(e.clientX, e.clientY);
  s.previousPointer = { x: e.clientX, y: e.clientY };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
};
$("#grid").onpointermove = (e) => {
  if (!s.drag || e.pointerId !== s.pointerId) return;
  tracePoint(e.clientX, e.clientY);
  applyTraceSegment(e.clientX, e.clientY);
};
$("#grid").onpointerup = (e) => {
  if (!s.drag || e.pointerId !== s.pointerId) return;
  tracePoint(e.clientX, e.clientY);
  applyTraceSegment(e.clientX, e.clientY);
  s.drag = 0;
  s.pointerId = null;
  s.previousPointer = null;
  try {
    e.currentTarget.releasePointerCapture(e.pointerId);
  } catch {}
  submit();
  setTimeout(clearTrace, 250);
};
$("#grid").onpointercancel = (e) => resetTrace(e.pointerId);
$("#grid").onlostpointercapture = (e) => resetTrace(e.pointerId);
