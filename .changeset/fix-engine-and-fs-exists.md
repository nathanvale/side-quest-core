---
'@side-quest/core': patch
---

fix: remove incorrect Node.js engine declaration and replace Bun-only fs/promises exists import

- Replace `"node": ">=22.20"` engine with `"bun": ">=1.2"` since the package uses Bun-specific APIs throughout (Bun.file, Bun.write, Bun.hash, etc.)
- Replace `import { exists } from 'node:fs/promises'` in config.ts with a stat-based alternative, since `exists` is a Bun-only API not available in Node.js

Closes #29, closes #31
