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

  const escape = (value) =>
    String(value ?? "").replace(/[&<>'"]/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
    );
  const renderIdle = (message = "Choose Wordrush from your phone to show the room here.") => {
    eyebrow.textContent = "TV COMPANION";
    screen.className = "screen idle";
    screen.innerHTML = `<p class="kicker">READY TO PLAY</p><h1>Cast a room<br>to get started.</h1><p class="message">${escape(message)}</p>`;
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
    if (state.status === "lobby") {
      const joinUrl = new URL("/", location.origin);
      joinUrl.searchParams.set("join", state.code);
      screen.className = "screen lobby";
      screen.innerHTML = `<p class="kicker">JOIN ROOM</p><div class="lobby-join"><img class="join-qr" src="/qr.svg?join=${encodeURIComponent(state.code)}" alt="QR code to join Wordrush room ${escape(state.code)}"><div class="lobby-details"><div class="room-code">${escape(state.code)}</div><p class="join-url">Scan to open Wordrush and join this room.</p><div class="scoreboard">${cards}</div></div></div>`;
    } else if (state.status === "finished") {
      screen.className = "screen finished";
      screen.innerHTML = `<p class="kicker">ROUND COMPLETE</p><h1>${escape(state.lastResult?.reason === "timeout" ? "Time's up." : "Results are in.")}</h1><div class="scoreboard">${cards}</div>`;
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
  const connectDisplay = (token, resume = false) => {
    if (typeof token !== "string" || !token) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
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
        return render(message.state);
      }
      if (message.type === "session_closed") {
        reconnectToken = "";
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
