import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { classifyComment, noCommentsRule } from "./no-comments.ts";

RuleTester.describe = (_name, run) => run();
RuleTester.it = (_name, run) => run();

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const sourceFile = "packages/core/src/foo.ts";
const configFile = "oxlint.config.ts";
const comment = { messageId: "comment" };
const bad = { messageId: "badDirective" };

describe("anti-slop/no-comments", () => {
	it("rejects a plain line comment", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [{ code: "// note\nconst a = 1;", filename: sourceFile, errors: [comment] }],
		});
	});

	it("rejects a plain block comment", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [{ code: "/* note */\nconst a = 1;", filename: sourceFile, errors: [comment] }],
		});
	});

	it("ignores comment-like text inside strings and templates", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [
				{ code: 'const a = "// not a comment";', filename: sourceFile },
				{ code: "const a = `/* nor this */ ${1}`;", filename: sourceFile },
				{ code: "const a = /\\/\\//;", filename: sourceFile },
			],
			invalid: [],
		});
	});

	it("allows justified oxlint and eslint disable directives", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [
				{ code: "// oxlint-disable-next-line no-console -- needed for CLI output\nconst a = 1;", filename: sourceFile },
				{ code: "/* eslint-disable max-lines, no-console -- generated table */\nconst a = 1;", filename: sourceFile },
				{ code: "const a = 1; // eslint-disable-line no-console -- #123", filename: sourceFile },
				{ code: "/* oxlint-enable no-console */\nconst a = 1;", filename: sourceFile },
			],
			invalid: [],
		});
	});

	it("rejects a disable directive without a reason", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [
				{ code: "// oxlint-disable-next-line no-console\nconst a = 1;", filename: sourceFile, errors: [bad] },
				{ code: "// oxlint-disable-next-line no-console --   \nconst a = 1;", filename: sourceFile, errors: [bad] },
			],
		});
	});

	it("rejects a disable directive without a rule name", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [
				{ code: "/* eslint-disable */\nconst a = 1;", filename: sourceFile, errors: [bad] },
				{ code: "// oxlint-disable-next-line -- reason\nconst a = 1;", filename: sourceFile, errors: [bad] },
			],
		});
	});

	it("rejects disabling anti-slop/no-comments inline", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [
				{
					code: "// oxlint-disable-next-line anti-slop/no-comments -- reason\nconst a = 1;",
					filename: sourceFile,
					errors: [{ messageId: "badDirective", data: { reason: "anti-slop/no-comments cannot be disabled inline." } }],
				},
				{ code: "/* eslint-disable no-comments -- reason */\nconst a = 1;", filename: sourceFile, errors: [bad] },
			],
		});
	});

	it("allows a comment on a rule in the lint config", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [
				{
					code: "export default {\n\trules: {\n\t\t// explains the rule\n\t\t'a/b': 'error',\n\t},\n};",
					filename: configFile,
				},
			],
			invalid: [
				{ code: "// top level\nexport default { rules: {} };", filename: configFile, errors: [comment] },
				{
					code: "export default {\n\t// not a rule\n\tplugins: [],\n\trules: {},\n};",
					filename: configFile,
					errors: [comment],
				},
				{
					code: "export default {\n\trules: {\n\t\t'a/b': 'error',\n\t},\n};\n// trailing",
					filename: configFile,
					errors: [comment],
				},
			],
		});
	});

	it("allows toolchain directives", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [
				{ code: "// @ts-expect-error legacy typing\nconst a: number = 'x';", filename: sourceFile },
				{ code: "// prettier-ignore\nconst a = 1;", filename: sourceFile },
				{ code: "// Stryker disable next-line all: equivalent mutant\nconst a = 1;", filename: sourceFile },
				{ code: "// Stryker restore all\nconst a = 1;", filename: sourceFile },
				{ code: "// @vitest-environment jsdom\nconst a = 1;", filename: sourceFile },
				{ code: "// v8 ignore next -- unreachable\nconst a = 1;", filename: sourceFile },
				{ code: "/* v8 ignore start -- @preserve */\nconst a = 1;", filename: sourceFile },
				{ code: "// v8 ignore stop\nconst a = 1;", filename: sourceFile },
				{ code: '/// <reference types="vitest" />\nconst a = 1;', filename: sourceFile },
				{ code: "const a = /*#__PURE__*/ make();", filename: sourceFile },
				{ code: "#!/usr/bin/env node\nconst a = 1;", filename: sourceFile },
			],
			invalid: [],
		});
	});

	it("rejects toolchain directives missing a required reason", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [
				{ code: "// @ts-expect-error\nconst a: number = 'x';", filename: sourceFile, errors: [bad] },
				{ code: "// Stryker disable all\nconst a = 1;", filename: sourceFile, errors: [bad] },
				{ code: "// v8 ignore next\nconst a = 1;", filename: sourceFile, errors: [bad] },
				{ code: "// @ts-ignore\nconst a = 1;", filename: sourceFile, errors: [comment] },
			],
		});
	});

	it("rejects JSDoc on an export", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [],
			invalid: [{ code: "/** Adds one. */\nexport const add = (n: number) => n + 1;", filename: sourceFile, errors: [comment] }],
		});
	});

	it("honours the per-file allowance and reports a stale allowance", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [{ code: "// one\n// two\nconst a = 1;", filename: sourceFile, options: [{ allowed: 2 }] }],
			invalid: [
				{
					code: "// one\n// two\nconst a = 1;",
					filename: sourceFile,
					options: [{ allowed: 1 }],
					errors: [comment],
				},
				{
					code: "// one\nconst a = 1;",
					filename: sourceFile,
					options: [{ allowed: 3 }],
					errors: [{ messageId: "staleAllowance" }],
				},
			],
		});
	});

	it("skips non-source extensions", () => {
		tester.run("anti-slop/no-comments", noCommentsRule, {
			valid: [
				{ code: "// note\nconst a = 1;", filename: "packages/core/src/foo.json" },
				{ code: "// note\nconst a = 1;", filename: "packages/core/src/foo.md" },
			],
			invalid: [],
		});
	});

	it("classifies comments without delimiters", () => {
		expect(classifyComment("Line", " plain")).toEqual({ kind: "disallowed" });
		expect(classifyComment("Block", "#__PURE__")).toEqual({ kind: "allowed" });
		expect(classifyComment("Line", "#__PURE__")).toEqual({ kind: "disallowed" });
		expect(classifyComment("Line", "/ <reference path='x' />")).toEqual({ kind: "allowed" });
		expect(classifyComment("Block", "/ <reference path='x' />")).toEqual({ kind: "disallowed" });
	});
});
