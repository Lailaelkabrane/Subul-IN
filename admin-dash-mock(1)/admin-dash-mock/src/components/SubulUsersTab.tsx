'use client';

import { useState } from 'react';
import type { SubulStatsResponse, SubulUsersResponse, SubulUserRow } from '../lib/api';
import { ACTION_LABELS } from '../lib/actionMeta';

interface Props {
  stats: SubulStatsResponse | null;
  users: SubulUsersResponse | null;
  dark: boolean;
  onPageChange: (page: number) => void;
  onViewUser?: (userId: string) => void;
  onRevoke?: (userId: string) => void;
  onReactivate?: (userId: string) => void;
}

function fmt(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function exportCSV(users: SubulUserRow[]) {
  const headers = ['Email', 'Requests', 'Joined', 'Last Seen', 'Status'];
  const rows = users.map(u => [u.email, u.request_count, fmt(u.created_at), fmt(u.last_seen), u.is_active ? 'Active' : 'Inactive']);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'subul_users.csv'; a.click();
  URL.revokeObjectURL(url);
}

export default function SubulUsersTab({ stats, users, dark, onPageChange, onViewUser, onRevoke, onReactivate }: Props) {
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const card = dark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const sub  = dark ? 'text-gray-400' : 'text-gray-500';

  async function handleRevoke(userId: string, email: string) {
    if (!confirm(`Deactivate access for ${email}?`)) return;
    setActing(userId);
    try { await onRevoke?.(userId); } finally { setActing(null); }
  }

  async function handleReactivate(userId: string, email: string) {
    if (!confirm(`Reactivate ${email}?`)) return;
    setActing(userId);
    try { await onReactivate?.(userId); } finally { setActing(null); }
  }

  const statsSection = stats ? (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className={`text-2xl font-bold ${text}`}>{stats.total_subul_users}</div>
        <div className={`text-sm mt-1 ${sub}`}>Total Subul Users</div>
      </div>
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className="text-2xl font-bold text-green-600">{stats.active_subul_users}</div>
        <div className={`text-sm mt-1 ${sub}`}>Active</div>
      </div>
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className="text-2xl font-bold text-red-400">{stats.inactive_subul_users}</div>
        <div className={`text-sm mt-1 ${sub}`}>Inactive</div>
      </div>
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className={`text-2xl font-bold ${text}`}>{stats.total_requests.toLocaleString()}</div>
        <div className={`text-sm mt-1 ${sub}`}>Total Requests</div>
      </div>
      <div className={`rounded-lg border p-4 ${card}`}>
        <div className={`text-2xl font-bold ${text}`}>
          {stats.total_subul_users > 0 ? Math.round(stats.total_requests / stats.total_subul_users) : 0}
        </div>
        <div className={`text-sm mt-1 ${sub}`}>Avg Req/User</div>
      </div>
    </div>
  ) : null;

  const usageBreakdown = stats && Object.keys(stats.requests_by_action).length > 0 ? (
    <div className={`rounded-lg border p-4 mb-6 ${card}`}>
      <div className={`text-sm font-semibold mb-3 ${text}`}>Subul Usage by Feature</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(stats.requests_by_action)
          .sort(([, a], [, b]) => b - a)
          .map(([action, count]) => (
          <div key={action} className={`flex items-center justify-between px-3 py-2 rounded ${dark ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
            <span className={`text-xs ${sub}`}>{ACTION_LABELS[action] || action}</span>
            <span className={`text-sm font-bold ${text}`}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  if (!users || users.total === 0) {
    return (
      <div className="space-y-6">
        {statsSection}
        <div className={`rounded-lg border p-8 text-center ${card} ${sub}`}>
          No Subul users yet. Users need to log in via the Subul platform.
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(users.total / users.page_size);
  const filtered = users.users.filter(u => u.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6">
      {statsSection}
      {usageBreakdown}

      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex flex-wrap gap-3 justify-between items-center">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Subul Users</h2>
            <span className="text-xs text-gray-400">{users.total} total</span>
            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              Subul Platform
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input type="text" placeholder="Search Subul users..." value={search} onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48" />
            </div>
            <button type="button" onClick={() => exportCSV(users.users)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              Export CSV
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              <tr>
                {['Email', 'Requests', 'Joined', 'Last Seen', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-5 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-400">No Subul users match &quot;{search}&quot;</td></tr>
              ) : filtered.map(u => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-800 dark:text-gray-200">
                    <button type="button" onClick={() => onViewUser?.(u.id)} className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors text-left">
                      {u.email}
                    </button>
                  </td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{u.request_count}</td>
                  <td className="px-5 py-3 text-gray-500">{fmt(u.created_at)}</td>
                  <td className="px-5 py-3 text-gray-500">{fmt(u.last_seen)}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${u.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3 flex gap-2">
                    <button type="button" onClick={() => onViewUser?.(u.id)} className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 font-medium transition-colors">
                      View
                    </button>
                    {u.is_active ? (
                      <button
                        type="button"
                        onClick={() => handleRevoke(u.id, u.email)}
                        disabled={acting === u.id}
                        className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {acting === u.id ? 'Working…' : 'Deactivate'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleReactivate(u.id, u.email)}
                        disabled={acting === u.id}
                        className="text-xs text-emerald-500 hover:text-emerald-700 dark:text-emerald-400 font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {acting === u.id ? 'Working…' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
            <span>Page {users.page} of {totalPages}</span>
            <div className="flex gap-2">
              <button type="button" disabled={users.page <= 1} onClick={() => onPageChange(users.page - 1)} className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Prev</button>
              <button type="button" disabled={users.page >= totalPages} onClick={() => onPageChange(users.page + 1)} className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
