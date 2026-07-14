const $ = (s) => document.querySelector(s),
  MODE = {
    classic: ["CLASSIC", 3, 4, 120, "Free play · 2 minutes"],
    minimum: ["MINIMUM WORD", 5, 6, 180, "Minimum 5 letters"],
    sudden: ["SUDDEN DEATH", 3, 5, 180, "One invalid word ends the round"],
    race: ["RACE MODE", 3, 4, 240, "First to 500 points wins"],
    dirty: ["DIRTY MODE · 18+", 3, 5, 180, "Opt-in adult dictionary"],
  };
let customConfig = null,
  customAdult = false;
const RANDOM_MODES = ["classic", "minimum", "sudden", "race"];
function nextRandomMode() {
  const choices = RANDOM_MODES.filter((mode) => mode !== s.mode);
  return choices[Math.floor(Math.random() * choices.length)] || RANDOM_MODES[0];
}
const common =
    "STAR START STARE STONE LINE LINES LION PLACE SPACE MOUSE MUSES STREAM WORDS RUSH BRAIN TRACE FIRE FINE SCORE RAIN TRAIN STAIR TONE NOTE RATE PLANE PLANT HEART HOUSE".split(
      " ",
    ),
  adult = "ASS BITCH COCK DAMN DICK HELL PISS SHIT SLUT TIT".split(" "),
  bag =
    "EEEEEEEEEEEEAAAAAAAARRRRRRIIIIIIIIOOOOOOOONNNNNNTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPHHFFVVWWYYKJXQZ";
