(() => {
  const NAMESPACE = "urn:x-cast:com.nrdgrrrl.wordrush";
  const screen = document.querySelector("#screen");
  const eyebrow = document.querySelector("#eyebrow");
  const connection = document.querySelector("#connection");
  let socket;
  let castContext;
  let reconnectToken = "";
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let keepaliveTimer = null;
  let activeRoomCode = "";
  let targetRoomCode = "";
  const reconnectStorageKey = "wordrush-display-reconnect";
  const suddenDeathOutcome = window.WordrushSuddenDeathOutcome;
  const suddenDeathSeries = window.WordrushSuddenDeathSeries;
  let renderedFinishedRoundId = null;

  const savedReconnectCredential = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(reconnectStorageKey) || "null");
      return typeof saved?.token === "string" && saved.token
        ? { token: saved.token, roomCode: String(saved.roomCode || "") }
        : null;
    } catch {
      return null;
    }
  };
  const saveReconnectCredential = () => {
    try {
      sessionStorage.setItem(reconnectStorageKey, JSON.stringify({
        token: reconnectToken,
        roomCode: activeRoomCode,
      }));
    } catch {}
  };
  const clearReconnectCredential = () => {
    try { sessionStorage.removeItem(reconnectStorageKey); } catch {}
  };

  const escape = (value) =>
    String(value ?? "").replace(/[&<>'"]/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
    );
  const renderIdle = (message = "Choose Wordrush from your phone to show the room here.") => {
    eyebrow.textContent = "TV COMPANION";
    screen.className = "screen idle";
    screen.innerHTML = `<p class="kicker">READY TO PLAY</p><h1>Cast a room<br>to get started.</h1><p class="message">${escape(message)}</p>`;
  };
  const wordLengthClass = (word) => {
    const length = String(word || "").length;
    return length >= 7 ? "long" : length >= 5 ? "medium" : "short";
  };
  const seriesReason = (entry) => entry?.reason === "invalid_word"
    ? escape(entry.loserName || entry.loser?.name || "A player") +
      " rejected " + escape(entry.rejectedWord || "a word") + " · 1 strike"
    : entry?.reason === "timeout"
      ? "Timeout · no strike"
      : entry?.reason === "host_skip"
        ? "Host skip · no strike"
        : "Round ended · no strike";
  const seriesStandings = (series) =>
    suddenDeathSeries.rankParticipants(series?.participants || []).map((player) =>
      "<div class=\"series-tv-standing" +
      (player.status === "withdrawn" ? " is-withdrawn" : "") +
      "\"><strong>" + escape(player.avatar || "🐈") + " " +
      escape(player.name) + "</strong><span>" +
      (player.status === "withdrawn"
        ? "WITHDRAWN"
        : (Number(player.strikes || 0) + " STRIKE" +
          (Number(player.strikes || 0) === 1 ? "" : "S"))) +
      "</span></div>",
    ).join("");
  const renderSeriesInterstitial = (state) => {
    const series = state.series;
    const entry = series?.history?.at(-1);
    const roundNumber = Number(entry?.roundNumber) ||
      Math.max(1, Number(series?.currentRoundNumber || 1) - 1);
    eyebrow.textContent = "SUDDEN DEATH SERIES";
    screen.className = "screen series-interstitial";
    screen.innerHTML =
      "<p class=\"kicker\">ROUND " + roundNumber + " OF " +
      (series?.totalRounds || 10) + "</p><h1>Next board loading.</h1>" +
      "<div class=\"series-tv-outcome\">" + seriesReason(entry) + "</div>" +
      "<div class=\"series-tv-standings\">" + seriesStandings(series) +
      "</div><p class=\"series-tv-next\">Next board will start after the readable transition.</p>";
    connection.textContent = "Sudden Death Series · interstitial";
  };
  const renderSeriesFinished = (state, result) => {
    const series = result.series || state.series;
    const ranking = suddenDeathSeries.rankParticipants(
      result.ranking || series?.participants || [],
    );
    const winners = ranking.filter((player) =>
      (player.series?.status || player.status) !== "withdrawn" &&
      series?.winnerIds?.includes(player.id),
    );
    const headline = winners.length
      ? winners.map((player) => escape(player.avatar || "🐈") + " " +
          escape(player.name)).join(" & ") +
        (winners.length > 1 ? " share" : " wins") + " the series!"
      : "Sudden Death Series cancelled";
    const cards = ranking.map((player) => {
      const seriesPlayer = player.series || player;
      return "<article class=\"series-tv-final-card" +
        (series?.winnerIds?.includes(player.id) ? " is-winner" : "") +
        (seriesPlayer.status === "withdrawn" ? " is-withdrawn" : "") +
        "\"><header><strong>" + escape(player.avatar || "🐈") + " " +
        escape(player.name) + "</strong><b>" + Number(seriesPlayer.strikes || 0) +
        " strike" + (Number(seriesPlayer.strikes || 0) === 1 ? "" : "s") +
        "</b></header><p>" +
        (seriesPlayer.status === "withdrawn"
          ? "WITHDRAWN · cannot win"
          : Number(player.score || 0).toLocaleString() + " aggregate pts · " +
            (player.words || []).length + " accepted words") +
        "</p></article>";
    }).join("");
    const history = (series?.history || []).map((entry) =>
      "<li>Round " + entry.roundNumber + ": " + seriesReason(entry) + "</li>",
    ).join("");
    eyebrow.textContent = "FINAL RESULTS";
    screen.className = "screen finished results-party series-results";
    screen.innerHTML =
      "<div class=\"finish-title\"><p class=\"kicker\">SUDDEN DEATH SERIES · " +
      (series?.totalRounds || 10) + " ROUNDS</p><h1>" + headline +
      "</h1></div><div class=\"series-tv-final-grid\">" + cards +
      "</div><div class=\"series-tv-history\"><h2>Round losses</h2><ol>" +
      history + "</ol></div>";
    connection.textContent = "Final series standings · live room connection";
    renderedFinishedRoundId = result.accountingId || result.roundId || null;
  };
  const renderFinished = (state) => {
    const result = state.lastResult || {};
    if (result.series?.id || state.series?.phase === "finished")
      return renderSeriesFinished(state, result);
    const replaySuddenDeath = renderedFinishedRoundId !== result.roundId;
    const ranking = [...(result.ranking || state.players || [])]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const wordEntries = ranking.flatMap((player) =>
      (player.words || []).map((item) => ({ player, item })),
    );
    const longestLength = Math.max(
      0,
      ...wordEntries.map(({ item }) => String(item.word || "").length),
    );
    const longest = wordEntries
      .filter(({ item }) => String(item.word || "").length === longestLength)
      .sort((a, b) => Number(b.item.points || 0) - Number(a.item.points || 0))[0];
    const winner = ranking[0];
    const leaders = winner
      ? ranking.filter((player) => Number(player.score || 0) === Number(winner.score || 0))
      : [];
    const suddenDeath = suddenDeathOutcome.normalizeSuddenDeathOutcome(result.suddenDeath);
    const headline = suddenDeath
      ? suddenDeath.outcome === "sole_winner"
        ? escape(suddenDeath.winner.avatar) + " " + escape(suddenDeath.winner.name) + " wins Sudden Death!"
        : suddenDeath.outcome === "survivors"
          ? "Sudden Death survivors!"
          : "Sudden Death — no winner"
      : result.cooperative
      ? "Team word power!"
      : leaders.length > 1
        ? `${leaders.map((player) => `${escape(player.avatar || "🐈")} ${escape(player.name)}`).join(" & ")} tie for the crown!`
      : winner
        ? `${escape(winner.avatar || "🐈")} ${escape(winner.name)} takes the crown!`
        : "What a word rush!";
    const longestBanner = longest
      ? `<div class="longest-banner"><span>🏆 LONGEST WORD</span><strong>${escape(longest.item.word)}</strong><b>${escape(longest.player.avatar || "🐈")} ${escape(longest.player.name)} · ${longestLength} letters · ${Number(longest.item.points || 0).toLocaleString()} pts</b></div>`
      : `<div class="longest-banner empty"><span>✨ NEXT ROUND</span><strong>No words yet</strong><b>A fresh board is waiting.</b></div>`;
    const suddenDeathBanner = result.suddenDeath
      ? "<div class=\"sudden-death-banner" + (replaySuddenDeath ? "" : " no-replay") + "\"><strong>💥 SUDDEN DEATH!</strong><span>" +
        escape(suddenDeathOutcome.formatSuddenDeathOutcome(result.suddenDeath)) + "</span></div>"
      : "";
    const playerCards = ranking.map((player, index) => {
      const words = player.words || [];
      const wordChips = words.length
        ? words.map((item) => `<div class="tv-word length-${wordLengthClass(item.word)}"><b>${escape(item.word)}</b><span>${Number(item.points || 0).toLocaleString()} pts</span></div>`).join("")
        : `<p class="no-words">No words this round</p>`;
      const density = words.length > 18 ? " ultra-dense" : words.length > 10 ? " dense" : "";
      const sessionRecord = player.session
        ? `<span class="tv-session-record">${Number(player.session.wins || 0)}W · ${Number(player.session.losses || 0)}L · ${Number(player.session.points || 0).toLocaleString()} SESSION PTS</span>`
        : "";
      const outcomeBadge = suddenDeathOutcome.badgeForPlayer(suddenDeath, player);
      const cardClass = "final-player-card rank-" + Math.min(index + 1, 4) +
        (outcomeBadge ? " sudden-death-result-card" : "");
      const rankBadge = outcomeBadge || (["👑", "🥈", "🥉"][index] || index + 1);
      return `<article class="${cardClass}"><header><span class="final-rank"${outcomeBadge ? ` data-outcome="${outcomeBadge.toLowerCase()}"` : ""}>${rankBadge}</span><div><strong>${escape(player.avatar || "🐈")} ${escape(player.name)}</strong><small>${words.length} word${words.length === 1 ? "" : "s"}</small>${sessionRecord}</div><b class="final-score">${Number(player.score || 0).toLocaleString()}</b></header><div class="tv-word-list${density}">${wordChips}</div></article>`;
    }).join("");
    eyebrow.textContent = "FINAL RESULTS";
    screen.className = "screen finished results-party";
    screen.innerHTML = `<div class="finish-title"><p class="kicker">ROUND COMPLETE!</p><h1>${headline}</h1></div>${longestBanner}${suddenDeathBanner}<div class="final-player-grid players-${Math.min(ranking.length, 4)}">${playerCards}</div><div class="word-color-key"><span class="length-short">3–4 letters</span><span class="length-medium">5–6 letters</span><span class="length-long">7+ letters</span></div>`;
    connection.textContent = "Final scores · live room connection";
    renderedFinishedRoundId = result.roundId || null;
  };
  const render = (state) => {
    if (!state || state.status === "closed") {
      renderedFinishedRoundId = null;
      renderIdle("This room has closed. Cast another room when you are ready.");
      connection.textContent = "Room closed";
      return;
    }
    if (
      state.status === "playing" &&
      state.series?.phase === "interstitial"
    )
      return renderSeriesInterstitial(state);
    const players = state.series
      ? [...(state.series.participants || [])].sort((a, b) =>
          (Number(a.strikes) || 0) - (Number(b.strikes) || 0) ||
          (a.status === "withdrawn") - (b.status === "withdrawn"),
        )
      : [...(state.players || [])].sort((a, b) => b.score - a.score);
    if (state.status !== "finished") renderedFinishedRoundId = null;
    const cards = players.map((player) => state.series
      ? '<article class="score-card' +
        (player.status === "withdrawn" ? " is-withdrawn" : "") +
        '"><span class="name">' + escape(player.avatar || "🐈") + " " +
        escape(player.name) + '</span><strong class="score">' +
        (player.status === "withdrawn"
          ? "WITHDRAWN"
          : Number(player.strikes || 0) + " STRIKES") +
        "</strong></article>"
      : '<article class="score-card"><span class="name">' +
        escape(player.avatar || "🐈") + " " + escape(player.name) +
        '</span><strong class="score">' +
        Number(player.score || 0).toLocaleString() +
        "</strong></article>").join("");
    eyebrow.textContent = state.status === "playing" ? "LIVE SCOREBOARD" : state.status === "finished" ? "FINAL RESULTS" : "ROOM LOBBY";
    if (state.status === "finished") return renderFinished(state);
    if (state.status === "lobby") {
      const joinUrl = new URL("/", location.origin);
      joinUrl.searchParams.set("join", state.code);
      screen.className = "screen lobby";
      screen.innerHTML = `<p class="kicker">JOIN ROOM</p><div class="lobby-join"><img class="join-qr" src="/qr.svg?join=${encodeURIComponent(state.code)}" alt="QR code to join Wordrush room ${escape(state.code)}"><div class="lobby-details"><div class="room-code">${escape(state.code)}</div><p class="join-url">Scan to open Wordrush and join this room.</p><div class="scoreboard">${cards}</div></div></div>`;
    } else {
      screen.className = "screen playing";
      screen.innerHTML =
        "<p class=\"kicker\">" +
        escape(state.series
          ? "SUDDEN DEATH SERIES · ROUND " +
            state.series.currentRoundNumber + " OF " + state.series.totalRounds
          : state.config?.label || "WORDRUSH") +
        "</p><h1>" + escape(state.code) +
        "</h1><div class=\"scoreboard\">" + cards + "</div>";
    }
    connection.textContent = "Live room connection";
  };
  const notifySender = (message, senderId = "") => {
    try {
      const senders = castContext?.getSenders?.() || [];
      const recipients = senderId
        ? senders.filter((sender) => sender.id === senderId)
        : message.type === "display_reconnect_needed"
          ? senders.slice(0, 1)
          : senders;
      for (const sender of recipients)
        castContext.sendCustomMessage(NAMESPACE, sender.id, message);
    } catch {}
  };
  const socketIsActive = (candidate) =>
    candidate && (candidate.readyState === undefined || candidate.readyState <= 1);
  const stopKeepalive = () => {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };
  const startKeepalive = (displaySocket) => {
    stopKeepalive();
    const interval = window.wordrushDisplayKeepaliveMs ?? 30_000;
    keepaliveTimer = setInterval(() => {
      if (socket !== displaySocket) return;
      try {
        displaySocket.send(JSON.stringify({ type: "display_keepalive" }));
      } catch {}
    }, interval);
  };
  const connectDisplay = (token, resume = false, roomCode = "") => {
    if (typeof token !== "string" || !token) return;
    const normalizedRoomCode = String(roomCode || "").trim().toUpperCase();
    if (
      !resume &&
      normalizedRoomCode &&
      normalizedRoomCode === targetRoomCode &&
      socketIsActive(socket)
    ) {
      // Phone wakeups and multiple origin-scoped sender tabs can deliver the
      // same room again. Never replace a live display for an idempotent handoff.
      if (activeRoomCode === normalizedRoomCode)
        notifySender({ type: "display_status", status: "connected" });
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopKeepalive();
    if (!resume) {
      reconnectToken = "";
      reconnectAttempts = 0;
      targetRoomCode = normalizedRoomCode;
    }
    const previousSocket = socket;
    let reconnectRequested = false;
    connection.textContent = resume ? "Reconnecting to room…" : "Connecting to room…";
    const displaySocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/display`);
    socket = displaySocket;
    previousSocket?.close();
    displaySocket.addEventListener("open", () =>
      displaySocket.send(JSON.stringify({
        type: resume ? "display_resume" : "display_hello",
        token,
      })),
    );
    displaySocket.addEventListener("message", ({ data }) => {
      if (socket !== displaySocket) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === "display_state") {
        if (message.reconnectToken) reconnectToken = message.reconnectToken;
        activeRoomCode = String(message.state?.code || targetRoomCode);
        targetRoomCode = activeRoomCode;
        saveReconnectCredential();
        reconnectAttempts = 0;
        startKeepalive(displaySocket);
        notifySender({ type: "display_status", status: "connected" });
        return render(message.state);
      }
      if (message.type === "display_keepalive_ack") {
        notifySender({ type: "display_status", status: "connected" });
        return;
      }
      if (message.type === "session_closed") {
        reconnectToken = "";
        activeRoomCode = "";
        targetRoomCode = "";
        clearReconnectCredential();
        stopKeepalive();
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        render({ status: "closed" });
        connection.textContent = "Room closed";
        return;
      }
      if (message.type === "error") {
        reconnectToken = "";
        clearReconnectCredential();
        renderIdle("This room connection was not authorized. Cast the room again from your phone.");
        connection.textContent = "Authorization required";
        reconnectRequested = true;
        notifySender({ type: "display_reconnect_needed", code: message.code });
        displaySocket.close();
      }
    });
    displaySocket.addEventListener("close", () => {
      if (socket !== displaySocket) return;
      socket = null;
      stopKeepalive();
      notifySender({ type: "display_status", status: "reconnecting" });
      if (!reconnectToken) {
        if (!reconnectRequested) notifySender({ type: "display_reconnect_needed" });
        return;
      }
      connection.textContent = "Room connection interrupted — reconnecting…";
      const delay = window.wordrushDisplayReconnectDelayMs ??
        Math.min(1000 * 2 ** reconnectAttempts, 10_000);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(
        () => connectDisplay(reconnectToken, true, targetRoomCode),
        delay,
      );
    });
  };
  const startCastReceiver = () => {
    if (!window.cast?.framework) {
      connection.textContent = "Receiver preview — awaiting Cast runtime";
      return;
    }
    castContext = cast.framework.CastReceiverContext.getInstance();
    castContext.addCustomMessageListener(NAMESPACE, (event) => {
      if (event.data?.type === "display_token")
        connectDisplay(event.data.token, false, event.data.roomCode);
      if (event.data?.type === "display_probe") {
        const requestedRoom = String(event.data.roomCode || "").trim().toUpperCase();
        const healthy = socketIsActive(socket) && reconnectToken &&
          (!requestedRoom || requestedRoom === activeRoomCode);
        notifySender(
          healthy
            ? { type: "display_status", status: "connected" }
            : { type: "display_reconnect_needed" },
          event.senderId,
        );
      }
    });
    const senderConnected = cast.framework.system?.EventType?.SENDER_CONNECTED;
    if (senderConnected)
      castContext.addEventListener?.(senderConnected, (event) => {
        if (!socketIsActive(socket))
          notifySender({ type: "display_reconnect_needed" }, event.senderId);
      });
    castContext.start({
      statusText: "Wordrush TV is ready",
      // Wordrush is a non-media receiver. CAF otherwise treats the app as idle
      // and shuts it down even while its room WebSocket is healthy.
      disableIdleTimeout: true,
      skipPlayersLoad: true,
    });
    const saved = savedReconnectCredential();
    if (saved) connectDisplay(saved.token, true, saved.roomCode);
    else
      setTimeout(() => {
        if (!socketIsActive(socket))
          notifySender({ type: "display_reconnect_needed" });
      }, window.wordrushReceiverHandoffDelayMs ?? 1_000);
    connection.textContent = "Waiting for room context from your phone";
  };
  renderIdle();
  startCastReceiver();
})();
