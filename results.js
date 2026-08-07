(() => {
  const $ = (selector) => document.querySelector(selector);
  const SPEEDS = { slow: 1800, medium: 900, fast: 350 };

  function readSoloSettings() {
    return {
      view: "static",
      speed: "medium",
    };
  }

  let settings = readSoloSettings();
  let localWords = [];
  let resultRows = [];
  let revealTimer = null;
  let revealToken = 0;
  let renderedView = null;
  let currentSuddenDeath = null;
  let currentSeries = null;
  let currentCooperative = false;
  let currentTeamScore = 0;
  const suddenDeathOutcome = window.WordrushSuddenDeathOutcome;
  const suddenDeathSeries = window.WordrushSuddenDeathSeries;
  const cooperativeResults = window.WordrushCooperativeResults;

  function renderPlayerName(target, player) {
    if (window.wordrushRenderPlayerName) {
      window.wordrushRenderPlayerName(target, player);
      return;
    }
    target.textContent = (player.avatar || "🐈") + " " + player.name;
  }

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

  function makePlayerCard(
    player,
    suddenDeath = currentSuddenDeath,
    series = currentSeries,
  ) {
    const card = document.createElement("article");
    card.className = "reveal-player";
    const heading = document.createElement("header");
    const identity = document.createElement("span");
    identity.className = "reveal-player-name";
    renderPlayerName(identity, player);
    const score = document.createElement("b");
    score.className = "reveal-player-total";
    score.textContent = currentCooperative ? "0 contribution" : "0";
    heading.append(identity, score);
    const outcomeBadge = suddenDeath
      ? suddenDeathOutcome.badgeForPlayer(suddenDeath, player)
      : series?.winnerIds?.includes(player.id)
        ? "WINNER"
        : null;
    if (outcomeBadge) {
      const badge = document.createElement("small");
      badge.className = "reveal-outcome-badge";
      badge.dataset.outcome = outcomeBadge.toLowerCase();
      badge.textContent = outcomeBadge;
      heading.insertBefore(badge, score);
      card.classList.add("sudden-death-result-card");
    }
    if (series) {
      const seriesStatus = document.createElement("small");
      seriesStatus.className = "reveal-series-status";
      seriesStatus.textContent =
        (Number(player.series?.strikes) || 0) + " strike" +
        (Number(player.series?.strikes) === 1 ? "" : "s") +
        " · " + (player.series?.status === "withdrawn" ? "withdrawn" : "active");
      heading.append(seriesStatus);
    }
    if (player.session) {
      const sessionRecord = document.createElement("p");
      sessionRecord.className = "reveal-session-record";
      sessionRecord.textContent =
        `${Number(player.session.wins) || 0}W · ` +
        `${Number(player.session.losses) || 0}L · ` +
        `${(Number(player.session.points) || 0).toLocaleString()} session pts`;
      card.append(heading, sessionRecord);
    } else card.append(heading);
    const list = document.createElement("div");
    list.className = "reveal-word-list";
    card.append(list);
    return card;
  }

  function appendWord(card, item) {
    const line = document.createElement("div");
    const length = String(item.word || "").length;
    const lengthClass = length >= 7 ? "long" : length >= 5 ? "medium" : "short";
    line.className = "reveal-word reveal-in word-length-" + lengthClass;
    const word = document.createElement("span");
    word.textContent = item.word;
    const points = document.createElement("b");
    points.textContent = "+" + item.points;
    line.append(word, points);
    card.querySelector(".reveal-word-list").append(line);
  }

  function renderHighlights(players, skipped = false, suddenDeath = null, series = null) {
    const outcome = suddenDeathOutcome.normalizeSuddenDeathOutcome(suddenDeath);
    const topPlayer = series
      ? suddenDeathSeries.rankParticipants(players, { winnerIds: series.winnerIds })[0]
      : [...players].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0];
    const words = players.flatMap((player) =>
      (player.words || []).map((item) => ({ ...item, player })),
    );
    const longestLength = Math.max(
      0,
      ...words.map((item) => String(item.word || "").length),
    );
    const longest = words.filter((item) =>
      String(item.word || "").length === longestLength,
    );
    const longestPlayers = new Set(longest.map((item) => item.player.id)).size;
    if ($("#resultTopLabel"))
      $("#resultTopLabel").textContent = series
        ? "SERIES RESULT"
        : skipped
        ? "ROUND RESULT"
        : currentCooperative
        ? "TEAM OUTCOME"
        : outcome
          ? "TOP SCORE · OUTCOME ABOVE"
          : "ROUND LEADER";
    if ($("#resultTopPlayer")) {
      const topTarget = $("#resultTopPlayer");
      topTarget.textContent = "";
      if (skipped) topTarget.textContent = "Not recorded";
      else if (currentCooperative) topTarget.textContent = currentTeamScore.toLocaleString() + " shared points";
      else if (topPlayer) renderPlayerName(topTarget, topPlayer);
      else topTarget.textContent = "—";
    }
    if ($("#resultLongestLabel"))
      $("#resultLongestLabel").textContent = longestPlayers > 1
        ? "LONGEST WORD · CO-WINNERS"
        : "LONGEST WORD";
    if ($("#resultLongestWord")) {
      const longestTarget = $("#resultLongestWord");
      longestTarget.replaceChildren();
      if (!longest.length) longestTarget.textContent = "—";
      else longest.forEach((item, index) => {
        if (index) longestTarget.append(document.createTextNode(" • "));
        const entry = document.createElement("span");
        const prefix = document.createElement("span");
        prefix.textContent =
          String(item.word).toUpperCase() + " · " + item.points + " pts · ";
        const playerName = document.createElement("span");
        entry.append(prefix, playerName);
        if (window.wordrushRenderPlayerName)
          window.wordrushRenderPlayerName(playerName, item.player);
        else playerName.textContent = (item.player.avatar || "🐈") + " " + item.player.name;
        longestTarget.append(entry);
      });
    }
  }
  function renderSeriesFinal(series, ranking) {
    const panel = $("#seriesFinalPanel");
    if (!panel) return;
    panel.hidden = !series;
    if (!series) {
      $("#seriesFinalStandings")?.replaceChildren();
      $("#seriesRoundHistory")?.replaceChildren();
      return;
    }
    const standings = suddenDeathSeries.rankParticipants(ranking || []);
    const standingsTarget = $("#seriesFinalStandings");
    standingsTarget?.replaceChildren(
      ...standings.map((player) => {
        const row = document.createElement("div");
        row.className = "series-final-standing" +
          (series.winnerIds?.includes(player.id) ? " is-winner" : "") +
          (player.series?.status === "withdrawn" ? " is-withdrawn" : "");
        const name = document.createElement("strong");
        renderPlayerName(name, player);
        const detail = document.createElement("span");
        detail.textContent =
          (Number(player.series?.strikes) || 0) + " strike" +
          (Number(player.series?.strikes) === 1 ? "" : "s") +
          " · " + (player.series?.status === "withdrawn" ? "withdrawn" : "active");
        const score = document.createElement("b");
        score.textContent = (Number(player.score) || 0).toLocaleString() + " pts";
        row.append(name, detail, score);
        return row;
      }),
    );
    const historyTarget = $("#seriesRoundHistory");
    const reason = (entry) => entry.reason === "invalid_word"
      ? (entry.loserName || "A player") + " rejected " +
        (entry.rejectedWord || "a word") + " · strike"
      : entry.reason === "timeout"
        ? "Timeout · no strike"
        : entry.reason === "host_skip"
          ? "Host skip · no strike"
          : "Round ended · no strike";
    historyTarget?.replaceChildren(
      ...(series.history || []).map((entry) => {
        const item = document.createElement("li");
        item.textContent = "Round " + entry.roundNumber + ": " + reason(entry);
        return item;
      }),
    );
  }

  function renderReveal() {
    const host = $("#revealPlayers");
    if (!host) return;
    clearTimeout(revealTimer);
    revealToken++;
    const token = revealToken;
    const players = rows();
    const cards = players.map((player) =>
      makePlayerCard(player, currentSuddenDeath, currentSeries),
    );
    host.replaceChildren(...cards);
    $("#revealTotalLabel").textContent = currentCooperative
      ? "TEAM SCORE"
      : "TOTAL SCORE";
    $("#revealTotal").textContent = currentCooperative
      ? currentTeamScore.toLocaleString()
      : "0";
    const playerTotals = players.map(() => 0);
    const maximumWords = Math.max(
      0,
      ...players.map((player) => player.words?.length || 0),
    );
    if (maximumWords === 0) {
      const scoreTotal = players.reduce((sum, player, playerIndex) => {
        const score = currentCooperative
          ? Number(player.contribution) || 0
          : Number(player.score) || 0;
        cards[playerIndex].querySelector(".reveal-player-total").textContent =
          score.toLocaleString() + (currentCooperative ? " contribution" : "");
        return sum + score;
      }, 0);
      if (!currentCooperative)
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
          playerTotals[playerIndex].toLocaleString() +
          (currentCooperative ? " contribution" : "");
        total += Number(item.points) || 0;
      });
      if (!currentCooperative) {
        const totalEl = $("#revealTotal");
        totalEl.textContent = total.toLocaleString();
        totalEl.classList.remove("score-pop");
        void totalEl.offsetWidth;
        totalEl.classList.add("score-pop");
      }
      wordIndex++;
      revealTimer = setTimeout(
        revealNextGroup,
        SPEEDS[settings.speed] || SPEEDS.medium,
      );
    };

    revealNextGroup();
  }

  function applyResults(restartReveal = false) {
    $("#staticResultsView").hidden = false;
    revealToken++;
    clearTimeout(revealTimer);
    renderedView = "static";
  }

  function updateGuestControls() {
    const isGuest =
      window.wordrushSessionCode &&
      window.wordrushCanSetResultsSettings === false;
    [ $("#staticResultsButton"), $("#animatedResultsButton") ].forEach((btn) => {
      if (!btn) return;
      if (isGuest) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        btn.title = "Only the host can change multiplayer results";
      } else {
        btn.disabled = false;
        btn.removeAttribute("aria-disabled");
        btn.title = "";
      }
    });
    document.querySelectorAll("[data-speed]").forEach((btn) => {
      if (isGuest) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        btn.title = "Only the host can change multiplayer results";
      } else {
        btn.disabled = false;
        btn.removeAttribute("aria-disabled");
        btn.title = "";
      }
    });
  }

  function persistSoloSettings() {
    if (window.wordrushSessionCode) return;
    localStorage.setItem("wordrush-results-view", settings.view);
    localStorage.setItem("wordrush-results-speed", settings.speed);
  }

  function setSettings(next, broadcast = false) {
    if (
      broadcast &&
      window.wordrushSessionCode &&
      window.wordrushCanSetResultsSettings === false
    )
      return;
    settings = {
      view: "static",
      speed: "medium",
    };
    persistSoloSettings();
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
    currentSuddenDeath = null;
    currentSeries = null;
    currentCooperative = false;
    currentTeamScore = 0;
    renderedView = null;
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
    const presentation = cooperativeResults.normalizeResultPresentation({
      result: detail.result,
      ranking: detail.ranking,
    });
    resultRows = presentation.players;
    currentCooperative = presentation.cooperative;
    currentTeamScore = presentation.teamScore || 0;
    const skipped =
      detail.result?.reason === "skipped" || detail.result?.recorded === false;
    currentSuddenDeath = suddenDeathOutcome.normalizeSuddenDeathOutcome(
      detail.suddenDeath || detail.result?.suddenDeath,
    );
    currentSeries = detail.result?.series || null;
    renderHighlights(rows(), skipped, currentSuddenDeath, currentSeries);
    renderSeriesFinal(currentSeries, rows());
    applyResults();
  });

  window.addEventListener("wordrush:room-change", () => {
    updateGuestControls();
    if (!window.wordrushSessionCode) {
      settings = readSoloSettings();
      applyResults();
    }
  });

  window.wordrushResultsSettings = (next) => setSettings(next, false);
  applyResults();
})();
