<p align="center">
  <img src="assets/logo.svg" alt="chirp logo" width="120" height="120"/>
</p>

<h1 align="center">chirp</h1>

<p align="center">
  <b>An MCP server that gives an AI agent read + write access to X (Twitter)</b><br/>
  through the internal web API — <b>no paid API key</b>.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/License-AGPL--3.0-3A5A98.svg"/></a>
  <a href="#requirements"><img alt="Node.js >=18" src="https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg"/></a>
  <a href="#tools"><img alt="MCP: Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-FF6B35.svg"/></a>
</p>

X retired its free v1.1 API and the paid tiers are prohibitively expensive for personal agents. This project re-uses the same GraphQL endpoint the x.com web app calls, wraps it in a small MCP server, and exposes eight tools your agent can call directly: read your timeline, search, check trends, read a profile — and post or reply.

```
┌──────────────┐        MCP (HTTP)         ┌──────────────────┐
│  AI agent    │ ───────────────────────▶  │  chirp              │
│  (Claude,    │   /mcp   (stateless       │  (Node, :8899)    │
│   kelivo,    │    streamable HTTP)       │                   │
│   Cursor …)  │                           │  ┌─────────────┐  │
└──────────────┘                           │  │  read path  │──┼──▶ twitter-scraper
                                           │  └─────────────┘  │      (cookie auth)
                                           │  ┌─────────────┐  │
                                           │  │ write path  │──┼──▶ CreateTweet GraphQL
                                           │  └─────────────┘  │      (direct fetch)
                                           └──────────────────┘
                                                    │
                                             cookies.json
                                            (auth_token + ct0)
```

## Why this project is a little unusual

There are two ways people build "free Twitter bots":

1. **A scraper library** (`twitter-scraper`, `agent-twitter-client`, …). These are great for *reading*, but the write path in most libraries pins a **stale GraphQL query id**. X rotates these ids periodically, and when it does, posting stops working — the endpoint returns HTTP 200 with an empty `tweet_results: {}` and no error.
2. **A full web-driver** (Playwright/Selenium driving the real site). This always works but is heavy, slow, and fragile to DOM changes.

This project splits the difference:

- **Read** uses `@the-convocation/twitter-scraper` (stable, cookie-authenticated).
- **Write** is a single direct `fetch` to the `CreateTweet` GraphQL mutation, with the query id and auth header shape kept as **plain configuration** so you can re-point them when X rotates them — no library rewrite.

That decision is the whole reason this server keeps working after X changes its API: the two fragile constants (`CREATE_TWEET_QUERY_ID` and the bearer token) are environment variables, and the README below tells you exactly how to re-capture them from your own browser.

## Tools

| Tool | Action | Read/Write |
|------|--------|-----------|
| `x_read_timeline` | Latest tweets from accounts you follow | read |
| `x_search` | Search tweets by keyword | read |
| `x_trends` | Current trending topics | read |
| `x_get_tweet` | Read one tweet by id | read |
| `x_get_user_tweets` | A user's recent tweets | read |
| `x_profile` | A user's profile (followers / following / bio) | read |
| `x_post` | Post a new tweet | **write** |
| `x_reply` | Reply to a tweet | **write** |

All tools return plain JSON, so any MCP-compatible client can call them.

## Requirements

- Node.js **≥ 18** (uses global `fetch`).
- An X account you're willing to use from a datacenter IP (see the rate-limit note in [Troubleshooting](#troubleshooting)).

## Quick start (local)

```bash
git clone https://github.com/<you>/chirp.git
cd chirp
npm install

# 1. Capture your X session cookies (opens a browser for you to log in)
npm i -D playwright && npx playwright install chromium
npm run capture-cookies          # → writes cookies.json

# 2. Set your handle (required for x_read_timeline)
cp .env.example .env             # then edit X_USERNAME

# 3. Run
npm start                        # → listening on :8899
```

Verify it's up:

```bash
npm run smoke-test
# initialize: { name: 'chirp', version: '1.0.0' }
# tools: x_read_timeline, x_search, x_trends, x_get_tweet, x_get_user_tweets, x_profile, x_post, x_reply
```

Then connect it to your MCP client. For Claude Code:

```bash
claude mcp add chirp --transport http http://127.0.0.1:8899/mcp
```

## Configuration

Copy `.env.example` to `.env`. Every value is optional except `X_USERNAME` (for the timeline tool).

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8899` | HTTP listen port |
| `COOKIES_FILE` | `./cookies.json` | Path to captured session cookies |
| `PUBLIC_HOST` | *(empty)* | Public hostname when behind a tunnel/proxy — **required** for remote use (see below) |
| `MCP_AUTH_KEY` | *(empty)* | If set, clients must send `Authorization: Bearer <key>` or `x-api-key: <key>` |
| `X_USERNAME` | *(empty)* | Your handle without `@`, for `x_read_timeline` |
| `X_BEARER_TOKEN` | *(built-in)* | Override when X rotates the web-app bearer token |
| `X_CREATE_TWEET_QUERY_ID` | *(built-in)* | Override when X rotates the CreateTweet query id |

## Deploy to a VPS (with Cloudflare Tunnel)

For a phone or any client that isn't on your LAN, run the server on a VPS and expose it over HTTPS. The steps below assume Ubuntu and Cloudflare Tunnel.

### 1. Install and run the server

```bash
# on the VPS
sudo apt update && sudo apt install -y nodejs npm
# (if the distro's Node is <18, install via nvm or nodesource)
git clone https://github.com/<you>/chirp.git && cd chirp
npm install
npm run capture-cookies   # needs a display; or run it locally and scp cookies.json up

