#!/usr/bin/env bun
/**
 * Generate API catalog from built .d.ts files and source barrel modules.
 *
 * Produces four artifacts:
 * - dist/catalog.json  -- structured JSON for programmatic consumption
 * - dist/catalog.js    -- runtime wrapper for Node/Bun subpath import
 * - dist/catalog.d.ts  -- types for the catalog wrapper
 * - dist/llms.txt      -- llms.txt community standard for ecosystem tools
 *
 * Runs as a postbuild step after `bunx bunup`.
 *
 * @example
 * ```bash
 * bun scripts/generate-catalog.ts
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isMainScript } from '../src/terminal/index.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single runtime declaration extracted from a .d.ts file */
export interface Declaration {
	name: string
	kind: 'function' | 'class' | 'enum' | 'const'
	signature: string
	description: string
}

/** A runtime export binding from generated JS (local -> exported) */
export interface ExportBinding {
	local: string
	exported: string
}

/** A module entry in the catalog */
export interface ModuleEntry {
	summary: string
	exports: string[]
	declarations: Declaration[]
}

/** The full catalog structure */
export interface Catalog {
	schemaVersion: number
	packageVersion: string
	generated: string
	moduleCount: number
	declarationCount: number
	modules: Record<string, ModuleEntry>
}

/** Validation error for missing JSDoc */
export interface JsdocError {
	file: string
	line: number
	name: string
	signature: string
	sourceHint: string
}

// ---------------------------------------------------------------------------
// Module summary extraction (from source barrel files)
// ---------------------------------------------------------------------------

/**
 * Extract the first descriptive line from a module's top-level JSDoc block.
 *
 * Reads `src/{module}/index.ts` and finds the opening `/** ... * /` block.
 * Skips `@module`, `@packageDocumentation`, `@example` tags, and code fences.
 * Returns the first line that looks like a real English sentence.
 *
 * @param sourceContent - Content of the source barrel file
 * @returns First descriptive line, or empty string if none found
 */
