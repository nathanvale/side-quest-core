/**
 * JSON state management with Zod validation, atomic writes, and file locking.
 *
 * Provides type-safe load/save/update operations for JSON state files,
 * generalizing the manual type-guard pattern into reusable Zod-validated
 * functions with atomic write safety.
 *
 * @module fs/json-state
 */

import type { ZodType } from 'zod'
import { type FileLockOptions, withFileLock } from '../concurrency/file-lock.js'
import {
	ensureParentDirSync,
	readJsonFileOrDefault,
	writeJsonFileAtomic,
	writeJsonFileSyncAtomic,
} from './index.js'

/**
 * Load JSON state from a file with Zod schema validation.
 *
 * Reads the file, parses JSON, and validates against the provided Zod schema.
 * Returns the default value if the file doesn't exist, contains invalid JSON,
 * or fails schema validation.
 *
 * Why Zod: Manual type guards are error-prone and don't compose well.
 * Zod provides runtime type safety with clear error messages.
 *
 * @param filePath - Path to the JSON state file
 * @param schema - Zod schema to validate against
 * @param defaultValue - Value to return when file is missing or invalid
 * @returns Validated state or default value
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const StateSchema = z.object({
 *   version: z.number(),
 *   items: z.array(z.string()),
 * });
 *
 * const state = loadJsonStateSync(
 *   "/path/to/state.json",
 *   StateSchema,
 *   { version: 1, items: [] }
 * );
 * ```
 */
export function loadJsonStateSync<T>(
	filePath: string,
	schema: ZodType<T>,
	defaultValue: T,
): T {
	const raw = readJsonFileOrDefault(filePath, null)
	if (raw === null) {
		return defaultValue
	}

	const result = schema.safeParse(raw)
	if (!result.success) {
		return defaultValue
	}

	return result.data
}

/**
 * Save JSON state to a file atomically.
 *
 * Ensures the parent directory exists, then writes the state using
 * atomic write (write to temp file, then rename) to prevent partial writes.
 *
 * @param filePath - Path to the JSON state file
 * @param state - State to save
 *
 * @example
 * ```typescript
 * saveJsonStateSync("/path/to/state.json", {
 *   version: 1,
 *   items: ["a", "b"],
 * });
 * ```
 */
export function saveJsonStateSync(filePath: string, state: unknown): void {
	ensureParentDirSync(filePath)
	writeJsonFileSyncAtomic(filePath, state)
}

/**
 * Atomically update a JSON state file with file locking.
 *
 * Performs a locked read-modify-write cycle:
 * 1. Acquires a file lock for the resource
 * 2. Reads and validates the current state (or uses default)
 * 3. Applies the transform function
 * 4. Writes the updated state atomically
 * 5. Releases the lock
 *
 * Why locking: Concurrent load/modify/save sequences without locking can
 * overwrite each other's changes. File locking serializes access.
 *
 * @param filePath - Path to the JSON state file
 * @param schema - Zod schema to validate against
 * @param defaultValue - Value to use when file is missing or invalid
 * @param transform - Function that receives current state and returns updated state
 * @param options - Optional file lock configuration
 * @returns The updated state after the transform
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const CounterSchema = z.object({ count: z.number() });
 *
 * const updated = await updateJsonFileAtomic(
 *   "/path/to/counter.json",
 *   CounterSchema,
 *   { count: 0 },
 *   (state) => ({ count: state.count + 1 })
 * );
 * // updated.count === 1 (or previous + 1)
 * ```
 */
export async function updateJsonFileAtomic<T>(
	filePath: string,
	schema: ZodType<T>,
	defaultValue: T,
	transform: (current: T) => T,
	options?: FileLockOptions,
): Promise<T> {
	return withFileLock(
		filePath,
		async () => {
			const current = loadJsonStateSync(filePath, schema, defaultValue)
			const updated = transform(current)
			ensureParentDirSync(filePath)
			await writeJsonFileAtomic(filePath, updated)
			return updated
		},
		options,
	)
}
