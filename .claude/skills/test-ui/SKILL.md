---
name: test-ui
description: Launch Chrome browser automation to test the Tempo/Deal Brain web UI. Use when the user asks to test the app in the browser, verify UI behavior, check pages, login with Salesforce, or interact with the web interface.
allowed-tools: Bash, Read, Grep, Glob, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__javascript_tool, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__read_console_messages, mcp__claude-in-chrome__read_network_requests, mcp__claude-in-chrome__gif_creator
---

# Test UI — Tempo (Deal Brain) Browser Automation

You are an agent responsible for testing the Tempo (Deal Brain) web application through browser automation. This skill teaches you how to launch Chrome, navigate the app, authenticate, and verify UI behavior.

## App Access

- **URL:** `https://localhost:3001` (Caddy HTTPS reverse proxy with self-signed TLS)
- **Login page:** `https://localhost:3001/start`
- **Dashboard (after auth):** `https://localhost:3001/app/dashboard/opportunities`

The app runs locally via Docker + process-compose. Caddy on port 3001 provides HTTPS, proxying to Wrangler on port 3000, which routes to the NestJS API and Vite frontend.

## Getting Started with Browser Automation

### Step 1: Get tab context
Always start by getting available browser tabs:
```
mcp__claude-in-chrome__tabs_context_mcp (createIfEmpty: true)
```
This returns existing tabs. Create a new tab for testing unless the user wants to use an existing one:
```
mcp__claude-in-chrome__tabs_create_mcp
```

### Step 2: Navigate to the app
```
mcp__claude-in-chrome__navigate (url: "https://localhost:3001", tabId: <your-tab-id>)
```

### Step 3: Take a screenshot to see current state
```
mcp__claude-in-chrome__computer (action: "screenshot", tabId: <your-tab-id>)
```

## Authentication Flow

### Login Page
The app uses WorkOS AuthKit with Salesforce OAuth. The login page is at `/start` and shows:
- **"Welcome to Deal Brain."** heading
- **"Continue with Salesforce"** button (orange, primary)
- Terms of Service and Privacy Statement links

The "Continue with Salesforce" button links to:
```
/auth/salesforce?return_to=/start?step=form&formStep=salesforce
```

### Auth Route Guards
- **Guest routes** (`/_guest/*`): Redirect authenticated users to `/dashboard/opportunities`
- **Authenticated routes** (`/_authenticated/*`): Redirect unauthenticated users to `/start`

### Checking Auth State
If you land on the dashboard, the user is already authenticated. If you land on `/start`, the user needs to log in.

### Login Process
1. Navigate to `https://localhost:3001/start`
2. Find the "Continue with Salesforce" button
3. Click it — this redirects to WorkOS → Salesforce OAuth
4. **IMPORTANT:** The OAuth flow involves external redirects to Salesforce login. The user may need to manually enter credentials on the Salesforce login page. Do NOT enter passwords on behalf of the user.
5. After successful OAuth, the callback redirects to `/app/dashboard/opportunities`
6. A `wos-session` cookie is set (HttpOnly, Secure, sealed by WorkOS)

### Logout
Navigate to `https://localhost:3001/auth/logout` — clears the session cookie and redirects to the marketing landing page.

## App Navigation

### Sidebar (left side, always visible when authenticated)
The app has a vertical sidebar with navigation icons. Key pages:

| Icon/Area | Route | Purpose |
|-----------|-------|---------|
| Top logo | — | Tempo T lettermark |
| Deals/Opportunities | `/app/dashboard/opportunities` | Main opportunity list |
| Search | `/app/search` | Search functionality |
| Sync | `/app/sync` | Salesforce sync status |
| Projects | `/app/projects` | Project management |
| Updates | `/app/updates` | Activity updates |
| User avatar (bottom) | — | User menu / settings |

### Opportunities Page
- URL: `/app/dashboard/opportunities`
- Shows a table with columns: Name, Next Step, Opportunity Type, Close Date, Amount
- Has a search bar ("Find opportunity...")
- Has a "Fields" button showing field count
- Click a row to view opportunity details

### Key UI Patterns
- **Tables:** Most data views use tables with sortable columns
- **Search:** Filter inputs at the top of list views
- **Modals/Panels:** Detail views often open in side panels
- **Real-time sync:** Data updates via ElectricSQL (changes appear without refresh)

## Testing Strategies

### Visual Verification
1. Take screenshots at each step to verify UI state
2. Use `read_page` to inspect the DOM/accessibility tree
3. Use `find` to locate specific elements by natural language

### Interaction Testing
1. Click buttons, links, and interactive elements
2. Fill form inputs with `form_input`
3. Scroll to find off-screen content
4. Use keyboard shortcuts with `key` action

### Network & Console Monitoring
```
# Check for JavaScript errors
mcp__claude-in-chrome__read_console_messages (tabId, onlyErrors: true)

# Monitor API calls
mcp__claude-in-chrome__read_network_requests (tabId, urlPattern: "/api/")

# Check tRPC calls specifically
mcp__claude-in-chrome__read_network_requests (tabId, urlPattern: "trpc")
```

### Recording Test Sessions
Use GIF recording for multi-step test flows:
```
# Start recording
mcp__claude-in-chrome__gif_creator (action: "start_recording", tabId)

# Take initial screenshot
mcp__claude-in-chrome__computer (action: "screenshot", tabId)

# ... perform test actions with screenshots between steps ...

# Take final screenshot
mcp__claude-in-chrome__computer (action: "screenshot", tabId)

# Stop recording
mcp__claude-in-chrome__gif_creator (action: "stop_recording", tabId)

# Export GIF
mcp__claude-in-chrome__gif_creator (action: "export", tabId, download: true, filename: "test-name.gif")
```

## Frontend Tech Stack Reference

- **React 19** with TypeScript (strict mode)
- **TanStack Router** — File-based routing (`apps/frontend/src/routes/`)
- **TanStack DB + ElectricSQL** — Real-time data sync
- **tRPC v11** — Type-safe API calls
- **TailwindCSS v4** — Styling with design tokens in `apps/frontend/src/styles/tokens.css`
- **CVA (Class Variance Authority)** — Component variant system
- **Atomic design** — Components in `apps/frontend/src/components/atoms/`

### Key Frontend Files
- `apps/frontend/src/routes/_guest/start.tsx` — Login/start page
- `apps/frontend/src/routes/_guest.tsx` — Guest layout (redirects authenticated users)
- `apps/frontend/src/routes/_authenticated.tsx` — Auth layout with sidebar
- `apps/frontend/src/lib/auth/AuthProvider.tsx` — Auth context provider
- `apps/frontend/src/lib/collections.ts` — ElectricSQL real-time collections

## Troubleshooting

- **HTTPS certificate warning:** The app uses a self-signed cert. Browser may show a warning on first visit. The user needs to accept it manually.
- **Blank page:** Check if all services are running (`docker compose ps` + process-compose). Check browser console for errors.
- **Login redirect loop:** Session may be expired. Clear cookies for `localhost:3001` and try again.
- **API errors in console:** Check backend logs for details. Use `read_network_requests` to see response status codes.
- **Elements not found:** The app uses React with client-side rendering. Wait for page load (use `wait` action) before searching for elements.
- **ElectricSQL sync issues:** Check `docker compose logs electric` and network requests to `/electric/`.
