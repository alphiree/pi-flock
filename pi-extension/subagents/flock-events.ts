import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const FLOCK_EVENT_VERSION = 1 as const;

const EVENT_FILE_PREFIX = "flock-event-";
const EVENT_FILE_SUFFIX = ".json";
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_TEXT_LENGTH = 65_536;
const MAX_EVENT_FILE_BYTES = 131_072;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TURN_PHASES = new Set<FlockTurnPhase>(["started", "completed", "interrupted"]);
const CLOSE_REASONS = new Set<FlockCloseReason>(["completed", "failed", "cancelled"]);

/** Identity shared by every event from one pi-flock run. */
export interface FlockEventIdentity {
  /** Stable identifier for the complete root hierarchy. */
  rootId: string;
  /** Identifier for the process/run that emitted this event. */
  runId: string;
  /** The parent run, or null for the root run. */
  parentId: string | null;
  /** Pi session that owns this run. */
  sessionId: string;
  /** Stable agent identity within the hierarchy. */
  agentId: string;
  /** Human-readable agent identity. */
  agentName: string;
}

export interface FlockEventBase extends FlockEventIdentity {
  version: typeof FLOCK_EVENT_VERSION;
  /** Globally unique event ID. It is also the event file's identity. */
  eventId: string;
  /** Unix epoch milliseconds when the event was emitted. */
  createdAt: number;
}

export interface FlockRegisteredEvent extends FlockEventBase {
  type: "registered";
}

export type FlockTurnPhase = "started" | "completed" | "interrupted";

/** A turn transition, optionally carrying the bounded text to relay. */
export interface FlockTurnEvent extends FlockEventBase {
  type: "turn";
  turnId: string;
  phase: FlockTurnPhase;
  text?: string;
}

export type FlockCloseReason = "completed" | "failed" | "cancelled";

export interface FlockClosedEvent extends FlockEventBase {
  type: "closed";
  reason: FlockCloseReason;
  text?: string;
}

export type FlockEvent = FlockRegisteredEvent | FlockTurnEvent | FlockClosedEvent;

export type FlockEventReadResult =
  | { ok: true; fileName: string; filePath: string; event: FlockEvent }
  | { ok: false; fileName: string; filePath: string; error: string };

export interface PublishFlockEventResult {
  eventId: string;
  fileName: string;
  filePath: string;
  /** False when the event ID was already published. Existing files are never overwritten. */
  published: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID.test(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_LENGTH;
}

function hasOnlyKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(object).every((key) => keys.includes(key));
}

