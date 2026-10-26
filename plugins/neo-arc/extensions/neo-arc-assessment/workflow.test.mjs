// Drives the real workflow `run` against a scripted ctx. The Copilot SDK is not installed here, so its bare specifier
// is redirected to a stub that captures the workflow definition.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { TEMPLATES } from "./helpers.mjs";

const STUB =
    "export const defineWorkflow = (d) => { globalThis.__neoArcWorkflow = d; return d; };\n" +
    "export const joinSession = async () => {};\n";
const HOOKS =
    `const STUB_URL = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(STUB)}`)};\n` +
    "export async function resolve(specifier, context, next) {\n" +
    '    if (specifier === "@github/copilot-sdk/extension") return { url: STUB_URL, shortCircuit: true };\n' +
    "    return next(specifier, context);\n" +
    "}\n";
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);
await import("./extension.mjs");
const workflow = globalThis.__neoArcWorkflow;

// findGitRoot runs from process.cwd(); point it at a throwaway repository so nothing touches this checkout.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "neo-arc-workflow-"));
await fs.mkdir(path.join(root, ".git"));
process.chdir(root);
test.after(() => fs.rm(root, { recursive: true, force: true }));

const build = (headings, body = {}) => headings.map((h) => `## ${h}\n${body[h] ?? "text"}\n`).join("\n");

const AREA_ROWS = Array.from({ length: 8 }, (_, i) => `| ${i + 1} | Area ${i + 1} | src/a${i + 1}.ts | look |`);
const SCOUT = build(TEMPLATES.scout, {
    "Shared context": "SHARED-CONTEXT",
    Areas: ["| # | Area | Anchor files | What to look for |", "| --- | --- | --- | --- |", ...AREA_ROWS].join("\n"),
    "External product": "none named",
});
const reader = (id) =>
    build(TEMPLATES.reader, {
        Area: id,
        "Reuse claims":
            id === "area-1"
                ? "| Component | Path | Grade |\n| --- | --- | --- |\n| Cache | src/cache.ts:10 | extend |"
                : "| Component | Path | Grade |\n| --- | --- | --- |\n| Other | src/other.ts:3 | verbatim |",
        Facts: `- FACT READER-FACT-${id}`,
    });
const CLAIMS_HEADER = "| # | Component | Path | Grade | How |\n| --- | --- | --- | --- | --- |";
const synth = (rows) =>
    build(TEMPLATES.synthesizer, {
        Recommendation: "SYNTHESIS-MARKER",
        "Reuse claims the recommendation depends on": [CLAIMS_HEADER, ...rows].join("\n"),
    });
const TWO_CLAIMS = ["| 1 | Cache | src/cache.ts | verbatim | as-is |", "| 2 | Queue | src/queue.ts | extend | new case |"];
const REFUTER = build(TEMPLATES.refuter, { Verdict: "holds", Confidence: "high", "Corrected grade": "extend" });

function roleOf(agent) {
    return agent.replace("neo-arc:neo.arc-", "");
}

/**
 * A scripted ctx. `readerFails` lists reader ids whose replies are off template (so they fail after one retry).
 * Refuter replies wait until the critic has been called, so a sequential critic would be observed as late.
 */
function makeCtx({ synthesis = synth(TWO_CLAIMS), readerFails = [] } = {}) {
    const calls = [];
    const parallelSizes = [];
    const phases = [];
    const steps = [];
    let criticStarted;
    const criticCalled = new Promise((resolve) => {
        criticStarted = resolve;
    });
    const state = { criticBeforeRefutersFinished: false, refutersFinished: 0 };
    const ctx = {
        args: { question: "How should we add a cache?" },
        phase: (title) => phases.push(title),
        step: async (key, fn) => {
            steps.push(key);
            return fn();
        },
        parallel: async (thunks) => {
            parallelSizes.push(thunks.length);
            return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
        },
        agent: async (prompt, opts) => {
            const role = roleOf(opts.agent);
            calls.push({ role, prompt, label: opts.label });
            switch (role) {
                case "scout":
                    return SCOUT;
                case "reader": {
                    const id = /reader (\S+) attempt/.exec(opts.label)[1];
                    return readerFails.includes(id) ? "off template" : reader(id);
                }
                case "designer":
                    return build(TEMPLATES.designer);
                case "judge":
                    return build(TEMPLATES.judge);
                case "synthesizer":
                    return synthesis;
                case "refuter": {
                    await Promise.race([criticCalled, new Promise((r) => setTimeout(r, 500))]);
                    state.refutersFinished += 1;
                    return REFUTER;
                }
                case "critic":
                    if (state.refutersFinished === 0) state.criticBeforeRefutersFinished = true;
                    criticStarted();
                    return build(TEMPLATES.critic);
                case "report":
                    return null; // stop the run before any file is written
                default:
                    throw new Error(`unexpected agent ${opts.agent}`);
            }
        },
    };
    return { ctx, calls, parallelSizes, phases, steps, state };
}

