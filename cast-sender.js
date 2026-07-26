(() => {
  const NAMESPACE = "urn:x-cast:com.nrdgrrrl.wordrush";
  const trackCast = (action, detail = {}) =>
    window.wordrushAnalytics?.track("cast_action", { action, ...detail });
  const button = document.querySelector("#castButton");
  const gameButton = document.querySelector("#gameCastButton");
  const buttons = [...document.querySelectorAll("[data-cast-action]")];
  const control = document.querySelector("#castControl");
  const status = document.querySelector("#castStatus");
  const secureOrigin = window.isSecureContext && location.protocol === "https:";
  let context = null;
  let initialized = false;
  let sharing = false;
  let receiverMessageSession = null;
  let receiverHealthy = false;
  let receiverHealthTimer = null;
  let receiverProbeTimer = null;
  let activeRoomCode = "";

  if (!button || !control || !status) return;

  const setStatus = (message, enabled = false) => {
    status.textContent = message;
    buttons.forEach((castButton) => {
      castButton.disabled = !enabled;
      castButton.title = message;
    });
  };
  const hasRoom = () => Boolean(window.wordrushSessionCode);
  const updateAvailability = () => {
    const nextRoomCode = window.wordrushSessionCode || "";
    if (nextRoomCode !== activeRoomCode) {
      activeRoomCode = nextRoomCode;
      receiverHealthy = false;
      clearTimeout(receiverHealthTimer);
      receiverHealthTimer = null;
      clearTimeout(receiverProbeTimer);
      receiverProbeTimer = null;
      if (gameButton) gameButton.textContent = "📺 Cast to TV";
    }
    control.hidden = !hasRoom();
    if (gameButton)
      gameButton.hidden = !hasRoom() || !secureOrigin || !initialized;
    if (!hasRoom()) return;
    if (!secureOrigin) return setStatus("Casting is available on secure Wordrush only");
    if (!initialized) return setStatus("Cast is unavailable in this browser");
    if (!receiverHealthy) setStatus("Ready to cast this room", true);
  };
  const markReceiverHealth = (healthy) => {
    trackCast(healthy ? "receiver_healthy" : "receiver_unhealthy");
    receiverHealthy = healthy;
    clearTimeout(receiverHealthTimer);
    receiverHealthTimer = null;
    clearTimeout(receiverProbeTimer);
    receiverProbeTimer = null;
    if (healthy) {
      setStatus("TV is live with this room", true);
      if (gameButton) gameButton.textContent = "📺 Refresh TV";
      receiverHealthTimer = setTimeout(() => {
        receiverHealthy = false;
        setStatus("TV stopped responding — tap Re-cast", true);
        if (gameButton) gameButton.textContent = "📺 Re-cast TV";
      }, window.wordrushCastHealthTimeoutMs ?? 75_000);
    } else {
      setStatus("TV connection dropped — tap Re-cast", true);
      if (gameButton) gameButton.textContent = "📺 Re-cast TV";
    }
  };
  const shareRoom = async () => {
    if (sharing || !hasRoom() || !context) return;
    const session = context.getCurrentSession();
    if (!session) return;
    sharing = true;
    setStatus("Connecting this room…");
    try {
      const { token } = await window.wordrushRequestDisplayToken();
      await session.sendMessage(NAMESPACE, {
        type: "display_token",
        token,
        roomCode: window.wordrushSessionCode,
      });
      trackCast("room_handoff_sent");
      setStatus("Waiting for the TV to confirm…", true);
    } catch (error) {
      trackCast("room_handoff_failed", { error_type: error?.name || "Error" });
      setStatus("Could not connect the TV. Your game is unchanged.", true);
      console.warn("Wordrush Cast room handoff failed", error);
    } finally {
      sharing = false;
    }
  };
  const probeRoom = async () => {
    if (!hasRoom() || !context) return;
    const session = context.getCurrentSession();
    if (!session) return;
    clearTimeout(receiverProbeTimer);
    setStatus("Checking the TV connection…", true);
    try {
      await session.sendMessage(NAMESPACE, {
        type: "display_probe",
        roomCode: window.wordrushSessionCode,
      });
      receiverProbeTimer = setTimeout(() => {
        receiverProbeTimer = null;
        if (!receiverHealthy) shareRoom();
      }, window.wordrushCastProbeTimeoutMs ?? 5_000);
    } catch {
      await shareRoom();
    }
  };
  const listenForReceiverMessages = (session) => {
    if (!session || session === receiverMessageSession) return;
    receiverMessageSession = session;
    session.addMessageListener(NAMESPACE, (_namespace, message) => {
      if (message?.type === "display_status") {
        markReceiverHealth(message.status === "connected");
        return;
      }
      if (message?.type === "display_reconnect_needed" && hasRoom()) {
        markReceiverHealth(false);
        shareRoom();
      }
    });
  };
  const initialize = async () => {
    try {
      const response = await fetch("/api/cast-config", { cache: "no-store" });
      const { applicationId } = response.ok ? await response.json() : {};
      if (!applicationId) return setStatus("Cast is not configured yet");
      context = cast.framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: applicationId,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      context.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (event) => {
          const state = event.sessionState;
          if (state === cast.framework.SessionState.SESSION_STARTED) {
            listenForReceiverMessages(context.getCurrentSession());
            shareRoom();
          } else if (state === cast.framework.SessionState.SESSION_RESUMED) {
            listenForReceiverMessages(context.getCurrentSession());
            receiverHealthy = false;
            probeRoom();
          } else if (state === cast.framework.SessionState.SESSION_ENDED) {
            receiverMessageSession = null;
            receiverHealthy = false;
            clearTimeout(receiverHealthTimer);
            clearTimeout(receiverProbeTimer);
            receiverProbeTimer = null;
            if (gameButton) gameButton.textContent = "📺 Cast to TV";
            updateAvailability();
          }
        },
      );
      initialized = true;
      trackCast("initialized");
      updateAvailability();
    } catch (error) {
      trackCast("initialization_failed", { error_type: error?.name || "Error" });
      setStatus("Cast is unavailable in this browser");
      console.warn("Wordrush Cast initialization failed", error);
    }
  };

  window.__onGCastApiAvailable = (available) => {
    if (available) initialize();
    else setStatus("Cast is unavailable in this browser");
  };
  const requestOrRefreshCast = async () => {
    if (!hasRoom() || !context) return;
    try {
      if (context.getCurrentSession()) {
        listenForReceiverMessages(context.getCurrentSession());
        await shareRoom();
        return;
      }
      setStatus("Choose a TV…");
      await context.requestSession();
      trackCast("session_requested");
      listenForReceiverMessages(context.getCurrentSession());
      await shareRoom();
    } catch (error) {
      trackCast("session_request_failed", { error_type: error?.name || "Error" });
      setStatus("Cast cancelled or unavailable. Your game is unchanged.", true);
      console.warn("Wordrush Cast session request failed", error);
    }
  };
  buttons.forEach((castButton) =>
    castButton.addEventListener("click", requestOrRefreshCast));
  window.addEventListener("wordrush:room-change", updateAvailability);
  updateAvailability();
  if (secureOrigin) {
    const sdk = document.createElement("script");
    sdk.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    sdk.async = true;
    document.head.append(sdk);
  }
})();
