import path from "node:path";

const allowedExt = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml"]);

export interface PatchValidationResult {
  ok: boolean;
  error?: string;
}

export class PatchValidator {
  constructor(
    private maxFiles = 5,
    private maxChangedLines = 300
  ) {}

  validate(diffText: string): PatchValidationResult {
    if (!diffText.trim()) {
      return { ok: false, error: "Patch is empty" };
    }

    const filesFromGit = Array.from(diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)).map((m) => m[2]);
    const filesFromPlus = Array.from(diffText.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm))
      .map((m) => m[1])
      .filter((x) => x !== "/dev/null");
    const files = filesFromGit.length > 0 ? filesFromGit : filesFromPlus;
    const uniqueFiles = new Set(files);
    if (uniqueFiles.size === 0) {
      return { ok: false, error: "Patch has no file targets" };
    }
    if (uniqueFiles.size > this.maxFiles) {
      return { ok: false, error: `Patch touches too many files: ${uniqueFiles.size}` };
    }

    for (const file of uniqueFiles) {
      const ext = path.extname(file);
      if (!allowedExt.has(ext)) {
        return { ok: false, error: `Forbidden file extension in patch: ${ext}` };
      }
    }

    const changedLines = diffText
      .split("\n")
      .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
      .length;
    if (changedLines > this.maxChangedLines) {
      return { ok: false, error: `Patch too large: ${changedLines} lines` };
    }

    return { ok: true };
  }
}
