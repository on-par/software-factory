import { RuleTester } from "oxlint/plugins-dev";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { packageBoundariesRule } from "./package-boundaries.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const NAME = "anti-slop/package-boundaries";
const FIXTURE_CONFIG = "tools/oxlint/anti-slop/rules/__fixtures__/package-boundaries/packages/config/src/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function adr(messageId: string) {
	expect(packageBoundariesRule.meta?.messages?.[messageId]).toContain("ADR-0004");
	return { messageId };
}

describe("config imports a workspace package", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import { x } from '@on-par/factory-core';",
				filename: "packages/config/src/defaults.ts",
				errors: [{ messageId: "configImportsWorkspace" }],
			},
			{
				code: "export * from '@on-par/contracts';",
				filename: "packages/config/src/defaults.ts",
				errors: [{ messageId: "configImportsWorkspace" }],
			},
		],
	});
});

describe("config declares runtime dependencies", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [{ code: "export {};", filename: FIXTURE_CONFIG, cwd: REPO_ROOT, errors: [{ messageId: "configRuntimeDependencies" }] }],
	});
});

describe("core imports cli or tui", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '@on-par/factory-cli';",
				filename: "packages/core/src/run/x.ts",
				errors: [{ messageId: "coreImportsUpstream" }],
			},
			{
				code: "import x from '@on-par/factory-tui';",
				filename: "packages/core/src/run/x.ts",
				errors: [{ messageId: "coreImportsUpstream" }],
			},
			{
				code: "await import('@on-par/factory-tui');",
				filename: "packages/core/src/run/x.ts",
				errors: [{ messageId: "coreImportsUpstream" }],
			},
		],
	});
});

describe("relative import crosses a package root", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '../../../cli/src/cli/index.js';",
				filename: "packages/core/src/run/x.ts",
				errors: [{ messageId: "relativeCrossesPackage" }],
			},
		],
	});
});

describe("deep import of another package src", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '@on-par/factory-core/src/index.js';",
				filename: "packages/cli/src/cli/x.ts",
				errors: [{ messageId: "deepSrcImport" }],
			},
		],
	});
});

describe("test-support imported from another package", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '../../../cli/src/cli/test-support/ship-harness.js';",
				filename: "packages/core/src/run/x.test.ts",
				errors: [adr("testSupportImport")],
			},
			{
				code: "import x from '@on-par/factory-cli/src/cli/test-support/ship-harness.js';",
				filename: "packages/core/src/run/x.test.ts",
				errors: [adr("testSupportImport")],
			},
		],
	});
});

describe("core internal subpath outside cli tui scripts", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '@on-par/factory-core/internal';",
				filename: "packages/contracts/src/x.ts",
				errors: [adr("coreInternalSubpath")],
			},
			{
				code: "import x from '@on-par/factory-core/internal';",
				filename: "packages/config/src/x.ts",
				errors: [{ messageId: "configImportsWorkspace" }],
			},
		],
	});
});

describe("core testing subpath outside tests", () => {
	tester.run(NAME, packageBoundariesRule, {
		valid: [],
		invalid: [
			{
				code: "import x from '@on-par/factory-core/testing';",
				filename: "packages/cli/src/cli/x.ts",
				errors: [adr("coreTestingSubpath")],
			},
			{
				code: "import x from '@on-par/factory-core/testing';",
				filename: "scripts/foo.ts",
				errors: [adr("coreTestingSubpath")],
			},
		],
	});
});

describe("permitted edges", () => {
	const internal = "import x from '@on-par/factory-core/internal';";
	const testing = "import x from '@on-par/factory-core/testing';";
	tester.run(NAME, packageBoundariesRule, {
		valid: [
			{ code: internal, filename: "packages/cli/src/cli/x.ts" },
			{ code: internal, filename: "packages/tui/src/x.ts" },
			{ code: internal, filename: "scripts/x.ts" },
			{ code: internal, filename: "packages/core/src/internal-surface.test.ts" },
			{ code: testing, filename: "packages/cli/src/x.test.ts" },
			{ code: testing, filename: "packages/cli/src/cli/test-support/x.ts" },
			{ code: testing, filename: "scripts/eval.ts", options: [{ testingAllowedFiles: ["scripts/eval.ts"] }] },
			{ code: "import x from './x.js';", filename: "packages/core/src/run/y.ts" },
			{ code: "import x from '../utils/x.js';", filename: "packages/core/src/run/y.ts" },
			{ code: "import x from '@on-par/factory-core';", filename: "packages/tui/src/x.ts" },
			{ code: "import x from 'zod';", filename: "packages/config/src/x.ts" },
			{
				code: "import x from '../packages/cli/src/cli/json-contract.js';",
				filename: "scripts/gen-cli-json-schemas.ts",
			},
			{ code: "import x from '@on-par/factory-cli';", filename: "evals/x.ts" },
			{ code: "export {};", filename: "packages/config/src/index.ts", cwd: REPO_ROOT },
		],
		invalid: [],
	});
});
