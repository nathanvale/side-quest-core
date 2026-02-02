---
"@side-quest/core": minor
---

Add `mcp-response` module with MCP tool handler utilities

New export `@side-quest/core/mcp-response` providing:
- `wrapToolHandler` — reduces MCP tool boilerplate from ~25 lines to ~5 lines
- `ResponseFormat` enum and `parseResponseFormat` for JSON/Markdown output
- `respondText` / `respondError` for standardized MCP responses
- `createLoggerAdapter` for bridging LogTape to handler interface
- Logging utilities with correlation IDs and log file injection
