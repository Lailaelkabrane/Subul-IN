'use client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, Legend } from 'recharts';
import { ModelCostInfo } from '@/lib/api';

interface Props {
  data: Record<string, number>;
  modelCosts?: Record<string, ModelCostInfo>;
}

const COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];

function shortName(name: string): string {
  if (name.includes('mini')) return name.replace(/gpt-4o-mini-/, 'mini-');
  if (name.includes('4o')) return name.replace(/gpt-4o-/, '4o-');
  return name;
}

export default function ModelUsageChart({ data, modelCosts }: Props) {
  if (Object.keys(data).length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm flex items-center justify-center h-[280px]">
        <div className="text-center">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3 text-gray-300 dark:text-gray-600"><rect x="2" y="3" width="6" height="18" rx="1"/><rect x="9" y="8" width="6" height="13" rx="1"/><rect x="16" y="13" width="6" height="8" rx="1"/></svg>
          <p className="text-sm text-gray-400 dark:text-gray-500">No model usage data yet</p>
        </div>
      </div>
    );
  }

  const NON_MODEL = new Set(['unknown', 'cosmos-db', 'none', '']);

  const chartData = Object.entries(data)
    .filter(([name]) => !NON_MODEL.has(name.toLowerCase()))
    .map(([name, requests]) => {
      const cost = modelCosts?.[name];
      return {
        name: shortName(name),
        full: name,
        requests,
        tokens_in: cost?.tokens_in ?? 0,
        tokens_out: cost?.tokens_out ?? 0,
        cost_usd: cost?.cost_usd ?? 0,
      };
    });

  const hasCosts = chartData.some(d => d.cost_usd > 0);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Usage by Model</h2>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} barSize={28}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(150,150,150,0.1)" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              return (
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-xs">
                  <p className="font-semibold text-gray-800 dark:text-gray-100 mb-1">{d.full}</p>
                  <p className="text-gray-500 dark:text-gray-400">Requests: <span className="font-bold text-gray-700 dark:text-gray-200">{d.requests.toLocaleString()}</span></p>
                  {d.tokens_in > 0 && (
                    <p className="text-gray-500 dark:text-gray-400">Tokens: <span className="font-bold text-purple-600 dark:text-purple-400">{(d.tokens_in + d.tokens_out).toLocaleString()}</span></p>
                  )}
                  {d.cost_usd > 0 && (
                    <p className="text-gray-500 dark:text-gray-400">Cost: <span className="font-bold text-green-600 dark:text-green-400">${d.cost_usd.toFixed(4)}</span></p>
                  )}
                </div>
              );
            }}
          />
          <Bar dataKey="requests" radius={[6, 6, 0, 0]} name="Requests">
            {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Cost breakdown table */}
      {hasCosts && (
        <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Cost Breakdown</h3>
          <div className="space-y-2">
            {chartData.filter(d => d.cost_usd > 0).map((d, i) => (
              <div key={d.full} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="text-xs text-gray-600 dark:text-gray-400">{d.full}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-purple-500 tabular-nums">{(d.tokens_in + d.tokens_out).toLocaleString()} tokens</span>
                  <span className="font-bold text-green-600 dark:text-green-400 tabular-nums">${d.cost_usd.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
