import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
	type Catalog,
	cleanSignature,
	extractModuleSummary,
	generateCatalog,
	generateCatalogModuleDts,
	generateCatalogModuleJs,
	generateLlmsTxt,
	getExpectedModuleNamesFromPackageExports,
	getJsdocDescription,
	hasCatalogSkip,
	parseDeclarations,
	parseJsExportBindings,
	validateFunctionJsdoc,
} from './generate-catalog.ts'

describe('extractModuleSummary', () => {
	it('extracts first descriptive line from JSDoc block', () => {
		const source = `/**
 * Concurrency utilities for safe concurrent operations.
 *
 * Provides primitives for file locking, transactional operations.
 *
 * @module core/concurrency
 */

export { withFileLock } from './file-lock.js'`

		expect(extractModuleSummary(source)).toBe(
			'Concurrency utilities for safe concurrent operations.',
		)
	})

	it('skips @module tags and code fences', () => {
		const source = `/**
 * @module core/fs
 *
 * Filesystem utilities for Bun-native operations.
 *
 * @example
 * \`\`\`ts
 * import { readFile } from "@side-quest/core/fs";
 * \`\`\`
 */`

		expect(extractModuleSummary(source)).toBe('Filesystem utilities for Bun-native operations.')
	})

	it('returns empty string when no JSDoc block exists', () => {
		const source = `export { something } from './something.js'`
		expect(extractModuleSummary(source)).toBe('')
	})

	it('skips headings and bold feature lists', () => {
		const source = `/**
 * Terminal module - CLI output formatting using Bun's native APIs
 *
 * ## Key Features
 *
 * - **Color** formatting with Bun.color()
 * - **String width** calculation
 */`

		expect(extractModuleSummary(source)).toBe(
			"Terminal module - CLI output formatting using Bun's native APIs",
		)
	})
})

describe('hasCatalogSkip', () => {
	it('detects @catalog-skip in JSDoc', () => {
		expect(hasCatalogSkip('/** @catalog-skip */')).toBe(true)
		expect(hasCatalogSkip('/** @catalog-skip - Use color() instead */')).toBe(true)
	})

	it('returns false when not present', () => {
		expect(hasCatalogSkip('/** Apply bold style to text */')).toBe(false)
	})
})

describe('getJsdocDescription', () => {
	it('walks backwards to find description, skips code examples and tags', () => {
		const content = `/**
* Execute an operation with exclusive file lock.
*
* Prevents concurrent modifications to the same resource.
*
* @param resourceId - Unique identifier
* @returns Result of the operation
*
* @example
* \`\`\`typescript
* await withFileLock("registry", async () => { ... });
* \`\`\`
*/
declare function withFileLock<T>(resourceId: string): Promise<T>;`

		const lines = content.split('\n')
		const declIdx = lines.findIndex((l) => l.includes('declare function'))
		expect(getJsdocDescription(lines, declIdx)).toBe(
			'Execute an operation with exclusive file lock.',
		)
	})

	it('returns empty string when no JSDoc block above declaration', () => {
		const content = `declare function orphan(): void;`
		const lines = content.split('\n')
		expect(getJsdocDescription(lines, 0)).toBe('')
	})

	it('skips @param and @returns tags', () => {
		const content = `/**
* Format bytes to human-readable size.
*
* @param bytes - Number of bytes
* @returns Human-readable string
*/
declare function formatBytes(bytes: number): string;`

		const lines = content.split('\n')
		const declIdx = lines.findIndex((l) => l.includes('declare function'))
		expect(getJsdocDescription(lines, declIdx)).toBe('Format bytes to human-readable size.')
	})
})

