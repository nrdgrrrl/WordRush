(() => {
  const extraAvatars = (window.wordrushAvatarOptions || []).slice(6);
  const avatarPicker = document.querySelector("#avatarPicker");
  if (avatarPicker)
    extraAvatars.forEach((avatar) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.avatar = avatar;
      button.textContent = avatar;
      avatarPicker.append(button);
    });

  const openings = [
    "You found",
    "You somehow found",
    "You bravely located",
    "You pedantically discovered",
    "You accidentally summoned",
    "You insisted on finding",
    "You made the dictionary nervous about",
  ];
  const nouns = [
    "a tiny word",
    "a suspiciously useful word",
    "a word with too many vowels",
    "a word nobody asked for",
    "a word shaped like a spreadsheet",
    "a word that sounds made-up",
    "a word your cat would reject",
  ];
  const endings = [
    "and nobody can stop you.",
    "Please try to act surprised.",
    "The tiles are filing a complaint.",
    "Your English teacher has questions.",
    "This is technically progress.",
    "Somewhere, a lexicographer sighed.",
    "The cat remains unimpressed.",
  ];
  const achievements = [
    {
      id: "first",
      title: "First blood",
      detail: "Find your first word in a round",
      test: (p) => p.words >= 1,
    },
    {
      id: "long",
      title: "Long haul",
      detail: "Find a word with 10+ letters",
      test: (p) => p.longest >= 10,
    },
    {
      id: "speed",
      title: "Speed demon",
      detail: "Find 20 words in one minute",
      test: (p) => Boolean(p.speedAchievement),
    },
    {
      id: "grid",
      title: "Grid master",
      detail: "Win a round on an 8×8 grid",
      test: (p) => p.maxGridWin >= 8,
    },
  ];
  for (let i = 1; i <= 200; i++) {
    const kind = i % 4;
    const threshold =
      kind === 0
        ? i * 3
        : kind === 1
          ? i * 40
          : kind === 2
            ? Math.ceil(i / 4)
            : Math.ceil(i / 8);
    const test =
      kind === 0
        ? (p) => p.words >= threshold
        : kind === 1
          ? (p) => p.score >= threshold
          : kind === 2
            ? (p) => p.rounds >= threshold
            : (p) => p.streak >= threshold;
    achievements.push({
      id: "odd-" + i,
      title:
        openings[i % openings.length] + " " + nouns[(i * 3) % nouns.length],
      detail: endings[(i * 5) % endings.length],
      test,
    });
  }

  function readProfile() {
    try {
      return JSON.parse(localStorage.getItem("wordrush-profile") || "{}");
    } catch {
      return {};
    }
  }
  function dismissToast() {
    const el = document.querySelector("#toast");
    if (!el) return;
    clearTimeout(toast.timer);
    toast.queue = [];
    el.classList.remove("show");
  }
  function showNextToast() {
    const el = document.querySelector("#toast");
    const message = toast.queue.shift();
    if (!el || !message) return;
    el.textContent = "✦ " + message;
    el.classList.add("show");
    toast.timer = setTimeout(() => {
      el.classList.remove("show");
      if (toast.queue.length) setTimeout(showNextToast, 250);
    }, 4000);
  }
  function toast(message) {
    toast.queue ||= [];
    toast.queue.push(message);
    if (!document.querySelector("#toast.show")) showNextToast();
  }
  let renderedUnlocks = null;
  function render(profile, announce = false) {
    profile.unlocked = Array.isArray(profile.unlocked) ? profile.unlocked : [];
    const newly = [];
    achievements.forEach((item) => {
      if (!profile.unlocked.includes(item.id) && item.test(profile)) {
        profile.unlocked.push(item.id);
        newly.push(item);
      }
    });
    localStorage.setItem("wordrush-profile", JSON.stringify(profile));
    const list = document.querySelector(".achievement-list");
    const unlockSignature = profile.unlocked.join("|");
    if (list && unlockSignature !== renderedUnlocks) {
      list.innerHTML = achievements
        .map(
          (item) =>
            '<article data-achievement="' +
            item.id +
            '"><span>✦</span><div><b>' +
            item.title +
            "</b><small>" +
            item.detail +
            "</small></div><em>" +
            (profile.unlocked.includes(item.id) ? "UNLOCKED" : "LOCKED") +
            "</em></article>",
        )
        .join("");
      renderedUnlocks = unlockSignature;
    }
    const count = profile.unlocked.length;
    const counter = document.querySelector("#achievementCount");
    if (counter) counter.textContent = count + " / " + achievements.length;
    const bar = document.querySelector("#achievementBar");
    if (bar)
      bar.style.background =
        "linear-gradient(90deg,var(--coral) " +
        (count / achievements.length) * 100 +
        "%,#e1dfd8 " +
        (count / achievements.length) * 100 +
        "%)";
    if (announce && !document.querySelector("#resultsScreen.active"))
      newly.forEach((item) => toast(item.title + " — " + item.detail));
  }
  render(readProfile());
  window.wordrushAchievementEvent = (profile = readProfile()) =>
    render(profile, true);
  window.wordrushAchievementCatalog = achievements;
  document.addEventListener("wordrush:round-complete", dismissToast);
})();
