(() => {
  const targets = [...document.querySelectorAll("[data-site-footer]")];
  if (!targets.length) return;

  fetch("/site-footer.html")
    .then((response) => {
      if (!response.ok) throw new Error("site footer request failed");
      return response.text();
    })
    .then((markup) => {
      const template = document.createElement("template");
      template.innerHTML = markup.trim();
      targets.forEach((target) => target.replaceWith(template.content.cloneNode(true)));
    })
    .catch(() => targets.forEach((target) => target.remove()));
})();
