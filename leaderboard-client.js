(() => {
  const request = (url, options) =>
    fetch(url, options).then((response) => {
      if (!response.ok) throw new Error("leaderboard request failed");
      return response.json();
    });
  let loadToken = 0;
  let profileLoadToken = 0;
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
      .addEventListener("click", () => {
        profileLoadToken++;
        dialog.close();
      });
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
          if (window.wordrushRenderAvatar)
            window.wordrushRenderAvatar(row.querySelector(".scoreboard-avatar"), player.avatar);
          else row.querySelector(".scoreboard-avatar").textContent = player.avatar;
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
    const token = ++profileLoadToken;
    request("/api/leaderboard/" + encodeURIComponent(id))
      .then((player) => {
        if (token !== profileLoadToken) return;
        const dialog = document.querySelector("#leaderboardProfileDialog");
        document.querySelector("#leaderboardProfileName").textContent =
          (window.wordrushAvatarLabel?.(player.avatar) || player.avatar || "🐈") +
          " " + player.name;
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
  addUI();
})();
