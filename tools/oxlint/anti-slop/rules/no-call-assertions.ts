import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SCANNED =
	/^(?:packages\/[^/]+\/src\/(?:.*\.test\.tsx?|(?:.*\/)?test-support\/.*\.tsx?)|scripts\/.*\.test\.ts)$/;

const CALL_MATCHERS = new Set([
	"toHaveBeenCalled",
	"toHaveBeenCalledWith",
	"toHaveBeenCalledTimes",
	"toHaveBeenCalledOnce",
	"toHaveBeenCalledExactlyOnceWith",
	"toHaveBeenCalledBefore",
	"toHaveBeenCalledAfter",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toBeCalled",
	"toBeCalledWith",
	"toBeCalledTimes",
	"lastCalledWith",
	"nthCalledWith",
	"lastReturnedWith",
	"nthReturnedWith",
]);
const RETURN_FAMILY = /^(?:toHave(?:Last|Nth)?Returned|toReturn|toHave(?:Last|Nth)?Resolved)/;
const MOCK_PROPERTIES = new Set(["calls", "results", "lastCall", "instances", "contexts", "invocationCallOrder"]);
const DISABLE_COMMENT = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\s+(.*?)(?:\s+--\s.*)?\s*$/;
const RULE_NAMES = new Set(["anti-slop/no-call-assertions", "no-call-assertions"]);

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
	return !relative.startsWith("..") && SCANNED.test(relative);
}

function readAllowed(option: unknown): number {
	if (typeof option !== "object" || option === null || Array.isArray(option)) {
		return 0;
	}
	const allowed = (option as { allowed?: unknown }).allowed;
	return typeof allowed === "number" && Number.isInteger(allowed) && allowed >= 0 ? allowed : 0;
}

function isMatcherName(name: string): boolean {
	return CALL_MATCHERS.has(name) || RETURN_FAMILY.test(name);
}

/** True when `node` is a member expression whose property is `mock`. */
function isMockMember(node: ESTree.Node): boolean {
	return (
		node.type === "MemberExpression" &&
		((!node.computed && node.property.type === "Identifier" && node.property.name === "mock") ||
			(node.computed && node.property.type === "Literal" && node.property.value === "mock"))
	);
}

function propertyKeyName(key: ESTree.Node, computed: boolean): string | undefined {
	if (!computed && key.type === "Identifier") {
		return key.name;
	}
	return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

function suppressedRules(commentText: string): string[] {
	const found = DISABLE_COMMENT.exec(commentText);
	return found?.[1] === undefined ? [] : found[1].split(/[,\s]+/).filter(Boolean);
}

/** Disallow call-count assertions and mock-call reads in tests, with a shrink-only per-file allowance. */
export const noCallAssertionsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow call-count assertions and mock-call reads in tests; assert observable behaviour.",
		},
		messages: {
			callAssertion:
				"Call-count assertion or mock-call read. Assert the observable behaviour instead (return value, resulting state, output, emitted event), or delete the test if it only proves implementation.",
			staleAllowance:
				"This file has {{actual}} call-count assertions but its allowance in call-assertions-baseline.json is {{allowed}}. Lower the entry to {{actual}}, or delete it at 0.",
			noSuppression:
				"anti-slop/no-call-assertions cannot be disabled inline. Assert observable behaviour instead; see .claude/skills/verify/SKILL.md.",
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
		let matches: ESTree.Node[] = [];
		return {
			before() {
				matches = [];
				return isInScope(context.filename, context.cwd);
			},
			CallExpression(node) {
				const callee = node.callee;
				if (
					callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.property.type === "Identifier" &&
					isMatcherName(callee.property.name)
				) {
					matches.push(node);
				}
			},
			MemberExpression(node) {
				if (!isMockMember(node.object)) {
					return;
				}
				const property = node.property;
				const name = node.computed
					? property.type === "Literal" && typeof property.value === "string"
						? property.value
						: undefined
					: property.type === "Identifier"
						? property.name
						: undefined;
				if (name !== undefined && MOCK_PROPERTIES.has(name)) {
					matches.push(node);
				}
			},
			VariableDeclarator(node) {
				if (node.id.type !== "ObjectPattern" || node.init === null || node.init === undefined) {
					return;
				}
				if (!isMockMember(node.init)) {
					return;
				}
				for (const prop of node.id.properties) {
					if (prop.type !== "Property") {
						continue;
					}
					const name = propertyKeyName(prop.key, prop.computed);
					if (name !== undefined && MOCK_PROPERTIES.has(name)) {
						matches.push(prop);
					}
				}
			},
			"Program:exit"(program) {
				const comments = context.sourceCode.getAllComments?.() ?? program.comments ?? [];
				for (const comment of comments) {
					if (suppressedRules(comment.value).some((rule) => RULE_NAMES.has(rule))) {
						context.report({ node: comment, messageId: "noSuppression" });
					}
				}
				const allowed = readAllowed(context.options?.[0]);
				if (matches.length > allowed) {
					for (const node of matches.slice(allowed)) {
						context.report({ node, messageId: "callAssertion" });
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
