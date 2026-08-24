// UserPromptSubmit hook: record a HUMAN_TURN event (human-presence gate).
//
// On every real human prompt, append a HUMAN_TURN event to the active intent's
// audit shard (the state machine's own append-only ledger). The approval /
// interview gate (handleApprove / handleAnswer) refuses unless a HUMAN_TURN was
// recorded since the last gate resolution, so a model under autopilot cannot
// fabricate an approval with no human having acted this turn.
//
// Presence remains the gate signal, while the prompt payload is also inspected
// for an exact protected Plan Approval choice. appendAuditEntry resolves the
// active intent from the on-disk cursor. No workflow state on disk means nothing
// to gate, so the hook exits without writing (same self-gate as
// aidlc-session-start.ts) - otherwise every prompt in a project that carries the
// harness shell but never ran the framework would scaffold and grow audit
// shards. The gate fails open on an empty ledger, so skipping the mint there is
// safe. The mint is fail-open (try/catch, exit 0): a mint failure must never
// block the human's turn.
//
// The same seam also touches the .aidlc-human-turn marker (markHumanTurn). The
// ledger event serves the human-presence GATE; the marker serves the Stop hook's
// conversational carve-out, which needs a cheap "when was the last human prompt,
// relative to the last engine advance?" comparison that works on harnesses
// delivering no transcript. Both are written from this one seam so they can never
// disagree about when a human spoke. See the marker family in aidlc-lib.ts.
import { existsSync } from "node:fs";
import { markHumanTurn, resolveProjectDirFromHook, stateFilePath } from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { recordPlanApprovalHumanResponse } from "../tools/aidlc-testing-posture.ts";

function extractResponseText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return extractResponseText(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractResponseText(entry);
      if (text) return text;
    }
    return "";
  }
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of [
    "answer",
    "answers",
    "selected",
    "selection",
    "value",
    "label",
    "text",
  ]) {
    if (!(key in record)) continue;
    const text = extractResponseText(record[key]);
    if (text) return text;
  }
  for (const entry of Object.values(record)) {
    const text = extractResponseText(entry);
    if (text) return text;
  }
  return "";
}

export async function run(input: string): Promise<number> {
try {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  if (existsSync(stateFilePath(projectDir))) {
    let sessionId = "";
    let humanResponseText = "";
    try {
      const parsed = JSON.parse(input) as {
        session_id?: unknown;
        prompt?: unknown;
        user_prompt?: unknown;
        message?: unknown;
        tool_response?: unknown;
        toolResponse?: unknown;
      };
      if (typeof parsed.session_id === "string") sessionId = parsed.session_id.trim();
      for (const candidate of [
        parsed.prompt,
        parsed.user_prompt,
        parsed.message,
        parsed.tool_response,
        parsed.toolResponse,
      ]) {
        const extracted = extractResponseText(candidate);
        if (extracted) {
          humanResponseText = extracted;
          break;
        }
      }
    } catch { /* presence still records without identity on legacy payloads */ }
    appendAuditEntry("HUMAN_TURN", sessionId ? { Session: sessionId } : {}, projectDir);
    if (sessionId && humanResponseText) {
      recordPlanApprovalHumanResponse(
        projectDir,
        sessionId,
        humanResponseText,
      );
    }
    markHumanTurn(projectDir);
  }
} catch {
  // Non-fatal — a mint failure must never block the human's turn.
}

return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
