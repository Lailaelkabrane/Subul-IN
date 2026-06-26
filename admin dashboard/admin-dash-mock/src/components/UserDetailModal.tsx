'use client';

import { useEffect, useState } from 'react';
import { api, UserCompleteData } from '@/lib/api';
import { ACTION_LABELS } from '@/lib/actionMeta';

interface Props {
  userId: string;
  dark: boolean;
  onClose: () => void;
}


function fmt(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtShort(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function UserDetailModal({ userId, dark, onClose }: Props) {
  const [data, setData] = useState<UserCompleteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState<'overview' | 'usage' | 'networking' | 'ai' | 'snapshots'>('overview');

  const card = dark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
  const text = dark ? 'text-white' : 'text-gray-900';
  const sub  = dark ? 'text-gray-400' : 'text-gray-500';
  const bg   = dark ? 'bg-gray-900' : 'bg-gray-50';

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getUserData(userId)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [userId]);

  const sections: { key: typeof section; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'usage', label: 'Usage' },
    { key: 'networking', label: 'Networking' },
    { key: 'ai', label: 'AI History' },
    { key: 'snapshots', label: 'Snapshots' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className={`relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl ${card}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`sticky top-0 z-10 px-6 py-4 border-b ${dark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'} flex items-center justify-between`}>
          <div>
            <h2 className={`text-lg font-bold ${text}`}>
              {data?.user?.email || userId.replace('user:', '')}
            </h2>
            {data?.user && (
              <div className="flex items-center gap-2 mt-1">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  data.user.auth_provider === 'subul'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                }`}>
                  {data.user.auth_provider}
                </span>
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                  data.user.is_active
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                }`}>
                  {data.user.is_active ? 'Active' : 'Inactive'}
                </span>
                <span className={`text-xs ${sub}`}>Joined {fmtShort(data.user.created_at)}</span>
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className={`p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${sub}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Section Tabs */}
        <div className={`px-6 pt-3 border-b ${dark ? 'border-gray-700' : 'border-gray-200'} flex gap-1`}>
          {sections.map(s => (
            <button
              type="button"
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`px-4 py-2 text-xs font-medium rounded-t-lg transition-colors ${
                section === s.key
                  ? `${dark ? 'bg-gray-700 text-white' : 'bg-white text-gray-900'} border border-b-0 ${dark ? 'border-gray-600' : 'border-gray-200'}`
                  : `${sub} hover:text-gray-700 dark:hover:text-gray-200`
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className={`ml-3 text-sm ${sub}`}>Loading user data...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-500 text-sm">{error}</div>
          ) : !data ? (
            <div className={`text-center py-12 ${sub}`}>User not found.</div>
          ) : (
            <>
              {/* Overview */}
              {section === 'overview' && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.usage.total_requests}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Total API Requests</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.usage.total_tokens.toLocaleString()}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Total Tokens</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className="text-2xl font-bold text-green-600">{data.networking.connections_made}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Connections Made</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.networking.acceptance_rate}%</div>
                    <div className={`text-xs mt-1 ${sub}`}>Accept Rate</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.networking.messages_sent}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Messages Sent</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.ai_history.ai_scores.length}</div>
                    <div className={`text-xs mt-1 ${sub}`}>AI Scores</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.ai_history.gap_analyses.length}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Gap Analyses</div>
                  </div>
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-2xl font-bold ${text}`}>{data.snapshots.length}</div>
                    <div className={`text-xs mt-1 ${sub}`}>Profile Snapshots</div>
                  </div>
                </div>
              )}

              {/* Usage */}
              {section === 'usage' && (
                <div className="space-y-4">
                  {/* By action breakdown */}
                  <div className={`rounded-lg border p-4 ${card}`}>
                    <div className={`text-sm font-semibold mb-3 ${text}`}>Requests by Feature</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {Object.entries(data.usage.requests_by_action)
                        .sort(([, a], [, b]) => b - a)
                        .map(([action, count]) => (
                        <div key={action} className={`flex items-center justify-between px-3 py-2 rounded ${dark ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
                          <span className={`text-xs ${sub}`}>{ACTION_LABELS[action] || action}</span>
                          <span className={`text-sm font-bold ${text}`}>{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Recent logs */}
                  {data.usage.recent_logs.length > 0 && (
                    <div className={`rounded-lg border overflow-hidden ${card}`}>
                      <div className={`px-4 py-3 border-b ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
                        <span className={`text-sm font-semibold ${text}`}>Recent Activity (last 20)</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className={dark ? 'bg-gray-800/60' : 'bg-gray-50'}>
                              {['Action', 'Model', 'Tokens', 'Latency', 'Status', 'Time'].map(h => (
                                <th key={h} className={`px-4 py-2 text-left font-medium ${sub}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.usage.recent_logs.map((log, i) => (
                              <tr key={i} className={`border-t ${dark ? 'border-gray-700' : 'border-gray-100'}`}>
                                <td className={`px-4 py-2 ${text} font-medium`}>{ACTION_LABELS[log.action] || log.action}</td>
                                <td className={`px-4 py-2 ${sub} font-mono text-[10px]`}>{(log.deployment || '—').slice(0, 25)}</td>
                                <td className={`px-4 py-2 ${sub}`}>{((log.tokens_in || 0) + (log.tokens_out || 0)).toLocaleString()}</td>
                                <td className={`px-4 py-2 ${sub}`}>{log.latency_ms ? `${log.latency_ms}ms` : '—'}</td>
                                <td className="px-4 py-2">
                                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    log.success ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                                  }`}>
                                    {log.success ? 'OK' : 'FAIL'}
                                  </span>
                                </td>
                                <td className={`px-4 py-2 ${sub}`}>{fmt(log.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Networking */}
              {section === 'networking' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className={`rounded-lg border p-4 ${card}`}>
                      <div className="text-2xl font-bold text-green-600">{data.networking.connections_made}</div>
                      <div className={`text-xs mt-1 ${sub}`}>Connected</div>
                    </div>
                    <div className={`rounded-lg border p-4 ${card}`}>
                      <div className="text-2xl font-bold text-red-400">{data.networking.connections_skipped}</div>
                      <div className={`text-xs mt-1 ${sub}`}>Skipped</div>
                    </div>
                    <div className={`rounded-lg border p-4 ${card}`}>
                      <div className={`text-2xl font-bold ${text}`}>{data.networking.messages_sent}</div>
                      <div className={`text-xs mt-1 ${sub}`}>Messages Sent</div>
                    </div>
                    <div className={`rounded-lg border p-4 ${card}`}>
                      <div className="text-2xl font-bold text-green-600">{data.networking.messages_accepted}</div>
                      <div className={`text-xs mt-1 ${sub}`}>Accepted</div>
                    </div>
                  </div>
                  {data.networking.networking_goal && (
                    <div className={`rounded-lg border p-4 ${card}`}>
                      <div className={`text-sm font-semibold mb-2 ${text}`}>Networking Goal</div>
                      <div className="flex gap-3">
                        <span className="inline-flex px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                          {data.networking.networking_goal.replace('_', ' ')}
                        </span>
                        {data.networking.goal_industry && (
                          <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium ${dark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                            {data.networking.goal_industry}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* AI History */}
              {section === 'ai' && (
                <div className="space-y-4">
                  <div className={`text-xs ${sub}`}>{data.ai_history.chat_count} chat messages recorded</div>

                  {data.ai_history.ai_scores.length > 0 && (
                    <div className={`rounded-lg border overflow-hidden ${card}`}>
                      <div className={`px-4 py-3 border-b ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
                        <span className={`text-sm font-semibold ${text}`}>AI Profile Scores</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className={dark ? 'bg-gray-800/60' : 'bg-gray-50'}>
                              {['Score', 'Grade', 'Profile Type', 'Date'].map(h => (
                                <th key={h} className={`px-4 py-2 text-left font-medium ${sub}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.ai_history.ai_scores.map((s, i) => (
                              <tr key={i} className={`border-t ${dark ? 'border-gray-700' : 'border-gray-100'}`}>
                                <td className={`px-4 py-2 font-bold ${s.overall_score >= 80 ? 'text-green-500' : s.overall_score >= 60 ? 'text-yellow-500' : 'text-red-400'}`}>
                                  {s.overall_score}/100
                                </td>
                                <td className={`px-4 py-2 font-bold ${text}`}>{s.grade}</td>
                                <td className={`px-4 py-2 ${sub}`}>{s.profile_type}</td>
                                <td className={`px-4 py-2 ${sub}`}>{fmtShort(s.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {data.ai_history.gap_analyses.length > 0 && (
                    <div className={`rounded-lg border overflow-hidden ${card}`}>
                      <div className={`px-4 py-3 border-b ${dark ? 'border-gray-700' : 'border-gray-200'}`}>
                        <span className={`text-sm font-semibold ${text}`}>Gap Analyses</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className={dark ? 'bg-gray-800/60' : 'bg-gray-50'}>
                              {['vs. Target', 'Gap Score', 'Label', 'Date'].map(h => (
                                <th key={h} className={`px-4 py-2 text-left font-medium ${sub}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.ai_history.gap_analyses.map((g, i) => (
                              <tr key={i} className={`border-t ${dark ? 'border-gray-700' : 'border-gray-100'}`}>
                                <td className={`px-4 py-2 ${text} font-medium`}>{g.target_name || g.target_slug}</td>
                                <td className={`px-4 py-2 font-bold ${g.overall_gap_score >= 70 ? 'text-green-500' : g.overall_gap_score >= 40 ? 'text-yellow-500' : 'text-red-400'}`}>
                                  {g.overall_gap_score}/100
                                </td>
                                <td className={`px-4 py-2 ${sub}`}>{g.score_label}</td>
                                <td className={`px-4 py-2 ${sub}`}>{fmtShort(g.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {data.ai_history.ai_scores.length === 0 && data.ai_history.gap_analyses.length === 0 && (
                    <div className={`rounded-lg border p-8 text-center ${card} ${sub}`}>
                      No AI analysis history for this user yet.
                    </div>
                  )}
                </div>
              )}

              {/* Snapshots */}
              {section === 'snapshots' && (
                <div>
                  {data.snapshots.length > 0 ? (
                    <div className={`rounded-lg border overflow-hidden ${card}`}>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className={dark ? 'bg-gray-800/60' : 'bg-gray-50'}>
                              {['Name', 'Headline', 'Connections', 'Followers', 'Date'].map(h => (
                                <th key={h} className={`px-4 py-2 text-left font-medium ${sub}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {data.snapshots.map((s, i) => (
                              <tr key={i} className={`border-t ${dark ? 'border-gray-700' : 'border-gray-100'}`}>
                                <td className={`px-4 py-2 ${text} font-medium`}>{s.name || '—'}</td>
                                <td className={`px-4 py-2 ${sub} max-w-[200px] truncate`}>{s.headline || '—'}</td>
                                <td className={`px-4 py-2 ${text}`}>{(s.connections || 0).toLocaleString()}</td>
                                <td className={`px-4 py-2 ${text}`}>{(s.followers || 0).toLocaleString()}</td>
                                <td className={`px-4 py-2 ${sub}`}>{fmtShort(s.captured_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className={`rounded-lg border p-8 text-center ${card} ${sub}`}>
                      No profile snapshots for this user yet.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
