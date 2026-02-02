# Changelog

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
