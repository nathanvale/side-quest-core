import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { loadJsonStateSync, saveJsonStateSync, updateJsonFileAtomic } from './json-state.ts'

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'json-state-test-'))
}

const TestSchema = z.object({
	version: z.number(),
	items: z.array(z.string()),
})

type TestState = z.infer<typeof TestSchema>

const DEFAULT_STATE: TestState = { version: 1, items: [] }

// ============================================================================
// loadJsonStateSync Tests
// ============================================================================

describe('loadJsonStateSync', () => {
	test('returns default when file does not exist', () => {
		const result = loadJsonStateSync('/nonexistent/state.json', TestSchema, DEFAULT_STATE)
		expect(result).toEqual(DEFAULT_STATE)
	})

	test('returns default when file contains invalid JSON', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'invalid.json')
		fs.writeFileSync(file, 'not valid json{{{')

		const result = loadJsonStateSync(file, TestSchema, DEFAULT_STATE)
		expect(result).toEqual(DEFAULT_STATE)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('returns default when JSON fails schema validation', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'wrong-shape.json')
		fs.writeFileSync(file, JSON.stringify({ wrong: 'shape' }))

		const result = loadJsonStateSync(file, TestSchema, DEFAULT_STATE)
		expect(result).toEqual(DEFAULT_STATE)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('returns parsed state when file is valid', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'valid.json')
		const state: TestState = { version: 2, items: ['a', 'b'] }
		fs.writeFileSync(file, JSON.stringify(state))

		const result = loadJsonStateSync(file, TestSchema, DEFAULT_STATE)
		expect(result).toEqual(state)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('validates extra fields are stripped by schema', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'extra.json')
		fs.writeFileSync(file, JSON.stringify({ version: 1, items: [], extra: 'field' }))

		const StrictSchema = z
			.object({
				version: z.number(),
				items: z.array(z.string()),
			})
			.strict()

		// strict() schema rejects extra fields
		const result = loadJsonStateSync(file, StrictSchema, DEFAULT_STATE)
		expect(result).toEqual(DEFAULT_STATE)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})
})

// ============================================================================
// saveJsonStateSync Tests
// ============================================================================

describe('saveJsonStateSync', () => {
	test('writes state to file', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'state.json')

		const state: TestState = { version: 1, items: ['hello'] }
		saveJsonStateSync(file, state)

		const content = JSON.parse(fs.readFileSync(file, 'utf8'))
		expect(content).toEqual(state)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('creates parent directories', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'nested', 'deep', 'state.json')

		saveJsonStateSync(file, DEFAULT_STATE)

		expect(fs.existsSync(file)).toBe(true)
		const content = JSON.parse(fs.readFileSync(file, 'utf8'))
		expect(content).toEqual(DEFAULT_STATE)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('overwrites existing file', () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'state.json')

		saveJsonStateSync(file, { version: 1, items: [] })
		saveJsonStateSync(file, { version: 2, items: ['updated'] })

		const content = JSON.parse(fs.readFileSync(file, 'utf8'))
		expect(content).toEqual({ version: 2, items: ['updated'] })

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})
})

// ============================================================================
// updateJsonFileAtomic Tests
// ============================================================================

describe('updateJsonFileAtomic', () => {
	test('creates file with transformed default when file does not exist', async () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'new-state.json')

		const result = await updateJsonFileAtomic(file, TestSchema, DEFAULT_STATE, (state) => ({
			...state,
			items: ['first'],
		}))

		expect(result).toEqual({ version: 1, items: ['first'] })

		const content = JSON.parse(fs.readFileSync(file, 'utf8'))
		expect(content).toEqual({ version: 1, items: ['first'] })

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('updates existing state', async () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'state.json')
		fs.writeFileSync(file, JSON.stringify({ version: 1, items: ['a'] }))

		const result = await updateJsonFileAtomic(file, TestSchema, DEFAULT_STATE, (state) => ({
			...state,
			version: state.version + 1,
			items: [...state.items, 'b'],
		}))

		expect(result).toEqual({ version: 2, items: ['a', 'b'] })

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('falls back to default when existing file is invalid', async () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'corrupt.json')
		fs.writeFileSync(file, 'not json')

		const result = await updateJsonFileAtomic(file, TestSchema, DEFAULT_STATE, (state) => ({
			...state,
			items: ['recovered'],
		}))

		expect(result).toEqual({ version: 1, items: ['recovered'] })

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	test('creates parent directories', async () => {
		const tmpDir = makeTmpDir()
		const file = path.join(tmpDir, 'a', 'b', 'c', 'state.json')

		await updateJsonFileAtomic(file, TestSchema, DEFAULT_STATE, (state) => state)

		expect(fs.existsSync(file)).toBe(true)

		fs.rmSync(tmpDir, { recursive: true, force: true })
	})
})
