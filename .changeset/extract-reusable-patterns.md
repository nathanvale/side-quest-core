---
"@side-quest/core": minor
---

Add reusable validation, spawn, and fs utilities extracted from voice-memo plugin

- `isSafeFilename` / `validateFilename` - whitelist-based filename validation with optional extension matching
- `validateAbsoluteFilePath` - defense-in-depth absolute path validation (shell metachar rejection, existence, extension)
- `SHELL_METACHARACTERS_STRICT` - broader metacharacter pattern blocking parens and quotes
- `isToolAvailable` / `ensureToolAvailable` - async tool detection with actionable install hints
- `loadJsonStateSync` / `saveJsonStateSync` / `updateJsonFileAtomic` - Zod-validated JSON state management with atomic writes and file locking
- `isSymlinkSync` / `isEmptyFileSync` - lightweight filesystem helpers
