(() => {
  const $ = (selector) => document.querySelector(selector);
  const SPEEDS = { slow: 1800, medium: 900, fast: 350 };
  const storedView = localStorage.getItem("wordrush-results-view");
  const storedSpeed = localStorage.getItem("wordrush-results-speed");
  let settings = {
    view: ["static", "reveal"].includes(storedView) ? storedView : "static",
    speed: Object.hasOwn(SPEEDS, storedSpeed) ? storedSpeed : "medium",
  };
  let localWords = [];
  let resultRows = [];
  let revealTimer = null;
  let revealToken = 0;

  function localRow() {
    const profile = window.wordrushProfile?.() || {
      name: "Player",
      avatar: "🐈",
    };
    return {
      ...profile,
      score: localWords.reduce((sum, item) => sum + item.points, 0),
      words: localWords,
    };
  }

  function rows() {
    return resultRows.length ? resultRows : [localRow()];
  }

  function makePlayerCard(player) {
    const card = document.createElement("article");
    card.className = "reveal-player";
    const heading = document.createElement("header");
    const identity = document.createElement("span");
    identity.textContent = (player.avatar || "🐈") + " " + player.name;
    const score = document.createElement("b");
    score.className = "reveal-player-total";
    score.textContent = "0";
    heading.append(identity, score);
    const list = document.createElement("div");
    list.className = "reveal-word-list";
    card.append(heading, list);
    return card;
  }

  function appendWord(card, item) {
    const line = document.createElement("div");
    line.className = "reveal-word reveal-in";
    const word = document.createElement("span");
    word.textContent = item.word;
    const points = document.createElement("b");
    points.textContent = "+" + item.points;
    line.append(word, points);
    card.querySelector(".reveal-word-list").append(line);
  }

  function renderReveal() {
    const host = $("#revealPlayers");
    if (!host) return;
    clearTimeout(revealTimer);
    revealToken++;
    const token = revealToken;
    const players = rows();
    const cards = players.map(makePlayerCard);
    host.replaceChildren(...cards);
    $("#revealTotal").textContent = "0";
    const playerTotals = players.map(() => 0);
    const maximumWords = Math.max(
      0,
      ...players.map((player) => player.words?.length || 0),
    );
    if (maximumWords === 0) {
      const scoreTotal = players.reduce((sum, player, playerIndex) => {
        const score = Number(player.score) || 0;
        cards[playerIndex].querySelector(".reveal-player-total").textContent =
          score.toLocaleString();
        return sum + score;
      }, 0);
      $("#revealTotal").textContent = scoreTotal.toLocaleString();
      return;
    }
    let wordIndex = 0;
    let total = 0;

    const revealNextGroup = () => {
      if (token !== revealToken || wordIndex >= maximumWords) return;
      players.forEach((player, playerIndex) => {
        const item = player.words?.[wordIndex];
        if (!item) return;
        appendWord(cards[playerIndex], item);
        playerTotals[playerIndex] += Number(item.points) || 0;
        cards[playerIndex].querySelector(".reveal-player-total").textContent =
          playerTotals[playerIndex].toLocaleString();
        total += Number(item.points) || 0;
      });
      const totalEl = $("#revealTotal");
      totalEl.textContent = total.toLocaleString();
      totalEl.classList.remove("score-pop");
      void totalEl.offsetWidth;
      totalEl.classList.add("score-pop");
      wordIndex++;
      revealTimer = setTimeout(
        revealNextGroup,
        SPEEDS[settings.speed] || SPEEDS.medium,
      );
    };

    revealNextGroup();
  }

  function applyResults() {
    const reveal = settings.view === "reveal";
    $("#staticResultsView").hidden = reveal;
    $("#animatedResultsView").hidden = !reveal;
    $("#staticResultsButton").classList.toggle("active", !reveal);
    $("#staticResultsButton").setAttribute("aria-pressed", String(!reveal));
    $("#animatedResultsButton").classList.toggle("active", reveal);
    $("#animatedResultsButton").setAttribute("aria-pressed", String(reveal));
    document.querySelectorAll("[data-speed]").forEach((button) => {
      const active = button.dataset.speed === settings.speed;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (reveal) renderReveal();
    else {
      revealToken++;
      clearTimeout(revealTimer);
    }
  }

  function setSettings(next, broadcast = false) {
    settings = {
      view:
        next.view === "reveal"
          ? "reveal"
          : next.view === "static"
            ? "static"
            : settings.view,
      speed: Object.hasOwn(SPEEDS, next.speed) ? next.speed : settings.speed,
    };
    localStorage.setItem("wordrush-results-view", settings.view);
    localStorage.setItem("wordrush-results-speed", settings.speed);
    if (
      broadcast &&
      window.wordrushSessionCode &&
      window.wordrushSocket?.readyState === WebSocket.OPEN
    ) {
      window.wordrushSocket.send(
        JSON.stringify({ type: "set_results_settings", ...settings }),
      );
    }
    applyResults();
  }

  document.addEventListener("wordrush:round-started", () => {
    localWords = [];
    resultRows = [];
    revealToken++;
    clearTimeout(revealTimer);
  });
  document.addEventListener("wordrush:screen-change", ({ detail }) => {
    if (detail.id !== "resultsScreen") {
      revealToken++;
      clearTimeout(revealTimer);
    }
  });
  document.addEventListener("wordrush:word-accepted", ({ detail }) => {
    if (!localWords.some((item) => item.word === detail.word))
      localWords.push({
        word: detail.word,
        points: Number(detail.points) || 0,
      });
  });
  document.addEventListener("wordrush:round-complete", ({ detail }) => {
    resultRows = (detail.ranking || []).map((player) => ({
      ...player,
      words: player.words || [],
    }));
    if (detail.result?.results)
      settings = { ...settings, ...detail.result.results };
    applyResults();
  });

  window.wordrushResultsSettings = (next) => setSettings(next, false);
  $("#staticResultsButton")?.addEventListener("click", () =>
    setSettings({ view: "static" }, true),
  );
  $("#animatedResultsButton")?.addEventListener("click", () =>
    setSettings({ view: "reveal" }, true),
  );
  document
    .querySelectorAll("[data-speed]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        setSettings({ speed: button.dataset.speed }, true),
      ),
    );
  applyResults();
})();
