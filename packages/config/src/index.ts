import { z } from "zod";

export const ChainMcpConfigSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(128),
    server: z
      .object({
        transport: z.literal("stdio").default("stdio"),
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(3333),
        requestTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(300_000)
          .default(15_000),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(100_000_000)
          .default(1_000_000),
      })
      .strict()
      // prefault, not default: Zod 4 `.default({})` short-circuits inner
      // parsing and would return `{}` without the field defaults above.
      .prefault({}),
    security: z
      .object({
        requireInboundAuth: z.boolean().default(false),
        allowedUpstreamHosts: z.array(z.string().min(1)).default([]),
        redactHeaders: z
          .array(z.string().min(1))
          .default(["authorization", "cookie", "x-api-key"]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type ChainMcpConfig = z.infer<typeof ChainMcpConfigSchema>;

export function parseConfig(input: unknown): ChainMcpConfig {
  return ChainMcpConfigSchema.parse(input);
}
