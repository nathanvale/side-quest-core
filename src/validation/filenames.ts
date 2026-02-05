/**
 * Filename validation utilities for safe subprocess and filesystem usage.
 *
 * Provides whitelist-based filename validation that prevents:
 * - Command injection via filenames passed to subprocesses
 * - Filesystem attacks via special characters
 *
 * The allowed character set matches `validateFilenameForSubprocess` in `fs/sandbox.ts`.
 *
 * @module validation/filenames
 */

import type { ValidationResult } from './patterns.ts'

/**
 * Characters allowed in safe filenames: alphanumeric, underscore, hyphen, dot, space.
 * This is the same character set used by `validateFilenameForSubprocess`.
 */
const SAFE_FILENAME_CHARS = /^[a-zA-Z0-9_\-. ]+$/

/**
 * Check if a filename contains only safe characters.
 *
 * Validates the filename against a whitelist of allowed characters
 * (alphanumeric, underscore, hyphen, dot, space). Optionally checks
 * that the filename ends with a specific extension.
 *
 * Why: Filenames passed to subprocesses or shell commands can be attack vectors.
 * A whitelist approach is safer than blacklisting dangerous characters.
 *
 * @param filename - Filename to validate (basename only, not a path)
 * @param extension - Optional required extension (e.g., ".m4a", ".json")
 * @returns True if the filename is safe
 *
 * @example
 * ```typescript
 * isSafeFilename("report.pdf")           // => true
 * isSafeFilename("My Notes.md")          // => true
 * isSafeFilename("file; rm -rf /")       // => false
 * isSafeFilename("audio.m4a", ".m4a")    // => true
 * isSafeFilename("audio.wav", ".m4a")    // => false (wrong extension)
 * ```
 */
export function isSafeFilename(filename: string, extension?: string): boolean {
	if (!filename || filename.trim() === '') {
		return false
	}

	if (!SAFE_FILENAME_CHARS.test(filename)) {
		return false
	}

	if (extension && !filename.toLowerCase().endsWith(extension.toLowerCase())) {
		return false
	}

	return true
}

/**
 * Validate a filename and return a structured result.
 *
 * Like `isSafeFilename` but returns a `ValidationResult` with error details
 * for better error reporting in user-facing code.
 *
 * @param filename - Filename to validate (basename only, not a path)
 * @param extension - Optional required extension (e.g., ".m4a", ".json")
 * @returns Validation result with the trimmed filename or error message
 *
 * @example
 * ```typescript
 * validateFilename("report.pdf")
 * // => { valid: true, value: "report.pdf" }
 *
 * validateFilename("")
 * // => { valid: false, error: "Filename cannot be empty" }
 *
 * validateFilename("file`whoami`.txt")
 * // => { valid: false, error: "Filename contains invalid characters: ..." }
 *
 * validateFilename("audio.wav", ".m4a")
 * // => { valid: false, error: "Filename must end with .m4a" }
 * ```
 */
export function validateFilename(
	filename: string,
	extension?: string,
): ValidationResult {
	if (!filename || filename.trim() === '') {
		return { valid: false, error: 'Filename cannot be empty' }
	}

	if (!SAFE_FILENAME_CHARS.test(filename)) {
		return {
			valid: false,
			error: `Filename contains invalid characters: ${filename}. Only alphanumeric, underscore, hyphen, dot, and space are allowed.`,
		}
	}

	if (extension && !filename.toLowerCase().endsWith(extension.toLowerCase())) {
		return {
			valid: false,
			error: `Filename must end with ${extension}`,
		}
	}

	return { valid: true, value: filename }
}
