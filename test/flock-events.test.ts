import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FLOCK_EVENT_VERSION,
  dedupeFlockEvents,
  enumerateFlockEventFiles,
  getFlockEventFileName,
  publishFlockEvent,
  readFlockEventFile,
  readFlockEvents,
  validateFlockEvent,
  type FlockEventIdentity,
} from "../pi-extension/subagents/flock-events.ts";

const identity: FlockEventIdentity = {
  rootId: "root-1",
  runId: "run-1",
  parentId: null,
  sessionId: "session-1",
  agentId: "agent-1",
  agentName: "Worker One",
};

function withEventDir(run: (eventDir: string) => void) {
  const eventDir = mkdtempSync(join(tmpdir(), "flock-events-test-"));
  try {
    run(eventDir);
  } finally {
    rmSync(eventDir, { recursive: true, force: true });
  }
}

describe("flock-events", () => {
  it("publishes complete files once and enumerates them deterministically", () => {
    withEventDir((eventDir) => {
      const later = {
        version: FLOCK_EVENT_VERSION,
        eventId: "z-event",
        createdAt: 2,
        ...identity,
        type: "registered" as const,
      };
      const earlier = {
        version: FLOCK_EVENT_VERSION,
        eventId: "a-event",
        createdAt: 1,
        ...identity,
        type: "turn" as const,
        turnId: "turn-1",
        phase: "completed" as const,
        text: "relay payload",
      };

      assert.equal(publishFlockEvent(eventDir, later).published, true);
      assert.equal(publishFlockEvent(eventDir, earlier).published, true);
      assert.equal(publishFlockEvent(eventDir, earlier).published, false);

      assert.deepEqual(enumerateFlockEventFiles(eventDir), [
        getFlockEventFileName("a-event"),
        getFlockEventFileName("z-event"),
      ]);
      assert.deepEqual(
        readFlockEvents(eventDir).map((result) => result.ok && result.event.eventId),
        ["a-event", "z-event"],
      );
      assert.equal(
        readdirSync(eventDir).some((fileName) => fileName.endsWith(".tmp")),
        false,
      );
    });
  });

  it("contains untrusted JSON, filename traversal, and filename/event-ID mismatches", () => {
    withEventDir((eventDir) => {
      const badJsonName = getFlockEventFileName("bad-json");
      writeFileSync(join(eventDir, badJsonName), "{not json");
      const mismatchName = getFlockEventFileName("expected-id");
      writeFileSync(
        join(eventDir, mismatchName),
        JSON.stringify({
          version: FLOCK_EVENT_VERSION,
          eventId: "different-id",
          createdAt: 1,
          ...identity,
          type: "closed",
          reason: "completed",
        }),
      );

      const results = readFlockEvents(eventDir);
      assert.deepEqual(results.map((result) => result.ok), [false, false]);
      assert.match(results[1].error, /does not match filename/);

      const traversal = readFlockEventFile(eventDir, "../outside.json");
      assert.equal(traversal.ok, false);
      assert.equal(traversal.filePath, eventDir);
      assert.match(traversal.error, /invalid event filename/);
    });
  });

  it("validates a strict versioned schema and dedupes by event ID", () => {
    const event = {
      version: FLOCK_EVENT_VERSION,
      eventId: "event-1",
      createdAt: 1,
      ...identity,
      type: "closed" as const,
      reason: "failed" as const,
      text: "provider error",
    };
    const validated = validateFlockEvent(event);
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    assert.equal(validateFlockEvent({ ...event, rootId: "../escape" }).ok, false);
    assert.equal(validateFlockEvent({ ...event, unexpected: true }).ok, false);
    assert.deepEqual(
      dedupeFlockEvents([validated.event, validated.event]),
      [validated.event],
    );
  });
});
