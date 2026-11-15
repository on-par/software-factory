import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { noCallAssertionsRule } from "./no-call-assertions.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const hit = { messageId: "callAssertion" };
const testFile = "packages/core/src/foo.test.ts";
const call = "expect(fn).toHaveBeenCalled();";

tester.run("anti-slop/no-call-assertions", noCallAssertionsRule, {
	valid: [
		{ code: "const fake = () => 42; expect(sut(fake)).toBe(42);", filename: testFile },
		{
			code: 'const events: string[] = []; const fake = (e: string) => { events.push(e); }; run(fake); expect(events).toEqual(["a"]);',
			filename: testFile,
		},
		{ code: "const f = vi.fn(() => 1);", filename: testFile },
		{ code: 'const s = "expect(fn).toHaveBeenCalled()";', filename: testFile },
		{ code: call, filename: "packages/core/src/foo.ts" },
		{ code: call, filename: "tools/x.test.ts" },
		{ code: call, filename: testFile, options: [{ allowed: 1 }] },
		{ code: "// oxlint-disable-next-line no-console\nconst a = 1;", filename: testFile },
		{ code: "/* eslint-disable max-lines, no-console */\nconst a = 1;", filename: testFile },
	],
	invalid: [
		{ code: "expect(fn).toHaveBeenCalled(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledTimes(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledOnce(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledExactlyOnceWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledBefore(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalledAfter(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenLastCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveBeenNthCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toBeCalled(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toBeCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toBeCalledTimes(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).lastCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).nthCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).lastReturnedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).nthReturnedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveReturned(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveReturnedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveReturnedTimes(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveLastReturnedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveNthReturnedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toReturn(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toReturnWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toReturnTimes(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveResolved(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveResolvedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveResolvedTimes(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveLastResolvedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).toHaveNthResolvedWith(1);", filename: testFile, errors: [hit] },
		{ code: "expect(fn).not.toHaveBeenCalled();", filename: testFile, errors: [hit] },
		{ code: "expect.soft(fn).toHaveBeenCalledWith(1);", filename: testFile, errors: [hit] },
		{ code: "await expect(fn).resolves.toHaveBeenCalled();", filename: testFile, errors: [hit] },
		{ code: "fn.mock.calls;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"calls\"];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.results;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"results\"];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.lastCall;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"lastCall\"];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.instances;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"instances\"];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.contexts;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"contexts\"];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.invocationCallOrder;", filename: testFile, errors: [hit] },
		{ code: "fn.mock[\"invocationCallOrder\"];", filename: testFile, errors: [hit] },
		{ code: "vi.mocked(fn).mock.calls[0];", filename: testFile, errors: [hit] },
		{ code: "fn.mock.calls[0][1];", filename: testFile, errors: [hit] },
		{ code: "const { calls } = fn.mock;", filename: testFile, errors: [hit] },
		{ code: "const { calls, results, other } = fn.mock;", filename: testFile, errors: [hit, hit] },
		{ code: "expect(fn).toHaveBeenCalled();", filename: "packages/cli/src/cli/test-support/h.ts", errors: [hit] },
		{ code: "expect(fn).toHaveBeenCalled();", filename: "scripts/foo.test.ts", errors: [hit] },
		{ code: `${call}\n${call}`, filename: testFile, options: [{ allowed: 1 }], errors: [hit] },
		{ code: "const a = 1;", filename: testFile, options: [{ allowed: 2 }], errors: [{ messageId: "staleAllowance" }] },
		{ code: "// oxlint-disable-next-line anti-slop/no-call-assertions\nconst a = 1;", filename: testFile, errors: [{ messageId: "noSuppression" }] },
		{ code: "/* eslint-disable no-call-assertions */\nconst a = 1;", filename: testFile, errors: [{ messageId: "noSuppression" }] },
	],
});