function invalidEvent(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Validate and copy untrusted JSON into the version 1 event schema.
 * Unknown keys are rejected so a future protocol version cannot be silently
 * interpreted as version 1.
 */
export function validateFlockEvent(value: unknown):
  | { ok: true; event: FlockEvent }
  | { ok: false; error: string } {
  if (!isRecord(value)) return invalidEvent("event must be an object");
  if (value.version !== FLOCK_EVENT_VERSION) return invalidEvent("unsupported event version");
  if (!isSafeId(value.eventId)) return invalidEvent("eventId must be a filesystem-safe ID");
  if (!isSafeId(value.rootId)) return invalidEvent("rootId must be a filesystem-safe ID");
  if (!isSafeId(value.runId)) return invalidEvent("runId must be a filesystem-safe ID");
  if (value.parentId !== null && !isSafeId(value.parentId)) {
    return invalidEvent("parentId must be null or a filesystem-safe ID");
  }
  if (!isSafeId(value.sessionId)) return invalidEvent("sessionId must be a filesystem-safe ID");
  if (!isSafeId(value.agentId)) return invalidEvent("agentId must be a filesystem-safe ID");
  if (!isName(value.agentName)) return invalidEvent("agentName must be a bounded printable string");
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    return invalidEvent("createdAt must be a non-negative safe integer");
  }

  const base: FlockEventBase = {
    version: FLOCK_EVENT_VERSION,
    eventId: value.eventId,
    createdAt: value.createdAt,
    rootId: value.rootId,
    runId: value.runId,
    parentId: value.parentId,
    sessionId: value.sessionId,
    agentId: value.agentId,
    agentName: value.agentName,
  };

  if (value.type === "registered") {
    if (!hasOnlyKeys(value, [...Object.keys(base), "type"])) {
      return invalidEvent("registered event has unsupported keys");
    }
    return { ok: true, event: { ...base, type: "registered" } };
  }

  if (value.type === "turn") {
    if (!hasOnlyKeys(value, [...Object.keys(base), "type", "turnId", "phase", "text"])) {
      return invalidEvent("turn event has unsupported keys");
    }
    if (!isSafeId(value.turnId)) return invalidEvent("turnId must be a filesystem-safe ID");
    if (typeof value.phase !== "string" || !TURN_PHASES.has(value.phase as FlockTurnPhase)) {
      return invalidEvent("turn event has an unknown phase");
    }
    if (value.text !== undefined && !isText(value.text)) {
      return invalidEvent("turn text must be a bounded string when present");
    }
    return {
      ok: true,
      event: {
        ...base,
        type: "turn",
        turnId: value.turnId,
        phase: value.phase as FlockTurnPhase,
        ...(value.text === undefined ? {} : { text: value.text }),
      },
    };
  }

  if (value.type === "closed") {
    if (!hasOnlyKeys(value, [...Object.keys(base), "type", "reason", "text"])) {
      return invalidEvent("closed event has unsupported keys");
    }
    if (typeof value.reason !== "string" || !CLOSE_REASONS.has(value.reason as FlockCloseReason)) {
      return invalidEvent("closed event has an unknown reason");
    }
    if (value.text !== undefined && !isText(value.text)) {
      return invalidEvent("closed text must be a bounded string when present");
    }
    return {
      ok: true,
      event: {
        ...base,
        type: "closed",
        reason: value.reason as FlockCloseReason,
        ...(value.text === undefined ? {} : { text: value.text }),
      },
    };
  }

  return invalidEvent("unknown event type");
}

export function createFlockEventId(): string {
  return randomUUID();
}

export function createFlockRegisteredEvent(
  identity: FlockEventIdentity,
  now = Date.now(),
): FlockRegisteredEvent {
  return {
    version: FLOCK_EVENT_VERSION,
    eventId: createFlockEventId(),
    createdAt: now,
    ...identity,
    type: "registered",
  };
}

export function createFlockTurnEvent(
  identity: FlockEventIdentity,
  turn: { turnId: string; phase: FlockTurnPhase; text?: string },
  now = Date.now(),
): FlockTurnEvent {
  return {
    version: FLOCK_EVENT_VERSION,
    eventId: createFlockEventId(),
    createdAt: now,
    ...identity,
    type: "turn",
    ...turn,
  };
}

export function createFlockClosedEvent(
  identity: FlockEventIdentity,
  close: { reason: FlockCloseReason; text?: string },
  now = Date.now(),
): FlockClosedEvent {
  return {
    version: FLOCK_EVENT_VERSION,
    eventId: createFlockEventId(),
    createdAt: now,
    ...identity,
    type: "closed",
    ...close,
  };
}

/** Return the canonical filename for an event ID, rejecting path-like IDs. */
export function getFlockEventFileName(eventId: string): string {
  if (!isSafeId(eventId)) throw new Error("eventId must be a filesystem-safe ID");
  return `${EVENT_FILE_PREFIX}${eventId}${EVENT_FILE_SUFFIX}`;
}

/** Return the ID encoded by a canonical event filename, if any. */
export function getFlockEventIdFromFileName(fileName: string): string | null {
  if (typeof fileName !== "string" || fileName !== fileName.trim()) return null;
  if (!fileName.startsWith(EVENT_FILE_PREFIX) || !fileName.endsWith(EVENT_FILE_SUFFIX)) return null;
  const eventId = fileName.slice(EVENT_FILE_PREFIX.length, -EVENT_FILE_SUFFIX.length);
  return isSafeId(eventId) && getFlockEventFileName(eventId) === fileName ? eventId : null;
}

