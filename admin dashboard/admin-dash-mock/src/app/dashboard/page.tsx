'use client';
import React, { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api, StatsResponse, UsersResponse, LogsResponse, SnapshotsResponse, NetworkingStatsResponse, NetworkingInteractionsResponse, FeatureStatsResponse, SubulStatsResponse, SubulUsersResponse } from '@/lib/api';
import { ACTION_LABELS, ACTION_COLORS } from '@/lib/actionMeta';
import StatsCards          from '@/components/StatsCards';
import RequestsChart       from '@/components/RequestsChart';
import ModelUsageChart     from '@/components/ModelUsageChart';
import UsersTable          from '@/components/UsersTable';
import LogsTable           from '@/components/LogsTable';
import SnapshotsTable      from '@/components/SnapshotsTable';
import ActivityFeed        from '@/components/ActivityFeed';
import NetworkingStatsTab  from '@/components/NetworkingStatsTab';
import NotificationsTab    from '@/components/NotificationsTab';
import SubulUsersTab       from '@/components/SubulUsersTab';
import UserDetailModal     from '@/components/UserDetailModal';

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 10)  return 'just now';
  if (secs < 60)  return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return mins + 'm ago';
  return Math.floor(mins / 60) + 'h ago';
}

interface LogFilters { action?: string; status?: string; from?: string; to?: string; }

