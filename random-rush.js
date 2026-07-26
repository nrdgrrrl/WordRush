(() => {
  const config = window.WordrushConfig || {};
  const modeConfig = config.MODE_CONFIG || {};
  const formatDuration = (seconds) => {
    if (seconds % 60 === 0) return seconds / 60 + " minute" + (seconds === 60 ? "" : "s");
    return seconds + " seconds";
  };
  const titleCase = (label) =>
    String(label || "")
      .toLowerCase()
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const choices = (config.RANDOM_RUSH_MODES || [])
    .map((mode) => {
      const modeDetails = modeConfig[mode];
      if (!modeDetails) return null;
      const rule = String(modeDetails.rule || "");
      const sub = /\b(seconds?|minutes?)\b/i.test(rule)
        ? rule
        : formatDuration(modeDetails.seconds) + " · " + rule;
      return {
        mode,
        title: titleCase(modeDetails.label) + " · " + modeDetails.size + "×" + modeDetails.size + " grid",
        sub,
      };
    })
    .filter(Boolean);
  window.wordrushRandomRushChoices = choices.map((choice) => choice.mode);
  let selected = choices[0];
  const panel = document.querySelector("#randomPanel");
  const rerollButton = document.querySelector("#reroll");
  if (!choices.length || !panel || !rerollButton || typeof window.start !== "function") return;
  const render = () => {
    document.querySelector("#randomPreview").textContent = selected.title;
    document.querySelector("#randomPreviewSub").textContent = selected.sub;
  };
  const reroll = (event) => {
    event.stopPropagation();
    const available = choices.filter((choice) => choice.mode !== selected.mode);
    selected = available[Math.floor(Math.random() * available.length)];
    window.wordrushAnalytics?.track("random_rush_action", {
      action: "reroll",
      selected_mode: selected.mode,
    });
    render();
  };
  const launch = (event) => {
    if (event.target.closest("#reroll")) return;
    event.preventDefault();
    window.wordrushAnalytics?.track("random_rush_action", {
      action: "start",
      selected_mode: selected.mode,
    });
    window.start(selected.mode, null, false, true);
  };
  render();
  rerollButton.onclick = reroll;
  panel.onpointerup = launch;
  panel.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") launch(event);
  };
})();
