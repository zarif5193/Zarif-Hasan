# Vercel deployment

This repository contains the Vercel adapter for the Zarif Hasan portfolio.

## Required environment variables

Set these in Vercel Project Settings > Environment Variables:

- `DATABASE_URL`: Supabase PostgreSQL connection string from Project Settings > Database. Never commit a real database password.
- `ADMIN_PASSWORD`: a unique admin password.
- `SESSION_SECRET`: a random secret of at least 32 characters.

Use Node.js 22 or newer. The Vercel handler is `api/index.js` and routing is configured in `vercel.json`.

The deployment is not production-ready until all application source files and public assets are committed and the environment variables are set.