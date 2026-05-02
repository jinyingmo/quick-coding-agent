/**
 * Build the memory behavioral instructions prompt.
 *
 * This is the text that would be injected into the system prompt
 * in the full Claude Code system.
 */

import { MEMORY_TYPES } from './types.js'
import { readEntrypoint } from './indexer.js'

export async function buildMemoryPrompt(memoryDir: string): Promise<string> {
  const entrypointContent = await readEntrypoint(memoryDir)

  const lines: string[] = [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`.`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Types of memory',
    '',
    'There are several discrete types of memory that you can store in your memory system:',
    '',
    ...MEMORY_TYPES.map(
      (t) =>
        `- **${t}**: ${typeDescription(t)}`
    ),
    '',
    '## What NOT to save in memory',
    '',
    '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
    '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
    '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
    '- Anything already documented in CLAUDE.md files.',
    '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
    '',
    'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
    '',
    '## How to save memories',
    '',
    'Saving a memory is a two-step process:',
    '',
    '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
    '',
    '```markdown',
    '---',
    'name: {{memory name}}',
    'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
    `type: {{${MEMORY_TYPES.join(', ')}}}`,
    '---',
    '',
    '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
    '```',
    '',
    '**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.',
    '',
    '- `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise',
    '- Keep the name, description, and type fields in memory files up-to-date with the content',
    '- Organize memory semantically by topic, not chronologically',
    '- Update or remove memories that turn out to be wrong or outdated',
    '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
    '',
    '## When to access memories',
    '',
    '- When memories seem relevant, or the user references prior-conversation work.',
    '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
    '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
    '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.',
    '',
    '## Before recommending from memory',
    '',
    'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
    '',
    '- If the memory names a file path: check the file exists.',
    '- If the memory names a function or flag: grep for it.',
    '- If the user is about to act on your recommendation (not just asking about history), verify first.',
    '',
    '"The memory says X exists" is not the same as "X exists now."',
    '',
    'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
    '',
    '## Memory and other forms of persistence',
    '',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    '',
    '---',
    '',
    '## MEMORY.md',
    '',
  ]

  if (entrypointContent) {
    lines.push(entrypointContent)
  } else {
    lines.push('Your MEMORY.md is currently empty. When you save new memories, they will appear here.')
  }

  return lines.join('\n')
}

function typeDescription(type: string): string {
  switch (type) {
    case 'user':
      return "Information about the user's role, goals, responsibilities, and knowledge."
    case 'feedback':
      return 'Guidance the user has given about how to approach work — what to avoid and what to keep doing.'
    case 'project':
      return 'Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from code or git history.'
    case 'reference':
      return 'Pointers to where information can be found in external systems.'
    default:
      return ''
  }
}
