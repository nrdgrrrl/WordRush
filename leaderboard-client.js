(() => {
  const guestId =
    localStorage.getItem("wordrush-guest-id") || crypto.randomUUID();
  localStorage.setItem("wordrush-guest-id", guestId);
  const profile = () =>
    window.wordrushProfile
      ? window.wordrushProfile()
      : { name: "Guest", avatar: "🐈" };
  const request = (url, options) =>
    fetch(url, options).then((response) => {
      if (!response.ok) throw new Error("leaderboard request failed");
      return response.json();
    });
  let loadToken = 0;
  const readStoredProfile = () => {
    try {
      return JSON.parse(localStorage.getItem("wordrush-profile") || "{}");
    } catch {
      return {};
    }
  };
  if (!sessionStorage.getItem("wordrush-leaderboard-baseline"))
    sessionStorage.setItem(
      "wordrush-leaderboard-baseline",
      JSON.stringify(readStoredProfile()),
    );
  const scoreRound = (detail) => {
    const own = detail.ranking?.find((player) => player.id === guestId);
    const score = own?.score ?? detail.ranking?.[0]?.score;
    const value = Number(score) || 0;
    const current = readStoredProfile();
    if (!value) {
      sessionStorage.setItem(
        "wordrush-leaderboard-baseline",
        JSON.stringify(current),
      );
      return;
    }
    const previous = (() => {
      try {
        return JSON.parse(
          sessionStorage.getItem("wordrush-leaderboard-baseline") || "{}",
        );
      } catch {
        return {};
      }
    })();
    const marker = [guestId, value, current.rounds || 0].join(":");
    if (sessionStorage.getItem("wordrush-last-leaderboard-score") === marker)
      return;
    const delta = (key) =>
      Math.max(0, (Number(current[key]) || 0) - (Number(previous[key]) || 0));
    if (detail.multiplayer) {
      sessionStorage.setItem("wordrush-last-leaderboard-score", marker);
      sessionStorage.setItem(
        "wordrush-leaderboard-baseline",
        JSON.stringify(current),
      );
      return;
    }
    request("/api/leaderboard/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: guestId,
        ...profile(),
        score: value,
        words: delta("words"),
        correct: delta("correct"),
        incorrect: delta("incorrect"),
        longest: current.longest || 0,
        totalWordLength: delta("totalWordLength"),
        gameSeconds: Math.min(600, delta("totalGameSeconds")),
        multiplayer: false,
        multiplayerWin: false,
      }),
    })
      .then(() => {
        sessionStorage.setItem("wordrush-last-leaderboard-score", marker);
        sessionStorage.setItem(
          "wordrush-leaderboard-baseline",
          JSON.stringify(current),
        );
      })
      .catch(() => {});
  };
  function addUI() {
    const card = document.querySelector("#sessionCard");
    if (!card || document.querySelector("#scoreboardButton")) return;
    const button = document.createElement("button");
    button.id = "scoreboardButton";
    button.className = "secondary scoreboard-button";
    button.innerHTML = "Global scoreboard <span>→</span>";
    button.addEventListener("click", openBoard);
    card.after(button);
    const screen = document.createElement("section");
    screen.className = "screen";
    screen.id = "scoreboardScreen";
    screen.innerHTML =
      '<div class="game-head"><button id="scoreboardBack">←</button><div><p class="eyebrow">Everyone is playing</p><h1>Scoreboard</h1></div></div><div class="scoreboard-tabs"><button class="active" data-period="weekly">This week</button><button data-period="total">All time</button><button data-period="multiplayer-wins">MP wins</button><button data-period="multiplayer-ratio">MP ratio</button></div><div id="scoreboardList" class="scoreboard-list"></div>';
    document.querySelector("#homeScreen").after(screen);
    screen
      .querySelector("#scoreboardBack")
      .addEventListener("click", () =>
        document.querySelector('[data-screen="homeScreen"]').click(),
      );
    screen.querySelectorAll("[data-period]").forEach((tab) =>
      tab.addEventListener("click", () => {
        screen
          .querySelectorAll("[data-period]")
          .forEach((x) => x.classList.toggle("active", x === tab));
        load(tab.dataset.period);
      }),
    );
    const dialog = document.createElement("dialog");
    dialog.id = "leaderboardProfileDialog";
    dialog.innerHTML =
      '<div class="dialog-head"><div><p class="eyebrow">Player profile</p><h2 id="leaderboardProfileName">Player</h2></div><button id="leaderboardProfileClose" aria-label="Close">×</button></div><div id="leaderboardProfileBody" class="leaderboard-profile"></div>';
    document.body.append(dialog);
    dialog
      .querySelector("#leaderboardProfileClose")
      .addEventListener("click", () => dialog.close());
  }
  function openBoard() {
    document
      .querySelectorAll(".screen")
      .forEach((screen) =>
        screen.classList.toggle("active", screen.id === "scoreboardScreen"),
      );
    document
      .querySelectorAll("nav button")
      .forEach((button) => button.classList.remove("active"));
    load("weekly");
  }
  function load(period) {
    const list = document.querySelector("#scoreboardList");
    if (!list) return;
    const token = ++loadToken;
    list.innerHTML = '<p class="scoreboard-empty">Loading the standings…</p>';
    request("/api/leaderboard?period=" + period)
      .then((data) => {
        if (token !== loadToken) return;
        list.innerHTML = "";
        if (!data.players.length) {
          list.innerHTML =
            '<p class="scoreboard-empty">No scores yet. Be the first legend.</p>';
          return;
        }
        data.players.forEach((player, index) => {
          const row = document.createElement("button");
          row.className = "scoreboard-row";
          row.innerHTML =
            '<span class="scoreboard-rank">' +
            (index + 1) +
            '</span><span class="scoreboard-avatar"></span><span class="scoreboard-player"></span><b></b>';
          row.querySelector(".scoreboard-avatar").textContent = player.avatar;
          row.querySelector(".scoreboard-player").textContent = player.name;
          row.querySelector("b").textContent =
            period === "multiplayer-ratio"
              ? (player.score * 100).toFixed(1) + "%"
              : player.score.toLocaleString();
          row.addEventListener("click", () => showProfile(player.id));
          list.append(row);
        });
      })
      .catch(() => {
        if (token !== loadToken) return;
        list.innerHTML =
          '<p class="scoreboard-empty">Scoreboard unavailable right now.</p>';
      });
  }
  function showProfile(id) {
    request("/api/leaderboard/" + encodeURIComponent(id))
      .then((player) => {
        const dialog = document.querySelector("#leaderboardProfileDialog");
        document.querySelector("#leaderboardProfileName").textContent =
          player.avatar + " " + player.name;
        document.querySelector("#leaderboardProfileBody").innerHTML =
          '<div class="profile-score"><strong>' +
          player.totalScore.toLocaleString() +
          '</strong><small>total score</small></div><div class="profile-stat-grid"><span><b>' +
          player.rounds +
          "</b><small>rounds</small></span><span><b>" +
          player.totalWords +
          "</b><small>words</small></span><span><b>" +
          (player.totalWords
            ? (player.totalWordLength / player.totalWords).toFixed(1)
            : "0.0") +
          "</b><small>avg word length</small></span><span><b>" +
          (player.totalGameSeconds
            ? (player.totalWords / (player.totalGameSeconds / 60)).toFixed(1)
            : "0.0") +
          "</b><small>words / minute</small></span><span><b>" +
          player.multiplayerWins +
          "</b><small>multiplayer wins</small></span><span><b>" +
          (player.multiplayerWinRatio * 100).toFixed(1) +
          "%</b><small>multiplayer win ratio</small></span></div>";
        dialog.showModal();
      })
      .catch(() => {});
  }
  document.addEventListener("wordrush:round-complete", ({ detail }) => {
    scoreRound(detail);
  });
  addUI();
})();
