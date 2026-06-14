'use client';
import { useState } from 'react';
import { UsersResponse, UserRow, BASE_URL } from '@/lib/api';

interface Props {
  users: UsersResponse;
  onPageChange: (page: number) => void;
  onRevoke?: (userId: string) => void;
  onReactivate?: (userId: string) => void;
  onViewUser?: (userId: string) => void;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function exportAllUsersCSV() {
  const token = sessionStorage.getItem('adminToken') ?? '';
  try {
    const res = await fetch(`${BASE_URL}/admin/users/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Match apiFetch behaviour: silently expire token + redirect on 401 instead
    // of leaving the user in a broken state with a generic alert.
    if (res.status === 401) {
      try { sessionStorage.removeItem('adminToken'); } catch {}
      window.location.href = '/login';
      return;
    }
    if (!res.ok) { alert(`Export failed: ${res.status} ${res.statusText}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Export failed: could not reach the backend.');
    console.error('[UsersTable] CSV export error:', err);
  }
}

export default function UsersTable({ users, onPageChange, onRevoke, onReactivate, onViewUser }: Props) {
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const totalPages = Math.ceil(users.total / users.page_size);
  const filtered = users.users.filter(u => u.email.toLowerCase().includes(search.toLowerCase()));

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

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex flex-wrap gap-3 justify-between items-center">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Users</h2>
          <span className="text-xs text-gray-400">{users.total} total</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="text" placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-44" />
          </div>
          <button type="button" onClick={exportAllUsersCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <tr>
              {['Email','Provider','Requests','Joined','Last Seen','Status','Actions'].map(h => (
                <th key={h} className="px-5 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-gray-400">No users match &quot;{search}&quot;</td></tr>
            ) : filtered.map(u => (
              <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="px-5 py-3 font-medium text-gray-800 dark:text-gray-200">
                  <button type="button" onClick={() => onViewUser?.(u.id)} className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors text-left">
                    {u.email}
                  </button>
                </td>
                <td className="px-5 py-3">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${
                    u.auth_provider === 'subul'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      : u.auth_provider === 'google'
                      ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {u.auth_provider || 'email'}
                  </span>
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
  );
}