export default function DashboardPage() {
  const router = useRouter();
  const [stats,            setStats]            = useState<StatsResponse | null>(null);
  const [users,            setUsers]            = useState<UsersResponse | null>(null);
  const [logs,             setLogs]             = useState<LogsResponse | null>(null);
  const [logFilters,       setLogFilters]       = useState<LogFilters>({});
  const [snapshots,        setSnapshots]        = useState<SnapshotsResponse | null>(null);
  const [netStats,         setNetStats]         = useState<NetworkingStatsResponse | null>(null);
  const [netInteractions,  setNetInteractions]  = useState<NetworkingInteractionsResponse | null>(null);
  const [featureStats,     setFeatureStats]     = useState<FeatureStatsResponse | null>(null);
  const [subulStats,       setSubulStats]       = useState<SubulStatsResponse | null>(null);
  const [subulUsers,       setSubulUsers]       = useState<SubulUsersResponse | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [refreshing,       setRefreshing]       = useState(false);
  const [error,            setError]            = useState('');
  const [dark,             setDark]             = useState(false);
  const [tab,              setTab]              = useState<'overview' | 'users' | 'logs' | 'snapshots' | 'networking' | 'subul' | 'notifications'>('overview');
  const [viewUserId,       setViewUserId]       = useState<string | null>(null);
  const [lastUpdated,      setLastUpdated]      = useState<Date | null>(null);
  const [actionError,      setActionError]      = useState('');
  const [, setTick] = useState(0); // setTick triggers re-renders every 30s so timeAgo() stays current
  const adminEmail = typeof window !== 'undefined' ? sessionStorage.getItem('adminEmail') ?? '' : '';

  // Early route guard — runs synchronously before paint so unauthenticated
  // visitors never see the dashboard skeleton or any of its child components.
  // (Audit: previous guard was inside loadAll's async path, after render.)
  const [authChecked, setAuthChecked] = useState(false);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    if (!sessionStorage.getItem('adminToken')) {
      router.replace('/login');
      return;
    }
    setAuthChecked(true);
  }, [router]);

  useEffect(() => {
    const saved = localStorage.getItem('darkMode');
    if (saved === 'true') setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('darkMode', String(dark));
  }, [dark]);

  const loadAll = useCallback(async (silent = false) => {
    if (!sessionStorage.getItem('adminToken')) { router.push('/login'); return; }
    silent ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const [s, u, l, sn, ns, ni, fs, ss, su] = await Promise.all([
        api.getStats(), api.getUsers(), api.getLogs(), api.getSnapshots(),
        api.getNetworkingStats().catch(() => null),
        api.getNetworkingInteractions().catch(() => null),
        api.getFeatureStats().catch(() => null),
        api.getSubulStats().catch(() => null),
        api.getSubulUsers().catch(() => null),
      ]);
      setStats(s); setUsers(u); setLogs(l); setSnapshots(sn);
      setNetStats(ns); setNetInteractions(ni); setFeatureStats(fs);
      setSubulStats(ss); setSubulUsers(su);
      setLastUpdated(new Date());
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      silent ? setRefreshing(false) : setLoading(false);
    }
  }, [router]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Tick every 30s to keep the 'X ago' label fresh
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  function handleLogout() {
    sessionStorage.removeItem('adminToken');
    sessionStorage.removeItem('adminEmail');
    router.push('/login');
  }

  function handleLogFiltersChange(filters: LogFilters) {
    setLogFilters(filters);
    api.getLogs(1, filters).then(setLogs);
  }

  function handleLogsPageChange(page: number) {
    api.getLogs(page, logFilters).then(setLogs);
  }

  // Route guard: render nothing until we've confirmed the user is authenticated.
  // Without this, unauthenticated visitors momentarily see the dashboard skeleton
  // before being redirected — and child components fire API calls in the meantime.
  if (!authChecked) return null;

  if (loading) return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Top bar skeleton */}
        <div className="flex justify-between items-start">
          <div className="space-y-2">
            <div className="h-7 w-48 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
            <div className="h-4 w-32 bg-gray-100 dark:bg-gray-800/60 rounded animate-pulse" />
          </div>
          <div className="h-9 w-24 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
        </div>
        {/* Tab bar skeleton */}
        <div className="flex gap-2">
          {['w-20', 'w-24', 'w-16', 'w-14', 'w-22', 'w-24', 'w-28'].map((cls, i) => (
            <div key={i} className={`h-9 ${cls} bg-gray-200 dark:bg-gray-800 rounded-xl animate-pulse`} />
          ))}
        </div>
        {/* Stats cards skeleton — 9 cards */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 border-l-4 border-l-gray-200 dark:border-l-gray-700 p-5 shadow-sm">
              <div className="h-8 w-8 bg-gray-100 dark:bg-gray-800 rounded-xl mb-3 animate-pulse" />
              <div className="h-3 w-20 bg-gray-100 dark:bg-gray-800 rounded mb-2 animate-pulse" />
              <div className="h-7 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            </div>
          ))}
        </div>
        {/* Charts skeleton */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm h-[280px] animate-pulse">
            <div className="h-4 w-32 bg-gray-100 dark:bg-gray-800 rounded mb-4" />
            <div className="h-48 bg-gray-50 dark:bg-gray-800/50 rounded-xl" />
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm h-[280px] animate-pulse">
            <div className="h-4 w-28 bg-gray-100 dark:bg-gray-800 rounded mb-4" />
            <div className="h-48 bg-gray-50 dark:bg-gray-800/50 rounded-xl" />
          </div>
        </div>
      </div>
    </main>
  );

  if (error) return (
    <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-950">
      <div className="text-center bg-red-50 border border-red-200 rounded-2xl p-8 max-w-sm">
        <p className="text-red-600 font-semibold mb-2">Failed to load</p>
        <p className="text-sm text-red-500 mb-1">{error}</p>
        <p className="text-xs text-gray-400 mb-4">Make sure the backend is running on port 8010</p>
        <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm">Retry</button>
      </div>
    </div>
  );

  const TABS = [
    { id: 'overview',       label: 'Overview' },
    { id: 'users',          label: 'Users' + (users ? ' (' + users.total + ')' : '') },
    { id: 'subul',          label: 'Subul' + (subulStats ? ' (' + subulStats.total_subul_users + ')' : '') },
    { id: 'logs',           label: 'Logs' + (logs ? ' (' + logs.total + ')' : '') },
    { id: 'snapshots',      label: 'Snapshots' + (snapshots ? ' (' + snapshots.total + ')' : '') },
    { id: 'networking',     label: 'Networking' + (netStats ? ' (' + netStats.total_interactions + ')' : '') },
    { id: 'notifications',  label: 'Notifications' },
  ] as const;

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 transition-colors duration-200">
      <div className="p-6 max-w-7xl mx-auto space-y-6">

        {/* Top bar */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Admin Dashboard</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-sm text-gray-500 dark:text-gray-400">LinkedIn AI Agent</p>
              {adminEmail && (
                <>
                  <span className="text-gray-300 dark:text-gray-700">·</span>
                  <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">{adminEmail}</span>
                </>
              )}
            </div>
            {lastUpdated && (
              <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">Updated {timeAgo(lastUpdated)}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadAll(true)}
              disabled={refreshing}
              title="Refresh data"
              className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={refreshing ? 'animate-spin' : ''}>
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setDark(d => !d)}
              className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Toggle dark mode"
            >
              {dark ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Stats cards — success_rate now comes from server-side aggregate */}
        {stats && <StatsCards stats={stats} featureStats={featureStats} />}

        {/* Tab navigation */}
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ' + (
                tab === t.id
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              )}>
              {t.label}
            </button>
          ))}
        </div>

        <div role="alert" aria-live="polite">
          {actionError && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-700 dark:text-red-400">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError('')} className="text-red-400 hover:text-red-600 font-bold flex-shrink-0">×</button>
            </div>
          )}
        </div>

        {/* Overview tab */}
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {stats && <RequestsChart data={stats.requests_last_7_days} />}
              {stats && <ModelUsageChart data={stats.requests_by_model} modelCosts={stats.model_costs} />}
            </div>

            {/* Activity feed + top users */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {logs && <ActivityFeed logs={logs.logs} />}

              {stats && stats.top_users.length > 0 && (
                <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                    <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Top Users by Requests</h2>
                  </div>
                  <div className="divide-y divide-gray-50 dark:divide-gray-800">
                    {stats.top_users.map((u, i) => (
                      <div key={u.email} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                        <div className="flex items-center gap-3">
                          <span className={'w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 ' + (
                            i === 0 ? 'bg-amber-100 text-amber-700' :
                            i === 1 ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' :
                            i === 2 ? 'bg-orange-100 text-orange-700' :
                                      'bg-gray-50 text-gray-400 dark:bg-gray-800/50'
                          )}>
                            {i + 1}
                          </span>
                          <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{u.email}</span>
                        </div>
                        <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 flex-shrink-0">{u.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Feature usage + token I/O */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {featureStats && (
                <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">AI Feature Usage</h2>
                  <div className="grid grid-cols-1 gap-3">
                    {[
                      { label: 'Gap Analyses', count: featureStats.gap_analysis_count, color: 'bg-orange-500' },
                      { label: 'AI Profile Scores', count: featureStats.ai_score_count, color: 'bg-rose-500' },
                      { label: 'Networking Messages', count: featureStats.networking_message_count, color: 'bg-cyan-500' },
                    ].map(f => (
                      <div key={f.label} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
                        <div className={`w-3 h-3 rounded-full ${f.color} flex-shrink-0`} />
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 dark:text-gray-400">{f.label}</p>
                          <p className="text-lg font-bold text-gray-800 dark:text-gray-100">{(f.count ?? 0).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Engagement metrics */}
              {stats && (
                <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Engagement Metrics</h2>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Avg Requests / User</p>
                        <p className="text-lg font-bold text-gray-800 dark:text-gray-100">
                          {stats.total_users > 0 ? (stats.total_requests / stats.total_users).toFixed(1) : '0'}
                        </p>
                      </div>
                      <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-600 dark:text-indigo-400">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round"/>
                          <circle cx="9" cy="7" r="4"/>
                        </svg>
                      </div>
                    </div>
                    {(stats.tokens_in > 0 || stats.tokens_out > 0) && (
                      <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Token Distribution (In vs Out)</p>
                        <div className="flex h-3 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                          <div
                            className="bg-purple-500 transition-all bar-fill"
                            style={{ '--bar-width': `${Math.round((stats.tokens_in / (stats.tokens_in + stats.tokens_out)) * 100)}%` } as React.CSSProperties}
                          />
                          <div className="bg-pink-500 flex-1" />
                        </div>
                        <div className="flex justify-between mt-1.5 text-xs">
                          <span className="text-purple-500 font-medium">{(stats.tokens_in ?? 0).toLocaleString()} in</span>
                          <span className="text-pink-500 font-medium">{(stats.tokens_out ?? 0).toLocaleString()} out</span>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
                      <div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Avg Tokens / Request</p>
                        <p className="text-lg font-bold text-gray-800 dark:text-gray-100">
                          {stats.total_requests > 0 ? Math.round(stats.total_tokens / stats.total_requests).toLocaleString() : '0'}
                        </p>
                      </div>
                      <div className="w-10 h-10 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-600 dark:text-purple-400">
                          <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    </div>
                    {stats.total_cost_usd > 0 && (
                      <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
                        <div>
                          <p className="text-xs text-gray-500 dark:text-gray-400">Avg Cost / Request</p>
                          <p className="text-lg font-bold text-green-600 dark:text-green-400">
                            ${stats.total_requests > 0 ? (stats.total_cost_usd / stats.total_requests).toFixed(4) : '0.0000'}
                          </p>
                        </div>
                        <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-600 dark:text-green-400">
                            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Requests by action — colorful bars */}
            {stats && Object.keys(stats.requests_by_action).length > 0 && (
              <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Requests by Action</h2>
                <div className="space-y-3.5">
                  {Object.entries(stats.requests_by_action).map(([action, count]) => {
                    const total = Object.values(stats.requests_by_action).reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    const barColor = (ACTION_COLORS[action] ?? 'bg-gray-50 text-gray-600').split(' ')[0].replace('bg-', 'bg-') || 'bg-gray-400';
                    return (
                      <div key={action}>
                        <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1.5">
                          <span className="font-medium">{ACTION_LABELS[action] ?? action}</span>
                          <span className="tabular-nums">{count.toLocaleString()} <span className="text-gray-400">({pct}%)</span></span>
                        </div>
                        <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-blue-500 bar-fill" style={{ '--bar-width': pct + '%' } as React.CSSProperties} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Users tab */}
        {tab === 'users' && users && (
          <UsersTable
            users={users}
            onPageChange={p => api.getUsers(p).then(setUsers)}
            onRevoke={userId => api.deactivateUser(userId).then(() => api.getUsers(users.page).then(setUsers)).catch(e => setActionError((e as Error).message || 'Failed to deactivate user'))}
            onReactivate={userId => api.reactivateUser(userId).then(() => api.getUsers(users.page).then(setUsers)).catch(e => setActionError((e as Error).message || 'Failed to reactivate user'))}
            onViewUser={userId => setViewUserId(userId)}
          />
        )}

        {/* Logs tab */}
        {tab === 'logs' && logs && (
          <LogsTable
            logs={logs}
            filters={logFilters}
            onPageChange={handleLogsPageChange}
            onFiltersChange={handleLogFiltersChange}
          />
        )}

        {/* Snapshots tab */}
        {tab === 'snapshots' && snapshots && (
          <SnapshotsTable
            snapshots={snapshots}
            onPageChange={p => api.getSnapshots(p).then(setSnapshots)}
          />
        )}

        {/* Networking tab */}
        {tab === 'networking' && (
          <NetworkingStatsTab
            stats={netStats}
            interactions={netInteractions}
            dark={dark}
          />
        )}

        {/* Subul tab */}
        {tab === 'subul' && (
          <SubulUsersTab
            stats={subulStats}
            users={subulUsers}
            dark={dark}
            onPageChange={p => api.getSubulUsers(p).then(setSubulUsers)}
            onViewUser={userId => setViewUserId(userId)}
            onRevoke={userId => api.deactivateUser(userId).then(() => {
              api.getSubulUsers(subulUsers?.page || 1).then(setSubulUsers);
              api.getSubulStats().then(setSubulStats);
            }).catch(e => setActionError((e as Error).message || 'Failed to deactivate user'))}
            onReactivate={userId => api.reactivateUser(userId).then(() => {
              api.getSubulUsers(subulUsers?.page || 1).then(setSubulUsers);
              api.getSubulStats().then(setSubulStats);
            }).catch(e => setActionError((e as Error).message || 'Failed to reactivate user'))}
          />
        )}

        {/* Notifications tab */}
        {tab === 'notifications' && (
          <NotificationsTab featureStats={featureStats} dark={dark} />
        )}

      </div>

      {/* Per-user detail modal */}
      {viewUserId && (
        <UserDetailModal
          userId={viewUserId}
          dark={dark}
          onClose={() => setViewUserId(null)}
        />
      )}
    </main>
  );
}
