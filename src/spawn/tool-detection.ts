/**
 * Async tool detection utilities for checking command availability.
 *
 * Provides async companions to the sync `commandExists()` and
 * `ensureCommandAvailable()` functions, with improved error messages
 * that include actionable install hints.
 *
 * Uses `Bun.which` for fast PATH resolution without spawning a subprocess.
 *
 * @module spawn/tool-detection
 */

/**
 * Check if a command-line tool is available on PATH (async).
 *
 * Async companion to `commandExists()`. Uses `Bun.which` for fast
 * resolution without spawning a subprocess (unlike the `which` command).
 *
 * Why async: Allows non-blocking checks in async initialization flows
 * and can be composed with other async operations via `Promise.all`.
 *
 * @param name - Command name to check (e.g., "ffmpeg", "whisper")
 * @returns Promise resolving to true if the tool is available
 *
 * @example
 * ```typescript
 * if (await isToolAvailable("ffmpeg")) {
 *   // Use ffmpeg for transcoding
 * }
 *
 * // Check multiple tools in parallel
 * const [hasFFmpeg, hasWhisper] = await Promise.all([
 *   isToolAvailable("ffmpeg"),
 *   isToolAvailable("whisper"),
 * ]);
 * ```
 */
export async function isToolAvailable(name: string): Promise<boolean> {
	return Bun.which(name) !== null
}

/**
 * Ensure a tool is available on PATH, with an actionable install hint on failure.
 *
 * Like `ensureCommandAvailable()` but adds an optional install hint in the
 * error message, making it easier for users to fix missing dependencies.
 *
 * @param name - Command name to check (e.g., "ffmpeg", "whisper")
 * @param installHint - Optional install instruction shown on failure
 * @returns Resolved absolute path to the command
 * @throws Error with actionable message if the tool is not found
 *
 * @example
 * ```typescript
 * // Without install hint
 * const ffmpegPath = ensureToolAvailable("ffmpeg");
 *
 * // With install hint
 * const whisperPath = ensureToolAvailable(
 *   "whisper",
 *   "Install with: pip install openai-whisper"
 * );
 * // Error: "Command not found: whisper. Install with: pip install openai-whisper"
 * ```
 */
export function ensureToolAvailable(
	name: string,
	installHint?: string,
): string {
	const resolved = Bun.which(name)
	if (!resolved) {
		const message = installHint
			? `Command not found: ${name}. ${installHint}`
			: `Command not found: ${name}`
		throw new Error(message)
	}
	return resolved
}
