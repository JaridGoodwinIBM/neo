// Pure helpers for the neo-arc-assessment workflow. No SDK, no filesystem, no I/O.

/** Reuse grades a refuter may return, strongest first. */
export const REUSE_GRADES = ["verbatim", "extend", "pattern-only", "not-reusable"];

/** Required ordered `##` headings per worker (mirrors the orchestrator's template checklist). */
export const TEMPLATES = {
    scout: [
        "Question",
        "Shared context",
        "What the question means",
        "Repository state",
        "Governing documents",
        "Keyword hits",
        "Areas",
        "External product",
    ],
    reader: ["Area", "Summary", "Existing mentions of", "Reuse claims", "Gaps", "Constraints", "Facts"],
    designer: [
        "Name and thesis",
        "What the capability means here",
        "Stages",
        "New components",
        "Reused components",
        "Configuration",
        "ADR impact",
        "PRD sections touched",
        "Human gates",
        "Risks",
        "Open questions for the user",
        "Rough effort",
    ],
    judge: ["Lens", "Scores", "Winner", "Graft from the others", "Factual errors spotted"],
    synthesizer: [
        "Recommendation",
        "Phased plan",
        "Reuse claims the recommendation depends on",
        "Not reusable",
        "ADR work",
        "PRD work",
        "Decisions only the user can make",
        "Judge disagreements",
    ],
    refuter: ["Claim", "Verdict", "Confidence", "Reason", "Evidence", "Corrected grade"],
    critic: ["Missing", "Unverified claims", "Premature or overbuilt", "Sharpest question for the user"],
    report: ["Written", "Grades carried", "Unread areas"],
    factcheck: ["Check kind", "Checked", "Findings"],
};

/**
 * Validate and normalize the design question.
 * @returns {{ ok: true, question: string } | { ok: false, error: string }}
 */
export function normalizeQuestion(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return { ok: false, error: "question is required and must be a non-empty string" };
    }
    return { ok: true, question: value.trim() };
}

/**
 * Check a reply carries exactly the required `##` headings, in order, with nothing
 * before the first heading. A heading passes when its text equals the required text or
 * continues it after a non-alphanumeric boundary (a documented suffix, e.g. "Areas (3)").
 * Headings inside fenced code blocks are ignored; `###` and deeper are body, not headings.
 * @param {unknown} reply
 * @param {string[]} required
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkTemplate(reply, required) {
    if (typeof reply !== "string" || reply.trim() === "") {
        return { ok: false, problems: ["reply is empty"] };
    }
    const problems = [];
    const found = [];
    let fence = null;
    let preamble = false;
    for (const line of reply.split(/\r?\n/)) {
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (fence === null) fence = marker;
            else if (fence === marker) fence = null;
            if (found.length === 0) preamble = true;
            continue;
        }
        if (fence === null) {
            const heading = /^##[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
            if (heading) {
                found.push(heading[1]);
                continue;
            }
        }
        if (found.length === 0 && line.trim() !== "") preamble = true;
    }
    if (preamble) problems.push("content before the first heading");
    if (found.length !== required.length) {
        problems.push(`expected ${required.length} headings, found ${found.length}`);
    }
    required.forEach((name, i) => {
        const got = found[i];
        if (got === undefined) {
            problems.push(`missing heading "${name}"`);
        } else if (!(got === name || (got.startsWith(name) && !/[A-Za-z0-9]/.test(got[name.length])))) {
            problems.push(`heading ${i + 1}: expected "${name}", found "${got}"`);
        }
    });
    return { ok: problems.length === 0, problems };
}

/** Initial state for a worker run. */
export function startAttempt() {
    return { status: "pending", attempts: 0 };
}

/**
 * Deterministic one-retry transition. Feed it whether the latest reply was on template.
 * pending --on--> accepted | pending --off--> retry | retry --on--> accepted | retry --off--> failed.
 * `accepted` and `failed` are terminal; `retry` means "re-run once". Never returns a third attempt.
 * @param {{ status: string, attempts: number }} state
 * @param {boolean} onTemplate
 */
export function nextAttempt(state, onTemplate) {
    if (state.status === "accepted" || state.status === "failed") return state;
    if (state.attempts >= 2 && !onTemplate) return { status: "failed", attempts: state.attempts };
    const attempts = Math.min(state.attempts + 1, 2);
    if (onTemplate) return { status: "accepted", attempts };
    return { status: state.status === "retry" ? "failed" : "retry", attempts };
}

/**
 * Account for coverage of requested units (e.g. reader areas).
 * A unit is `read` only when its result is accepted; failed or missing units are `unread`.
 * Stage counts: success = accepted first try, retry = accepted after a retry, failure = failed or missing.
 * Output presence is decided by status, never by truthiness, so valid falsy outputs (0, "", false) are kept.
 * @param {string[]} requested unit ids
 * @param {Record<string, { status: string, attempts: number, output?: unknown }>} results
 */
export function summarizeCoverage(requested, results) {
    const read = [];
    const unread = [];
    const stages = { success: 0, retry: 0, failure: 0 };
    for (const id of requested) {
        const result = Object.hasOwn(results, id) ? results[id] : undefined;
        if (result?.status === "accepted") {
            read.push(id);
            if (result.attempts > 1) stages.retry += 1;
            else stages.success += 1;
        } else {
            unread.push(id);
            stages.failure += 1;
        }
    }
    return { requested: [...requested], read, unread, stages };
}

/**
 * Propagate refuter corrected grades onto claims. A claim with no usable refuter result
 * (missing, or corrected grade not one of REUSE_GRADES) is `unverified` and keeps its original grade.
 * @param {{ id: string, grade: string }[]} claims
 * @param {Record<string, { verdict?: string, confidence?: string, correctedGrade?: string }>} refuted by claim id
 */
export function propagateGrades(claims, refuted) {
    return claims.map((claim) => {
        const result = Object.hasOwn(refuted, claim.id) ? refuted[claim.id] : undefined;
        const grade = typeof result?.correctedGrade === "string" ? result.correctedGrade.trim() : "";
        if (!REUSE_GRADES.includes(grade)) {
            return { ...claim, originalGrade: claim.grade, unverified: true };
        }
        return {
            ...claim,
            originalGrade: claim.grade,
            grade,
            unverified: false,
            verdict: result.verdict,
            confidence: result.confidence,
        };
    });
}
