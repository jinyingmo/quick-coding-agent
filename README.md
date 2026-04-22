# quick-coding-agent

This repository now uses a pnpm workspace layout to host two related demos:

- `packages/memory-system`: persistent memory core + sample memory files
- `packages/agent-tool-call`: Claude-Code-style tool-calling agent demo

## Workspace structure

```text
quick-coding-agent/
├── packages/
│   ├── memory-system/
│   └── agent-tool-call/
├── package.json
└── pnpm-workspace.yaml
```

## Quick start

```bash
pnpm install
pnpm build
pnpm agent:demo
```

Useful scripts:

- `pnpm agent:repl`
- `pnpm memory:demo`
- `pnpm memory:demo:local`
