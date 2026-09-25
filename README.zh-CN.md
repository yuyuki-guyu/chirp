# chirp · 中文教程

> 一个 MCP 服务器，让 AI 智能体（Claude、kelivo、Cursor 等）**读 X（Twitter）** 也能 **发 X** —— 走 x.com 网页版内部接口，**不花一分钱 API 费**。

X 早就砍掉了免费的 v1.1 API，付费档对个人智能体来说贵得离谱。本项目复用了 x.com 网页版自己调用的那个 GraphQL 接口，包成一个小型 MCP 服务器，暴露 8 个工具给智能体直接调用：刷时间线、搜索、看热搜、看主页、发推、回复。

---

## 目录

1. [它为什么这么设计](#它为什么这么设计)
2. [架构](#架构)
3. [工具一览](#工具一览)
4. [本地快速开始](#本地快速开始)
5. [抓取 Cookies（关键步骤）](#抓取-cookies关键步骤)
6. [环境变量](#环境变量)
7. [部署到 VPS + Cloudflare 隧道](#部署到-vps--cloudflare-隧道)
8. [写接口求生指南（三个坑）](#写接口求生指南三个坑)
9. [排错表](#排错表)
10. [安全](#安全)
11. [许可证与免责声明](#许可证与免责声明)

---

## 它为什么这么设计

市面上"免费发推机器人"基本只有两条路：

1. **抓包库**（`twitter-scraper`、`agent-twitter-client` 等）：读没问题，但**写**这条路，多数库写死了一个**过期的 GraphQL query id**。X 会不定期轮换这个 id，一旦轮换，发推就悄悄失效 —— 接口返回 HTTP 200，但里面是空的 `tweet_results: {}`，连个报错都没有。
2. **整页驱动**（Playwright/Selenium 模拟真人浏览器）：永远能用，但重、慢、DOM 一改就崩。

本项目折中处理：

- **读**：用 `@the-convocation/twitter-scraper`（稳定、cookie 认证）。
- **写**：直接 `fetch` 调 `CreateTweet` GraphQL 接口，把 query id 和请求头形状做成**纯配置**，X 一轮换你改个环境变量就行，不用改库。

这就是这个服务器在 X 改接口后还能活下去的全部原因：两个易碎常量（`CREATE_TWEET_QUERY_ID` 和 bearer token）都是环境变量，下面还手把手教你从浏览器里重新抓到它们。

## 架构

```
┌──────────────┐        MCP (HTTP)         ┌──────────────────┐
│  AI 智能体    │ ───────────────────────▶  │  chirp              │
│  (Claude,    │   /mcp   （无状态          │  (Node, :8899)    │
│   kelivo,    │    streamable HTTP）       │                   │
│   Cursor …)  │                           │  ┌─────────────┐  │
└──────────────┘                           │  │  读路径      │──┼──▶ twitter-scraper
                                           │  └─────────────┘  │      (cookie 认证)
                                           │  ┌─────────────┐  │
                                           │  │  写路径      │──┼──▶ CreateTweet GraphQL
                                           │  └─────────────┘  │      (直接 fetch)
                                           └──────────────────┘
                                                    │
                                             cookies.json
                                            (auth_token + ct0)
```

## 工具一览

| 工具 | 作用 | 读/写 |
|------|------|-------|
| `x_read_timeline` | 我关注账号的最新推文 | 读 |
| `x_search` | 按关键词搜索推文 | 读 |
| `x_trends` | 当前热门趋势 | 读 |
| `x_get_tweet` | 按 id 读一条推文 | 读 |
| `x_get_user_tweets` | 某账号最近推文 | 读 |
| `x_profile` | 某账号资料（粉丝/关注/简介） | 读 |
| `x_post` | 发一条新推文 | **写** |
| `x_reply` | 回复一条推文 | **写** |

所有工具都返回纯 JSON，任何 MCP 客户端都能调。

## 本地快速开始

```bash
git clone https://github.com/<你>/chirp.git
cd chirp
npm install

# 1. 抓取你的 X 会话 cookies（会弹出一个浏览器让你登录）
npm i -D playwright && npx playwright install chromium
npm run capture-cookies          # → 生成 cookies.json

# 2. 填你的用户名（x_read_timeline 需要）
cp .env.example .env             # 编辑 X_USERNAME

# 3. 启动
npm start                        # → 监听 :8899
```

验证是否起来：

```bash
npm run smoke-test
# initialize: { name: 'chirp', version: '1.0.0' }
# tools: x_read_timeline, x_search, x_trends, x_get_tweet, x_get_user_tweets, x_profile, x_post, x_reply
```

然后接到你的 MCP 客户端。以 Claude Code 为例：

```bash
claude mcp add chirp --transport http http://127.0.0.1:8899/mcp
```

## 抓取 Cookies（关键步骤）

X 的登录页被 Cloudflare 挡着，无头脚本没法可靠地登录，所以用**有头浏览器**手动登录，脚本自动导出 cookies：

```bash
npm i -D playwright && npx playwright install chromium
npm run capture-cookies
```

脚本会：

1. 弹出一个真实的 Chromium 窗口，跳到 `x.com/login`；
2. 你自己手动登录（过验证码、过 Cloudflare 都行）；
3. 脚本每 2 秒检测一次，一旦出现 `auth_token` cookie，就自动存到 `cookies.json` 并退出。

> 如果你的网络需要代理才能上 X，可以 `X_PROXY=socks5://127.0.0.1:1080 npm run capture-cookies`。

导出的 `cookies.json` 是 `name=value` 字符串数组。**读**用全量 cookie 认证；**写**只取 `auth_token` / `ct0` / `twid` / `lang`（原因见下面"坑 #2"）。服务器已经帮你分好了，你不用管。

## 环境变量

复制 `.env.example` 成 `.env`。除了 `X_USERNAME`（时间线工具需要）外，其余都可选。

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `PORT` | `8899` | HTTP 监听端口 |
| `COOKIES_FILE` | `./cookies.json` | 会话 cookies 路径 |
| `PUBLIC_HOST` | *(空)* | 走隧道/反代时的公网域名，**远程用必填**（见下） |
| `MCP_AUTH_KEY` | *(空)* | 若设置，客户端必须带 `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `X_USERNAME` | *(空)* | 你的用户名（不带 `@`） |
| `X_BEARER_TOKEN` | *(内置)* | X 轮换 web 端 bearer 时覆盖 |
| `X_CREATE_TWEET_QUERY_ID` | *(内置)* | X 轮换 CreateTweet query id 时覆盖 |

## 部署到 VPS + Cloudflare 隧道

手机或任何不在你内网的客户端，都要把服务器放到 VPS 上、再用 HTTPS 暴露出去。下面假设 Ubuntu + Cloudflare 隧道。

### 1. 装并跑服务器

```bash
# 在 VPS 上
sudo apt update && sudo apt install -y nodejs npm
# 发行版 Node <18 的话，用 nvm 或 nodesource 装新版本
git clone https://github.com/<你>/chirp.git && cd chirp
npm install
npm run capture-cookies   # 需要图形界面；也可以本地抓好后 scp 上传

cp .env.example .env
# PUBLIC_HOST=chirp.example.com   ← 你的隧道域名
# MCP_AUTH_KEY=$(openssl rand -hex 24)

npm i -g pm2
cp ecosystem.config.example.cjs ecosystem.config.cjs   # 填好值
pm2 start ecosystem.config.cjs
```

### 2. 用 Cloudflare 隧道暴露

```bash
cloudflared tunnel create chirp
cloudflared tunnel route dns chirp chirp.example.com
# 编辑 ~/.cloudflared/config.yml：
#   tunnel: <tunnel-id>
#   credentials-file: /home/<用户>/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: chirp.example.com
#       service: http://localhost:8899
#     - service: http_status:404
pm2 start cloudflared -- tunnel --config ~/.cloudflared/config.yml
```

### ⚠️ DNS-rebinding 这个坑（会重复踩）

MCP SDK 的 `createMcpExpressApp()` 默认开了 DNS-rebinding 防护，只放行 `localhost`。走隧道后 `Host` 头变成你的公网域名，请求会报 **"Invalid Host"**。这正是 `PUBLIC_HOST` 的用途 —— 服务器会把你的域名加进白名单：

```js
// src/server.mjs
const allowedHosts = config.publicHost
  ? [config.publicHost, 'localhost', '127.0.0.1']
  : ['localhost', '127.0.0.1'];
```

把 `PUBLIC_HOST` 设成隧道域名，这个报错就消失。

### 3. 把客户端指向公网地址

```bash
claude mcp add chirp --transport http https://chirp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_KEY>"
```

> **地区注意**：如果 VPS 所在网络墙掉了 x.com（比如大陆 IP），写路径会失败。把服务器放到**能直连 x.com** 的 VPS 上（例如韩国、日本、新加坡等区域）。

## 写接口求生指南（三个坑）

写路径是逆向 x.com 网页端做出来的，X 随时可能改。你会碰到的失败不外乎下面四种，每种都有已知解法。

### 坑 #1：空结果 —— "发推返回没反应"（query id 轮换）

**现象**：`x_post` 不报错，但返回 `{ ok: true, id: "", url: "" }`，推文根本没发出去。原始响应是 HTTP 200，里面是 `tweet_results: {}`。

**原因**：X 轮换了 `CreateTweet` 的 GraphQL query id，你的 `X_CREATE_TWEET_QUERY_ID` 过期了。

**解法 —— 从浏览器重新抓**：
1. 桌面浏览器登录 x.com，打开 DevTools → Network；
2. 打一条推文点发布；
3. 过滤 `graphql`，找到发往 `https://x.com/i/api/graphql/<ID>/CreateTweet` 的请求；
4. 复制 `<ID>`（22 位字符串），设为 `X_CREATE_TWEET_QUERY_ID`。

### 坑 #2：错误 226 —— "looks automated"

**现象**：X 返回错误码 `226`。

**原因**：写路径带上了**过期的 Cloudflare 令牌**（`cf_clearance` / `__cf_bm`），这些过期令牌让 X 判定请求是自动化脚本。

**解法**：本服务器已经把写路径的 cookie 收敛到只剩 `auth_token`、`ct0`、`twid`、`lang`。如果你自己手动调接口，记住**别带** Cloudflare 那几个 cookie。

### 坑 #3：错误 344 —— 每日发推上限

**现象**：X 返回错误码 `344`（"daily limit for sending Tweets"）。

**原因**：新号或低活跃账号每日发推额度极低，约 24 小时重置。

**解法**：代码层面无解，这是账号级限制。规律发推、涨关注，额度会随账号活跃度逐步提升。

### 坑 #4：错误 32 —— 认证失败

**现象**：X 返回错误码 `32`。

**原因**：`auth_token` 过期或无效。

**解法**：重新 `npm run capture-cookies` 刷新会话。

### 还有：请求头形状

写请求必须带 `x-twitter-auth-type: OAuth2Session` —— **不是**很多写库用的 `OAuth2Client`。这个值写错，是第三方写库返回空结果的**头号原因**。服务器已经帮你处理好了；这里专门写出来，是因为大多数人自己重写这个调用时都会栽在这里。

## 排错表

| 症状 | 可能原因 | 解法 |
|------|---------|------|
| `Invalid Host: <域名>` | 没设 `PUBLIC_HOST` | 设成隧道域名 |
| `Not Acceptable` (406) | 客户端没带 `Accept: application/json, text/event-stream` | 用真 MCP 客户端；curl 则手动加头 |
| `cookies.json not found` | 漏了抓取步骤 | 跑 `npm run capture-cookies` |
| `isLoggedIn=false` | cookies 过期 | 重新抓 |
| 读正常、写返回空 | query id 轮换 | 见坑 #1 |

## 安全

- `cookies.json`、`.env`、`MCP_AUTH_KEY` 都是**机密**，已加入 `.gitignore`，**绝不提交**。
- X 密码**不落盘**，只抓取并使用会话 cookies。
- 公开暴露时**必须设 `MCP_AUTH_KEY`**，否则能摸到端口的人都能替你发推。
- 走 HTTPS（Cloudflare 隧道已经帮你做了）。**别**把裸 HTTP 端口直接暴露到公网。

## 许可证与免责声明

[AGPL-3.0](LICENSE) 自由软件协议：如果你把改过的版本当网络服务跑，AGPL 要求你向用户提供源码。

**免责声明**：本项目与 X Corp / Twitter 无任何关联、背书或赞助。它使用了 X 内部未公开的接口，该接口可能随时变更，且你的使用可能违反 X 的服务条款。请自行对账号负责、遵守 X 的规则，风险自负，作者不承担任何责任。
