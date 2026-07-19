/**
 * Smoke tests for legacy system-prompt frontmatter parsing and Pi-only
 * append composition. The authoritative launch artifact tests are in test.ts.
 */
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  pass: ${message}`);
    passed++;
  } else {
    console.log(`  fail: ${message}`);
    failed++;
  }
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const get = (key: string) => {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return value ? value[1].trim() : undefined;
  };
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = get("system-prompt");
  return {
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    body: body || undefined,
  };
}

function composeSystemPromptFlags(agentBody: string | undefined, callerSystemPrompt: string | undefined) {
  return [agentBody, callerSystemPrompt]
    .filter((prompt): prompt is string => prompt !== undefined)
    .map(() => "--append-system-prompt");
}

const AGENT_REPLACE = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: replace
---

You are a specialized agent.`;

const AGENT_APPEND = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: append
---

You are an appended identity.`;

const AGENT_DEFAULT = `---
model: anthropic/claude-sonnet-4-20250514
---

You are a default agent.`;

console.log("\nFrontmatter parsing");
const replace = parseFrontmatter(AGENT_REPLACE)!;
assert(replace.systemPromptMode === "replace", "legacy replace metadata remains parseable");
assert(replace.body === "You are a specialized agent.", "agent body is extracted");
assert(parseFrontmatter(AGENT_APPEND)!.systemPromptMode === "append", "append metadata is parseable");
assert(parseFrontmatter(AGENT_DEFAULT)!.systemPromptMode === undefined, "missing metadata remains unset");

console.log("\nPi-only prompt composition");
const both = composeSystemPromptFlags(replace.body, "Caller instructions.");
assert(
  both.length === 2 && both.every((flag) => flag === "--append-system-prompt"),
  "agent and caller instructions are independently appended",
);
assert(
  !both.includes("--system-prompt"),
  "replace mode never selects Pi's replacement system-prompt flag",
);
assert(
  composeSystemPromptFlags(undefined, "Caller instructions.").length === 1,
  "caller instructions are retained without an agent body",
);
assert(
  composeSystemPromptFlags(undefined, undefined).length === 0,
  "no system prompt artifacts are emitted when neither source is present",
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
