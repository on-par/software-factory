import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|js|mjs)$/;
const LINT_CONFIG = "oxlint.config.ts";
const LINT_DIRECTIVE = /^(?:eslint|oxlint)-(disable-next-line|disable-line|disable|enable)\b(.*)$/s;
const STRYKER = /^Stryker (disable|restore)\b(.*)$/s;
const COVERAGE = /^[vc]8 ignore (next|start|stop|if|else|file)\b(.*)$/s;
const TRIPLE_SLASH = /^\/\s*<reference\s/;
const SELF_RULES = new Set(["anti-slop/no-comments", "no-comments"]);

export type CommentVerdict =
	| { kind: "allowed" }
	| { kind: "bad-directive"; reason: string }
	| { kind: "disallowed" };

const ALLOWED: CommentVerdict = { kind: "allowed" };
const DISALLOWED: CommentVerdict = { kind: "disallowed" };

function bad(reason: string): CommentVerdict {
	return { kind: "bad-directive", reason };
}

function toPosix(path: string): string {
	return path.replaceAll("\\", "/");
}

function relativePath(filename: string, cwd: string): string {
	const file = toPosix(filename);
	const root = toPosix(cwd).replace(/\/$/, "");
	return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : `../${file}`;
}

function readAllowed(option: unknown): number {
	if (typeof option !== "object" || option === null || Array.isArray(option)) {
		return 0;
	}
	const allowed = (option as { allowed?: unknown }).allowed;
	return typeof allowed === "number" && Number.isInteger(allowed) && allowed >= 0 ? allowed : 0;
}

function classifyLintDirective(form: string, rest: string): CommentVerdict {
	const separator = rest.indexOf(" -- ");
	const rulePart = separator === -1 ? rest : rest.slice(0, separator);
	const reason = separator === -1 ? "" : rest.slice(separator + 4).trim();
	const rules = rulePart.split(/[,\s]+/).filter(Boolean);
	if (rules.length === 0) {
		return bad("Name the rule(s) this directive applies to.");
	}
	if (rules.some((rule) => SELF_RULES.has(rule))) {
		return bad("anti-slop/no-comments cannot be disabled inline.");
	}
	if (form !== "enable" && reason === "") {
		return bad("Add `-- <reason or #issue>` after the rule names.");
	}
	return ALLOWED;
}

function classifyCoverage(form: string, rest: string): CommentVerdict {
	if (form === "stop") {
		return ALLOWED;
	}
	const separator = rest.indexOf(" -- ");
	if (separator !== -1 && rest.slice(separator + 4).trim() !== "") {
		return ALLOWED;
	}
	return bad("Add `-- <reason>` to the coverage ignore directive.");
}

export function classifyComment(kind: "Line" | "Block", value: string): CommentVerdict {
	const text = value.trim();
	const lint = LINT_DIRECTIVE.exec(text);
	if (lint?.[1] !== undefined) {
		return classifyLintDirective(lint[1], lint[2] ?? "");
	}
	if (text.startsWith("@ts-expect-error")) {
		return text.slice("@ts-expect-error".length).trim() === ""
			? bad("Add a reason after @ts-expect-error.")
			: ALLOWED;
	}
	if (text.startsWith("@ts-ignore") || text.startsWith("@ts-nocheck")) {
		return DISALLOWED;
	}
	if (text === "prettier-ignore") {
		return ALLOWED;
	}
	const stryker = STRYKER.exec(text);
	if (stryker !== null) {
		if (stryker[1] === "restore") {
			return ALLOWED;
		}
		const colon = (stryker[2] ?? "").indexOf(":");
		return colon !== -1 && (stryker[2] ?? "").slice(colon + 1).trim() !== ""
			? ALLOWED
			: bad("Add `: <reason>` to the Stryker disable directive.");
	}
	if (/^@vitest-environment\s+\S/.test(text)) {
		return ALLOWED;
	}
	const coverage = COVERAGE.exec(text);
	if (coverage?.[1] !== undefined) {
		return classifyCoverage(coverage[1], coverage[2] ?? "");
	}
	if (kind === "Line" && TRIPLE_SLASH.test(value)) {
		return ALLOWED;
	}
	if (kind === "Block" && (text === "#__PURE__" || text === "@__PURE__")) {
		return ALLOWED;
	}
	return DISALLOWED;
}

function isRulesObjectProperty(node: ESTree.Node | null | undefined): boolean {
	let current = node;
	while (current && current.type !== "Property") {
		current = current.parent;
	}
	const container = current?.parent;
	const owner = container?.parent;
	return (
		container?.type === "ObjectExpression" &&
		owner?.type === "Property" &&
		owner.value === container &&
		((owner.key.type === "Identifier" && owner.key.name === "rules") ||
			(owner.key.type === "Literal" && owner.key.value === "rules"))
	);
}

export const noCommentsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow comments except justified lint overrides and toolchain directives, with a shrink-only per-file allowance.",
		},
		messages: {
			comment:
				"Comments are not allowed. Express the rule as a type, test or lint rule, or delete it; see .claude/skills/verify/SKILL.md#comments-baseline.",
			staleAllowance:
				"This file has {{actual}} disallowed comments but its allowance in comments-baseline.json is {{allowed}}. Lower the entry to {{actual}}, or delete it at 0.",
			badDirective: "{{reason}}",
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
		let isLintConfig = false;
		return {
			before() {
				const relative = relativePath(context.filename, context.cwd);
				isLintConfig = relative === LINT_CONFIG;
				return !relative.startsWith("..") && SOURCE_EXTENSION.test(relative);
			},
			"Program:exit"(program) {
				const source = context.sourceCode;
				const comments = source.getAllComments?.() ?? program.comments ?? [];
				const disallowed: typeof comments = [];
				for (const comment of comments) {
					const commentType: string = comment.type;
					if (commentType === "Shebang") {
						continue;
					}
					const verdict = classifyComment(comment.type, comment.value);
					if (verdict.kind === "bad-directive") {
						context.report({ node: comment, messageId: "badDirective", data: { reason: verdict.reason } });
					} else if (verdict.kind === "disallowed") {
						if (isLintConfig && isRuleNote(source.text, comment.end, source)) {
							continue;
						}
						disallowed.push(comment);
					}
				}
				const allowed = readAllowed(context.options?.[0]);
				if (disallowed.length > allowed) {
					for (const comment of disallowed.slice(allowed)) {
						context.report({ node: comment, messageId: "comment" });
					}
				} else if (disallowed.length < allowed) {
					context.report({
						node: program,
						messageId: "staleAllowance",
						data: { actual: String(disallowed.length), allowed: String(allowed) },
					});
				}
			},
		};
	},
});

function isRuleNote(
	text: string,
	end: number,
	source: { getNodeByRangeIndex(index: number): ESTree.Node | null },
): boolean {
	let offset = end;
	while (offset < text.length) {
		if (/\s/.test(text.charAt(offset))) {
			offset += 1;
		} else if (text.startsWith("//", offset)) {
			const newline = text.indexOf("\n", offset);
			offset = newline === -1 ? text.length : newline + 1;
		} else if (text.startsWith("/*", offset)) {
			const close = text.indexOf("*/", offset + 2);
			offset = close === -1 ? text.length : close + 2;
		} else {
			break;
		}
	}
	return offset < text.length && isRulesObjectProperty(source.getNodeByRangeIndex(offset));
}
