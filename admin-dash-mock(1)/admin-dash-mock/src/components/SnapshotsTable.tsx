'use client';
import React, { useState } from 'react';
import { SnapshotsResponse, SnapshotRow } from '@/lib/api';

interface Props {
  snapshots: SnapshotsResponse;
  onPageChange: (page: number) => void;
}

function fmt(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function exportCSV(rows: SnapshotRow[]) {
  const headers = ['Captured At', 'User Email', 'Name', 'Headline', 'Connections', 'Followers', 'Profile URL'];
  const data = rows.map(r => [
    fmt(r.captured_at), r.user_email, r.name, r.headline,
    r.connections, r.followers, r.profile_url,
  ]);
  const csv = [headers, ...data].map(row =>
    row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'snapshots.csv'; a.click();
  URL.revokeObjectURL(url);
}

export default function SnapshotsTable({ snapshots, onPageChange }: Props) {
  const [search, setSearch] = useState('');
  const rows = snapshots.snapshots;
  const filtered = rows.filter(r =>
    r.name?.toLowerCase().includes(search.toLowerCase()) ||
    r.user_email?.toLowerCase().includes(search.toLowerCase()) ||
    r.headline?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex flex-wrap gap-3 justify-between items-center">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">LinkedIn Snapshots</h2>
          <span className="text-xs text-gray-400">{rows.length} on this page</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              type="text"
              placeholder="Search name / email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
            />
          </div>
          <button
            type="button"
            onClick={() => exportCSV(rows)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            <tr>
              {['Captured At', 'User', 'Name', 'Headline', 'Connections', 'Followers', 'Source', 'Profile'].map(h => (
                <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  {search ? `No snapshots match "${search}"` : 'No snapshots yet'}
                </td>
              </tr>
            ) : filtered.map(row => (
              <tr key={row.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{fmt(row.captured_at)}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400 max-w-[130px] truncate">
                  {row.user_email || <span className="italic text-gray-300">anonymous</span>}
                </td>
                <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-200 max-w-[130px] truncate">
                  {row.name || '—'}
                </td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400 max-w-[200px] truncate">
                  {row.headline || '—'}
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">
                  {row.connections > 0 ? row.connections.toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-gray-700 dark:text-gray-300 text-center">
                  {row.followers > 0 ? row.followers.toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    {row.source || 'extension'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {row.profile_url ? (
                    <a
                      href={row.profile_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 hover:text-blue-700 dark:text-blue-400 underline truncate block max-w-[100px]"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
        <span>Page {snapshots.page}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={snapshots.page <= 1}
            onClick={() => onPageChange(snapshots.page - 1)}
            className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={rows.length < snapshots.page_size}
            onClick={() => onPageChange(snapshots.page + 1)}
            className="px-3 py-1 border border-gray-200 dark:border-gray-700 rounded-lg disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
