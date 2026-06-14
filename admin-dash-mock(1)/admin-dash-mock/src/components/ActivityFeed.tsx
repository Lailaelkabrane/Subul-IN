import { LogRow } from '@/lib/api';
import { ACTION_LABELS, ACTION_STYLES_FEED } from '@/lib/actionMeta';

interface Props { logs: LogRow[] }

function timeAgo(iso: string): string {
  try {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 0) return 'just now';
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return '';
  }
}

export default function ActivityFeed({ logs }: Props) {
  const recent = logs.slice(0, 10);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Recent Activity</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">Last {recent.length} requests</span>
      </div>

      {recent.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-gray-300 dark:text-gray-600">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="text-sm text-gray-400 dark:text-gray-500">No activity yet</p>
          <p className="text-xs text-gray-300 dark:text-gray-600 mt-1">Requests will appear here after the next refresh</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-50 dark:divide-gray-800">
          {recent.map(log => (
            <div key={log.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 ${ACTION_STYLES_FEED[log.action] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                {ACTION_LABELS[log.action] ?? log.action}
              </span>
              <span className="text-xs text-gray-600 dark:text-gray-400 truncate flex-1 min-w-0">{log.user_email}</span>
              {log.tokens_in !== null && log.tokens_in > 0 && (
                <span className="text-xs text-purple-400 flex-shrink-0" title={`${log.tokens_in} in / ${log.tokens_out ?? 0} out`}>
                  {((log.tokens_in ?? 0) + (log.tokens_out ?? 0)).toLocaleString()}t
                </span>
              )}
              {log.latency_ms !== null && log.latency_ms > 0 && (
                <span className="text-xs text-gray-400 flex-shrink-0">{log.latency_ms}ms</span>
              )}
              <span className={`text-xs font-bold flex-shrink-0 ${log.success ? 'text-emerald-500' : 'text-red-500'}`}>
                {log.success ? '\u2713' : '\u2717'}
              </span>
              <span className="text-xs text-gray-400 flex-shrink-0 w-16 text-right" title={log.created_at}>
                {timeAgo(log.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
