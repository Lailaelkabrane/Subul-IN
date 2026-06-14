# LinkedIn AI Agent v2.1.0

AI-powered LinkedIn productivity suite: Chrome extension + FastAPI backend + admin dashboard.

## Architecture

```
Chrome Extension (MV3)  →  FastAPI Backend (port 8010)  →  Azure OpenAI (GPT-4o-mini)
   popup + background.js       main.py + cosmos_db.py          AI generation
                                     ↕
                              Azure Cosmos DB
                                     ↕
                          Next.js Admin Dashboard (port 3000)
```

---

## Quick Start

### 1. Backend

```bash
cd linkedin-backend
pip install -r requirements.txt
```

Create a `.env` file (or edit the existing one):

```env
# Azure OpenAI
AZURE_ENDPOINT=https://your-resource.openai.azure.com
AZURE_API_KEY=your-api-key
AZURE_API_VERSION=2024-12-01-preview
POST_DEPLOYMENT=gpt-4o-mini-2024-07-18-postagent
PROFILE_DEPLOYMENT=gpt-4o-mini-2024-07-18

# Azure Cosmos DB
AZURE_COSMOS_ENDPOINT=https://your-cosmos.documents.azure.com:443/
AZURE_COSMOS_KEY=your-cosmos-key
AZURE_COSMOS_DATABASE_NAME=EduTech_AI_Production
AZURE_COSMOS_CONTAINER_NAME=AgentLinkedin

# Admin credentials
ADMIN_EMAIL=admin@linkedin.ai
ADMIN_PASSWORD=admin123

# Email notifications (optional)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com
```

Start the server:

```bash
# Windows
start_backend.bat

# Or manually
uvicorn main:app --reload --host 127.0.0.1 --port 8010
```

Backend runs at `http://127.0.0.1:8010`. API docs at `http://127.0.0.1:8010/docs`.

### 2. Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select `linkedin-ext-v2(2)/linkedin-ext/`
4. Open the extension popup
5. Sign in or create an account (email + password)
6. Navigate to any LinkedIn page and start using the features

The extension auto-detects the backend on `127.0.0.1:8010`. If the local backend is unavailable, it falls back to the configured Azure URL.

### 3. Admin Dashboard

```bash
cd admin-dash-mock(1)/admin-dash-mock
npm install
npm run dev
```

Dashboard runs at `http://localhost:3000`.

**Login:** `http://localhost:3000/login`
- Email: `admin@linkedin.ai`
- Password: `admin123`

The dashboard connects to `http://127.0.0.1:8010` by default. To point it at a different backend, create `.env.local`:

```env
NEXT_PUBLIC_API_URL=https://your-production-backend.com
```

#### Dashboard Tabs

| Tab | What it shows |
|-----|---------------|
| **Overview** | KPI cards, usage charts, action distribution, top users, AI feature usage |
| **Users** | Registered users list with activity, deactivation controls |
| **Logs** | Full usage log with filters (action, status, date range), CSV export |
| **Snapshots** | Saved LinkedIn profile snapshots from extension users |
| **Networking** | Connection scoring stats, acceptance rates, goal distribution |
| **Notifications** | Notification system status, event types, delivery channels |

---

## Features

### Extension
- **Post Generator** — AI-generated LinkedIn posts (7 types, 4 tones, FR/EN)
- **Profile Optimizer** — AI headline, about, experience, skills generation
- **Profile Scorer** — Rule-based instant score + AI deep analysis (24h cache)
- **Gap Analyzer** — Side-by-side comparison with any LinkedIn profile
- **Networking Scanner** — Surface scan + deep scan + AI analysis pipeline
- **Chat Assistant** — Multi-intent AI chat (post, profile, networking, general)
- **Conversation Coach** — Real-time messaging practice mode
- **Notifications** — Per-event browser push + email notifications

### Backend API

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/health` | No | Server + Cosmos DB status |
| GET | `/test-connection` | No | Azure OpenAI connectivity check |
| POST | `/auth/register` | No | Create user account |
| POST | `/auth/login` | No | Login (returns JWT) |
| POST | `/auth/admin-login` | No | Admin login |
| POST | `/generate-post` | JWT | Generate LinkedIn post |
| POST | `/generate-profile` | JWT | Generate profile content |
| POST | `/route-chat` | JWT | AI chat with intent routing |
| POST | `/conversation-coach` | JWT | Conversation coaching |
| POST | `/profile-snapshot` | JWT | Save scraped profile to Cosmos DB |
| POST | `/profile/gap-analysis` | JWT | AI gap analysis vs target profile |
| POST | `/profile/ai-score` | JWT | AI deep profile scoring |
| POST | `/networking/onboarding` | JWT | Save networking goal |
| GET | `/networking/profile` | JWT | Get user's networking profile |
| POST | `/networking/score` | JWT | Rule-based candidate scoring |
| POST | `/networking/message` | JWT | AI connection message generation |
| POST | `/networking/analyze` | JWT | AI deep analysis of candidates |
| POST | `/networking/chat` | JWT | Networking-specific AI chat |
| POST | `/notifications/send-email` | JWT | Send email notification |
| GET | `/admin/stats` | Admin | Dashboard aggregate stats |
| GET | `/admin/users` | Admin | Paginated user list |
| GET | `/admin/logs` | Admin | Paginated usage logs |
| GET | `/admin/feature-stats` | Admin | Gap analysis / AI score / networking counts |

---

## Production Deployment

1. Deploy the FastAPI backend (Azure App Service, Railway, etc.)
2. Set all `.env` variables in the hosting platform
3. Change `ADMIN_PASSWORD` to something strong
4. Build the admin dashboard: `npm run build && npm start`
5. Set `NEXT_PUBLIC_API_URL` to your production backend URL
6. The Chrome extension auto-discovers the backend via the options page URL setting

---

## Notes

- All LinkedIn scraping runs client-side in the Chrome extension — the backend never accesses LinkedIn directly
- API keys are server-side only, never exposed to the browser
- JWT tokens expire after 24 hours
- Cosmos DB caches (admin stats, user request counts) have 2-5 minute TTL
- The extension stores profile data in `chrome.storage.local` for offline access
