export const STAGES: string[];
export const STAGES_RUNNING: string[];
export const STAGES_WAIT_OWNER: string[];
export const LOCK_WAIT_MS: number;
export const LOCK_STALE_MS: number;
export class StateBusyError extends Error {}
export function stateDir(cwd?: string): string;
export const emptyState: () => { tasks: Record<string, unknown> };
export function readState(): { tasks: Record<string, Record<string, unknown>> };
export function logLine(id: string, text: string): void;
export function newTask(id: string, fields?: Record<string, unknown>): Record<string, unknown>;
export function createTask(id: string, fields?: Record<string, unknown>): Record<string, unknown>;
export function updateTask(
  id: string,
  patch: Record<string, unknown> | ((task: Record<string, unknown>) => Record<string, unknown>),
): Record<string, unknown>;
export function removeTask(id: string): void;
export function setStage(
  id: string,
  stage: string,
  reason?: string,
  extra?: Record<string, unknown> | ((task: Record<string, unknown>) => Record<string, unknown>),
): Record<string, unknown>;
