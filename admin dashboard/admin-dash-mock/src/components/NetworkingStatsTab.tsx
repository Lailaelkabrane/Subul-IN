'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { NetworkingStatsResponse, NetworkingInteractionsResponse } from '../lib/api';

interface Props {
  stats: NetworkingStatsResponse | null;
  interactions: NetworkingInteractionsResponse | null;
  dark: boolean;
}

const GOAL_COLORS: Record<string, string> = {
  job_search: '#0A66C2',
  clients:    '#057642',
  investors:  '#B24020',
  learning:   '#7A3E98',
};

const GOAL_LABELS: Record<string, string> = {
  job_search: 'Job Search',
  clients:    'Find Clients',
  investors:  'Find Investors',
  learning:   'Learn & Grow',
};

const ACTION_COLORS: Record<string, string> = {
  connected: '#057642',
  skipped:   '#B24020',
  saved:     '#E7A33E',
};

export default function NetworkingStatsTab({ stats, interactions, dark }: Props) {
  const card = dark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const sub  = dark ? 'text-gray-400' : 'text-gray-500';

  if (!stats) {
    return (
      <div className={`rounded-lg border p-8 text-center ${card} ${sub}`}>
        No networking data yet. Users need to complete onboarding in the extension first.
      </div>
    );
  }

  const goalData = Object.entries(stats.goal_distribution || {}).map(([key, count]) => ({
    name:  GOAL_LABELS[key] || key,
    value: count,
    color: GOAL_COLORS[key] || '#888',
  }));

  return (
    <div className="space-y-6">

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-2xl font-bold ${text}`}>{stats.total_interactions.toLocaleString()}</div>
          <div className={`text-sm mt-1 ${sub}`}>Total Interactions</div>
        </div>
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-2xl font-bold text-green-600`}>{stats.acceptance_rate}%</div>
          <div className={`text-sm mt-1 ${sub}`}>Acceptance Rate</div>
        </div>
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-2xl font-bold ${text}`}>{stats.avg_score_at_connect}</div>
          <div className={`text-sm mt-1 ${sub}`}>Avg Score at Connect</div>
        </div>
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-2xl font-bold ${text}`}>{stats.avg_score_at_skip}</div>
          <div className={`text-sm mt-1 ${sub}`}>Avg Score at Skip</div>
        </div>
      </div>

      {/* Goal Distribution + Connect vs Skip */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Goal Pie */}
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-sm font-semibold mb-3 ${text}`}>Goal Distribution</div>
          {goalData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={goalData} dataKey="value" cx="50%" cy="50%" outerRadius={60} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                    {goalData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => [v, 'Users']} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-2 mt-2">
                {goalData.map((g, i) => (
                  <span key={i} className="flex items-center gap-1 text-xs" style={{ color: g.color }}>
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: g.color }} />
                    {g.name}: {g.value}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className={`text-sm ${sub}`}>No goal data yet.</div>
          )}
        </div>

        {/* Connect vs Skip */}
        <div className={`rounded-lg border p-4 ${card}`}>
          <div className={`text-sm font-semibold mb-3 ${text}`}>Actions Breakdown</div>
          <div className="space-y-3">
            {[
              { label: 'Connected', value: stats.total_connected, color: 'bg-green-500' },
              { label: 'Skipped',   value: stats.total_skipped,   color: 'bg-red-400' },
            ].map(row => (
              <div key={row.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className={sub}>{row.label}</span>
                  <span className={`font-medium ${text}`}>{row.value}</span>
                </div>
                <div className={`w-full rounded-full h-2 ${dark ? 'bg-gray-700' : 'bg-gray-100'}`}>
                  <div
                    className={`h-2 rounded-full ${row.color}`}
                    style={{ width: stats.total_interactions > 0 ? `${(row.value / stats.total_interactions) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className={`mt-4 text-xs ${sub}`}>
            {(() => {
              const delta = stats.avg_score_at_connect - stats.avg_score_at_skip;
              return `Score delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts at connect vs skip`;
            })()}
          </div>
        </div>
      </div>

      {/* Recent Interactions Table */}
      {interactions && interactions.interactions.length > 0 && (
        <div className={`rounded-lg border ${card} overflow-hidden`}>
          <div className={`px-4 py-3 border-b ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
            <span className={`text-sm font-semibold ${text}`}>Recent Interactions</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={dark ? 'bg-gray-700' : 'bg-gray-50'}>
                  {['User', 'Candidate', 'Score', 'Action', 'Time'].map(h => (
                    <th key={h} className={`px-4 py-2 text-left font-medium ${sub}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {interactions.interactions.slice(0, 20).map((row, i) => (
                  <tr key={i} className={`border-t ${dark ? 'border-gray-700' : 'border-gray-100'}`}>
                    <td className={`px-4 py-2 ${sub} font-mono`}>{row.user_id.replace('user:', '').slice(0, 20)}…</td>
                    <td className={`px-4 py-2 ${text}`}>{(row.suggested_profile_id || '—').slice(0, 25)}</td>
                    <td className={`px-4 py-2 font-bold ${row.score_given >= 80 ? 'text-green-500' : row.score_given >= 60 ? 'text-yellow-500' : 'text-red-400'}`}>
                      {row.score_given}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium`}
                        style={{ background: ACTION_COLORS[row.user_action] + '22', color: ACTION_COLORS[row.user_action] || '#888' }}>
                        {row.user_action}
                      </span>
                    </td>
                    <td className={`px-4 py-2 ${sub}`}>
                      {row.timestamp ? new Date(row.timestamp).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
