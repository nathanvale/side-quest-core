---
'@side-quest/core': minor
---

Add publishable API catalog artifacts and subpath exports

- `dist/catalog.json` - structured JSON catalog of all 25 modules, 395+ declarations with signatures, descriptions, and export names
- `dist/catalog.js` + `dist/catalog.d.ts` - typed JS wrapper for Bun/Node ESM consumption via `@side-quest/core/catalog`
- `dist/llms.txt` - llms.txt community standard file for LLM ecosystem tooling
- `@side-quest/core/catalog` subpath export (typed, runtime-safe for both Bun and Node)
- `@side-quest/core/catalog.json` subpath export (direct JSON access)
- Catalog generation now filters to package.json-declared module exports only, preventing accidental dist/src noise
