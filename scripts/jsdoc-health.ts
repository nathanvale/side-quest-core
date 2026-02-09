#!/usr/bin/env bun
/**
 * Assess JSDoc quality for runtime API surface published in dist/catalog.json.
 *
 * Phase 2a (heuristics only):
 * - Name restatement
 * - Description length checks
 * - Generic filler phrasing
 * - Missing @example
 * - Missing @param for multi-parameter functions
 *
 * Writes a JSON report for CI and prints a human summary by default.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMainScript } from '../src/terminal/index.ts'
import type { Catalog, Declaration } from './generate-catalog.ts'
import { getJsdocBlock, parseJsExportBindings } from './generate-catalog.ts'

const JSDOC_HEALTH_SCHEMA_VERSION = 1
const DEFAULT_CATALOG_PATH = 'dist/catalog.json'
const DEFAULT_REPORT_PATH = '.artifacts/jsdoc-health-report.json'

const ISSUE_PENALTIES = {
	name_restatement: 10,
	description_too_short: 10,
	generic_filler: 5,
	missing_example: 25,
	missing_param_tags: 15,
	description_too_long: 5,
} as const

const ISSUE_SUMMARIES: Record<IssueCode, string> = {
	name_restatement: 'Name restatement',
	description_too_short: 'Too short description',
	generic_filler: 'Generic filler phrasing',
	missing_example: 'Missing @example',
	missing_param_tags: 'Missing @param docs',
	description_too_long: 'Overly long description',
}

/** Supported issue codes for heuristic checks. */
export type IssueCode = keyof typeof ISSUE_PENALTIES

/** CLI options parsed from argv. */
export interface JsdocHealthCliOptions {
	moduleFilter: string[]
	outputJson: boolean
	details: boolean
	failUnder?: number
	catalogPath: string
	reportPath: string
	llmRequested: boolean
}

/** JSDoc tag signals extracted for a function declaration. */
export interface FunctionDocTags {
	hasExample: boolean
	paramTagCount: number
}

/** One quality issue found for a function. */
export interface HealthIssue {
	code: IssueCode
	penalty: number
	message: string
}

/** Health evaluation result for a single function export. */
export interface FunctionHealth {
	moduleName: string
	name: string
	signature: string
	description: string
	score: number
	rating: string
	parameterCount: number | null
	hasExample: boolean | null
	paramTagCount: number | null
	issues: HealthIssue[]
}

/** Aggregated health result for a module. */
export interface ModuleHealth {
	name: string
	functionCount: number
	score: number
	rating: string
	issuesByCode: Record<IssueCode, number>
	functions: FunctionHealth[]
}

/** Versioned JSON report schema for Phase 2 quality checks. */
export interface JsdocHealthReport {
	jsdocHealthSchemaVersion: number
	generated: string
	packageVersion: string
	catalogPath: string
	reportPath: string
	moduleFilter: string[] | null
	moduleCount: number
	functionCount: number
	overallScore: number
	overallRating: string
	topIssues: Array<{ code: IssueCode; count: number; label: string }>
	modules: ModuleHealth[]
}

/**
 * Parse CLI args for the health checker.
 *
 * @param argv - Raw CLI args (without node/bun executable)
 * @returns Parsed options or null when --help is requested
 */
