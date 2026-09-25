#!/usr/bin/env node
/**
 * chirp — an MCP server that lets an AI agent read and post on X (Twitter).
 *
 * Why this exists: X has no free official write API. Every open-source "Twitter
 * scraper" is a reverse-engineered client of X's internal GraphQL API, and that
 * API breaks whenever X rotates its internal query IDs. This server keeps the
 * two fragile pieces (the CreateTweet query id and the auth header shape) as
 * plain configuration, so when X rotates them you update two env vars instead of
 * rewriting a library.
 *
 * Read  → @the-convocation/twitter-scraper (cookie-authenticated, stable).
 * Write → a single direct fetch to the CreateTweet GraphQL mutation, because the
 *         popular write libraries pin stale query IDs and silently return empty
 *         results (HTTP 200 with `tweet_results: {}`).
 *
 * See README.md for setup, deployment, and the "survival guide" for X's API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Scraper as ReadScraper, SearchMode } from '@the-convocation/twitter-scraper';
import fs from 'node:fs';
import * as z from 'zod';

// ---------------------------------------------------------------------------
// Configuration (env vars). The two values that X rotates live here so you can
// re-point them without touching code.
// ---------------------------------------------------------------------------

// Public bearer token of X's web app. Not a secret (it ships in the JS bundle),
// but X has rotated it before — override with X_BEARER_TOKEN when it changes.
const DEFAULT_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// CreateTweet GraphQL query id. Rotated by X. See README "Finding the current
// query id" for how to re-capture it from your browser's Network tab.
const DEFAULT_CREATE_TWEET_QUERY_ID = 'GYdIGqVWfZNho79bQ2XDoA';

// Feature flags sent in the CreateTweet body. These are less volatile than the
// query id; capture a fresh copy from DevTools if X starts rejecting the body.
const CREATE_TWEET_FEATURES = {
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  rweb_sports_post_context_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_nested_quote_preview_enabled: false,
  articles_preview_enabled: true,
  rweb_cashtags_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const config = {
  port: Number(process.env.PORT || 8899),
  cookiesFile: process.env.COOKIES_FILE || 'cookies.json',
  authKey: process.env.MCP_AUTH_KEY || '',
  publicHost: process.env.PUBLIC_HOST || '',
  username: process.env.X_USERNAME || '',
  bearer: process.env.X_BEARER_TOKEN || DEFAULT_BEARER,
  createTweetQueryId:
    process.env.X_CREATE_TWEET_QUERY_ID || DEFAULT_CREATE_TWEET_QUERY_ID,
};

// ---------------------------------------------------------------------------
// Auth + cookies
// ---------------------------------------------------------------------------

/** Enforce MCP_AUTH_KEY when set. Accepts `Authorization: Bearer` or `x-api-key`. */
function checkAuth(req, res) {
  if (!config.authKey) return true;
  const auth = String(req.headers.authorization || '').trim();
  const xkey = String(req.headers['x-api-key'] || '').trim();
  const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : xkey;
  if (given === config.authKey) return true;
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  return false;
}

