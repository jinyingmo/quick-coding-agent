/**
 * Terminal UI Module
 * Provides visual feedback and formatted output for the agent
 */

// Core components
export {
  colors,
  icons,
  startSpinner,
  updateSpinner,
  stopSpinner,
  status,
  header,
  section,
  kv,
  listItem,
  codeBlock,
  box,
  progressBar,
  table,
  diffView,
  elapsed,
  clear,
  divider,
  blank,
  truncate,
} from "./components.js";

// Result rendering
export {
  renderSuccessResult,
  renderFailureResult,
  renderAnalysisResult,
  renderPatchPreview,
  renderDiffPatch,
  renderVerificationResult,
  renderTaskResult,
  messageBox,
  renderSteps,
  type RenderOptions,
} from "./result-renderer.js";

// Agent progress
export {
  AgentProgressUI,
  createProgressUI,
  withProgress,
  type AgentPhase,
  type ProgressState,
  type StepInfo,
} from "./agent-progress.js";
