const test = require("node:test");
const assert = require("node:assert/strict");
const avatars = require("../avatar-presentation");

function fakeElement(tagName, ownerDocument) {
  return {
    tagName: tagName.toUpperCase(),
    ownerDocument,
    children: [],
    dataset: {},
    handlers: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute() {},
    textContent: "",
  };
}

function fakeDocument() {
  const document = {
    createElement(tagName) { return fakeElement(tagName, document); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
  };
  return document;
}

test("describes approved social photos and preserves emoji avatars", () => {
  assert.deepEqual(
    avatars.describe("https://lh3.googleusercontent.com/avatar"),
    { kind: "photo", value: "https://lh3.googleusercontent.com/avatar" },
  );
  assert.deepEqual(avatars.describe("🐿️"), { kind: "emoji", value: "🐿️" });
  assert.deepEqual(avatars.describe("🦊"), { kind: "emoji", value: "🦊" });
  assert.deepEqual(avatars.describe("https://images.example/avatar"), { kind: "emoji", value: "🐈" });
});

test("renders photo markup as an image, never visible URL text, with safe attributes", () => {
  const markup = avatars.markup('https://lh3.googleusercontent.com/avatar?name="&mode=large');
  assert.match(markup, /class="avatar-photo"/);
  assert.match(markup, /data-avatar-fallback="🐈"/);
  assert.match(markup, /src="https:\/\/lh3\.googleusercontent\.com\/avatar\?name=&quot;&amp;mode=large"/);
  assert.doesNotMatch(markup, />https:\/\/lh3\.googleusercontent\.com/);
  assert.match(avatars.markup("🐈"), /avatar-emoji.*🐈/);
});

test("falls back to the default emoji when a photo fails to load", () => {
  const document = fakeDocument();
  const target = fakeElement("span", document);
  assert.equal(avatars.render(target, "https://lh3.googleusercontent.com/avatar"), true);
  assert.equal(target.children[0].tagName, "IMG");

  target.children[0].handlers.error();
  assert.equal(target.textContent, "🐈");

  const name = fakeElement("strong", document);
  assert.equal(avatars.appendInline(name, "🦊", "Fox"), true);
  assert.equal(name.children[0].textContent, "🦊");
});
