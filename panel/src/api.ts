import type {
  AuthSuccessResponse,
  CreateKeyResponse,
  KeysListResponse,
  MeResponse,
  ProvidersResponse,
  StatusResponse,
} from './types';

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  let payload: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
  }

  if (!response.ok) {
    const errObj = (payload && typeof payload === 'object' ? payload : {}) as Record<
      string,
      unknown
    >;
    const serverMsg =
      (typeof errObj.error === 'string' && errObj.error) ||
      (typeof errObj.message === 'string' && errObj.message) ||
      `Error HTTP ${response.status}`;
    throw new ApiError(serverMsg, response.status);
  }

  return payload as T;
}

export const api = {
  getStatus(): Promise<StatusResponse> {
    return request<StatusResponse>('/api/status', { method: 'GET' });
  },

  setupAdmin(username: string, password: string): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  login(username: string, password: string): Promise<AuthSuccessResponse> {
    return request<AuthSuccessResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    });
  },

  getMe(): Promise<MeResponse> {
    return request<MeResponse>('/api/auth/me', { method: 'GET' });
  },

  getProviders(): Promise<ProvidersResponse> {
    return request<ProvidersResponse>('/api/providers', { method: 'GET' });
  },

  getKeys(): Promise<KeysListResponse> {
    return request<KeysListResponse>('/api/keys', { method: 'GET' });
  },

  createKey(name: string): Promise<CreateKeyResponse> {
    return request<CreateKeyResponse>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  revokeKey(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
