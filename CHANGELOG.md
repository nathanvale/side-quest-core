# Changelog

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
