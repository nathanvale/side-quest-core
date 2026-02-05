import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateAbsoluteFilePath } from './file-paths.ts'

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'file-paths-test-'))
}

// ============================================================================
// validateAbsoluteFilePath Tests
// ============================================================================

describe('validateAbsoluteFilePath', () => {
	describe('accepts valid absolute paths', () => {
		test('simple absolute path', () => {
			expect(validateAbsoluteFilePath('/home/user/file.txt')).toBe('/home/user/file.txt')
		})

		test('path with hyphens and underscores', () => {
			expect(validateAbsoluteFilePath('/home/my-user/my_file.txt')).toBe(
				'/home/my-user/my_file.txt',
			)
		})

		test('path with dots in directory names', () => {
			expect(validateAbsoluteFilePath('/home/user/.config/app.json')).toBe(
				'/home/user/.config/app.json',
			)
		})
	})

	describe('rejects invalid paths', () => {
		test('empty string', () => {
			expect(() => validateAbsoluteFilePath('')).toThrow('File path cannot be empty')
		})

		test('whitespace only', () => {
			expect(() => validateAbsoluteFilePath('   ')).toThrow('File path cannot be empty')
		})

		test('relative path', () => {
			expect(() => validateAbsoluteFilePath('relative/path.txt')).toThrow('must be absolute')
		})

		test('dot-relative path', () => {
			expect(() => validateAbsoluteFilePath('./relative/path.txt')).toThrow('must be absolute')
		})
	})

	describe('rejects shell metacharacters', () => {
		test('semicolon', () => {
			expect(() => validateAbsoluteFilePath('/home/user/file; rm -rf /')).toThrow(
				'unsafe characters',
			)
		})

		test('backtick', () => {
			expect(() => validateAbsoluteFilePath('/home/user/`whoami`.txt')).toThrow('unsafe characters')
		})

		test('dollar sign', () => {
			expect(() => validateAbsoluteFilePath('/home/user/$(cat /etc/passwd).txt')).toThrow(
				'unsafe characters',
			)
		})

		test('pipe', () => {
			expect(() => validateAbsoluteFilePath('/home/user/file|name.txt')).toThrow(
				'unsafe characters',
			)
		})

		test('parentheses', () => {
			expect(() => validateAbsoluteFilePath('/home/user/file(1).txt')).toThrow('unsafe characters')
		})

		test('double quotes', () => {
			expect(() => validateAbsoluteFilePath('/home/user/"file".txt')).toThrow('unsafe characters')
		})

		test('single quotes', () => {
			expect(() => validateAbsoluteFilePath("/home/user/'file'.txt")).toThrow('unsafe characters')
		})

		test('backslash', () => {
			expect(() => validateAbsoluteFilePath('/home/user/file\\name.txt')).toThrow(
				'unsafe characters',
			)
		})
	})

	describe('extension validation', () => {
		test('accepts correct extension', () => {
			expect(
				validateAbsoluteFilePath('/home/user/audio.m4a', {
					extension: '.m4a',
				}),
			).toBe('/home/user/audio.m4a')
		})

		test('rejects wrong extension', () => {
			expect(() =>
				validateAbsoluteFilePath('/home/user/audio.wav', {
					extension: '.m4a',
				}),
			).toThrow('must end with .m4a')
		})

		test('case-insensitive extension check', () => {
			expect(
				validateAbsoluteFilePath('/home/user/audio.M4A', {
					extension: '.m4a',
				}),
			).toBe('/home/user/audio.M4A')
		})
	})

	describe('existence validation', () => {
		test('accepts existing file', () => {
			const tmpDir = makeTmpDir()
			const file = path.join(tmpDir, 'exists.txt')
			fs.writeFileSync(file, 'test')

			expect(validateAbsoluteFilePath(file, { mustExist: true })).toBe(file)

			fs.rmSync(tmpDir, { recursive: true, force: true })
		})

		test('rejects non-existent file', () => {
			expect(() =>
				validateAbsoluteFilePath('/definitely/not/a/real/file.txt', {
					mustExist: true,
				}),
			).toThrow('File not found')
		})

		test('does not check existence by default', () => {
			expect(validateAbsoluteFilePath('/not/a/real/path/but/valid.txt')).toBe(
				'/not/a/real/path/but/valid.txt',
			)
		})
	})

	describe('combined options', () => {
		test('extension + existence', () => {
			const tmpDir = makeTmpDir()
			const file = path.join(tmpDir, 'audio.m4a')
			fs.writeFileSync(file, 'test')

			expect(
				validateAbsoluteFilePath(file, {
					mustExist: true,
					extension: '.m4a',
				}),
			).toBe(file)

			fs.rmSync(tmpDir, { recursive: true, force: true })
		})
	})
})
