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

## Sign in to Instagram, X and Reddit (once)

These three only show search results to signed-in visitors. With the engine stopped:

```bash
cd engine && npm run login
```

A Chrome window opens with three tabs. Sign in on each, then close the window. The sign-ins
are saved in `engine/data/browser-profile` on this PC and reused by the engine. Use accounts
made for this purpose, not personal ones, and run the engine on the same network you signed in from.

## How it works

- Adding a keyword queues one job per platform. Each job gathers a pool of up to `POOL_SIZE`
  (300) candidates, ranks them by traction (views + weighted likes / comments / shares) and
  keeps the top `RESULT_LIMIT` (100).
- A failed or empty run never overwrites results already cached. "Refresh now" jumps the queue.
- Failures are listed in the dashboard and in `engine/data/errors.log`. When a signed-in
  platform returns very little, a screenshot of what the browser saw is saved in `engine/data/debug/`.

Two lanes:

- **Signed-in lane (Instagram, X, Reddit)**: a real Chrome window (parked off-screen; set
  `BROWSER_VISIBLE=1` to watch it) with the saved profile opens the
  platform's own search page, scrolls it, and reads the data the page loads. It always uses
  this machine's own connection (never a rotating IP), handles one keyword at a time with a
  randomised gap, has a daily cap, and pauses itself the moment a platform rate-limits or
  challenges the account. The dashboard shows the pause and how to clear it.
- **Anonymous lane (YouTube, Pinterest, Google)**: plain requests, which can go through the
  rotating egress below. YouTube falls back to the browser if requests are turned away.

At the default pace Instagram handles roughly one keyword a minute, so 600 keywords take
about 10 hours; that is why it refreshes every 48 hours.

## Rotating IPs on AWS (anonymous lane only)

```bash
cd engine && npm run gateways -- create
```

Creates an API Gateway per target host in each region of `AWS_GATEWAY_REGIONS` and writes
`gateways.json`; set `AWS_GATEWAYS_FILE=./gateways.json`. Each request then leaves from a
different AWS address. `npm run gateways -- delete` removes them. `PROXY_URLS` works too.
Signed-in platforms deliberately ignore this: an account that hops between addresses looks stolen.

## What each platform returns

| Platform  | Source                                                  | Numbers                                    |
|-----------|---------------------------------------------------------|--------------------------------------------|
| YouTube   | Search sorted by view count (month, year, all time)     | Views; likes/comments for the top `YOUTUBE_ENRICH_TOP` |
| Instagram | Signed-in keyword search grid, then `#tag` search       | Plays, likes, comments (looked up for the top `INSTAGRAM_ENRICH_TOP`) |
| X         | Signed-in "Top" search                                  | Views, likes, replies, reposts; ads tagged |
| Reddit    | Signed-in search, top of week / month / year            | Upvotes, comments, crossposts              |
| Pinterest | Pin search, deep pool then ranked                       | Reactions, comments, saves; ads tagged     |
| Google    | Google Trends rising + top related searches, then news stories | Growth %, interest score, outlets covering |

Known limits:

- Only YouTube can sort its whole catalogue by views. Elsewhere the list is the best of
  everything the platform shows for the keyword, not a guaranteed global top.
- Automated use of an account breaks these platforms' terms. The pacing lowers the risk; it
  cannot remove it.
- Google has no likes or views; Google Trends often rate-limits, in which case the tab shows stories only.
- Collectors read what the sites' own pages load, which changes without notice. `npm test`
  in `engine/` covers the parsers; each platform has one file in `engine/src/scrapers/`.

`DEMO_MODE=1` on the engine serves clearly labelled sample data for UI work. Never set it in production.