cp .env.example .env
# PUBLIC_HOST=chirp.example.com   ← your tunnel hostname
# MCP_AUTH_KEY=<openssl rand -hex 24>

npm i -g pm2
pm2 start ecosystem.config.example.cjs --name chirp   # after copying to ecosystem.config.cjs
```

### 2. Expose it with Cloudflare Tunnel

```bash
cloudflared tunnel create chirp
cloudflared tunnel route dns chirp chirp.example.com
# in ~/.cloudflared/config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: chirp.example.com
#       service: http://localhost:8899
#     - service: http_status:404
pm2 start cloudflared -- tunnel --config ~/.cloudflared/config.yml
```

### ⚠️ The DNS-rebinding gotcha

The MCP SDK's `createMcpExpressApp()` enables DNS-rebinding protection and only allows `localhost` by default. Behind a tunnel the `Host` header is your public domain, so requests fail with **"Invalid Host"**. That's what `PUBLIC_HOST` is for — the server adds your hostname to the allow-list:

```js
// src/server.mjs
const allowedHosts = config.publicHost
  ? [config.publicHost, 'localhost', '127.0.0.1']
  : ['localhost', '127.0.0.1'];
```

Set `PUBLIC_HOST` to your tunnel hostname and this error disappears.

### 3. Point your client at the public endpoint

```bash
claude mcp add chirp --transport http https://chirp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_KEY>"
```

> **Note on region.** If your VPS is behind a network that blocks x.com (e.g. a mainland-China IP), the write path will fail. Run the server on a VPS whose IP can reach x.com directly.

## Survival guide: keeping the write path alive

The write path is reverse-engineered from the x.com web app, so X can break it at any time. Every failure you'll hit is one of the four below, and each has a known fix.

### 1. Empty result — "posting returns nothing" (rotated query id)

**Symptom:** `x_post` succeeds (no error) but returns `{ ok: true, id: "", url: "" }`, and the tweet never appears. The raw response is HTTP 200 with `tweet_results: {}`.

**Cause:** X rotated the `CreateTweet` GraphQL query id. Your `X_CREATE_TWEET_QUERY_ID` is stale.

**Fix — re-capture it from your browser:**
1. Log in to x.com in a desktop browser, open DevTools → Network.
2. Type a tweet and press Post.
3. Filter for `graphql`. Find the request to `https://x.com/i/api/graphql/<ID>/CreateTweet`.
4. Copy the `<ID>` (a 22-character token) and set it as `X_CREATE_TWEET_QUERY_ID`.

### 2. Error 226 — "looks automated"

**Symptom:** X returns error code `226`.

**Cause:** The write path sent a full cookie jar that includes stale Cloudflare tokens (`cf_clearance`, `__cf_bm`). Those stale tokens mark the request as automated.

**Fix:** This server already filters the write-path cookie string to only `auth_token`, `ct0`, `twid`, and `lang`. If you call the GraphQL endpoint yourself, don't send the Cloudflare cookies.

### 3. Error 344 — daily post limit

**Symptom:** X returns error code `344` ("daily limit for sending Tweets").

**Cause:** New or low-activity accounts get a very small daily post quota. It resets after ~24h.

**Fix:** None in code — this is an account-level limit. Posting regularly and gaining followers raises the quota over time.

### 4. Error 32 — authentication failed

**Symptom:** X returns error code `32`.

**Cause:** `auth_token` is expired or invalid.

**Fix:** Re-run `npm run capture-cookies` to refresh the session.

### Also: the auth header shape

Writes must send `x-twitter-auth-type: OAuth2Session` — **not** the `OAuth2Client` value many write libraries use. The wrong value is the #1 reason third-party write libraries return empty results. The server handles this for you; it's documented here because it's the detail most people get wrong when they reimplement the call.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Invalid Host: <domain>` | `PUBLIC_HOST` not set | Set `PUBLIC_HOST` to your tunnel hostname |
| `Not Acceptable` (406) | Client didn't send `Accept: application/json, text/event-stream` | Use a real MCP client; for curl, add the header |
| `cookies.json not found` | Forgot the capture step | Run `npm run capture-cookies` |
| `isLoggedIn=false` | Expired cookies | Re-capture cookies |
| Read works, write returns empty | Rotated query id | See survival guide #1 |

## Security

- `cookies.json`, `.env`, and any `MCP_AUTH_KEY` are **secrets**. They are git-ignored — never commit them.
- The X password is **never** stored anywhere. Only the session cookies are captured and used.
- If you expose the server publicly, **set `MCP_AUTH_KEY`**. Without it, anyone who can reach the port can post as you.
- Use HTTPS (the Cloudflare Tunnel does this for you). Never expose the raw HTTP port to the internet.

## Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by X Corp / Twitter**. It uses X's internal, undocumented API, which may change without notice and which your use of may violate X's Terms of Service. You are responsible for your own account and for complying with X's rules. Use at your own risk; the authors assume no liability.

## License

[AGPL-3.0](LICENSE) — free software. If you run a modified version as a network service, the AGPL requires you to offer its source to your users.

---

*中文详细教程见 [README.zh-CN.md](README.zh-CN.md)。*
