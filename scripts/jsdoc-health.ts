#!/usr/bin/env bun
/**
 * Assess JSDoc quality for runtime API surface published in dist/catalog.json.
 *
 * Phase 2 provides two tiers:
 * - Tier 1: deterministic heuristics (default)
 * - Tier 2: optional LLM quality assessment with strict runtime budgets
 *
 * Writes a JSON report for CI and prints a human summary by default.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isMainScript } from '../src/terminal/index.ts'
import type { Catalog, Declaration } from './generate-catalog.ts'
import { getJsdocBlock, parseJsExportBindings } from './generate-catalog.ts'

const JSDOC_HEALTH_SCHEMA_VERSION = 2
const DEFAULT_CATALOG_PATH = 'dist/catalog.json'
const DEFAULT_REPORT_PATH = '.artifacts/jsdoc-health-report.json'
const DEFAULT_MAX_MODULES = 3
const DEFAULT_MAX_FUNCTIONS = 40
const DEFAULT_MAX_TOKENS = 120_000
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_LLM_MODEL = 'gpt-4o-mini'
const OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const TIER2_COMPLETION_TOKEN_BUDGET = 260

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

/** Supported status values for optional Tier 2 assessment. */
export type Tier2Status = 'completed' | 'partial' | 'skipped' | 'failed'

/** Reason why Tier 2 was skipped, stopped early, or failed. */
export type Tier2StopReason =
	| 'max_modules'
	| 'max_functions'
	| 'max_tokens'
	| 'timeout'
	| 'provider_error'
	| 'manual_skip'

/** Parsed execution budgets for Tier 2 LLM checks. */
export interface Tier2Budgets {
	maxModules: number
	maxFunctions: number
	maxTokens: number
	timeoutMs: number
}