describe('parseDeclarations', () => {
	it('finds function/class/enum/const declarations', () => {
		const dts = `declare function doStuff(x: string): boolean;
declare class MyClass {
}
declare enum OutputFormat {
	JSON = "json"
}
declare const SOME_VALUE = "hello";`

		const result = parseDeclarations(dts)
		expect(result).toHaveLength(4)
		expect(result.map((d) => d.kind)).toEqual(['function', 'class', 'enum', 'const'])
		expect(result.map((d) => d.name)).toEqual(['doStuff', 'MyClass', 'OutputFormat', 'SOME_VALUE'])
	})

	it('does NOT include type or interface declarations', () => {
		const dts = `type Foo = string;
interface Bar { x: number; }
declare function realExport(): void;`

		const result = parseDeclarations(dts)
		expect(result).toHaveLength(1)
		expect(result[0]?.name).toBe('realExport')
	})

	it('deduplicates function overloads by name', () => {
		const dts = `/**
* Register a resource (URI variant).
*/
declare function resource(name: string, uri: string): void;
declare function resource(name: string, template: object): void;`

		const result = parseDeclarations(dts)
		expect(result).toHaveLength(1)
		expect(result[0]?.name).toBe('resource')
	})

	it('handles multi-line declare const with object types', () => {
		const dts = `declare const BOX: {
	readonly topLeft: "a";
	readonly topRight: "b";
};`

		const result = parseDeclarations(dts)
		expect(result).toHaveLength(1)
		expect(result[0]?.name).toBe('BOX')
		expect(result[0]?.signature).toContain('{ ... }')
	})

	it('skips declarations with @catalog-skip in JSDoc', () => {
		const dts = `/** @catalog-skip */
declare const RESET = "\\x1b[0m";
/**
* Format a color as ANSI escape code for terminal output.
*/
declare function color(input: string): string;`

		const result = parseDeclarations(dts)
		expect(result).toHaveLength(1)
		expect(result[0]?.name).toBe('color')
	})

	it('extracts description from preceding JSDoc', () => {
		const dts = `/**
* Execute an operation with exclusive file lock.
*
* @param resourceId - The resource to lock
*/
declare function withFileLock(resourceId: string): Promise<void>;`

		const result = parseDeclarations(dts)
		expect(result[0]?.description).toBe('Execute an operation with exclusive file lock.')
	})
})

describe('parseJsExportBindings', () => {
	it('parses plain and aliased exports from generated JS', () => {
		const js = `export { tool, startServer, unescapeGitPath2 as unescapeGitPath, z };`
		expect(parseJsExportBindings(js)).toEqual([
			{ local: 'tool', exported: 'tool' },
			{ local: 'startServer', exported: 'startServer' },
			{ local: 'unescapeGitPath2', exported: 'unescapeGitPath' },
			{ local: 'z', exported: 'z' },
		])
	})

	it('parses multiline export lists', () => {
		const js = `export {
  existsSync,
  fsCopyFileSync as nodeCopyFileSync,
  readFileSync
};`
		expect(parseJsExportBindings(js)).toEqual([
			{ local: 'existsSync', exported: 'existsSync' },
			{ local: 'fsCopyFileSync', exported: 'nodeCopyFileSync' },
			{ local: 'readFileSync', exported: 'readFileSync' },
		])
	})
})

describe('getExpectedModuleNamesFromPackageExports', () => {
	it('returns module names from dist/src import targets', () => {
		const exportsField = {
			'./fs': {
				types: './dist/src/fs/index.d.ts',
				import: './dist/src/fs/index.js',
			},
			'./mcp-response': {
				types: './dist/src/mcp-response/index.d.ts',
				import: './dist/src/mcp-response/index.js',
			},
			'./catalog': {
				types: './dist/catalog.d.ts',
				import: './dist/catalog.js',
			},
			'./catalog.json': './dist/catalog.json',
			'./package.json': './package.json',
		}

		expect(getExpectedModuleNamesFromPackageExports(exportsField)).toEqual(['fs', 'mcp-response'])
	})
})

describe('cleanSignature', () => {
	it('removes declare prefix and trailing semicolon', () => {
		expect(cleanSignature('declare function foo(): void;')).toBe('function foo(): void')
	})

	it('truncates signatures >200 chars at params', () => {
		const longSig = `declare function veryLongFunction(${Array(20).fill('paramName: SomeLongGenericType<Another>').join(', ')}): Promise<void>;`
		const result = cleanSignature(longSig)
		expect(result.length).toBeLessThanOrEqual(200)
		expect(result).toContain('(...)')
	})
})

describe('validateFunctionJsdoc', () => {
	it('reports error for function with no JSDoc', () => {
		const dts = `declare function orphan(): void;`
		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test')
		expect(errors).toHaveLength(1)
		expect(errors[0]?.name).toBe('orphan')
	})

	it('reports error for function with trivial JSDoc', () => {
		const dts = `/**
* TODO
*/
declare function incomplete(): void;`
		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test')
		expect(errors).toHaveLength(1)
	})

	it('allows const/class/enum without JSDoc', () => {
		const dts = `declare const VALUE = "x";
declare class Thing {}
declare enum Mode { A = "a" }`
		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test')
		expect(errors).toHaveLength(0)
	})

	it('skips @catalog-skip declarations', () => {
		const dts = `/** @catalog-skip */
declare function hidden(): void;`
		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test')
		expect(errors).toHaveLength(0)
	})

	it('passes for function with adequate JSDoc', () => {
		const dts = `/**
* Format a color as ANSI escape code for terminal output.
*/
declare function color(input: string): string;`
		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test')
		expect(errors).toHaveLength(0)
	})

	it('validates only exported local function names when provided', () => {
		const dts = `declare function internalOnly(): void;
/**
* Public function with docs.
*/
declare function publicFn(): void;`

		const errors = validateFunctionJsdoc(dts, 'test.d.ts', 'test', new Set(['publicFn']))
		expect(errors).toHaveLength(0)
	})
})

