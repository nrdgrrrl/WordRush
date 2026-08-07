(() => {
  try {
    const themePreference = localStorage.getItem("wordrush-theme");
    if (themePreference) document.documentElement.dataset.theme = themePreference;
  } catch {}
})();
