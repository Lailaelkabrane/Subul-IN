import { FeatureStatsResponse } from '@/lib/api';

interface Props {
  featureStats?: FeatureStatsResponse | null;
  dark: boolean;
}

const NOTIFICATION_EVENTS = [
  { id: 'gap_analysis',         label: 'Gap Analysis Complete',     icon: 'M9 19V6l12-3v13',          color: 'bg-orange-500', textColor: 'text-orange-600 dark:text-orange-400', desc: 'Sent when a profile gap analysis finishes' },
  { id: 'ai_score',             label: 'AI Profile Score Ready',    icon: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z', color: 'bg-rose-500', textColor: 'text-rose-600 dark:text-rose-400', desc: 'Sent when AI scores the user\'s profile' },
  { id: 'networking',           label: 'Networking Suggestions',    icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', color: 'bg-cyan-500', textColor: 'text-cyan-600 dark:text-cyan-400', desc: 'Sent when new networking matches are found' },
  { id: 'connection_accepted',  label: 'Connection Accepted',       icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3', color: 'bg-emerald-500', textColor: 'text-emerald-600 dark:text-emerald-400', desc: 'Sent when a suggested connection accepts' },
  { id: 'weekly_report',        label: 'Weekly Report',             icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', color: 'bg-indigo-500', textColor: 'text-indigo-600 dark:text-indigo-400', desc: 'Weekly summary of profile activity and growth' },
];

export default function NotificationsTab({ featureStats, dark }: Props) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Notification System</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">Email (SMTP) and browser push notifications via the Chrome extension. Users control per-event toggles in the extension settings.</p>
          </div>
        </div>
      </div>

      {/* Delivery channels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Email Notifications</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">Channel</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">SMTP (Gmail / Custom)</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">Endpoint</span>
              <code className="text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded">/notifications/send-email</code>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">Template</span>
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Default (custom layout pending)</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Browser Push</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">Channel</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Chrome Extension API</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">Handler</span>
              <code className="text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded">background.js sendNotification()</code>
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm text-gray-600 dark:text-gray-300">User Control</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Per-event toggles in popup</span>
            </div>
          </div>
        </div>
      </div>

      {/* Event types */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Notification Events</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Users can enable/disable each event type independently</p>
        </div>
        <div className="divide-y divide-gray-50 dark:divide-gray-800">
          {NOTIFICATION_EVENTS.map(evt => (
            <div key={evt.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
              <div className={`w-9 h-9 rounded-xl ${evt.color} bg-opacity-10 dark:bg-opacity-20 flex items-center justify-center flex-shrink-0`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={evt.textColor}>
                  <path d={evt.icon}/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{evt.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{evt.desc}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium">Email</span>
                <span className="text-xs px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 font-medium">Push</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Trigger activity from feature stats */}
      {featureStats && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Triggering Feature Activity</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            These features trigger notifications when enabled by the user. Counts reflect total backend API calls.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: 'Gap Analyses',        count: featureStats.gap_analysis_count,       color: 'border-l-orange-500', event: 'gap_analysis' },
              { label: 'AI Profile Scores',   count: featureStats.ai_score_count,           color: 'border-l-rose-500',   event: 'ai_score' },
              { label: 'Networking Messages',  count: featureStats.networking_message_count, color: 'border-l-cyan-500',   event: 'networking' },
            ].map(f => (
              <div key={f.label} className={`p-4 rounded-xl border border-gray-100 dark:border-gray-800 border-l-4 ${f.color} bg-gray-50 dark:bg-gray-800/30`}>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">{f.label}</p>
                <p className="text-2xl font-bold text-gray-800 dark:text-gray-100 mt-1">{f.count.toLocaleString()}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Triggers <code className="text-blue-500">{f.event}</code> event</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