/** CLI options parsed from argv. */
export interface JsdocHealthCliOptions {
	moduleFilter: string[]
	outputJson: boolean
	details: boolean
	failUnder?: number
	catalogPath: string
	reportPath: string
	llmRequested: boolean
	llmStrict: boolean
	tier2Budgets: Tier2Budgets
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

/** One selected function candidate for Tier 2 assessment. */
export interface Tier2FunctionCandidate {
	moduleName: string
	functionName: string
	signature: string
	description: string
	estimatedTokens: number
}

/** LLM evaluation score breakdown for one function. */
export interface Tier2Evaluation {
	clarity: number
	discoverability: number
	completeness: number
	summary: string
}

/** Stored result for one Tier 2-evaluated function. */
export interface Tier2FunctionAssessment extends Tier2FunctionCandidate {
	score: number
	clarity: number
	discoverability: number
	completeness: number
	summary: string
}

/** Coverage statistics for Tier 2 execution. */
export interface Tier2Coverage {
	processedFunctions: number
	eligibleFunctions: number
	processedModules: number
	eligibleModules: number
	skippedFunctions: number
	skippedModules: number
}

/** Tier 2 report section describing execution outcome and scored results. */
export interface Tier2Report {
	status: Tier2Status
	model: string | null
	score: number | null
	coverage: Tier2Coverage
	stopReason: Tier2StopReason | null
	assessments: Tier2FunctionAssessment[]
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
	warnings: string[]
	tier2: Tier2Report
}

/** Selection result for deterministic Tier 2 candidate ordering and truncation. */
export interface Tier2SelectionResult {
	candidates: Tier2FunctionCandidate[]
	eligibleModules: number
	eligibleFunctions: number
	stopReason: Tier2StopReason | null
}

/** Context passed into each LLM evaluation call for timeout/budget management. */
export interface Tier2EvaluatorContext {
	model: string
	remainingMs: number
}

/** Custom evaluator signature used by tests and provider adapters. */
export type Tier2Evaluator = (
	candidate: Tier2FunctionCandidate,
	context: Tier2EvaluatorContext,
) => Promise<Tier2Evaluation>

interface Tier2ExecutionResult {
	tier2: Tier2Report
	warnings: string[]
	providerFailure: boolean
	timedOut: boolean
}

/**
 * Parse a positive integer CLI option.
 *
 * @param rawValue - Raw string value from parseArgs
 * @param flagName - Flag name for clear error messages
 * @returns Parsed positive integer
 */
export function parsePositiveIntegerOption(
	rawValue: string,
	flagName: string,
): number {
	const parsed = Number(rawValue)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flagName} must be a positive integer`)
	}
	return parsed
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
			'llm-strict': { type: 'boolean', default: false },
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

	const llmRequested = values.llm
	const llmStrict = values['llm-strict']
	if (llmStrict && !llmRequested) {
		throw new Error('--llm-strict requires --llm')
	}

	return {
		moduleFilter,
		outputJson: values.json,
		details: values.details,
		failUnder,
		catalogPath: values.catalog ?? DEFAULT_CATALOG_PATH,
		reportPath: values.report ?? DEFAULT_REPORT_PATH,
		llmRequested,
		llmStrict,
		tier2Budgets: {
			maxModules:
				values['max-modules'] === undefined
					? DEFAULT_MAX_MODULES
					: parsePositiveIntegerOption(values['max-modules'], '--max-modules'),
			maxFunctions:
				values['max-functions'] === undefined
					? DEFAULT_MAX_FUNCTIONS
					: parsePositiveIntegerOption(
							values['max-functions'],
							'--max-functions',
						),
			maxTokens:
				values['max-tokens'] === undefined
					? DEFAULT_MAX_TOKENS
					: parsePositiveIntegerOption(values['max-tokens'], '--max-tokens'),
			timeoutMs:
				values['timeout-ms'] === undefined
					? DEFAULT_TIMEOUT_MS
					: parsePositiveIntegerOption(values['timeout-ms'], '--timeout-ms'),
		},
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
 * Build an empty Tier 2 report section for default/non-LLM runs.
 *
 * @returns Tier 2 report initialized as skipped
 */
export function createDefaultTier2Report(): Tier2Report {
	return {
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
		warnings: [],
		tier2: createDefaultTier2Report(),
	}
}

/**
 * Build deterministic Tier 2 candidates and apply static budget truncation.
 *
 * @param report - Tier 1 health report containing modules/functions
 * @param budgets - Tier 2 budget limits
 * @returns Ordered candidates plus eligibility and truncation metadata
 */
export function selectTier2Candidates(
	report: JsdocHealthReport,
	budgets: Tier2Budgets,
): Tier2SelectionResult {
	const sortedModules = report.modules
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
	const eligibleModules = sortedModules.length
	const eligibleFunctions = sortedModules.reduce(
		(sum, module) => sum + module.functions.length,
		0,
	)

	const limitedModules = sortedModules.slice(0, budgets.maxModules)
	let stopReason: Tier2StopReason | null =
		limitedModules.length < sortedModules.length ? 'max_modules' : null

	const candidates: Tier2FunctionCandidate[] = []
	let tokenTotal = 0

	moduleLoop: for (const module of limitedModules) {
		const sortedFunctions = module.functions
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))

		for (const func of sortedFunctions) {
			if (candidates.length >= budgets.maxFunctions) {
				if (!stopReason) stopReason = 'max_functions'
				break moduleLoop
			}

			const candidateBase = {
				moduleName: module.name,
				functionName: func.name,
				signature: func.signature,
				description: func.description,
			}
			const estimatedTokens =
				estimateTokens(buildTier2Prompt(candidateBase)) +
				TIER2_COMPLETION_TOKEN_BUDGET
			if (tokenTotal + estimatedTokens > budgets.maxTokens) {
				if (!stopReason) stopReason = 'max_tokens'
				break moduleLoop
			}

			tokenTotal += estimatedTokens
			candidates.push({ ...candidateBase, estimatedTokens })
		}
	}

	return {
		candidates,
		eligibleModules,
		eligibleFunctions,
		stopReason,
	}
}

/**
 * Build the structured prompt for one Tier 2 function assessment request.
 *
 * @param candidate - Function candidate details
 * @returns Prompt text requesting strict JSON output
 */
export function buildTier2Prompt(
	candidate: Omit<Tier2FunctionCandidate, 'estimatedTokens'>,
): string {
	return [
		'Evaluate this TypeScript function JSDoc for LLM consumption.',
		'Score each dimension from 0 to 100 as integers.',
		'Return ONLY JSON with keys: clarity, discoverability, completeness, summary.',
		'',
		`Module: ${candidate.moduleName}`,
		`Function: ${candidate.functionName}`,
		`Signature: ${candidate.signature}`,
		`Description: ${candidate.description || '(missing description)'}`,
	].join('\n')
}

/**
 * Rough token estimate used for deterministic max-token budgeting.
 *
 * @param text - Prompt text
 * @returns Approximate token count (4 chars/token heuristic)
 */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Parse a numeric score expected in [0, 100].
 *
 * @param value - Unknown value from parsed JSON
 * @param field - Field name for error messages
 * @returns Validated score
 */
export function parseTier2ScoreField(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Tier 2 response missing numeric ${field}`)
	}
	if (value < 0 || value > 100) {
		throw new Error(`Tier 2 response ${field} must be between 0 and 100`)
	}
	return Number(value.toFixed(2))
}

