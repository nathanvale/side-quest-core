import { describe, expect, test } from 'bun:test'
import { isSafeFilename, validateFilename } from './filenames.ts'

// ============================================================================
// isSafeFilename Tests
// ============================================================================

describe('isSafeFilename', () => {
	describe('accepts safe filenames', () => {
		test('simple filename with extension', () => {
			expect(isSafeFilename('report.pdf')).toBe(true)
		})

		test('filename with spaces', () => {
			expect(isSafeFilename('My Notes.md')).toBe(true)
		})

		test('filename with underscores and hyphens', () => {
			expect(isSafeFilename('my_file-v2.txt')).toBe(true)
		})

		test('filename with numbers', () => {
			expect(isSafeFilename('2024-01-report.csv')).toBe(true)
		})

		test('filename with multiple dots', () => {
			expect(isSafeFilename('archive.tar.gz')).toBe(true)
		})
	})

	describe('rejects unsafe filenames', () => {
		test('empty string', () => {
			expect(isSafeFilename('')).toBe(false)
		})

		test('whitespace only', () => {
			expect(isSafeFilename('   ')).toBe(false)
		})

		test('semicolon injection', () => {
			expect(isSafeFilename('file; rm -rf /')).toBe(false)
		})

		test('backtick command substitution', () => {
			expect(isSafeFilename('file`whoami`.txt')).toBe(false)
		})

		test('dollar sign expansion', () => {
			expect(isSafeFilename('$(cat /etc/passwd).txt')).toBe(false)
		})

		test('pipe character', () => {
			expect(isSafeFilename('file|name.txt')).toBe(false)
		})

		test('angle brackets', () => {
			expect(isSafeFilename('file<name>.txt')).toBe(false)
		})

		test('path separators', () => {
			expect(isSafeFilename('path/file.txt')).toBe(false)
		})
	})

	describe('extension matching', () => {
		test('matches correct extension', () => {
			expect(isSafeFilename('audio.m4a', '.m4a')).toBe(true)
		})

		test('rejects wrong extension', () => {
			expect(isSafeFilename('audio.wav', '.m4a')).toBe(false)
		})

		test('case-insensitive extension matching', () => {
			expect(isSafeFilename('audio.M4A', '.m4a')).toBe(true)
			expect(isSafeFilename('audio.m4a', '.M4A')).toBe(true)
		})

		test('no extension check when not specified', () => {
			expect(isSafeFilename('audio.wav')).toBe(true)
		})
	})
})

// ============================================================================
// validateFilename Tests
// ============================================================================

describe('validateFilename', () => {
	describe('returns valid for good filenames', () => {
		test('simple filename', () => {
			const result = validateFilename('report.pdf')
			expect(result.valid).toBe(true)
			expect(result.value).toBe('report.pdf')
		})

		test('filename with spaces', () => {
			const result = validateFilename('Meeting Notes.md')
			expect(result.valid).toBe(true)
			expect(result.value).toBe('Meeting Notes.md')
		})

		test('filename with correct extension', () => {
			const result = validateFilename('audio.m4a', '.m4a')
			expect(result.valid).toBe(true)
			expect(result.value).toBe('audio.m4a')
		})
	})

	describe('returns error for invalid filenames', () => {
		test('empty filename', () => {
			const result = validateFilename('')
			expect(result.valid).toBe(false)
			expect(result.error).toBe('Filename cannot be empty')
		})

		test('whitespace-only filename', () => {
			const result = validateFilename('   ')
			expect(result.valid).toBe(false)
			expect(result.error).toBe('Filename cannot be empty')
		})

		test('unsafe characters', () => {
			const result = validateFilename('file`whoami`.txt')
			expect(result.valid).toBe(false)
			expect(result.error).toContain('invalid characters')
		})

		test('wrong extension', () => {
			const result = validateFilename('audio.wav', '.m4a')
			expect(result.valid).toBe(false)
			expect(result.error).toContain('.m4a')
		})
	})
})