export function extractModuleSummary(sourceContent: string): string {
	// Find the first JSDoc block at the top of the file
	const jsdocMatch = sourceContent.match(/^\s*\/\*\*([\s\S]*?)\*\//)
	if (!jsdocMatch) return ''

	const block = jsdocMatch[1] as string
	const lines = block.split('\n')

	let inCodeFence = false

	for (const raw of lines) {
		const line = raw.replace(/^\s*\*\s?/, '').trim()

		// Track code fences
		if (line.startsWith('```')) {
			inCodeFence = !inCodeFence
			continue
		}
		if (inCodeFence) continue

		// Skip tags
		if (line.startsWith('@module')) continue
		if (line.startsWith('@packageDocumentation')) continue
		if (line.startsWith('@example')) continue
		if (line.startsWith('@')) continue

		// Skip empty lines
		if (line.length === 0) continue

		// Skip headings (## Key Features, etc.)
		if (line.startsWith('#')) continue

		// Skip list items that look like feature lists
		if (line.startsWith('- **')) continue

		// Must look like a real sentence (>10 chars, starts with a letter)
		if (line.length > 10 && /^[A-Z]/.test(line)) {
			return line
		}
	}

	return ''
}

// ---------------------------------------------------------------------------
// Declaration parsing (from .d.ts files)
// ---------------------------------------------------------------------------

/**
 * Check if a JSDoc block contains @catalog-skip.
 *
 * @param jsdocBlock - Raw JSDoc text including delimiters
 * @returns True if @catalog-skip is present
 */
export function hasCatalogSkip(jsdocBlock: string): boolean {
	return /@catalog-skip/.test(jsdocBlock)
}

/**
 * Extract JSDoc description by walking backwards from a declaration line.
 *
 * Skips `@param`, `@returns`, `@example`, `@catalog-skip` tags,
 * code fence content, and lines that look like code examples.
 * Returns the first line that looks like a real English sentence.
 *
 * @param lines - All lines from the .d.ts file
 * @param declLineIndex - Index of the declaration line
 * @returns Description string, or empty string if none found
 */
export function getJsdocDescription(
	lines: string[],
	declLineIndex: number,
): string {
	// Walk backwards to find the closing */ of a JSDoc block
	let endIdx = -1
	for (let i = declLineIndex - 1; i >= 0; i--) {
		const trimmed = (lines[i] as string).trim()
		if (trimmed === '') continue
		if (trimmed.endsWith('*/')) {
			endIdx = i
			break
		}
		// If we hit something that isn't whitespace or JSDoc close, no JSDoc
		break
	}

	if (endIdx === -1) return ''

	// Walk backwards to find the opening /**
	let startIdx = -1
	for (let i = endIdx; i >= 0; i--) {
		if ((lines[i] as string).trim().startsWith('/**')) {
			startIdx = i
			break
		}
	}

	if (startIdx === -1) return ''

	// Parse the JSDoc block
	const jsdocLines = lines.slice(startIdx, endIdx + 1)
	const candidates: string[] = []
	let inCodeFence = false

	for (const raw of jsdocLines) {
		const line = raw
			.replace(/^\s*\/?\*+\s?/, '')
			.replace(/\*\/\s*$/, '')
			.trim()

		// Track code fences
		if (line.startsWith('```')) {
			inCodeFence = !inCodeFence
			continue
		}
		if (inCodeFence) continue

		// Skip tags
		if (line.startsWith('@param')) continue
		if (line.startsWith('@returns')) continue
		if (line.startsWith('@example')) continue
		if (line.startsWith('@catalog-skip')) continue
		if (line.startsWith('@template')) continue
		if (line.startsWith('@throws')) continue
		if (line.startsWith('@default')) continue
		if (line.startsWith('@module')) continue
		if (line.startsWith('@')) continue

		// Skip empty
		if (line.length === 0) continue

		// Skip lines that look like code examples
		if (/^(const |let |var |await |import |console\.|\/\/)/.test(line)) continue

		// Skip headings
		if (line.startsWith('#')) continue

		// Skip list items with bold labels (feature lists)
		if (line.startsWith('- **')) continue

		// Collect candidate description lines (>10 chars, starts with letter)
		if (line.length > 10 && /^[A-Za-z]/.test(line)) {
			candidates.push(line)
		}
	}

	// Return first candidate
	return candidates[0] ?? ''
}

/**
 * Get the full JSDoc block text preceding a declaration line.
 *
 * @param lines - All lines from the .d.ts file
 * @param declLineIndex - Index of the declaration line
 * @returns Full JSDoc block text, or empty string if none found
 */
export function getJsdocBlock(lines: string[], declLineIndex: number): string {
	// Walk backwards to find the closing */
	let endIdx = -1
	for (let i = declLineIndex - 1; i >= 0; i--) {
		const trimmed = (lines[i] as string).trim()
		if (trimmed === '') continue
		if (trimmed.endsWith('*/')) {
			endIdx = i
			break
		}
		break
	}

	if (endIdx === -1) return ''

	// Walk backwards to find the opening /**
	let startIdx = -1
	for (let i = endIdx; i >= 0; i--) {
		if ((lines[i] as string).trim().startsWith('/**')) {
			startIdx = i
			break
		}
	}

	if (startIdx === -1) return ''

	return lines.slice(startIdx, endIdx + 1).join('\n')
}

/**
 * Clean a declaration signature for catalog output.
 *
 * - Removes `declare ` prefix
 * - Collapses multi-line generic signatures onto one line
 * - Truncates signatures >200 chars at the params
 *
 * @param signature - Raw declaration signature (may be multi-line)
 * @returns Cleaned signature string
 */
export function cleanSignature(signature: string): string {
	// Remove declare prefix
	let sig = signature.replace(/^declare\s+/, '')

	// Collapse to one line
	sig = sig
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()

	// Remove trailing semicolon
	sig = sig.replace(/;$/, '')

	// Truncate if >200 chars
	if (sig.length > 200) {
		// Try to truncate at the params for functions
		const parenIdx = sig.indexOf('(')
		if (parenIdx !== -1) {
			// Find return type
			const colonAfterParen = sig.lastIndexOf('): ')
			if (colonAfterParen !== -1) {
				const returnType = sig.slice(colonAfterParen + 2).trim()
				const name = sig.slice(0, parenIdx)
				sig = `${name}(...): ${returnType}`
			} else {
				sig = `${sig.slice(0, parenIdx)}(...)`
			}
		} else {
			sig = `${sig.slice(0, 197)}...`
		}
	}

	return sig
}

/**
 * Parse runtime declarations from a .d.ts file's content.
 *
 * Finds all `declare function|class|enum|const` lines (runtime exports only).
 * Skips `type` and `interface` declarations.
 * Deduplicates by name (handles function overloads).
 * Handles multi-line `declare const` with object types using brace counting.
 * Skips declarations tagged with `@catalog-skip`.
 *
 * @param dtsContent - Content of a .d.ts file
 * @returns Array of parsed declarations
 */
export function parseDeclarations(dtsContent: string): Declaration[] {
	const lines = dtsContent.split('\n')
	const declarations: Declaration[] = []
	const seenNames = new Set<string>()

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] as string).trim()

		// Match declare function/class/enum/const
		const match = line.match(/^declare\s+(function|class|enum|const)\s+(\w+)/)
		if (!match) continue

		const kind = match[1] as Declaration['kind']
		const name = match[2] as string

		// Deduplicate (function overloads)
		if (seenNames.has(name)) continue

		// Check for @catalog-skip in preceding JSDoc
		const jsdocBlock = getJsdocBlock(lines, i)
		if (jsdocBlock && hasCatalogSkip(jsdocBlock)) continue

		// Build the full signature
		let signature = line

		if (kind === 'const') {
			// Handle multi-line const with object types (brace counting)
			let braceCount = 0
			let foundBrace = false

			for (let j = 0; j < signature.length; j++) {
				if (signature[j] === '{') {
					braceCount++
					foundBrace = true
				}
				if (signature[j] === '}') braceCount--
			}

			if (foundBrace && braceCount > 0) {
				// Multi-line - read until braces balance
				let fullSig = line
				let lineIdx = i + 1
				while (braceCount > 0 && lineIdx < lines.length) {
					const nextLine = lines[lineIdx] as string
					fullSig += ` ${nextLine.trim()}`
					for (let j = 0; j < nextLine.length; j++) {
						if (nextLine[j] === '{') braceCount++
						if (nextLine[j] === '}') braceCount--
					}
					lineIdx++
				}

				// Truncate object type to `const NAME: { ... }`
				const colonIdx = line.indexOf(':')
				if (colonIdx !== -1) {
					signature = `${line.slice(0, colonIdx)}: { ... }`
				} else {
					signature = fullSig
				}
			}
		} else if (kind === 'function') {
			// Check if function signature spans multiple lines (unclosed parens)
			let parenCount = 0
			for (let j = 0; j < signature.length; j++) {
				if (signature[j] === '(') parenCount++
				if (signature[j] === ')') parenCount--
			}

			if (parenCount > 0) {
				let fullSig = line
				let lineIdx = i + 1
				while (parenCount > 0 && lineIdx < lines.length) {
					const nextLine = (lines[lineIdx] as string).trim()
					fullSig += ` ${nextLine}`
					for (let j = 0; j < nextLine.length; j++) {
						if (nextLine[j] === '(') parenCount++
						if (nextLine[j] === ')') parenCount--
					}
					lineIdx++
				}
				// May need to grab the return type on the next line
				if (lineIdx < lines.length) {
					const nextLine = (lines[lineIdx] as string).trim()
					if (nextLine.startsWith(':')) {
						fullSig += ` ${nextLine}`
					}
				}
				signature = fullSig
			}
		} else if (kind === 'class') {
			// For classes, just take the first line (class NAME { ... })
			// We don't need the full class body
			const braceIdx = line.indexOf('{')
			if (braceIdx !== -1) {
				signature = line.slice(0, braceIdx).trim()
			}
			// If extends or implements across lines, grab those
			if (!line.includes('{') && !line.endsWith(';')) {
				let fullSig = line
				let lineIdx = i + 1
				while (lineIdx < lines.length) {
					const nextLine = (lines[lineIdx] as string).trim()
					if (nextLine.startsWith('{') || nextLine === '') break
					fullSig += ` ${nextLine}`
					lineIdx++
				}
				signature = fullSig
			}
		}

		const description = getJsdocDescription(lines, i)
		const cleaned = cleanSignature(signature)

		seenNames.add(name)
		declarations.push({
			name,
			kind,
			signature: cleaned,
			description,
		})
	}

	return declarations
}

