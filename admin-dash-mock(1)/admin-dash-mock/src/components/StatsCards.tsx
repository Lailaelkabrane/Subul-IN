import { StatsResponse, FeatureStatsResponse } from '@/lib/api';

interface Card {
  label: string;
  value: string;
  sub?: string;
  icon: string;
  iconColor: string;
  borderColor: string;
}

interface Props {
  stats: StatsResponse;
  featureStats?: FeatureStatsResponse | null;
}

export default function StatsCards({ stats, featureStats }: Props) {
  const totalCost = stats.total_cost_usd ?? 0;

  const cards: Card[] = [
    {
      label: 'Total Users',
      value: (stats.total_users ?? 0).toLocaleString(),
      icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
      iconColor: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
      borderColor: 'border-l-blue-500',
    },
    {
      label: 'Total Requests',
      value: (stats.total_requests ?? 0).toLocaleString(),
      icon: 'M22 12h-4l-3 9L9 3l-3 9H2',
      iconColor: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30',
      borderColor: 'border-l-indigo-500',
    },
    {
      label: 'Total Tokens',
      value: (stats.total_tokens ?? 0).toLocaleString(),
      sub: stats.tokens_in || stats.tokens_out
        ? `${(stats.tokens_in ?? 0).toLocaleString()} in / ${(stats.tokens_out ?? 0).toLocaleString()} out`
        : undefined,
      icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
      iconColor: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30',
      borderColor: 'border-l-purple-500',
    },
    {
      label: 'Est. Cost',
      value: totalCost > 0 ? `$${totalCost.toFixed(2)}` : '$0.00',
      sub: Object.keys(stats.model_costs ?? {}).length > 0
        ? Object.entries(stats.model_costs).map(([m, c]) => {
            const short = m.includes('mini') ? 'mini' : m.includes('4o') ? '4o' : m;
            return `${short}: $${c.cost_usd.toFixed(2)}`;
          }).join(' | ')
        : undefined,
      icon: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
      iconColor: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30',
      borderColor: 'border-l-green-500',
    },
    {
      label: 'Avg Latency',
      value: `${stats.avg_latency_ms ?? 0} ms`,
      icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
      iconColor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
      borderColor: 'border-l-emerald-500',
    },
    {
      label: 'Gap Analyses',
      value: featureStats ? (featureStats.gap_analysis_count ?? 0).toLocaleString() : '\u2014',
      icon: 'M9 19V6l12-3v13M9 19c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2zM21 16c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z',
      iconColor: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30',
      borderColor: 'border-l-amber-500',
    },
    {
      label: 'AI Scores',
      value: featureStats ? (featureStats.ai_score_count ?? 0).toLocaleString() : '\u2014',
      icon: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
      iconColor: 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30',
      borderColor: 'border-l-rose-500',
    },
    {
      label: 'Snapshots',
      value: (stats.cosmos_db?.total_snapshots ?? 0).toLocaleString(),
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10',
      iconColor: 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-900/30',
      borderColor: 'border-l-sky-500',
    },
    {
      label: 'Success Rate',
      value: stats.success_rate !== undefined ? `${stats.success_rate}%` : '\u2014',
      icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3',
      iconColor: 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/30',
      borderColor: 'border-l-teal-500',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-3">
      {cards.map(c => (
        <div
          key={c.label}
          className={`card-hover bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 border-l-4 ${c.borderColor} p-5 shadow-sm`}
        >
          <div className={`inline-flex p-2 rounded-xl mb-3 ${c.iconColor}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={c.icon}/>
            </svg>
          </div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{c.label}</p>
          <p className="text-2xl font-bold text-gray-800 dark:text-gray-100 mt-1">{c.value}</p>
          {c.sub && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate" title={c.sub}>{c.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}
