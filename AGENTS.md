# AGENTS.md

## Project
Raw Organic Records

## Stack
- Vite
- React
- Supabase

## Goal
Build a record label website with sections for:
- Home
- Artists
- Music
- Social
- Blog

Each artist should eventually have an individual detail page that aggregates:
- releases
- social posts
- related blog content
- platform/account links

## Current backend status
Supabase is connected and working.

### Environment
This is a Vite app, so environment variables must use:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Do not convert this project to Next.js conventions.

### Existing Supabase tables
- `artists`
- `artist_links`
- `releases`
- `release_links`
- `blog_posts`
- `blog_post_artists`
- `social_posts`

### Security
- RLS is enabled
- Public read policies exist for current public-facing tables

## Current frontend status
- Artists are already being fetched from Supabase and rendered on the Artists page
- Some other sections still rely on mock/model-based data from `useLabelData()`
- We are replacing mock data incrementally, not rewriting the whole app at once

## Important auth note
Guest state is normal.
Do not assume a logged-in user exists.
Do not throw errors just because there is no auth session.

Prefer safe session checks over hard failure.

## Development rules
1. Prefer incremental refactors over rewrites
2. Preserve current routing and styling unless there is a strong reason to change them
3. Keep the current UI structure intact as much as possible
4. If a component expects mock-only fields, simplify it safely to support real Supabase data
5. Do not add unnecessary abstractions
6. Keep code readable and straightforward

## Priority order
1. Replace mock releases with Supabase `releases`
2. Replace mock social feed with Supabase `social_posts`
3. Replace mock blog content with Supabase `blog_posts`
4. Gradually wire the artist detail page to real relational data
5. Keep the app stable throughout each step

## Working style
- Make one logical change at a time
- Explain what changed
- Keep output practical
- Avoid breaking working parts of the app