'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminLogin } from '@/lib/api';

const FEATURES = [
  'Real-time analytics dashboard',
  'User management & monitoring',
  'AI generation logs & metrics',
  'LinkedIn profile snapshot archive',
];

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const router = useRouter();

  async function handleLogin() {
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    try {
      await adminLogin(email.trim(), password);
      router.push('/dashboard');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Login failed';
      if (/fetch|network|ECONNREFUSED|Failed to fetch/i.test(msg)) {
        setError('Backend not running. Open a terminal in linkedin-backend/ and run:\nuvicorn main:app --reload --port 8010');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen">

      {/* ── Left branding panel ── */}
      <div className="login-panel hidden lg:flex lg:w-[52%] relative flex-col justify-between p-12">

        {/* Decorative blobs */}
        <div className="login-blob-tr absolute top-0 right-0 w-80 h-80 rounded-full opacity-10" />
        <div className="login-blob-bl absolute bottom-0 left-0 w-64 h-64 rounded-full opacity-10" />

        {/* Logo */}
        <div className="relative flex items-center gap-3">
          <div className="login-icon-bg w-10 h-10 rounded-xl flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <span className="text-white font-bold text-lg tracking-tight">LinkedIn AI Agent</span>
        </div>

        {/* Hero text + features */}
        <div className="relative">
          <h2 className="text-4xl font-extrabold text-white leading-tight mb-4">
            Manage your<br />AI&#8209;powered<br />LinkedIn agent
          </h2>
          <p className="text-blue-200 text-base mb-10 leading-relaxed">
            Monitor usage, oversee users,<br />and explore AI-generated content.
          </p>

          <div className="space-y-3.5">
            {FEATURES.map(f => (
              <div key={f} className="flex items-center gap-3">
                <div className="login-feature-dot w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <span className="text-blue-100 text-sm">{f}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-blue-300 text-xs">© 2025 LinkedIn AI Agent · Admin Portal</p>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex flex-1 items-center justify-center bg-gray-50 p-8">
        <div className="w-full max-w-sm">

          {/* Mobile logo (hidden on large screens) */}
          <div className="lg:hidden flex items-center gap-2 justify-center mb-8">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span className="font-bold text-gray-800 text-lg">LinkedIn AI Agent</span>
          </div>

          <h1 className="text-2xl font-bold text-gray-800 mb-1">Admin sign in</h1>
          <p className="text-sm text-gray-500 mb-7">Access your admin dashboard</p>

          {error && (
            <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 whitespace-pre-line">
              {error}
            </div>
          )}

          <div className="space-y-3.5">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Email</label>
              <input
                type="email"
                placeholder="admin@linkedin.ai"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoFocus
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white transition-shadow"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Password</label>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white transition-shadow"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading || !email.trim() || !password.trim()}
            className="login-btn w-full mt-5 text-white rounded-xl px-4 py-3 text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"/>
                Signing in…
              </span>
            ) : 'Sign in'}
          </button>

          <p className="mt-5 text-xs text-center text-gray-400">
            Credentials configured in the backend{' '}
            <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">.env</code> file
          </p>
        </div>
      </div>

    </div>
  );
}
