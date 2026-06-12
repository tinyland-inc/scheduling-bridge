/**
 * Volatile-state fence (c): the design (docs/design/flow-dag-formalization.md §4, risk 2)
 * calls for an ESLint ban on `Schema.declare`/`Schema.Any` in flow-state positions. This repo
 * has no ESLint infrastructure (no config, no devDependency, no lint script), so the ban ships
 * as this equivalent conformance test: it scans flow sources — src/flow/, the Acuity
 * flow-definition modules (flow-steps.ts, flows.ts, flow-pack.ts), and any other src/ module
 * that defines a FlowStateSpec — and fails on any use of the banned constructs. Comments are
 * stripped before matching so the design citations in doc comments do not trip the fence.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');

const FLOW_SOURCE_ROOTS = [join(HERE, '..')];

/**
 * Acuity flow-definition modules: flow state (FlowStateSpec), step wrappers, and the vendor
 * pack are defined here, outside src/flow/. Pinned explicitly so the fence cannot silently
 * lose them to path drift; the FlowStateSpec sweep below catches any future additions.
 */
const ACUITY_FLOW_MODULES = ['flow-steps.ts', 'flows.ts', 'flow-pack.ts'].map((name) =>
	join(SRC_ROOT, 'adapters', 'acuity', name),
);

const BANNED = /\bSchema\s*\.\s*(declare|Any)\b/g;

const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const collectSources = (root: string): string[] => {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const full = join(root, entry);
		if (statSync(full).isDirectory()) {
			if (entry === '__tests__' || entry === 'node_modules') continue;
			out.push(...collectSources(full));
			continue;
		}
		if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
	}
	return out;
};

/** Every fence-covered source file: src/flow/, the pinned Acuity flow modules, and any other
 * src/ module that defines a FlowStateSpec (so the ban holds everywhere flow state is defined). */
const collectFencedSources = (): string[] => {
	const fenced = new Set<string>(FLOW_SOURCE_ROOTS.flatMap(collectSources));
	for (const file of ACUITY_FLOW_MODULES) fenced.add(file);
	for (const file of collectSources(SRC_ROOT)) {
		if (/\bFlowStateSpec\b/.test(readFileSync(file, 'utf8'))) fenced.add(file);
	}
	return [...fenced].sort();
};

describe('flow source fences (ESLint-equivalent ban)', () => {
	it('bans Schema.declare and Schema.Any in flow-state positions', () => {
		const offenders: string[] = [];
		for (const file of collectFencedSources()) {
			const cleaned = stripComments(readFileSync(file, 'utf8'));
			const matches = [...cleaned.matchAll(BANNED)];
			if (matches.length > 0) {
				offenders.push(`${file}: ${matches.map((m) => m[0]).join(', ')}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('scans a non-empty source set (guard against silent path drift)', () => {
		const files = collectFencedSources();
		expect(files.length).toBeGreaterThanOrEqual(10);
	});

	it('covers the Acuity flow-definition modules', () => {
		const files = new Set(collectFencedSources());
		for (const module of ACUITY_FLOW_MODULES) {
			expect(files.has(module), `expected fence to cover ${module}`).toBe(true);
		}
	});
});