export function parseCliArgs(argv: string[]): JsdocHealthCliOptions | null {
	const { values } = parseArgs({
		options: {
			module: { type: 'string', short: 'm', multiple: true },
			json: { type: 'boolean', default: false },
			details: { type: 'boolean', default: false },
			'fail-under': { type: 'string' },
			catalog: { type: 'string' },
			report: { type: 'string' },
			help: { type: 'boolean', short: 'h', default: false },
			llm: { type: 'boolean', default: false },
			'max-modules': { type: 'string' },
			'max-functions': { type: 'string' },
			'max-tokens': { type: 'string' },
			'timeout-ms': { type: 'string' },
		},
		allowPositionals: false,
		strict: true,
		args: argv,
	})

	if (values.help) {
		return null
	}

	const failUnderRaw = values['fail-under']
	let failUnder: number | undefined
	if (failUnderRaw !== undefined) {
		const parsed = Number(failUnderRaw)
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
			throw new Error('--fail-under must be a number between 0 and 100')
		}
		failUnder = parsed
	}

	const rawModules = values.module ?? []
	const moduleFilter = rawModules
		.flatMap((entry) => entry.split(','))
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

	return {
		moduleFilter,
		outputJson: values.json,
		details: values.details,
		failUnder,
		catalogPath: values.catalog ?? DEFAULT_CATALOG_PATH,
		reportPath: values.report ?? DEFAULT_REPORT_PATH,
		llmRequested: values.llm,
	}
}

/**
 * Split an identifier into lowercase words.
 *
 * Handles camelCase, PascalCase, snake_case, and kebab-case names.
 *
 * @param input - Identifier text
 * @returns Normalized lowercase word list
 */
export function splitIdentifierWords(input: string): string[] {
	return input
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]/g, ' ')
		.split(/\s+/)
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length > 0)
}

/**
 * Count top-level function parameters from a signature string.
 *
 * Returns null when parameters are intentionally elided (`(...)`) or parsing fails.
 *
 * @param signature - Cleaned function signature from catalog
 * @returns Number of parameters or null when unknown
 */
export function countSignatureParameters(signature: string): number | null {
	if (!signature.startsWith('function ')) return null

	const start = signature.indexOf('(')
	if (start === -1) return null
	if (signature.slice(start, start + 5) === '(...)') return null

	let depthParen = 0
	let depthAngle = 0
	let depthBrace = 0
	let depthBracket = 0
	let end = -1

	for (let i = start; i < signature.length; i++) {
		const ch = signature[i] as string
		if (ch === '(') {
			depthParen++
			continue
		}
		if (ch === ')') {
			depthParen--
			if (depthParen === 0) {
				end = i
				break
			}
			continue
		}
		if (ch === '<') depthAngle++
		if (ch === '>' && depthAngle > 0) depthAngle--
		if (ch === '{') depthBrace++
		if (ch === '}' && depthBrace > 0) depthBrace--
		if (ch === '[') depthBracket++
		if (ch === ']' && depthBracket > 0) depthBracket--
	}

	if (end === -1) return null

	const paramsText = signature.slice(start + 1, end).trim()
	if (paramsText.length === 0) return 0

	const params: string[] = []
	let current = ''
	depthParen = 0
	depthAngle = 0
	depthBrace = 0
	depthBracket = 0
	let quote: 'single' | 'double' | 'backtick' | null = null

	for (let i = 0; i < paramsText.length; i++) {
		const ch = paramsText[i] as string
		const prev = i > 0 ? (paramsText[i - 1] as string) : ''

		if (quote) {
			current += ch
			if (
				((quote === 'single' && ch === "'") ||
					(quote === 'double' && ch === '"') ||
					(quote === 'backtick' && ch === '`')) &&
				prev !== '\\'
			) {
				quote = null
			}
			continue
		}

		if (ch === "'") {
			quote = 'single'
			current += ch
			continue
		}
		if (ch === '"') {
			quote = 'double'
			current += ch
			continue
		}
		if (ch === '`') {
			quote = 'backtick'
			current += ch
			continue
		}

		if (ch === '(') depthParen++
		if (ch === ')' && depthParen > 0) depthParen--
		if (ch === '<') depthAngle++
		if (ch === '>' && depthAngle > 0) depthAngle--
		if (ch === '{') depthBrace++
		if (ch === '}' && depthBrace > 0) depthBrace--
		if (ch === '[') depthBracket++
		if (ch === ']' && depthBracket > 0) depthBracket--

		const atTopLevel =
			depthParen === 0 &&
			depthAngle === 0 &&
			depthBrace === 0 &&
			depthBracket === 0

		if (ch === ',' && atTopLevel) {
			if (current.trim().length > 0) params.push(current.trim())
			current = ''
			continue
		}

		current += ch
	}

	if (current.trim().length > 0) params.push(current.trim())
	return params.length
}

