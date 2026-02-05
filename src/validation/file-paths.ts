/**
 * Absolute file path validation with defense-in-depth security checks.
 *
 * Provides strict validation for absolute file paths that may be passed
 * to subprocesses or used in security-sensitive contexts. Complements
 * `validateFilePath` in `fs/safety.ts` which validates relative paths.
 *
 * @module validation/file-paths
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { SHELL_METACHARACTERS_STRICT } from './patterns.ts'

/**
 * Options for absolute file path validation.
 */
export interface ValidateAbsoluteFilePathOptions {
	/**
	 * Check that the file exists on disk.
	 * @default false
	 */
	mustExist?: boolean

	/**
	 * Required file extension (e.g., ".m4a", ".json").
	 * Case-insensitive comparison.
	 */
	extension?: string
}

/**
 * Validate an absolute file path for safe use in subprocesses.
 *
 * Performs defense-in-depth checks:
 * 1. Requires an absolute path (starts with /)
 * 2. Rejects shell metacharacters (strict set including parens and quotes)
 * 3. Optionally checks file existence
 * 4. Optionally validates file extension
 *
 * Why: File paths passed to subprocesses can be attack vectors even with
 * array-based spawn. This provides multiple layers of validation.
 *
 * Named `validateAbsoluteFilePath` to avoid collision with `validateFilePath`
 * in `fs/safety.ts` which validates relative paths.
 *
 * @param filePath - Absolute file path to validate
 * @param options - Validation options
 * @returns The validated path (normalized)
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * // Basic validation
 * validateAbsoluteFilePath("/home/user/file.txt")
 * // => "/home/user/file.txt"
 *
 * // With existence check
 * validateAbsoluteFilePath("/home/user/file.txt", { mustExist: true })
 * // throws if file doesn't exist
 *
 * // With extension check
 * validateAbsoluteFilePath("/home/user/audio.m4a", { extension: ".m4a" })
 * // => "/home/user/audio.m4a"
 *
 * // Rejects relative paths
 * validateAbsoluteFilePath("relative/path.txt")
 * // throws Error
 *
 * // Rejects shell metacharacters
 * validateAbsoluteFilePath("/home/user/$(whoami).txt")
 * // throws Error
 * ```
 */
export function validateAbsoluteFilePath(
	filePath: string,
	options?: ValidateAbsoluteFilePathOptions,
): string {
	if (!filePath || filePath.trim() === '') {
		throw new Error('File path cannot be empty')
	}

	if (!path.isAbsolute(filePath)) {
		throw new Error(`File path must be absolute: ${filePath}`)
	}

	if (SHELL_METACHARACTERS_STRICT.test(filePath)) {
		throw new Error(`File path contains unsafe characters: ${filePath}`)
	}

	if (options?.extension) {
		const ext = options.extension
		if (!filePath.toLowerCase().endsWith(ext.toLowerCase())) {
			throw new Error(`File path must end with ${ext}: ${filePath}`)
		}
	}

	if (options?.mustExist && !existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`)
	}

	return filePath
}
