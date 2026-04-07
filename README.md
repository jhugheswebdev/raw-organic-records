# React App

This project is a minimal React app scaffolded with Vite.

## Getting started

1. Install Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Start the development server:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
```

## Sync scripts

The project includes import scripts for platform links and release metadata.

### SoundCloud

Add these environment variables before running the SoundCloud sync:

```bash
SOUNDCLOUD_CLIENT_ID=your_soundcloud_client_id
SOUNDCLOUD_CLIENT_SECRET=your_soundcloud_client_secret
SOUNDCLOUD_IMPORT_START_DATE=2026-04-06
```

Then run:

```bash
npm run sync:soundcloud
```

The sync reads artist SoundCloud profile URLs from `artist_links`, resolves each profile, and imports public tracks plus playlists into `releases` and `release_links`.

By default it only imports SoundCloud items dated on or after `2026-04-06`, so older catalog entries are skipped. You can move that cutoff later by changing `SOUNDCLOUD_IMPORT_START_DATE`.

If you want the app to automatically label SoundCloud entries longer than 10 minutes as `DJ Mix`, add this column in Supabase:

```sql
alter table public.releases
add column if not exists duration_ms bigint;
```