/**
 * Detect whether a description is likely just restating the function name.
 *
 * @param functionName - Runtime export name
 * @param description - First-line JSDoc description
 * @returns True when description likely mirrors only the name
 */
export function isNameRestatement(
	functionName: string,
	description: string,
): boolean {
	const normalize = (value: string): string => {
		let cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, '')
		if (cleaned.endsWith('ies') && cleaned.length > 4) {
			cleaned = `${cleaned.slice(0, -3)}y`
		} else if (cleaned.endsWith('ing') && cleaned.length > 5) {
			cleaned = cleaned.slice(0, -3)
		} else if (cleaned.endsWith('ed') && cleaned.length > 4) {
			cleaned = cleaned.slice(0, -2)
		} else if (cleaned.endsWith('es') && cleaned.length > 4) {
			cleaned = cleaned.slice(0, -2)
		} else if (cleaned.endsWith('s') && cleaned.length > 3) {
			cleaned = cleaned.slice(0, -1)
		}
		return cleaned
	}

	const nameWords = splitIdentifierWords(functionName)
		.map(normalize)
		.filter((word) => word.length > 0)
	const descriptionWords = description
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map(normalize)
		.filter((word) => word.length > 0)

	if (nameWords.length === 0 || descriptionWords.length === 0) return false
	if (descriptionWords.length < nameWords.length) return false

	const samePrefix = nameWords.every(
		(word, idx) => descriptionWords[idx] === word,
	)
	if (!samePrefix) return false

	// Permit tiny amount of extra text, otherwise this is likely just renaming.
	return descriptionWords.length <= nameWords.length + 2
}

/**
 * Check whether a description starts with generic filler phrasing.
 *
 * @param description - JSDoc description text
 * @returns True when phrase likely provides little semantic value
 */
export function hasGenericFiller(description: string): boolean {
	const normalized = description.trim().toLowerCase()
	const patterns = [
		/^utility\s+(for|to)\b/,
		/^function\s+to\b/,
		/^helper\s+(for|to)\b/,
		/^used\s+to\b/,
		/^this\s+function\b/,
	]
	return patterns.some((pattern) => pattern.test(normalized))
}

/**
 * Parse local function JSDoc tag signals from a module's .d.ts content.
 *
 * @param dtsContent - Module declaration file content
 * @returns Map of local function name to @example/@param metadata
 */
export function parseFunctionDocTagsFromDts(
	dtsContent: string,
): Map<string, FunctionDocTags> {
	const lines = dtsContent.split('\n')
	const seen = new Set<string>()
	const tags = new Map<string, FunctionDocTags>()

	for (let i = 0; i < lines.length; i++) {
		const match = (lines[i] as string)
			.trim()
			.match(/^(?:export\s+)?declare\s+function\s+(\w+)/)
		if (!match) continue

		const name = match[1] as string
		if (seen.has(name)) continue
		seen.add(name)

		const jsdocBlock = getJsdocBlock(lines, i)
		if (!jsdocBlock) {
			tags.set(name, { hasExample: false, paramTagCount: 0 })
			continue
		}

		const paramTagCount = (jsdocBlock.match(/@param\b/g) ?? []).length
		tags.set(name, {
			hasExample: /@example\b/.test(jsdocBlock),
			paramTagCount,
		})
	}

	return tags
}

/**
 * Map exported runtime function names to JSDoc tag signals.
 *
 * Uses generated JS export bindings to handle alias exports.
 *
 * @param dtsContent - Module declaration file content
 * @param jsContent - Module generated JS content
 * @returns Map of exported function names to JSDoc tag metadata
 */
