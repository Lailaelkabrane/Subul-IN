// Real API client — calls the FastAPI backend
// Set NEXT_PUBLIC_API_URL in .env.local to override (e.g. for Azure production)
export const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8010';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem('adminToken') ?? '';
}

// Single redirect coordinator — when 9 parallel requests all hit 401, only ONE
// triggers the redirect. Without this each .catch() races to set
// window.location.href and some get swallowed by `.catch(() => null)` in
// dashboard/page.tsx, leaving the user on a half-rendered admin page.
let _redirecting = false;
function _handle401() {
  if (_redirecting || typeof window === 'undefined') return;
  _redirecting = true;
  try { sessionStorage.removeItem('adminToken'); } catch {}
  window.location.href = '/login';
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    _handle401();
    throw new Error('Session expired — please log in again');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ── Interfaces ────────────────────────────────────────────

export interface ModelCostInfo {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  rate_input_per_1m: number;
  rate_output_per_1m: number;
}

export interface StatsResponse {
  total_users: number;
  total_requests: number;
  total_tokens: number;
  tokens_in: number;
  tokens_out: number;
  avg_latency_ms: number;
  requests_by_action: Record<string, number>;
  requests_by_model: Record<string, number>;
  requests_last_7_days: { date: string; count: number }[];
  top_users: { email: string; count: number }[];
  cosmos_db?: { total_snapshots: number };
  model_costs: Record<string, ModelCostInfo>;
  total_cost_usd: number;
  success_rate: number;
}

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  last_seen: string;
  is_active: boolean;
  auth_provider: string;
  request_count: number;
}

export interface UsersResponse {
  total: number;
  page: number;
  page_size: number;
  users: UserRow[];
}

export interface LogRow {
  id: string;
  user_email: string;
  action: string;
  deployment: string;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

export interface LogsResponse {
  total: number;
  page: number;
  page_size: number;
  logs: LogRow[];
}

export interface SnapshotRow {
  id: string;
  captured_at: string;
  user_id: string;
  user_email: string;
  profile_url: string;
  name: string;
  headline: string;
  connections: number;
  followers: number;
  source: string;
}

export interface SnapshotsResponse {
  page: number;
  page_size: number;
  total: number;
  snapshots: SnapshotRow[];
}

export interface NetworkingStatsResponse {
  total_interactions: number;
  total_connected: number;
  total_skipped: number;
  acceptance_rate: number;
  goal_distribution: Record<string, number>;
  avg_score_at_connect: number;
  avg_score_at_skip: number;
}

export interface InteractionRow {
  id: string;
  user_id: string;
  suggested_profile_id: string;
  score_given: number;
  user_action: string;
  timestamp: string;
}

export interface NetworkingInteractionsResponse {
  total: number;
  page: number;
  page_size: number;
  interactions: InteractionRow[];
}

export interface FeatureStatsResponse {
  gap_analysis_count: number;
  ai_score_count: number;
  networking_message_count: number;
}

// ── Subul Users ──────────────────────────────────────────

export interface SubulUserRow {
  id: string;
  email: string;
  created_at: string;
  last_seen: string;
  is_active: boolean;
  auth_provider: string;
  request_count: number;
}

export interface SubulUsersResponse {
  total: number;
  page: number;
  page_size: number;
  users: SubulUserRow[];
}

export interface SubulStatsResponse {
  total_subul_users: number;
  active_subul_users: number;
  inactive_subul_users: number;
  total_requests: number;
  requests_by_action: Record<string, number>;
}

// ── Per-User Data ────────────────────────────────────────

export interface UserUsageStats {
  total_requests: number;
  total_tokens: number;
  requests_by_action: Record<string, number>;
  recent_logs: {
    action: string;
    created_at: string;
    deployment: string;
    success: boolean;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
  }[];
}

export interface UserNetworkingStats {
  connections_made: number;
  connections_skipped: number;
  acceptance_rate: number;
  messages_sent: number;
  messages_accepted: number;
  networking_goal: string;
  goal_industry: string;
}

export interface UserAiHistory {
  ai_scores: { id: string; overall_score: number; grade: string; profile_type: string; created_at: string }[];
  gap_analyses: { id: string; target_name: string; target_slug: string; overall_gap_score: number; score_label: string; created_at: string }[];
  chat_count: number;
}

export interface UserCompleteData {
  user: {
    id: string;
    email: string;
    auth_provider: string;
    is_admin: boolean;
    is_active: boolean;
    created_at: string;
    last_seen: string;
  };
  usage: UserUsageStats;
  networking: UserNetworkingStats;
  ai_history: UserAiHistory;
  snapshots: SnapshotRow[];
}

// ── Auth ──────────────────────────────────────────────────

export async function adminLogin(
  email: string,
  password: string,
): Promise<{ token: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? 'Login failed');
  }

  const data = await res.json();
  // sessionStorage: token cleared when browser tab closes (safer than localStorage for admin creds)
  sessionStorage.setItem('adminToken', data.token);
  sessionStorage.setItem('adminEmail', data.email);
  return data;
}

// ── API object ────────────────────────────────────────────

export const api = {
  getStats: (): Promise<StatsResponse> =>
    apiFetch('/admin/stats'),

  getUsers: (page = 1): Promise<UsersResponse> =>
    apiFetch(`/admin/users?page=${page}&page_size=20`),

  getLogs: (page = 1, filters?: { action?: string; status?: string; from?: string; to?: string }): Promise<LogsResponse> => {
    const params = new URLSearchParams({ page: String(page), page_size: '50' });
    if (filters?.action) params.set('action', filters.action);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.from) params.set('from_date', filters.from);
    if (filters?.to) params.set('to_date', filters.to);
    return apiFetch(`/admin/logs?${params}`);
  },

  getSnapshots: (page = 1): Promise<SnapshotsResponse> =>
    apiFetch(`/admin/snapshots?page=${page}&page_size=20`),

  deactivateUser: (userId: string): Promise<{ success: boolean }> =>
    apiFetch(`/admin/users/${encodeURIComponent(userId)}/deactivate`, { method: 'PATCH' }),

  reactivateUser: (userId: string): Promise<{ success: boolean }> =>
    apiFetch(`/admin/users/${encodeURIComponent(userId)}/reactivate`, { method: 'PATCH' }),

  getNetworkingStats: (): Promise<NetworkingStatsResponse> =>
    apiFetch('/admin/networking/stats'),

  getNetworkingInteractions: (page = 1): Promise<NetworkingInteractionsResponse> =>
    apiFetch(`/admin/networking/interactions?page=${page}&page_size=50`),

  getFeatureStats: (): Promise<FeatureStatsResponse> =>
    apiFetch('/admin/feature-stats'),

  // Subul users
  getSubulStats: (): Promise<SubulStatsResponse> =>
    apiFetch('/admin/subul/stats'),

  getSubulUsers: (page = 1): Promise<SubulUsersResponse> =>
    apiFetch(`/admin/subul/users?page=${page}&page_size=20`),

  // Per-user data
  getUserData: (userId: string): Promise<UserCompleteData> =>
    apiFetch(`/admin/users/${encodeURIComponent(userId)}/data`),
};
