const $ = (s) => document.querySelector(s),
  sharedConfig = window.WordrushConfig,
  MODE = Object.fromEntries(
    Object.entries(sharedConfig.MODE_CONFIG)
      .filter(([mode]) => mode !== "coop")
      .map(([mode, config]) => [
        mode,
        [config.label, config.min, config.size, config.seconds, config.rule],
      ]),
  );
let customAdult = false;
function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent("wordrush:" + name, { detail }));
}
const RANDOM_MODES = ["classic", "minimum", "sudden", "race"];
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
const common = sharedConfig.COMMON_WORDS,
  adult = sharedConfig.ADULT_WORDS,
  bag = sharedConfig.LETTER_BAG;
let custom = new Set();
try {
  custom = new Set(
    JSON.parse(localStorage.getItem("wordrush-custom") || "[]").filter((w) =>
      /^[A-Z]{3,}$/.test(w),
    ),
  );
} catch {}
const wordCheckCache = new Map();
async function isServerDictionaryWord(word, adultMode) {
  const key = (adultMode ? "dirty:" : "classic:") + word;
  if (wordCheckCache.has(key)) return wordCheckCache.get(key);
  const check = fetch(
    "/api/word-check?word=" +
      encodeURIComponent(word) +
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
      return lex().has(word);
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
  trace: [],
  traceFrame: 0,
  startedAt: 0,
  endsAt: 0,
  rush: false,
  rushTimer: 0,
  rushCountdown: 0,
  roundWordTimes: [],
  onlineRoundKey: null,
  pendingOnlineTrace: null,
  party: false,
};
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
        speedAchievement: false,
        maxGridWin: 0,
        days: [],
      },
      JSON.parse(localStorage.getItem("wordrush-profile") || "{}"),
    );
  } catch {
    return {
      name: "",
      avatar: "🐈",
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
      speedAchievement: false,
      maxGridWin: 0,
      days: [],
    };
  }
})();
if (!profile.name || profile.name === "Jordan")
  profile.name = randomGuestName();
