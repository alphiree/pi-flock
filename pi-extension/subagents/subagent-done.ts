/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  createFlockClosedEvent,
  createFlockRegisteredEvent,
  createFlockTurnEvent,
  publishFlockEvent,
  type FlockEventIdentity,
} from "./flock-events.ts";

export const MAX_RELAY_TEXT_LENGTH = 4_000;

export function getLatestAssistantTextTurn(message: unknown): string | null {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) return null;
  return text.length <= MAX_RELAY_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_RELAY_TEXT_LENGTH - 3)}...`;
}

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(messages: any[] | undefined):
  | { type: "done" }
  | { type: "error"; errorMessage: string; stopReason: "error" } {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

type InboxDeliverAs = "normal" | "followUp" | "steer";

interface InboxMessage {
  id?: string;
  type?: string;
  message?: unknown;
  deliverAs?: unknown;
}

export function getInboxCursorFile(inboxFile: string): string {
  return `${inboxFile}.cursor`;
}

export function readInboxCursor(inboxFile: string): number {
  try {
    const value = Number(readFileSync(getInboxCursorFile(inboxFile), "utf8"));
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

export function writeInboxCursor(inboxFile: string, offset: number) {
  writeFileSync(getInboxCursorFile(inboxFile), String(Math.max(0, offset)), "utf8");
}

export function getCompleteInboxChunk(content: string, offset: number): { chunk: string; nextOffset: number } {
  const safeOffset = content.length < offset ? 0 : offset;
  const unread = content.slice(safeOffset);
  const lastNewline = unread.lastIndexOf("\n");
  if (lastNewline < 0) return { chunk: "", nextOffset: safeOffset };
  return {
    chunk: unread.slice(0, lastNewline + 1),
    nextOffset: safeOffset + lastNewline + 1,
  };
}

export function parseInboxMessages(content: string): Array<{ message: string; deliverAs: InboxDeliverAs }> {
  const messages: Array<{ message: string; deliverAs: InboxDeliverAs }> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: InboxMessage;
    try {
      parsed = JSON.parse(trimmed) as InboxMessage;
    } catch {
      continue;
    }
    if (parsed.type !== "user_message") continue;
    if (typeof parsed.message !== "string" || !parsed.message.trim()) continue;
    const deliverAs = parsed.deliverAs === "normal" || parsed.deliverAs === "steer" || parsed.deliverAs === "followUp"
      ? parsed.deliverAs
      : "followUp";
    messages.push({ message: parsed.message, deliverAs });
  }
  return messages;
}

export function deliverInboxMessage(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  message: string,
  deliverAs: InboxDeliverAs,
) {
  if (deliverAs === "steer") {
    pi.sendUserMessage(message, { deliverAs: "steer" });
    return;
  }

  // Use followUp for both explicit followUp and compatibility "normal" delivery.
  // It runs immediately when the child is idle and queues safely when it is busy.
  pi.sendUserMessage(message, { deliverAs: "followUp" });
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  const inboxFile = process.env.PI_SUBAGENT_INBOX_FILE;
  const inboxPollMs = Math.max(100, Number(process.env.PI_SUBAGENT_INBOX_POLL_MS ?? 500) || 500);
  let inboxOffset = inboxFile ? readInboxCursor(inboxFile) : 0;
  let inboxInterval: ReturnType<typeof setInterval> | null = null;
  const flockEventDir = process.env.PI_FLOCK_EVENT_DIR?.trim();
  const relayTurns = process.env.PI_FLOCK_RELAY_TURNS === "1";
  let registeredPublished = false;
  let closedPublished = false;
  let latestAssistantTextTurn: string | null = null;
  let lastRelayedAssistantTextTurn: string | null = null;

  function getFlockIdentity(): FlockEventIdentity | null {
    const rootId = process.env.PI_FLOCK_ROOT_ID?.trim();
    const runId = process.env.PI_SUBAGENT_ID?.trim();
    const sessionId = process.env.PI_SUBAGENT_SESSION_ID?.trim();
    const surface = process.env.PI_SUBAGENT_SURFACE?.trim();
    if (!rootId || !runId || !sessionId || !surface) return null;
    const parentId = process.env.PI_FLOCK_PARENT_ID?.trim() || null;
    return {
      rootId,
      runId,
      parentId,
      sessionId,
      agentId: process.env.PI_SUBAGENT_AGENT?.trim() || "subagent",
      agentName: process.env.PI_SUBAGENT_NAME?.trim() || "subagent",
      interactive: process.env.PI_SUBAGENT_INTERACTIVE === "1",
      surface,
    };
  }

  function publishChildFlockEvent(event: ReturnType<typeof createFlockRegisteredEvent> | ReturnType<typeof createFlockTurnEvent> | ReturnType<typeof createFlockClosedEvent>) {
    if (!flockEventDir) return;
    try {
      publishFlockEvent(flockEventDir, event);
    } catch {
      // Cross-process observation must never disrupt child work.
    }
  }

  function pollInbox() {
    if (!inboxFile || !existsSync(inboxFile)) return;
    const content = readFileSync(inboxFile, "utf8");
    const { chunk, nextOffset } = getCompleteInboxChunk(content, inboxOffset);
    if (!chunk.trim()) return;
    const messages = parseInboxMessages(chunk);
    for (const inboxMessage of messages) {
      deliverInboxMessage(pi, inboxMessage.message, inboxMessage.deliverAs);
    }
    inboxOffset = nextOffset;
    writeInboxCursor(inboxFile, inboxOffset);
  }

  function startInboxPolling() {
    if (!inboxFile || inboxInterval) return;
    pollInbox();
    inboxInterval = setInterval(pollInbox, inboxPollMs);
  }

  function stopInboxPolling() {
    if (!inboxInterval) return;
    clearInterval(inboxInterval);
    inboxInterval = null;
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const identity = getFlockIdentity();
    if (identity && !registeredPublished) {
      publishChildFlockEvent(createFlockRegisteredEvent(identity));
      registeredPublished = true;
    }
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
    startInboxPolling();
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify(buildCompletionSidecar(messages)),
          );
        } catch {
          // Best effort — the watcher can still detect the terminal sentinel
          // after shutdown if the completion sidecar cannot be written.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
    // turn_end exposes only the assistant message. This deliberately excludes
    // the initial user task, thoughts, and tool results from root relaying.
    latestAssistantTextTurn = getLatestAssistantTextTurn((event as any).message);
  });

  pi.on("agent_settled", () => {
    if (!relayTurns || !latestAssistantTextTurn || latestAssistantTextTurn === lastRelayedAssistantTextTurn) {
      return;
    }
    const identity = getFlockIdentity();
    if (!identity) return;
    publishChildFlockEvent(createFlockTurnEvent(identity, {
      turnId: `settled-${Date.now()}`,
      phase: "completed",
      text: latestAssistantTextTurn,
    }));
    lastRelayedAssistantTextTurn = latestAssistantTextTurn;
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    stopInboxPolling();
    recorder.sessionShutdown((event as any).reason);
    // Replacement and reload shutdowns are not final child closure.
    const identity = getFlockIdentity();
    if ((event as any).reason === "quit" && identity && !closedPublished) {
      publishChildFlockEvent(createFlockClosedEvent(identity, { reason: "completed" }));
      closedPublished = true;
    }
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
