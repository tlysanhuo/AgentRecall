import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const idSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u, "Observation ID is invalid.");
const pathSchema = z.string().trim().min(1).max(32_768)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL.");
const modelSchema = z.string().trim().min(1).max(512).nullable();
const reasoningSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).nullable();
const titleSchema = z.string().trim().min(1).max(500);
const promptSchema = z.string().min(1).max(200_000)
  .refine((value) => value.trim().length > 0, "Prompt cannot be blank.");
const streamSchema = z.enum(["timeline", "rpc", "rollout"]);
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const limitSchema = z.number().int().min(1).max(200);
const createSchema = z.object({
  workDir: pathSchema,
  modelId: modelSchema,
  reasoningEffort: reasoningSchema,
}).strict();
const approvalSchema = z.object({
  sessionId: idSchema,
  requestId: z.string().min(1).max(256),
  decision: z.enum(["approved", "rejected"]),
}).strict();

export const CODEX_OBSERVATION_IPC = {
  list: defineIpcRequest("codex-observation:list", noInput),
  get: defineIpcRequest("codex-observation:get", z.tuple([idSchema])),
  chooseDirectory: defineIpcRequest("codex-observation:choose-directory", noInput),
  create: defineIpcRequest("codex-observation:create", z.tuple([createSchema])),
  rename: defineIpcRequest("codex-observation:rename", z.tuple([idSchema, titleSchema])),
  send: defineIpcRequest("codex-observation:send", z.tuple([idSchema, promptSchema])),
  cancel: defineIpcRequest("codex-observation:cancel", z.tuple([idSchema])),
  stop: defineIpcRequest("codex-observation:stop", z.tuple([idSchema])),
  resolveApproval: defineIpcRequest(
    "codex-observation:resolve-approval",
    z.tuple([approvalSchema]),
  ),
  events: defineIpcRequest(
    "codex-observation:events",
    z.tuple([idSchema, streamSchema, sequenceSchema, limitSchema]),
  ),
  payload: defineIpcRequest(
    "codex-observation:payload",
    z.tuple([idSchema, streamSchema, sequenceSchema]),
  ),
  delete: defineIpcRequest("codex-observation:delete", z.tuple([idSchema])),
} as const;

export const CODEX_OBSERVATION_EVENTS = {
  changed: "codex-observation:changed",
} as const;
