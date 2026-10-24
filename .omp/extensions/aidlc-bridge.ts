// AI-DLC ⇄ oh-my-pi bridge.
//
// AI-DLC is installed here for the Claude Code harness (.claude/). Its engine
// relies on Claude Code command hooks (.claude/settings.json) that omp never
// runs. This extension maps omp's lifecycle events onto the same
// `aidlc engine hook <name>` entry points, feeding each one the Claude-shaped
// JSON it parses (no transcript), the way upstream's opencode adapter does.
//
//   omp event                         -> AI-DLC hook (Claude event mirrored)
//   input (interactive, main)         -> session-start (until handled), record-human-turn (UserPromptSubmit)
//   before_agent_start (main)         -> delivers the hooks' additionalContext to the model
//   tool_call task                    -> deliver-stage-rules rewrite + guard-tool-call, per tasks[] item (PreToolUse Task)
//   tool_call bash|write|edit         -> guard-tool-call (PreToolUse Bash|Write|Edit)
//   tool_call read|grep|glob (sub)    -> guard-tool-call for reviewer read scope (PreToolUse Read|Grep|Glob)
//   tool_result write|edit            -> write-audit-log, run-sensors (PostToolUse Write|Edit)
//   tool_result bash                  -> rebuild-stage-graph (PostToolUse Bash)
//   tool_result ask (main)            -> record-human-turn (PostToolUse AskUserQuestion)
//   tool_result todo start            -> sync-workflow-state (PostToolUse TaskUpdate)
//   agent_end (sub)                   -> log-subagent (SubagentStop)
//   session_stop (main)               -> continue-workflow (Stop)
//   session_before_compact            -> validate-state (PreCompact)
//   session_shutdown                  -> session-end (SessionEnd)
//
// Known gaps versus Claude Code:
//   - fold-usage (token/cost folding) needs a Claude transcript and is not run.
//   - Mutations outside bash/write/edit (eval, ast_edit, xd:// devices) are not
//     seen by the plan-approval and review-freeze guards.
//   - Main-session read/grep/glob calls skip the guard spawn: only the
//     reviewer read-scope guard reads them, and it scopes AI-DLC subagents only.
//
// It also mirrors .claude/agents/aidlc-*-agent.md into .omp/agents/ (omp does
// not read .claude/agents), keeping name + description and denying nested
// spawns (the Claude definitions disallow Task), and appends TOOL_MAPPING to
// the main session's system prompt so the conductor reads Claude tool names
// in AI-DLC's instructions as their omp equivalents.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type Json = Record<string, unknown>;
type HookResult = { code: number; stdout: string; stderr: string };
type ClaudeCall = { tool_name: string; tool_input: Json };

const AIDLC_AGENT = /^aidlc-[a-z0-9-]+-agent$/;
const ENTRY = /^\/(aidlc(?:-[a-z0-9-]+)?)(?=\s|$)/;
const SKILL_ENTRY = /^\/skill:(aidlc(?:-[a-z0-9-]+)?)(?=\s|$)/;
const URL_PATH = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAIN_ONLY_SKIPPED: Record<string, true> = { Read: true, Grep: true, Glob: true };
const TOOL_MAPPING = `# AI-DLC under oh-my-pi

AI-DLC here is installed for Claude Code; .omp/extensions/aidlc-bridge.ts runs its hooks for omp. When an AI-DLC skill, stage, or engine directive names a Claude Code tool, use the omp equivalent:
- AskUserQuestion → ask: one question per call unless the step lists several; options exactly as given, never add an "Other" option (omp adds custom input itself).
- Task / Agent with subagent_type X → task with one tasks[] item whose agent is X (agents are mirrored to .omp/agents/); the brief goes in that item's task.
- TaskUpdate / TodoWrite → todo. Bash → bash; Read / Write / Edit → read / write / edit.
Never run \`aidlc engine hook …\` yourself; the bridge does.`;

