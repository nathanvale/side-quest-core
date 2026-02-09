import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Catalog } from './generate-catalog.ts'
import {
	buildJsdocHealthReport,
	countSignatureParameters,
	extractAnthropicMessageContent,
	type FunctionHealth,
	hasGenericFiller,
	isNameRestatement,
	isTier2TimeoutError,
	type JsdocHealthReport,
	type ModuleHealth,
	mapExportedFunctionDocTags,
	parseCliArgs,
	parseFunctionDocTagsFromDts,
	parseTier2EvaluationFromText,
	parseTier2Provider,
	resolveTier2ProviderConfig,
	runJsdocHealth,
	scoreFunctionDocumentation,
	selectTier2Candidates,
	splitIdentifierWords,
	type Tier2Evaluator,
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

async function withEnvUnset(keys: string[], run: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>()
	for (const key of keys) {
		previous.set(key, process.env[key])
		delete process.env[key]
	}
	try {
		await run()
	} finally {
		for (const key of keys) {
			const prior = previous.get(key)
			if (prior === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = prior
			}
		}
	}
}

async function withEnvValues(
	entries: Record<string, string | undefined>,
	run: () => Promise<void> | void,
): Promise<void> {
	const previous = new Map<string, string | undefined>()
	for (const [key, value] of Object.entries(entries)) {
		previous.set(key, process.env[key])
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
	try {
		await run()
	} finally {
		for (const [key, prior] of previous.entries()) {
			if (prior === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = prior
			}
		}
	}
}

function makeFunctionHealth(moduleName: string, functionName: string): FunctionHealth {
	return {
		moduleName,
		name: functionName,
		signature: `function ${functionName}(input: string): string`,
		description: `Function ${functionName} description for deterministic selection`,
		score: 100,
		rating: 'Excellent',
		parameterCount: 1,
		hasExample: true,
		paramTagCount: 1,
		issues: [],
	}
}

function makeModuleHealth(name: string, functionNames: string[]): ModuleHealth {
	return {
		name,
		functionCount: functionNames.length,
		score: 100,
		rating: 'Excellent',
		issuesByCode: {
			name_restatement: 0,
			description_too_short: 0,
			generic_filler: 0,
			missing_example: 0,
			missing_param_tags: 0,
			description_too_long: 0,
		},
		functions: functionNames.map((functionName) => makeFunctionHealth(name, functionName)),
	}
}

function makeSyntheticReport(modules: ModuleHealth[]): JsdocHealthReport {
	return {
		jsdocHealthSchemaVersion: 2,
		generated: '2026-02-09T00:00:00.000Z',
		packageVersion: '0.3.0',
		catalogPath: '/tmp/catalog.json',
		reportPath: '/tmp/report.json',
		moduleFilter: null,
		moduleCount: modules.length,
		functionCount: modules.reduce((sum, module) => sum + module.functionCount, 0),
		overallScore: 100,
		overallRating: 'Excellent',
		topIssues: [],
		modules,
		warnings: [],
		tier2: {
			status: 'skipped',
			model: null,
			score: null,
			coverage: {
				processedFunctions: 0,
				eligibleFunctions: 0,
				processedModules: 0,
				eligibleModules: 0,
				skippedFunctions: 0,
				skippedModules: 0,
			},
			stopReason: 'manual_skip',
			assessments: [],
		},
	}
}

describe('parseCliArgs', () => {
	it('parses module filters and thresholds', () => {
		const options = parseCliArgs(['--module', 'fs,mcp', '--module', 'cli', '--fail-under', '72.5'])
		expect(options).not.toBeNull()
		expect(options?.moduleFilter).toEqual(['fs', 'mcp', 'cli'])
		expect(options?.failUnder).toBe(72.5)
	})

	it('parses llm and budget controls', () => {
		const options = parseCliArgs([
			'--llm',
			'--llm-strict',
			'--max-modules',
			'5',
			'--max-functions',
			'12',
			'--max-tokens',
			'90000',
			'--timeout-ms',
			'450000',
		])
		expect(options?.llmRequested).toBe(true)
		expect(options?.llmStrict).toBe(true)
		expect(options?.tier2Budgets).toEqual({
			maxModules: 5,
			maxFunctions: 12,
			maxTokens: 90000,
			timeoutMs: 450000,
		})
	})

	it('throws when --llm-strict is used without --llm', () => {
		expect(() => parseCliArgs(['--llm-strict'])).toThrow('--llm-strict requires --llm')
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

	it('handles export declare function form', () => {
		const dts = `/**
 * Parse options.
 * @param argv - input arguments
 * @param defaults - default values
 * @example
 * parseOptions(['--debug'])
 */
export declare function parseOptions(argv: string[], defaults: object): object;`

		const tags = parseFunctionDocTagsFromDts(dts)
		expect(tags.get('parseOptions')).toEqual({ hasExample: true, paramTagCount: 2 })
	})

	it('handles export declare without jsdoc', () => {
		const dts = `export declare function orphan(): void;`

		const tags = parseFunctionDocTagsFromDts(dts)
		expect(tags.get('orphan')).toEqual({ hasExample: false, paramTagCount: 0 })
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

	it('maps alias exports with export declare function form', () => {
		const dts = `/**
 * Parse options.
 * @param argv - input arguments
 * @example
 * parseOptions([])
 */
export declare function parseOptions2(argv: string[]): object;`
		const js = `export { parseOptions2 as parseOptions };`
		const tags = mapExportedFunctionDocTags(dts, js)
		expect(tags.get('parseOptions')).toEqual({ hasExample: true, paramTagCount: 1 })
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

describe('parseTier2EvaluationFromText', () => {
	it('parses strict json response', () => {
		const parsed = parseTier2EvaluationFromText(
			'{"clarity": 90, "discoverability": 88, "completeness": 86, "summary": "Strong operational guidance."}',
		)
		expect(parsed).toEqual({
			clarity: 90,
			discoverability: 88,
			completeness: 86,
			summary: 'Strong operational guidance.',
		})
	})

	it('extracts json from wrapped response text', () => {
		const parsed = parseTier2EvaluationFromText(
			'Result:\n```json\n{"clarity": 80, "discoverability": 70, "completeness": 75, "summary": "Good enough."}\n```',
		)
		expect(parsed.clarity).toBe(80)
		expect(parsed.summary).toBe('Good enough.')
	})
})

describe('isTier2TimeoutError', () => {
	it('recognizes timeout-style errors', () => {
		expect(isTier2TimeoutError(new Error('Tier 2 provider request timed out'))).toBe(true)
		expect(isTier2TimeoutError(new Error('reached --timeout-ms budget'))).toBe(true)
		expect(isTier2TimeoutError(new Error('simulated provider outage'))).toBe(false)
	})
})

describe('tier2 provider resolution', () => {
	it('parses provider names with openai default', () => {
		expect(parseTier2Provider(undefined)).toBe('openai')
		expect(parseTier2Provider('openai')).toBe('openai')
		expect(parseTier2Provider('anthropic')).toBe('anthropic')
	})

	it('throws for unsupported provider names', () => {
		expect(() => parseTier2Provider('ollama')).toThrow('Unsupported Tier 2 provider "ollama"')
	})

	it('resolves anthropic provider config and credential checks', async () => {
		await withEnvValues(
			{
				JSDOC_HEALTH_PROVIDER: 'anthropic',
				JSDOC_HEALTH_MODEL: undefined,
				ANTHROPIC_MODEL: 'claude-3-5-haiku-latest',
				ANTHROPIC_API_KEY: undefined,
			},
			() => {
				const config = resolveTier2ProviderConfig()
				expect(config.provider).toBe('anthropic')
				expect(config.credentialEnvVar).toBe('ANTHROPIC_API_KEY')
				expect(config.credentialError).toBe('ANTHROPIC_API_KEY is not set')
				expect(config.model).toBe('claude-3-5-haiku-latest')
			},
		)
	})

	it('extracts anthropic text content blocks', () => {
		const text = extractAnthropicMessageContent({
			content: [
				{
					type: 'text',
					text: '{"clarity":90,"discoverability":85,"completeness":88,"summary":"Solid."}',
				},
			],
		})
		expect(text).toContain('"clarity":90')
	})
})

describe('selectTier2Candidates', () => {
	it('selects candidates deterministically and honors max-modules', () => {
		const report = makeSyntheticReport([
			makeModuleHealth('beta', ['zetaFn', 'alphaFn']),
			makeModuleHealth('alpha', ['twoFn', 'oneFn']),
			makeModuleHealth('gamma', ['extraFn']),
		])

		const selection = selectTier2Candidates(report, {
			maxModules: 2,
			maxFunctions: 10,
			maxTokens: 120000,
			timeoutMs: 600000,
		})

		expect(selection.stopReason).toBe('max_modules')
		expect(
			selection.candidates.map((candidate) => `${candidate.moduleName}.${candidate.functionName}`),
		).toEqual(['alpha.oneFn', 'alpha.twoFn', 'beta.alphaFn', 'beta.zetaFn'])
	})

	it('stops before exceeding max-token budget', () => {
		const report = makeSyntheticReport([makeModuleHealth('alpha', ['oneFn'])])
		const selection = selectTier2Candidates(report, {
			maxModules: 3,
			maxFunctions: 40,
			maxTokens: 5,
			timeoutMs: 600000,
		})

		expect(selection.candidates).toHaveLength(0)
		expect(selection.stopReason).toBe('max_tokens')
	})

	it('applies max-modules after excluding empty modules', () => {
		const report = makeSyntheticReport([
			makeModuleHealth('alpha-empty', []),
			makeModuleHealth('beta-empty', []),
			makeModuleHealth('gamma', ['doFn']),
			makeModuleHealth('zeta', ['laterFn']),
		])

		const selection = selectTier2Candidates(report, {
			maxModules: 1,
			maxFunctions: 10,
			maxTokens: 120000,
			timeoutMs: 600000,
		})

		expect(selection.eligibleModules).toBe(2)
		expect(selection.eligibleFunctions).toBe(2)
		expect(selection.stopReason).toBe('max_modules')
		expect(
			selection.candidates.map((candidate) => `${candidate.moduleName}.${candidate.functionName}`),
		).toEqual(['gamma.doFn'])
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
		expect(report.jsdocHealthSchemaVersion).toBe(2)
	})

	it('deduplicates repeated module filters before scoring', () => {
		const rootDir = createTempRoot()
		const catalog = seedCatalogFixture(rootDir)

		const report = buildJsdocHealthReport(
			catalog,
			rootDir,
			['beta', 'alpha', 'alpha', 'beta'],
			join(rootDir, 'dist', 'catalog.json'),
			join(rootDir, '.artifacts', 'jsdoc-health-report.json'),
		)

		expect(report.moduleFilter).toEqual(['alpha', 'beta'])
		expect(report.moduleCount).toBe(2)
		expect(report.functionCount).toBe(2)
		expect(report.modules.map((module) => module.name)).toEqual(['alpha', 'beta'])
		expect(report.overallScore).toBe(77.5)
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

	it('runs tier2 with deterministic truncation metadata', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		const evaluator: Tier2Evaluator = async () => ({
			clarity: 92,
			discoverability: 90,
			completeness: 88,
			summary: 'Clear guidance for model tool selection.',
		})

		const exitCode = await runJsdocHealth(
			['--llm', '--max-functions', '1', '--report', '.artifacts/tier2-partial.json'],
			rootDir,
			evaluator,
		)
		expect(exitCode).toBe(0)

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-partial.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.status).toBe('partial')
		expect(report.tier2.stopReason).toBe('max_functions')
		expect(report.tier2.coverage.processedFunctions).toBe(1)
		expect(report.tier2.coverage.eligibleFunctions).toBe(2)
		expect(report.tier2.assessments[0]?.moduleName).toBe('alpha')
		expect(report.tier2.assessments[0]?.functionName).toBe('parseArgs')
	})

	it('keeps non-strict llm failures advisory', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		const failingEvaluator: Tier2Evaluator = async () => {
			throw new Error('simulated provider outage')
		}

		const exitCode = await runJsdocHealth(
			['--llm', '--report', '.artifacts/tier2-fail.json'],
			rootDir,
			failingEvaluator,
		)
		expect(exitCode).toBe(0)

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-fail.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.status).toBe('failed')
		expect(report.tier2.stopReason).toBe('provider_error')
		expect(report.warnings.length).toBeGreaterThan(0)
	})

	it('enforces strict llm failures', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		const failingEvaluator: Tier2Evaluator = async () => {
			throw new Error('simulated provider outage')
		}

		const exitCode = await runJsdocHealth(
			['--llm', '--llm-strict', '--report', '.artifacts/tier2-strict-fail.json'],
			rootDir,
			failingEvaluator,
		)
		expect(exitCode).toBe(1)
	})

	it('classifies timeout evaluator failures with timeout stop reason', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		const timeoutEvaluator: Tier2Evaluator = async () => {
			throw new Error('request timed out while waiting for model')
		}

		const exitCode = await runJsdocHealth(
			['--llm', '--report', '.artifacts/tier2-timeout.json'],
			rootDir,
			timeoutEvaluator,
		)
		expect(exitCode).toBe(0)

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-timeout.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.stopReason).toBe('timeout')
		expect(report.tier2.status).toBe('partial')
	})

	it('keeps missing OPENAI_API_KEY advisory in non-strict mode', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		await withEnvUnset(['OPENAI_API_KEY'], async () => {
			const exitCode = await runJsdocHealth(
				['--llm', '--report', '.artifacts/tier2-missing-key.json'],
				rootDir,
			)
			expect(exitCode).toBe(0)
		})

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-missing-key.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.status).toBe('failed')
		expect(report.tier2.stopReason).toBe('provider_error')
		expect(report.warnings.some((warning) => warning.includes('OPENAI_API_KEY'))).toBe(true)
	})

	it('fails missing OPENAI_API_KEY in strict mode', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		let exitCode = 0
		await withEnvUnset(['OPENAI_API_KEY'], async () => {
			exitCode = await runJsdocHealth(
				['--llm', '--llm-strict', '--report', '.artifacts/tier2-missing-key-strict.json'],
				rootDir,
			)
		})

		expect(exitCode).toBe(1)
	})

	it('uses provider-specific credential checks for anthropic', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		await withEnvValues(
			{
				JSDOC_HEALTH_PROVIDER: 'anthropic',
				ANTHROPIC_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				const exitCode = await runJsdocHealth(
					['--llm', '--report', '.artifacts/tier2-missing-anthropic-key.json'],
					rootDir,
				)
				expect(exitCode).toBe(0)
			},
		)

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-missing-anthropic-key.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.status).toBe('failed')
		expect(report.warnings.some((warning) => warning.includes('ANTHROPIC_API_KEY'))).toBe(true)
	})

	it('handles unsupported provider config as provider_error', async () => {
		const rootDir = createTempRoot()
		seedCatalogFixture(rootDir)

		await withEnvValues(
			{
				JSDOC_HEALTH_PROVIDER: 'unsupported-provider',
			},
			async () => {
				const exitCode = await runJsdocHealth(
					['--llm', '--report', '.artifacts/tier2-invalid-provider.json'],
					rootDir,
				)
				expect(exitCode).toBe(0)
			},
		)

		const report = JSON.parse(
			readFileSync(join(rootDir, '.artifacts', 'tier2-invalid-provider.json'), 'utf-8'),
		) as JsdocHealthReport
		expect(report.tier2.stopReason).toBe('provider_error')
		expect(
			report.warnings.some((warning) => warning.includes('provider configuration error')),
		).toBe(true)
	})
})
