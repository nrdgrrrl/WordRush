(function exposeWordrushAvatarPresentation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WordrushAvatarPresentation = api;
})(globalThis, () => {
  const emojiAvatars = new Set([
    "🐈", "🦊", "🐼", "🐸", "🦄", "🐙", "🐯", "🦁", "🐨", "🐵",
    "🙈", "🐔", "🐧", "🐦", "🦉", "🐝", "🦋", "🐌", "🐞", "🐢",
    "🐍", "🦎", "🐳", "🐬", "🦈", "🐊", "🦀", "🐿️", "🦔", "🦥",
    "🦦", "🦙", "🦘", "🦚", "🐲",
  ]);
  const photoHosts = [
    "googleusercontent.com",
    "facebook.com",
    "fbcdn.net",
    "fbsbx.com",
  ];

  function isPhotoUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && photoHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      );
    } catch {
      return false;
    }
  }

  function describe(value, fallback = "🐈") {
    if (isPhotoUrl(value)) return { kind: "photo", value: String(value) };
    if (emojiAvatars.has(value)) return { kind: "emoji", value: String(value) };
    return {
      kind: "emoji",
      value: emojiAvatars.has(fallback) ? fallback : "🐈",
    };
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
    );
  }

  function markup(value, fallback = "🐈") {
    const avatar = describe(value, fallback);
    if (avatar.kind === "photo")
      return `<img class="avatar-photo" src="${escapeHtml(avatar.value)}" alt="" data-avatar-fallback="${escapeHtml(fallback)}">`;
    return `<span class="avatar-emoji" aria-hidden="true">${escapeHtml(avatar.value)}</span>`;
  }

  function render(target, value, fallback = "🐈") {
    if (!target) return false;
    const avatar = describe(value, fallback);
    target.replaceChildren();
    if (avatar.kind === "photo") {
      const image = target.ownerDocument.createElement("img");
      image.className = "avatar-photo";
      image.src = avatar.value;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.dataset.avatarFallback = fallback;
      image.addEventListener("error", () => render(target, fallback, fallback), { once: true });
      target.append(image);
    } else {
      target.textContent = avatar.value;
    }
    return true;
  }

  function appendInline(target, value, text, fallback = "🐈") {
    if (!target) return false;
    const avatar = target.ownerDocument.createElement("span");
    avatar.className = "avatar-inline";
    avatar.setAttribute("aria-hidden", "true");
    render(avatar, value, fallback);
    target.append(avatar, target.ownerDocument.createTextNode(" " + String(text ?? "")));
    return true;
  }

  function isSupported(value) {
    return emojiAvatars.has(value) || isPhotoUrl(value);
  }

  return Object.freeze({
    appendInline,
    describe,
    isPhotoUrl,
    isSupported,
    markup,
    render,
  });
});