/** Load cookies.json as an array of `name=value` strings. Accepts string or object arrays. */
function loadCookieStrings() {
  if (!fs.existsSync(config.cookiesFile)) {
    throw new Error(`cookies.json not found at ${config.cookiesFile}. Run scripts/capture-cookies.mjs first.`);
  }
  const data = JSON.parse(fs.readFileSync(config.cookiesFile, 'utf8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('cookies.json must be a non-empty array');
  if (data.every((c) => typeof c === 'string')) return data;
  return data.filter((c) => c && c.name && c.value).map((c) => `${c.name}=${c.value}`);
}

/**
 * Write path cookie string. IMPORTANT: only send the stable auth cookies.
 * Sending stale Cloudflare tokens (cf_clearance / __cf_bm) makes X flag the
 * request as automated (error 226). auth_token + ct0 are the essentials.
 */
const WRITE_COOKIE_NAMES = new Set(['auth_token', 'ct0', 'twid', 'lang']);
function writeCookieString() {
  return loadCookieStrings()
    .filter((s) => WRITE_COOKIE_NAMES.has(s.split('=')[0]))
    .join('; ');
}

function ct0Value() {
  const c = loadCookieStrings().find((s) => s.startsWith('ct0='));
  return c ? c.slice(4) : '';
}

// ---------------------------------------------------------------------------
// Read API — via the scraper (stable, cookie-authenticated)
// ---------------------------------------------------------------------------

let readScraper = null;
async function getReadScraper() {
  if (readScraper) return readScraper;
  const s = new ReadScraper();
  await s.setCookies(loadCookieStrings());
  const ok = await s.isLoggedIn().catch(() => false);
  if (!ok) throw new Error('X cookies are invalid (isLoggedIn=false). Re-capture them.');
  readScraper = s;
  return s;
}

function fmtTweet(t) {
  if (!t) return null;
  const id = t.id || t.restId || '';
  const username = t.username || t.screenName || '';
  return {
    id,
    name: t.name || '',
    username,
    text: (t.text || '').slice(0, 500),
    url: t.permanentUrl || (username && id ? `https://x.com/${username}/status/${id}` : ''),
    likes: t.likes ?? 0,
    retweets: t.retweets ?? 0,
    replies: t.replies ?? 0,
    time: t.timeParsed ? t.timeParsed.toISOString() : '',
  };
}

async function searchX(query, count) {
  const s = await getReadScraper();
  const r = await s.fetchSearchTweets(query, count, SearchMode.Top);
  return (r?.tweets || []).slice(0, count).map(fmtTweet).filter(Boolean);
}

async function trendsX() {
  const s = await getReadScraper();
  return s.getTrends();
}

async function getTweetX(id) {
  const s = await getReadScraper();
  return fmtTweet(await s.getTweet(id));
}

async function getUserTweetsX(username, count) {
  const s = await getReadScraper();
  const out = [];
  for await (const t of s.getTweets(username, count)) {
    const f = fmtTweet(t);
    if (f) out.push(f);
    if (out.length >= count) break;
  }
  return out;
}

async function profileX(username) {
  const s = await getReadScraper();
  const p = await s.getProfile(username);
  return {
    username: p?.username || username,
    name: p?.name || '',
    userId: p?.userId || '',
    followers: p?.followersCount ?? 0,
    following: p?.followingCount ?? 0,
    tweets: p?.tweetsCount ?? 0,
    bio: p?.biography || '',
    verified: !!p?.isVerified,
  };
}

/** Approximate home timeline: latest tweet from each followed account. */
async function homeTimelineX(count) {
  const s = await getReadScraper();
  let myId = '';
  try {
    const p = await s.getProfile(config.username);
    myId = p?.userId || p?.id || '';
  } catch {
    /* ignore */
  }
  if (!myId) {
    try { myId = await s.getUserIdByScreenName(config.username); } catch { /* ignore */ }
  }
  const following = [];
  try {
    for await (const p of s.getFollowing(myId, 50)) if (p?.username) following.push(p);
  } catch {
    /* ignore */
  }
  const tweets = [];
  for (const p of following.slice(0, 20)) {
    try {
      const lt = await s.getLatestTweet(p.username);
      const f = fmtTweet(lt);
      if (f) { f.author_name = p.name || p.username; tweets.push(f); }
    } catch {
      /* ignore per-account failures */
    }
  }
  tweets.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  return tweets.slice(0, count);
}

// ---------------------------------------------------------------------------
// Write API — direct CreateTweet GraphQL (no write library)
// ---------------------------------------------------------------------------

function extractPosted(r) {
  const id =
    r?.data?.create_tweet?.tweet_results?.result?.rest_id ||
    r?.data?.create_tweet?.tweet_results?.result?.legacy?.id_str ||
    r?.rest_id ||
    '';
  return { ok: true, id, url: id ? `https://x.com/${config.username}/status/${id}` : '' };
}

async function createTweet(text, tweetId) {
  const ct0 = ct0Value();
  const variables = {
    tweet_text: text,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
    semantic_annotation_options: { source: 'UniversalLink' },
  };
  if (tweetId) variables.reply = { in_reply_to_tweet_id: tweetId };

  const res = await fetch(
    `https://x.com/i/api/graphql/${config.createTweetQueryId}/CreateTweet`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.bearer}`,
        cookie: writeCookieString(),
        'content-type': 'application/json',
        'x-csrf-token': ct0,
        // The web app authenticates writes as "OAuth2Session", NOT "OAuth2Client".
        // The wrong value is the #1 reason write libraries return empty results.
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        variables,
        features: CREATE_TWEET_FEATURES,
        queryId: config.createTweetQueryId,
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (data?.errors?.length) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`X rejected the tweet: ${msg}`);
  }
  return extractPosted(data);
}

const postX = (text) => createTweet(text, null);
const replyX = (tweetId, text) => createTweet(text, tweetId);

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function getServer() {
  const server = new McpServer({ name: 'chirp', version: '1.0.0' });

  server.registerTool(
    'x_read_timeline',
    {
      description: 'Read the home timeline (latest tweets from accounts you follow). Returns id/author/text/link.',
      inputSchema: { count: z.number().int().min(1).max(50).default(20).describe('how many tweets to read') },
    },
    async ({ count }) => {
      const tweets = await homeTimelineX(count);
      return { content: [{ type: 'text', text: JSON.stringify(tweets, null, 2) }] };
    }
  );

  server.registerTool(
    'x_search',
    {
      description: 'Search X for tweets matching a query.',
      inputSchema: {
        query: z.string().describe('search keyword'),
        count: z.number().int().min(1).max(100).default(20).describe('number of results'),
      },
    },
    async ({ query, count }) => {
      const tweets = await searchX(query, count);
      return { content: [{ type: 'text', text: JSON.stringify(tweets, null, 2) }] };
    }
  );

  server.registerTool(
    'x_trends',
    { description: 'Get current trending topics on X.' },
    async () => {
      const trends = await trendsX();
      return { content: [{ type: 'text', text: JSON.stringify(trends) }] };
    }
  );

  server.registerTool(
    'x_get_tweet',
    {
      description: 'Read a single tweet by id.',
      inputSchema: { tweet_id: z.string().describe('tweet id') },
    },
    async ({ tweet_id }) => {
      const t = await getTweetX(tweet_id);
      return { content: [{ type: 'text', text: JSON.stringify(t) }] };
    }
  );

  server.registerTool(
    'x_get_user_tweets',
    {
      description: 'Read a user\'s recent tweets.',
      inputSchema: {
        username: z.string().describe('username without @'),
        count: z.number().int().min(1).max(50).default(20).describe('number of results'),
      },
    },
    async ({ username, count }) => {
      const tweets = await getUserTweetsX(username.replace(/^@/, ''), count);
      return { content: [{ type: 'text', text: JSON.stringify(tweets, null, 2) }] };
    }
  );

  server.registerTool(
    'x_profile',
    {
      description: 'Get a user\'s profile (followers/following/bio).',
      inputSchema: { username: z.string().describe('username without @') },
    },
    async ({ username }) => {
      const p = await profileX(username.replace(/^@/, ''));
      return { content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] };
    }
  );

  server.registerTool(
    'x_post',
    {
      description: 'Post a new tweet as the configured X account.',
      inputSchema: { text: z.string().min(1).max(280).describe('tweet body, ≤280 chars') },
    },
    async ({ text }) => {
      const r = await postX(text);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    }
  );

  server.registerTool(
    'x_reply',
    {
      description: 'Reply to a tweet.',
      inputSchema: {
        tweet_id: z.string().describe('id of the tweet to reply to'),
        text: z.string().min(1).max(280).describe('reply body'),
      },
    },
    async ({ tweet_id, text }) => {
      const r = await replyX(tweet_id, text);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport (stateless streamable HTTP)
// ---------------------------------------------------------------------------

// The MCP SDK's DNS-rebinding protection only allows localhost by default. When
// served behind a reverse proxy / tunnel, add your public hostname here.
const allowedHosts = config.publicHost
  ? [config.publicHost, 'localhost', '127.0.0.1']
  : ['localhost', '127.0.0.1'];

const app = createMcpExpressApp({ allowedHosts });

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    readReady: !!readScraper,
    postReady: !!ct0Value(),
    cookiesFile: config.cookiesFile,
  });
});

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const server = getServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: String((error && error.message) || error) },
        id: null,
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
});
app.delete('/mcp', (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`chirp listening on :${config.port}`);
});
