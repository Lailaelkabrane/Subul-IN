'use client';
import { LogsResponse, LogRow } from '@/lib/api';
import { ACTION_LABELS, ACTION_COLORS } from '@/lib/actionMeta';

interface LogFilters { action?: string; status?: string; from?: string; to?: string; }

interface Props {
  logs: LogsResponse;
  filters: LogFilters;
  onPageChange: (page: number) => void;
  onFiltersChange: (filters: LogFilters) => void;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function exportCSV(logs: LogRow[]) {
  try {
    const headers = ['Time','User','Action','Model','Tokens In','Tokens Out','Latency','Status','Error'];
    const rows = logs.map(l => [
      fmt(l.created_at), l.user_email ?? '', l.action ?? '', l.deployment ?? '',
      l.tokens_in ?? '', l.tokens_out ?? '',
      l.latency_ms != null ? `${l.latency_ms}ms` : '',
      l.success ? 'OK' : 'ERR',
      l.error_message ?? '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `logs_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[LogsTable] CSV export error:', err);
    alert('Export failed. Please try again.');
  }
}

const ACTION_OPTIONS = [
  'generate_post', 'generate_profile', 'route_chat', 'profile_snapshot',
  'gap_analysis', 'ai_score', 'networking_message', 'networking_analyze',
  'networking_chat', 'conversation_coach', 'subul_login', 'job_fit_analysis', 'interview_prep',
];

export default function LogsTable({ logs, filters, onPageChange, onFiltersChange }: Props) {
  const totalPages = Math.ceil(logs.total / logs.page_size);

  function setFilter(key: keyof LogFilters, value: string) {
    const next = { ...filters, [key]: value || undefined };
    onFiltersChange(next);
  }

  function clearFilters() {
    onFiltersChange({});
  }

  const hasFilters = !!(filters.action || filters.status || filters.from || filters.to);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex flex-wrap gap-3 justify-between items-center">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Usage Logs</h2>
            <span className="text-xs text-gray-400">{logs.total} total</span>
          </div>
          <button onClick={() => exportCSV(logs.logs)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>
        {/* Filters — applied server-side */}
        <div className="flex flex-wrap gap-2 mt-3">
          <input type="date" value={filters.from ?? ''} onChange={e => setFilter('from', e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <span className="text-xs text-gray-400 self-center">to</span>
          <input type="date" value={filters.to ?? ''} onChange={e => setFilter('to', e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <select value={filters.action ?? ''} onChange={e => setFilter('action', e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All actions</option>
            {ACTION_OPTIONS.map(a => (
              <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
            ))}
          </select>
          <select value={filters.status ?? ''} onChange={e => setFilter('status', e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All status</option>
            <option value="ok">OK only</option>
            <option value="err">Errors only</option>
          </select>
          {hasFilters && (
            <button onClick={clearFilters}
              className="px-2 py-1.5 text-xs text-red-500 hover:text-red-700 transition-colors">
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <tr>
              {['Time','User','Action','Model','Tokens In','Tokens Out','Latency','Status'].map(h => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {logs.logs.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No logs match the current filters</td></tr>
            ) : logs.logs.map(log => (
              <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmt(log.created_at)}</td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300 max-w-[140px] truncate">{log.user_email}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'}`}>
                    {ACTION_LABELS[log.action] ?? log.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 font-mono text-[10px] max-w-[120px] truncate">{log.deployment}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{log.tokens_in ?? '—'}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{log.tokens_out ?? '—'}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{log.latency_ms != null ? `${log.latency_ms}ms` : '—'}</td>
                <td className="px-4 py-3">
                  <span
                    title={!log.success && log.error_message ? log.error_message : undefined}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold cursor-default ${log.success ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}
                  >
                    {log.success ? 'OK' : 'ERR'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
          <span>Page {logs.page} of {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={logs.page <= 1} onClick={() => onPageChange(logs.page - 1)} className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Prev</button>
            <button disabled={logs.page >= totalPages} onClick={() => onPageChange(logs.page + 1)} className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
