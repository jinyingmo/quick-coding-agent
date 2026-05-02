# quick-coding-agent

This repository now uses a pnpm workspace layout centered on one combined demo:

- `packages/agent-tool-call`: Claude-Code-style tool-calling agent demo with persistent memory built in

## Workspace structure

```text
quick-coding-agent/
├── packages/
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