describe('catalog module wrapper generation', () => {
	it('generates JS wrapper that reads catalog.json', () => {
		const js = generateCatalogModuleJs()
		expect(js).toContain("readFileSync(new URL('./catalog.json', import.meta.url)")
		expect(js).toContain('export default catalog')
	})

	it('generates d.ts wrapper typings', () => {
		const dts = generateCatalogModuleDts()
		expect(dts).toContain('export interface CoreApiCatalog')
		expect(dts).toContain('declare const catalog: CoreApiCatalog')
	})
})

describe('generateLlmsTxt', () => {
	const mockCatalog: Catalog = {
		schemaVersion: 1,
		packageVersion: '0.2.0',
		generated: '2026-02-09T00:00:00.000Z',
		moduleCount: 2,
		declarationCount: 5,
		modules: {
			concurrency: {
				summary: 'Concurrency utilities for safe concurrent operations',
				exports: ['withFileLock', 'Transaction'],
				declarations: [],
			},
			fs: {
				summary: 'Bun-native filesystem operations',
				exports: ['readFile', 'writeFile'],
				declarations: [],
			},
		},
	}

	it('produces valid llms.txt format with H1 and blockquote', () => {
		const result = generateLlmsTxt(mockCatalog, '@side-quest/core')
		expect(result).toContain('# @side-quest/core')
		expect(result).toContain('> 2 modules')
	})

	it('includes GitHub source links for each module', () => {
		const result = generateLlmsTxt(mockCatalog, '@side-quest/core')
		expect(result).toContain(
			'[concurrency](https://github.com/nathanvale/side-quest-core/tree/main/src/concurrency)',
		)
		expect(result).toContain('[fs](https://github.com/nathanvale/side-quest-core/tree/main/src/fs)')
	})

	it('includes link to catalog.json in Optional section', () => {
		const result = generateLlmsTxt(mockCatalog, '@side-quest/core')
		expect(result).toContain('## Optional')
		expect(result).toContain('./catalog.json')
	})

	it('sorts modules alphabetically', () => {
		const result = generateLlmsTxt(mockCatalog, '@side-quest/core')
		const concurrencyIdx = result.indexOf('concurrency')
		const fsIdx = result.indexOf('[fs]')
		expect(concurrencyIdx).toBeLessThan(fsIdx)
	})
})

// ---------------------------------------------------------------------------
// Integration test (requires dist/ from a prior build)
// ---------------------------------------------------------------------------

describe.skipIf(!existsSync('dist/src'))('integration', () => {
	it('generates catalog from real dist/ files', async () => {
		const catalog = await generateCatalog()
		const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
			exports?: unknown
		}
		const expectedModules = getExpectedModuleNamesFromPackageExports(pkg.exports)

		expect(catalog.moduleCount).toBe(expectedModules.length)
		expect(catalog.declarationCount).toBeGreaterThan(50)
		expect(Object.keys(catalog.modules).sort()).toEqual(expectedModules)

		// Spot-check known exports
		expect(catalog.modules.concurrency?.exports).toContain('withFileLock')
		expect(catalog.modules.concurrency?.exports).toContain('Transaction')
		expect(catalog.modules.terminal?.exports).toContain('color')
		expect(catalog.modules.mcp?.exports).toContain('tool')
		expect(catalog.modules.mcp?.exports).toContain('startServer')

		// Re-export + alias correctness checks
		expect(catalog.modules.git?.exports).toContain('unescapeGitPath')
		expect(catalog.modules.git?.exports).not.toContain('unescapeGitPath2')
		expect(catalog.modules.mcp?.exports).toContain('z')
		expect(catalog.modules.fs?.exports).toContain('readFileSync')

		// Wrapper artifacts exist and are importable
		expect(existsSync('dist/catalog.js')).toBe(true)
		expect(existsSync('dist/catalog.d.ts')).toBe(true)

		const { pathToFileURL } = await import('node:url')
		const { resolve: resolvePath } = await import('node:path')
		const wrapperUrl = pathToFileURL(resolvePath('dist/catalog.js')).href
		const wrapperModule = (await import(wrapperUrl)) as {
			default: { moduleCount: number; declarationCount: number }
		}
		expect(wrapperModule.default.moduleCount).toBe(catalog.moduleCount)
		expect(wrapperModule.default.declarationCount).toBe(catalog.declarationCount)

		const catalogDts = readFileSync('dist/catalog.d.ts', 'utf-8')
		expect(catalogDts).toContain('export interface CoreApiCatalog')
	})
})
