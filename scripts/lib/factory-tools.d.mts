export const WORKER_ALLOWED: string[];
export const WORKER_DISALLOWED: string[];
export const WORKER_BUDGET_USD: number;
export function matchesRule(rule: string, command: string): boolean;
export const WORKER_TIMEOUT_MIN: number;
export function workerBudgetUsd(env?: Record<string, string | undefined>): number;
export function workerTimeoutMs(env?: Record<string, string | undefined>): number;
export function worktreeGlob(worktree: string): string;
export function workerAllowed(worktree: string): string[];
