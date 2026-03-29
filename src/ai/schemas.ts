import { z } from "zod";

export const patchProposalSchema = z.object({
  reasoning: z.string().default(""),
  patch: z.string(),
  testsToRun: z.array(z.string()).default([]),
});