let custom = new Set();
try {
  custom = new Set(
    JSON.parse(localStorage.getItem("wordrush-custom") || "[]").filter((w) =>
      /^[A-Z]{3,}$/.test(w),
    ),
  );
} catch {}
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
  rush: false,
  rushTimer: 0,
  rushCountdown: 0,
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
  const today = new Date().toISOString().slice(0, 10);
  if (!profile.days.includes(today)) profile.days.push(today);
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
  const unlocked = {
    long: profile.longest >= 10,
    first: profile.words > 0,
    speed: profile.rounds > 0 && profile.words >= 20,
    grid: profile.rounds > 0 && profile.maxGrid >= 8,
  };
  const count = Object.values(unlocked).filter(Boolean).length;
  if ($("#achievementCount"))
    $("#achievementCount").textContent = count + " / 4";
  if ($("#achievementBar"))
    $("#achievementBar").style.background =
      "linear-gradient(90deg,var(--coral) " +
      (count / 4) * 100 +
      "%,#e1dfd8 " +
      (count / 4) * 100 +
      "%)";
  document.querySelectorAll("[data-achievement]").forEach((card) => {
    const done = unlocked[card.dataset.achievement];
    card.classList.toggle("unlocked", done);
    const status = card.querySelector("em");
    if (status) status.textContent = done ? "UNLOCKED" : "LOCKED";
  });
  window.wordrushAchievementEvent?.();
  window.wordrushStatsEvent?.();
}
updateIdentity();
updateProfile();
function lex() {
  return new Set([
    ...common,
    ...custom,
    ...(s.mode === "dirty" || customAdult ? adult : []),
  ]);
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
function make() {
  let c = Array(s.n * s.n).fill(""),
    all = [...lex()],
    targets = [3, 4, 5, 6]
      .map((l, i) => {
        let a = all.filter((w) => (i === 3 ? w.length >= 6 : w.length === l));
        return a[Math.floor(Math.random() * a.length)];
      })
      .filter(Boolean);
  targets
    .sort((a, b) => b.length - a.length)
    .forEach((w) => {
      let p = place(w, c);
      if (p) p.forEach((i, j) => (c[i] = w[j]));
    });
  return c.map((x) => x || bag[Math.floor(Math.random() * bag.length)]);
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
    : [{ name: profile.name, avatar: profile.avatar, score: s.score }];
  $("#resultName").textContent = profile.name + ".";
  $("#resultPlayers").innerHTML =
    "<p>PLAYER <b>SCORE</b></p>" +
    rows
      .map(
        (player) =>
          "<p>" +
          ((player.avatar || "🐈") + " " + player.name) +
          " <b>" +
          player.score +
          "</b></p>",
      )
      .join("");
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
  $("#bonus").textContent = s.score ? 50 : 0;
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
  profile.maxGrid = Math.max(profile.maxGrid || 0, s.n);
  updateProfile();
  show("resultsScreen");
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
}
function stopRush() {
  s.rush = false;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  $("#stopRush").hidden = true;
  $("#stopRushResults").hidden = true;
  show("homeScreen");
}
function start(mode, override = null, adultMode = false, rush = false) {
  if (
    mode === "dirty" &&
    !confirm("Dirty Mode contains adult language. Continue?")
  )
    return;
  let m = override || MODE[mode];
  customConfig = override;
  customAdult = adultMode || mode === "dirty";
  s.customConfig = override;
  s.rush = rush;
  clearTimeout(s.rushTimer);
  clearInterval(s.rushCountdown);
  s.target = override?.[5]?.target || null;
  s.mode = mode;
  document.body.dataset.mode = mode;
  s.n = m[2];
  s.time = m[3];
  s.score = 0;
  s.found.clear();
  s.pick = [];
  s.done = 0;
  s.startedAt = Date.now();
  s.b = make();
  $("#gameMode").textContent = m[0];
  $("#gameTitle").textContent = "Round 01 · " + s.n + "×" + s.n;
  $("#ruleBanner").textContent = m[4];
  $("#gameHint").textContent = "Minimum " + m[1] + " letters";
  $("#gameScore").textContent = 0;
  $("#stopRush").hidden = !s.rush;
  $("#stopRushResults").hidden = true;
  render();
  show("gameScreen");
  clearInterval(s.timer);
  s.timer = setInterval(() => {
    s.time--;
    $("#timer").textContent =
      String(Math.floor(s.time / 60)).padStart(2, "0") +
      ":" +
      String(s.time % 60).padStart(2, "0");
    if (s.time <= 0) end();
  }, 1000);
}
function clearPick() {
  document
    .querySelectorAll(".selected")
    .forEach((x) => x.classList.remove("selected"));
  s.pick = [];
}
function submit() {
  let trace = s.pick.slice(),
    w = s.pick.map((i) => s.b[i]).join("");
  if (window.wordrushSocket && window.wordrushSocket.readyState === 1) {
    window.wordrushSocket.send(
      JSON.stringify({ type: "submit_word", word: w, path: trace }),
    );
    clearPick();
    return;
  }
  let m = s.customConfig || MODE[s.mode],
    ok = w.length >= m[1] && lex().has(w) && path(w);
  if (ok && !s.found.has(w)) {
    s.found.add(w);
    s.score += w.length * w.length;
    profile.words++;
    profile.correct++;
    profile.totalWordLength += w.length;
    profile.longest = Math.max(profile.longest, w.length);
    updateProfile();
    $("#gameScore").textContent = s.score;
    $("#preview").textContent = w + " +" + w.length * w.length;
    $("#preview").classList.add("found");
    if ((s.mode === "race" || s.target) && s.score >= 500) end();
  } else if (s.found.has(w)) {
    profile.incorrect++;
    updateProfile();
    toast("Already found");
  } else {
    profile.incorrect++;
    updateProfile();
    toast(
      w.length < m[1]
        ? "Need " + m[1] + " letters"
        : !path(w)
          ? "Tiles must connect"
          : "Not in dictionary",
    );
    if (s.mode === "sudden") setTimeout(end, 300);
  }
  clearPick();
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
function tileCenter(tile) {
  const r = tile.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function candidateAt(x, y) {
  const tiles = [...document.querySelectorAll(".tile")];
  let best = null,
    distance = Infinity;
  for (const tile of tiles) {
    const center = tileCenter(tile),
      d = Math.hypot(x - center.x, y - center.y);
    if (d < distance) {
      distance = d;
      best = { tile, center, d };
    }
  }
  const radius = (best?.tile.getBoundingClientRect().width || 0) * 0.38;
  return best && best.d <= radius ? best : null;
}
function pick(t) {
  if (!t || s.pick.includes(+t.dataset.i)) return;
  s.pick.push(+t.dataset.i);
  t.classList.add("selected");
  $("#preview").textContent = s.pick.map((i) => s.b[i]).join("");
}
function moveTrace(x, y) {
  tracePoint(x, y);
  const candidate = candidateAt(x, y);
  if (!candidate) return;
  const index = +candidate.tile.dataset.i;
  if (s.pick.length && !near(index).includes(s.pick.at(-1))) return;
  pick(candidate.tile);
}
$("#grid").onpointerdown = (e) => {
  const candidate = candidateAt(e.clientX, e.clientY);
  if (!candidate) return;
  s.drag = 1;
  s.pointerId = e.pointerId;
  clearPick();
  clearTrace();
  pick(candidate.tile);
  tracePoint(e.clientX, e.clientY);
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
};
$("#grid").onpointermove = (e) => {
  if (s.drag && e.pointerId === s.pointerId) moveTrace(e.clientX, e.clientY);
};
$("#grid").onpointerup = (e) => {
  if (!s.drag || e.pointerId !== s.pointerId) return;
  s.drag = 0;
  try {
    e.currentTarget.releasePointerCapture(e.pointerId);
  } catch {}
  submit();
  setTimeout(clearTrace, 250);
};
$("#grid").onpointercancel = (e) => {
  if (s.drag) {
    s.drag = 0;
    clearPick();
    clearTrace();
  }
};
document
  .querySelectorAll("[data-screen]")
  .forEach((x) => (x.onclick = () => show(x.dataset.screen)));
const launchRandom = () =>
  window.wordrushSessionCode
    ? $("#multiplayerDialog").showModal()
    : start(nextRandomMode(), null, false, true);
$("#randomPanel").onpointerup = (e) => {
  if (e.target.closest("#reroll")) return;
  e.preventDefault();
  launchRandom();
};
$("#randomPanel").onkeydown = (e) => {
  if ((e.key === "Enter" || e.key === " ") && !e.target.closest("#reroll")) {
    e.preventDefault();
    launchRandom();
  }
};
$("#quickPlay").onclick = () => start("classic");
$("#navStats").onclick = () => show("statsScreen");
$("#stopRush").onclick = stopRush;
$("#stopRushResults").onclick = stopRush;
$("#again").onclick = () => start(s.mode);
$("#endGame").onclick = end;
$("#reroll").onclick = (e) => {
  e.stopPropagation();
  let a = [
    ["Minimum 4 · Sudden death", "3 minutes · 5×5 grid"],
    ["Race to 500 · 4×4 grid", "First player to 500"],
    ["Classic free play · 6×6 grid", "2 minutes · 6×6 grid"],
  ][Math.floor(Math.random() * 3)];
  $("#randomPreview").textContent = a[0];
  $("#randomPreviewSub").textContent = a[1];
};
document
  .querySelectorAll("[data-mode]")
  .forEach((x) => (x.onclick = () => start(x.dataset.mode)));
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
$("#customGame").onclick = () => $("#customDialog").showModal();
$("#customForm")?.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "start") return;
  const type = $("#customType").value,
    rules = $("#customRules").value,
    min = Math.max(3, Math.min(12, Number($("#customMin").value) || 3)),
    size = Math.max(4, Math.min(8, Number($("#customBoard").value) || 4)),
    seconds = Math.max(
      15,
      Math.min(600, Number($("#customTime").value) || 120),
    );
  const ruleMin = rules === "long" ? Math.max(5, min) : min;
  const label =
    type === "classic" ? "CUSTOM CLASSIC" : type.toUpperCase() + " CUSTOM";
  const rule =
    rules === "first"
      ? "First to 500 points"
      : rules === "long"
        ? "Minimum " + ruleMin + " letters"
        : "Minimum " + ruleMin + " letters · " + seconds + " seconds";
  start(
    "custom",
    [
      label,
      ruleMin,
      size,
      seconds,
      rule,
      { target: rules === "first" ? 500 : null },
    ],
    type === "dirty",
  );
});
fetch("/dictionary.json")
  .then((response) => (response.ok ? response.json() : []))
  .then((words) => words.forEach((word) => custom.add(word)))
  .catch(() => {});
