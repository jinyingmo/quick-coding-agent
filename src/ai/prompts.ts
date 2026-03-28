import type { PatchContextChunk } from "./llm-client.js";

const SEMANTIC_RULES = [
  "Patch 必须最小化且有针对性，避免不相关的修改",
  "永远不要修改密钥文件或敏感信息存储",
  "修复必须针对根本原因，而非仅仅处理症状",
];

export function buildPatchPrompt(input: {
  task: string;
  context: PatchContextChunk[];
  constraints: string[];
}): string {
  const contextText = input.context
    .map((c) => `# ${c.file ?? c.id}\n${c.content}`)
    .join("\n\n");

  const allConstraints = [...input.constraints, ...SEMANTIC_RULES];

  return [
    "你是一个资深 TypeScript 代码修复代理。",
    "你需要产出严格 JSON：{\"reasoning\": string, \"patch\": string, \"testsToRun\": string[]}",
    "patch 必须为 unified diff，且最小化改动。",
    "不要输出 markdown，不要输出解释性前后缀。",
    `任务: ${input.task}`,
    `约束: ${allConstraints.join("; ")}`,
    "上下文如下：",
    contextText,
  ].join("\n");
}
