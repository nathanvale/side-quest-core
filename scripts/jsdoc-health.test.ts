import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Catalog } from './generate-catalog.ts'
import {
	buildJsdocHealthReport,
	countSignatureParameters,
	hasGenericFiller,
	isNameRestatement,
	mapExportedFunctionDocTags,
	parseCliArgs,
	parseFunctionDocTagsFromDts,
	runJsdocHealth,
	scoreFunctionDocumentation,
	splitIdentifierWords,
} from './jsdoc-health.ts'

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

function createTempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'jsdoc-health-'))
	tempDirs.push(dir)
	return dir
}

describe('parseCliArgs', () => {
	it('parses module filters and thresholds', () => {
		const options = parseCliArgs(['--module', 'fs,mcp', '--module', 'cli', '--fail-under', '72.5'])
		expect(options).not.toBeNull()
		expect(options?.moduleFilter).toEqual(['fs', 'mcp', 'cli'])
		expect(options?.failUnder).toBe(72.5)
	})
})

describe('splitIdentifierWords', () => {
	it('splits camelCase, snake_case, and kebab-case', () => {
		expect(splitIdentifierWords('parseArgs')).toEqual(['parse', 'args'])
		expect(splitIdentifierWords('parse_args')).toEqual(['parse', 'args'])
		expect(splitIdentifierWords('parse-args')).toEqual(['parse', 'args'])
	})
})

describe('countSignatureParameters', () => {
	it('counts top-level parameters with nested types', () => {
		const signature =
			'function foo(a: string, options: Record<string, Array<{ x: number; y: number }>>, cb: (x: number, y: number) => void): void'
		expect(countSignatureParameters(signature)).toBe(3)
	})

	it('returns null for truncated signatures', () => {
		expect(countSignatureParameters('function parseArgs(...): ParseResult')).toBeNull()
	})
})

describe('heuristics', () => {
	it('detects name restatement', () => {
		expect(isNameRestatement('parseArgs', 'Parse args.')).toBe(true)
		expect(
			isNameRestatement('parseArgs', 'Parse command-line flags into a typed options object.'),
		).toBe(false)
	})

	it('detects generic filler', () => {
		expect(hasGenericFiller('Utility for parsing input values')).toBe(true)
		expect(hasGenericFiller('Parse command-line arguments into options')).toBe(false)
	})
})

describe('parseFunctionDocTagsFromDts', () => {
	it('extracts @example and @param metadata from jsdoc', () => {
		const dts = `/**
 * Parse options.
 * @param argv - input arguments
 * @param defaults - default values
 * @example
 * parseOptions(['--debug'])
 */
declare function parseOptions(argv: string[], defaults: object): object;`

		const tags = parseFunctionDocTagsFromDts(dts)
		expect(tags.get('parseOptions')).toEqual({ hasExample: true, paramTagCount: 2 })
	})
})

describe('mapExportedFunctionDocTags', () => {
	it('maps alias exports from generated JS', () => {
		const dts = `/**
 * Parse options.
 * @example
 * parseOptions([])
 */
declare function parseOptions2(argv: string[]): object;`
		const js = `export { parseOptions2 as parseOptions };`
		const tags = mapExportedFunctionDocTags(dts, js)
		expect(tags.get('parseOptions')).toEqual({ hasExample: true, paramTagCount: 0 })
	})
})

describe('scoreFunctionDocumentation', () => {
	it('applies penalties for short restatement and missing tags', () => {
		const scored = scoreFunctionDocumentation(
			'cli',
			{
				name: 'parseArgs',
				kind: 'function',
				signature: 'function parseArgs(input: string): object',
				description: 'Parse args.',
			},
			{ hasExample: false, paramTagCount: 0 },
		)

		expect(scored.score).toBe(55)
		expect(scored.issues.map((issue) => issue.code).sort()).toEqual([
			'description_too_short',
			'missing_example',
			'name_restatement',
		])
	})
})

function seedCatalogFixture(rootDir: string): Catalog {
	mkdirSync(join(rootDir, 'dist', 'src', 'alpha'), { recursive: true })
	mkdirSync(join(rootDir, 'dist', 'src', 'beta'), { recursive: true })

	writeFileSync(
		join(rootDir, 'dist', 'src', 'alpha', 'index.d.ts'),
		`/**
 * Parse args.
 */
declare function parseArgs(input: string): object;`,
	)
	writeFileSync(join(rootDir, 'dist', 'src', 'alpha', 'index.js'), 'export { parseArgs };\n')

	writeFileSync(
		join(rootDir, 'dist', 'src', 'beta', 'index.d.ts'),
		`/**
 * Parse command-line flags into a typed options object.
 * @param argv - args
 * @param defaults - default option values
 * @example
 * parseOptions(['--debug'], {})
 */
declare function parseOptions(argv: string[], defaults: object): object;`,
	)
	writeFileSync(join(rootDir, 'dist', 'src', 'beta', 'index.js'), 'export { parseOptions };\n')

	const catalog: Catalog = {
		schemaVersion: 1,
		packageVersion: '0.3.0',
		generated: '2026-02-09T00:00:00.000Z',
		moduleCount: 2,
		declarationCount: 2,
		modules: {
			alpha: {
				summary: 'Alpha module',
				exports: ['parseArgs'],
				declarations: [
					{
						name: 'parseArgs',
						kind: 'function',
						signature: 'function parseArgs(input: string): object',
						description: 'Parse args.',
					},
				],
			},
			beta: {
				summary: 'Beta module',
				exports: ['parseOptions'],
				declarations: [
					{
						name: 'parseOptions',
						kind: 'function',
						signature: 'function parseOptions(argv: string[], defaults: object): object',
						description: 'Parse command-line flags into a typed options object.',
					},
				],
			},
		},
	}

	mkdirSync(join(rootDir, 'dist'), { recursive: true })
	writeFileSync(join(rootDir, 'dist', 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)

	return catalog
}

describe('buildJsdocHealthReport', () => {
	it('uses function-count weighted overall score', () => {
		const rootDir = createTempRoot()
		const catalog = seedCatalogFixture(rootDir)

		const report = buildJsdocHealthReport(
			catalog,
			rootDir,
			[],
			join(rootDir, 'dist', 'catalog.json'),
			join(rootDir, '.artifacts', 'jsdoc-health-report.json'),
		)

		expect(report.moduleCount).toBe(2)
		expect(report.functionCount).toBe(2)
		expect(report.overallScore).toBe(77.5)
		expect(report.topIssues.map((issue) => issue.code)).toContain('missing_example')
	})
})

describe('runJsdocHealth', () => {
	it('writes report and respects --fail-under', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		const exitOk = await runJsdocHealth(
			['--json', '--report', '.artifacts/custom-health.json'],
			rootDir,
		)
		expect(exitOk).toBe(0)

		const reportPath = join(rootDir, '.artifacts', 'custom-health.json')
		expect(existsSync(reportPath)).toBe(true)
		const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
			overallScore: number
		}
		expect(report.overallScore).toBe(77.5)

		const exitFail = await runJsdocHealth(['--fail-under', '90'], rootDir)
		expect(exitFail).toBe(1)
	})
})