/**
 * Parse runtime export bindings from generated JavaScript.
 *
 * Supports export lists such as:
 * `export { a, b as c }`
 *
 * @param jsContent - Content of generated module JS
 * @returns Export bindings in declaration order
 */
export function parseJsExportBindings(jsContent: string): ExportBinding[] {
	const bindings: ExportBinding[] = []
	const exportListRegex = /export\s*\{([\s\S]*?)\};?/g

	for (const match of jsContent.matchAll(exportListRegex)) {
		const body = match[1] ?? ''
		for (const rawPart of body.split(',')) {
			const part = rawPart.trim()
			if (!part || part === 'default') continue

			if (part.includes(' as ')) {
				const [local, exported] = part.split(/\s+as\s+/)
				if (!local || !exported) continue
				bindings.push({ local: local.trim(), exported: exported.trim() })
				continue
			}

			bindings.push({ local: part, exported: part })
		}
	}

	return bindings
}

/**
 * Normalize an export binding identifier by stripping TS export modifiers.
 *
 * `.d.ts` export lists can include `type Foo` or `typeof Foo` entries.
 * Runtime declaration matching needs the raw identifier (`Foo`).
 *
 * @param rawName - Raw binding name from export list parsing
 * @returns Normalized identifier
 */
export function normalizeExportBindingName(rawName: string): string {
	return rawName
		.replace(/^type\s+/, '')
		.replace(/^typeof\s+/, '')
		.trim()
}

