export type UserRole = 'admin' | 'guest' | string;

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  dailyTokenLimit?: number | null;
  quotaResetMode?: string;
}

export interface DashboardStats {
  providersCount: number;
  modelsCount: number;
  keysCount: number;
}

export interface StatusResponse {
  initialized: boolean;
}

export interface AuthSuccessResponse {
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  stats: DashboardStats;
}

export interface ProviderSummary {
  id: string;
  name: string;
}

export interface ProvidersResponse {
  providers: ProviderSummary[];
}

export interface InternalApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface KeysListResponse {
  keys: InternalApiKey[];
}

export interface CreateKeyResponse {
  key: InternalApiKey;
  rawKey: string;
}

export type ActiveTab = 'overview' | 'keys' | 'providers';
