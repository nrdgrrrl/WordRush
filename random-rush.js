(() => {
  const choices = [
    {
      mode: "classic",
      title: "Classic free play · 4×4 grid",
      sub: "2 minutes · free play",
    },
    {
      mode: "minimum",
      title: "Minimum 5 · 6×6 grid",
      sub: "3 minutes · long words only",
    },
    {
      mode: "sudden",
      title: "Sudden death · 5×5 grid",
      sub: "3 minutes · one miss ends it",
    },
    {
      mode: "race",
      title: "Race to 500 · 4×4 grid",
      sub: "4 minutes · first to 500 wins",
    },
    {
      mode: "blitz",
      title: "Blitz · 4×4 grid",
      sub: "60 seconds · lightning words",
    },
    {
      mode: "longhaul",
      title: "Long Haul · 6×6 grid",
      sub: "3 minutes · minimum 6 letters",
    },
    {
      mode: "storm",
      title: "Letter Storm · 8×8 grid",
      sub: "2 minutes · hunt everywhere",
    },
    {
      mode: "scoreattack",
      title: "Score Attack · 5×5 grid",
      sub: "150 seconds · first to 250",
    },
    {
      mode: "chain",
      title: "Word Chain · 5×5 grid",
      sub: "3 minutes · follow the last letter",
    },
  ];
  let selected = choices[0];
  const panel = document.querySelector("#randomPanel");
  const rerollButton = document.querySelector("#reroll");
  if (!panel || !rerollButton || typeof window.start !== "function") return;
  const render = () => {
    document.querySelector("#randomPreview").textContent = selected.title;
    document.querySelector("#randomPreviewSub").textContent = selected.sub;
  };
  const reroll = (event) => {
    event.stopPropagation();
    const available = choices.filter((choice) => choice.mode !== selected.mode);
    selected = available[Math.floor(Math.random() * available.length)];
    render();
  };
  const launch = (event) => {
    if (event.target.closest("#reroll")) return;
    event.preventDefault();
    window.start(selected.mode, null, false, true);
  };
  render();
  rerollButton.onclick = reroll;
  panel.onpointerup = launch;
  panel.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") launch(event);
  };
})();
