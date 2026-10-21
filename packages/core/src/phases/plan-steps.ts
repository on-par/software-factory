// src/phases/plan-steps.ts — PLAN prompt step 4 variants, split out of plan.ts to stay under the max-lines ceiling (#3373)

export const RIGHT_SIZE_STEP = `4. RIGHT-SIZE THE SLICE. A single BUILD pass must be bounded: aim for roughly
   5-15 minutes of agent work, a handful of files, at most ~6 target types /
   ~8 signatures / ~10 call edges in the design block. If the issue genuinely
   needs more surface than that, do NOT write a mega-spec — instead print a line
   starting with ESCALATE: asking to split the issue into smaller slices first,
   and do not write the spec file. A slice that takes 40 minutes to build is a
   planning failure, not a build problem.`;

export const RIGHT_SIZE_STEP_GATE_PASSED = `4. RIGHT-SIZE THE SLICE. The factory's deterministic size gate passed this issue: size is
   the gate's call, not yours. Do NOT print ESCALATE: about size or to ask for a split.
   Still aim for a bounded BUILD pass (roughly 5-15 minutes of agent work, a handful of
   files). If the scope really is bigger, write the full design block anyway: the factory's
   post-plan build-scope gate measures it and slices or decomposes it. You may escalate only
   for missing information or a contradiction, and must name which, as
   "ESCALATE: missing-info: <question>" or "ESCALATE: contradiction: <what conflicts>";
   then do not write the spec file.`;