function assertEventDir(eventDir: string, create: boolean): void {
  if (typeof eventDir !== "string" || !eventDir.trim()) throw new Error("eventDir must be a non-empty path");
  if (create) mkdirSync(eventDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(eventDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("eventDir must be a real directory, not a symbolic link");
  }
}

function eventFilePath(eventDir: string, fileName: string): string {
  // fileName originates from the strict canonical parser above, so join cannot escape eventDir.
  return join(eventDir, fileName);
}

function safeReadEventFile(filePath: string): string {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("event path is not a regular file");
    if (stat.size > MAX_EVENT_FILE_BYTES) throw new Error("event file exceeds size limit");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish exactly one complete JSON file for an event. The temp file lives in
 * eventDir, then rename makes the final filename visible atomically.
 */
export function publishFlockEvent(eventDir: string, event: FlockEvent): PublishFlockEventResult {
  const validated = validateFlockEvent(event);
  if (!validated.ok) throw new Error(`invalid flock event: ${validated.error}`);

  assertEventDir(eventDir, true);
  const fileName = getFlockEventFileName(validated.event.eventId);
  const filePath = eventFilePath(eventDir, fileName);
  if (getExistingEvent(filePath)) {
    return { eventId: validated.event.eventId, fileName, filePath, published: false };
  }

  const tempPath = eventFilePath(
    eventDir,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(validated.event)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Do not overwrite a known event. Event IDs are UUIDs in normal use, so
    // a competing publication is a duplicate rather than a replacement.
    if (getExistingEvent(filePath)) {
      return { eventId: validated.event.eventId, fileName, filePath, published: false };
    }
    renameSync(tempPath, filePath);
    return { eventId: validated.event.eventId, fileName, filePath, published: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve a write/rename error. Temp cleanup is best effort.
    }
  }
}

function getExistingEvent(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error("event path must not be a symbolic link");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** List only canonical event files, in deterministic filename order. */
export function enumerateFlockEventFiles(eventDir: string): string[] {
  try {
    assertEventDir(eventDir, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return readdirSync(eventDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && getFlockEventIdFromFileName(entry.name) !== null)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** Safely parse one canonical event file beneath eventDir. */
export function readFlockEventFile(eventDir: string, fileName: string): FlockEventReadResult {
  const eventId = getFlockEventIdFromFileName(fileName);
  // Never join an untrusted filename: callers may pass arbitrary input here.
  if (!eventId) {
    return { ok: false, fileName, filePath: eventDir, error: "invalid event filename" };
  }
  const filePath = eventFilePath(eventDir, fileName);

  try {
    assertEventDir(eventDir, false);
    const parsed: unknown = JSON.parse(safeReadEventFile(filePath));
    const validated = validateFlockEvent(parsed);
    if (!validated.ok) return { ok: false, fileName, filePath, error: validated.error };
    if (validated.event.eventId !== eventId) {
      return { ok: false, fileName, filePath, error: "eventId does not match filename" };
    }
    return { ok: true, fileName, filePath, event: validated.event };
  } catch (error) {
    return {
      ok: false,
      fileName,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read all canonical event files in deterministic filename order. */
export function readFlockEvents(eventDir: string): FlockEventReadResult[] {
  return enumerateFlockEventFiles(eventDir).map((fileName) => readFlockEventFile(eventDir, fileName));
}

/**
 * Keep first-seen events by ID, preserving input order. Pass a retained set to
 * dedupe a later scan against earlier scans without depending on filenames.
 */
export function dedupeFlockEvents(
  events: Iterable<FlockEvent>,
  seenEventIds: Set<string> = new Set(),
): FlockEvent[] {
  const unique: FlockEvent[] = [];
  for (const event of events) {
    if (seenEventIds.has(event.eventId)) continue;
    seenEventIds.add(event.eventId);
    unique.push(event);
  }
  return unique;
}
