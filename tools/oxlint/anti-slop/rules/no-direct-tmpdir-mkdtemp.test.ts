import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { noDirectTmpdirMkdtempRule } from "./no-direct-tmpdir-mkdtemp.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const direct = { messageId: "directMkdtemp" };
const testFile = "packages/core/src/foo.test.ts";
const call = "mkdtemp(join(tmpdir(), 'x-'));";

tester.run("anti-slop/no-direct-tmpdir-mkdtemp", noDirectTmpdirMkdtempRule, {
	valid: [
		{ code: "createTempDirs().make('x-');", filename: testFile },
		{ code: "mkdtemp(join(root, 'x-'));", filename: testFile },
		{ code: call, filename: "packages/core/src/foo.ts" },
		{ code: call, filename: "scripts/foo.test.ts" },
		{ code: call, filename: "packages/core/src/harness/temp-dir.ts" },
		{ code: call, filename: testFile, options: [{ allowed: 1 }] },
		{ code: "const s = \"mkdtemp(join(tmpdir(), 'x-'))\";", filename: testFile },
	],
	invalid: [
		{ code: call, filename: testFile, errors: [direct] },
		{ code: "mkdtempSync(path.join(os.tmpdir(), 'x-'));", filename: testFile, errors: [direct] },
		{
			code: "await mkdtemp(\n\tjoin(\n\t\ttmpdir(),\n\t\t'x-',\n\t),\n);",
			filename: testFile,
			errors: [direct],
		},
		{ code: "mkdtemp(tmpdir());", filename: testFile, errors: [direct] },
		{ code: "fs.mkdtempSync(os.tmpdir());", filename: testFile, errors: [direct] },
		{ code: call, filename: "packages/cli/src/cli/test-support/ship-harness.ts", errors: [direct] },
		{ code: `${call}\n${call}`, filename: testFile, options: [{ allowed: 1 }], errors: [direct] },
		{ code: "const a = 1;", filename: testFile, options: [{ allowed: 2 }], errors: [{ messageId: "staleAllowance" }] },
	],
});