show("homeScreen");
document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-screen]");
  if (target) show(target.dataset.screen);
});

window.wordrushRecordOnlineWord = (word) => {
  profile.words++;
  profile.correct++;
  profile.totalWordLength += word.length;
  profile.longest = Math.max(profile.longest, word.length);
  updateProfile();
};
window.wordrushRecordOnlineIncorrect = () => {
  profile.incorrect++;
  updateProfile();
};
window.wordrushOnlineRound = (round, config, mode) => {
  const match = Object.entries(MODE).find(
    ([, value]) => value[0] === config?.label,
  );
  s.mode = mode || match?.[0] || "classic";
  document.body.dataset.mode = s.mode;
  s.n = round.size;
  s.b = round.board;
  s.score = 0;
  s.found.clear();
  s.done = 0;
  $("#gameMode").textContent = config?.label || "MULTIPLAYER";
  $("#gameTitle").textContent = "Round 01 · " + round.size + "×" + round.size;
  $("#ruleBanner").textContent = config?.rule || "";
  render();
  show("gameScreen");
};
window.wordrushOnlineFinish = (ranking, result = {}) => {
  clearInterval(s.timer);
  const mine =
    ranking?.find((player) => player.name === profile.name)?.score ?? s.score;
  $("#finalScore").textContent = mine;
  $("#bonus").textContent = mine ? 50 : 0;
  renderResults(ranking);
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
    : (ranking?.[0]?.name || "Winner") +
      " wins · " +
      (result.stats?.wordsFound || 0) +
      " words found.";
  profile.score += mine;
  profile.rounds++;
  profile.totalGameSeconds += (Date.now() - s.startedAt) / 1000;
  const won = result.cooperative || ranking?.[0]?.name === profile.name;
  profile.gamesWon += won ? 1 : 0;
  profile.gamesLost += won ? 0 : 1;
  updateProfile();
  show("resultsScreen");
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
document.querySelectorAll("[data-avatar]").forEach((button) =>
  button.addEventListener("click", () => {
    profile.avatar = button.dataset.avatar;
    document
      .querySelectorAll("[data-avatar]")
      .forEach((x) =>
        x.classList.toggle("chosen", x.dataset.avatar === profile.avatar),
      );
    if ($("#profileButton")) $("#profileButton").textContent = profile.avatar;
  }),
);
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
$("#profileForm .dialog-save")?.addEventListener("click", saveProfile);
function make() {
  let all = [...lex()],
    dirty = s.mode === "dirty" || customAdult;
  for (let attempt = 0; attempt < 40; attempt++) {
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
  return Array(s.n * s.n)
    .fill(0)
    .map(() => bag[Math.floor(Math.random() * bag.length)]);
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
  if (starting) return direct && grid.contains(direct) ? direct : null;
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
