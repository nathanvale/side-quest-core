import { describe, expect, test } from 'bun:test'
import { ensureToolAvailable, isToolAvailable } from './tool-detection.ts'

// ============================================================================
// isToolAvailable Tests
// ============================================================================

describe('isToolAvailable', () => {
	test('returns true for a common tool (ls)', async () => {
		expect(await isToolAvailable('ls')).toBe(true)
	})

	test('returns true for bun', async () => {
		expect(await isToolAvailable('bun')).toBe(true)
	})

	test('returns false for a non-existent tool', async () => {
		expect(await isToolAvailable('definitely-not-a-real-command-xyz123')).toBe(false)
	})
})

// ============================================================================
// ensureToolAvailable Tests
// ============================================================================

describe('ensureToolAvailable', () => {
	test('returns path for existing tool', () => {
		const result = ensureToolAvailable('ls')
		expect(result).toBeString()
		expect(result).toContain('/')
	})

	test('throws for non-existent tool without hint', () => {
		expect(() => ensureToolAvailable('definitely-not-a-real-command-xyz123')).toThrow(
			'Command not found: definitely-not-a-real-command-xyz123',
		)
	})

	test('throws with install hint when provided', () => {
		expect(() =>
			ensureToolAvailable(
				'definitely-not-a-real-command-xyz123',
				'Install with: brew install xyz123',
			),
		).toThrow(
			'Command not found: definitely-not-a-real-command-xyz123. Install with: brew install xyz123',
		)
	})

	test('does not include hint text when tool exists', () => {
		const result = ensureToolAvailable('ls', 'Install with: apt install coreutils')
		expect(result).toBeString()
		expect(result).toContain('/')
	})
})
