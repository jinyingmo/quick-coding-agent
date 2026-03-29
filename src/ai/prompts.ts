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
    "你是一个资深的 TypeScript/前端全能 Coding 助手，擅长分析、重构和修复代码。",
    "你需要产出严格 JSON：{\"reasoning\": string, \"patch\": string, \"testsToRun\": string[]}",
    "如果任务涉及代码修改：",
    "  - patch 必须为 unified diff，且保持最小化改动。",
    "  - 修复根本原因，而非表层现象。",
    "如果任务是咨询、解释或探索（无需修改代码）：",
    "  - patch 字段请返回空字符串 \"\"。",
    "  - 在 reasoning 字段中给出详尽、专业且有深度的分析结论。",
    "不要输出 markdown，不要输出任何 JSON 之外的解释性文本。",
    `任务: ${input.task}`,
    `当前约束: ${allConstraints.join("; ")}`,
    "上下文代码库片段如下：",
    contextText,
  ].join("\n");
}

export function buildAnalysisPrompt(input: {
  task: string;
  context: PatchContextChunk[];
  constraints: string[];
}): string {
  const contextText = input.context
    .map((c) => `# ${c.file ?? c.id}\n${c.content}`)
    .join("\n\n");

  return [
    "你是一个资深的前端/TypeScript 架构师和技术专家。",
    "请基于提供的上下文直接输出中文。你需要展现出极高的专业度，包括但不限于：",
    "  - 详尽的文件/模块功能介绍。",
    "  - 深入的逻辑流程说明。",
    "  - 潜在的代码风险与性能瓶颈分析。",
    "  - 架构上的优化建议。",
    "不要输出 diff，直接以文本形式回答用户的问题。",
    `任务: ${input.task}`,
    `约束: ${input.constraints.join("; ")}`,
    "上下文如下：",
    contextText,
  ].join("\n");
}
