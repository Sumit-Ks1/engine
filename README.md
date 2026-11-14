# Trend Engine

Collects the highest-traction posts, videos and stories for a list of keywords / hashtags
across YouTube, Instagram, X (Twitter), Reddit, Pinterest and Google, and shows them in a dashboard.

```
web/     Next.js dashboard + server-side routes (login, keyword upload, results)
engine/  Node.js service: job queue, collectors, rotating egress, SQLite cache
```

The browser only talks to `web/`. `web/` talks to `engine/` server-side with a shared key.
Collection runs in the engine's background queue, so nothing is tied to a web request timeout.

## Run

Needs Node.js 22.13 or newer.

```bash
cd engine && cp .env.example .env && npm install && npm run dev
```

```bash
cd web && cp .env.example .env.local && npm install && npm run dev
```

Fill in both env files first (`openssl rand -hex 32` for the key and the session secret).
Open http://localhost:3000, sign in, add keywords or upload an `.xlsx` / `.csv`.

Production: `npm run build && npm start` in each folder. Keep the engine on a private address.

## How it works

- Adding a keyword queues one job per platform. Workers collect up to `RESULT_LIMIT` (100)
  items, rank them by traction (views + weighted likes / comments / shares) and cache them.
- Everything is re-collected every `REFRESH_HOURS`. "Refresh now" jumps the queue.
- A failed or empty run never overwrites results already cached.
- Requests rotate across egress routes; a route that gets turned away cools down with
  exponential back-off while traffic moves to the others. Requests to one host are spaced out.

## Rotating IPs on AWS

```bash
cd engine && npm run gateways -- create
```

Creates an API Gateway per target host in each region of `AWS_GATEWAY_REGIONS` and writes
`gateways.json`; set `AWS_GATEWAYS_FILE=./gateways.json`. Each request then leaves from a
different AWS address. `npm run gateways -- delete` removes them. AWS charges per request
and per GB. `PROXY_URLS` can be used instead of, or together with, the gateways.

## What each platform returns

| Platform  | Source                                              | Numbers                                         |
|-----------|-----------------------------------------------------|-------------------------------------------------|
| YouTube   | Search sorted by views (month → year → all time)    | Views; likes/comments for top `YOUTUBE_ENRICH_TOP` |
| Reddit    | Top posts (week → month → year)                     | Upvotes, comments, crossposts                   |
| Pinterest | Pin search                                          | Reactions, comments, saves; promoted pins tagged |
| Google    | Google News results for the keyword                 | None exist on Google; ordered by Google's rank  |
| Instagram | Hashtag payload if served, else public post links   | Likes, comments, plays where the embed shows them |
| X         | Public post links + X's public embed data           | Likes, replies                                  |

Known limits:

- **Instagram and X** show hashtag/search results only to signed-in visitors. Without accounts,
  the engine finds public post links through web search and reads each post's public embed, so
  these two return fewer than 100 items and not strictly the top ones.
- **AWS addresses are datacenter IPs.** Instagram, Pinterest and Google turn many of them away.
  Add residential proxies via `PROXY_URLS` if those platforms show "turned away" in the dashboard.
- **Ads**: promoted items are tagged where a platform includes them in results (Pinterest, Reddit).
  There is no dedicated ad-library collector.
- Collectors read the sites' own pages, which change without notice. `npm test` in `engine/`
  covers the parsers; when a platform changes its markup the matching file in
  `engine/src/scrapers/` is the only place to update.

`DEMO_MODE=1` on the engine serves clearly labelled sample data for UI work. Never set it in production.
