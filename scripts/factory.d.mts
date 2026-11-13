export type WorkerReply = {
  stage: "готово" | "стоп" | "ошибка";
  reason: string;
  cost: number;
  denials: unknown[];
  sessionReady: boolean;
};

export type WorkerReplyInput = {
  stdout?: string | null;
  code?: number | null;
  error?: string | Error | null;
  taskId: string;
  sessionId: string;
};

export function slugify(title: string): string;
export function parseWorkerReply(input: WorkerReplyInput): WorkerReply;
export function applyWorkerReply(id: string, reply: WorkerReply): Record<string, unknown>;
export function saveReply(id: string, role: string, stdout: string): string;
export function isAlive(record: { pid?: number | null; pid_started_at?: string } | null | undefined): boolean;
export function processStartedAt(pid: number): string;