export function mapExportedFunctionDocTags(
	dtsContent: string,
	jsContent: string,
): Map<string, FunctionDocTags> {
	const localTags = parseFunctionDocTagsFromDts(dtsContent)
	const bindings = parseJsExportBindings(jsContent)
	const mapped = new Map<string, FunctionDocTags>()

	if (bindings.length > 0) {
		for (const binding of bindings) {
			if (mapped.has(binding.exported)) continue
			const tags = localTags.get(binding.local)
			if (!tags) continue
			mapped.set(binding.exported, tags)
		}
	}

	// Fallback for emit changes: local name lookup remains usable.
	for (const [name, tags] of localTags.entries()) {
		if (!mapped.has(name)) mapped.set(name, tags)
	}

	return mapped
}

/**
 * Load exported function doc-tag metadata for one module from dist/src outputs.
 *
 * @param rootDir - Repository root
 * @param moduleName - Catalog module key
 * @returns Map of exported function name to doc-tag metadata
 */
export function loadModuleFunctionDocTags(
	rootDir: string,
	moduleName: string,
): Map<string, FunctionDocTags> {
	const dtsPath = join(rootDir, 'dist', 'src', moduleName, 'index.d.ts')
	const jsPath = join(rootDir, 'dist', 'src', moduleName, 'index.js')

	if (!existsSync(dtsPath) || !existsSync(jsPath)) {
		throw new Error(
			`Missing built module files for "${moduleName}". Expected ${dtsPath} and ${jsPath}. Run bun run build first.`,
		)
	}

	const dtsContent = readFileSync(dtsPath, 'utf-8')
	const jsContent = readFileSync(jsPath, 'utf-8')
	return mapExportedFunctionDocTags(dtsContent, jsContent)
}

/**
 * Convert a numeric score to a qualitative rating label.
 *
 * @param score - Score in [0,100]
 * @returns Rating label used in terminal and JSON report output
 */
export function scoreToRating(score: number): string {
	if (score >= 90) return 'Excellent'
	if (score >= 80) return 'Good'
	if (score >= 70) return 'Needs improvement'
	return 'Poor'
}

/**
 * Score one function declaration using Tier 1 heuristics.
 *
 * @param moduleName - Module containing the function
 * @param declaration - Function declaration from catalog
 * @param docTags - Optional @example/@param metadata signals
 * @returns Function-level score + issue list
 */
export function scoreFunctionDocumentation(
	moduleName: string,
	declaration: Declaration,
	docTags?: FunctionDocTags,
): FunctionHealth {
	const issues: HealthIssue[] = []
	const description = declaration.description.trim()

	const addIssue = (code: IssueCode): void => {
		issues.push({
			code,
			penalty: ISSUE_PENALTIES[code],
			message: ISSUE_SUMMARIES[code],
		})
	}

	if (isNameRestatement(declaration.name, description)) {
		addIssue('name_restatement')
	}

	if (description.length < 15) {
		addIssue('description_too_short')
	}

	if (hasGenericFiller(description)) {
		addIssue('generic_filler')
	}

	if (description.length > 300) {
		addIssue('description_too_long')
	}

	const parameterCount = countSignatureParameters(declaration.signature)
	if (docTags && !docTags.hasExample) {
		addIssue('missing_example')
	}
	if (
		docTags &&
		parameterCount !== null &&
		parameterCount > 1 &&
		docTags.paramTagCount === 0
	) {
		addIssue('missing_param_tags')
	}

	const totalPenalty = issues.reduce((sum, issue) => sum + issue.penalty, 0)
	const score = Math.max(0, 100 - totalPenalty)

	return {
		moduleName,
		name: declaration.name,
		signature: declaration.signature,
		description,
		score,
		rating: scoreToRating(score),
		parameterCount,
		hasExample: docTags ? docTags.hasExample : null,
		paramTagCount: docTags ? docTags.paramTagCount : null,
		issues,
	}
}

