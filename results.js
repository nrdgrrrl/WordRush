(() => {
  const $ = (selector) => document.querySelector(selector);
  const speeds = { slow: 1800, medium: 900, fast: 350 };
  let localWords = [], revealTimer = 0, revealToken = 0, lastApplied = "", wasGame = false;
  let results = { view: localStorage.getItem("wordrush-results-view") || "static", speed: localStorage.getItem("wordrush-results-speed") || "medium" };
  let multiplayerWords = null;

  function sendSettings(next) {
    results = { ...results, ...next };
    localStorage.setItem("wordrush-results-view", results.view);
    localStorage.setItem("wordrush-results-speed", results.speed);
    if (window.wordrushSessionCode && window.wordrushSocket?.readyState === 1)
      window.wordrushSocket.send(JSON.stringify({ type: "set_results_settings", view: results.view, speed: results.speed }));
    applyResults();
  }

  function rows() {
    if (multiplayerWords) return multiplayerWords;
    const name = window.wordrushProfile?.().name || "Player";
    return [{ name, avatar: window.wordrushProfile?.().avatar || "🐈", score: localWords.reduce((sum, item) => sum + item.points, 0), words: localWords }];
  }

  function renderReveal() {
    const host = $("#revealPlayers");
    if (!host) return;
    host.innerHTML = rows().map((player) => `<article class="reveal-player"><header><span>${player.avatar || "🐈"} ${player.name}</span><b class="reveal-player-total">0</b></header><div class="reveal-word-list"></div></article>`).join("");
    revealToken++;
    const token = revealToken;
    clearInterval(revealTimer);
    const delay = speeds[results.speed] || speeds.medium;
    let total = 0;
    $("#revealTotal").textContent = "0";
    const items = [];
    [...host.querySelectorAll(".reveal-player")].forEach((card, playerIndex) => {
      const player = rows()[playerIndex];
      (player.words || []).forEach((item) => items.push({ card, item }));
    });
    let index = 0;
    const revealNext = () => {
      if (token !== revealToken || index >= items.length) return;
      const { card, item } = items[index++];
      const line = document.createElement("div");
      line.className = "reveal-word reveal-in";
      line.innerHTML = `<span>${item.word}</span><b>+${item.points}</b>`;
      card.querySelector(".reveal-word-list").append(line);
      const playerTotal = [...card.querySelectorAll(".reveal-word b")].reduce((sum, el) => sum + Number(el.textContent.slice(1)), 0);
      card.querySelector(".reveal-player-total").textContent = playerTotal;
      total += item.points;
      const totalEl = $("#revealTotal");
      totalEl.textContent = total;
      totalEl.classList.remove("score-pop");
      void totalEl.offsetWidth;
      totalEl.classList.add("score-pop");
      revealTimer = setTimeout(revealNext, delay);
    };
    revealNext();
  }

  function applyResults() {
    const reveal = results.view === "reveal";
    const key = results.view + ":" + results.speed;
    if (reveal && key === lastApplied) return;
    lastApplied = key;
    $("#staticResultsView").hidden = reveal;
    $("#animatedResultsView").hidden = !reveal;
    $("#staticResultsButton").classList.toggle("active", !reveal);
    $("#animatedResultsButton").classList.toggle("active", reveal);
    document.querySelectorAll("[data-speed]").forEach((button) => button.classList.toggle("active", button.dataset.speed === results.speed));
    if (reveal) renderReveal();
  }

  const originalOnlineFinish = window.wordrushOnlineFinish;
  function finish(ranking, result = {}) {
    originalOnlineFinish?.(ranking, result);
    multiplayerWords = ranking?.map((player) => ({ ...player, words: player.words || [] })) || null;
    if (result.results) results = { ...results, ...result.results };
    applyResults();
  }

  window.wordrushOnlineFinish = finish;
  window.wordrushResultsSettings = (next) => { results = { ...results, ...next }; applyResults(); };
  const originalOnlineRound = window.wordrushOnlineRound;
  window.wordrushOnlineRound = (...args) => { localWords = []; multiplayerWords = null; return originalOnlineRound?.(...args); };
  const originalRecord = window.wordrushRecordOnlineWord;
  window.wordrushRecordOnlineWord = (word, points) => { localWords.push({ word, points: points || word.length * word.length }); originalRecord?.(word); };

  $("#staticResultsButton")?.addEventListener("click", () => sendSettings({ view: "static" }));
  $("#animatedResultsButton")?.addEventListener("click", () => sendSettings({ view: "reveal" }));
  document.querySelectorAll("[data-speed]").forEach((button) => button.addEventListener("click", () => sendSettings({ speed: button.dataset.speed })));
  const observer = new MutationObserver(() => {
    const gameActive = $("#gameScreen")?.classList.contains("active");
    if (gameActive && !wasGame) { localWords = []; multiplayerWords = null; lastApplied = ""; }
    wasGame = gameActive;
    const preview = $("#preview");
    if (preview?.classList.contains("found")) {
      const match = preview.textContent.match(/^(.+) \+(\d+)$/);
      if (match && !localWords.some((item) => item.word === match[1])) localWords.push({ word: match[1], points: Number(match[2]) });
    }
    if ($("#resultsScreen")?.classList.contains("active")) applyResults();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  applyResults();
})();