/**
 * Build a map of exported runtime names to local declaration names from `.d.ts`.
 *
 * This handles cases where `.d.ts` keeps a suffixed local symbol name
 * (`unescapeGitPath2`) but exports it under the public runtime name
 * (`unescapeGitPath`).
 *
 * @param dtsContent - Content of generated module .d.ts
 * @param declarationByLocalName - Runtime declarations keyed by local name
 * @returns Exported name -> local declaration name map
 */
export function mapDtsExportedRuntimeNamesToLocals(
	dtsContent: string,
	declarationByLocalName: ReadonlyMap<string, Declaration>,
): Map<string, string> {
	const map = new Map<string, string>()
	for (const binding of parseJsExportBindings(dtsContent)) {
		const local = normalizeExportBindingName(binding.local)
		const exported = normalizeExportBindingName(binding.exported)
		if (!local || !exported) continue
		if (!declarationByLocalName.has(local)) continue
		if (!map.has(exported)) {
			map.set(exported, local)
		}
	}
	return map
}

/**
 * Resolve which declaration local name corresponds to a JS export binding.
 *
 * @param binding - Runtime binding from generated JS
 * @param declarationByLocalName - Runtime declarations keyed by local name
 * @param dtsExportedToLocal - `.d.ts` exported name to local name map
 * @returns Matching local declaration name, or null if no runtime declaration matches
 */
