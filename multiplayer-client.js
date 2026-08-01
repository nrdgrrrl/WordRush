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
    roomStatus = "",
    roomSeries = null;
  let reconnectTimer = null,
    reconnectAttempts = 0,
    intentionalLeave = false,
    pendingSession = Boolean(
      /^[A-Z]{5}$/.test(localStorage.getItem("wordrush-room") || "") &&
      localStorage.getItem("wordrush-room-token"),
    );
  let displayTokenRequest = null;
  let scannerStream = null;
  let scannerFrame = 0;
  let scannerRun = 0;
  let pendingConsentRequestId = "";
  let pendingChallengeId = "";
  let randomRushChoice = null;
  const $ = (selector) => document.querySelector(selector);
  const goHome = () =>
    document.querySelector('[data-screen="homeScreen"]')?.click();
  function clearConsentUi() {
    pendingConsentRequestId = "";
    pendingChallengeId = "";
    const consentPanel = $("#consentPanel");
    const prePanel = $("#preAdmissionPanel");
    const actions = $("#consentActions");
    const cancel = $("#consentCancel");
    const players = $("#consentPlayers");
    if (consentPanel) consentPanel.hidden = true;
    if (prePanel) prePanel.hidden = true;
    if (actions) actions.hidden = true;
    if (cancel) cancel.hidden = true;
    players?.replaceChildren();
  }
  function clearRandomRushChoice() {
    randomRushChoice = null;
    const dialog = $("#randomRushChoiceDialog");
    if (dialog?.open) dialog.close();
  }
  function openRandomRushChoice(dictionaryId = null) {
    const dialog = $("#randomRushChoiceDialog");
    if (!dialog || !creator || !sessionCode || !socket || socket.readyState !== WebSocket.OPEN)
      return false;
    if (randomRushChoice) return true;
    randomRushChoice = { dictionaryId };
    dialog.showModal();
    $("#randomRushKeepClean")?.focus();
    return true;
  }
  function submitRandomRushChoice(includeDirty) {
    const choice = randomRushChoice;
    if (!choice) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      clearRandomRushChoice();
      toast("The multiplayer session is reconnecting");
      return;
    }
    randomRushChoice = null;
    const dialog = $("#randomRushChoiceDialog");
    if (dialog?.open) dialog.close();
    trackMultiplayer("random_rush_eligibility", {
      include_dirty: includeDirty,
    });
    sendWhenReady({
      type: "start_game",
      mode: "random",
      randomRushIncludeDirty: includeDirty,
      ...(choice.dictionaryId ? { dictionaryId: choice.dictionaryId } : {}),
    });
  }
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
  const trackMultiplayer = (action, detail = {}) =>
    document.dispatchEvent(new CustomEvent("wordrush:multiplayer", {
      detail: { action, ...detail },
    }));
  function stopQrScanner(showChoices = true) {
    scannerRun += 1;
    if (scannerFrame) cancelAnimationFrame(scannerFrame);
    scannerFrame = 0;
    scannerStream?.getTracks().forEach((track) => track.stop());
    scannerStream = null;
    const video = $("#sessionScannerVideo");
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    const scanner = $("#sessionScanner");
    const choices = $("#sessionChoices");
    if (scanner) scanner.hidden = true;
    if (showChoices && choices) choices.hidden = false;
  }
  function roomCodeFromQrValue(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, location.origin);
      const linkedCode = url.searchParams.get("join")?.trim().toUpperCase();
      if (linkedCode && /^[A-Z]{5}$/.test(linkedCode)) return linkedCode;
    } catch {
      // The QR may contain a plain room code instead of a join URL.
    }
    const code = text.match(/\b[A-Z]{5}\b/i)?.[0]?.toUpperCase() || "";
    return /^[A-Z]{5}$/.test(code) ? code : "";
  }
  async function startQrScanner() {
    const scanner = $("#sessionScanner");
    const choices = $("#sessionChoices");
    const video = $("#sessionScannerVideo");
    const status = $("#sessionScannerStatus");
    if (!scanner || !choices || !video || !status) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.BarcodeDetector) {
      trackMultiplayer("qr_scan_unsupported");
      toast("QR scanning is not supported here — enter the room code instead");
      return;
    }
    stopQrScanner(false);
    scanner.hidden = false;
    choices.hidden = true;
    status.textContent = "Starting camera…";
    trackMultiplayer("qr_scan_start");
    const run = ++scannerRun;
    try {
      let detector;
      try {
        detector = new BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        detector = new BarcodeDetector();
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (run !== scannerRun) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      scannerStream = stream;
      video.srcObject = scannerStream;
      await video.play();
      status.textContent = "Point your camera at the room QR code";
      const scan = async () => {
        if (run !== scannerRun || !scannerStream) return;
        try {
          const results = await detector.detect(video);
          const code = roomCodeFromQrValue(results[0]?.rawValue);
          if (code) {
            trackMultiplayer("qr_scan_success");
            stopQrScanner(false);
            joinRoom(code);
            return;
          }
        } catch {
          status.textContent = "Keep the QR code inside the frame…";
        }
        scannerFrame = requestAnimationFrame(scan);
      };
      scannerFrame = requestAnimationFrame(scan);
    } catch (error) {
      trackMultiplayer("qr_scan_failed", {
        reason: error?.name === "NotAllowedError" ? "permission" : "camera",
      });
      stopQrScanner(true);
      toast(
        error?.name === "NotAllowedError"
          ? "Allow camera access to scan a room QR code"
          : "Could not start the QR scanner — enter the room code instead",
      );
    }
  }
  function clearSession(code = sessionCode) {
    stopQrScanner(false);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (code) endedSessionCode = code;
    sessionCode = "";
    window.wordrushSessionCode = "";
    delete window.wordrushCanSetResultsSettings;
    creator = false;
    creatorId = "";
    roomStatus = "";
    roomSeries = null;
    window.wordrushSessionCreator = false;
    window.wordrushAbandonOnlineRound?.();
    pendingSession = false;
    clearRandomRushChoice();
    localStorage.removeItem("wordrush-room");
    localStorage.removeItem("wordrush-room-token");
    clearConsentUi();
    $("#multiplayerBanner").hidden = true;
    $("#multiplayerBannerText").textContent = "No active session";
    $("#sessionLobby").hidden = true;
    $("#sessionChoices").hidden = false;
    $("#roomTitle").textContent = "No active session";
    $("#roomSubtitle").textContent = "Create or join a multiplayer session";
    $("#sessionPlayersText").textContent = "1 player connected";
    $("#livePlayers").replaceChildren();
    $("#seriesLiveStandings").replaceChildren();
    $("#seriesLiveStandings").hidden = true;
    $("#lobbyPlayers").replaceChildren();
    $("#sessionHostControls").hidden = true;
    $("#sessionType").disabled = false;
    $("#endGame").hidden = false;
    $("#endGame").textContent = "End round";
    $("#endGame").setAttribute("aria-label", "End round");
    $("#gameBack").setAttribute("aria-label", "Back to home");
    $("#exitMultiplayer").hidden = true;
    $("#exitMultiplayer").textContent = "Leave party";
    $("#exitMultiplayer").setAttribute("aria-label", "Leave party");
    $("#sessionLeave").hidden = true;
    $("#sessionLeave").textContent = "Leave party";
    $("#exitParty").hidden = true;
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
  function renderPlayers(players, series = roomSeries) {
    const list = players || [];
    const seriesLive = $("#seriesLiveStandings");
    if (seriesLive) {
      seriesLive.hidden = !series;
      seriesLive.replaceChildren(
        ...(series?.participants || []).map((participant) => {
          const row = document.createElement("span");
          row.className = participant.status === "withdrawn"
            ? "is-withdrawn"
            : participant.id === guestId
              ? "is-you"
              : "";
          row.textContent = (participant.avatar || "🐈") + " " +
            participant.name + " · " +
            (participant.status === "withdrawn"
              ? "withdrawn"
              : (Number(participant.strikes) || 0) + " strike" +
                (Number(participant.strikes) === 1 ? "" : "s"));
          return row;
        }),
      );
    }
    const livePlayers = $("#livePlayers");
    livePlayers?.replaceChildren();
    list.filter((player) => player.id !== guestId).forEach((player) => {
      if (livePlayers) {
        const row = document.createElement("div");
        row.className = "live-player is-opponent";
        const score = document.createElement("b");
        score.textContent = series
          ? (Number(player.strikes ?? player.series?.strikes) || 0) + " strikes"
          : Number(player.score || 0).toLocaleString();
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
      row.dataset.playerId = player.id;
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
      const seriesParticipant = series?.participants?.find((item) => item.id === player.id);
      if (seriesParticipant) {
        const seriesBadge = document.createElement("span");
        seriesBadge.className = "lobby-player-role series-player-status";
        seriesBadge.textContent = seriesParticipant.status === "withdrawn"
          ? "Withdrawn"
          : (Number(seriesParticipant.strikes) || 0) + " strike" +
            (Number(seriesParticipant.strikes) === 1 ? "" : "s");
        badges.append(seriesBadge);
        if (seriesParticipant.status === "withdrawn") row.classList.add("is-withdrawn");
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
    window.wordrushSessionCreator = creator;
    $("#sessionHostControls").hidden = !creator;
    $("#sessionType").disabled = !creator;
    $("#lobbyStatus").textContent = roomStatus === "playing" && roomSeries?.phase === "interstitial"
      ? "Sudden Death Series transition — the roster is frozen."
      : roomStatus === "playing"
      ? roomSeries
        ? "Sudden Death Series in progress — the roster is frozen."
        : "Round in progress — new players can scan this QR code and jump in!"
      : creator
        ? "You’re the host — pick a game and start when everybody’s ready!"
        : "Waiting for the host to start. Get your fingers ready!";
    const inSession = Boolean(sessionCode);
    const playing = roomStatus === "playing";
    $("#endGame").hidden = inSession
      ? !creator || !playing
      : false;
    $("#endGame").textContent = inSession ? "Skip round" : "End round";
    $("#endGame").setAttribute(
      "aria-label",
      inSession ? "Skip round" : "End round",
    );
    $("#gameBack").setAttribute(
      "aria-label",
      inSession
        ? "Back to home; you remain in the party"
        : "Back to home",
    );
    $("#exitMultiplayer").hidden = !inSession;
    $("#exitMultiplayer").textContent = creator ? "End session" : "Leave party";
    $("#exitMultiplayer").setAttribute(
      "aria-label",
      creator ? "End session" : "Leave party",
    );
    $("#sessionLeave").hidden = !inSession || Boolean(pendingChallengeId);
    $("#sessionLeave").textContent = creator ? "End session" : "Leave party";
    $("#resumeMultiplayer").hidden = roomStatus !== "playing";
  }
  function sessionDialog(open = true) {
    const dialog = $("#multiplayerDialog");
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    }
    else {
      stopQrScanner(false);
      if (dialog.open) dialog.close();
    }
  }
  function showLobbyView() {
    stopQrScanner(false);
    $("#sessionChoices").hidden = true;
    $("#sessionScanner").hidden = true;
    $("#sessionLobby").hidden = false;
    sessionDialog();
  }
  function showLobby(code, isCreator) {
    pendingSession = false;
    sessionCode = code;
    endedSessionCode = "";
    window.wordrushSessionCode = code;
    creator = isCreator;
    if (isCreator) creatorId = guestId;
    $("#multiplayerBanner").hidden = false;
    showLobbyView();
    $("#sessionCode").textContent = code;
    $("#sessionQr").src = "/qr.svg?join=" + encodeURIComponent(code);
    $("#sessionQr").alt = "QR code to join Wordrush room " + code;
    updateLobbyControls();
    window.dispatchEvent(new CustomEvent("wordrush:room-change"));
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
        trackMultiplayer("session_closed");
        intentionalLeave = false;
        clearSession(message.code);
        goHome();
        if ($("#multiplayerDialog").open) $("#multiplayerDialog").close();
        toast("Multiplayer session ended");
      }
      if (message.type === "session_left") {
        trackMultiplayer("session_left");
        intentionalLeave = false;
        clearSession(message.code);
        goHome();
        if ($("#multiplayerDialog").open) $("#multiplayerDialog").close();
        toast("Left multiplayer session");
      }
      if (message.type === "room_created") {
        trackMultiplayer("room_created");
        rememberSession(message);
        showLobby(message.code, true);
        toast("Session " + message.code + " created");
      }
      if (message.type === "joined_room") {
        trackMultiplayer("room_joined");
        rememberSession(message);
        showLobby(message.code, false);
        toast("Joined session " + message.code);
      }
      if (message.type === "room_resumed") {
        trackMultiplayer("room_resumed");
        reconnectAttempts = 0;
        rememberSession(message);
        clearConsentUi();
        if (!sessionCode) showLobby(message.code, false);
        toast("Session reconnected");
      }
      if (message.type === "adult_consent_request") {
        pendingConsentRequestId = message.requestId;
        showLobbyView();
        const consentPanel = $("#consentPanel");
        const prePanel = $("#preAdmissionPanel");
        const actions = $("#consentActions");
        if (consentPanel) consentPanel.hidden = false;
        if (prePanel) prePanel.hidden = true;
        if (actions) actions.hidden = false;
        const modeLabel = message.mode === "dirty" ? "Dirty Mode" : "Adult Custom";
        $("#consentMode").textContent = modeLabel;
        $("#consentDescription").textContent =
          message.mode === "dirty"
            ? "This round contains adult language. Everyone in the room must accept before it starts."
            : "This custom round contains adult language. Everyone in the room must accept before it starts.";
        $("#consentConfig").textContent =
          message.config.size + "×" + message.config.size +
          " · min " + message.config.min +
          " · " + formatTimer(message.config.seconds);
        renderConsentPlayers(message.requiredPlayerIds, message.acceptedPlayerIds);
        if (creator) $("#consentCancel").hidden = false;
        else $("#consentCancel").hidden = true;
        toast("Adult content requires your consent");
      }
      if (message.type === "adult_consent_player_accepted") {
        if (pendingConsentRequestId === message.requestId) {
          showLobbyView();
          renderConsentPlayers(message.requiredPlayerIds, message.acceptedPlayerIds);
        }
      }
      if (message.type === "adult_consent_cancelled") {
        clearConsentUi();
        const reasonLabels = {
          host_cancelled: "The host cancelled the adult round",
          timeout: "Adult consent request timed out",
          player_declined: "A player declined the adult round",
          player_disconnected: "A player disconnected — adult consent cancelled",
          player_left: "A player left — adult consent cancelled",
          configuration_changed: "The host changed the game mode",
          room_closed: "The room was closed",
        };
        toast(reasonLabels[message.reason] || "Adult consent cancelled");
        updateLobbyControls();
      }
      if (message.type === "adult_consent_declined") {
        clearConsentUi();
        toast("A player declined the adult round");
        updateLobbyControls();
      }
      if (message.type === "adult_pre_admission_challenge") {
        pendingConsentRequestId = "";
        pendingChallengeId = message.challengeId;
        showLobbyView();
        $("#endGame").hidden = true;
        $("#sessionLeave").hidden = true;
        const prePanel = $("#preAdmissionPanel");
        const consentPanel = $("#consentPanel");
        const actions = $("#consentActions");
        if (prePanel) prePanel.hidden = false;
        if (consentPanel) consentPanel.hidden = true;
        if (actions) actions.hidden = false;
        $("#consentCancel").hidden = true;
        const modeLabel = message.mode === "dirty" ? "Dirty Mode" : "Adult Custom";
        $("#preAdmissionMode").textContent = modeLabel;
        $("#preAdmissionDescription").textContent =
          "This room has adult content. You must accept to join.";
        $("#preAdmissionConfig").textContent =
          (message.config.size || "?") + "×" + (message.config.size || "?") +
          " · min " + (message.config.min || "?") +
          " · " + formatTimer(message.config.seconds || 0);
      }
      if (message.type === "adult_pre_admission_accepted") {
        pendingChallengeId = "";
        const prePanel = $("#preAdmissionPanel");
        const actions = $("#consentActions");
        if (prePanel) prePanel.hidden = true;
        if (actions) actions.hidden = true;
        rememberSession(message);
        toast("Join accepted — entering room");
      }
      if (message.type === "adult_pre_admission_declined") {
        pendingChallengeId = "";
        const prePanel = $("#preAdmissionPanel");
        const actions = $("#consentActions");
        if (prePanel) prePanel.hidden = true;
        if (actions) actions.hidden = true;
        toast("You declined to join the adult room");
      }
      if (message.type === "adult_pre_admission_timeout") {
        if (pendingChallengeId === message.challengeId) {
          pendingChallengeId = "";
          const prePanel = $("#preAdmissionPanel");
          const actions = $("#consentActions");
          if (prePanel) prePanel.hidden = true;
          if (actions) actions.hidden = true;
          toast("Join request timed out");
        }
      }
      if (message.type === "room_state" && message.code !== endedSessionCode) {
        roomStatus = message.status;
        roomSeries = message.series || null;
        creatorId = message.creatorId;
        window.wordrushSessionCreator = creatorId === guestId;
        const restoredResult =
          message.status === "finished" && message.lastResult?.ranking
            ? message.lastResult
            : null;
        if (restoredResult) {
          const accepted = window.wordrushOnlineFinish?.(
            restoredResult.ranking,
            restoredResult,
            {
              authoritativeSnapshot: true,
              roomMetadata: {
                mode: message.mode,
                config: message.config,
                round: message.round,
              },
            },
          );
          if (accepted === false) return;
        }
        window.wordrushCanSetResultsSettings = creatorId === guestId;
        updateLobbyControls();
        renderPlayers(message.players, roomSeries);
        if (message.code && !sessionCode)
          showLobby(message.code, message.creatorId === guestId);
        else
          window.dispatchEvent(new CustomEvent("wordrush:room-change"));
        if (message.round && message.status === "playing") {
          const cfg = message.config ||
            (window.WordrushConfig?.configForPreset?.(message.mode)) || {
              label: message.mode.toUpperCase(),
              min: 3,
              size: message.round.size,
              seconds: Math.max(1, Math.ceil((message.round.endsAt - Date.now()) / 1000)),
              rule: "Multiplayer round",
              target: null,
              sudden: false,
              chain: false,
              adult: false,
              party: false,
            };
          window.wordrushOnlineRound?.(
            message.round,
            cfg,
            message.mode,
            message.randomRush,
            message.dictionary,
            message.chain,
            message.series,
          );
          sessionDialog(false);
        }
        if (
          message.status === "playing" &&
          roomSeries?.phase === "interstitial" &&
          !message.round
        ) {
          window.wordrushSeriesState?.(roomSeries);
          sessionDialog(false);
        }
        if (message.status === "finished" && message.results)
          window.wordrushResultsSettings?.(message.results);
        if (restoredResult) sessionDialog(false);
      }
      if (message.type === "round_started") {
        trackMultiplayer("round_started", {
          mode: message.mode,
          player_count: message.players.length,
          random_rush: message.randomRush,
        });
        clearConsentUi();
        roomStatus = "playing";
        creatorId = message.creatorId || creatorId;
        updateLobbyControls();
        roomSeries = message.series || null;
        renderPlayers(message.players, roomSeries);
        window.wordrushOnlineRound?.(
          message.round,
          message.config,
          message.mode,
          message.randomRush,
          message.dictionary,
          message.chain,
          message.series,
        );
        sessionDialog(false);
        toast("Round started · " + message.players.length + " players");
      }
      if (message.type === "round_start_now")
        window.wordrushRoundStartNow?.(message);
      if (message.type === "series_round_finished") {
        roomStatus = "playing";
        roomSeries = message.series || roomSeries;
        renderPlayers(message.series?.participants || message.players, roomSeries);
        window.wordrushSeriesRoundFinished?.(message);
        sessionDialog(false);
      }
      if (message.type === "series_participant_withdrawn") {
        roomSeries = message.series || roomSeries;
        renderPlayers(message.series?.participants || [], roomSeries);
        updateLobbyControls();
      }
      if (message.type === "series_cancelled") {
        roomSeries = null;
        roomStatus = "lobby";
        window.wordrushSeriesCancelled?.(message);
        updateLobbyControls();
        showLobbyView();
        toast("Sudden Death Series cancelled");
      }
      if (message.type === "word_accepted") {
        if (message.playerId === guestId)
          window.wordrushRecordOnlineWord?.(message.word, message.points, message.chain);
        else
          window.wordrushUpdateOnlineChain?.(message.chain, true);
        renderPlayers(message.scores, roomSeries);
        const own = message.scores.find((score) => score.id === guestId);
        if (own && $("#gameScore")) $("#gameScore").textContent = own.score;
      }
      if (message.type === "word_rejected") {
        if (message.playerId === guestId)
          window.wordrushRecordOnlineIncorrect?.(
            message.reason,
            message.word,
            message.chain,
          );
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
        roomSeries = message.series || null;
        const accepted = window.wordrushOnlineFinish?.(message.ranking, {
          roundId: message.roundId,
          gameSeconds: message.gameSeconds,
          cooperative: message.cooperative,
          randomRush: message.randomRush,
          teamScore: message.teamScore,
          stats: message.stats,
          reason: message.reason,
          recorded: message.recorded,
          suddenDeath: message.suddenDeath,
          results: message.results,
          dictionary: message.dictionary,
          nextRound: message.nextRound,
          series: message.series,
          seriesComplete: message.seriesComplete,
          accountingId: message.accountingId,
          resultId: message.resultId,
        });
        if (accepted === false) return;
        roomStatus = "finished";
        updateLobbyControls();
        sessionDialog(false);
        toast(
          message.reason === "skipped"
            ? "Round skipped"
            : message.cooperative
              ? "Team round complete"
              : "Round complete",
        );
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
      if (message.type === "error") {
        trackMultiplayer("error", { error_code: message.code });
        toast(message.code.replaceAll("_", " ").toLowerCase());
      }
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
      clearRandomRushChoice();
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
  window.wordrushStartSessionGame = ({ mode, config, randomRush, dictionaryId } = {}) => {
    const isRandomRush = Boolean(randomRush || mode === "random");
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
    if (isRandomRush) {
      openRandomRushChoice(dictionaryId);
      return true;
    }
    sendWhenReady({
      type: "start_game",
      mode,
      config,
      ...(dictionaryId ? { dictionaryId } : {}),
    });
    return true;
  };
  window.wordrushStartRoundNow = () => {
    if (!sessionCode || !socket || socket.readyState !== WebSocket.OPEN)
      return false;
    socket.send(JSON.stringify({ type: "start_round_now" }));
    return true;
  };
  window.wordrushStartNextRound = ({ sourceRoundId } = {}) => {
    if (!sessionCode || !socket || socket.readyState !== WebSocket.OPEN)
      return false;
    if (!creator) {
      toast("Only the session creator can start the next round");
      return true;
    }
    socket.send(JSON.stringify({ type: "start_next_round", sourceRoundId }));
    return true;
  };
  $("#sessionManage")?.addEventListener("click", () => sessionDialog());
  $("#sessionCreate")?.addEventListener("click", () => {
    trackMultiplayer("create_requested");
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
    trackMultiplayer("code_join_requested");
    joinRoom(code);
  });
  $("#sessionJoinScan")?.addEventListener("click", startQrScanner);
  $("#sessionScannerCancel")?.addEventListener("click", () =>
    stopQrScanner(true),
  );
  const joinFromLink = new URLSearchParams(location.search).get("join")
    ?.trim()
    .toUpperCase();
  if (joinFromLink) {
    history.replaceState({}, "", location.pathname + location.hash);
    if (/^[A-Z]{5}$/.test(joinFromLink)) {
      trackMultiplayer("link_join_requested");
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
    trackMultiplayer("start_requested", { mode });
    window.wordrushStartSessionGame({ mode, randomRush: mode === "random" });
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
    trackMultiplayer("leave_requested", { creator });
    intentionalLeave = true;
    if (socket?.readyState === 1 && sessionCode)
      sendWhenReady({ type: creator ? "end_session" : "leave_session" });
    else {
      intentionalLeave = false;
      clearSession();
      goHome();
      sessionDialog(false);
    }
  }
  function formatTimer(seconds) {
    const safe = Math.max(0, Math.ceil(Number(seconds) || 0));
    return (
      String(Math.floor(safe / 60)).padStart(2, "0") +
      ":" +
      String(safe % 60).padStart(2, "0")
    );
  }
  $("#randomRushKeepClean")?.addEventListener("click", () =>
    submitRandomRushChoice(false),
  );
  $("#randomRushIncludeDirty")?.addEventListener("click", () =>
    submitRandomRushChoice(true),
  );
  $("#randomRushChoiceDialog")?.addEventListener("close", () => {
    randomRushChoice = null;
  });
  function renderConsentPlayers(requiredIds, acceptedIds) {
    const target = $("#consentPlayers");
    if (!target) return;
    target.replaceChildren();
    const allPlayers = [...document.querySelectorAll("#lobbyPlayers .live-player")];
    requiredIds.forEach((id) => {
      const row = document.createElement("div");
      row.className = "live-player consent-player";
      const statusEl = document.createElement("span");
      statusEl.className = "consent-status";
      if (acceptedIds.includes(id)) {
        statusEl.textContent = "✓ Accepted";
        statusEl.style.color = "#2e7d32";
      } else {
        statusEl.textContent = "⋯ Deciding";
        statusEl.style.color = "#b8860b";
      }
      const nameSpan = document.createElement("span");
      nameSpan.className = "player-name";
      if (id === guestId) nameSpan.textContent = "You";
      else {
        const player = allPlayers.find((p) =>
          p.querySelector(".player-name")?.textContent === id ||
          p.dataset?.playerId === id
        );
        nameSpan.textContent = player
          ? player.querySelector(".player-name")?.textContent || id
          : id;
      }
      row.append(statusEl, nameSpan);
      target.append(row);
    });
  }
  $("#consentAccept")?.addEventListener("click", () => {
    if (pendingChallengeId) {
      sendWhenReady({ type: "adult_consent_response", challengeId: pendingChallengeId, accepted: true });
    } else if (pendingConsentRequestId) {
      sendWhenReady({ type: "adult_consent_response", requestId: pendingConsentRequestId, accepted: true });
    }
  });
  $("#consentDecline")?.addEventListener("click", () => {
    if (pendingChallengeId) {
      sendWhenReady({ type: "adult_consent_response", challengeId: pendingChallengeId, accepted: false });
      pendingChallengeId = "";
      $("#preAdmissionPanel").hidden = true;
    } else if (pendingConsentRequestId) {
      sendWhenReady({ type: "adult_consent_response", requestId: pendingConsentRequestId, accepted: false });
    }
  });
  $("#consentCancel")?.addEventListener("click", () => {
    if (pendingConsentRequestId) {
      sendWhenReady({ type: "adult_consent_cancel", requestId: pendingConsentRequestId });
      pendingConsentRequestId = "";
      $("#consentPanel").hidden = true;
    }
  });
  const originalUpdateLobbyControls = updateLobbyControls;
  updateLobbyControls = function () {
    originalUpdateLobbyControls();
    const pending = Boolean(pendingConsentRequestId);
    if (creator) {
      $("#sessionType").disabled = pending;
      $("#sessionStart").disabled = pending;
    }
  };
})();