if (!avatarOptions.includes(profile.avatar)) profile.avatar = "🐈";
function updateIdentity() {
  if ($("#profileButton")) $("#profileButton").textContent = profile.avatar;
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
function updateProfile() {
  const dates = [...new Set(profile.days)].sort().reverse();
  profile.streak = dates.length ? 1 : 0;
  for (let i = 1; i < dates.length; i++) {
    const gap = (new Date(dates[i - 1]) - new Date(dates[i])) / 86400000;
    if (gap !== 1) break;
    profile.streak++;
  }
  localStorage.setItem("wordrush-profile", JSON.stringify(profile));
  if ($("#homeScore"))
    $("#homeScore").textContent = profile.score.toLocaleString();
  if ($("#homeWords")) $("#homeWords").textContent = profile.words;
  if ($("#homeStreak")) $("#homeStreak").textContent = profile.streak;
  window.wordrushAchievementEvent?.(profile);
  window.wordrushStatsEvent?.();
}
function recordPlayDay() {
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  if (!profile.days.includes(today)) profile.days.push(today);
}
function recordAcceptedWord(word) {
  const elapsed = Date.now() - s.startedAt;
  s.roundWordTimes.push(elapsed);
  if (s.roundWordTimes.filter((time) => elapsed - time <= 60000).length >= 20)
    profile.speedAchievement = true;
  profile.words++;
  profile.correct++;
  profile.totalWordLength += word.length;
  profile.longest = Math.max(profile.longest, word.length);
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
  const key = s.mode + ":" + customAdult + ":" + custom.size;
  if (lexiconCache && lexiconCacheKey === key) return lexiconCache;
  lexiconCacheKey = key;
  lexiconCache = new Set([
    ...common,
    ...custom,
    ...(s.mode === "dirty" || customAdult ? adult : []),
  ]);
  return lexiconCache;
}
function near(i) {
  let r = Math.floor(i / s.n),
    c = i % s.n,
    a = [];
  for (let y = -1; y < 2; y++)
    for (let x = -1; x < 2; x++) {
      let R = r + y,
        C = c + x;
      if ((y || x) && R >= 0 && C >= 0 && R < s.n && C < s.n)
        a.push(R * s.n + C);
    }
  return a;
}
function place(w, c) {
  for (let start = 0; start < s.n * s.n; start++) {
    let p = [start],
      u = new Set(p);
    function go() {
      if (p.length === w.length) return 1;
      for (let i of near(p.at(-1)).filter(
        (i) => !u.has(i) && (c[i] === "" || c[i] === w[p.length]),
      )) {
        p.push(i);
        u.add(i);
        if (go()) return 1;
        p.pop();
        u.delete(i);
      }
      return 0;
    }
    if (go()) return p;
  }
  return null;
}
function path(w) {
  function d(i, k, u) {
    if (k === w.length) return 1;
    for (let n of near(i))
      if (!u.has(n) && s.b[n] === w[k]) {
        u.add(n);
        if (d(n, k + 1, u)) return 1;
        u.delete(n);
      }
    return 0;
  }
  return s.b.some((x, i) => x === w[0] && d(i, 1, new Set([i])));
}
function render() {
  let g = $("#grid");
  g.style.gridTemplateColumns = "repeat(" + s.n + ",1fr)";
  g.innerHTML = s.b
    .map((l, i) => '<button class="tile" data-i="' + i + '">' + l + "</button>")
    .join("");
}
function renderResults(ranking) {
  const rows = ranking?.length
    ? ranking
    : [{
        name: profile.name,
        avatar: profile.avatar,
        score: s.score,
        words: [...s.found].map((word) => ({ word, points: word.length ** 2 })),
      }];
  $("#resultName").textContent = profile.name + ".";
  const target = $("#resultPlayers");
  target.replaceChildren();
  rows.forEach((player, index) => {
    const row = document.createElement("article");
    row.className = "result-player-card rank-" + Math.min(index + 1, 4);
    const rank = document.createElement("span");
    rank.className = "result-rank";
    rank.textContent = ["👑", "🥈", "🥉"][index] || String(index + 1);
    const identity = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = (player.avatar || "🐈") + " " + player.name;
    const wordCount = document.createElement("small");
    wordCount.textContent = (player.words?.length || 0) + " words";
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
    score.textContent = Number(player.score || 0).toLocaleString();
    row.append(rank, identity, score);
    target.append(row);
  });
}
function end() {
  if (
    window.wordrushSocket?.readyState === 1 &&
    window.wordrushSessionCode &&
    !s.done
  ) {
    window.wordrushSocket.send(JSON.stringify({ type: "end_round" }));
    return;
  }
  if (s.done) return;
  s.done = 1;
  clearInterval(s.timer);
  $("#finalScore").textContent = s.score;
  $("#resultWordCount").textContent = s.found.size;
  renderResults();
  $("#resultAchievement").hidden = !s.found.size;
  $("#resultAchievementTitle").textContent = s.found.size
    ? "Round complete"
    : "Keep tracing";
  $("#resultAchievementDetail").textContent = s.found.size
    ? s.found.size + " word" + (s.found.size === 1 ? "" : "s") + " found."
    : "Find words to unlock achievements.";
  profile.score += s.score;
  profile.rounds++;
  profile.totalGameSeconds += (Date.now() - s.startedAt) / 1000;
  profile.gamesWon += s.score > 0 ? 1 : 0;
  profile.gamesLost += s.score > 0 ? 0 : 1;
  if (s.score > 0) profile.maxGridWin = Math.max(profile.maxGridWin || 0, s.n);
  recordPlayDay();
  updateProfile();
  $("#again").textContent = s.party ? "Continue party mode →" : "Play again →";
  $("#exitParty").hidden = !s.party;
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
  });
  if (s.rush) {
    const rushDelay = window.wordrushRushDelay || 20000;
    $("#stopRushResults").hidden = false;
    let left = Math.ceil(rushDelay / 1000);
    $("#resultAchievementTitle").textContent = "Next rush in " + left + "s";
    $("#resultAchievementDetail").textContent =
      "Your score is saved. The next random game will start automatically.";
    s.rushCountdown = setInterval(() => {
      left--;
      if (left > 0)
        $("#resultAchievementTitle").textContent = "Next rush in " + left + "s";
    }, 1000);
    s.rushTimer = setTimeout(() => {
      clearInterval(s.rushCountdown);
      if (s.rush) start(nextRandomMode(), null, false, true);
    }, rushDelay);
  }
}
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("show");
  clearTimeout(toast.id);
  toast.id = setTimeout(() => t.classList.remove("show"), 1800);
}
function show(id) {
  document
    .querySelectorAll(".screen")
    .forEach((x) => x.classList.toggle("active", x.id === id));
  document
    .querySelectorAll("nav [data-screen]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.screen === id),
    );
  emit("screen-change", { id });
}
function stopRush() {
  s.rush = false;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  $("#stopRush").hidden = true;
  $("#stopRushResults").hidden = true;
  show("homeScreen");
}
async function start(mode, override = null, adultMode = false, rush = false) {
  if (
    (mode === "dirty" || adultMode) &&
    !confirm("Dirty Mode contains adult language. Continue?")
  )
    return;
  if (
    window.wordrushStartSessionGame?.({
      mode,
      config: override
        ? {
            label: override[0],
            min: override[1],
            size: override[2],
            seconds: override[3],
            rule: override[4],
            target: override[5]?.target || null,
            adult: adultMode,
            sudden: Boolean(override[5]?.sudden),
          }
        : null,
      randomRush: rush,
    })
  )
    return;
  let m = override || MODE[mode];
  if (rush && !s.rush) randomModeQueue = [];
  customAdult = adultMode || mode === "dirty";
  s.customConfig = override;
  s.rush = rush;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  s.target = override?.[5]?.target || null;
  s.mode = mode;
  s.party = Boolean(override?.[0] === "PARTY MODE");
  s.onlineRoundKey = null;
  s.pendingOnlineTrace = null;
  document.body.dataset.mode = mode;
  s.n = m[2];
  s.time = m[3];
  s.score = 0;
  s.found.clear();
  s.roundWordTimes = [];
  s.pick = [];
  s.done = 0;
  s.startedAt = Date.now();
  s.endsAt = s.startedAt + s.time * 1000;
  s.b = make();
  $("#gameMode").textContent = m[0];
  $("#gameTitle").textContent = "Round 01 · " + s.n + "×" + s.n;
  $("#ruleBanner").textContent = m[4];
  $("#gameHint").textContent = "Minimum " + m[1] + " letters";
  $("#gameScore").textContent = 0;
  $("#timer").textContent = formatTimer(s.time);
  $("#stopRush").hidden = !s.rush;
  $("#endGame").hidden = false;
  $("#stopRushResults").hidden = true;
  render();
  show("gameScreen");
  emit("round-started");
  clearInterval(s.timer);
  s.timer = setInterval(() => {
    s.time = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
    $("#timer").textContent = formatTimer(s.time);
    if (s.time <= 0) end();
  }, 250);
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
async function submit() {
  let trace = s.pick.slice(),
    w = s.pick.map((i) => s.b[i]).join("");
  if (window.wordrushSocket && window.wordrushSocket.readyState === 1) {
    s.pendingOnlineTrace = { word: w, trace };
    window.wordrushSocket.send(
      JSON.stringify({ type: "submit_word", word: w, path: trace }),
    );
    clearPick();
    return;
  }
  let m = s.customConfig || MODE[s.mode],
    validPath = pickedPathIsValid(trace, w),
    duplicate = s.found.has(w),
    roundStartedAt = s.startedAt;
  clearPick();
  const inDictionary =
    w.length >= m[1] && validPath && !duplicate
      ? custom.has(w) || await isServerDictionaryWord(w, customAdult)
      : false;
  if (s.done || s.startedAt !== roundStartedAt) return;
  const ok = w.length >= m[1] && validPath && inDictionary;
  if (ok && !s.found.has(w)) {
    const points = w.length * w.length;
    s.found.add(w);
    s.score += points;
    recordAcceptedWord(w);
    updateProfile();
    $("#gameScore").textContent = s.score;
    $("#preview").textContent = w + " +" + points;
    $("#preview").classList.add("found");
    pulseAcceptedWord(trace);
    emit("word-accepted", { word: w, points });
    if ((s.mode === "race" || s.target) && s.score >= 500) end();
  } else if (duplicate || s.found.has(w)) {
    pulseIncorrectWord(trace);
    profile.incorrect++;
    updateProfile();
    toast("Already found");
  } else {
    pulseIncorrectWord(trace);
    profile.incorrect++;
    updateProfile();
    toast(
      w.length < m[1]
        ? "Need " + m[1] + " letters"
        : !validPath
          ? "Tiles must connect"
          : "Not in dictionary",
    );
    if (s.mode === "sudden") setTimeout(end, 300);
  }
  setTimeout(() => {
    $("#preview").classList.remove("found");
    $("#preview").textContent = "Trace a word";
  }, 900);
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
  s.trace = [];
  $("#tracePath").removeAttribute("d");
}
function pick(t) {
  if (!t || s.pick.includes(+t.dataset.i)) return;
  s.pick.push(+t.dataset.i);
  t.classList.add("selected");
  $("#preview").textContent = s.pick.map((i) => s.b[i]).join("");
}
function pulseWord(trace, className) {
  const tiles = trace
    .map((index) => document.querySelector('.tile[data-i="' + index + '"]'))
    .filter(Boolean);
  tiles.forEach((tile) => {
    tile.classList.remove("word-correct", "word-incorrect");
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
$("#quickPlay")?.addEventListener("click", () => start("classic"));
$("#navStats").onclick = () => show("statsScreen");
$("#stopRush").onclick = stopRush;
$("#stopRushResults").onclick = stopRush;
let partyConfig = { size: 4, min: 3, seconds: 120 };
function syncPartyOptions() {
  document.querySelectorAll("[data-party-size]").forEach((button) => button.classList.toggle("active", +button.dataset.partySize === partyConfig.size));
  document.querySelectorAll("[data-party-min]").forEach((button) => button.classList.toggle("active", +button.dataset.partyMin === partyConfig.min));
  document.querySelectorAll("[data-party-time]").forEach((button) => button.classList.toggle("active", +button.dataset.partyTime === partyConfig.seconds));
}
function openParty() { syncPartyOptions(); $("#partyDialog").showModal(); }
$("#partyMode").onclick = openParty;
document.querySelectorAll("[data-party-size]").forEach((button) => button.onclick = () => { partyConfig.size = +button.dataset.partySize; syncPartyOptions(); });
document.querySelectorAll("[data-party-min]").forEach((button) => button.onclick = () => { partyConfig.min = +button.dataset.partyMin; syncPartyOptions(); });
document.querySelectorAll("[data-party-time]").forEach((button) => button.onclick = () => { partyConfig.seconds = +button.dataset.partyTime; syncPartyOptions(); });
$("#partyForm").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "start") return;
  const config = ["PARTY MODE", partyConfig.min, partyConfig.size, partyConfig.seconds, `Party round · minimum ${partyConfig.min} letters`, { party: true }];
  start("custom", config);
});
$("#again").onclick = () => s.party ? openParty() : start(s.mode, s.customConfig, customAdult);
$("#exitParty").onclick = () => { s.party = false; $("#exitParty").hidden = true; $("#again").textContent = "Play again →"; show("homeScreen"); };
$("#endGame").onclick = end;
document
  .querySelectorAll("[data-mode]")
  .forEach((x) => (x.onclick = () => {
    if (x.dataset.mode !== "classic") return start(x.dataset.mode);
    if (window.wordrushStartSessionGame?.({
      mode: "classic",
      config: null,
      randomRush: false,
    })) return;
    openRushBuilder(true);
  }));
$("#dictionary").onclick = () => {
  let w = prompt("Add a word to your personal dictionary")
    ?.trim()
    .toUpperCase();
  if (w && /^[A-Z]{3,}$/.test(w)) {
    custom.add(w);
    localStorage.setItem("wordrush-custom", JSON.stringify([...custom]));
    toast(w + " added");
  } else if (w) toast("Letters only, 3+ characters");
};
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
    dirty: "DIRTY MODE · 18+",
  };
  const rule = type === "race"
    ? "First to 500 points"
    : type === "sudden"
      ? "One invalid word ends the round · minimum " + min
      : "Minimum " + min + " letters · " + seconds + " seconds";
  start(
    "custom",
    [
      labels[type],
      min,
      size,
      seconds,
      rule,
      {
        target: type === "race" ? 500 : null,
        sudden: type === "sudden",
      },
    ],
    type === "dirty",
  );
});
show("homeScreen");
document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-screen]");
  if (target) show(target.dataset.screen);
});

