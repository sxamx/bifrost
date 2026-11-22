import type { MetricsRange, Percentiles } from './stats.js';

export type UserRole = 'admin' | 'guest';
export type QuotaResetMode = 'utc_midnight' | 'rolling_24h';
export type UptimeDayState = 'ok' | 'partial' | 'error' | 'no_data';
export type ActivityRange = 'today' | '24h' | '7d' | '30d';
export type ActivityGroupBy = 'model' | 'provider' | 'user' | 'apiKey';
export type SystemLogLevel = 'info' | 'warn' | 'error';
export type SystemLogCategory =
  | 'failover'
  | 'stream_resume'
  | 'node'
  | 'sync'
  | 'auth'
  | 'backup'
  | 'system';

export interface SummaryMetricsOptions {
  nowSec?: number;
  userId: string;
  role: UserRole;
}

export interface SummaryMetricsResult {
  quotaToday: {
    configuredDailyLimit: number | null;
    providerRateLimitRemaining: number | null;
    usedTokensToday: number;
    remainingTokensToday: number | null;
    usedPct: number | null;
    quotaResetMode: QuotaResetMode;
    nextResetAt: string;
    earliestProviderResetAt: string | null;
    activeWindow?: 'hour' | 'day' | 'week';
    windowSeconds?: number;
    windowLabel?: string;
    confidence?: 'header_exact' | 'configured' | 'inferred';
    effectiveLimit?: number | null;
    adaptiveAdjusted?: boolean;
  };
  providersCount: number;
  activeModelsCount: number;
  onlineNodesCount: number;
  providerQuotas?: import('./adaptive-quota.js').ProviderAdaptiveQuota[];
}

export interface LatencyMetricsOptions {
  nowSec?: number;
  range: MetricsRange;
  providerId?: string;
  modelFullId?: string;
  userId?: string;
}

export interface LatencyBucket extends Percentiles {
  bucketStartSec: number;
  timestamp: number;
  label: string;
  sampleCount: number;
  count: number;
}

export interface LatencyMetricsResult {
  range: MetricsRange;
  granularity: 'hour' | 'day';
  overall: Percentiles & {
    sampleCount: number;
    percentiles: Percentiles;
  };
  buckets: LatencyBucket[];
}

export interface SpeedAndCacheMetricsOptions {
  nowSec?: number;
  range: MetricsRange;
}

export interface ModelSpeedMetrics {
  modelFullId: string;
  modelName: string;
  providerId: string;
  sampleCount: number;
  ttftMs: Percentiles;
  tokensPerSec: Percentiles;
}

export interface ProviderCacheMetrics {
  providerId: string;
  providerName: string;
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  cacheHitRate: number | null;
}

export interface SpeedAndCacheMetricsResult {
  range: MetricsRange;
  models: ModelSpeedMetrics[];
  providers: ProviderCacheMetrics[];
  cacheByProvider: ProviderCacheMetrics[];
}

export interface Uptime60DaysOptions {
  nowSec?: number;
}

export interface UptimeDayCell {
  date: string;
  dayStartSec: number;
  totalRequests: number;
  okRequests: number;
  errorRequests: number;
  uptimePct: number | null;
  state: UptimeDayState;
}

export interface ProviderUptime60Days {
  providerId: string;
  providerName: string;
  totalRequests60d: number;
  okRequests60d: number;
  overallUptimePct: number | null;
  overallState: UptimeDayState;
  days: UptimeDayCell[];
}

export interface Uptime60DaysResult {
  windowDays: 60;
  fromDate: string;
  toDate: string;
  providers: ProviderUptime60Days[];
}

export interface ProviderErrorRates7dOptions {
  nowSec?: number;
}

export interface ProviderErrorRateItem {
  providerId: string;
  providerName: string;
  totalRequests: number;
  toolErrors: number;
  structuredErrors: number;
  toolErrorRate: number | null;
  structuredErrorRate: number | null;
}

export interface ProviderErrorRates7dResult {
  windowDays: 7;
  fromDate: string;
  toDate: string;
  providers: ProviderErrorRateItem[];
}

export interface TokenActivityOptions {
  nowSec?: number;
  range: ActivityRange;
  groupBy: ActivityGroupBy;
  filterId?: string;
  userIdScope?: string;
}

export interface TokenVolumeTotals {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface TokenActivitySeriesBucket extends TokenVolumeTotals {
  bucketStartSec: number;
  label: string;
}

export interface TokenActivityBreakdownRow extends TokenVolumeTotals {
  id: string;
  key: string;
  label: string;
  requestsCount: number;
}

export interface TokenActivityResult {
  range: ActivityRange;
  granularity: 'hour' | 'day';
  groupBy: ActivityGroupBy;
  totals: TokenVolumeTotals;
  series: TokenActivitySeriesBucket[];
  breakdown: TokenActivityBreakdownRow[];
  items: TokenActivityBreakdownRow[];
}

export interface QuerySystemLogsOptions {
  level?: SystemLogLevel;
  category?: SystemLogCategory;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface SystemLogItem {
  id: number;
  level: SystemLogLevel;
  category: SystemLogCategory;
  message: string;
  meta: unknown;
  createdAt: number;
}

export interface QuerySystemLogsResult {
  total: number;
  limit: number;
  offset: number;
  items: SystemLogItem[];
  logs: SystemLogItem[];
}