// Module state is shared by the main session and every subagent session the
// factory is rebound to. Subagent tool calls are judged under the workflow of
// the main session that owns them.
let mainSessionId: string | undefined;
let sessionStartHandled = false;
let pendingContext: string[] = [];
const pendingWrites = new Map<string, ClaudeCall[]>();

function aidlcInstalled(cwd: string): boolean {
	return existsSync(join(cwd, ".claude", "tools", "data", "harness.json"));
}

function isSub(ctx: ExtensionContext): boolean {
	return ctx.agent.kind === "sub";
}

/** The session whose workflow judges this call: subagents belong to the main session. */
function owningSession(ctx: ExtensionContext): string {
	return isSub(ctx) && mainSessionId ? mainSessionId : ctx.sessionManager.getSessionId();
}

function runHook(cwd: string, hook: string, payload: Json): Promise<HookResult> {
	const { promise, resolve: done } = Promise.withResolvers<HookResult>();
	// Fail open on spawn failure, as every upstream adapter does: a missing
	// `aidlc` binary must not wedge the session.
	const FAIL_OPEN: HookResult = { code: 0, stdout: "", stderr: "" };
	try {
		const child = spawn("aidlc", ["engine", "hook", hook, "--project-dir", cwd], {
			cwd,
			env: { ...process.env, AIDLC_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", () => done(FAIL_OPEN));
		child.on("close", code => done({ code: code ?? 0, stdout, stderr }));
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	} catch {
		done(FAIL_OPEN);
	}
	return promise;
}

function jsonLines(stdout: string): Json[] {
	const out: Json[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = asJson(JSON.parse(trimmed));
			if (parsed) out.push(parsed);
		} catch {
			// Not a hook protocol line.
		}
	}
	return out;
}

function asJson(value: unknown): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** The model-visible context a hook printed (Claude's additionalContext channels). */
function hookContext(stdout: string): string[] {
	const out: string[] = [];
	for (const line of jsonLines(stdout)) {
		const context = asJson(line.hookSpecificOutput)?.additionalContext ?? line.additionalContext;
		if (typeof context === "string" && context.trim()) out.push(context);
	}
	return out;
}

function denyReason(result: HookResult, fallback: string): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	for (const line of jsonLines(result.stdout)) {
		const reason = asJson(line.hookSpecificOutput)?.permissionDecisionReason;
		if (typeof reason === "string" && reason.trim()) return reason;
	}
	return fallback;
}

/** A local file path for a tool argument, without read selectors (`:50-80`, `:raw`). */
function localPath(raw: unknown, cwd: string): string | null {
	if (typeof raw !== "string" || raw === "" || URL_PATH.test(raw)) return null;
	const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
	let candidate = raw;
	while (!existsSync(abs(candidate)) && /:[^/:]*$/.test(candidate)) {
		candidate = candidate.replace(/:[^/:]*$/, "");
	}
	return abs(existsSync(abs(candidate)) ? candidate : raw);
}

/** Claude-shaped calls for one omp tool call; empty when no AI-DLC guard reads it. */
function claudeCalls(toolName: string, input: Json, cwd: string): ClaudeCall[] {
	switch (toolName) {
		case "bash":
			return [{ tool_name: "Bash", tool_input: { command: typeof input.command === "string" ? input.command : "" } }];
		case "write":
		case "read": {
			const file = localPath(input.path, cwd);
			return file ? [{ tool_name: toolName === "write" ? "Write" : "Read", tool_input: { file_path: file } }] : [];
		}
		case "edit":
			// omp derives path/paths on the edit event for policy inspection.
			return (Array.isArray(input.paths) ? input.paths : [input.path])
				.map(p => localPath(p, cwd))
				.filter((p): p is string => p !== null)
				.map(file => ({ tool_name: "Edit", tool_input: { file_path: file } }));
		case "grep":
			return [{ tool_name: "Grep", tool_input: { pattern: input.pattern, path: localPath(input.path ?? ".", cwd) ?? cwd } }];
		case "glob":
			return [{ tool_name: "Glob", tool_input: { pattern: input.path ?? "*", path: cwd } }];
		default:
			return [];
	}
}

function bindMainSession(sessionId: string): void {
	if (sessionId !== mainSessionId) sessionStartHandled = false;
	mainSessionId = sessionId;
	// AI-DLC names the invoking chat from the agent's shell environment
	// (hostNamedChat for .claude: CLAUDE_PID alive + CLAUDE_CODE_SESSION_ID).
	// Shells spawned after this inherit it, so `aidlc engine orchestrate ...`
	// run from the bash tool resolves to this session.
	process.env.CLAUDE_PID = String(process.pid);
	process.env.CLAUDE_CODE_SESSION_ID = sessionId;
}

function syncAgents(cwd: string): void {
	const source = join(cwd, ".claude", "agents");
	if (!existsSync(source)) return;
	const target = join(cwd, ".omp", "agents");
	for (const file of readdirSync(source)) {
		if (!/^aidlc-[a-z0-9-]+-agent\.md$/.test(file)) continue;
		const text = readFileSync(join(source, file), "utf8");
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
		if (!match) continue;
		const front = asJson(Bun.YAML.parse(match[1]));
		if (typeof front?.name !== "string" || typeof front.description !== "string") continue;
		const out = [
			"---",
			`name: ${JSON.stringify(front.name)}`,
			`description: ${JSON.stringify(front.description.trim())}`,
			'spawns: ""',
			"---",
			`<!-- Generated by .omp/extensions/aidlc-bridge.ts from .claude/agents/${file}; edit the source, not this copy. -->`,
			text.slice(match[0].length),
		].join("\n");
		const dest = join(target, file);
		if (existsSync(dest) && readFileSync(dest, "utf8") === out) continue;
		mkdirSync(target, { recursive: true });
		writeFileSync(dest, out);
	}
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(block => {
			const text = asJson(block)?.type === "text" ? asJson(block)?.text : undefined;
			return typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

/** omp `ask` result → Claude AskUserQuestion input/response (answers keyed by question text). */
function pickerPayload(input: Json, details: unknown): { tool_input: Json; tool_response: Json } | null {
	const questions = (Array.isArray(input.questions) ? input.questions : []).map(q => asJson(q) ?? {});
	const d = asJson(details);
	if (questions.length === 0 || !d) return null;
	const results = Array.isArray(d.results) ? d.results.map(r => asJson(r) ?? {}) : [{ ...d, id: questions[0]?.id }];
	const answers: Json = {};
	for (const result of results) {
		// An auto-selection after a timeout is not the person's answer.
		if (result.timedOut === true) continue;
		const question = questions.find(q => q.id === result.id) ?? questions[0];
		const picks = [
			...(Array.isArray(result.selectedOptions) ? result.selectedOptions.filter(p => typeof p === "string") : []),
			...(typeof result.customInput === "string" && result.customInput.trim() ? [result.customInput] : []),
		];
		if (typeof question?.question === "string" && picks.length > 0) answers[question.question] = picks;
	}
	return {
		tool_input: {
			questions: questions.map(q => ({
				id: q.id,
				question: q.question,
				options: Array.isArray(q.options) ? q.options : [],
				multiSelect: q.multi === true,
			})),
		},
		tool_response: { answers },
	};
}

export default function aidlcBridge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		bindMainSession(ctx.sessionManager.getSessionId());
		try {
			syncAgents(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`AI-DLC bridge: could not mirror agents (${String(error)})`, "warning");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		bindMainSession(ctx.sessionManager.getSessionId());
	});

	pi.on("input", async (event, ctx) => {
		// Only a person typing in the TUI is a human turn: RPC, extension and
		// subagent input never mint AI-DLC's presence proof.
		if (event.source !== "interactive" || isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		const cwd = ctx.cwd;
		const text = event.text;
		const sessionId = ctx.sessionManager.getSessionId();
		bindMainSession(sessionId);

		let replacement: string | undefined;
		let prompt = text;
		const entry = ENTRY.exec(text);
		const skillEntry = SKILL_ENTRY.exec(text);
		if (entry && existsSync(join(cwd, ".claude", "skills", entry[1], "SKILL.md"))) {
			// `/aidlc …` as in Claude Code: run the skill, record the words as typed.
			replacement = `/skill:${entry[1]}${text.slice(entry[0].length)}`;
		} else if (skillEntry) {
			// The engine reads `/aidlc …` as its entry word.
			prompt = `/${skillEntry[1]}${text.slice(skillEntry[0].length)}`;
		} else if (/^[/!$]/.test(text)) {
			// omp's own slash commands and local bash/python sigils are not prompts.
			return;
		}

		if (!sessionStartHandled) {
			const started = await runHook(cwd, "session-start", {
				hook_event_name: "SessionStart",
				source: ctx.sessionManager.getBranch().length > 0 ? "resume" : "startup",
				session_id: sessionId,
				cwd,
			});
			const context = hookContext(started.stdout);
			// A project with no workflow yet prints nothing; retry on later turns.
			if (context.length > 0) sessionStartHandled = true;
			pendingContext.push(...context);
		}
		const turn = await runHook(cwd, "record-human-turn", {
			hook_event_name: "UserPromptSubmit",
			session_id: sessionId,
			prompt,
			cwd,
		});
		pendingContext.push(...hookContext(turn.stdout));
		return replacement === undefined ? undefined : { text: replacement };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		const systemPrompt = event.systemPrompt.includes(TOOL_MAPPING) ? event.systemPrompt : [...event.systemPrompt, TOOL_MAPPING];
		if (pendingContext.length === 0) return { systemPrompt };
		const content = pendingContext.join("\n\n");
		pendingContext = [];
		return { systemPrompt, message: { customType: "aidlc-hook-context", content, display: false } };
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx.cwd;
		if (!aidlcInstalled(cwd)) return;
		const agentName = ctx.agent.name;
		const base = {
			hook_event_name: "PreToolUse",
			session_id: owningSession(ctx),
			cwd,
			// Reviewer read scope applies to AI-DLC's own agents only.
			...(isSub(ctx) && AIDLC_AGENT.test(agentName) ? { agent_type: agentName } : {}),
		};

		if (event.toolName === "task") {
			const tasks = Array.isArray(event.input.tasks) ? event.input.tasks.map(t => ({ ...(asJson(t) ?? {}) })) : [];
			let changed = false;
			for (const task of tasks) {
				const subagent_type = typeof task.agent === "string" && task.agent ? task.agent : "task";
				const prompt = typeof task.task === "string" ? task.task : "";
				const dispatch = await runHook(cwd, "deliver-stage-rules", {
					...base,
					tool_name: "Task",
					tool_input: { subagent_type, prompt, description: task.name ?? "" },
				});
				if (dispatch.code === 2) {
					return { block: true, reason: denyReason(dispatch, "AI-DLC could not load the active stage's rules for this dispatch.") };
				}
				for (const line of jsonLines(dispatch.stdout)) {
					const updated = asJson(asJson(line.hookSpecificOutput)?.updatedInput);
					if (typeof updated?.prompt === "string" && updated.prompt !== prompt) {
						task.task = updated.prompt;
						changed = true;
					}
				}
				const guard = await runHook(cwd, "guard-tool-call", {
					...base,
					tool_name: "Task",
					tool_input: { subagent_type, prompt: task.task },
				});
				if (guard.code === 2) return { block: true, reason: denyReason(guard, "AI-DLC refused this dispatch.") };
			}
			return changed ? { input: { ...event.input, tasks } } : undefined;
		}

		let calls = claudeCalls(event.toolName, asJson(event.input) ?? {}, cwd);
		if (!isSub(ctx)) calls = calls.filter(call => !MAIN_ONLY_SKIPPED[call.tool_name]);
		if (calls.length === 0) return;
		if (event.toolName === "write" || event.toolName === "edit") pendingWrites.set(event.toolCallId, calls);
		const context: string[] = [];
		for (const call of calls) {
			const guard = await runHook(cwd, "guard-tool-call", { ...base, ...call });
			if (guard.code === 2) {
				pendingWrites.delete(event.toolCallId);
				return { block: true, reason: denyReason(guard, "AI-DLC refused this tool call.") };
			}
			context.push(...hookContext(guard.stdout));
		}
		return context.length > 0 ? { additionalContext: context.join("\n\n") } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const cwd = ctx.cwd;
		if (!aidlcInstalled(cwd)) return;
		const base = { hook_event_name: "PostToolUse", session_id: owningSession(ctx), cwd };
		const context: string[] = [];

		if (event.toolName === "write" || event.toolName === "edit") {
			const calls = pendingWrites.get(event.toolCallId) ?? [];
			pendingWrites.delete(event.toolCallId);
			if (event.isError) return;
			for (const call of calls) {
				// Audit first, then sensors: the Claude settings.json order.
				await runHook(cwd, "write-audit-log", { ...base, ...call });
				const sensors = await runHook(cwd, "run-sensors", { ...base, ...call });
				context.push(...hookContext(sensors.stdout));
			}
		} else if (event.toolName === "bash") {
			const result = await runHook(cwd, "rebuild-stage-graph", {
				...base,
				tool_name: "Bash",
				tool_input: { command: event.input.command ?? "" },
				tool_response: textOf(event.content),
			});
			for (const line of jsonLines(result.stdout)) {
				if (typeof line.systemMessage === "string" && line.systemMessage.trim()) ctx.ui.notify(line.systemMessage, "error");
			}
			context.push(...hookContext(result.stdout));
		} else if (event.toolName === "ask") {
			// A picker answer is a human turn only in the person's own session.
			if (event.isError || isSub(ctx) || !ctx.hasUI) return;
			const picker = pickerPayload(event.input, event.details);
			if (!picker) return;
			const result = await runHook(cwd, "record-human-turn", { ...base, tool_name: "AskUserQuestion", ...picker });
			context.push(...hookContext(result.stdout));
		} else if (event.toolName === "todo") {
			if (event.input.op !== "start" || typeof event.input.task !== "string") return;
			await runHook(cwd, "sync-workflow-state", {
				...base,
				tool_name: "TaskUpdate",
				tool_input: { status: "in_progress", activeForm: event.input.task },
			});
		}
		return context.length > 0 ? { additionalContext: context.join("\n\n") } : undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		const last = [...event.messages].reverse().find(message => message.role === "assistant");
		await runHook(ctx.cwd, "log-subagent", {
			hook_event_name: "SubagentStop",
			session_id: owningSession(ctx),
			agent_type: ctx.agent.name,
			agent_id: ctx.agent.id,
			last_assistant_message: last && "content" in last ? textOf(last.content) : "",
			cwd: ctx.cwd,
		});
	});

	pi.on("session_stop", async (event, ctx) => {
		if (isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		const result = await runHook(ctx.cwd, "continue-workflow", {
			hook_event_name: "Stop",
			session_id: event.session_id,
			stop_hook_active: event.stop_hook_active,
			cwd: ctx.cwd,
		});
		for (const line of jsonLines(result.stdout)) {
			if (line.decision === "block" && typeof line.reason === "string" && line.reason.trim()) {
				return { decision: "block", reason: line.reason };
			}
		}
		return undefined;
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		if (!aidlcInstalled(ctx.cwd)) return;
		await runHook(ctx.cwd, "validate-state", { hook_event_name: "PreCompact", session_id: owningSession(ctx), cwd: ctx.cwd });
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isSub(ctx) || !aidlcInstalled(ctx.cwd)) return;
		await runHook(ctx.cwd, "session-end", {
			hook_event_name: "SessionEnd",
			reason: "other",
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		});
	});
}
