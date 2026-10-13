import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

const SCOUT_AGENT = "neo-arc:neo.arc-scout";

const neoArcAssessment = defineWorkflow({
    meta: {
        name: "neo-arc-assessment",
        description:
            "Explicit-only: run only when the user asks for the neo-arc-assessment workflow by name. " +
            "Vertical slice of the Neo Arc assessment: one Neo Arc Scout call over the repository for a design question. " +
            "args: { question: string } — the architecture design question.",
        phases: [{ title: "Scout" }],
        argsSchema: {
            type: "object",
            required: ["question"],
            properties: {
                question: { type: "string" },
            },
        },
    },
    run: async (ctx) => {
        const question = ctx.args?.question;
        if (typeof question !== "string" || question.trim() === "") {
            return { ok: false, error: "question is required and must be a non-empty string" };
        }

        ctx.phase("Scout");
        let brief;
        try {
            brief = await ctx.agent(
                `Scout the repository for this architecture design question and return the reader brief:\n\n${question.trim()}`,
                { label: "neo-arc-assessment: scout", agent: SCOUT_AGENT },
            );
        } catch (err) {
            return { ok: false, error: `scout failed: ${err instanceof Error ? err.message : String(err)}` };
        }

        if (brief === null || brief === undefined || (typeof brief === "string" && brief.trim() === "")) {
            return { ok: false, error: "scout returned no brief" };
        }
        return { ok: true, scout: brief };
    },
});

await joinSession({ workflows: [neoArcAssessment] });