/**
 * Build the full health report for selected modules from catalog data.
 *
 * @param catalog - Parsed API catalog
 * @param rootDir - Repository root
 * @param moduleFilter - Optional list of module names to scope analysis
 * @param catalogPath - Resolved path used for catalog input
 * @param reportPath - Resolved path where report will be written
 * @returns Versioned health report JSON object
 */
export function buildJsdocHealthReport(
	catalog: Catalog,
	rootDir: string,
	moduleFilter: string[],
	catalogPath: string,
	reportPath: string,
): JsdocHealthReport {
	const allModuleNames = Object.keys(catalog.modules).sort()
	const normalizedModuleFilter = Array.from(new Set(moduleFilter))
	const selectedModules =
		normalizedModuleFilter.length > 0
			? normalizedModuleFilter.slice().sort()
			: allModuleNames

	const unknownModules = selectedModules.filter(
		(name) => !(name in catalog.modules),
	)
	if (unknownModules.length > 0) {
		throw new Error(`Unknown module(s): ${unknownModules.join(', ')}`)
	}

	const modules: ModuleHealth[] = []
	const issueTotals: Record<IssueCode, number> = {
		name_restatement: 0,
		description_too_short: 0,
		generic_filler: 0,
		missing_example: 0,
		missing_param_tags: 0,
		description_too_long: 0,
	}

	let weightedScoreSum = 0
	let totalFunctions = 0

	for (const moduleName of selectedModules) {
		const moduleEntry = catalog.modules[moduleName]
		if (!moduleEntry) continue

		const docTags = loadModuleFunctionDocTags(rootDir, moduleName)
		const functions = moduleEntry.declarations
			.filter((declaration) => declaration.kind === 'function')
			.map((declaration) =>
				scoreFunctionDocumentation(
					moduleName,
					declaration,
					docTags.get(declaration.name),
				),
			)

		for (const func of functions) {
			weightedScoreSum += func.score
			totalFunctions++
			for (const issue of func.issues) {
				issueTotals[issue.code]++
			}
		}

		const moduleScore =
			functions.length > 0
				? functions.reduce((sum, func) => sum + func.score, 0) /
					functions.length
				: 100

		const issuesByCode: Record<IssueCode, number> = {
			name_restatement: 0,
			description_too_short: 0,
			generic_filler: 0,
			missing_example: 0,
			missing_param_tags: 0,
			description_too_long: 0,
		}

		for (const func of functions) {
			for (const issue of func.issues) {
				issuesByCode[issue.code]++
			}
		}

		modules.push({
			name: moduleName,
			functionCount: functions.length,
			score: Number(moduleScore.toFixed(2)),
			rating: scoreToRating(moduleScore),
			issuesByCode,
			functions,
		})
	}

	const overallScore =
		totalFunctions > 0 ? weightedScoreSum / totalFunctions : 100
	const topIssues = (Object.entries(issueTotals) as Array<[IssueCode, number]>)
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([code, count]) => ({ code, count, label: ISSUE_SUMMARIES[code] }))

	return {
		jsdocHealthSchemaVersion: JSDOC_HEALTH_SCHEMA_VERSION,
		generated: new Date().toISOString(),
		packageVersion: catalog.packageVersion,
		catalogPath,
		reportPath,
		moduleFilter: normalizedModuleFilter.length > 0 ? selectedModules : null,
		moduleCount: modules.length,
		functionCount: totalFunctions,
		overallScore: Number(overallScore.toFixed(2)),
		overallRating: scoreToRating(overallScore),
		topIssues,
		modules,
	}
}

/**
 * Render a concise terminal summary for the health report.
 *
 * @param report - Health report object
 * @param details - Whether to include per-function issue rows
 */
