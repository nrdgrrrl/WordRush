(() => {
  const socketUrl =
    (location.protocol === "https:"
      ? "wss://" + location.host
      : "ws://" + location.host) + "/ws";
  const guestId =
    localStorage.getItem("wordrush-guest-id") ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : "guest-" + Math.random().toString(36).slice(2));
  localStorage.setItem("wordrush-guest-id", guestId);
  window.wordrushGuestId = guestId;
  let socket,
    sessionCode = "",
    endedSessionCode = "",
    creator = false,
    creatorId = "",
    roomStatus = "";
  let reconnectTimer = null,
    reconnectAttempts = 0,
    intentionalLeave = false,
    pendingSession = Boolean(
      /^[A-Z]{5}$/.test(localStorage.getItem("wordrush-room") || "") &&
      localStorage.getItem("wordrush-room-token"),
    );
  let displayTokenRequest = null;
  const $ = (selector) => document.querySelector(selector);
  const goHome = () =>
    document.querySelector('[data-screen="homeScreen"]')?.click();
  const identity = () =>
    window.wordrushProfile
      ? window.wordrushProfile()
      : { name: "Guest", avatar: "🐈" };
  const toast = (message, tone = "default") => {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("toast-duplicate", "toast-wrong");
    if (tone !== "default") el.classList.add("toast-" + tone);
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.classList.remove("show", "toast-duplicate", "toast-wrong");
    }, 1800);
  };
  function clearSession(code = sessionCode) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (code) endedSessionCode = code;
    sessionCode = "";
    window.wordrushSessionCode = "";
    creator = false;
    creatorId = "";
    roomStatus = "";
    window.wordrushAbandonOnlineRound?.();
    pendingSession = false;
    localStorage.removeItem("wordrush-room");
    localStorage.removeItem("wordrush-room-token");
    $("#multiplayerBanner").hidden = true;
    $("#multiplayerBannerText").textContent = "No active session";
    $("#sessionLobby").hidden = true;
    $("#sessionChoices").hidden = false;
    $("#roomTitle").textContent = "No active session";
    $("#roomSubtitle").textContent = "Create or join a multiplayer session";
    $("#sessionPlayersText").textContent = "1 player connected";
    $("#livePlayers").replaceChildren();
    $("#lobbyPlayers").replaceChildren();
    $("#sessionHostControls").hidden = true;
    $("#sessionType").disabled = false;
    window.dispatchEvent(new CustomEvent("wordrush:room-change"));
  }
  function playerIdentity(player) {
    const fragment = document.createDocumentFragment();
    const avatar = document.createElement("span");
    avatar.className = "player-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = player.avatar || "🐈";
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name;
    fragment.append(avatar, name);
    return fragment;
  }
  function renderPlayers(players) {
    const list = players || [];
    const livePlayers = $("#livePlayers");
    livePlayers?.replaceChildren();
    list.filter((player) => player.id !== guestId).forEach((player) => {
      if (livePlayers) {
        const row = document.createElement("div");
        row.className = "live-player is-opponent";
        const score = document.createElement("b");
        score.textContent = Number(player.score || 0).toLocaleString();
        row.append(playerIdentity(player), score);
        livePlayers.append(row);
      }
    });
    const lobbyPlayers = $("#lobbyPlayers");
    lobbyPlayers?.replaceChildren();
    list.forEach((player) => {
      if (!lobbyPlayers) return;
      const row = document.createElement("div");
      row.className = "live-player";
      row.setAttribute("role", "listitem");
      if (player.id === creatorId) row.classList.add("is-host");
      row.append(playerIdentity(player));
      const badges = document.createElement("span");
      badges.className = "lobby-player-badges";
      if (player.id === guestId) {
        const you = document.createElement("span");
        you.className = "lobby-player-you";
        you.textContent = "You";
        badges.append(you);
      }
      if (player.id === creatorId) {
        const host = document.createElement("span");
        host.className = "lobby-player-role";
        host.textContent = "♛ Host";
        badges.append(host);
      }
      row.append(badges);
      lobbyPlayers.append(row);
    });
    if (sessionCode) {
      $("#multiplayerBanner").hidden = false;
      $("#multiplayerBannerText").textContent =
        (players || []).length +
        " player" +
        ((players || []).length === 1 ? "" : "s") +
        " in session";
      $("#roomTitle").textContent = "Multiplayer · " + sessionCode;
      $("#roomSubtitle").textContent =
        (players || []).length +
        " player" +
        ((players || []).length === 1 ? "" : "s") +
        " connected";
      $("#sessionPlayersText").textContent =
        (players || []).length +
        " player" +
        ((players || []).length === 1 ? "" : "s") +
        " connected";
    }
  }
  function updateLobbyControls() {
    creator = creatorId === guestId;
    $("#sessionHostControls").hidden = !creator;
    $("#sessionType").disabled = !creator;
    $("#lobbyStatus").textContent = roomStatus === "playing"
      ? "Round in progress — new players can scan this QR code and jump in!"
      : creator
        ? "You’re the host — pick a game and start when everybody’s ready!"
        : "Waiting for the host to start. Get your fingers ready!";
    $("#endGame").hidden = !creator;
    $("#resumeMultiplayer").hidden = roomStatus !== "playing";
  }
  function sessionDialog(open = true) {
    if (open) $("#multiplayerDialog").showModal();
    else $("#multiplayerDialog").close();
  }
  function showLobby(code, isCreator) {
    pendingSession = false;
    sessionCode = code;
    endedSessionCode = "";
    window.wordrushSessionCode = code;
    creator = isCreator;
    if (isCreator) creatorId = guestId;
    $("#multiplayerBanner").hidden = false;
    $("#sessionChoices").hidden = true;
    $("#sessionLobby").hidden = false;
    $("#sessionCode").textContent = code;
    $("#sessionQr").src = "/qr.svg?join=" + encodeURIComponent(code);
    $("#sessionQr").alt = "QR code to join Wordrush room " + code;
    updateLobbyControls();
    window.dispatchEvent(new CustomEvent("wordrush:room-change"));
    sessionDialog();
  }
  function sendWhenReady(payload) {
    const target = socket;
    const send = () => {
      if (target.readyState === WebSocket.OPEN)
        target.send(JSON.stringify(payload));
    };
    target.readyState === WebSocket.OPEN
      ? send()
      : target.addEventListener("open", send, { once: true });
  }
  function savedSession() {
    const code = localStorage.getItem("wordrush-room") || "";
    const reconnectToken = localStorage.getItem("wordrush-room-token") || "";
    return /^[A-Z]{5}$/.test(code) && reconnectToken
      ? { code, reconnectToken }
      : null;
  }
  function rememberSession(message) {
    pendingSession = false;
    localStorage.setItem("wordrush-room", message.code);
    localStorage.setItem("wordrush-room-token", message.reconnectToken);
  }
  function joinRoom(code) {
    const saved = savedSession();
    intentionalLeave = false;
    pendingSession = true;
    if (saved?.code === code) {
      connect(saved);
      return;
    }
    localStorage.removeItem("wordrush-room");
    localStorage.removeItem("wordrush-room-token");
    socket = connect();
    sendWhenReady({ type: "join_room", code, ...identity() });
  }
  function scheduleReconnect() {
    if (reconnectTimer || intentionalLeave) return;
    const saved = savedSession();
    if (!saved) {
      clearSession();
      return goHome();
    }
    pendingSession = true;
    const delay = window.wordrushReconnectDelayMs ??
      Math.min(500 * 2 ** reconnectAttempts, 10_000);
    reconnectAttempts += 1;
    $("#multiplayerBanner").hidden = false;
    $("#multiplayerBannerText").textContent = "Reconnecting to session…";
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(saved);
    }, delay);
  }
  function connect(resume = null) {
    if (socket && socket.readyState <= 1) return socket;
    const activeSocket = new WebSocket(socketUrl);
    socket = activeSocket;
    window.wordrushSocket = activeSocket;
    activeSocket.addEventListener("open", () => {
      activeSocket.send(JSON.stringify({ type: "hello", guestId, ...identity() }));
      if (resume)
        activeSocket.send(JSON.stringify({
          type: "resume_room",
          code: resume.code,
          reconnectToken: resume.reconnectToken,
          ...identity(),
        }));
    });
    activeSocket.addEventListener("message", (event) => {
      if (socket !== activeSocket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return toast("Received an invalid server message");
      }
      if (message.type === "session_closed") {
        intentionalLeave = false;
        clearSession(message.code);
        goHome();
        if ($("#multiplayerDialog").open) $("#multiplayerDialog").close();
        toast("Multiplayer session ended");
      }
      if (message.type === "session_left") {
        intentionalLeave = false;
        clearSession(message.code);
        goHome();
        if ($("#multiplayerDialog").open) $("#multiplayerDialog").close();
        toast("Left multiplayer session");
      }
      if (message.type === "room_created") {
        rememberSession(message);
        showLobby(message.code, true);
        toast("Session " + message.code + " created");
      }
      if (message.type === "joined_room") {
        rememberSession(message);
        showLobby(message.code, false);
        toast("Joined session " + message.code);
      }
      if (message.type === "room_resumed") {
        reconnectAttempts = 0;
        rememberSession(message);
        if (!sessionCode) showLobby(message.code, false);
        toast("Session reconnected");
      }
      if (message.type === "room_state" && message.code !== endedSessionCode) {
        roomStatus = message.status;
        creatorId = message.creatorId;
        updateLobbyControls();
        renderPlayers(message.players);
        if (message.code && !sessionCode)
          showLobby(message.code, message.creatorId === guestId);
        if (message.round && message.status === "playing") {
          window.wordrushOnlineRound?.(
            message.round,
            message.config || {
              label: message.mode.toUpperCase(),
              rule: "Multiplayer round",
            },
            message.mode,
          );
          sessionDialog(false);
        }
        if (message.status === "finished" && message.results)
          window.wordrushResultsSettings?.(message.results);
        if (message.status === "finished" && message.lastResult?.ranking) {
          sessionDialog(false);
          window.wordrushOnlineFinish?.(
            message.lastResult.ranking,
            message.lastResult,
          );
        }
      }
      if (message.type === "round_started") {
        roomStatus = "playing";
        creatorId = message.creatorId || creatorId;
        updateLobbyControls();
        renderPlayers(message.players);
        window.wordrushOnlineRound?.(
          message.round,
          message.config,
          message.mode,
        );
        sessionDialog(false);
        toast("Round started · " + message.players.length + " players");
      }
      if (message.type === "round_start_now")
        window.wordrushRoundStartNow?.(message);
      if (message.type === "word_accepted") {
        if (message.playerId === guestId)
          window.wordrushRecordOnlineWord?.(message.word, message.points);
        renderPlayers(message.scores);
        const own = message.scores.find((score) => score.id === guestId);
        if (own && $("#gameScore")) $("#gameScore").textContent = own.score;
      }
      if (message.type === "word_rejected") {
        if (message.playerId === guestId)
          window.wordrushRecordOnlineIncorrect?.(message.reason);
        const rejection = {
          minimum: `Need at least ${message.minimum || 3} letters`,
          path: "Tiles must connect in order",
          duplicate: "Already found that word",
          chain: "Wrong word · follow the chain",
          dictionary: `${message.word || "That word"} is not in the Wordrush dictionary`,
        };
        toast(
          message.reason === "duplicate"
            ? "Already found — try a new word"
            : "Wrong word · " + (rejection[message.reason] || "not accepted"),
          message.reason === "duplicate" ? "duplicate" : "wrong",
        );
      }
      if (message.type === "display_token" && displayTokenRequest) {
        const request = displayTokenRequest;
        displayTokenRequest = null;
        clearTimeout(request.timer);
        request.resolve(message);
      }
      if (message.type === "round_finished") {
        roomStatus = "finished";
        sessionDialog(false);
        window.wordrushOnlineFinish?.(message.ranking, {
          roundId: message.roundId,
          gameSeconds: message.gameSeconds,
          cooperative: message.cooperative,
          teamScore: message.teamScore,
          stats: message.stats,
          reason: message.reason,
          suddenDeath: message.suddenDeath,
          results: message.results,
        });
        toast(message.cooperative ? "Team round complete" : "Round complete");
      }
      if (message.type === "results_settings")
        window.wordrushResultsSettings?.(message.results);
      if (message.type === "error" && message.code === "RESUME_FAILED") {
        intentionalLeave = false;
        clearSession(resume?.code);
        goHome();
        if ($("#multiplayerDialog").open) $("#multiplayerDialog").close();
        toast("That multiplayer session has ended");
        activeSocket.close(1000, "resume failed");
      }
      if (
        message.type === "error" &&
        !sessionCode &&
        ["ROOM_NOT_FOUND", "ROOM_FULL", "ALREADY_JOINED"].includes(message.code)
      )
        pendingSession = false;
      if (message.type === "error")
        if (displayTokenRequest) {
          const request = displayTokenRequest;
          displayTokenRequest = null;
          clearTimeout(request.timer);
          request.reject(new Error(message.code || "DISPLAY_TOKEN_FAILED"));
        }
      if (message.type === "error")
        toast(message.code.replaceAll("_", " ").toLowerCase());
    });
    activeSocket.addEventListener("close", () => {
      if (socket !== activeSocket) return;
      socket = null;
      window.wordrushSocket = null;
      if (displayTokenRequest) {
        const request = displayTokenRequest;
        displayTokenRequest = null;
        clearTimeout(request.timer);
        request.reject(new Error("DISPLAY_TOKEN_CONNECTION_LOST"));
      }
      if (intentionalLeave) {
        intentionalLeave = false;
        clearSession();
        return goHome();
      }
      scheduleReconnect();
    });
    return activeSocket;
  }
  window.wordrushIdentityChanged = () => {
    if (socket?.readyState === 1 && sessionCode)
      socket.send(JSON.stringify({ type: "update_identity", ...identity() }));
  };
  window.wordrushRequestDisplayToken = () => {
    if (!sessionCode || !socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("NO_ACTIVE_ROOM"));
    if (displayTokenRequest) return Promise.reject(new Error("DISPLAY_TOKEN_PENDING"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (displayTokenRequest?.timer !== timer) return;
        displayTokenRequest = null;
        reject(new Error("DISPLAY_TOKEN_TIMEOUT"));
      }, 10_000);
      displayTokenRequest = { resolve, reject, timer };
      socket.send(JSON.stringify({ type: "create_display_token" }));
    });
  };
  window.wordrushStartSessionGame = ({ mode, config, randomRush } = {}) => {
    if (!sessionCode && !pendingSession && !savedSession()) return false;
    if (!sessionCode || !socket || socket.readyState !== WebSocket.OPEN) {
      pendingSession = true;
      toast("Reconnecting to the multiplayer session");
      return true;
    }
    if (!creator) {
      toast("Only the session creator can start a game");
      return true;
    }
    if (roomStatus === "playing") {
      toast("The multiplayer round is already running");
      return true;
    }
    sendWhenReady({
      type: "start_game",
      mode: randomRush ? "random" : mode,
      config,
    });
    return true;
  };
  window.wordrushStartRoundNow = () => {
    if (!sessionCode || !socket || socket.readyState !== WebSocket.OPEN)
      return false;
    socket.send(JSON.stringify({ type: "start_round_now" }));
    return true;
  };
  $("#sessionManage")?.addEventListener("click", () => sessionDialog());
  $("#sessionCreate")?.addEventListener("click", () => {
    localStorage.removeItem("wordrush-room");
    localStorage.removeItem("wordrush-room-token");
    intentionalLeave = false;
    pendingSession = true;
    const ws = connect();
    sendWhenReady({ type: "create_room", ...identity() });
  });
  $("#sessionJoin")?.addEventListener("click", () => {
    const code = prompt("Enter the 5-letter session code")
      ?.trim()
      .toUpperCase();
    if (!/^[A-Z]{5}$/.test(code || "")) return toast("Enter a 5-letter code");
    joinRoom(code);
  });
  const joinFromLink = new URLSearchParams(location.search).get("join")
    ?.trim()
    .toUpperCase();
  if (joinFromLink) {
    history.replaceState({}, "", location.pathname + location.hash);
    if (/^[A-Z]{5}$/.test(joinFromLink)) {
      joinRoom(joinFromLink);
    } else toast("That room code is invalid");
  } else {
    const saved = savedSession();
    if (saved) connect(saved);
  }
  $("#multiplayerShare")?.addEventListener("click", () => {
    if (sessionCode) sessionDialog();
  });
  $("#resumeMultiplayer")?.addEventListener("click", () =>
    window.wordrushReturnToOnlineRound?.(),
  );
  $("#sessionShare")?.addEventListener("click", async () => {
    if (!sessionCode) return;
    const url = new URL("/", location.origin);
    url.searchParams.set("join", sessionCode);
    try {
      if (navigator.share)
        await navigator.share({
          title: "Join my Wordrush room",
          text: "Join Wordrush room " + sessionCode,
          url: url.href,
        });
      else {
        await navigator.clipboard.writeText(url.href);
        toast("Join link copied");
      }
    } catch (error) {
      if (error?.name !== "AbortError") toast("Could not share the join link");
    }
  });
  $("#sessionStart")?.addEventListener("click", () => {
    const mode = $("#sessionType").value;
    sendWhenReady({ type: "start_game", mode });
  });
  function requestLeave() {
    if (
      creator &&
      !confirm("Close this multiplayer session for everyone?")
    )
      return;
    leaveSession();
  }
  $("#sessionLeave")?.addEventListener("click", requestLeave);
  $("#exitMultiplayer")?.addEventListener("click", () => {
    if (!creator || confirm("Close this multiplayer session for everyone?"))
      leaveSession();
  });
  function leaveSession() {
    intentionalLeave = true;
    if (socket?.readyState === 1 && sessionCode)
      sendWhenReady({ type: "leave_session" });
    else {
      intentionalLeave = false;
      clearSession();
      goHome();
      sessionDialog(false);
    }
  }
})();