window.wordrushRecordOnlineWord = (word, points) => {
  if (s.pendingOnlineTrace?.word === word) {
    pulseAcceptedWord(s.pendingOnlineTrace.trace);
  }
  s.pendingOnlineTrace = null;
  recordAcceptedWord(word);
  updateProfile();
  emit("word-accepted", {
    word,
    points: Number(points) || word.length * word.length,
  });
};
window.wordrushRecordOnlineIncorrect = () => {
  if (s.pendingOnlineTrace) pulseIncorrectWord(s.pendingOnlineTrace.trace);
  s.pendingOnlineTrace = null;
  profile.incorrect++;
  updateProfile();
};
window.wordrushOnlineRound = (round, config, mode) => {
  const roundKey = round.endsAt + ":" + round.board.join("");
  if (s.onlineRoundKey === roundKey && !s.done) return;
  s.onlineRoundKey = roundKey;
  const match = Object.entries(MODE).find(
    ([, value]) => value[0] === config?.label,
  );
  s.mode = mode || match?.[0] || "classic";
  s.party = config?.label === "PARTY MODE";
  s.pendingOnlineTrace = null;
  customAdult = Boolean(config?.adult);
  s.customConfig = [
    config?.label || "MULTIPLAYER",
    config?.min || 3,
    round.size,
    config?.seconds ||
      Math.max(1, Math.ceil((round.endsAt - Date.now()) / 1000)),
    config?.rule || "Multiplayer round",
    {
      target: config?.target || null,
      sudden: Boolean(config?.sudden),
    },
  ];
  document.body.dataset.mode = s.mode;
  s.n = round.size;
  s.b = round.board;
  s.score = 0;
  s.found.clear();
  s.roundWordTimes = [];
  s.done = 0;
  s.startedAt = Date.now();
  $("#gameMode").textContent = config?.label || "MULTIPLAYER";
  $("#gameTitle").textContent = "Round 01 · " + round.size + "×" + round.size;
  $("#ruleBanner").textContent = config?.rule || "";
  $("#gameHint").textContent = "Minimum " + (config?.min || 3) + " letters";
  const updateOnlineTimer = () => {
    s.time = Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000));
    $("#timer").textContent = formatTimer(s.time);
  };
  clearInterval(s.timer);
  updateOnlineTimer();
  s.timer = setInterval(updateOnlineTimer, 250);
  render();
  show("gameScreen");
  emit("round-started");
};
window.wordrushOnlineFinish = (ranking, result = {}) => {
  if (s.done) return;
  s.done = 1;
  clearInterval(s.timer);
  const guestId = window.wordrushGuestId;
  const normalizedRanking = (ranking || []).map((player) => ({
    ...player,
    score: Number(player.score) || 0,
    words: Array.isArray(player.words)
      ? player.words.map((item) => ({
          word: String(item.word || ""),
          points: Number(item.points) || 0,
        }))
      : [],
  }));
  const ownPlayer = normalizedRanking.find((player) => player.id === guestId);
  const mine = ownPlayer?.score ?? s.score;
  const ownWords = ownPlayer?.words || [];
  s.score = mine;
  s.found.clear();
  ownWords.forEach((item) => s.found.add(item.word));
  $("#finalScore").textContent = mine;
  $("#resultWordCount").textContent = ownWords.length;
  renderResults(normalizedRanking);
  $("#resultAchievement").hidden = false;
  $("#resultAchievementTitle").textContent = result.cooperative
    ? "Co-op complete"
    : "Multiplayer round";
  $("#resultAchievementDetail").textContent = result.cooperative
    ? "Team score: " +
      (result.teamScore || 0) +
      " · " +
      (result.stats?.wordsFound || 0) +
      " shared words."
    : (normalizedRanking[0]?.name || "Winner") +
      " wins · " +
      ownWords.length +
      " word" +
      (ownWords.length === 1 ? "" : "s") +
      " found by you.";
  profile.score += mine;
  profile.rounds++;
  profile.totalGameSeconds += (Date.now() - s.startedAt) / 1000;
  const won = result.cooperative || normalizedRanking[0]?.id === guestId;
  profile.gamesWon += won ? 1 : 0;
  profile.gamesLost += won ? 0 : 1;
  profile.multiplayerWins = (profile.multiplayerWins || 0) + (won ? 1 : 0);
  profile.multiplayerLosses = (profile.multiplayerLosses || 0) + (won ? 0 : 1);
  if (won) profile.maxGridWin = Math.max(profile.maxGridWin || 0, s.n);
  recordPlayDay();
  updateProfile();
  show("resultsScreen");
  $("#again").textContent = s.party ? "Continue party mode →" : "Play again →";
  $("#exitParty").hidden = !s.party;
  emit("round-complete", {
    ranking: normalizedRanking,
    multiplayer: true,
    cooperative: Boolean(result.cooperative),
    result,
  });
};

