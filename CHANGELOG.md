# Changelog

## 0.3.1

### Patch Changes

- [#32](https://github.com/nathanvale/side-quest-core/pull/32) [`f6d747d`](https://github.com/nathanvale/side-quest-core/commit/f6d747d8fc72b502d0c37e169f45f3482489b5f9) Thanks [@nathanvale](https://github.com/nathanvale)! - fix: remove incorrect Node.js engine declaration and replace Bun-only fs/promises exists import

  - Replace `"node": ">=22.20"` engine with `"bun": ">=1.2"` since the package uses Bun-specific APIs throughout (Bun.file, Bun.write, Bun.hash, etc.)
  - Replace `import { exists } from 'node:fs/promises'` in config.ts with a stat-based alternative, since `exists` is a Bun-only API not available in Node.js

  Closes #29, closes #31

## 0.3.0

### Minor Changes

- [#24](https://github.com/nathanvale/side-quest-core/pull/24) [`492855b`](https://github.com/nathanvale/side-quest-core/commit/492855bf270066aaa8614c59eb33d713137a5d2f) Thanks [@nathanvale](https://github.com/nathanvale)! - Add publishable API catalog artifacts and subpath exports

  - `dist/catalog.json` - structured JSON catalog of all 25 modules, 395+ declarations with signatures, descriptions, and export names
  - `dist/catalog.js` + `dist/catalog.d.ts` - typed JS wrapper for Bun/Node ESM consumption via `@side-quest/core/catalog`
  - `dist/llms.txt` - llms.txt community standard file for LLM ecosystem tooling
  - `@side-quest/core/catalog` subpath export (typed, runtime-safe for both Bun and Node)
  - `@side-quest/core/catalog.json` subpath export (direct JSON access)
  - Catalog generation now filters to package.json-declared module exports only, preventing accidental dist/src noise

## 0.2.0

### Minor Changes

- [#17](https://github.com/nathanvale/side-quest-core/pull/17) [`1cc6e57`](https://github.com/nathanvale/side-quest-core/commit/1cc6e57f972ebf5a24f6c9d4b6c0acdcc166b2ee) Thanks [@nathanvale](https://github.com/nathanvale)! - Add reusable validation, spawn, and fs utilities extracted from voice-memo plugin

  - `isSafeFilename` / `validateFilename` - whitelist-based filename validation with optional extension matching
  - `validateAbsoluteFilePath` - defense-in-depth absolute path validation (shell metachar rejection, existence, extension)
  - `SHELL_METACHARACTERS_STRICT` - broader metacharacter pattern blocking parens and quotes
  - `isToolAvailable` / `ensureToolAvailable` - async tool detection with actionable install hints
  - `loadJsonStateSync` / `saveJsonStateSync` / `updateJsonFileAtomic` - Zod-validated JSON state management with atomic writes and file locking
  - `isSymlinkSync` / `isEmptyFileSync` - lightweight filesystem helpers

## 0.1.1

### Patch Changes

- [#11](https://github.com/nathanvale/side-quest-core/pull/11) [`a08953e`](https://github.com/nathanvale/side-quest-core/commit/a08953e15d387198f3c160a1b49936165019eb58) Thanks [@nathanvale](https://github.com/nathanvale)! - fix(ci): add build step before npm publish in changesets workflow

## 0.1.0

### Minor Changes

- [#9](https://github.com/nathanvale/side-quest-core/pull/9) [`e7e4d4b`](https://github.com/nathanvale/side-quest-core/commit/e7e4d4b242e51b9519193e61895fa66bc9a40987) Thanks [@nathanvale](https://github.com/nathanvale)! - Add `mcp-response` module with MCP tool handler utilities

  New export `@side-quest/core/mcp-response` providing:

  - `wrapToolHandler` — reduces MCP tool boilerplate from ~25 lines to ~5 lines
  - `ResponseFormat` enum and `parseResponseFormat` for JSON/Markdown output
  - `respondText` / `respondError` for standardized MCP responses
  - `createLoggerAdapter` for bridging LogTape to handler interface
  - Logging utilities with correlation IDs and log file injection

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial release.
