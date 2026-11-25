export type Period = 'hour' | 'day' | 'month';

export type Clock = () => Date;

export interface QuotaOptions {
  /** Used for users without a row in user_quotas. */
  defaultLimit: number;
  period: Period;
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

export type ReserveResult = { ok: true; eventId: string } | { ok: false; usage: Usage };

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
