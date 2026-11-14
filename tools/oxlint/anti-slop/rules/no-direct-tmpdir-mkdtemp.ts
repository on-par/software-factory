import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SCANNED = /^packages\/[^/]+\/src\/(?:.*\.test\.tsx?|(?:.*\/)?test-support\/.*\.tsx?)$/;
const HELPER = "packages/core/src/harness/temp-dir.ts";
const MKDTEMP_NAMES = new Set(["mkdtemp", "mkdtempSync"]);

function toPosix(path: string): string {
	return path.replaceAll("\\", "/");
}

function relativePath(filename: string, cwd: string): string {
	const file = toPosix(filename);
	const root = toPosix(cwd).replace(/\/$/, "");
	return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : `../${file}`;
}

function isInScope(filename: string, cwd: string): boolean {
	const relative = relativePath(filename, cwd);
	return !relative.startsWith("..") && relative !== HELPER && SCANNED.test(relative);
}

/** True for `name` or `owner.name` callees (non-computed). */
function calleeMatches(callee: ESTree.Node, names: ReadonlySet<string>, owner?: string): boolean {
	if (callee.type === "Identifier") {
		return names.has(callee.name);
	}
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier" &&
		names.has(callee.property.name) &&
		(owner === undefined || (callee.object.type === "Identifier" && callee.object.name === owner))
	);
}

function isTmpdirCall(node: ESTree.Node | undefined): boolean {
	return (
		node?.type === "CallExpression" &&
		node.arguments.length === 0 &&
		(node.callee.type === "Identifier"
			? node.callee.name === "tmpdir"
			: calleeMatches(node.callee, new Set(["tmpdir"]), "os"))
	);
}

function isJoinOfTmpdir(node: ESTree.Node | undefined): boolean {
	return (
		node?.type === "CallExpression" &&
		calleeMatches(node.callee, new Set(["join"]), node.callee.type === "Identifier" ? undefined : "path") &&
		isTmpdirCall(node.arguments[0])
	);
}

function readAllowed(option: unknown): number {
	if (typeof option !== "object" || option === null || Array.isArray(option)) {
		return 0;
	}
	const allowed = (option as { allowed?: unknown }).allowed;
	return typeof allowed === "number" && Number.isInteger(allowed) && allowed >= 0 ? allowed : 0;
}

/** Disallow direct mkdtemp of tmpdir() in tests, with a shrink-only per-file allowance. */
export const noDirectTmpdirMkdtempRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow direct mkdtemp of os.tmpdir() in tests; use createTempDirs so scratch dirs are cleaned up.",
		},
		messages: {
			directMkdtemp:
				"Direct `mkdtemp`/`mkdtempSync` of `tmpdir()` in a test leaks scratch dirs. Use `createTempDirs()` (or `withTempDir`) from packages/core/src/harness/temp-dir.ts, imported via @on-par/factory-core/testing.",
			staleAllowance:
				"This file has {{actual}} direct tmpdir mkdtemp calls but its allowance in tmpdir-mkdtemp-baseline.json is {{allowed}}. Lower the entry to {{actual}}, or delete it at 0.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowed: { type: "integer", minimum: 0 },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowed: 0 }],
	},
	createOnce(context) {
		let matches: ESTree.CallExpression[] = [];
		return {
			before() {
				matches = [];
				return isInScope(context.filename, context.cwd);
			},
			CallExpression(node) {
				if (!calleeMatches(node.callee, MKDTEMP_NAMES)) {
					return;
				}
				const first = node.arguments[0];
				if (isTmpdirCall(first) || isJoinOfTmpdir(first)) {
					matches.push(node);
				}
			},
			"Program:exit"(program) {
				const allowed = readAllowed(context.options?.[0]);
				if (matches.length > allowed) {
					for (const node of matches.slice(allowed)) {
						context.report({ node, messageId: "directMkdtemp" });
					}
				} else if (matches.length < allowed) {
					context.report({
						node: program,
						messageId: "staleAllowance",
						data: { actual: String(matches.length), allowed: String(allowed) },
					});
				}
			},
		};
	},
});