export function resolveDeclarationLocalNameForExportBinding(
	binding: ExportBinding,
	declarationByLocalName: ReadonlyMap<string, Declaration>,
	dtsExportedToLocal: ReadonlyMap<string, string>,
): string | null {
	const local = normalizeExportBindingName(binding.local)
	if (local && declarationByLocalName.has(local)) {
		return local
	}

	const exported = normalizeExportBindingName(binding.exported)
	if (exported && declarationByLocalName.has(exported)) {
		return exported
	}

	const mappedLocal = exported ? dtsExportedToLocal.get(exported) : undefined
	if (mappedLocal && declarationByLocalName.has(mappedLocal)) {
		return mappedLocal
	}

	return null
}

/**
 * Collect declaration names marked with @catalog-skip in .d.ts JSDoc blocks.
 *
 * @param dtsContent - Content of a .d.ts file
 * @returns Set of local declaration names to exclude from catalog exports
 */
export function getCatalogSkipDeclarationNames(
	dtsContent: string,
): Set<string> {
	const lines = dtsContent.split('\n')
	const skippedNames = new Set<string>()

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] as string).trim()
		const match = line.match(/^declare\s+(function|class|enum|const)\s+(\w+)/)
		if (!match) continue

		const name = match[2] as string
		const jsdocBlock = getJsdocBlock(lines, i)
		if (jsdocBlock && hasCatalogSkip(jsdocBlock)) {
			skippedNames.add(name)
		}
	}

	return skippedNames
}

/**
 * Derive expected module names from package.json exports by structure.
 *
 * A module export is any subpath whose `import` target matches:
 * `./dist/src/{module}/index.js`
 *
 * @param exportsField - package.json exports value
 * @returns Sorted unique list of expected module names
 */
export function getExpectedModuleNamesFromPackageExports(
	exportsField: unknown,
): string[] {
	if (!exportsField || typeof exportsField !== 'object') return []

	const modules = new Set<string>()

	for (const value of Object.values(exportsField as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue
		const importPath = (value as Record<string, unknown>).import
		if (typeof importPath !== 'string') continue

		const match = importPath.match(/^\.\/dist\/src\/([^/]+)\/index\.js$/)
		if (!match) continue
		modules.add(match[1] as string)
	}

	return Array.from(modules).sort()
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that all exported functions have JSDoc with non-trivial descriptions.
 *
 * - `declare function` without JSDoc: error
 * - `declare function` with trivial JSDoc (<=10 chars or only whitespace/tags): error
 * - `declare const/class/enum` without JSDoc: allowed
 * - Declarations with @catalog-skip: excluded from validation
 *
 * @param dtsContent - Content of a .d.ts file
 * @param filePath - Path to the .d.ts file (for error messages)
 * @param moduleName - Module name (for source hint)
 * @param exportedLocalFunctionNames - Optional set of local function names that
 * are actually exported at runtime for this module
 * @returns Array of validation errors
 */
export function validateFunctionJsdoc(
	dtsContent: string,
	filePath: string,
	moduleName: string,
	exportedLocalFunctionNames?: ReadonlySet<string>,
): JsdocError[] {
	const lines = dtsContent.split('\n')
	const errors: JsdocError[] = []
	const seenNames = new Set<string>()

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] as string).trim()

		const match = line.match(/^declare\s+function\s+(\w+)/)
		if (!match) continue

		const name = match[1] as string

		// Only validate functions that are runtime-exported from this module
		if (exportedLocalFunctionNames && !exportedLocalFunctionNames.has(name)) {
			continue
		}

		// Skip overloads (only validate first occurrence)
		if (seenNames.has(name)) continue
		seenNames.add(name)

		// Skip @catalog-skip
		const jsdocBlock = getJsdocBlock(lines, i)
		if (jsdocBlock && hasCatalogSkip(jsdocBlock)) continue

		// Check for JSDoc presence
		const description = getJsdocDescription(lines, i)
		if (!jsdocBlock || description.length <= 10) {
			// Build signature for error output
			const signature = cleanSignature(line)
			errors.push({
				file: filePath,
				line: i + 1,
				name,
				signature,
				sourceHint: `src/${moduleName}/index.ts`,
			})
		}
	}

	return errors
}

