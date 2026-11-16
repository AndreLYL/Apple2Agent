import type { ZodType } from "zod";
import type { AccessContext, Capability, Domain } from "../core/context.js";
export interface ToolDefinition {
  schema: ZodType;
  description: string;
  capability: Capability;
  destructive?: boolean;
  readOnly?: boolean;
  run(ctx: AccessContext, input: any): Promise<any>;
}
export type ToolRegistry = Record<string, ToolDefinition>;
export interface Module {
  domain: Domain;
  tools: ToolRegistry;
  status(ctx: AccessContext): Promise<unknown>;
}
