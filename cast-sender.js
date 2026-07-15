(() => {
  const NAMESPACE = "urn:x-cast:com.nrdgrrrl.wordrush";
  const button = document.querySelector("#castButton");
  const control = document.querySelector("#castControl");
  const status = document.querySelector("#castStatus");
  const secureOrigin = window.isSecureContext && location.protocol === "https:";
  let context = null;
  let initialized = false;
  let sharing = false;
  let receiverMessageSession = null;

  if (!button || !control || !status) return;

  const setStatus = (message, enabled = false) => {
    status.textContent = message;
    button.disabled = !enabled;
  };
  const hasRoom = () => Boolean(window.wordrushSessionCode);
  const updateAvailability = () => {
    control.hidden = !hasRoom();
    if (!hasRoom()) return;
    if (!secureOrigin) return setStatus("Casting is available on secure Wordrush only");
    if (!initialized) return setStatus("Cast is unavailable in this browser");
    setStatus("Ready to cast this room", true);
  };
  const shareRoom = async () => {
    if (sharing || !hasRoom() || !context) return;
    const session = context.getCurrentSession();
    if (!session) return;
    sharing = true;
    setStatus("Connecting this room…");
    try {
      const { token } = await window.wordrushRequestDisplayToken();
      await session.sendMessage(NAMESPACE, { type: "display_token", token });
      setStatus("Casting this room", true);
    } catch (error) {
      setStatus("Could not connect the TV. Your game is unchanged.", true);
      console.warn("Wordrush Cast room handoff failed", error);
    } finally {
      sharing = false;
    }
  };
  const listenForReceiverMessages = (session) => {
    if (!session || session === receiverMessageSession) return;
    receiverMessageSession = session;
    session.addMessageListener(NAMESPACE, (_namespace, message) => {
      if (message?.type !== "display_reconnect_needed" || !hasRoom()) return;
      shareRoom();
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
          if (
            state === cast.framework.SessionState.SESSION_STARTED ||
            state === cast.framework.SessionState.SESSION_RESUMED
          ) {
            listenForReceiverMessages(context.getCurrentSession());
            shareRoom();
          } else if (state === cast.framework.SessionState.SESSION_ENDED) {
            receiverMessageSession = null;
            updateAvailability();
          }
        },
      );
      initialized = true;
      updateAvailability();
    } catch (error) {
      setStatus("Cast is unavailable in this browser");
      console.warn("Wordrush Cast initialization failed", error);
    }
  };

  window.__onGCastApiAvailable = (available) => {
    if (available) initialize();
    else setStatus("Cast is unavailable in this browser");
  };
  button.addEventListener("click", async () => {
    if (!hasRoom() || !context) return;
    try {
      setStatus("Choose a TV…");
      await context.requestSession();
      listenForReceiverMessages(context.getCurrentSession());
      await shareRoom();
    } catch (error) {
      setStatus("Cast cancelled or unavailable. Your game is unchanged.", true);
      console.warn("Wordrush Cast session request failed", error);
    }
  });
  window.addEventListener("wordrush:room-change", updateAvailability);
  updateAvailability();
  if (secureOrigin) {
    const sdk = document.createElement("script");
    sdk.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    sdk.async = true;
    document.head.append(sdk);
  }
})();
