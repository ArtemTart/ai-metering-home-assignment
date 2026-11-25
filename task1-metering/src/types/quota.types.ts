export type Period = 'hour' | 'day' | 'month';

export type Clock = () => Date;

export interface QuotaOptions {
  /** Used for users without a row in user_quotas. */
  defaultLimit: number;
  period: Period;
  /** Without an Idempotency-Key, the same prompt from the same user within this window is treated as a retry. 0 = off. */
  dedupeWindowSeconds?: number;
}

export interface PeriodBounds {
  /** Inclusive, ISO 8601 UTC. */
  start: string;
  /** Exclusive, ISO 8601 UTC. */
  end: string;
}

export interface Usage {
  userId: string;
  limit: number;
  used: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

/** The stored part of a successful response, replayed for a repeated idempotency key. */
export interface StoredResponse {
  requestId: string;
  result: string;
}

export interface ReserveInput {
  userId: string;
  /** Client-supplied; repeats of the same key are not charged again. */
  idempotencyKey?: string;
  /** Hash of the prompt, to detect a key reused for a different request. */
  requestHash: string;
}

export type ReserveResult =
  | { kind: 'reserved'; eventId: string }
  | { kind: 'quota_exceeded'; usage: Usage }
  /** Same key, already answered: return the stored response. */
  | { kind: 'replay'; response: StoredResponse }
  /** Same key, first request still running. */
  | { kind: 'in_progress' }
  /** Same key, different prompt. */
  | { kind: 'key_reused' };

export type UsageStatus = 'RESERVED' | 'COMMITTED' | 'REFUNDED';

export type RefundReason = 'AI_ERROR' | 'AI_TIMEOUT';

/** A row of usage_events: the evidence for one AI request. */
export interface UsageEvent {
  id: string;
  user_id: string;
  status: UsageStatus;
  period_start: string;
  created_at: string;
  settled_at: string | null;
  error: RefundReason | null;
  idempotency_key: string | null;
}

export interface UserUsageSummary {
  userId: string;
  limit: number;
  /** true if set via PUT /quota, false if the default applies. */
  customLimit: boolean;
  used: number;
  /** Failed AI calls this period (recorded, not charged). */
  refunded: number;
  remaining: number;
}

export interface UsersOverview {
  periodStart: string;
  periodEnd: string;
  users: UserUsageSummary[];
}
