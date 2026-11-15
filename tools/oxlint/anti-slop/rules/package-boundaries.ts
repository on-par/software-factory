import { readFileSync } from "node:fs";
import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const CONFIG_INDEX = /(^|\/)packages\/config\/src\/index\.ts$/;
const TEST_SUPPORT_BARE = /^@on-par\/[^/]+\/src\/(?:.*\/)?test-support(?:\/|$)/;
const INTERNAL_ALLOWED = ["packages/core/", "packages/cli/", "packages/tui/", "scripts/"];
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}

function relativePath(filename: string, cwd: string): string {
	const file = toPosix(filename);
	const root = toPosix(cwd).replace(/\/$/, "");
	return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : `../${file}`;
}

function readAllowedFiles(option: unknown): ReadonlySet<string> {
	if (typeof option !== "object" || option === null || Array.isArray(option)) {
		return new Set();
	}
	const files = (option as { testingAllowedFiles?: unknown }).testingAllowedFiles;
	return new Set(Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : []);
}

function isSubpath(spec: string, base: string): boolean {
	return spec === base || spec.startsWith(`${base}/`);
}

/** Names of runtime dependency fields declared in a package manifest, or undefined when unreadable. */
function runtimeDependencies(manifestPath: string): string[] | undefined {
	try {
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (typeof manifest !== "object" || manifest === null) {
			return undefined;
		}
		const names: string[] = [];
		for (const field of DEP_FIELDS) {
			const section = (manifest as Record<string, unknown>)[field];
			if (typeof section === "object" && section !== null) {
				names.push(...Object.keys(section));
			}
		}
		return names;
	} catch {
		return undefined;
	}
}

/** Enforce package dependency direction, published-name imports and the core subpath boundary. */
export const packageBoundariesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Enforce config ← core ← cli, published-name cross-package imports and the ADR-0004 core subpath boundary.",
		},
		messages: {
			testSupportImport:
				"`src/test-support/` is package-private (ADR-0004). Do not import another package's test-support; copy the helper or expose it through `@on-par/factory-core/testing`.",
			configImportsWorkspace:
				"packages/config must stay zero-dependency (dependency direction config ← core ← cli). Do not import `{{spec}}` from config.",
			coreImportsUpstream:
				"core must not import `{{spec}}` (dependency direction config ← core ← cli; tui sits above core).",
			relativeCrossesPackage:
				"Relative import `{{spec}}` leaves packages/{{pkg}}. Import other packages by published name (`@on-par/...`), never by a relative path.",
			deepSrcImport:
				"Do not deep-import another package's `src/` (`{{spec}}`). Import its published entry point.",
			coreInternalSubpath:
				"`@on-par/factory-core/internal` is for this repo's cli, tui and scripts/ only (ADR-0004). Import from the public root `@on-par/factory-core` instead.",
			coreTestingSubpath:
				"`@on-par/factory-core/testing` holds test doubles and may be imported only from test files and test-support (ADR-0004).",
			configRuntimeDependencies:
				"packages/config must declare no runtime dependencies (zero-dependency config ← core ← cli); remove {{names}} from packages/config/package.json.",
			configManifestUnreadable: "Could not read or parse {{path}} to check that packages/config is zero-dependency.",
		},
		schema: [
			{
				type: "object",
				properties: {
					testingAllowedFiles: { type: "array", items: { type: "string" } },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ testingAllowedFiles: [] }],
	},
	createOnce(context) {
		let rel = "";
		let importerPkg: string | undefined;
		let allowedFiles: ReadonlySet<string> = new Set();

		function testSupportTarget(spec: string): boolean {
			if (TEST_SUPPORT_BARE.test(spec)) {
				return true;
			}
			if (importerPkg === undefined || !spec.startsWith(".")) {
				return false;
			}
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
			const match = /^packages\/([^/]+)\/src\/(?:.*\/)?test-support(?:\/|$)/.exec(target);
			return match !== null && match[1] !== importerPkg;
		}

		function check(spec: string, node: ESTree.Node): void {
			const report = (messageId: string, data: Record<string, string> = {}): void => {
				context.report({ node, messageId, data });
			};
			if (testSupportTarget(spec)) {
				report("testSupportImport");
			} else if (importerPkg === "config" && spec.startsWith("@on-par/")) {
				report("configImportsWorkspace", { spec });
			} else if (importerPkg === "core" && /^@on-par\/factory-(?:cli|tui)(?:\/|$)/.test(spec)) {
				report("coreImportsUpstream", { spec });
			} else if (
				importerPkg !== undefined &&
				spec.startsWith(".") &&
				!path.posix
					.normalize(path.posix.join(path.posix.dirname(rel), spec))
					.startsWith(`packages/${importerPkg}/`)
			) {
				report("relativeCrossesPackage", { spec, pkg: importerPkg });
			} else if (importerPkg !== undefined && /^@on-par\/[^/]+\/src(?:\/|$)/.test(spec)) {
				report("deepSrcImport", { spec });
			} else if (isSubpath(spec, "@on-par/factory-core/internal")) {
				if (!INTERNAL_ALLOWED.some((prefix) => rel.startsWith(prefix))) {
					report("coreInternalSubpath");
				}
			} else if (spec === "@on-par/factory-core/testing") {
				const permitted = /\.test\.tsx?$/.test(rel) || /(^|\/)test-support\//.test(rel) || allowedFiles.has(rel);
				if (!permitted) {
					report("coreTestingSubpath");
				}
			}
		}

		function checkSource(source: ESTree.Node | null | undefined): void {
			if (source?.type === "Literal" && typeof source.value === "string") {
				check(source.value, source);
			}
		}

		return {
			before() {
				rel = relativePath(context.filename, context.cwd);
				if (!(rel.startsWith("packages/") || rel.startsWith("scripts/") || CONFIG_INDEX.test(rel))) {
					return false;
				}
				importerPkg = /^packages\/([^/]+)\//.exec(rel)?.[1];
				allowedFiles = readAllowedFiles(context.options?.[0]);
				return true;
			},
			ImportDeclaration(node) {
				checkSource(node.source);
			},
			ExportNamedDeclaration(node) {
				checkSource(node.source);
			},
			ExportAllDeclaration(node) {
				checkSource(node.source);
			},
			ImportExpression(node) {
				checkSource(node.source);
			},
			Program(program) {
				if (!CONFIG_INDEX.test(rel)) {
					return;
				}
				const manifest = path.join(path.dirname(context.filename), "..", "package.json");
				const names = runtimeDependencies(manifest);
				if (names === undefined) {
					context.report({ node: program, messageId: "configManifestUnreadable", data: { path: manifest } });
				} else if (names.length > 0) {
					context.report({
						node: program,
						messageId: "configRuntimeDependencies",
						data: { names: names.join(", ") },
					});
				}
			},
		};
	},
});
