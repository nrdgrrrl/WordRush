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
  const renderFinished = (state) => {
    const result = state.lastResult || {};
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
    const headline = result.cooperative
      ? "Team word power!"
      : leaders.length > 1
        ? `${leaders.map((player) => `${escape(player.avatar || "🐈")} ${escape(player.name)}`).join(" & ")} tie for the crown!`
      : winner
        ? `${escape(winner.avatar || "🐈")} ${escape(winner.name)} takes the crown!`
        : "What a word rush!";
    const longestBanner = longest
      ? `<div class="longest-banner"><span>🏆 LONGEST WORD</span><strong>${escape(longest.item.word)}</strong><b>${escape(longest.player.avatar || "🐈")} ${escape(longest.player.name)} · ${longestLength} letters · ${Number(longest.item.points || 0).toLocaleString()} pts</b></div>`
      : `<div class="longest-banner empty"><span>✨ NEXT ROUND</span><strong>No words yet</strong><b>A fresh board is waiting.</b></div>`;
    const playerCards = ranking.map((player, index) => {
      const words = player.words || [];
      const wordChips = words.length
        ? words.map((item) => `<div class="tv-word length-${wordLengthClass(item.word)}"><b>${escape(item.word)}</b><span>${Number(item.points || 0).toLocaleString()} pts</span></div>`).join("")
        : `<p class="no-words">No words this round</p>`;
      const density = words.length > 18 ? " ultra-dense" : words.length > 10 ? " dense" : "";
      const sessionRecord = player.session
        ? `<span class="tv-session-record">${Number(player.session.wins || 0)}W · ${Number(player.session.losses || 0)}L · ${Number(player.session.points || 0).toLocaleString()} SESSION PTS</span>`
        : "";
      return `<article class="final-player-card rank-${Math.min(index + 1, 4)}"><header><span class="final-rank">${["👑", "🥈", "🥉"][index] || index + 1}</span><div><strong>${escape(player.avatar || "🐈")} ${escape(player.name)}</strong><small>${words.length} word${words.length === 1 ? "" : "s"}</small>${sessionRecord}</div><b class="final-score">${Number(player.score || 0).toLocaleString()}</b></header><div class="tv-word-list${density}">${wordChips}</div></article>`;
    }).join("");
    eyebrow.textContent = "FINAL RESULTS";
    screen.className = "screen finished results-party";
    screen.innerHTML = `<div class="finish-title"><p class="kicker">ROUND COMPLETE!</p><h1>${headline}</h1></div>${longestBanner}<div class="final-player-grid players-${Math.min(ranking.length, 4)}">${playerCards}</div><div class="word-color-key"><span class="length-short">3–4 letters</span><span class="length-medium">5–6 letters</span><span class="length-long">7+ letters</span></div>`;
    connection.textContent = "Final scores · live room connection";
  };
  const render = (state) => {
    if (!state || state.status === "closed") {
      renderIdle("This room has closed. Cast another room when you are ready.");
      connection.textContent = "Room closed";
      return;
    }
    const players = [...(state.players || [])].sort((a, b) => b.score - a.score);
    const cards = players.map((player) => `<article class="score-card"><span class="name">${escape(player.avatar || "🐈")} ${escape(player.name)}</span><strong class="score">${Number(player.score || 0).toLocaleString()}</strong></article>`).join("");
    eyebrow.textContent = state.status === "playing" ? "LIVE SCOREBOARD" : state.status === "finished" ? "FINAL RESULTS" : "ROOM LOBBY";
    if (state.status === "finished") return renderFinished(state);
    if (state.status === "lobby") {
      const joinUrl = new URL("/", location.origin);
      joinUrl.searchParams.set("join", state.code);
      screen.className = "screen lobby";
      screen.innerHTML = `<p class="kicker">JOIN ROOM</p><div class="lobby-join"><img class="join-qr" src="/qr.svg?join=${encodeURIComponent(state.code)}" alt="QR code to join Wordrush room ${escape(state.code)}"><div class="lobby-details"><div class="room-code">${escape(state.code)}</div><p class="join-url">Scan to open Wordrush and join this room.</p><div class="scoreboard">${cards}</div></div></div>`;
    } else {
      screen.className = "screen playing";
      screen.innerHTML = `<p class="kicker">${escape(state.config?.label || "WORDRUSH")}</p><h1>${escape(state.code)}</h1><div class="scoreboard">${cards}</div>`;
    }
    connection.textContent = "Live room connection";
  };
  const notifySender = (message) => {
    try {
      const senders = castContext?.getSenders?.() || [];
      for (const sender of senders) castContext.sendCustomMessage(NAMESPACE, sender.id, message);
    } catch {}
  };
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
  const connectDisplay = (token, resume = false) => {
    if (typeof token !== "string" || !token) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopKeepalive();
    if (!resume) {
      reconnectToken = "";
      reconnectAttempts = 0;
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
        stopKeepalive();
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        render({ status: "closed" });
        connection.textContent = "Room closed";
        return;
      }
      if (message.type === "error") {
        reconnectToken = "";
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
        () => connectDisplay(reconnectToken, true),
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
      if (event.data?.type === "display_token") connectDisplay(event.data.token);
    });
    castContext.start({
      statusText: "Wordrush TV is ready",
      // Wordrush is a non-media receiver. CAF otherwise treats the app as idle
      // and shuts it down even while its room WebSocket is healthy.
      disableIdleTimeout: true,
    });
    connection.textContent = "Waiting for room context from your phone";
  };
  renderIdle();
  startCastReceiver();
})();
