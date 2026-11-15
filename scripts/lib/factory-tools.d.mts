export const WORKER_ALLOWED: string[];
export const WORKER_DISALLOWED: string[];
export const WORKER_BUDGET_USD: number;
export function matchesRule(rule: string, command: string): boolean;
export const WORKER_TIMEOUT_MIN: number;
export function workerBudgetUsd(env?: Record<string, string | undefined>): number;
export function workerTimeoutMs(env?: Record<string, string | undefined>): number;
export function worktreeGlob(worktree: string): string;
export function workerAllowed(worktree: string): string[];
export const RIGHTS: Record<string, string[]>;
export const KNOWN_RIGHTS: string[];
export function rightsAllowed(rights?: string[]): string[];
export type AgentInvocation = { command: "dsh"; args: string[]; prompt: string };
export function agentInvocation(
  role: "sh-reviewer" | "sh-verifier" | "sh-retro" | "sh-worker",
  opts?: {
    sessionId?: string;
    worktree?: string;
    model?: string;
    effort?: string;
    prompt?: string;
  },
): AgentInvocation;
export const MODEL_PRICE_CNY_PER_MTOK: Record<string, { input: number; output: number }>;