// ---------------------------------------------------------------------------
// llms.txt generation
// ---------------------------------------------------------------------------

/**
 * Generate llms.txt content following the llms.txt community standard.
 *
 * @param catalog - The generated catalog data
 * @param packageName - npm package name
 * @returns llms.txt content string
 */
export function generateLlmsTxt(catalog: Catalog, packageName: string): string {
	const moduleNames = Object.keys(catalog.modules).sort()
	const repoUrl = 'https://github.com/nathanvale/side-quest-core'

	const lines: string[] = [
		`# ${packageName}`,
		'',
		`> ${catalog.moduleCount} modules of reusable TypeScript utilities for Bun -- filesystem, MCP, concurrency, hashing, spawn, and more. Runtime exports only.`,
		'',
		`- [${packageName} on npm](https://www.npmjs.com/package/${packageName})`,
		`- [Source code](${repoUrl})`,
		'',
		'## Modules',
		'',
	]

	for (const name of moduleNames) {
		const mod = catalog.modules[name] as ModuleEntry
		const summary = mod.summary || `${name} module`
		lines.push(`- [${name}](${repoUrl}/tree/main/src/${name}): ${summary}`)
	}

	lines.push('')
	lines.push('## Optional')
	lines.push('')
	lines.push(
		'- [Full API catalog (JSON)](./catalog.json): Structured JSON with all type signatures, descriptions, and export names',
	)
	lines.push('')

	return lines.join('\n')
}

/**
 * Generate JavaScript wrapper content for `@side-quest/core/catalog`.
 *
 * Why: Node.js ESM requires import attributes for direct JSON imports.
 * This wrapper provides stable runtime loading for both Bun and Node.
 *
 * @returns JavaScript module source
 */
export function generateCatalogModuleJs(): string {
	return `import { readFileSync } from 'node:fs'

const catalog = JSON.parse(
  readFileSync(new URL('./catalog.json', import.meta.url), 'utf-8'),
)

export default catalog
`
}

/**
 * Generate TypeScript declaration content for `dist/catalog.js`.
 *
 * @returns .d.ts module source
 */
export function generateCatalogModuleDts(): string {
	return `export interface CatalogDeclaration {
  name: string
  kind: 'function' | 'class' | 'enum' | 'const'
  signature: string
  description: string
}

export interface CatalogModuleEntry {
  summary: string
  exports: string[]
  declarations: CatalogDeclaration[]
}

export interface CoreApiCatalog {
  schemaVersion: number
  packageVersion: string
  generated: string
  moduleCount: number
  declarationCount: number
  modules: Record<string, CatalogModuleEntry>
}

declare const catalog: CoreApiCatalog
export default catalog
`
}

// ---------------------------------------------------------------------------
// Main script
// ---------------------------------------------------------------------------

/**
 * Main catalog generation logic.
 *
 * @returns The generated catalog object
 * @throws Error if validation fails
 */
