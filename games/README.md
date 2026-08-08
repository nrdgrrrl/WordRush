# Public game catalog

Each `games/<catalog-key>/manifest.json` owns one public game's identity and discovery facts: its canonical name, short discovery copy, public gameplay route, availability, and any existing mechanics key association.

`game-config.js` remains the authority for mechanics such as board size, timer, word length, score targets, special rules, adult dictionary behavior, and Party/Custom configuration. Internal keys need not equal product names, and stable public URLs are not renamed when a product name changes.

This is only a catalog boundary. It does not implement manifest-driven rules, a game interpreter, hot reload, plugins, or asset handling. Future expansion is possible without being implemented here.

To add a public game, add its manifest in a human-readable folder and update the focused catalog consistency tests. Folder names and manifest keys are stable lowercase kebab-case identifiers.