const themePreference = localStorage.getItem("wordrush-theme");
if (themePreference) document.documentElement.dataset.theme = themePreference;
$("#themeToggle")?.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("wordrush-theme", next);
});

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
  if ($("#profileButton")) $("#profileButton").textContent = profile.avatar;
});
const saveProfile = () => {
  const name = $("#profileName").value.trim();
  if (name) profile.name = name;
  localStorage.setItem("wordrush-profile", JSON.stringify(profile));
  updateIdentity();
  window.wordrushIdentityChanged?.();
};
$("#profileForm")?.addEventListener("submit", saveProfile);
function make() {
  let all = [...lex()],
    dirty = s.mode === "dirty" || customAdult;
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = Array(s.n * s.n).fill(""),
      preferred = dirty
        ? [...adult].sort(() => Math.random() - 0.5).slice(0, 7)
        : [],
      targets = preferred.concat(
        [3, 4, 5, 6]
          .map((length, bucket) => {
            const matches = (word) =>
              bucket === 3 ? word.length >= length : word.length === length;
            const preferredCandidates = preferred.filter(matches);
            const candidates = preferredCandidates.length
              ? preferredCandidates
              : all.filter(matches);
            return candidates[Math.floor(Math.random() * candidates.length)];
          })
          .filter(Boolean),
      );
    targets
      .sort((a, b) => b.length - a.length)
      .forEach((word) => {
        let p = place(word, c);
        if (p) p.forEach((i, j) => (c[i] = word[j]));
      });
    let board = c.map((x) => x || bag[Math.floor(Math.random() * bag.length)]);
    if (!dirty) return board;
    let old = s.b;
    s.b = board;
    let dirtyCount = adult.filter((word) => path(word)).length;
    s.b = old;
    if (dirtyCount >= 5) return board;
  }
  if (dirty && s.n >= 4) {
    // This 4×4 seed contains playable paths for BITCH, COCK, DICK, SHIT and
    // TIT. Embed it in larger custom boards so dirty mode can never silently
    // fall back to a board without adult words.
    const seed = "NOLKCDCSITHIBITD";
    const board = Array.from(
      { length: s.n * s.n },
      () => bag[Math.floor(Math.random() * bag.length)],
    );
    const offsetRow = Math.floor(Math.random() * (s.n - 3));
    const offsetColumn = Math.floor(Math.random() * (s.n - 3));
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++)
        board[(row + offsetRow) * s.n + column + offsetColumn] =
          seed[row * 4 + column];
    return board;
  }
  return Array.from(
    { length: s.n * s.n },
    () => bag[Math.floor(Math.random() * bag.length)],
  );
}
let selectionClearTimer = null;
function clearPick(immediate = false) {
  clearTimeout(selectionClearTimer);
  const clear = () => {
    document
      .querySelectorAll(".selected")
      .forEach((x) => x.classList.remove("selected"));
    s.pick = [];
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
    h = tile.offsetHeight,
    radius = Math.min(w, h) * 0.34;
  return Math.hypot(x - (left + w / 2), y - (top + h / 2)) <= radius
    ? tile
    : null;
}
function resetTrace(pointerId = null) {
  if (!s.drag || (pointerId !== null && pointerId !== s.pointerId)) return;
  s.drag = 0;
  s.pointerId = null;
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
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
};
$("#grid").onpointermove = (e) => {
  if (!s.drag || e.pointerId !== s.pointerId) return;
  tracePoint(e.clientX, e.clientY);
  const tile = safeCandidateAt(e.clientX, e.clientY);
  if (!tile) return;
  const index = +tile.dataset.i;
  if (s.pick.length && !near(index).includes(s.pick.at(-1))) return;
  pick(tile);
};
$("#grid").onpointerup = (e) => {
  if (!s.drag || e.pointerId !== s.pointerId) return;
  s.drag = 0;
  s.pointerId = null;
  try {
    e.currentTarget.releasePointerCapture(e.pointerId);
  } catch {}
  submit();
  setTimeout(clearTrace, 250);
};
$("#grid").onpointercancel = (e) => resetTrace(e.pointerId);
$("#grid").onlostpointercapture = (e) => resetTrace(e.pointerId);