export function printHealthReport(
	report: JsdocHealthReport,
	details: boolean,
): void {
	console.log(
		`JSDoc Health: ${report.overallScore}/100 (${report.overallRating})`,
	)
	console.log('')

	for (const module of report.modules) {
		const score = module.score.toFixed(0).padStart(3, ' ')
		const moduleName = module.name.padEnd(12, ' ')
		console.log(`  ${moduleName} ${score}/100  ${module.rating}`)
	}

	if (report.topIssues.length > 0) {
		console.log('')
		console.log('Top issues:')
		report.topIssues.slice(0, 3).forEach((issue, idx) => {
			console.log(`  ${idx + 1}. ${issue.label} in ${issue.count} function(s)`)
		})
	}

	if (details) {
		const functionsWithIssues = report.modules
			.flatMap((module) => module.functions)
			.filter((func) => func.issues.length > 0)
			.sort((a, b) => a.score - b.score)

		if (functionsWithIssues.length > 0) {
			console.log('')
			console.log('Details:')
			for (const func of functionsWithIssues) {
				const issueLabels = func.issues.map((issue) => issue.message).join('; ')
				console.log(
					`  - ${func.moduleName}.${func.name} (${func.score}/100): ${issueLabels}`,
				)
			}
		}
	}

	console.log('')
	console.log(`Report written: ${report.reportPath}`)
}

/**
 * Print command usage information.
 */
export function printUsage(): void {
	console.log(`Usage:
  bun run jsdoc:health
  bun run jsdoc:health --module fs
  bun run jsdoc:health --json
  bun run jsdoc:health --fail-under 70

Flags:
  --module, -m     Module name filter (repeatable or comma-separated)
  --json           Print JSON report to stdout
  --details        Include per-function issue rows in terminal output
  --fail-under     Exit 1 when overall score is below threshold (0-100)
  --catalog        Path to catalog JSON (default: dist/catalog.json)
  --report         Path to output report JSON (default: .artifacts/jsdoc-health-report.json)
  --llm            Reserved for future Tier 2 checks (not implemented yet)
  --help, -h       Show this usage`)
}

/**
 * Execute the health checker end-to-end.
 *
 * @param argv - Raw CLI args
 * @param rootDirOverride - Optional root directory for tests
 * @returns Process-style exit code
 */
export async function runJsdocHealth(
	argv: string[] = process.argv.slice(2),
	rootDirOverride?: string,
): Promise<number> {
	let options: JsdocHealthCliOptions | null

	try {
		options = parseCliArgs(argv)
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : 'Failed to parse arguments',
		)
		console.error('Run with --help for usage.')
		return 1
	}

	if (!options) {
		printUsage()
		return 0
	}

	if (options.llmRequested) {
		console.warn(
			'Warning: --llm is reserved for Phase 2b and is not implemented yet. Running Tier 1 heuristics only.',
		)
	}

	const rootDir = rootDirOverride ?? resolve(import.meta.dir, '..')
	const catalogPath = isAbsolute(options.catalogPath)
		? options.catalogPath
		: resolve(rootDir, options.catalogPath)
	const reportPath = isAbsolute(options.reportPath)
		? options.reportPath
		: resolve(rootDir, options.reportPath)

	if (!existsSync(catalogPath)) {
		console.error(
			`Catalog file not found: ${catalogPath}. Run bun run build first.`,
		)
		return 1
	}

	let catalog: Catalog
	try {
		catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as Catalog
	} catch (error) {
		console.error(
			`Failed to parse catalog JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
		return 1
	}

	let report: JsdocHealthReport
	try {
		report = buildJsdocHealthReport(
			catalog,
			rootDir,
			options.moduleFilter,
			catalogPath,
			reportPath,
		)
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		return 1
	}

	mkdirSync(dirname(reportPath), { recursive: true })
	await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)

	if (options.outputJson) {
		console.log(JSON.stringify(report, null, 2))
	} else {
		printHealthReport(report, options.details)
	}

	if (
		typeof options.failUnder === 'number' &&
		report.overallScore < options.failUnder
	) {
		console.error(
			`Score ${report.overallScore} is below fail threshold ${options.failUnder}.`,
		)
		return 1
	}

	return 0
}

if (isMainScript(import.meta.path)) {
	const exitCode = await runJsdocHealth()
	process.exit(exitCode)
}
