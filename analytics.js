(() => {
  const STORAGE_KEY = "wordrush-analytics-consent";
  const queue = [];
  const state = {
    measurementId: "",
    enabled: false,
    ready: false,
    blocked: false,
    requireConsent: true,
    startedAt: performance.now(),
  };
  const cleanKey = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
  const cleanValue = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    return String(value ?? "").slice(0, 100);
  };
  const safeParams = (params = {}) =>
    Object.fromEntries(
      Object.entries(params)
        .map(([key, value]) => [cleanKey(key), cleanValue(value)])
        .filter(([key, value]) => key && value !== ""),
    );
  function send(name, params) {
    if (!state.ready || typeof window.gtag !== "function") return false;
    window.gtag("event", cleanKey(name), safeParams(params));
    return true;
  }
  function track(name, params = {}) {
    if (!name || state.blocked) return;
    const event = { name, params: safeParams(params) };
    if (send(event.name, event.params)) return;
    if (queue.length >= 100) queue.shift();
    queue.push(event);
  }
  function flush() {
    queue.splice(0).forEach((event) => send(event.name, event.params));
  }
  function activeScreen() {
    return document.querySelector(".screen.active")?.id || document.body.dataset.page || "unknown";
  }
  function consentChoice() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }
  function storeConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {}
  }
  function removeConsentPrompt() {
    const prompt = document.querySelector("#analyticsConsent");
    if (!prompt) return;
    if (typeof prompt.close === "function" && prompt.open) prompt.close();
    prompt.remove();
  }
  function recordConsentChoice(granted) {
    fetch("/api/analytics-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: granted ? "granted" : "denied" }),
      keepalive: true,
    }).catch(() => {});
  }
  function loadGoogleTag() {
    if (state.ready || !state.enabled) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("consent", "default", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    window.gtag("js", new Date());
    window.gtag("config", state.measurementId, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_flags: "SameSite=Lax;Secure",
    });
    const script = document.createElement("script");
    script.async = true;
    script.src =
      "https://www.googletagmanager.com/gtag/js?id=" +
      encodeURIComponent(state.measurementId);
    script.onerror = () => {
      state.ready = false;
      state.blocked = true;
      queue.length = 0;
    };
    document.head.append(script);
    state.ready = true;
    track("page_view", {
      page_title: document.title,
      page_location: location.pathname,
      initial_screen: activeScreen(),
    });
    flush();
  }
  function setConsent(granted) {
    recordConsentChoice(granted);
    storeConsent(granted ? "granted" : "denied");
    state.blocked = !granted;
    removeConsentPrompt();
    if (granted) {
      loadGoogleTag();
      track("analytics_consent_choice", { choice: "granted" });
    }
    else queue.length = 0;
  }
  function showConsentPrompt() {
    if (document.querySelector("#analyticsConsent")) return;
    const prompt = document.createElement("dialog");
    prompt.id = "analyticsConsent";
    prompt.className = "analytics-consent";
    prompt.setAttribute("aria-modal", "true");
    prompt.setAttribute("aria-labelledby", "analyticsConsentTitle");
    prompt.addEventListener("cancel", (event) => event.preventDefault());
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.target.closest("button")) {
        event.preventDefault();
        setConsent(true);
      }
    });
    const title = document.createElement("strong");
    title.id = "analyticsConsentTitle";
    title.textContent = "Help tune Wordrush";
    const copy = document.createElement("p");
    copy.textContent =
      "Help make Wordrush better by sharing anonymous gameplay and performance data. No names, room codes, or words are collected.";
    const actions = document.createElement("div");
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "primary";
    accept.textContent = "Allow analytics";
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "secondary";
    decline.textContent = "No thanks";
    accept.addEventListener("click", () => setConsent(true));
    decline.addEventListener("click", () => setConsent(false));
    actions.append(accept, decline);
    prompt.append(title, copy, actions);
    document.body.append(prompt);
    if (typeof prompt.showModal === "function") prompt.showModal();
    else prompt.setAttribute("open", "");
    accept.focus();
  }
  function addPreferencesButton() {
    const form = document.querySelector("#profileForm");
    if (!form || document.querySelector("#analyticsPreferences")) return;
    const button = document.createElement("button");
    button.id = "analyticsPreferences";
    button.type = "button";
    button.className = "secondary analytics-preferences";
    button.textContent = "Analytics preference";
    button.addEventListener("click", () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      location.reload();
    });
    form.querySelector(".dialog-save")?.before(button);
  }
  function initialize(config) {
    const measurementId = String(config?.measurementId || "").toUpperCase();
    if (!/^G-[A-Z0-9]{5,20}$/.test(measurementId)) {
      state.blocked = true;
      queue.length = 0;
      return;
    }
    state.measurementId = measurementId;
    state.enabled = true;
    addPreferencesButton();
    state.requireConsent = config.requireConsent !== false;
    const choice = consentChoice();
    if (choice === "denied") {
      state.blocked = true;
      queue.length = 0;
    } else if (!state.requireConsent || choice === "granted") loadGoogleTag();
    else showConsentPrompt();
  }

  window.wordrushAnalytics = {
    track,
    setConsent,
    status: () => ({
      enabled: state.enabled,
      ready: state.ready,
      consent: consentChoice() || "unset",
    }),
  };

  document.addEventListener("wordrush:screen-change", ({ detail }) =>
    track("screen_view", { screen_name: detail.id }),
  );
  document.addEventListener("wordrush:round-intro", ({ detail }) =>
    track("round_intro_view", detail),
  );
  document.addEventListener("wordrush:round-started", ({ detail }) =>
    track("game_round_start", detail),
  );
  document.addEventListener("wordrush:word-accepted", ({ detail }) =>
    track("word_accepted", {
      mode: detail.mode,
      word_length: String(detail.word || "").length,
      points: detail.points,
      multiplayer: detail.multiplayer,
      random_rush: detail.randomRush,
    }),
  );
  document.addEventListener("wordrush:word-rejected", ({ detail }) =>
    track("word_rejected", detail),
  );
  document.addEventListener("wordrush:round-complete", ({ detail }) => {
    const players = detail.ranking || [];
    const own = players.find((player) => player.id === window.wordrushGuestId) ||
      players[0] || {};
    track("game_round_complete", {
      mode: detail.mode || document.body.dataset.mode,
      multiplayer: detail.multiplayer,
      cooperative: detail.cooperative,
      random_rush: detail.randomRush,
      score: Number(own.score) || 0,
      words: own.words?.length || 0,
      player_count: players.length || 1,
      reason: detail.result?.reason || "complete",
      game_seconds: Math.round(Number(detail.result?.gameSeconds) || 0),
    });
  });
  document.addEventListener("wordrush:multiplayer", ({ detail }) =>
    track("multiplayer_action", detail),
  );
  document.addEventListener("wordrush:random-rush", ({ detail }) =>
    track("random_rush_action", detail),
  );
  document.addEventListener("wordrush:theme-change", ({ detail }) =>
    track("theme_change", detail),
  );
  document.addEventListener("wordrush:achievement-unlocked", ({ detail }) =>
    track("achievement_unlocked", { achievement_id: detail.id }),
  );
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button || button.closest("#analyticsConsent")) return;
    const action = button.id || button.dataset.screen || button.dataset.mode;
    if (!action) return;
    track("ui_action", {
      action,
      screen_name: activeScreen(),
      mode: button.dataset.mode,
      target_screen: button.dataset.screen,
    });
  }, true);
  window.addEventListener("error", (event) => {
    const source = String(event.filename || "").split("/").pop();
    track("javascript_error", {
      error_type: event.error?.name || "Error",
      source_file: source,
      line: event.lineno || 0,
      screen_name: activeScreen(),
    });
  });
  window.addEventListener("unhandledrejection", (event) =>
    track("promise_rejection", {
      error_type: event.reason?.name || "UnhandledPromiseRejection",
      screen_name: activeScreen(),
    }),
  );
  window.addEventListener("load", () => {
    setTimeout(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      if (!navigation) return;
      track("performance_load", {
        dns_ms: Math.round(navigation.domainLookupEnd - navigation.domainLookupStart),
        connect_ms: Math.round(navigation.connectEnd - navigation.connectStart),
        response_ms: Math.round(navigation.responseEnd - navigation.requestStart),
        dom_ready_ms: Math.round(navigation.domContentLoadedEventEnd),
        load_ms: Math.round(navigation.loadEventEnd),
      });
    }, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden")
      track("session_engagement", {
        engagement_seconds: Math.round((performance.now() - state.startedAt) / 1000),
        last_screen: activeScreen(),
      });
  });

  fetch("/api/analytics-config", { cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then(initialize)
    .catch(() => {
      state.blocked = true;
      queue.length = 0;
    });
})();
