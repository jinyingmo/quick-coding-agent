import { z } from "zod";

export const patchProposalSchema = z.object({
  reasoning: z.string().default(""),
  patch: z.string().min(1),
  testsToRun: z.array(z.string()).default([]),
});