/**
 * Parse LLM output into Tier 2 evaluation fields.
 *
 * Accepts either raw JSON or wrapped text containing one JSON object.
 *
 * @param rawText - Model response text
 * @returns Parsed and validated evaluation fields
 */
export function parseTier2EvaluationFromText(rawText: string): Tier2Evaluation {
	const trimmed = rawText.trim()
	if (trimmed.length === 0) {
		throw new Error('Tier 2 response was empty')
	}

	let jsonText = trimmed
	if (!trimmed.startsWith('{')) {
		const start = trimmed.indexOf('{')
		const end = trimmed.lastIndexOf('}')
		if (start === -1 || end === -1 || end <= start) {
			throw new Error('Tier 2 response did not contain JSON')
		}
		jsonText = trimmed.slice(start, end + 1)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(jsonText)
	} catch (error) {
		throw new Error(
			`Tier 2 response JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('Tier 2 response JSON must be an object')
	}

	const record = parsed as Record<string, unknown>
	const summary =
		typeof record.summary === 'string' ? record.summary.trim() : ''
	if (summary.length === 0) {
		throw new Error('Tier 2 response missing non-empty summary')
	}

	return {
		clarity: parseTier2ScoreField(record.clarity, 'clarity'),
		discoverability: parseTier2ScoreField(
			record.discoverability,
			'discoverability',
		),
		completeness: parseTier2ScoreField(record.completeness, 'completeness'),
		summary,
	}
}

/**
 * Detect whether a Tier 2 runtime error represents timeout exhaustion.
 *
 * @param error - Unknown error thrown by evaluator/provider
 * @returns True when the failure should be classified as timeout
 */
export function isTier2TimeoutError(error: unknown): boolean {
	if (error instanceof Error) {
		if (error.name === 'AbortError') return true
		const message = error.message.toLowerCase()
		if (
			message.includes('timed out') ||
			message.includes('timeout') ||
			message.includes('--timeout-ms budget')
		) {
			return true
		}
	}
	return false
}

/**
 * Extract chat-completion message content from an OpenAI-compatible payload.
 *
 * @param payload - Parsed JSON payload from provider
 * @returns Message text content
 */
export function extractOpenAiMessageContent(payload: unknown): string {
	if (typeof payload !== 'object' || payload === null) {
		throw new Error('Invalid LLM response payload')
	}

	const choices = (payload as { choices?: unknown }).choices
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new Error('LLM response contained no choices')
	}

	const firstChoice = choices[0] as {
		message?: {
			content?: unknown
		}
	}
	const content = firstChoice.message?.content

	if (typeof content === 'string') {
		return content
	}

	if (Array.isArray(content)) {
		const textParts = content
			.map((part) => {
				if (typeof part === 'string') return part
				if (typeof part !== 'object' || part === null) return ''
				const maybeText = (part as { text?: unknown }).text
				return typeof maybeText === 'string' ? maybeText : ''
			})
			.filter((part) => part.length > 0)
		if (textParts.length > 0) {
			return textParts.join('\n')
		}
	}

	throw new Error('LLM response had no readable message content')
}

/**
 * Evaluate one function using OpenAI's chat-completions API.
 *
 * @param candidate - Function candidate details
 * @param context - Runtime context containing model + timeout
 * @returns Parsed Tier 2 evaluation from model output
 */
export async function evaluateTier2WithOpenAI(
	candidate: Tier2FunctionCandidate,
	context: Tier2EvaluatorContext,
): Promise<Tier2Evaluation> {
	const apiKey = process.env.OPENAI_API_KEY?.trim()
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is not set')
	}

	if (context.remainingMs <= 0) {
		throw new Error('Tier 2 timeout budget exhausted before request')
	}

	const apiBase = process.env.OPENAI_BASE_URL?.trim() || OPENAI_API_BASE_URL
	const endpoint = `${apiBase.replace(/\/$/, '')}/chat/completions`
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), context.remainingMs)

	let response: Response
	try {
		response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: context.model,
				temperature: 0,
				response_format: { type: 'json_object' },
				messages: [
					{
						role: 'system',
						content:
							'You score JSDoc quality for developer tooling. Return strict JSON only.',
					},
					{ role: 'user', content: buildTier2Prompt(candidate) },
				],
			}),
			signal: controller.signal,
		})
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Tier 2 provider request timed out')
		}
		throw new Error(
			`Tier 2 provider request failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		clearTimeout(timeout)
	}

	if (!response.ok) {
		let bodyText = ''
		try {
			bodyText = await response.text()
		} catch {
			bodyText = ''
		}
		const suffix = bodyText.length > 0 ? `: ${bodyText.slice(0, 240)}` : ''
		throw new Error(`Tier 2 provider returned HTTP ${response.status}${suffix}`)
	}

	let payload: unknown
	try {
		payload = await response.json()
	} catch (error) {
		throw new Error(
			`Tier 2 provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const content = extractOpenAiMessageContent(payload)
	return parseTier2EvaluationFromText(content)
}

/**
 * Convert a Tier 2 evaluation triple into one averaged score.
 *
 * @param evaluation - Parsed Tier 2 result
 * @returns Averaged score in [0,100]
 */
export function scoreTier2Evaluation(evaluation: Tier2Evaluation): number {
	const score =
		(evaluation.clarity +
			evaluation.discoverability +
			evaluation.completeness) /
		3
	return Number(score.toFixed(2))
}

/**
 * Run optional Tier 2 (LLM) checks and return merged report metadata.
 *
 * @param report - Tier 1 report used as canonical function surface
 * @param options - Parsed CLI options
 * @param evaluator - Optional evaluator override (tests/custom providers)
 * @returns Tier 2 section, warnings, and strict-failure signals
 */
export async function runTier2Assessment(
	report: JsdocHealthReport,
	options: JsdocHealthCliOptions,
	evaluator?: Tier2Evaluator,
): Promise<Tier2ExecutionResult> {
	if (!options.llmRequested) {
		return {
			tier2: createDefaultTier2Report(),
			warnings: [],
			providerFailure: false,
			timedOut: false,
		}
	}

	const model =
		process.env.JSDOC_HEALTH_MODEL?.trim() ||
		process.env.OPENAI_MODEL?.trim() ||
		DEFAULT_LLM_MODEL

	const selection = selectTier2Candidates(report, options.tier2Budgets)
	const coverage: Tier2Coverage = {
		processedFunctions: 0,
		eligibleFunctions: selection.eligibleFunctions,
		processedModules: 0,
		eligibleModules: selection.eligibleModules,
		skippedFunctions: selection.eligibleFunctions,
		skippedModules: selection.eligibleModules,
	}

	if (selection.eligibleFunctions === 0) {
		return {
			tier2: {
				status: 'skipped',
				model,
				score: null,
				coverage,
				stopReason: 'manual_skip',
				assessments: [],
			},
			warnings: ['Tier 2 skipped: no eligible functions in selected modules.'],
			providerFailure: false,
			timedOut: false,
		}
	}

	if (!evaluator && !process.env.OPENAI_API_KEY?.trim()) {
		return {
			tier2: {
				status: 'failed',
				model,
				score: null,
				coverage,
				stopReason: 'provider_error',
				assessments: [],
			},
			warnings: [
				'Tier 2 requested but OPENAI_API_KEY is not set. Falling back to Tier 1-only results.',
			],
			providerFailure: true,
			timedOut: false,
		}
	}

	const runtimeEvaluator = evaluator ?? evaluateTier2WithOpenAI
	const assessments: Tier2FunctionAssessment[] = []
	const processedModuleNames = new Set<string>()
	const warnings: string[] = []

	let stopReason = selection.stopReason
	let providerFailure = false
	let timedOut = false

	if (selection.stopReason) {
		warnings.push(
			`Tier 2 candidate set truncated by ${selection.stopReason} budget before evaluation.`,
		)
	}

	const startedAt = Date.now()
	for (const candidate of selection.candidates) {
		const elapsedMs = Date.now() - startedAt
		const remainingMs = options.tier2Budgets.timeoutMs - elapsedMs
		if (remainingMs <= 0) {
			stopReason = 'timeout'
			timedOut = true
			warnings.push('Tier 2 evaluation reached --timeout-ms budget.')
			break
		}

		let evaluation: Tier2Evaluation
		try {
			evaluation = await runtimeEvaluator(candidate, {
				model,
				remainingMs,
			})
		} catch (error) {
			if (isTier2TimeoutError(error)) {
				timedOut = true
				stopReason = 'timeout'
			} else {
				providerFailure = true
				stopReason = 'provider_error'
			}
			warnings.push(
				`Tier 2 evaluation failed for ${candidate.moduleName}.${candidate.functionName}: ${error instanceof Error ? error.message : String(error)}`,
			)
			break
		}

		const score = scoreTier2Evaluation(evaluation)
		assessments.push({
			...candidate,
			score,
			clarity: evaluation.clarity,
			discoverability: evaluation.discoverability,
			completeness: evaluation.completeness,
			summary: evaluation.summary,
		})
		processedModuleNames.add(candidate.moduleName)
	}

	coverage.processedFunctions = assessments.length
	coverage.processedModules = processedModuleNames.size
	coverage.skippedFunctions = Math.max(
		0,
		coverage.eligibleFunctions - coverage.processedFunctions,
	)
	coverage.skippedModules = Math.max(
		0,
		coverage.eligibleModules - coverage.processedModules,
	)

	const tier2Score =
		assessments.length > 0
			? Number(
					(
						assessments.reduce((sum, item) => sum + item.score, 0) /
						assessments.length
					).toFixed(2),
				)
			: null

	let status: Tier2Status = 'completed'
	if (providerFailure && assessments.length === 0) {
		status = 'failed'
	} else if (
		providerFailure ||
		stopReason === 'timeout' ||
		stopReason === 'max_modules' ||
		stopReason === 'max_functions' ||
		stopReason === 'max_tokens'
	) {
		status = 'partial'
	}

	if (assessments.length === 0 && status === 'completed') {
		status = 'skipped'
		stopReason = 'manual_skip'
	}

	return {
		tier2: {
			status,
			model,
			score: tier2Score,
			coverage,
			stopReason,
			assessments,
		},
		warnings,
		providerFailure,
		timedOut,
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

	console.log('')
	const tier2ScoreLabel =
		report.tier2.score === null ? 'n/a' : `${report.tier2.score}/100`
	console.log(
		`Tier 2 (LLM): ${report.tier2.status} (${tier2ScoreLabel})` +
			(report.tier2.model ? ` using ${report.tier2.model}` : ''),
	)
	if (report.tier2.stopReason) {
		console.log(`  stopReason: ${report.tier2.stopReason}`)
	}
	console.log(
		`  coverage: ${report.tier2.coverage.processedFunctions}/${report.tier2.coverage.eligibleFunctions} functions`,
	)

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

		if (report.tier2.assessments.length > 0) {
			console.log('')
			console.log('Tier 2 Details:')
			for (const assessment of report.tier2.assessments) {
				console.log(
					`  - ${assessment.moduleName}.${assessment.functionName} (${assessment.score}/100): ${assessment.summary}`,
				)
			}
		}
	}

	if (report.warnings.length > 0) {
		console.log('')
		console.log('Warnings:')
		for (const warning of report.warnings) {
			console.log(`  - ${warning}`)
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
  bun run jsdoc:health --llm --max-modules 3 --max-functions 40 --max-tokens 120000

Flags:
  --module, -m     Module name filter (repeatable or comma-separated)
  --json           Print JSON report to stdout
  --details        Include per-function issue rows in terminal output
  --fail-under     Exit 1 when overall score is below threshold (0-100)
  --catalog        Path to catalog JSON (default: dist/catalog.json)
  --report         Path to output report JSON (default: .artifacts/jsdoc-health-report.json)
  --llm            Enable optional Tier 2 LLM checks
  --llm-strict     Fail non-zero when Tier 2 provider/timeout/parsing fails (requires --llm)
  --max-modules    Tier 2 module budget (default: 3)
  --max-functions  Tier 2 function budget (default: 40)
  --max-tokens     Tier 2 token budget estimate (default: 120000)
  --timeout-ms     Tier 2 timeout budget in milliseconds (default: 600000)
  --help, -h       Show this usage`)
}

/**
 * Execute the health checker end-to-end.
 *
 * @param argv - Raw CLI args
 * @param rootDirOverride - Optional root directory for tests
 * @param tier2EvaluatorOverride - Optional Tier 2 evaluator override
 * @returns Process-style exit code
 */
export async function runJsdocHealth(
	argv: string[] = process.argv.slice(2),
	rootDirOverride?: string,
	tier2EvaluatorOverride?: Tier2Evaluator,
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

	let strictTier2Failure = false
	if (options.llmRequested) {
		const tier2Result = await runTier2Assessment(
			report,
			options,
			tier2EvaluatorOverride,
		)
		report.tier2 = tier2Result.tier2
		report.warnings.push(...tier2Result.warnings)
		if (
			options.llmStrict &&
			(tier2Result.providerFailure || tier2Result.timedOut)
		) {
			strictTier2Failure = true
		}
	}

	mkdirSync(dirname(reportPath), { recursive: true })
	await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)

	if (options.outputJson) {
		console.log(JSON.stringify(report, null, 2))
	} else {
		printHealthReport(report, options.details)
	}

	if (strictTier2Failure) {
		console.error(
			`Tier 2 strict mode failure: ${report.tier2.stopReason ?? 'provider_error'}.`,
		)
		return 1
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
