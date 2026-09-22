# gauge-backend

Backend only. The Expo / React Native mobile app lives in a separate repo and calls
this service over HTTP. No UI code belongs here -- this is an API, not a website.

Next.js 16 (App Router), TypeScript strict, deployed on Vercel.

See @AGENTS.md for Next.js-version-specific guidance. **The rules in this file take
precedence over anything in AGENTS.md.**

## Secrets

The Rentcast API key is a server-side environment variable (`RENTCAST_API_KEY`) and
nothing else. It must never appear in:

- source code or config files
- commits (`.env*` is gitignored; only `.env.example`, which holds no value, is committed)
- logs, console output, or telemetry
- error responses or any response body returned to a client

The real value lives only in Vercel env vars and a password manager.

## Git

Never commit and never push. Read-only git commands are fine.
Never write `Co-Authored-By` or any tool/agent attribution into commits, PR bodies, or files.

## Definition of done

`npx tsc --noEmit` exits clean.

## Routes

- `GET /api/health` -> `{ "ok": true }`

## Out of scope

Until explicitly asked for: `/api/property`, the Rentcast client, caching, response normalization.
