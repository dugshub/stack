#!/bin/bash
# Build multi-stack DAG for Scene 3
# 5-branch main stack + 2 dependent downstream stacks (3-4 branches each)
set -e

REPO_DIR="/Users/dug/Projects/sandbox/todo"
STATE_DIR="$HOME/.claude/stacks"
ST="st"

cd "$REPO_DIR"

# ── Clean everything ──

for pr in $(gh pr list --repo dugshub/todo --state open --json number --jq '.[].number' 2>/dev/null); do
  gh pr close "$pr" --repo dugshub/todo --delete-branch 2>/dev/null || true
done

git checkout main 2>/dev/null
git pull --ff-only 2>/dev/null || true
for branch in $(git branch | grep -v '^\* main$' | grep -v '^  main$' | tr -d ' *'); do
  git branch -D "$branch" 2>/dev/null || true
done

for ref in $(git branch -r | grep -v 'origin/main' | grep -v 'origin/HEAD' | tr -d ' '); do
  branch="${ref#origin/}"
  git push origin --delete "$branch" 2>/dev/null || true
done
git remote prune origin 2>/dev/null || true

rm -f "$STATE_DIR/todo.json"
rm -f "$STATE_DIR/todo.history.jsonl"

git clean -fd 2>/dev/null
git checkout . 2>/dev/null

git config user.name "Doug"
git config user.email "doug@example.com"

# ── Stack 1: api (5 branches) ──

git checkout -b api/1-schema main
mkdir -p src/db
cat > src/db/schema.ts << 'CODE'
export interface Todo {
  id: string
  title: string
  done: boolean
  createdAt: Date
}
CODE
git add -A && git commit -m 'add todo schema'

git checkout -b api/2-models
mkdir -p src/models
cat > src/models/user.ts << 'CODE'
export type User = {
  id: string
  name: string
  email: string
}
CODE
git add -A && git commit -m 'add user model'

git checkout -b api/3-routes
mkdir -p src/api
cat > src/api/todos.ts << 'CODE'
import { Hono } from "hono"
const app = new Hono()
app.get("/todos", (c) => c.json([]))
app.post("/todos", (c) => c.json({ ok: true }))
export default app
CODE
git add -A && git commit -m 'add todo routes'

git checkout -b api/4-auth
mkdir -p src/middleware
cat > src/middleware/auth.ts << 'CODE'
export const auth = async (c, next) => {
  const token = c.req.header("Authorization")
  if (!token) return c.json({ error: "unauthorized" }, 401)
  return next()
}
CODE
git add -A && git commit -m 'add auth middleware'

git checkout -b api/5-validation
cat > src/middleware/validate.ts << 'CODE'
export const validate = (schema) => async (c, next) => {
  const body = await c.req.json()
  if (!body.title) return c.json({ error: "title required" }, 400)
  return next()
}
CODE
git add -A && git commit -m 'add validation middleware'

# Register api stack
git checkout api/1-schema
$ST create api api/1-schema api/2-models api/3-routes api/4-auth api/5-validation

# ── Stack 2: cache (3 branches, depends on api/3-routes) ──

git checkout api/3-routes
git checkout -b cache/1-redis
mkdir -p src/cache
cat > src/cache/redis.ts << 'CODE'
export const redis = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: 6379,
}
CODE
git add -A && git commit -m 'add redis config'

git checkout -b cache/2-keys
cat > src/cache/keys.ts << 'CODE'
export const cacheKey = (resource: string, id: string) =>
  `todo:${resource}:${id}`
CODE
git add -A && git commit -m 'add cache key builder'

git checkout -b cache/3-middleware
cat > src/cache/middleware.ts << 'CODE'
import { cacheKey } from "./keys"
export const cached = async (c, next) => {
  const key = cacheKey("todos", c.req.param("id"))
  // check cache, fallback to handler
  return next()
}
CODE
git add -A && git commit -m 'add cache middleware'

git checkout cache/1-redis
$ST create cache cache/1-redis cache/2-keys cache/3-middleware --base api/3-routes

# ── Stack 3: realtime (3 branches, depends on api/5-validation) ──

git checkout api/5-validation
git checkout -b realtime/1-ws-server
mkdir -p src/realtime
cat > src/realtime/server.ts << 'CODE'
export const wsServer = {
  port: 3001,
  onConnect: (ws) => console.log("connected"),
}
CODE
git add -A && git commit -m 'add websocket server'

git checkout -b realtime/2-events
cat > src/realtime/events.ts << 'CODE'
export type Event =
  | { type: "todo:created"; todo: Todo }
  | { type: "todo:updated"; todo: Todo }
  | { type: "todo:deleted"; id: string }
CODE
git add -A && git commit -m 'add event types'

git checkout -b realtime/3-subscriptions
cat > src/realtime/subscriptions.ts << 'CODE'
const subscribers = new Map<string, Set<WebSocket>>()
export const subscribe = (topic: string, ws: WebSocket) => {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set())
  subscribers.get(topic)!.add(ws)
}
CODE
git add -A && git commit -m 'add subscription manager'

git checkout realtime/1-ws-server
$ST create realtime realtime/1-ws-server realtime/2-events realtime/3-subscriptions --base api/5-validation

# ── Submit all stacks ──

git checkout api/1-schema
$ST submit

git checkout cache/1-redis
$ST submit

git checkout realtime/1-ws-server
$ST submit

# ── Position for demo ──
# Start at tip of realtime — st -i will show cursor here, we nav UP to root
git checkout realtime/3-subscriptions

echo ""
echo "✓ Ready for Scene 3"
echo "  3 stacks, 11 branches, $(gh pr list --repo dugshub/todo --state open --json number --jq 'length') PRs"
echo "  Current branch: api/3-routes (st down → api/2-models)"