export async function generateCatalog(): Promise<Catalog> {
	const rootDir = resolve(import.meta.dir, '..')
	const distDir = join(rootDir, 'dist')
	const srcDir = join(rootDir, 'src')

	// Check dist exists
	if (!existsSync(distDir)) {
		throw new Error('dist/ directory not found. Run `bun run build` first.')
	}

	// Read package.json
	const pkgPath = join(rootDir, 'package.json')
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
	const packageVersion: string = pkg.version
	const packageName: string = pkg.name

	// Derive expected module names from package.json exports structure
	const expectedModuleNames = getExpectedModuleNamesFromPackageExports(
		pkg.exports,
	)
	if (expectedModuleNames.length === 0) {
		throw new Error(
			'No module exports found in package.json (expected ./dist/src/*/index.js import targets).',
		)
	}

	// Discover modules from dist/src/*/index.d.ts
	const distSrcDir = join(distDir, 'src')
	if (!existsSync(distSrcDir)) {
		throw new Error('dist/src/ directory not found. Build may have failed.')
	}

	const discoveredModuleDirs = readdirSync(distSrcDir)
		.filter((name) => {
			const dtsPath = join(distSrcDir, name, 'index.d.ts')
			return existsSync(dtsPath)
		})
		.sort()

	const missingExpectedModules = expectedModuleNames.filter(
		(name) => !discoveredModuleDirs.includes(name),
	)
	if (missingExpectedModules.length > 0) {
		throw new Error(
			`Missing built module(s) declared in package exports: ${missingExpectedModules.join(', ')}\nBuilt modules found: ${discoveredModuleDirs.join(', ')}`,
		)
	}

	// Catalog only package-exported modules to avoid accidental dist/src noise.
	const moduleDirs = expectedModuleNames
	const ignoredDiscoveredModules = discoveredModuleDirs.filter(
		(name) => !expectedModuleNames.includes(name),
	)
	if (ignoredDiscoveredModules.length > 0) {
		console.warn(
			`WARNING: Ignoring non-exported built module(s): ${ignoredDiscoveredModules.join(', ')}`,
		)
	}

	const modules: Record<string, ModuleEntry> = {}
	const allJsdocErrors: JsdocError[] = []
	const missingSummaryModules: string[] = []
	let totalDeclarations = 0

	for (const moduleName of moduleDirs) {
		// Read module summary from source
		const srcBarrelPath = join(srcDir, moduleName, 'index.ts')
		let summary = ''
		if (existsSync(srcBarrelPath)) {
			const srcContent = readFileSync(srcBarrelPath, 'utf-8')
			summary = extractModuleSummary(srcContent)
			if (!summary) {
				missingSummaryModules.push(moduleName)
			}
		} else {
			missingSummaryModules.push(moduleName)
		}

		// Parse declarations from .d.ts
		const dtsPath = join(distSrcDir, moduleName, 'index.d.ts')
		const dtsContent = readFileSync(dtsPath, 'utf-8')
		const declarations = parseDeclarations(dtsContent)
		const declarationByLocalName = new Map(
			declarations.map((declaration) => [declaration.name, declaration]),
		)
		const dtsExportedToLocal = mapDtsExportedRuntimeNamesToLocals(
			dtsContent,
			declarationByLocalName,
		)
		const skippedLocalNames = getCatalogSkipDeclarationNames(dtsContent)

		// Parse runtime export names from generated JS so aliases/re-exports stay accurate
		const jsPath = join(distSrcDir, moduleName, 'index.js')
		const jsContent = readFileSync(jsPath, 'utf-8')
		const exportBindings = parseJsExportBindings(jsContent)
		const exportedLocalFunctionNames =
			exportBindings.length > 0
				? new Set(
						exportBindings
							.map((binding) =>
								resolveDeclarationLocalNameForExportBinding(
									binding,
									declarationByLocalName,
									dtsExportedToLocal,
								),
							)
							.filter((name): name is string => name !== null)
							.filter((name) => !skippedLocalNames.has(name)),
					)
				: undefined

		// Validate function JSDoc
		const errors = validateFunctionJsdoc(
			dtsContent,
			dtsPath,
			moduleName,
			exportedLocalFunctionNames,
		)
		allJsdocErrors.push(...errors)

		const exportNames: string[] = []
		const mappedDeclarations: Declaration[] = []
		const seenExportNames = new Set<string>()

		for (const binding of exportBindings) {
			const localName = resolveDeclarationLocalNameForExportBinding(
				binding,
				declarationByLocalName,
				dtsExportedToLocal,
			)
			if (
				skippedLocalNames.has(normalizeExportBindingName(binding.local)) ||
				(localName !== null && skippedLocalNames.has(localName))
			) {
				continue
			}
			if (seenExportNames.has(binding.exported)) continue
			seenExportNames.add(binding.exported)
			exportNames.push(binding.exported)

			const declaration =
				localName === null ? undefined : declarationByLocalName.get(localName)
			if (!declaration) continue
			mappedDeclarations.push({
				...declaration,
				name: binding.exported,
			})
		}

		// Fallback for unexpected JS emit changes
		if (exportBindings.length === 0) {
			for (const declaration of declarations) {
				exportNames.push(declaration.name)
				mappedDeclarations.push(declaration)
			}
		}

		totalDeclarations += mappedDeclarations.length

		modules[moduleName] = {
			summary,
			exports: exportNames,
			declarations: mappedDeclarations,
		}
	}

	// Report missing module summaries
	if (missingSummaryModules.length > 0) {
		const files = missingSummaryModules
			.map((mod) => `  src/${mod}/index.ts`)
			.join('\n')
		throw new Error(
			`Missing top-level JSDoc summary in ${missingSummaryModules.length} module(s):\n${files}\n\nAdd a /** ... */ JSDoc block at the top of each barrel file.`,
		)
	}

	// Report JSDoc errors
	if (allJsdocErrors.length > 0) {
		const details = allJsdocErrors
			.map(
				(err) =>
					`  ${err.file}:${err.line}\n  ${err.signature}\n  -> Fix in: ${err.sourceHint}`,
			)
			.join('\n\n')
		throw new Error(
			`Missing JSDoc for ${allJsdocErrors.length} exported function(s)\n\n${details}\n\nAdd /** ... */ blocks above these functions, then re-run: bun run build`,
		)
	}

	const catalog: Catalog = {
		schemaVersion: 1,
		packageVersion,
		generated: new Date().toISOString(),
		moduleCount: moduleDirs.length,
		declarationCount: totalDeclarations,
		modules,
	}

	// Write catalog.json
	const catalogJson = JSON.stringify(catalog, null, 2)
	const catalogPath = join(distDir, 'catalog.json')
	await Bun.write(catalogPath, catalogJson)

	// Write catalog module wrapper + types
	const catalogModuleJsPath = join(distDir, 'catalog.js')
	await Bun.write(catalogModuleJsPath, generateCatalogModuleJs())
	const catalogModuleDtsPath = join(distDir, 'catalog.d.ts')
	await Bun.write(catalogModuleDtsPath, generateCatalogModuleDts())

	// Write llms.txt
	const llmsTxt = generateLlmsTxt(catalog, packageName)
	const llmsTxtPath = join(distDir, 'llms.txt')
	await Bun.write(llmsTxtPath, llmsTxt)

	// Print success summary
	const catalogSize = statSync(catalogPath).size
	const catalogModuleJsSize = statSync(catalogModuleJsPath).size
	const catalogModuleDtsSize = statSync(catalogModuleDtsPath).size
	const llmsSize = statSync(llmsTxtPath).size
	const formatSize = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`
		return `${(bytes / 1024).toFixed(1)} KB`
	}

	console.log(
		`Catalog generated: ${moduleDirs.length} modules, ${totalDeclarations} declarations`,
	)
	console.log('All exported functions documented')
	console.log(`dist/catalog.json (${formatSize(catalogSize)})`)
	console.log(`dist/catalog.js (${formatSize(catalogModuleJsSize)})`)
	console.log(`dist/catalog.d.ts (${formatSize(catalogModuleDtsSize)})`)
	console.log(`dist/llms.txt (${formatSize(llmsSize)})`)

	return catalog
}

// ---------------------------------------------------------------------------
// Entry point guard
// ---------------------------------------------------------------------------

if (isMainScript(import.meta.path)) {
	try {
		await generateCatalog()
	} catch (err) {
		console.error(err instanceof Error ? err.message : err)
		process.exit(1)
	}
}
