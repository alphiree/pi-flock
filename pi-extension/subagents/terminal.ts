import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  sendHerdrCommand,
  sendHerdrEscape,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

type TerminalTestHooks = {
  isTerminalAvailable?: () => boolean;
  createSubagentPane?: (name: string) => PaneId;
  runInPane?: (paneId: PaneId, command: string) => void;
  closePane?: (paneId: PaneId) => void;
};

let testHooks: TerminalTestHooks | undefined;

export function isTerminalAvailable(): boolean {
  return testHooks?.isTerminalAvailable?.() ?? isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string): PaneId {
  if (testHooks?.createSubagentPane) return testHooks.createSubagentPane(name);
  assertTerminalAvailable();
  return createHerdrSurface(name);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name: string, direction: SplitDirection): PaneId {
  assertTerminalAvailable();
  return createHerdrSurfaceSplit(name, direction);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  if (testHooks?.runInPane) return testHooks.runInPane(paneId, command);
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

export const __test__ = {
  setHooks(hooks: TerminalTestHooks): () => void {
    const previous = testHooks;
    testHooks = hooks;
    return () => {
      testHooks = previous;
    };
  },
};

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export function buildScriptContent(command: string, scriptPreamble?: string): string {
  const scriptLines = ["#!/bin/bash"];
  if (scriptPreamble) scriptLines.push(scriptPreamble.trimEnd());
  scriptLines.push(command);
  return `${scriptLines.join("\n")}\n`;
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-flock-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  writeFileSync(scriptPath, buildScriptContent(command, options?.scriptPreamble), { mode: 0o755 });

  runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
  return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { kind: "present", observedAt: Date.now(), ...result };
  }
  return result;
}

export function closePane(paneId: PaneId): void {
  if (testHooks?.closePane) return testHooks.closePane(paneId);
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}