const byRole = (calls, role) => calls.filter((c) => c.role === role);

test("the critic runs in the same parallel batch as the refuters, without their verdicts", async () => {
    const { ctx, calls, parallelSizes, phases, steps, state } = makeCtx();
    const result = await workflow.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, "report");

    // readers (8), designers (3), judges (3), then one batch of 2 refuters + the critic.
    assert.deepEqual(parallelSizes, [8, 3, 3, 3]);
    assert.equal(state.criticBeforeRefutersFinished, true);
    assert.ok(phases.includes("Refuters and Critic"));
    assert.ok(!phases.includes("Critic") && !phases.includes("Refuters"));
    assert.ok(steps.every((k) => k.startsWith("assessment-v2:")), steps.join(", "));

    const [critic] = byRole(calls, "critic");
    assert.ok(critic.prompt.includes("SYNTHESIS-MARKER"));
    assert.ok(critic.prompt.includes("Evidence map:"));
    assert.ok(critic.prompt.includes("READER-FACT-area-1"));
    assert.ok(!critic.prompt.includes("Refuter verdicts"));
    assert.ok(!critic.prompt.includes("corrected grade"));

    // The report receives the verdicts paired with their claims, and the critique.
    const [report] = byRole(calls, "report");
    assert.match(report.prompt, /Refuter verdicts paired with their claims:\n- claim-1 Cache \(src\/cache\.ts\): claimed verbatim; verdict holds, confidence high, corrected grade extend/);
    assert.ok(report.prompt.includes("Critique (written alongside the refuters"));
    assert.equal(result.coverage.stages.refuter.success, 2);
    assert.equal(result.coverage.stages.critic.success, 1);
});

test("each refuter prompt carries the reader rows that mention its claim, and nothing unrelated", async () => {
    const { ctx, calls } = makeCtx();
    await workflow.run(ctx);
    const refuters = byRole(calls, "refuter");
    assert.equal(refuters.length, 2);
    const cache = refuters.find((c) => c.prompt.includes("- Component: Cache"));
    assert.ok(cache.prompt.includes("- [area-1] | Cache | src/cache.ts:10 | extend |"), cache.prompt);
    assert.ok(!cache.prompt.includes("src/other.ts"));
    assert.ok(!cache.prompt.includes("Evidence map:"));
    const queue = refuters.find((c) => c.prompt.includes("- Component: Queue"));
    assert.ok(queue.prompt.includes("(none found in the reader outputs)"));
});

test("a synthesis with no reuse claims skips the refuter stage and runs only the critic", async () => {
    const { ctx, calls, parallelSizes } = makeCtx({ synthesis: synth([]) });
    const result = await workflow.run(ctx);
    assert.equal(result.failedStage, "report");
    assert.equal(byRole(calls, "refuter").length, 0);
    assert.equal(byRole(calls, "critic").length, 1);
    assert.deepEqual(parallelSizes, [8, 3, 3, 1]);
    assert.equal(result.coverage.stages.refuter, undefined);
    assert.deepEqual(result.coverage.refuters, { attempted: 0, dropped: 0 });
    assert.ok(byRole(calls, "report")[0].prompt.includes("(no reuse claims)"));
});

test("the run aborts at the readers when more than half of the reader units fail", async () => {
    const { ctx, calls } = makeCtx({ readerFails: ["area-1", "area-2", "area-3", "area-4", "area-5"] });
    const result = await workflow.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.failedStage, "readers");
    assert.match(result.error, /^5 of 8 reader units failed \(more than half; unread: area-1, area-2, area-3, area-4, area-5\)/);
    assert.deepEqual(result.coverage.readers.unread, ["area-1", "area-2", "area-3", "area-4", "area-5"]);
    assert.equal(byRole(calls, "designer").length, 0);
    // Each failed reader got exactly one retry.
    assert.equal(byRole(calls, "reader").length, 8 + 5);
});

test("the run continues when exactly half of the reader units fail, naming them as gaps", async () => {
    const { ctx, calls } = makeCtx({ readerFails: ["area-1", "area-2", "area-3", "area-4"] });
    const result = await workflow.run(ctx);
    assert.equal(result.failedStage, "report");
    const [designer] = byRole(calls, "designer");
    assert.ok(designer.prompt.includes("Unread areas (no evidence gathered; treat as gaps): area-1, area-2, area-3, area-4"));
});

test("the run aborts when every reader fails", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `area-${i + 1}`);
    const { ctx } = makeCtx({ readerFails: ids });
    const result = await workflow.run(ctx);
    assert.equal(result.failedStage, "readers");
    assert.match(result.error, /no reader produced an accepted output/);
});
