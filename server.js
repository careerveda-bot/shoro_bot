"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const FormData = require("form-data");

const app = express();
app.use(express.json());

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// ─── 1. CONFIGURATION & CONSTANTS ───────────────────────────────────────────
let isPipelineRunning = false;

// ─── PENDING IMAGE REQUESTS ──────────────────────────────────────────────────
// Keyed by chatId. Stores data needed to generate image on user's YES reply.
const pendingImageRequests = {};
// { [chatId]: { topic, post, imageConcept, expiresAt } }

const PENDING_IMAGE_TTL_MS = 20 * 60 * 1000; // 20 minutes — auto-expire stale requests

// ─── PENDING TOPIC SELECTIONS ─────────────────────────────────────────────────
// Keyed by chatId. Stores news headlines shown to user so they can pick 1–5.
const pendingTopicSelections = {};
// { [chatId]: { topic, headlines: [{title, source}], expiresAt } }

// Keyed by chatId. Stores category headlines shown to user for /autopost selection.
const pendingAutopostSelections = {};
// { [chatId]: { category, region, headlines: [{title, source, url}], expiresAt } }

// Keyed by chatId. Stores final story choice until user selects platform.
const pendingPlatformSelections = {};
// { [chatId]: { flow: "topic"|"autopost", chosen, region?, source?, expiresAt } }

// Keyed by chatId. Stores category selections shown in greeting.
const pendingGreetingSelections = {};
// { [chatId]: { options: [string], expiresAt } }

// ─── PENDING MULTI-POST REQUESTS ──────────────────────────────────────────────
// Keyed by chatId. Stores multiple generated posts for combined feedback/image.
const pendingMultiPostRequests = {};
// { [chatId]: { posts: [{topic, post, imageConcept, platforms, source, region}], expiresAt } }

const PENDING_TOPIC_TTL_MS = 40 * 60 * 1000; // 40 minutes to pick a headline

// Optimize sharp for production memory usage
sharp.cache(false);

const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.error("FATAL: Set TELEGRAM_TOKEN (Telegram bot token).");
  process.exit(1);
}

const OPENCLAW_BIN = (() => {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Users\\BIT\\AppData\\Roaming\\npm\\openclaw.cmd",
      "C:\\Users\\BIT\\AppData\\Roaming\\npm\\openclaw.ps1",
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return "openclaw.cmd";
  }
  return "openclaw";
})();

const TELEGRAM_MAX_TEXT = 3900;
const TELEGRAM_MAX_CAPTION = 900;
const OPENCLAW_MAX_RETRIES = 5;
const RECENT_TOPICS_FILE = "recent_topics.json";
const RECENT_TOPICS_LIMIT = 10;
const OR_MODEL = process.env.OR_MODEL || "openai/gpt-4o-mini";
const OR_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const FONT_PATH = path.join(os.tmpdir(), "overlay-font-anton.ttf");
const OPENCLAW_MAIN = (() => {
  if (process.env.OPENCLAW_MAIN) return process.env.OPENCLAW_MAIN;
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(process.env.APPDATA || "", "npm", "node_modules", "openclaw", "dist", "openclaw.mjs"),
    path.join(__dirname, "node_modules", "openclaw", "openclaw.mjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
})();

// ─── 2. CATEGORIES & SUBREDDITS ─────────────────────────────────────────────

const CATEGORY_SUBREDDITS = {
  startup: ["startups", "entrepreneur", "SaaS", "business", "productivity", "ycombinator", "indiehackers", "soloentrepreneur"],
  edtech: ["edtech", "highereducation", "Teachers", "education", "learning", "onlinelearning", "instructionaldesign"],
  ai: ["artificial", "MachineLearning", "singularity", "LocalLLaMA", "ChatGPT", "OpenAI", "ClaudeAI", "StableDiffusion"],
  healthcare: ["healthtech", "medicine", "nursing", "healthcare", "digitalhealth", "biotech"],
  fintech: ["fintech", "personalfinance", "crypto", "investing", "banking", "payments", "wallstreetbets", "stocks", "finance", "etfs"],
  marketing: ["marketing", "socialmedia", "advertising", "copywriting", "growthhacking", "digitalmarketing", "contentmarketing"],
  business: ["business", "economics", "entrepreneur", "finance", "smallbusiness", "investing"],
  politics_policy: ["politics", "worldpolitics", "geopolitics", "NeutralPolitics", "policy", "economics"],
  jobs_education: ["jobs", "careerguidance", "cscareerquestions", "education", "Indian_Academia", "UPSC"],
  state_city_news: ["india", "IndiaSpeaks", "canada", "canadanews", "newyorkcity", "toronto"],
  tech_it: ["technology", "programming", "MachineLearning", "sysadmin", "devops", "startups"],
  economy_markets: ["economics", "investing", "stocks", "finance", "wallstreetbets", "IndiaInvestments"],
  south_india_digest: ["india", "chennai", "bangalore", "kerala", "hyderabad", "telangana"],
  nri_diaspora: ["NRI", "india", "immigration", "expats", "IndianDiaspora", "canada"],
  gn_ind_en: ["india", "worldnews", "business", "economics", "geopolitics", "news"],
  gn_ind_hi: ["india", "IndiaSpeaks", "indianews", "worldnews", "politics"],
  gn_tn_ta: ["chennai", "tamilnadu", "india", "jobs", "education"],
  gn_apts_te: ["andhra_pradesh", "telangana", "hyderabad", "india", "jobs"],
  gn_ka_kn: ["bangalore", "karnataka", "developersIndia", "startups", "india"],
  gn_mh_mr: ["mumbai", "maharashtra", "india", "economics", "news"],
  gn_south_en: ["chennai", "bangalore", "kerala", "hyderabad", "india"],
  gn_nri_en: ["NRI", "immigration", "expats", "india", "worldnews"],
  news_general: ["worldnews", "news", "upliftingnews", "nottheonion"],
  current_affairs: ["geopolitics", "worldpolitics", "economics", "unitedkingdom", "europe"],
  dmv_edtech: ["jee", "UPSC", "Indian_Academia", "udemy", "edtech", "learnprogramming"],
  controversy: ["unpopularopinion", "changemyview", "TrueOffMyChest", "AmItheAsshole"],
  personal_growth: ["getdisciplined", "selfimprovement", "decidingtobebetter", "productivity"],
  humor: ["India", "IndianPeopleFacebook", "desimemes", "Damnthatsinteresting"]
};


// ─── REGION-SPECIFIC SUBREDDITS ─────────────────────────────────────────────

const REGION_SUBREDDITS = {
  India: {
    startup: ["indianstartups", "india_business", "StartupIndia", "entrepreneur", "indiehackers"],
    edtech: ["IndianAcademia", "jee", "UPSC", "india", "edtech"],
    ai: ["india", "artificial", "MachineLearning", "ChatGPT", "LocalLLaMA"],
    healthcare: ["india", "healthtech", "medicine", "Ayurveda"],
    fintech: ["IndiaInvestments", "IndianStreetBets", "personalfinance", "india", "fintech"],
    marketing: ["digitalmarketing", "india", "marketing", "socialmedia"],
    business: ["india_business", "economics", "IndiaInvestments", "StartupIndia", "india"],
    politics_policy: ["IndiaSpeaks", "india", "geopolitics", "worldpolitics", "economics"],
    jobs_education: ["jobs", "IndianAcademia", "jee", "UPSC", "india"],
    state_city_news: ["india", "mumbai", "delhi", "bangalore", "chennai"],
    tech_it: ["developersIndia", "india", "programming", "MachineLearning", "startups"],
    economy_markets: ["IndiaInvestments", "IndianStreetBets", "economics", "stocks", "finance"],
    south_india_digest: ["chennai", "bangalore", "kerala", "hyderabad", "telangana"],
    nri_diaspora: ["india", "NRI", "immigration", "expats", "IndianDiaspora"],
    gn_ind_en: ["india", "india_business", "worldnews", "economics", "StartupIndia"],
    gn_ind_hi: ["india", "IndiaSpeaks", "indianews", "politics", "economics"],
    gn_tn_ta: ["tamilnadu", "chennai", "india", "jobs", "education"],
    gn_apts_te: ["andhra_pradesh", "telangana", "hyderabad", "india", "jobs"],
    gn_ka_kn: ["karnataka", "bangalore", "developersIndia", "startups", "india"],
    gn_mh_mr: ["maharashtra", "mumbai", "pune", "india", "economics"],
    gn_south_en: ["chennai", "bangalore", "kerala", "hyderabad", "india"],
    gn_nri_en: ["india", "NRI", "immigration", "expats", "IndianDiaspora"],
    news_general: ["india", "IndiaSpeaks", "worldnews", "indianews"],
    current_affairs: ["india", "IndiaSpeaks", "geopolitics", "worldpolitics"],
    controversy: ["india", "IndiaSpeaks", "unpopularopinion", "TrueOffMyChest"],
    personal_growth: ["india", "getdisciplined", "selfimprovement", "indianstartups"],
    humor: ["desimemes", "IndianPeopleFacebook", "india", "dankinindia"],
    dmv_edtech: ["jee", "UPSC", "IndianAcademia", "india"],
  },
  Canada: {
    startup: ["canadabusiness", "canadiantech", "startups", "entrepreneur", "waterloo"],
    edtech: ["canada", "CanadaEducation", "learnprogramming", "edtech"],
    ai: ["canada", "artificial", "MachineLearning", "ChatGPT"],
    healthcare: ["CanadaHealthcare", "canada", "healthtech", "medicine"],
    fintech: ["PersonalFinanceCanada", "CanadaInvesting", "canada", "fintech"],
    marketing: ["canada", "marketing", "digitalmarketing", "socialmedia"],
    business: ["canadabusiness", "canada", "economics", "smallbusiness", "entrepreneur"],
    politics_policy: ["CanadaPolitics", "canada", "onguardforthee", "geopolitics", "worldpolitics"],
    jobs_education: ["canada", "jobs", "CanadaEducation", "careerguidance", "learnprogramming"],
    state_city_news: ["canada", "toronto", "vancouver", "calgary", "canadanews"],
    tech_it: ["canadiantech", "canada", "programming", "MachineLearning", "devops"],
    economy_markets: ["CanadaInvesting", "PersonalFinanceCanada", "economics", "stocks", "finance"],
    south_india_digest: ["canada", "toronto", "vancouver", "india", "Tamil"],
    nri_diaspora: ["canada", "immigration", "expats", "NRI", "IndianDiaspora"],
    gn_ind_en: ["canadanews", "worldnews", "economics", "canadabusiness", "india"],
    gn_ind_hi: ["canadanews", "worldnews", "politics", "india", "canada"],
    gn_tn_ta: ["canada", "toronto", "vancouver", "india", "Tamil"],
    gn_apts_te: ["canada", "toronto", "india", "technology", "news"],
    gn_ka_kn: ["canadiantech", "canada", "programming", "india", "startups"],
    gn_mh_mr: ["canada", "canadanews", "economics", "india", "business"],
    gn_south_en: ["canada", "toronto", "vancouver", "india", "news"],
    gn_nri_en: ["canada", "immigration", "expats", "NRI", "IndianDiaspora"],
    news_general: ["canada", "canadanews", "worldnews", "onguardforthee"],
    current_affairs: ["canada", "CanadaPolitics", "geopolitics", "onguardforthee"],
    controversy: ["canada", "onguardforthee", "unpopularopinion", "changemyview"],
    personal_growth: ["canada", "getdisciplined", "selfimprovement", "productivity"],
    humor: ["canada", "CanadaHumour", "funny", "Damnthatsinteresting"],
    dmv_edtech: ["canada", "CanadaEducation", "learnprogramming", "driving"],
  },
  US: {
    startup: ["startups", "entrepreneur", "ycombinator", "SaaS", "indiehackers", "soloentrepreneur"],
    edtech: ["edtech", "highereducation", "Teachers", "education", "learnprogramming"],
    ai: ["artificial", "MachineLearning", "OpenAI", "ChatGPT", "LocalLLaMA", "singularity"],
    healthcare: ["healthtech", "medicine", "nursing", "healthcare", "digitalhealth"],
    fintech: ["fintech", "personalfinance", "wallstreetbets", "stocks", "investing", "banking"],
    marketing: ["marketing", "socialmedia", "advertising", "copywriting", "digitalmarketing"],
    business: ["business", "smallbusiness", "economics", "entrepreneur", "finance"],
    politics_policy: ["politics", "neutralnews", "geopolitics", "worldpolitics", "economics"],
    jobs_education: ["jobs", "careerguidance", "cscareerquestions", "education", "Teachers"],
    state_city_news: ["USnews", "news", "newyorkcity", "losangeles", "chicago"],
    tech_it: ["technology", "programming", "devops", "MachineLearning", "startups"],
    economy_markets: ["stocks", "investing", "wallstreetbets", "economics", "finance"],
    south_india_digest: ["USnews", "india", "immigration", "technology", "news"],
    nri_diaspora: ["immigration", "expats", "india", "NRI", "news"],
    gn_ind_en: ["USnews", "worldnews", "economics", "business", "india"],
    gn_ind_hi: ["USnews", "worldnews", "politics", "india", "news"],
    gn_tn_ta: ["USnews", "technology", "india", "immigration", "news"],
    gn_apts_te: ["USnews", "technology", "india", "immigration", "business"],
    gn_ka_kn: ["technology", "programming", "startups", "india", "USnews"],
    gn_mh_mr: ["USnews", "economics", "business", "india", "finance"],
    gn_south_en: ["USnews", "worldnews", "india", "technology", "news"],
    gn_nri_en: ["immigration", "expats", "india", "NRI", "USnews"],
    news_general: ["news", "worldnews", "USnews", "politics", "nottheonion"],
    current_affairs: ["politics", "geopolitics", "worldpolitics", "economics", "neutralnews"],
    controversy: ["unpopularopinion", "changemyview", "AmItheAsshole", "TrueOffMyChest"],
    personal_growth: ["getdisciplined", "selfimprovement", "decidingtobebetter", "productivity"],
    humor: ["funny", "Damnthatsinteresting", "mildlyinteresting", "nottheonion"],
    dmv_edtech: ["DMV", "driving", "learnprogramming", "edtech", "highereducation"],
  },
  Global: null, // null = use existing CATEGORY_SUBREDDITS (default behavior)
};

const REGION_RSS_FEEDS = {
  India: [
    "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",
    "https://www.moneycontrol.com/rss/business.xml",
    "https://feeds.feedburner.com/ndtvnews-latest",
    "https://yourstory.com/feed",
  ],
  Canada: [
    "https://www.cbc.ca/cmlink/rss-business",
    "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/",
    "https://betakit.com/feed/",
    "https://financialpost.com/feed",
  ],
  US: [
    "https://techcrunch.com/feed/",
    "https://feeds.feedburner.com/entrepreneur/latest",
    "https://www.wired.com/feed/rss",
    "https://feeds.bloomberg.com/technology/news.rss",
  ],
  Global: [], // Global uses Reddit + HN only (existing behavior)
};

const DEFAULT_CATEGORY = "startup";
const AUTOPPOST_CATEGORIES = [
  "startup",
  "edtech",
  "ai",
  "healthcare",
  "fintech",
  "marketing",
  "business",
  "politics_policy",
  "jobs_education",
  "state_city_news",
  "tech_it",
  "economy_markets",
  "south_india_digest",
  "nri_diaspora",
  "gn_ind_en",
  "gn_ind_hi",
  "gn_tn_ta",
  "gn_apts_te",
  "gn_ka_kn",
  "gn_mh_mr",
  "gn_south_en",
  "gn_nri_en",
  "news_general",
  "current_affairs",
  "dmv_edtech",
  "controversy",
  "personal_growth",
  "humor",
];

const AUTOPPOST_CATEGORY_ALIASES = {
  india_daily_snapshot: "gn_ind_en",
  bharat_news_hindi: "gn_ind_hi",
  tamil_nadu_news_today: "gn_tn_ta",
  telugu_24x7_news: "gn_apts_te",
  karnataka_daily_news: "gn_ka_kn",
  maharashtra_city_state_news: "gn_mh_mr",
  south_india_news_radar: "gn_south_en",
  nri_india_global_brief: "gn_nri_en",
};

const DEFAULT_AUTOPPOST_STRATEGY = {
  googleHeadlinesLimit: 5,
  signalLineCap: 40,
  sourceMixHint: "Use a balanced mix: roughly 50% community signals and 50% Google News headlines.",
  locale: { hl: "en-US", gl: "US", ceid: "US:en" },
};

const AUTOPPOST_CATEGORY_STRATEGY = {
  startup: {
    query: "startup business technology",
  },
  humor: {
    query: "funny news satire comedy internet culture weird news",
  },
  ai: {
    query: "artificial intelligence AI machine learning large language models tech",
  },
  edtech: {
    query: "edtech education technology learning online education university",
  },
  healthcare: {
    query: "healthcare healthtech medicine digital health biotech medical science",
  },
  fintech: {
    query: "fintech finance cryptocurrency investment banking financial tech payments",
  },
  marketing: {
    query: "marketing advertising branding growth hacking social media copywriting",
  },
  business: {
    query: "business corporate news economy markets company strategy",
  },
  politics_policy: {
    query: "politics public policy governance elections legislation world affairs",
  },
  jobs_education: {
    query: "jobs employment careers labor market education UPSC exams",
  },
  tech_it: {
    query: "technology software engineering programming cloud computing IT industry",
  },
  economy_markets: {
    query: "economy global markets stock market finance inflation interest rates",
  },
  personal_growth: {
    query: "personal development growth productivity habits success self improvement",
  },
  controversy: {
    query: "controversial debate hot takes public opinion social issues",
  },
  gn_ind_en: {
    query: "India top stories business economy policy markets",
    defaultRegion: "India",
    googleHeadlinesLimit: 8,
    signalLineCap: 24,
    sourceMixHint: "Prioritize Google News (70%) and use community signals as context (30%).",
    locale: { hl: "en-IN", gl: "IN", ceid: "IN:en" },
  },
  gn_ind_hi: {
    query: "भारत राष्ट्रीय समाचार राजनीति अर्थव्यवस्था",
    defaultRegion: "India",
    googleHeadlinesLimit: 8,
    signalLineCap: 20,
    sourceMixHint: "Prioritize Google News (75%) and use community signals mainly for sentiment/context (25%).",
    locale: { hl: "hi", gl: "IN", ceid: "IN:hi" },
  },
  gn_tn_ta: {
    query: "Tamil Nadu news jobs education governance",
    defaultRegion: "India",
    googleHeadlinesLimit: 8,
    signalLineCap: 18,
    sourceMixHint: "Prioritize regional Google headlines (70%), then add community context (30%).",
    locale: { hl: "ta", gl: "IN", ceid: "IN:ta" },
  },
  gn_apts_te: {
    query: "Andhra Pradesh Telangana news jobs economy",
    defaultRegion: "India",
    googleHeadlinesLimit: 8,
    signalLineCap: 18,
    sourceMixHint: "Prioritize AP/TS Google headlines (70%), with community signals as secondary context (30%).",
    locale: { hl: "te", gl: "IN", ceid: "IN:te" },
  },
  gn_ka_kn: {
    query: "Karnataka Bengaluru news startups IT civic",
    defaultRegion: "India",
    googleHeadlinesLimit: 7,
    signalLineCap: 24,
    sourceMixHint: "Use a near-balanced mix, slightly favoring community signals for startup/civic discussions (55% community, 45% Google).",
    locale: { hl: "kn", gl: "IN", ceid: "IN:kn" },
  },
  gn_mh_mr: {
    query: "Maharashtra Mumbai Pune news economy civic",
    defaultRegion: "India",
    googleHeadlinesLimit: 7,
    signalLineCap: 22,
    sourceMixHint: "Use a balanced mix: 60% Google regional headlines and 40% community signals.",
    locale: { hl: "mr", gl: "IN", ceid: "IN:mr" },
  },
  gn_south_en: {
    query: "South India TN Karnataka AP Telangana Kerala top stories",
    defaultRegion: "India",
    googleHeadlinesLimit: 8,
    signalLineCap: 20,
    sourceMixHint: "Prioritize curated Google headlines (70%) and use community quotes/snippets for local flavor (30%).",
    locale: { hl: "en-IN", gl: "IN", ceid: "IN:en" },
  },
  gn_nri_en: {
    query: "NRI India diaspora migration visa economy US Canada Gulf",
    googleHeadlinesLimit: 7,
    signalLineCap: 22,
    sourceMixHint: "Use Google headlines as primary source (65%) and community discussions for diaspora sentiment (35%).",
    locale: { hl: "en-US", gl: "US", ceid: "US:en" },
  },
};

function normalizeCategoryKey(category) {
  return String(category || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

function resolveAutopostCategory(category) {
  const norm = normalizeCategoryKey(category);
  return AUTOPPOST_CATEGORY_ALIASES[norm] || norm;
}

function getAutopostCategoryStrategy(category) {
  const resolved = resolveAutopostCategory(category);
  return { ...DEFAULT_AUTOPPOST_STRATEGY, ...(AUTOPPOST_CATEGORY_STRATEGY[resolved] || {}) };
}

function getSubredditsForCategory(category) {
  const normCat = resolveAutopostCategory(category);
  return CATEGORY_SUBREDDITS[normCat] || CATEGORY_SUBREDDITS[DEFAULT_CATEGORY];
}

function getSubredditsForRegionAndCategory(region, category) {
  // If Global or no region, fall back to existing behavior
  if (!region || region === "Global") {
    return getSubredditsForCategory(category);
  }

  const regionMap = REGION_SUBREDDITS[region];
  if (!regionMap) return getSubredditsForCategory(category);

  const normCat = resolveAutopostCategory(category);
  // Use region-specific subs for this category, fall back to region's startup subs
  return regionMap[normCat] || regionMap["startup"] || getSubredditsForCategory(category);
}

function isGreetingMessage(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const firstWord = normalized.split(/\s+/)[0];
  return ["hi", "hello", "hey", "yo", "sup"].includes(firstWord);
}

function buildTelegramHelpText() {
  return [
    "📋 Commands:",
    "/generate — Auto-pick a startup story and write a post",
    "/autopost <category> [region] — e.g. /autopost edtech india",
    "/post <topic> — Search latest news, pick 1–5, write a post",
    "/research <goal> — Deep research brief + post",
    "/hooks [region] [category] — Run 8-agent hook pipeline",
    "/hooktopic <topic> | <region> — Run hooks for a specific topic",
    "",
    "Autopost categories:",
    AUTOPPOST_CATEGORIES.map((category) => `• /autopost ${category}`).join("\n"),
    "",
    "After /post or /autopost: reply with numbers to choose stories. You can pick multiple: '1,3,5' or 'all'.",
    "After choosing stories: pick platform(s) for each — e.g. X, Facebook, LinkedIn (or 1/2/3). You can pick multiple: 'LinkedIn X', '1,2', 'all'.",
    "After posts are ready: reply with feedback to rewrite, SHORT <number> to shorten, IMAGE <number>/ALL for images.",
    "Translate any post: /language <code> — e.g. /language te (Telugu), /language hi (Hindi), /language ta (Tamil).",
    "Images expire in 20 min, news selection expires in 40 min."
  ].join("\n");
}

function buildAutopostCategoriesText() {
  const options = [];

  // Add all categories
  for (const cat of AUTOPPOST_CATEGORIES) {
    options.push(cat);
  }
  // Add all aliases
  const aliasKeys = Object.keys(AUTOPPOST_CATEGORY_ALIASES);
  for (const alias of aliasKeys) {
    options.push(alias);
  }

  // Build the numbered list
  const categoryLines = AUTOPPOST_CATEGORIES.map((category, idx) => {
    const num = idx + 1;
    return `${num}. /autopost ${category}`;
  }).join("\n");

  const aliasLines = aliasKeys.map((alias, idx) => {
    const num = AUTOPPOST_CATEGORIES.length + idx + 1;
    const category = AUTOPPOST_CATEGORY_ALIASES[alias];
    return `${num}. /autopost ${alias} (resolves to ${category})`;
  }).join("\n");

  const text = [
    "Autopost categories (all):",
    categoryLines,
    "",
    "Category aliases:",
    aliasLines,
    "",
    "💡 Reply with a number to run that autopost category automatically!"
  ].join("\n");

  return { text, options };
}

function buildNewsQuery(category, region = "Global") {
  return [category, region && region !== "Global" ? region : ""].filter(Boolean).join(" ").trim();
}

function inferCategoryFromTopic(topic) {
  const text = String(topic || "").toLowerCase();
  const keywordMap = [
    { category: "fintech", keywords: ["fintech", "bank", "banking", "payments", "payment", "crypto", "invest", "investing", "stock", "stocks", "finance", "financial"] },
    { category: "edtech", keywords: ["edtech", "education", "learning", "school", "student", "teacher", "course", "academy", "exam"] },
    { category: "healthcare", keywords: ["health", "healthcare", "medical", "medicine", "hospital", "doctor", "nurse", "biotech"] },
    { category: "ai", keywords: ["ai", "artificial intelligence", "openai", "gpt", "llm", "machine learning", "ml", "chatgpt", "claude", "gemini"] },
    { category: "marketing", keywords: ["marketing", "growth", "ads", "advertising", "brand", "seo", "social media", "content"] },
    { category: "current_affairs", keywords: ["politics", "election", "war", "geopolitics", "economy", "policy", "government"] },
  ];

  const match = keywordMap.find((entry) => entry.keywords.some((keyword) => text.includes(keyword)));
  return match?.category || DEFAULT_CATEGORY;
}

// ─── 3. UTILITIES & STATE ───────────────────────────────────────────────────

function loadRecentTopics() {
  try {
    if (fs.existsSync(RECENT_TOPICS_FILE)) {
      const data = JSON.parse(fs.readFileSync(RECENT_TOPICS_FILE, "utf8"));
      return Array.isArray(data) ? data.slice(0, RECENT_TOPICS_LIMIT) : [];
    }
  } catch (_) { }
  return [];
}

function saveRecentTopics(topics) {
  try {
    fs.writeFileSync(RECENT_TOPICS_FILE, JSON.stringify(topics), "utf8");
  } catch (err) {
    console.warn("⚠️ Could not save recent topics:", err.message);
  }
}

const recentTopics = loadRecentTopics();

// ─── FONT MANAGEMENT ───────────────────────────────────────────────────────

let _fontB64 = null;

async function ensureFont() {
  if (fs.existsSync(FONT_PATH)) return;
  try {
    console.log("📦 Downloading overlay font...");
    const res = await axios.get(
      "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
      { responseType: "arraybuffer", timeout: 30000 }
    );
    fs.writeFileSync(FONT_PATH, Buffer.from(res.data));
    console.log("✅ Overlay font ready.");
  } catch (err) {
    console.warn(`⚠️ Could not download font: ${err.message}. Falling back to system fonts.`);
  }
}

function getFontB64() {
  if (!_fontB64 && fs.existsSync(FONT_PATH)) {
    try {
      _fontB64 = fs.readFileSync(FONT_PATH).toString("base64");
    } catch (err) {
      console.warn(`⚠️ Could not read font file: ${err.message}`);
    }
  }
  return _fontB64;
}

function rememberTopic(topic) {
  const key = normalizeTopic(topic);
  if (!key) return;
  const idx = recentTopics.indexOf(key);
  if (idx !== -1) recentTopics.splice(idx, 1);
  recentTopics.unshift(key);
  if (recentTopics.length > RECENT_TOPICS_LIMIT) recentTopics.length = RECENT_TOPICS_LIMIT;
  saveRecentTopics(recentTopics);
}

let isProcessing = false;

function normalizeTopic(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

function randomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MULTI-TOPIC SELECTION HELPERS ───────────────────────────────────────────

function parseTopicSelection(text, maxCount) {
  const trimmed = String(text || "").trim().toLowerCase();
  if (trimmed === "all") return Array.from({ length: maxCount }, (_, i) => i);

  const indices = trimmed
    .split(/[,\s]+/)
    .map((t) => parseInt(t.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= maxCount)
    .map((n) => n - 1);

  return [...new Set(indices)]; // dedupe, preserves order
}

function formatPlatformQuestion(topicTitle, topicIndex, total) {
  return `📰 Topic ${topicIndex + 1} of ${total}:\n"${topicTitle}"\n\nWhere should I optimize this post for?\n1) X\n2) Facebook\n3) LinkedIn\n\nReply with one or more platforms (e.g. X, LinkedIn, Facebook, 1/2/3, or 'all').`;
}

function parseMultiPostCommand(text) {
  const lower = String(text || "").trim().toLowerCase();

  // "image 1" → { action: "image", index: 0 }
  // "image all" → { action: "image", all: true }
  // "rewrite 2 make it shorter" → { action: "rewrite", index: 1, feedback: "make it shorter" }
  // "short 3" → { action: "short", index: 2 }
  // "yes" → { action: "image", index: 0 } (backward compat)

  const imageMatch = lower.match(/^image\s+(\d+|all)$/);
  if (imageMatch) {
    if (imageMatch[1] === "all") return { action: "image", all: true };
    return { action: "image", index: parseInt(imageMatch[1], 10) - 1 };
  }

  const rewriteMatch = lower.match(/^rewrite\s+(\d+)\s+(.+)$/);
  if (rewriteMatch) {
    return { action: "rewrite", index: parseInt(rewriteMatch[1], 10) - 1, feedback: text.trim().slice(rewriteMatch[0].indexOf(rewriteMatch[2])) };
  }

  const shortMatch = lower.match(/^short\s+(\d+)$/);
  if (shortMatch) {
    return { action: "short", index: parseInt(shortMatch[1], 10) - 1 };
  }

  if (lower === "yes" || lower === "/yes") {
    return { action: "image", index: 0 };
  }

  return null;
}

function logStage(stage, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const clipped = text.length > 3500 ? `${text.slice(0, 3500)}\n...[truncated in logs]` : text;
  console.log(`\n===== ${stage} =====\n${clipped}\n`);
}

// ─── 4. PROMPTS BY AGENT TASK ────────────────────────────────────────────────

// AGENT 1: STORY PICKER (Analyzes signals and selects the best topic)
function buildStoryPickerPrompt(signals, source, recentTopics, category, region = "Global") {
  const recentBlock = recentTopics.length
    ? `\nAvoid repeating these recently posted topics:\n${recentTopics.join("\n")}`
    : "";

  const audienceMap = {
    startup: "operator and startup",
    edtech: "edtech and education",
    ai: "AI and tech",
    healthcare: "healthcare and healthtech",
    fintech: "fintech and finance",
    business: "business and market",
    politics_policy: "policy and current affairs",
    jobs_education: "jobs and education",
    state_city_news: "state and city news",
    tech_it: "tech and IT",
    economy_markets: "economy and market",
    south_india_digest: "South India",
    nri_diaspora: "NRI and diaspora",
    gn_ind_en: "India English general news",
    gn_ind_hi: "India Hindi general news",
    gn_tn_ta: "Tamil Nadu regional news",
    gn_apts_te: "Andhra Pradesh and Telangana regional news",
    gn_ka_kn: "Karnataka state and Bengaluru ecosystem news",
    gn_mh_mr: "Maharashtra city and state news",
    gn_south_en: "South India digest for English audience",
    gn_nri_en: "NRI and diaspora focused global India news",
  };

  const audience = audienceMap[(category || "").toLowerCase()] || "operator and startup";

  return [
    `You are a signal analyst looking for ${audience} stories worth a LinkedIn post.`,
    "",
    `REGION CONSTRAINT: You are selecting a story for a ${region} audience.`,
    region === "Global"
      ? "Any country or global story is acceptable."
      : `ONLY pick stories directly relevant to ${region}. If no signal clearly relates to ${region}, pick the one with the most relevance and note it may be global context.`,
    "",
    `From the community signals below, pick the ONE story most worth a LinkedIn post for a ${audience} audience.`,
    "",
    "Evaluate for:",
    "  → discussion potential",
    "  → identity signaling",
    "  → repostability",
    "  → \"would smart people argue about this?\"",
    "",
    "PICK stories that:",
    "  → reveal a shift in behavior, markets, or technology",
    "  → expose hidden incentives or contradictions",
    "  → create strong professional opinions",
    "  → make smart people want to discuss or repost",
    "  → contain tension, conflict, or strategic implications",
    "  → feel culturally relevant right now",
    "",
    "Strong examples:",
    "  → AI replacing workflows",
    "  → startup pivots",
    "  → consumer backlash",
    "  → fintech infrastructure shifts",
    "  → controversial product decisions",
    "  → creator economy changes",
    "  → internet-driven brand crises",
    "",
    "Weak examples:",
    "  → discounts",
    "  → generic product launches",
    "  → low-emotion announcements",
    "  → feature updates without implications",
    "  → informational news with no discussion angle",
    "",
    "REJECT anything that is:",
    "  ❌ A minor patch, config tweak, or irrelevant story",
    "  ❌ A meta-post, hiring thread, weekly recap, or off-topic HN story",
    "  ❌ Vague or unverifiable without a primary source",
    recentBlock,
    "",
    `Sources: ${source}`,
    "Community signals:",
    signals,
    "",
    "Output EXACTLY one line: the story topic you chose. No explanation, no preamble.",
    "If nothing qualifies, output exactly: SKIP",
  ].join("\n");
}

function buildAutopostTopStoriesPrompt(
  liveSignals,
  googleHeadlines,
  source,
  recentTopics,
  category,
  region = "Global",
  sourceMixHint = DEFAULT_AUTOPPOST_STRATEGY.sourceMixHint
) {
  const recentBlock = recentTopics.length
    ? `Avoid repeating these recently posted topics:\n${recentTopics.join("\n")}`
    : "";

  const audienceMap = {
    startup: "startup and operator",
    edtech: "edtech and education",
    ai: "AI and tech",
    healthcare: "healthcare and healthtech",
    fintech: "fintech and finance",
    marketing: "marketing and growth",
    business: "business and market",
    politics_policy: "policy and current affairs",
    jobs_education: "jobs and education",
    state_city_news: "state and city news",
    tech_it: "tech and IT",
    economy_markets: "economy and market",
    south_india_digest: "South India",
    nri_diaspora: "NRI and diaspora",
    gn_ind_en: "India English general news",
    gn_ind_hi: "India Hindi general news",
    gn_tn_ta: "Tamil Nadu regional news",
    gn_apts_te: "Andhra Pradesh and Telangana regional news",
    gn_ka_kn: "Karnataka state and Bengaluru ecosystem news",
    gn_mh_mr: "Maharashtra city and state news",
    gn_south_en: "South India digest for English audience",
    gn_nri_en: "NRI and diaspora focused global India news",
  };

  const audience = audienceMap[(category || "").toLowerCase()] || "operator and startup";

  const googleBlock = googleHeadlines.length
    ? googleHeadlines.map((item, index) => `${index + 1}. ${item.title} — ${item.source}`).join("\n")
    : "(No Google News headlines found)";

  return [
    `You are a news curator selecting the TOP 5 story candidates for a ${audience} LinkedIn post.`,
    "",
    `REGION CONSTRAINT: prioritize stories for ${region}.`,
    region === "Global"
      ? "Global stories are allowed."
      : `If a story is not directly tied to ${region}, only include it if it clearly matters to that audience.`,
    "",
    "Use BOTH inputs below: live community signals and Google News headlines.",
    `SOURCE MIX TARGET: ${sourceMixHint}`,
    "Rank them by discussion potential, relevance, recency, and repostability.",
    "Do not output duplicates or near-duplicates.",
    recentBlock,
    "",
    `Sources: ${source}`,
    "",
    "LIVE COMMUNITY SIGNALS:",
    liveSignals,
    "",
    "GOOGLE NEWS HEADLINES:",
    googleBlock,
    "",
    "Output ONLY a JSON array of exactly 5 objects. No markdown. No preamble. No explanation.",
    "Schema for each object:",
    '{ "title": "...", "source": "...", "reason": "..." }',
    "Keep titles concise and news-like."
  ].join("\n");
}

// ─── AGENT STYLES ──────────────────────────────────────────────────────────

const POST_STYLES = [
  "Sharp observation → implication",
  "Contrarian insight → explanation",
  "Internet behavior → business lesson",
  "Specific event → hidden market shift",
  "Simple statement → uncomfortable implication",
  "Product/company decision → strategic insight",
  "Cultural trend → operator observation",
  "Short analytical breakdown",
  "One surprising realization carried to conclusion",
  "Consumer behavior decoded",
  "Calm operator commentary",
  "Quietly pessimistic industry observation"
];

function getRandomStyle() {
  return POST_STYLES[Math.floor(Math.random() * POST_STYLES.length)];
}

// AGENT 2: POST WRITER (Writes a high-impact post from a chosen story)
function buildPostWriterPrompt(chosenStory) {
  const style = getRandomStyle();
  return [
    `Write a high-impact LinkedIn post about this topic: ${chosenStory}`,
    "",
    `STYLE CONSTRAINT: You MUST write in this specific style: ${style}`,
    "",
    "Rules:",
    "Topic ≠ Post",
    "Turn the topic into a specific moment, NOT a general idea.",
    "LANGUAGE: Use simple, easy-to-understand English. Avoid complex jargon and keep sentences clear and straightforward.",
    "",
    "VOICE:",
    "Write like an intelligent operator reacting to something interesting happening in business, tech, or culture.",
    "NOT: motivational speaker, startup guru, productivity influencer, consultant, corporate brand account",
    "The tone should feel: observant, grounded, concise, slightly opinionated, internet-aware, emotionally believable.",
    "",
    "TRUTH CONSTRAINT:",
    "- Do NOT fabricate: personal stories, calls, meetings, customer conversations, statistics, revenue numbers, timelines, unless explicitly provided in source material.",
    "- Do NOT manufacture drama.",
    "- Only use concrete details explicitly present in source material.",
    "",
    "SINGLE NARRATIVE THREAD:",
    "- Stick to ONE company, ONE event, or ONE situation.",
    "- Do NOT merge multiple unrelated stories into one post.",
    "",
    "Avoid predictable structure",
    "Vary post length based on the topic:",
    "- very short (30-50 words)",
    "- medium (80-120 words)",
    "- slightly longer if needed (150-250 words)",
    "DO NOT exceed 300 words.",
    "",
    "Vary rhythm:",
    "Do NOT use multiple empty lines between paragraphs.",
    "Keep spacing tight and professional. One empty line between sections is the maximum.",
    "",
    "Formatting:",
    "Do NOT use 'broetry' style (one sentence per line with double spacing).",
    "",
    "Ban generic writing:",
    "No “Here are 5 tips”",
    "No “In today’s world”",
    "No “Businesses should”",
    "Avoid: 'This is huge', 'Game changer', 'Let that sink in', 'The future belongs to', 'I realized something', 'This says a lot about'",
    "",
    "KILL GENERIC ENDINGS:",
    "- Avoid philosophical closing lines about 'the world' or 'innovation'.",
    "- End with a sharp realization, an unresolved tension, or a specific thought.",
    "",
    "",
    "Make it feel real:",
    "Include slightly uncomfortable or honest lines when relevant",
    "",
    "Hook:",
    "First line must create curiosity, tension, or contrast",
    "But vary the style of hook (question, statement, contradiction, etc.)",
    "",
    "The best posts sound like: 'Someone smart noticed something important before everyone else did.'",
    "",
    "Output:",
    "Plain text only",
    "No emojis",
    "No hashtags",
    "No explanations",
    "Only the post"
  ].join("\n");
}

// AGENT 3: TOPIC POST WRITER (Writes a post from a user-provided topic without signals)
function buildTopicPostPrompt(topic) {
  const style = getRandomStyle();
  return [
    `Write a high-impact LinkedIn post about this topic: ${topic}`,
    "",
    `STYLE CONSTRAINT: You MUST write in this specific style: ${style}`,
    "",
    "Rules:",
    "Topic ≠ Post",
    "Turn the topic into a specific moment, NOT a general idea.",
    "LANGUAGE: Use simple, clear, and easy-to-understand English. Avoid heavy jargon.",
    "",
    "VOICE:",
    "Write like an intelligent operator reacting to something interesting happening in business, tech, or culture.",
    "NOT: motivational speaker, startup guru, productivity influencer, consultant, corporate brand account",
    "The tone should feel: observant, grounded, concise, slightly opinionated, internet-aware, emotionally believable.",
    "",
    "TRUTH CONSTRAINT:",
    "- Do NOT fabricate: personal stories, calls, meetings, customer conversations, statistics, revenue numbers, timelines, unless explicitly provided in source material.",
    "- Do NOT manufacture drama.",
    "- Only use concrete details explicitly present in source material.",
    "",
    "Avoid predictable structure",
    "Vary post length based on the topic:",
    "- very short (30-50 words)",
    "- medium (80-120 words)",
    "- slightly longer if needed (150-250 words)",
    "DO NOT exceed 300 words.",
    "",
    "Vary rhythm:",
    "Mix short punchy lines with occasional longer ones",
    "",
    "Formatting:",
    "Do NOT follow a fixed pattern. Vary line breaks and density.",
    "",
    "KILL GENERIC ENDINGS:",
    "- End with a sharp realization, an unresolved tension, or a specific thought.",
    "",
    "The best posts sound like: 'Someone smart noticed something important before everyone else did.'",
    "",
    "Output:",
    "Plain text only",
    "No emojis",
    "No hashtags",
    "No explanations",
    "Only the post"
  ].join("\n");
}

// AGENT 4: SIGNAL CLEANER (Removes noise and meta-posts from raw signals)
function buildSignalCleanerPrompt(signals) {
  return [
    "You are a noise-reduction specialist for a social media pipeline.",
    "",
    "Raw signals from Reddit and Hacker News follow. CLEAN them by:",
    "1. Removing all meta-posts (e.g., 'Welcome to r/fintech', 'Rules of the sub', 'AMA reminder').",
    "2. Removing generic threads (e.g., 'Weekly Hiring Thread', 'Self-promotion megathread').",
    "3. Removing obvious ads or spam.",
    "4. Grouping identical stories into one entry.",
    "",
    "Raw signals:",
    signals,
    "",
    "Output only the cleaned list of headlines, one per line. No introduction."
  ].join("\n");
}

// AGENT 5: HIDDEN IMPLICATION EXTRACTOR (Extracts the underlying shift from a story)
function buildHiddenImplicationExtractorPrompt(chosenStory) {
  return [
    "You are a deep-dive analyst.",
    "",
    `Topic: ${chosenStory}`,
    "",
    "Task: Extract the hidden business implication behind this story.",
    "",
    "Focus on:",
    "- incentive shifts",
    "- market dynamics",
    "- user behavior",
    "- strategic risks",
    "- operational realities",
    "- changing expectations",
    "",
    "Avoid motivational framing.",
    "Avoid therapy language.",
    "",
    "Output exactly one sharp observation. No intro."
  ].join("\n");
}

function buildDiscussionAnglePrompt(chosenStory, hiddenShift) {
  return [
    "Before writing the post, evaluate:",
    "Does this topic create natural disagreement?",
    "Does it reveal a hidden shift?",
    "Does it affect how people work/build/invest?",
    "Would someone repost this to signal intelligence or awareness?",
    "Does it contain emotional or strategic tension?",
    "",
    `Topic: ${chosenStory}`,
    `Hidden Shift: ${hiddenShift}`,
    "",
    "If NO to most:",
    "Output SKIP",
    "",
    "If YES:",
    "Output the primary discussion angle in one sharp sentence."
  ].join("\n");
}

// AGENT 6 (new): ARGUMENT ARCHITECT (Converts implication insight into a JSON content blueprint)
function buildArgumentArchitectSystemPrompt() {
  return [
    "You are a narrative architect. You receive a raw insight about a business topic and convert it into a structured content blueprint. Do not write any LinkedIn post. Only output a JSON object and nothing else — no preamble, no markdown backticks.",
    "",
    "Output format:",
    "{",
    '  "hook_type": "curiosity | contrarian | blunt",',
    '  "core_claim": "...",',
    '  "supporting_point": "...",',
    '  "specific_detail": "...",',
    '  "emotional_trigger": "...",',
    '  "ending_style": "open_loop | punchline | reflection"',
    "}"
  ].join("\n");
}

// AGENT 7 (new): DRAFT CRITIC (Diagnoses weaknesses in Draft 1 — does NOT rewrite)
function buildDraftCriticSystemPrompt() {
  return [
    "You are a brutally honest LinkedIn content critic. Your job is to diagnose weaknesses in a draft post written for operators. Do not rewrite the post. Only output a JSON object and nothing else — no preamble, no markdown backticks.",
    "",
    "Output format:",
    "{",
    '  "hook_strength": <1-10>,',
    '  "clarity_issues": ["..."],',
    '  "generic_phrases": ["..."],',
    '  "emotional_flatness": "...",',
    '  "specificity_score": <1-10>,',
    '  "rewrite_instructions": [',
    '    "...",',
    '    "..."',
    '  ]',
    "}",
    "",
    "Automatically penalize:",
    "- fake personal anecdotes",
    "- invented precision",
    "- synthetic emotional tension",
    "- vague inspiration",
    "- repetitive sentence rhythm",
    "- 'AI motivational cadence'",
    "- corporate-blog tone",
    "- generic founder advice",
    "",
    "Prefer:",
    "- specificity",
    "- tension",
    "- realism",
    "- concise observations",
    "- internet-native language"
  ].join("\n");
}

// AGENT 8: POST POLISHER (Final pass for rhythm and flow)
function buildPostPolisherPrompt(post) {
  return [
    "You are a world-class editor. You polish LinkedIn posts to perfection.",
    "",
    "Draft:",
    post,
    "",
    "Rules for Polishing:",
    "- TIGHTEN the spacing. Ensure there are no double-empty lines.",
    "- Ensure the hook is absolutely arresting.",
    "- REMOVE any remaining AI-isms (e.g., 'In the fast-paced world', 'It's more than just').",
    "- SIMPLIFY the language. Make sure the English is easy to understand, clear, and accessible.",
    "- KILL GENERIC ENDINGS: If it ends with a broad statement about the future or industry, rewrite it to be sharp and unresolved.",
    "- STICK to the 'Operator Voice' (observant, grounded, concise, slightly opinionated).",
    "- Output ONLY the raw post text. No intro, no explanation."
  ].join("\n");
}

// AGENT 9 (new): SHORT AND CRISP POLISHER
function buildShortCrispPrompt(post) {
  return [
    "You are a LinkedIn content refiner.",
    "",
    "Original Post:",
    post,
    "",
    "Your task is to rewrite the post to make it short and crisp. Make it highly user friendly, based on pointers.",
    "CRITICAL: Do NOT lose the essence or core message of the original post.",
    "Add more emotional hook lines (creek lines) to draw the reader in.",
    "",
    "Rules:",
    "- Keep the exact same insight and primary message.",
    "- Use sharp, emotional pointers.",
    "- Output ONLY the rewritten post. No introduction, no explanation."
  ].join("\n");
}

// FEEDBACK REWRITER: Rewrites a post based on user feedback
function buildFeedbackRewritePrompt(post, feedback) {
  return [
    "You are a LinkedIn content editor. Rewrite the post below based on the user's feedback.",
    "",
    "Original Post:",
    post,
    "",
    "User Feedback / Pointers:",
    feedback,
    "",
    "Instructions:",
    "- Apply the user's feedback precisely while keeping the post's core insight and message intact.",
    "- Do NOT add fake statistics, personal anecdotes, or fabricated details.",
    "- Maintain the operator voice: observant, grounded, concise, slightly opinionated.",
    "- Keep the same general length (don't make it dramatically shorter or longer unless asked).",
    "- Output ONLY the rewritten post. No introduction, no explanation, no markdown formatting."
  ].join("\n");
}

// AGENT 7: IMAGE CONCEPT STRATEGIST (Designs viral visuals for posts)
function buildImageConceptPrompt(topic, post) {
  const styles = [
    "EDITORIAL MAGAZINE COVER (Clean, striking, professional photography)",
    "STARTUP VISUAL ESSAY (Minimalist, structured, data-driven feel)",
    "BRUTALIST DESIGN (Bold typography, high contrast, raw unpolished aesthetic)",
    "MINIMALIST DIAGRAM (Clean lines, geometric, conceptual clarity)",
    "PRODUCT-FOCUSED COMPOSITION (Sleek, close-up, premium tech feel)",
    "DOCUMENTARY-STYLE REALISM (Gritty, authentic, unfiltered office or street scene)",
    "MODERNIST ABSTRACT (Simple shapes, depth, light-vs-dark, professional mystery)",
    "NORDIC / CLEAN (Soft light, cold tones, high-end professional atmosphere)"
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  return [
    "You are a Viral Poster Agent. Design a UNIQUE, high-impact LinkedIn infographic poster concept.",
    "",
    `MANDATORY ART STYLE: ${style}`,
    "",
    `TOPIC: ${topic}`,
    `POST CONTENT: ${post}`,
    "",
    "IMPORTANT VISUAL RULES:",
    "- scene: Clean, editorial, or documentary-style visual that represents the post topic without sci-fi overload.",
    "- metaphor: Keep it grounded. Use realistic or minimalist metaphors. DO NOT use epic cinematic glowing portals or oversaturated cyberpunk scenes.",
    "- detail: Make the environment professional and striking (e.g., minimalist office elements, abstract geometric shapes, high-end editorial photography).",
    "- composition: Strong central subject, clear negative space at the top and bottom for text overlay.",
    "- lighting: Natural, editorial, or studio lighting. Avoid excessive neon or volumetric fog.",
    "IMPORTANT:",
    "- NO TEXT, no typography, no letters, no words, no UI panels, no floating labels.",
    "- The image must be a text-free, highly detailed background artwork.",
    "- no over-designed poster elements",
    "",
    "IMPORTANT TEXT OVERLAY RULES (Golden Rule: Image = Emotion, Text = Message):",
    "Generate structured text blocks for the poster layout:",
    "- hook: Big Hook for the top (e.g. 'KPMG JUST SAID IT OUT LOUD')",
    "- number: Core Claim for the middle (e.g. '2-3 YEARS')",
    "- contrast: Subtext or contrast to support the number (e.g. 'OF JOB LEFT')",
    "- cta: Call to action for the bottom (e.g. 'CHOOSE YOUR CAREER WISELY')",
    "",
    "Return ONLY valid JSON in exactly this shape:",
    '{"hook":"...","number":"...","contrast":"...","cta":"...","visual":"..."}',
    "",
    "No markdown. No code fences. JSON only."
  ].join("\n");
}

async function callImageAPI(prompt) {
  if (OPENAI_API_KEY) {
    try {
      console.log(`🎨 Calling OpenAI image model (${OPENAI_IMAGE_MODEL})...`);
      const response = await axios.post(
        "https://api.openai.com/v1/images/generations",
        {
          model: OPENAI_IMAGE_MODEL,
          prompt: `${prompt}, no text, no letters, no typography, no logo, no watermark`,
          size: OPENAI_IMAGE_SIZE,
          quality: "standard",
          n: 1
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 120000
        }
      );

      const imageData = response.data?.data?.[0] || {};
      if (imageData.url) return imageData.url;

      if (imageData.b64_json) {
        const outputPath = path.join(os.tmpdir(), `openai-image-${Date.now()}.png`);
        fs.writeFileSync(outputPath, Buffer.from(imageData.b64_json, "base64"));
        return outputPath;
      }

      throw new Error("OpenAI image response did not include a usable image");
    } catch (err) {
      console.warn(`⚠️ OpenAI image generation failed, falling back to Pollinations: ${err.message}`);
    }
  }

  console.log("🎨 Calling Pollinations.ai for image...");
  const safePrompt = `${prompt}, no text, no letters, no typography, no logo, no watermark`;
  const cleanedPrompt = encodeURIComponent(safePrompt.replace(/[\n\r]/g, " ").trim());
  const seed = Math.floor(Math.random() * 1000000);
  return `https://image.pollinations.ai/prompt/${cleanedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;
}



function extractFirstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
}

function extractFirstJsonArray(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) { }

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeImageConcept(rawConcept, topic) {
  const parsed = extractFirstJsonObject(rawConcept) || {};

  const hook = String(parsed.hook || "INDUSTRY REALITY CHECK").replace(/\s+/g, " ").trim().slice(0, 100).toUpperCase();
  const number = String(parsed.number || "").replace(/\s+/g, " ").trim().slice(0, 40).toUpperCase();
  const contrast = String(parsed.contrast || "").replace(/\s+/g, " ").trim().slice(0, 80).toUpperCase();
  const cta = String(parsed.cta || "CHOOSE WISELY").replace(/\s+/g, " ").trim().slice(0, 60).toUpperCase();
  const visual = String(parsed.visual || `cinematic editorial portrait background, moody lighting, shallow depth of field, startup office atmosphere, no text elements`).replace(/\s+/g, " ").trim();

  return { hook, number, contrast, cta, visual };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function estimateTextWidth(text, fontSize, widthFactor = 0.56) {
  return String(text || "").length * fontSize * widthFactor;
}

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getHighlightTerms(highlight, headline) {
  // Deprecated, removed for layout engine
  return [];
}

function pickFallbackHighlightTerm(lines) {
  // Deprecated, removed for layout engine
  return "";
}

function getHighlightMode() {
  // Deprecated, removed for layout engine
  return "single_word";
}

function generatePangoMarkup(imageConcept, headlineSize, subtextSize, isShadow = false) {
  // Deprecated, removed for layout engine
  return "";
}

async function renderImageWithText(backgroundImageUrl, imageConcept) {
  const response = await axios.get(backgroundImageUrl, {
    responseType: "arraybuffer",
    timeout: 45000,
  });

  const background = Buffer.from(response.data);
  const metadata = await sharp(background).metadata();
  const width = metadata.width || 1024;
  const height = metadata.height || 1024;

  const textWidth = Math.round(width * 0.92);
  const shadowOffset = Math.max(2, Math.round(width * 0.005));

  async function createTextBuffer(text, fontSize, color, isShadow) {
    if (!text) return null;
    const escaped = escapeXml(text);
    const textColor = isShadow ? "black" : color;
    const markup = `<span font="Anton ${fontSize}" letter_spacing="-1024" foreground="${textColor}">${escaped}</span>`;
    return sharp({
      text: {
        text: markup,
        width: textWidth,
        align: 'center',
        rgba: true,
        fontfile: FONT_PATH
      }
    }).png().toBuffer();
  }

  // 1. RANDOM SIZE SCALE
  const headlineScale = [0.055, 0.06, 0.065];
  const scale = headlineScale[Math.floor(Math.random() * headlineScale.length)];

  const hookSize = Math.round(width * (scale * 1.2));
  const numberSize = Math.round(width * (scale * 2.2));
  const contrastSize = Math.round(width * (scale * 0.9));
  const ctaSize = Math.round(width * (scale * 0.75));

  // 2. RANDOM COLOR PALETTE
  const palettes = [
    ["#fbbf24", "#ffffff"], // gold + white
    ["#3b82f6", "#ffffff"], // electric blue + white
    ["#10b981", "#ffffff"], // emerald green + white
    ["#ec4899", "#ffffff"], // neon pink + white
    ["#8b5cf6", "#ffffff"], // cyber purple + white
    ["#ef4444", "#ffffff"], // bold red + white
    ["#06b6d4", "#ffffff"], // cyan + white
    ["#f97316", "#ffffff"], // intense orange + white
  ];
  const [highlightColor, textColor] = palettes[Math.floor(Math.random() * palettes.length)];

  const hookBuf = await createTextBuffer(imageConcept.hook, hookSize, textColor, false);
  const hookShadow = await createTextBuffer(imageConcept.hook, hookSize, textColor, true);

  const numberBuf = await createTextBuffer(imageConcept.number, numberSize, highlightColor, false);
  const numberShadow = await createTextBuffer(imageConcept.number, numberSize, highlightColor, true);

  const contrastBuf = await createTextBuffer(imageConcept.contrast, contrastSize, textColor, false);
  const contrastShadow = await createTextBuffer(imageConcept.contrast, contrastSize, textColor, true);

  const ctaBuf = await createTextBuffer(imageConcept.cta, ctaSize, highlightColor, false);
  const ctaShadow = await createTextBuffer(imageConcept.cta, ctaSize, highlightColor, true);

  const hookMeta = hookBuf ? await sharp(hookBuf).metadata() : { height: 0, width: 0 };
  const numberMeta = numberBuf ? await sharp(numberBuf).metadata() : { height: 0, width: 0 };
  const contrastMeta = contrastBuf ? await sharp(contrastBuf).metadata() : { height: 0, width: 0 };
  const ctaMeta = ctaBuf ? await sharp(ctaBuf).metadata() : { height: 0, width: 0 };

  const gap = Math.round(height * 0.015);

  // Calculate total block height
  let totalHeight = 0;
  if (hookBuf) totalHeight += hookMeta.height + gap;
  if (numberBuf) totalHeight += numberMeta.height + gap;
  if (contrastBuf) totalHeight += contrastMeta.height + gap;
  if (ctaBuf) totalHeight += ctaMeta.height + gap;
  if (totalHeight > 0) totalHeight -= gap; // remove last gap

  // 3. RANDOM POSITION LOGIC (top, center, bottom)
  const positions = ["bottom", "center", "top"];
  const position = positions[Math.floor(Math.random() * positions.length)];

  const paddingY = Math.round(height * 0.08);

  let startY;
  if (position === "bottom") {
    startY = height - totalHeight - paddingY;
  } else if (position === "center") {
    startY = Math.round((height - totalHeight) / 2);
  } else {
    startY = paddingY;
  }

  const composites = [];

  let gradientSvg = "";
  if (position === "bottom") {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="30%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.85)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>
</svg>`;
  } else if (position === "top") {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.85)"/>
      <stop offset="70%" stop-color="rgba(0,0,0,0)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>
</svg>`;
  } else {
    gradientSvg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.4)"/>
</svg>`;
  }

  composites.push({ input: Buffer.from(gradientSvg), top: 0, left: 0 });

  let currentY = startY;
  const elements = [];

  if (hookBuf) {
    elements.push({ buf: hookBuf, shadow: hookShadow, y: currentY, meta: hookMeta });
    currentY += hookMeta.height + gap;
  }
  if (numberBuf) {
    elements.push({ buf: numberBuf, shadow: numberShadow, y: currentY, meta: numberMeta });
    currentY += numberMeta.height + gap;
  }
  if (contrastBuf) {
    elements.push({ buf: contrastBuf, shadow: contrastShadow, y: currentY, meta: contrastMeta });
    currentY += contrastMeta.height + gap;
  }
  if (ctaBuf) {
    elements.push({ buf: ctaBuf, shadow: ctaShadow, y: currentY, meta: ctaMeta });
  }

  for (const el of elements) {
    const left = Math.round((width - (el.meta.width || textWidth)) / 2);
    composites.push({ input: el.shadow, top: el.y + shadowOffset, left: left + shadowOffset });
    composites.push({ input: el.buf, top: el.y, left: left });
  }

  const outputPath = path.join(os.tmpdir(), `shoro-render-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);

  await sharp(background)
    .composite(composites)
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);

  return outputPath;
}

function imageConceptToText(imageConcept) {
  return [
    `Hook: ${imageConcept.hook}`,
    `Number: ${imageConcept.number || "-"}`,
    `Contrast: ${imageConcept.contrast || "-"}`,
    `CTA: ${imageConcept.cta || "-"}`,
    `Visual: ${imageConcept.visual}`,
  ].join("\n");
}

// ─── 5. DATA FETCHING (Reddit & Hacker News) ────────────────────────────────

const REDDIT_HEADERS_BASE = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

async function fetchRedditSubOnce(sub, baseHost, type = "hot") {
  const url = `https://${baseHost}/r/${sub}/${type}.json?limit=10&raw_json=1`;
  const res = await axios.get(url, {
    headers: { ...REDDIT_HEADERS_BASE, "User-Agent": randomAgent() },
    timeout: 12000,
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200 || !res.data?.data?.children) return [];
  return res.data.data.children
    .map((p) => p?.data?.title)
    .filter((t) => t && t.length > 20 && t.length < 200)
    .slice(0, 8)
    .map((t) => `[r/${sub} ${type}] ${t}`);
}

async function fetchRedditTrends(category, region = "Global") {
  const allTitles = [];
  const subs = getSubredditsForRegionAndCategory(region, category);

  for (const sub of subs) {
    try {
      // Try both HOT and NEW for each sub
      for (const type of ["hot", "new"]) {
        let batch = [];
        try {
          batch = await fetchRedditSubOnce(sub, "www.reddit.com", type);
        } catch (e) {
          try {
            batch = await fetchRedditSubOnce(sub, "api.reddit.com", type);
          } catch (e2) {
            try {
              batch = await fetchRedditSubOnce(sub, "old.reddit.com", type);
            } catch (e3) {
              console.warn(`Reddit r/${sub} ${type} failed all hosts.`);
            }
          }
        }
        allTitles.push(...batch);
      }
    } catch (err) {
      console.warn(`Reddit r/${sub} processing failed: ${err.message}`);
    }
    await sleep(350);
  }
  if (allTitles.length < 3) return null;
  console.log(`✅ Reddit: fetched ${allTitles.length} titles across ${subs.length} subs (${category || DEFAULT_CATEGORY})`);
  return allTitles.slice(0, 35).join("\n");
}

async function fetchHNTrends() {
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const [askRes, storyRes] = await Promise.all([
      axios.get("https://hn.algolia.com/api/v1/search_by_date", {
        params: {
          tags: "ask_hn",
          hitsPerPage: 10,
          numericFilters: `points>10,created_at_i>${sevenDaysAgo}`,
        },
        headers: { "User-Agent": randomAgent() },
        timeout: 10000,
      }),
      axios.get("https://hn.algolia.com/api/v1/search_by_date", {
        params: {
          tags: "story",
          hitsPerPage: 8,
          numericFilters: `points>30,created_at_i>${sevenDaysAgo}`,
        },
        headers: { "User-Agent": randomAgent() },
        timeout: 10000,
      }),
    ]);

    const askTitles = (askRes?.data?.hits || [])
      .map((h) => h.title)
      .filter((t) => t && t.length > 15)
      .slice(0, 6)
      .map((t) => `[HN Ask] ${t}`);

    const storyTitles = (storyRes?.data?.hits || [])
      .map((h) => h.title)
      .filter((t) => t && t.length > 15)
      .slice(0, 5)
      .map((t) => `[HN] ${t}`);

    const titles = [...askTitles, ...storyTitles];
    if (titles.length < 2) return null;
    console.log(`✅ HN: fetched ${titles.length} titles`);
    return titles.join("\n");
  } catch (err) {
    console.warn(`HN fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchRSSFeed(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": randomAgent(),
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      timeout: 12000,
      validateStatus: (s) => s < 500,
    });

    const xml = res.data || "";

    // Extract <title> tags from RSS items — works for RSS 2.0 and Atom
    const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) ||
      xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];

    const titles = itemMatches
      .map(item => {
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        return titleMatch ? titleMatch[1].trim() : null;
      })
      .filter(t => t && t.length > 15 && t.length < 200)
      .slice(0, 8);

    if (titles.length === 0) return null;

    const domain = new URL(url).hostname.replace("www.", "");
    return titles.map(t => `[${domain}] ${t}`).join("\n");
  } catch (err) {
    console.warn(`⚠️ RSS fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchRegionRSSFeeds(region) {
  const feeds = REGION_RSS_FEEDS[region] || [];
  if (feeds.length === 0) return null;

  const results = await Promise.allSettled(feeds.map(url => fetchRSSFeed(url)));
  const parts = results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);

  if (parts.length === 0) return null;
  console.log(`✅ RSS: fetched ${parts.length} feeds for region ${region}`);
  return parts.join("\n");
}

async function fetchLiveSignals(category, region = "Global") {
  const [reddit, hn, rss] = await Promise.allSettled([
    fetchRedditTrends(category, region),
    fetchHNTrends(),
    fetchRegionRSSFeeds(region),
  ]);

  const parts = [];
  const sources = [];

  if (reddit.status === "fulfilled" && reddit.value) {
    parts.push(reddit.value);
    const subs = getSubredditsForRegionAndCategory(region, category);
    sources.push("Reddit(" + subs.map((s) => `r/${s}`).join(",") + ")");
  }
  const hnCompatible = [
    "startup",
    "ai",
    "tech_it",
    "business",
    "fintech",
    "jobs_education",
    "economy_markets"
  ].includes(category);

  if (hn.status === "fulfilled" && hn.value && region === "Global" && hnCompatible) {
    // HN is US/global-heavy — only include for Global and tech/business categories
    parts.push(hn.value);
    sources.push("Hacker News");
  }
  if (rss.status === "fulfilled" && rss.value) {
    parts.push(rss.value);
    sources.push(`RSS(${region})`);
  }

  if (parts.length === 0) return { data: null, source: "none" };
  return { data: parts.join("\n"), source: sources.join(" + ") };
}

// ─── TOPIC HEADLINE SEARCH (Google News RSS — no API key required) ────────────

async function fetchTopicHeadlines(topic, options = {}) {
  const {
    limit = 5,
    hl = "en-US",
    gl = "US",
    ceid = "US:en",
  } = options;

  const query = encodeURIComponent(topic);
  const url = `https://news.google.com/rss/search?q=${query}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;

  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": randomAgent(),
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });

    const xml = res.data || "";

    // Extract <item> blocks
    const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

    const headlines = [];
    for (const item of itemMatches) {
      if (headlines.length >= limit) break;

      // Extract title (strip CDATA if present)
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const rawTitle = titleMatch ? titleMatch[1].trim() : null;
      if (!rawTitle || rawTitle.length < 10) continue;

      // Strip HTML entities
      const title = rawTitle
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      // Extract source name
      const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      const source = sourceMatch ? sourceMatch[1].trim() : "News";

      // Extract URL
      const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
      const url = linkMatch ? linkMatch[1].trim() : "";

      headlines.push({ title, source, url });
    }

    return headlines;
  } catch (err) {
    console.warn(`⚠️ [topic-headlines] Google News fetch failed: ${err.message}`);
    return [];
  }
}

async function fetchAutopostTopStories(category, region = "Global", queryText = category) {
  const resolvedCategory = resolveAutopostCategory(category);
  const strategy = getAutopostCategoryStrategy(resolvedCategory);
  const effectiveRegion = (region === "Global" && strategy.defaultRegion) ? strategy.defaultRegion : region;
  const effectiveQuery = queryText && queryText !== category
    ? queryText
    : strategy.query || buildNewsQuery(resolvedCategory, effectiveRegion);

  const [liveSignalsResult, googleHeadlines] = await Promise.all([
    fetchLiveSignals(resolvedCategory, effectiveRegion),
    fetchTopicHeadlines(effectiveQuery, {
      limit: strategy.googleHeadlinesLimit,
      hl: strategy.locale?.hl,
      gl: strategy.locale?.gl,
      ceid: strategy.locale?.ceid,
    }),
  ]);

  if (!liveSignalsResult?.data && (!googleHeadlines || googleHeadlines.length === 0)) {
    return { stories: [], source: "none" };
  }

  const weightedSignals = limitSignalLines(liveSignalsResult?.data || "", strategy.signalLineCap);

  const cleanedSignals = weightedSignals
    ? await callDirectWithRetry(buildSignalCleanerPrompt(weightedSignals), "autopost-signal-cleaner")
    : "";

  const pickerPrompt = buildAutopostTopStoriesPrompt(
    cleanedSignals || weightedSignals || "",
    googleHeadlines || [],
    liveSignalsResult?.source || "none",
    recentTopics,
    resolvedCategory,
    effectiveRegion,
    strategy.sourceMixHint
  );

  const raw = await callDirectWithRetry(pickerPrompt, "autopost-top-story-picker");
  const parsed = extractFirstJsonArray(raw);

  if (!parsed) {
    return { stories: [], source: liveSignalsResult?.source || "none" };
  }

  const stories = parsed
    .map((item) => ({
      title: String(item?.title || "").trim(),
      source: String(item?.source || "").trim() || "News",
      reason: String(item?.reason || "").trim(),
    }))
    .filter((item) => item.title)
    .slice(0, 5);

  return {
    stories,
    source: liveSignalsResult?.source || "none",
  };
}



function isTransient(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  const code = (err?.code || "").toLowerCase();

  const keywords = [
    "503",
    "no healthy upstream",
    "provider returned error",
    "gateway timeout",
    "timed out",
    "timeout",
    "operation was aborted",
    "aborted",
    "cancel",
    "econnreset",
    "econnaborted",
    "err_canceled",
    "err_bad_gateway",
    "err_network",
    "response payload was empty",
    "returned no json payload",
    "socket hang up",
    "rate limit",
    "too many requests",
  ];

  return keywords.some(k => msg.includes(k) || code.includes(k));
}

function limitSignalLines(text, maxLines) {
  if (!text || !Number.isFinite(maxLines) || maxLines <= 0) return text || "";
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, maxLines).join("\n");
}

async function callOpenRouterDirect(prompt) {
  if (!OR_API_KEY) throw new Error("OPENROUTER_API_KEY not set.");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OR_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.85,
    },
    {
      headers: {
        Authorization: `Bearer ${OR_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://shoro-bot.local",
        "X-Title": "Shoro Bot",
      },
      timeout: 180000,
    }
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned empty content");
  return text.trim();
}

/**
 * callOpenRouterWithModel — sends a system+user message pair to a specific model.
 * Used by Argument Architect (gpt-4o) and Draft Critic (claude-3.7-sonnet).
 */
async function callOpenRouterWithModel(model, systemPrompt, userMessage) {
  if (!OR_API_KEY) throw new Error("OPENROUTER_API_KEY not set.");
  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${OR_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://shoro-bot.local",
        "X-Title": "Shoro Bot",
      },
      timeout: 180000,
    }
  );
  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter (${model}) returned empty content`);
  return text.trim();
}

// const OPENCLAW_MAIN = "C:\\Users\\BIT\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";

// LLM-powered post translator
async function translatePostWithLLM(rawPost, targetLanguage) {
  const langMap = {
    te: "Telugu",
    hi: "Hindi",
    ta: "Tamil",
    kn: "Kannada",
    ml: "Malayalam",
    mr: "Marathi",
    bn: "Bengali",
    gu: "Gujarati",
    pa: "Punjabi",
    ur: "Urdu",
  };
  const langName = langMap[targetLanguage] || targetLanguage;

  const userPrompt = [
    `Translate the following social media post into ${langName}.`,
    "Rules:",
    `- Write the ENTIRE post in ${langName} script (not English transliteration).`,
    "- Preserve the original meaning, tone, and emotional impact.",
    "- Keep the same hook style and post structure.",
    "- Use natural, conversational language that sounds native.",
    "- Do NOT add explanations, hashtags, or emojis unless they exist in the original.",
    "- Return ONLY the translated post. No preamble, no notes.",
    "",
    "Post:",
    rawPost
  ].join("\n");

  const resp = await callDirectWithRetry(userPrompt, `post-translator-${targetLanguage}`);

  let text = null;
  if (!resp) text = "";
  else if (typeof resp === "string") text = resp;
  else if (resp.text) text = resp.text;
  else if (resp.choices && resp.choices[0]) {
    const c = resp.choices[0];
    text = c.message?.content || c.text || (c.output && c.output[0]?.content?.text);
  } else if (resp.message && resp.message.content) {
    text = resp.message.content;
  } else {
    text = String(resp);
  }

  return (Array.isArray(text) ? text.join("\n") : text || "").trim();
}

// LLM-powered simple-language post simplifier
async function simplifyPostWithLLM(rawPost) {
  const systemMsg = "You are a concise editor who rewrites text using simple, plain English without changing meaning.";
  const userPrompt = [
    "Rewrite the following social media post into simple, everyday English.",
    "Preserve the original meaning, the main idea, and any hook or final question.",
    "Use short sentences, simple words, and natural conversational tone.",
    "Do NOT add facts, hashtags, or emojis unless they already exist in the post.",
    "Return only the rewritten post (no commentary, no analysis).",
    "",
    "Post:",
    rawPost
  ].join("\n");

  const resp = await callDirectWithRetry(userPrompt, "post-simplifier");

  let text = null;
  if (!resp) text = "";
  else if (typeof resp === "string") text = resp;
  else if (resp.text) text = resp.text;
  else if (resp.choices && resp.choices[0]) {
    const c = resp.choices[0];
    text = c.message?.content || c.text || (c.output && c.output[0]?.content?.text);
  } else if (resp.message && resp.message.content) {
    text = resp.message.content;
  } else {
    text = String(resp);
  }

  return (Array.isArray(text) ? text.join("\n") : text || "").trim();
}

async function callDirectWithRetry(prompt, logName) {
  let attempt = 0;
  while (attempt < OPENCLAW_MAX_RETRIES) {
    try {
      if (attempt > 0) {
        console.log(`🔄 [${logName}] Retrying OpenRouter request (attempt ${attempt + 1})...`);
        await sleep(2000 * attempt);
      }
      return await callOpenRouterDirect(prompt);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.warn(`⚠️ [${logName}] OpenRouter request failed: ${msg} (Code: ${e.code || "N/A"})`);

      if (isTransient(e)) {
        attempt++;
      } else {
        throw new Error(`OpenRouter ${logName} failed: ${msg}`);
      }
    }
  }
  throw new Error(`[${logName}] OpenRouter failed after ${OPENCLAW_MAX_RETRIES} transient errors.`);
}

function getAIResponse(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    if (!OPENCLAW_MAIN) {
      return reject(new Error("OpenClaw executable not found. Set OPENCLAW_MAIN to the openclaw.mjs path."));
    }

    const parseStdout = (stdout, stderr, exitCode) => {
      const textOut = (stdout || "").trim();
      const jsonStart = textOut.lastIndexOf("{");
      if (jsonStart === -1) {
        return reject(new Error("OpenClaw returned no JSON payload. " + (stderr ? `stderr: ${String(stderr).slice(0, 800)}` : `exit ${exitCode}`)));
      }
      try {
        const parsed = JSON.parse(textOut.slice(jsonStart));
        const reply = parsed?.payloads?.[0]?.text || parsed?.text || parsed?.message;
        if (!reply?.trim()) {
          console.error("OpenClaw response payload was empty.");
          return reject(new Error("OpenClaw response payload was empty."));
        }
        resolve(reply.trim());
      } catch (e) {
        reject(new Error(`Failed to parse OpenClaw JSON: ${e.message}`));
      }
    };

    const freshSessionId = `fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const args = [
      OPENCLAW_MAIN,
      "agent",
      "--agent", "main",
      "--session-id", freshSessionId,
      "--json",
      "--message", "-",
    ];

    console.log(`🤖 [openclaw] Starting direct node session (non-interactive): ${freshSessionId}...`);

    const child = spawn("node", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, OPENCLAW_LOG_LEVEL: "info" }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) { }
      reject(new Error("OpenClaw timed out after 300s"));
    }, 300000);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error(`Exit ${code}: ${stderr.slice(-500)}`));
      }
      parseStdout(stdout, stderr, code);
    });

    try {
      child.stdin.write(prompt, "utf8", () => {
        child.stdin.end();
      });
    } catch (e) {
      clearTimeout(timer);
      reject(new Error(`Failed to write prompt to stdin: ${e.message}`));
    }
  });
}

async function getAIResponseWithRetry(prompt, logName) {
  let attempt = 0;
  while (attempt < OPENCLAW_MAX_RETRIES) {
    try {
      if (attempt > 0) {
        console.log(`🔄 [${logName}] Retrying OpenClaw request (attempt ${attempt + 1})...`);
        await sleep(2000 * attempt);
      }
      return await getAIResponse(prompt);
    } catch (e) {
      console.warn(`⚠️ [${logName}] OpenClaw request failed: ${e.message}`);
      if (isTransient(e)) {
        attempt++;
      } else {
        throw e;
      }
    }
  }
  throw new Error(`[${logName}] OpenClaw failed after ${OPENCLAW_MAX_RETRIES} attempts.`);
}

// ─── 7. POST FORMATTING & VALIDATION ────────────────────────────────────────

function looksLikeMeta(text) {
  const m = (text || "").toLowerCase();
  return (
    m.includes("here is the post") ||
    m.includes("i have written") ||
    m.includes("here's a draft") ||
    m.includes("let me know")
  );
}

function looksLikeAnalysis(text) {
  const m = (text || "").toLowerCase();
  return m.includes("the story is about") || m.includes("the trend shows");
}

function looksLikeClarification(text) {
  const m = (text || "").toLowerCase();
  return m.includes("what is your timezone") || m.includes("how should i address you");
}

async function enforcePostFormat(raw) {
  if (!raw) return raw;

  // Collapse excessive spacing (3+ newlines into 2)
  let processed = raw.replace(/\n{3,}/g, "\n\n").trim();

  const lines = processed.split("\n");
  let startIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (looksLikeMeta(lines[i])) { startIdx = i + 1; }
  }
  processed = lines.slice(startIdx).join("\n").trim();

  try {
    const simplified = await simplifyPostWithLLM(processed);
    return simplified || processed;
  } catch (e) {
    console.warn(`⚠️ [enforcePostFormat] LLM simplifier failed: ${e.message}`);
    return processed;
  }
}

function assertPost(post, contextMsg) {
  if (!post || post.length < 50) {
    throw new Error(`Validation failed for ${contextMsg}: Output is too short or empty.`);
  }
  if (looksLikeMeta(post) || looksLikeClarification(post)) {
    throw new Error(`Validation failed for ${contextMsg}: Bot returned conversational meta-text instead of a post.`);
  }
}

// ─── 8. PIPELINES ───────────────────────────────────────────────────────────

async function runAutopostPipeline(category = null, region = "Global") {
  if (isPipelineRunning) {
    console.log("⚠️ Pipeline already running. Skipping concurrent trigger.");
    return;
  }
  isPipelineRunning = true;
  try {
    console.log(`🔍 Fetching live signals for autopost (Category: ${category || DEFAULT_CATEGORY}, Region: ${region})...`);
    const { data: rawSignals, source } = await fetchLiveSignals(category, region);

    if (!rawSignals) {
      throw new Error("All live signal sources failed. Cannot run autopost without real data.");
    }

    const cleanerPrompt = buildSignalCleanerPrompt(rawSignals);
    const signals = await callDirectWithRetry(cleanerPrompt, "signal-cleaner");

    logStage("LIVE_SIGNALS", signals);

    const pickerPrompt = buildStoryPickerPrompt(signals, source, recentTopics, category, region);
    const chosenStory = await callDirectWithRetry(pickerPrompt, "story-picker");

    if (!chosenStory?.trim() || chosenStory.trim().toUpperCase() === "SKIP") {
      throw new Error(`No qualifying ${category || DEFAULT_CATEGORY} story found in this week's signals.`);
    }

    return await buildAutopostPost(chosenStory.trim(), { source, region });
  } finally {
    isPipelineRunning = false;
  }
}

async function buildAutopostPost(chosenStory, { source = "Google News", region = "Global" } = {}) {
  const story = String(chosenStory || "").trim();
  if (!story) {
    throw new Error("No story provided for autopost generation.");
  }

  logStage("CHOSEN_STORY", story);

  const implicationPrompt = buildHiddenImplicationExtractorPrompt(story);
  const hiddenShift = await callDirectWithRetry(implicationPrompt, "hidden-implication");

  logStage("HIDDEN_SHIFT", hiddenShift);

  const anglePrompt = buildDiscussionAnglePrompt(story, hiddenShift);
  const discussionAngle = await callDirectWithRetry(anglePrompt, "discussion-angle");

  if (discussionAngle.trim().toUpperCase() === "SKIP") {
    throw new Error("Failed discussion test: Not enough professional tension or discussion potential.");
  }
  logStage("DISCUSSION_ANGLE", discussionAngle);

  // ── Argument Architect ────────────────────────────────────────────────────
  console.log("🏗️  [argument-architect] Building content blueprint...");
  let blueprint;
  try {
    const architectRaw = await callOpenRouterWithModel(
      "openai/gpt-4o",
      buildArgumentArchitectSystemPrompt(),
      hiddenShift
    );
    blueprint = extractFirstJsonObject(architectRaw);
    if (!blueprint) throw new Error("No valid JSON object found in Argument Architect response");
    logStage("ARGUMENT_BLUEPRINT", blueprint);
  } catch (err) {
    console.warn(`⚠️ [argument-architect] JSON parse failed, falling back to raw text: ${err.message}`);
    blueprint = hiddenShift;
  }

  // ── Hook Generation (runs in parallel with no blocking — 3 agents) ──────────
  console.log("🪝 [hook-gen] Generating viral hook candidates...");
  const hookCandidates = await runHookGenerationForPost(story, region);
  const bestHook = await pickBestHookForPost(hookCandidates, story);
  if (bestHook) logStage("BEST_HOOK", bestHook);

  // ── Post Writer — Draft 1 ─────────────────────────────────────────────────
  const blueprintBase = typeof blueprint === "string"
    ? `${story}\nHidden Shift: ${hiddenShift}\nDiscussion Angle: ${discussionAngle}\nBlueprint: ${blueprint}`
    : `${story}\nHidden Shift: ${hiddenShift}\nDiscussion Angle: ${discussionAngle}\nBlueprint: ${JSON.stringify(blueprint, null, 2)}`;

  const blueprintInput = bestHook
    ? `${blueprintBase}\n\nMANDATORY OPENING HOOK — You MUST use this exact line as the very first line of the post, word-for-word:\n"${bestHook}"`
    : blueprintBase;

  const writerPrompt = buildPostWriterPrompt(blueprintInput);
  let draft1 = await callDirectWithRetry(writerPrompt, "post-writer-draft1");
  draft1 = await enforcePostFormat(draft1);
  logStage("DRAFT_1", draft1);

  // ── Draft Critic ──────────────────────────────────────────────────────────
  console.log("🔍 [draft-critic] Analysing Draft 1...");
  let critiqueJson;
  try {
    const critiqueRaw = await callOpenRouterWithModel(
      "anthropic/claude-3.7-sonnet",
      buildDraftCriticSystemPrompt(),
      draft1
    );
    critiqueJson = extractFirstJsonObject(critiqueRaw);
    if (!critiqueJson) throw new Error("No valid JSON object found in Draft Critic response");
    logStage("DRAFT_CRITIQUE", critiqueJson);
  } catch (err) {
    console.warn(`⚠️ [draft-critic] JSON parse failed, falling back to raw text: ${err.message}`);
    critiqueJson = null;
  }

  // ── Post Writer — Draft 2 ─────────────────────────────────────────────────
  const draft2UserPrompt = [
    "You are rewriting a LinkedIn post based on a critique.",
    "",
    "Here is the original draft:",
    draft1,
    "",
    "Here is the critique:",
    critiqueJson ? JSON.stringify(critiqueJson, null, 2) : "(No structured critique available — improve the hook, remove generic phrases, and tighten the ending.)",
    "",
    "Rewrite the post by fixing every issue listed in rewrite_instructions. Rules:",
    "- Keep the same core idea and insight",
    "- Do not change the fundamental angle",
    "- Fix the hook first",
    "- Replace every flagged generic phrase with a specific detail",
    "- Do not add any new generic advice",
    "- Output only the rewritten post, no explanation"
  ].join("\n");

  let rawPost = await callDirectWithRetry(draft2UserPrompt, "post-writer-draft2");
  rawPost = await enforcePostFormat(rawPost);
  logStage("DRAFT_2", rawPost);

  const polisherPrompt = buildPostPolisherPrompt(rawPost);
  const post = await callDirectWithRetry(polisherPrompt, "post-polisher");

  console.log("🎨 Preparing image concept (image deferred until user confirms)...");
  const imageConceptPrompt = buildImageConceptPrompt(story, post);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept");
  const imageConcept = normalizeImageConcept(imageConceptRaw, story);

  assertPost(post, "autopost");
  rememberTopic(story);
  logStage("FINAL_POST", post);
  logStage("IMAGE_CONCEPT", imageConcept);
  return { post, source, chosenStory: story, imageConcept };
}

async function runGeneratePipeline() {
  return await runAutopostPipeline(DEFAULT_CATEGORY);
}

async function runTopicPostPipeline(topic) {
  console.log(`📝 Writing post for topic: ${topic}`);

  const implicationPrompt = buildHiddenImplicationExtractorPrompt(topic);
  const hiddenShift = await callDirectWithRetry(implicationPrompt, "hidden-implication-manual");

  logStage("HIDDEN_SHIFT", hiddenShift);

  const anglePrompt = buildDiscussionAnglePrompt(topic, hiddenShift);
  const discussionAngle = await callDirectWithRetry(anglePrompt, "discussion-angle-manual");

  if (discussionAngle.trim().toUpperCase() === "SKIP") {
    throw new Error("Failed discussion test: Not enough professional tension or discussion potential.");
  }
  logStage("DISCUSSION_ANGLE", discussionAngle);

  // ── Argument Architect ────────────────────────────────────────────────────
  console.log("🏗️  [argument-architect] Building content blueprint...");
  let blueprint;
  try {
    const architectRaw = await callOpenRouterWithModel(
      "openai/gpt-4o",
      buildArgumentArchitectSystemPrompt(),
      hiddenShift
    );
    blueprint = extractFirstJsonObject(architectRaw);
    if (!blueprint) throw new Error("No valid JSON object found in Argument Architect response");
    logStage("ARGUMENT_BLUEPRINT", blueprint);
  } catch (err) {
    console.warn(`⚠️ [argument-architect] JSON parse failed, falling back to raw text: ${err.message}`);
    blueprint = hiddenShift;
  }

  // ── Hook Generation (runs in parallel — 3 agents) ──────────────────────────
  console.log("🪝 [hook-gen] Generating viral hook candidates...");
  const hookCandidates = await runHookGenerationForPost(topic);
  const bestHook = await pickBestHookForPost(hookCandidates, topic);
  if (bestHook) logStage("BEST_HOOK", bestHook);

  // ── Post Writer — Draft 1 ─────────────────────────────────────────────────
  const blueprintBase = typeof blueprint === "string"
    ? `${topic}\nHidden Shift: ${hiddenShift}\nDiscussion Angle: ${discussionAngle}\nBlueprint: ${blueprint}`
    : `${topic}\nHidden Shift: ${hiddenShift}\nDiscussion Angle: ${discussionAngle}\nBlueprint: ${JSON.stringify(blueprint, null, 2)}`;

  const blueprintInput = bestHook
    ? `${blueprintBase}\n\nMANDATORY OPENING HOOK — You MUST use this exact line as the very first line of the post, word-for-word:\n"${bestHook}"`
    : blueprintBase;

  const draft1Prompt = buildTopicPostPrompt(blueprintInput);
  let draft1 = await callDirectWithRetry(draft1Prompt, "topic-post-draft1");
  draft1 = await enforcePostFormat(draft1);
  logStage("DRAFT_1", draft1);

  // ── Draft Critic ──────────────────────────────────────────────────────────
  console.log("🔍 [draft-critic] Analysing Draft 1...");
  let critiqueJson;
  try {
    const critiqueRaw = await callOpenRouterWithModel(
      "anthropic/claude-3.7-sonnet",
      buildDraftCriticSystemPrompt(),
      draft1
    );
    critiqueJson = extractFirstJsonObject(critiqueRaw);
    if (!critiqueJson) throw new Error("No valid JSON object found in Draft Critic response");
    logStage("DRAFT_CRITIQUE", critiqueJson);
  } catch (err) {
    console.warn(`⚠️ [draft-critic] JSON parse failed, falling back to raw text: ${err.message}`);
    critiqueJson = null;
  }

  // ── Post Writer — Draft 2 ─────────────────────────────────────────────────
  const draft2UserPrompt = [
    "You are rewriting a LinkedIn post based on a critique.",
    "",
    "Here is the original draft:",
    draft1,
    "",
    "Here is the critique:",
    critiqueJson ? JSON.stringify(critiqueJson, null, 2) : "(No structured critique available — improve the hook, remove generic phrases, and tighten the ending.)",
    "",
    "Rewrite the post by fixing every issue listed in rewrite_instructions. Rules:",
    "- Keep the same core idea and insight",
    "- Do not change the fundamental angle",
    "- Fix the hook first",
    "- Replace every flagged generic phrase with a specific detail",
    "- Do not add any new generic advice",
    "- Output only the rewritten post, no explanation"
  ].join("\n");

  let rawPost = await callDirectWithRetry(draft2UserPrompt, "topic-post-draft2");
  rawPost = await enforcePostFormat(rawPost);
  logStage("DRAFT_2", rawPost);

  const polisherPrompt = buildPostPolisherPrompt(rawPost);
  const post = await callDirectWithRetry(polisherPrompt, "topic-polisher");

  // Build image concept but defer actual image generation
  console.log("🎨 Preparing image concept (image deferred until user confirms)...");
  const imageConceptPrompt = buildImageConceptPrompt(topic, post);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept-manual");
  const imageConcept = normalizeImageConcept(imageConceptRaw, topic);

  assertPost(post, "topic-post");
  rememberTopic(topic);
  logStage("FINAL_POST", post);
  logStage("IMAGE_CONCEPT", imageConcept);
  return { post, imageConcept };
}

async function runResearchPipeline(topic) {
  console.log(`🚀 Starting Deep Research Content Brief for: "${topic}"`);

  const briefPrompt = [
    "I need a comprehensive content brief for a high-impact blog and social campaign.",
    `Topic: ${topic}`,
    "",
    "Research the web and deliver the brief using this EXACT format:",
    "## COMPETITOR ARTICLES",
    "| # | Title | URL | Angle | Gap |",
    "## SEARCH QUERIES",
    "## TARGET AUDIENCE",
    "## HEADLINE OPTIONS",
    "## RECOMMENDED OUTLINE",
    "## KEY STATS",
    "## SOCIAL POSTS",
    "## DISTRIBUTION"
  ].join("\n");

  const fullResponse = await getAIResponseWithRetry(briefPrompt, "content-brief-researcher");
  const socialSectionMatch = fullResponse.match(/## SOCIAL POSTS([\s\S]*?)(?=## DISTRIBUTION|$)/i);
  const socialPost = socialSectionMatch ? socialSectionMatch[1].trim() : "Social post generation failed.";
  const researchBrief = fullResponse.replace(/## SOCIAL POSTS[\s\S]*?(?=## DISTRIBUTION|$)/i, "✅ *Social Posts generated below*").trim();

  // Build image concept but defer image generation
  console.log("🎨 Preparing image concept (image deferred until user confirms)...");
  const imageConceptPrompt = buildImageConceptPrompt(topic, socialPost);
  const imageConceptRaw = await callDirectWithRetry(imageConceptPrompt, "image-concept-research");
  const imageConcept = normalizeImageConcept(imageConceptRaw, topic);

  rememberTopic(topic);
  logStage("CONTENT_BRIEF", researchBrief);

  return {
    post: socialPost,
    analysis: "📊 Content Brief Analysis Complete.",
    sources: researchBrief,
    imageConcept
  };
}

// ─── SHORT & CRISP GENERATOR ────────────────────────────────────────────────

async function shortenAndSendPost(chatId) {
  const pending = pendingImageRequests[chatId];
  if (!pending) {
    await safeSendMessage(chatId, "⚠️ No pending post to shorten. Run a post command first.");
    return;
  }
  if (Date.now() > pending.expiresAt) {
    delete pendingImageRequests[chatId];
    await safeSendMessage(chatId, "⏰ Post session expired. Run the command again.");
    return;
  }

  await safeSendMessage(chatId, "⏳ Rewriting post to be short, crisp, and emotional...");
  try {
    const shortenPrompt = buildShortCrispPrompt(pending.post);
    const newPostRaw = await callDirectWithRetry(shortenPrompt, "short-crisp-polisher");
    const newPost = await enforcePostFormat(newPostRaw);

    pending.post = newPost;

    await sendChunked(chatId, newPost);
    await safeSendMessage(chatId, "✅ Shortened post ready!\n\nWant an image? Reply YES to generate it.\n\nOr send feedback to rewrite it further.");
  } catch (err) {
    console.error(`❌ [shorten-post] Failed: ${err.message}`);
    await safeSendMessage(chatId, `❌ Rewrite failed: ${err.message}`);
  }
}

// ─── FEEDBACK REWRITER ───────────────────────────────────────────────────────

async function rewriteWithFeedback(chatId, feedback) {
  const pending = pendingImageRequests[chatId];
  if (!pending) {
    await safeSendMessage(chatId, "⚠️ No pending post to rewrite. Run a post command first.");
    return;
  }
  if (Date.now() > pending.expiresAt) {
    delete pendingImageRequests[chatId];
    await safeSendMessage(chatId, "⏰ Post session expired. Run the command again.");
    return;
  }

  await safeSendMessage(chatId, "⏳ Rewriting post based on your feedback...");
  try {
    const prompt = buildFeedbackRewritePrompt(pending.post, feedback);
    const rewrittenRaw = await callDirectWithRetry(prompt, "feedback-rewriter");
    const rewritten = await enforcePostFormat(rewrittenRaw);

    pending.post = rewritten;

    await sendChunked(chatId, rewritten);
    await safeSendMessage(chatId, "✅ Rewritten post ready!\n\nWant to make it short & crisp? Reply SHORT YES.\nWant an image? Reply YES.\nOr send more feedback to keep refining.");
  } catch (err) {
    console.error(`❌ [feedback-rewrite] Failed: ${err.message}`);
    await safeSendMessage(chatId, `❌ Rewrite failed: ${err.message}`);
  }
}

// ─── ON-DEMAND IMAGE GENERATOR ──────────────────────────────────────────────

async function generateAndSendImage(chatId) {
  const pending = pendingImageRequests[chatId];

  if (!pending) {
    await safeSendMessage(chatId, "⚠️ No pending image request. Run /autopost or /post first.");
    return;
  }

  // Check expiry
  if (Date.now() > pending.expiresAt) {
    delete pendingImageRequests[chatId];
    await safeSendMessage(chatId, "⏰ Image request expired (20 min limit). Run the command again.");
    return;
  }

  await safeSendMessage(chatId, "🎨 Generating image...");

  try {
    const imageBackgroundUrl = await callImageAPI(pending.imageConcept.visual);
    const imageUrl = await renderImageWithText(imageBackgroundUrl, pending.imageConcept);
    await sendPhoto(chatId, imageUrl, pending.post.slice(0, 1024));
    await safeSendMessage(chatId, `🧠 Visual Spec\n\n${imageConceptToText(pending.imageConcept)}`);
    console.log(`✅ [on-demand-image] Image generated and sent for chatId ${chatId}`);
  } catch (err) {
    console.error(`❌ [on-demand-image] Failed: ${err.message}`);
    await safeSendMessage(chatId, `❌ Image generation failed: ${err.message}`);
  } finally {
    // Always clear pending — force user to re-run command for a fresh image
    delete pendingImageRequests[chatId];
  }
}

// ─── 9. TELEGRAM WEBHOOK ────────────────────────────────────────────────────

function clampText(text) {
  if (!text || text.length <= TELEGRAM_MAX_TEXT) return text;
  return text.slice(0, TELEGRAM_MAX_TEXT) + "\n\n[truncated]";
}

function parsePlatformChoice(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (raw === "all") return ["X", "Facebook", "LinkedIn"];

  // Split by comma, slash, or whitespace
  const tokens = raw.split(/[,\/\s]+/).filter(Boolean);
  const platformSet = new Set();

  for (const token of tokens) {
    if (["1", "x", "twitter", "/x", "/twitter"].includes(token)) platformSet.add("X");
    else if (["2", "facebook", "fb", "/facebook", "/fb"].includes(token)) platformSet.add("Facebook");
    else if (["3", "linkedin", "li", "/linkedin", "/li"].includes(token)) platformSet.add("LinkedIn");
  }

  const result = Array.from(platformSet);
  return result.length > 0 ? result : null;
}

function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function trimToWordLimit(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ").trimEnd()}...`;
}

function buildPlatformRewritePrompt(post, platform) {
  const xRules = [
    "Platform: X",
    "Word count MUST be between 20 and 35 words, never above 35.",
    "Use concise social style, not long explanation.",
    "Return only the final post text.",
  ];

  const fbRules = [
    "Platform: Facebook",
    "Word count MUST be between 50 and 60 words. Never go below 45 or above 65.",
    "Keep language simple, clear, and conversational.",
    "CRITICAL: Vary the structure every time. Do NOT use a fixed template. Pick ONE of these patterns randomly:",
    '  A) One single punchy paragraph (4-6 lines).',
    '  B) Two paragraphs: a short hook (1-2 lines) + an insight/takeaway (2-4 lines).',
    '  C) Three micro-paragraphs: observation → implication → question/reflection.',
    '  D) Many tiny 2-line paragraphs stacked vertically.',
    '  E) A 2-line hook, then a short 3-line body, then a 1-line closing.',
    '  F) Four short paragraphs with mixed line lengths.',
    "Use line breaks freely. Avoid bullet points.",
    "Return only the final post text. No intro, no explanation.",
  ];

  const liRules = [
    "Platform: LinkedIn",
    "Word count MUST be around 100 words. Aim for 90-110 words. Never go below 80 or above 120.",
    "Keep the operator voice: observant, grounded, concise, slightly opinionated.",
    "CRITICAL: Vary the structure every time. Do NOT use a fixed template. Pick ONE of these patterns randomly:",
    '  A) Two paragraphs: a sharp hook (3-4 lines) + a deeper insight with closing (4-6 lines).',
    '  B) Three paragraphs: hook → specific example/implication → one-line reflection or question.',
    '  C) Four short paragraphs with rhythm: short → medium → short → punchy closing.',
    '  D) One flowing paragraph with natural line breaks (not a block of text).',
    '  E) A 1-line hook, a 3-line body, a 2-line expansion, and a 1-line closing.',
    '  F) Staggered lengths: 2-line hook, 4-line insight, 1-line twist/closing.',
    "Mix short punchy lines with slightly longer ones. Avoid predictable symmetry.",
    "No bullet points unless the topic genuinely needs them.",
    "Return only the final post text. No intro, no explanation.",
  ];

  const platformRules = platform === "X" ? xRules : platform === "Facebook" ? fbRules : liRules;

  return [
    "You are rewriting a social post for a single platform.",
    "Keep only ONE central idea. Do not mix unrelated ideas.",
    "Do not turn this into a newsletter.",
    ...platformRules,
    "",
    "Original post:",
    post,
  ].join("\n");
}

async function formatPostForPlatform(post, platform) {
  const raw = String(post || "").trim();
  if (!raw) return raw;

  // Apply platform-specific rewrite + word-limit enforcement for all platforms
  const limits = {
    X: { min: 20, max: 35 },
    Facebook: { min: 45, max: 65 },
    LinkedIn: { min: 80, max: 120 },
  };
  const { min, max } = limits[platform] || { min: 80, max: 120 };
  let candidate = raw;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const prompt = buildPlatformRewritePrompt(candidate, platform);
      const rewritten = await callDirectWithRetry(prompt, `platform-formatter-${platform.toLowerCase()}`);
      const cleaned = (await enforcePostFormat(rewritten))
        .replace(/^\s*[-*•]\s+/gm, "")
        .trim();

      const wc = countWords(cleaned);
      if (wc >= min && wc <= max) {
        return cleaned;
      }

      candidate = cleaned;
    } catch (_) {
      break;
    }
  }

  // Deterministic fallback if rewriting fails constraints.
  if (platform === "X") {
    const singleLine = raw.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    let compact = trimToWordLimit(singleLine, max);
    if (countWords(compact) < min) {
      compact = `${compact} What do you think?`;
      compact = trimToWordLimit(compact, max);
    }
    return compact;
  }

  // Facebook / LinkedIn fallback
  let trimmed = trimToWordLimit(raw.replace(/^\s*[-*•]\s+/gm, "").trim(), max);
  if (countWords(trimmed) < min) {
    trimmed = `${trimmed}\n\nWhat is your take?`;
    trimmed = trimToWordLimit(trimmed, max);
  }
  return trimmed;
}

async function safeSendMessage(chatId, text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (err) {
    console.error(`Telegram send failed: ${err.message}`);
  }
}

async function sendChunked(chatId, text) {
  const content = text || "";
  for (let i = 0; i < content.length; i += TELEGRAM_MAX_TEXT) {
    await safeSendMessage(chatId, content.slice(i, i + TELEGRAM_MAX_TEXT));
  }
}

async function sendPhoto(chatId, photoUrl, caption) {
  try {
    const textStr = String(caption || "");
    const captionToUse = textStr.length <= TELEGRAM_MAX_CAPTION ? textStr : "";

    const isRemoteUrl = /^https?:\/\//i.test(String(photoUrl || ""));
    if (isRemoteUrl) {
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: captionToUse
      });
    } else {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", captionToUse);
      form.append("photo", fs.createReadStream(photoUrl));

      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        timeout: 30000,
      });

      try {
        fs.unlink(photoUrl, () => { });
      } catch (_) { }
    }

    // If the text is too long for a caption, send it as a separate full message
    if (textStr.length > TELEGRAM_MAX_CAPTION) {
      await sendChunked(chatId, textStr);
    }
  } catch (err) {
    console.error(`Telegram sendPhoto failed: ${err.message}`);
    await sendChunked(chatId, `🖼️ Image: ${photoUrl}\n\n${caption}`);
  }
}

async function triggerAutopostFlow(chatId, rawCategory, regionArg = null) {
  const category = resolveAutopostCategory(rawCategory);
  const categoryStrategy = getAutopostCategoryStrategy(category);
  const region = regionArg
    ? (regionArg.charAt(0).toUpperCase() + regionArg.slice(1).toLowerCase())
    : (categoryStrategy.defaultRegion || "Global");

  if (!AUTOPPOST_CATEGORIES.includes(category)) {
    await safeSendMessage(
      chatId,
      `⚠️ Unknown category "${rawCategory}".\n\nUse one of:\n${AUTOPPOST_CATEGORIES.join(", ")}`
    );
    return;
  }

  await safeSendMessage(chatId, `🔎 Fetching top 5 live news items for ${category} / ${region}...`);

  try {
    const { stories, source } = await fetchAutopostTopStories(category, region);

    if (!stories.length) {
      await safeSendMessage(chatId, `⚠️ Couldn't build a top 5 list from live signals and Google News for "${category}". Please try again in a moment.`);
    } else {
      const list = stories.map((item, i) => {
        const reasonLine = item.reason ? `\n   • ${item.reason}` : "";
        return `${i + 1}. ${item.title}\n   — ${item.source}${reasonLine}`;
      }).join("\n\n");

      pendingAutopostSelections[chatId] = {
        category,
        region,
        headlines: stories,
        source,
        expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
      };

      await safeSendMessage(chatId,
        `📰 Top ${stories.length} stories for "${category}" (${region}) from live signals + Google News:\n\n${list}\n\nReply with number(s) to generate post(s).\n• Single: 1, 2, 3...\n• Multiple: 1,3,5 or "all"`
      );
    }
  } catch (err) {
    console.error(`❌ [autopost-flow] Failed: ${err.message}`);
    await safeSendMessage(chatId, `❌ Error: ${err.message}`);
  }
}

app.post("/webhook", async (req, res) => {
  const message = req.body?.message;
  if (!message?.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  res.sendStatus(200);

  (async () => {
    try {
      if (isProcessing) {
        await safeSendMessage(chatId, "⏳ Processing...");
        return;
      }
      isProcessing = true;

      if (isGreetingMessage(text)) {
        await safeSendMessage(chatId, "Hi! Here are all autopost categories you can use.");
        const { text: categoriesText, options } = buildAutopostCategoriesText();
        await sendChunked(chatId, categoriesText);
        pendingGreetingSelections[chatId] = {
          options,
          expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
        };
        await safeSendMessage(chatId, "For command help, use /help");
        return;
      }

      if (text.toLowerCase() === "generate" || text.startsWith("/generate")) {
        await safeSendMessage(chatId, "⏳ Scanning startup signals, picking story, and writing post...");
        const { post, imageConcept } = await runGeneratePipeline();
        await sendChunked(chatId, post);
        pendingImageRequests[chatId] = {
          topic: "startup signal",
          post,
          imageConcept,
          expiresAt: Date.now() + PENDING_IMAGE_TTL_MS
        };
        await safeSendMessage(chatId, "✅ Post ready!\n\nReply with your feedback/pointers to rewrite the post.\n\nWant to make it short, crisp, and pointer-based with emotional lines? Reply SHORT YES or SHORT NO.\n\nWant an image? Reply YES to generate it.");

      } else if (text.startsWith("/language ")) {
        const langCode = text.replace("/language", "").trim().toLowerCase();
        const supportedLangs = ["te", "hi", "ta", "kn", "ml", "mr", "bn", "gu", "pa", "ur"];
        if (!langCode || !supportedLangs.includes(langCode)) {
          await safeSendMessage(chatId, `❌ Usage: /language <code>\nSupported: te (Telugu), hi (Hindi), ta (Tamil), kn (Kannada), ml (Malayalam), mr (Marathi), bn (Bengali), gu (Gujarati), pa (Punjabi), ur (Urdu)`);
          return;
        }

        // Try to find a post to translate
        let sourcePost = null;
        let sourceType = null;

        if (pendingMultiPostRequests[chatId]) {
          const mp = pendingMultiPostRequests[chatId];
          if (Date.now() <= mp.expiresAt && mp.posts.length > 0) {
            sourcePost = mp.posts[0].post;
            sourceType = "multi";
          }
        }
        if (!sourcePost && pendingImageRequests[chatId]) {
          const pi = pendingImageRequests[chatId];
          if (Date.now() <= pi.expiresAt) {
            sourcePost = pi.post;
            sourceType = "single";
          }
        }

        if (!sourcePost) {
          await safeSendMessage(chatId, "⚠️ No active post to translate. Generate a post first with /generate, /post, or /autopost.");
          return;
        }

        await safeSendMessage(chatId, `⏳ Translating to ${langCode.toUpperCase()}...`);
        try {
          const translated = await translatePostWithLLM(sourcePost, langCode);
          await sendChunked(chatId, `🌐 Translated (${langCode.toUpperCase()}):\n\n${translated}`);

          // Also translate other posts in multi-post session
          if (sourceType === "multi" && pendingMultiPostRequests[chatId].posts.length > 1) {
            const mp = pendingMultiPostRequests[chatId];
            for (let i = 1; i < mp.posts.length; i++) {
              await safeSendMessage(chatId, `⏳ Translating post ${i + 1}...`);
              const t = await translatePostWithLLM(mp.posts[i].post, langCode);
              await sendChunked(chatId, `🌐 Post ${i + 1} (${langCode.toUpperCase()}):\n\n${t}`);
            }
          }
        } catch (err) {
          console.error(`❌ [language] Translation failed: ${err.message}`);
          await safeSendMessage(chatId, `❌ Translation failed: ${err.message}`);
        }

      } else if (text.startsWith("/post ")) {
        const topic = text.replace("/post", "").trim();
        if (!topic) return safeSendMessage(chatId, "Usage: /post <topic>");
        await safeSendMessage(chatId, `🔍 Searching latest news about "${topic}"...`);

        const headlines = await fetchTopicHeadlines(topic);

        if (headlines.length === 0) {
          // Fallback: no news found — write directly from LLM knowledge
          await safeSendMessage(chatId, `⚠️ Couldn't find live news for "${topic}". Writing from existing knowledge...`);
          const { post, imageConcept } = await runTopicPostPipeline(topic);
          await sendChunked(chatId, post);
          pendingImageRequests[chatId] = { topic, post, imageConcept, expiresAt: Date.now() + PENDING_IMAGE_TTL_MS };
          await safeSendMessage(chatId, "✅ Post ready!\n\nReply with your feedback/pointers to rewrite the post.\n\nWant to make it short, crisp, and pointer-based with emotional lines? Reply SHORT YES or SHORT NO.\n\nWant an image? Reply YES to generate it.");
        } else {
          // Show numbered headlines for user to pick
          const list = headlines.map((h, i) =>
            `${i + 1}. ${h.title}\n   — ${h.source}`
          ).join("\n\n");

          pendingTopicSelections[chatId] = {
            topic,
            headlines,
            expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
          };

          await safeSendMessage(chatId,
            `📰 Found ${headlines.length} recent news articles about "${topic}":\n\n${list}\n\nReply with number(s) to pick which one(s) to write about.\n• Single: 1, 2, 3...\n• Multiple: 1,3,5 or "all"`
          );
        }

      } else if (text.startsWith("/research ")) {
        const goal = text.replace("/research", "").trim();
        if (!goal) return safeSendMessage(chatId, "Usage: /research <goal>");
        await safeSendMessage(chatId, `🚀 Researching "${goal}" autonomously...`);
        const result = await runResearchPipeline(goal);
        await sendChunked(chatId, result.post);
        await safeSendMessage(chatId, `🔗 Sources:\n${result.sources}`);
        pendingImageRequests[chatId] = {
          topic: goal,
          post: result.post,
          imageConcept: result.imageConcept,
          expiresAt: Date.now() + PENDING_IMAGE_TTL_MS
        };
        await safeSendMessage(chatId, "✅ Research + post ready!\n\nReply with your feedback/pointers to rewrite the post.\n\nWant to make it short, crisp, and pointer-based with emotional lines? Reply SHORT YES or SHORT NO.\n\nWant an image? Reply YES to generate it.");

      } else if (text.startsWith("/hooks ") || text === "/hooks") {
        // Usage: /hooks [region] [category]
        // Example: /hooks India startup
        const args = text.replace("/hooks", "").trim().split(" ");
        const region = args[0] || "India";
        const category = args[1] || DEFAULT_CATEGORY;
        await safeSendMessage(chatId, `⏳ Running 8-agent hook pipeline for ${region} / ${category}...`);
        const { hooks, source, topics } = await runHookPipeline({ region, category });
        await safeSendMessage(chatId, `📡 Source: ${source}\n🎯 Topics: ${topics.join(", ")}\n📊 ${hooks.length} hooks generated`);
        // Send a sample of hooks (first 5) as a preview
        const preview = hooks.slice(0, 5).map(h =>
          `[${h.category} / ${h.hook_type}]\n${h.text}`
        ).join("\n\n---\n\n");
        await sendChunked(chatId, preview);

      } else if (text.startsWith("/hooktopic ")) {
        // Usage: /hooktopic <topic> | <region>
        // Example: /hooktopic Zepto raises $300M | India
        const parts = text.replace("/hooktopic", "").trim().split("|");
        const topic = parts[0]?.trim();
        const region = parts[1]?.trim() || "India";
        if (!topic) return safeSendMessage(chatId, "Usage: /hooktopic <topic> | <region>");
        await safeSendMessage(chatId, `⏳ Running 8 hook agents for: "${topic}" (${region})...`);
        const hooks = await runHookAgentsForTopic(topic, region, "general");
        const preview = hooks.slice(0, 6).map(h =>
          `[${h.category} / ${h.hook_type}]\n${h.text}`
        ).join("\n\n---\n\n");
        await sendChunked(chatId, preview);

      } else if (text.toLowerCase() === "autopost" || text.startsWith("/autopost")) {
        const args = text.split(" ").slice(1);
        const rawCategory = args[0] || DEFAULT_CATEGORY;
        await triggerAutopostFlow(chatId, rawCategory, args[1]);

      } else if (text.toLowerCase() === "short yes" || text.toLowerCase() === "/short yes") {
        await shortenAndSendPost(chatId);

      } else if (text.toLowerCase() === "short no" || text.toLowerCase() === "/short no") {
        await safeSendMessage(chatId, "Okay! Keeping the original post.\n\nWant an image? Reply YES to generate it.\n\nOr reply with feedback to rewrite it.");

      } else if (text.toLowerCase() === "yes" || text.toLowerCase() === "/yes") {
        await generateAndSendImage(chatId);

      } else if (pendingTopicSelections[chatId]) {
        // User is picking headline(s) from the /post flow
        const pending = pendingTopicSelections[chatId];

        if (Date.now() > pending.expiresAt) {
          delete pendingTopicSelections[chatId];
          await safeSendMessage(chatId, "⏰ Selection expired (40 min limit). Run /post again.");
        } else {
          const indices = parseTopicSelection(text, pending.headlines.length);

          if (indices.length === 0) {
            await safeSendMessage(chatId, `❌ Invalid choice. Please reply with numbers between 1 and ${pending.headlines.length}. You can pick multiple like '1,3,5' or 'all'.`);
          } else if (indices.length === 1) {
            // Single topic — original flow
            const chosen = pending.headlines[indices[0]];
            delete pendingTopicSelections[chatId];
            pendingPlatformSelections[chatId] = {
              flow: "topic",
              chosen,
              expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
            };
            await safeSendMessage(
              chatId,
              `✅ Story selected:\n"${chosen.title}"\n\nWhere should I optimize this post for?\n1) X\n2) Facebook\n3) LinkedIn\n\nReply with one or more platforms (e.g. X, LinkedIn, Facebook, 1/2/3, or 'all').`
            );
          } else {
            // Multiple topics — enter multi-platform selection flow
            const selectedTopics = indices.map((i) => pending.headlines[i]);
            delete pendingTopicSelections[chatId];
            pendingPlatformSelections[chatId] = {
              flow: "topic-multi",
              topics: selectedTopics.map((chosen) => ({ chosen })),
              currentIndex: 0,
              platformsSoFar: [],
              expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
            };
            await safeSendMessage(
              chatId,
              `✅ ${selectedTopics.length} stories selected!\n\n` + formatPlatformQuestion(selectedTopics[0].title, 0, selectedTopics.length)
            );
          }
        }

      } else if (pendingAutopostSelections[chatId]) {
        // User is picking headline(s) from the /autopost flow
        const pending = pendingAutopostSelections[chatId];

        if (Date.now() > pending.expiresAt) {
          delete pendingAutopostSelections[chatId];
          await safeSendMessage(chatId, "⏰ Selection expired (40 min limit). Run /autopost again.");
        } else {
          const indices = parseTopicSelection(text, pending.headlines.length);

          if (indices.length === 0) {
            await safeSendMessage(chatId, `❌ Invalid choice. Please reply with numbers between 1 and ${pending.headlines.length}. You can pick multiple like '1,3,5' or 'all'.`);
          } else if (indices.length === 1) {
            // Single topic — original flow
            const chosen = pending.headlines[indices[0]];
            delete pendingAutopostSelections[chatId];
            pendingPlatformSelections[chatId] = {
              flow: "autopost",
              chosen,
              region: pending.region,
              source: pending.source,
              expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
            };
            await safeSendMessage(
              chatId,
              `✅ Story selected:\n"${chosen.title}"\n\nWhere should I optimize this post for?\n1) X\n2) Facebook\n3) LinkedIn\n\nReply with one or more platforms (e.g. X, LinkedIn, Facebook, 1/2/3, or 'all').`
            );
          } else {
            // Multiple topics — enter multi-platform selection flow
            const selectedTopics = indices.map((i) => pending.headlines[i]);
            delete pendingAutopostSelections[chatId];
            pendingPlatformSelections[chatId] = {
              flow: "autopost-multi",
              topics: selectedTopics.map((chosen) => ({ chosen, region: pending.region, source: pending.source })),
              currentIndex: 0,
              platformsSoFar: [],
              expiresAt: Date.now() + PENDING_TOPIC_TTL_MS
            };
            await safeSendMessage(
              chatId,
              `✅ ${selectedTopics.length} stories selected!\n\n` + formatPlatformQuestion(selectedTopics[0].title, 0, selectedTopics.length)
            );
          }
        }

      } else if (pendingPlatformSelections[chatId]) {
        const pending = pendingPlatformSelections[chatId];

        if (Date.now() > pending.expiresAt) {
          delete pendingPlatformSelections[chatId];
          await safeSendMessage(chatId, "⏰ Platform selection expired (40 min limit). Pick a story again.");
        } else {
          const platforms = parsePlatformChoice(text);
          if (!platforms) {
            await safeSendMessage(chatId, "Please reply with one or more platforms: X, Facebook, LinkedIn (or 1/2/3). You can combine them like 'LinkedIn X' or '1,2' or 'all'.");
          } else if (pending.flow === "topic") {
            const chosenHeadline = `${pending.chosen.title} (Source: ${pending.chosen.source})`;
            await safeSendMessage(chatId, `✅ Platforms: ${platforms.join(", ")}\n\n⏳ Running pipeline...`);
            const { post, imageConcept } = await runTopicPostPipeline(chosenHeadline);

            let primaryPost = post;
            for (const platform of platforms) {
              const platformPost = await formatPostForPlatform(post, platform);
              await safeSendMessage(chatId, `📱 ${platform}:`);
              await sendChunked(chatId, platformPost);
              if (platform === "LinkedIn") primaryPost = platformPost;
              else if (primaryPost === post) primaryPost = platformPost;
            }

            pendingImageRequests[chatId] = {
              topic: pending.chosen.title,
              post: primaryPost,
              imageConcept,
              expiresAt: Date.now() + PENDING_IMAGE_TTL_MS
            };
            delete pendingPlatformSelections[chatId];
            await safeSendMessage(chatId, "✅ Posts ready!\n\nReply with your feedback/pointers to rewrite the post.\n\nWant to make it short, crisp, and pointer-based with emotional lines? Reply SHORT YES or SHORT NO.\n\nWant an image? Reply YES to generate it.");
          } else if (pending.flow === "autopost") {
            await safeSendMessage(chatId, `✅ Platforms: ${platforms.join(", ")}\n\n⏳ Running autopost pipeline...`);
            const { post, source, chosenStory, imageConcept } = await buildAutopostPost(pending.chosen.title, {
              source: pending.chosen.source || pending.source || "News",
              region: pending.region,
            });

            let primaryPost = post;
            for (const platform of platforms) {
              const platformPost = await formatPostForPlatform(post, platform);
              await safeSendMessage(chatId, `📱 ${platform}:`);
              await sendChunked(chatId, platformPost);
              if (platform === "LinkedIn") primaryPost = platformPost;
              else if (primaryPost === post) primaryPost = platformPost;
            }

            await safeSendMessage(chatId, `📡 Sources: ${source}\n🌍 Region: ${pending.region}\n🎯 Story: ${chosenStory}`);
            pendingImageRequests[chatId] = {
              topic: chosenStory,
              post: primaryPost,
              imageConcept,
              expiresAt: Date.now() + PENDING_IMAGE_TTL_MS
            };
            delete pendingPlatformSelections[chatId];
            await safeSendMessage(chatId, "✅ Posts ready!\n\nReply with your feedback/pointers to rewrite the post.\n\nWant to make it short, crisp, and pointer-based with emotional lines? Reply SHORT YES or SHORT NO.\n\nWant an image? Reply YES to generate it.");
          } else if (pending.flow === "topic-multi" || pending.flow === "autopost-multi") {
            // Multi-topic flow: collect platforms for current topic, then ask for next
            pending.platformsSoFar.push(platforms);
            pending.currentIndex += 1;

            if (pending.currentIndex < pending.topics.length) {
              // Ask for platforms for the next topic
              const nextTopic = pending.topics[pending.currentIndex].chosen;
              await safeSendMessage(
                chatId,
                `✅ Platforms saved!\n\n` + formatPlatformQuestion(nextTopic.title, pending.currentIndex, pending.topics.length)
              );
            } else {
              // All platforms collected — generate all posts in parallel
              delete pendingPlatformSelections[chatId];
              await safeSendMessage(chatId, `✅ All platforms set! ⏳ Generating ${pending.topics.length} posts in parallel...`);

              const isAutopost = pending.flow === "autopost-multi";
              const generationResults = await Promise.allSettled(
                pending.topics.map(async (topicData, i) => {
                  const topicPlatforms = pending.platformsSoFar[i];
                  try {
                    let post, imageConcept, source, chosenStory;

                    if (isAutopost) {
                      const result = await buildAutopostPost(topicData.chosen.title, {
                        source: topicData.chosen.source || topicData.source || "News",
                        region: topicData.region,
                      });
                      post = result.post;
                      source = result.source;
                      chosenStory = result.chosenStory;
                      imageConcept = result.imageConcept;
                    } else {
                      const chosenHeadline = `${topicData.chosen.title} (Source: ${topicData.chosen.source})`;
                      const result = await runTopicPostPipeline(chosenHeadline);
                      post = result.post;
                      imageConcept = result.imageConcept;
                    }

                    let primaryPost = post;
                    const platformPosts = [];
                    for (const platform of topicPlatforms) {
                      const platformPost = await formatPostForPlatform(post, platform);
                      platformPosts.push({ platform, post: platformPost });
                      if (platform === "LinkedIn") primaryPost = platformPost;
                      else if (primaryPost === post) primaryPost = platformPost;
                    }

                    return {
                      success: true,
                      index: i,
                      topic: isAutopost ? chosenStory : topicData.chosen.title,
                      post: primaryPost,
                      imageConcept,
                      platforms: topicPlatforms,
                      platformPosts,
                      source: isAutopost ? source : null,
                      region: topicData.region,
                    };
                  } catch (err) {
                    console.error(`❌ [multi-gen] Topic ${i + 1} failed: ${err.message}`);
                    return { success: false, index: i, error: err.message };
                  }
                })
              );

              // Send results to user
              const successfulPosts = [];
              for (const result of generationResults) {
                const r = result.status === "fulfilled" ? result.value : { success: false, error: result.reason?.message || "Unknown error" };
                if (r.success) {
                  await safeSendMessage(chatId, `\n━━━ Post ${r.index + 1}: ${r.topic} ━━━`);
                  for (const { platform, post } of r.platformPosts) {
                    await safeSendMessage(chatId, `📱 ${platform}:`);
                    await sendChunked(chatId, post);
                  }
                  if (r.source) {
                    await safeSendMessage(chatId, `📡 Sources: ${r.source}\n🌍 Region: ${r.region}`);
                  }
                  successfulPosts.push({
                    topic: r.topic,
                    post: r.post,
                    imageConcept: r.imageConcept,
                    platforms: r.platforms,
                    source: r.source,
                    region: r.region,
                  });
                } else {
                  await safeSendMessage(chatId, `❌ Post ${r.index + 1} failed: ${r.error}`);
                }
              }

              if (successfulPosts.length > 0) {
                pendingMultiPostRequests[chatId] = {
                  posts: successfulPosts,
                  expiresAt: Date.now() + PENDING_IMAGE_TTL_MS
                };
                await safeSendMessage(
                  chatId,
                  `\n✅ ${successfulPosts.length} post(s) ready!\n\nCommands:\n• REWRITE <number> <feedback> — rewrite a specific post\n• SHORT <number> — make a post short & crisp\n• IMAGE <number> — generate image for a post\n• IMAGE ALL — generate images for all posts\n• Or send general feedback to rewrite all posts`
                );
              }
            }
          }
        }

      } else if (text.startsWith("/start") || text.startsWith("/help")) {
        await safeSendMessage(chatId, buildTelegramHelpText());

      } else if (/^\d+$/.test(text.trim()) && pendingGreetingSelections[chatId]) {
        const pending = pendingGreetingSelections[chatId];
        if (Date.now() > pending.expiresAt) {
          delete pendingGreetingSelections[chatId];
          await safeSendMessage(chatId, "⏰ Category selection expired. Send 'hi' to see the categories again.");
        } else {
          const idx = parseInt(text.trim(), 10) - 1;
          const chosen = pending.options[idx];
          if (!chosen) {
            await safeSendMessage(chatId, `❌ Invalid choice. Please reply with a number between 1 and ${pending.options.length}.`);
          } else {
            delete pendingGreetingSelections[chatId];
            await triggerAutopostFlow(chatId, chosen);
          }
        }

      } else if (pendingMultiPostRequests[chatId]) {
        const pending = pendingMultiPostRequests[chatId];
        if (Date.now() > pending.expiresAt) {
          delete pendingMultiPostRequests[chatId];
          await safeSendMessage(chatId, "⏰ Post session expired. Run the command again.");
        } else {
          const cmd = parseMultiPostCommand(text);
          if (cmd) {
            if (cmd.action === "image") {
              if (cmd.all) {
                // Generate images for all posts
                await safeSendMessage(chatId, "🎨 Generating images for all posts...");
                for (let i = 0; i < pending.posts.length; i++) {
                  const postData = pending.posts[i];
                  try {
                    const imageBackgroundUrl = await callImageAPI(postData.imageConcept.visual);
                    const imageUrl = await renderImageWithText(imageBackgroundUrl, postData.imageConcept);
                    await sendPhoto(chatId, imageUrl, postData.post.slice(0, 1024));
                    await safeSendMessage(chatId, `🧠 Post ${i + 1} Visual Spec\n\n${imageConceptToText(postData.imageConcept)}`);
                  } catch (err) {
                    console.error(`❌ [multi-image] Post ${i + 1} failed: ${err.message}`);
                    await safeSendMessage(chatId, `❌ Image for post ${i + 1} failed: ${err.message}`);
                  }
                }
              } else {
                // Generate image for specific post
                const postData = pending.posts[cmd.index];
                if (!postData) {
                  await safeSendMessage(chatId, `❌ Invalid post number. You have ${pending.posts.length} post(s).`);
                } else {
                  await safeSendMessage(chatId, `🎨 Generating image for post ${cmd.index + 1}...`);
                  try {
                    const imageBackgroundUrl = await callImageAPI(postData.imageConcept.visual);
                    const imageUrl = await renderImageWithText(imageBackgroundUrl, postData.imageConcept);
                    await sendPhoto(chatId, imageUrl, postData.post.slice(0, 1024));
                    await safeSendMessage(chatId, `🧠 Post ${cmd.index + 1} Visual Spec\n\n${imageConceptToText(postData.imageConcept)}`);
                  } catch (err) {
                    console.error(`❌ [multi-image] Post ${cmd.index + 1} failed: ${err.message}`);
                    await safeSendMessage(chatId, `❌ Image generation failed: ${err.message}`);
                  }
                }
              }
            } else if (cmd.action === "short") {
              const postData = pending.posts[cmd.index];
              if (!postData) {
                await safeSendMessage(chatId, `❌ Invalid post number. You have ${pending.posts.length} post(s).`);
              } else {
                await safeSendMessage(chatId, `⏳ Making post ${cmd.index + 1} short & crisp...`);
                try {
                  const shortenPrompt = buildShortCrispPrompt(postData.post);
                  const newPostRaw = await callDirectWithRetry(shortenPrompt, "short-crisp-polisher");
                  const newPost = await enforcePostFormat(newPostRaw);
                  postData.post = newPost;
                  await sendChunked(chatId, `📰 Post ${cmd.index + 1} (shortened):\n\n${newPost}`);
                  await safeSendMessage(chatId, `✅ Post ${cmd.index + 1} shortened!\n\n• REWRITE <number> <feedback> — rewrite a specific post\n• SHORT <number> — make a post short & crisp\n• IMAGE <number> — generate image for a post\n• IMAGE ALL — generate images for all posts`);
                } catch (err) {
                  console.error(`❌ [multi-short] Post ${cmd.index + 1} failed: ${err.message}`);
                  await safeSendMessage(chatId, `❌ Shorten failed: ${err.message}`);
                }
              }
            } else if (cmd.action === "rewrite") {
              const postData = pending.posts[cmd.index];
              if (!postData) {
                await safeSendMessage(chatId, `❌ Invalid post number. You have ${pending.posts.length} post(s).`);
              } else {
                await safeSendMessage(chatId, `⏳ Rewriting post ${cmd.index + 1} based on your feedback...`);
                try {
                  const prompt = buildFeedbackRewritePrompt(postData.post, cmd.feedback);
                  const rewrittenRaw = await callDirectWithRetry(prompt, "feedback-rewriter");
                  const rewritten = await enforcePostFormat(rewrittenRaw);
                  postData.post = rewritten;
                  await sendChunked(chatId, `📰 Post ${cmd.index + 1} (rewritten):\n\n${rewritten}`);
                  await safeSendMessage(chatId, `✅ Post ${cmd.index + 1} rewritten!\n\n• REWRITE <number> <feedback> — rewrite a specific post\n• SHORT <number> — make a post short & crisp\n• IMAGE <number> — generate image for a post\n• IMAGE ALL — generate images for all posts`);
                } catch (err) {
                  console.error(`❌ [multi-rewrite] Post ${cmd.index + 1} failed: ${err.message}`);
                  await safeSendMessage(chatId, `❌ Rewrite failed: ${err.message}`);
                }
              }
            }
          } else {
            // General feedback — rewrite ALL posts
            await safeSendMessage(chatId, `⏳ Rewriting all ${pending.posts.length} post(s) based on your feedback...`);
            for (let i = 0; i < pending.posts.length; i++) {
              const postData = pending.posts[i];
              try {
                const prompt = buildFeedbackRewritePrompt(postData.post, text);
                const rewrittenRaw = await callDirectWithRetry(prompt, `feedback-rewriter-all-${i}`);
                const rewritten = await enforcePostFormat(rewrittenRaw);
                postData.post = rewritten;
                await sendChunked(chatId, `📰 Post ${i + 1} (rewritten):\n\n${rewritten}`);
              } catch (err) {
                console.error(`❌ [multi-rewrite-all] Post ${i + 1} failed: ${err.message}`);
                await safeSendMessage(chatId, `❌ Post ${i + 1} rewrite failed: ${err.message}`);
              }
            }
            await safeSendMessage(chatId, `✅ All posts rewritten!\n\n• REWRITE <number> <feedback> — rewrite a specific post\n• SHORT <number> — make a post short & crisp\n• IMAGE <number> — generate image for a post\n• IMAGE ALL — generate images for all posts`);
          }
        }

      } else if (pendingImageRequests[chatId]) {
        const pending = pendingImageRequests[chatId];
        if (Date.now() > pending.expiresAt) {
          delete pendingImageRequests[chatId];
          await safeSendMessage(chatId, "⏰ Post session expired. Run the command again.");
        } else {
          await rewriteWithFeedback(chatId, text);
        }
      }
    } catch (err) {
      await safeSendMessage(chatId, `❌ Error: ${err.message}`);
    } finally {
      isProcessing = false;
    }
  })();
});

// ─── 10. HOOK PIPELINE ──────────────────────────────────────────────────────

// ─── HOOK GENERATION FOR POST PIPELINE ──────────────────────────────────────
// Runs 3 LinkedIn-relevant hook agents in parallel and returns all hook texts.
// Intentionally excludes humor/spicy and dmv-specific agents to keep tone professional.

async function runHookGenerationForPost(topic, region = "Global") {
  const prefix = getRegionPrefix(region);
  const fullTopic = prefix ? `${prefix}${topic}` : topic;

  const agentPairs = [
    { name: "startup_news", fn: buildStartupNewsHooksPrompt },
    { name: "personal_growth", fn: buildPersonalGrowthHooksPrompt },
    { name: "linkedin_safe", fn: buildLinkedinSafeHooksPrompt },
  ];

  const results = await Promise.allSettled(
    agentPairs.map(({ name, fn }) =>
      callDirectWithRetry(fn(fullTopic, region), `hook-gen:${name}`)
        .then(raw => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = extractFirstJsonObject(raw); }
          return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        })
        .catch(() => [])
    )
  );

  const hooks = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const h of r.value) {
        if (h && h.text && h.text.trim().length > 10) {
          hooks.push(h.text.trim());
        }
      }
    }
  }

  console.log(`🪝 [hook-gen] Generated ${hooks.length} hook candidates`);
  return hooks;
}

// Uses a fast LLM call to pick the single best hook for virality.
async function pickBestHookForPost(hooks, topic) {
  if (!hooks || hooks.length === 0) return null;
  if (hooks.length === 1) return hooks[0];

  const prompt = [
    `You are a LinkedIn virality expert. Pick the SINGLE most attention-grabbing, scroll-stopping opening line for a LinkedIn post about: "${topic}"`,
    "",
    "Hook candidates:",
    hooks.map((h, i) => `${i + 1}. ${h}`).join("\n"),
    "",
    "Rules:",
    "- Pick the one that creates the most curiosity, tension, or contrast",
    "- Prefer specific and bold over vague and inspirational",
    "- Output ONLY the exact text of the winning hook. No number. No preamble. No explanation."
  ].join("\n");

  try {
    const best = await callDirectWithRetry(prompt, "hook-picker");
    return best.trim();
  } catch (err) {
    console.warn(`⚠️ [hook-picker] Failed, using first hook as fallback: ${err.message}`);
    return hooks[0];
  }
}


// Step 2 — Region Prefix Helper
function getRegionPrefix(region) {
  const map = {
    US: "This startup/event is from the US. ",
    Canada: "This startup/event is from Canada. ",
    Global: "This story spans multiple countries globally. ",
    India: ""
  };
  return map[region] || "";
}

// Step 3 — 8 Agent Prompt Builders

// Agent 1 — News General
function buildNewsGeneralHooksPrompt(topic, region) {
  return [
    `You are a social media content writer for a general audience.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 short emotional hooks (2–3 lines each, LinkedIn style, personal-sounding) about this topic.`,
    `Hook 1: about FAILURE — emotion_type: sadness`,
    `Hook 2: about a SMALL WIN — emotion_type: hope`,
    `Hook 3: about a LESSON — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<failure|small_win|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|hope|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 2 — Current Affairs
function buildCurrentAffairsHooksPrompt(topic, region) {
  return [
    `You are a serious content writer for educated, globally aware readers.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 nuanced, serious hooks (LinkedIn style) about this topic:`,
    `Hook 1: about SYSTEMIC RISK — emotion_type: fear`,
    `Hook 2: about INSTITUTIONAL FAILURE — emotion_type: anger`,
    `Hook 3: about PERSONAL IMPACT OR LEARNING — emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<systemic_risk|institutional_failure|personal_impact>", "platform": "LinkedIn", "text": "...", "emotion_type": "<fear|anger|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 3 — DMV / EdTech
function buildDmvEdtechHooksPrompt(topic, region) {
  return [
    `You are a content writer for students, exam aspirants, parents, and edtech users.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 emotional story-style hooks (LinkedIn style) about this topic:`,
    `Hook 1: about FAILURE — emotion_type: sadness`,
    `Hook 2: about FINAL PASS / SUCCESS — emotion_type: pride`,
    `Hook 3: about a LESSON LEARNED — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<failure|final_pass|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|pride|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 4 — Startup News
function buildStartupNewsHooksPrompt(topic, region) {
  return [
    `You are a content writer for founders, operators, and investors.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 LinkedIn hooks about this startup/business topic:`,
    `Hook 1: OPTIMISTIC / HYPE angle — hook_type: "optimistic", emotion_type: hope`,
    `Hook 2: SKEPTICAL / WARNING angle — hook_type: "skeptical", emotion_type: fear`,
    `Hook 3: LESSON FOR FOUNDERS — hook_type: "lesson", emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<optimistic|skeptical|lesson>", "platform": "LinkedIn", "text": "...", "emotion_type": "<hope|fear|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 5 — Controversy
function buildControversyHooksPrompt(topic, region) {
  return [
    `You are a hot-take content writer for debate-lovers and strong-opinion holders on X (Twitter).`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 X (Twitter) hooks showing an emotional arc: anger → regret → realization.`,
    `Hook 1: ANGER take — emotion_type: anger`,
    `Hook 2: REGRET / SADNESS take — emotion_type: sadness`,
    `Hook 3: REALIZATION / NUANCE — emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<anger|regret|realization>", "platform": "X", "text": "...", "emotion_type": "<anger|sadness|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 6 — Personal Growth
function buildPersonalGrowthHooksPrompt(topic, region) {
  return [
    `You are a reflective content writer for professionals, ambitious people, and founders on LinkedIn.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 reflective, emotional LinkedIn hooks following the arc: past pain → insight → advice.`,
    `Hook 1: PAST PAIN — emotion_type: sadness`,
    `Hook 2: INSIGHT / TURNING POINT — emotion_type: hope`,
    `Hook 3: ADVICE / LESSON — emotion_type: inspiration`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<past_pain|insight|advice>", "platform": "LinkedIn", "text": "...", "emotion_type": "<sadness|hope|inspiration>", "hook_style": "standard" }`,
  ].join("\n");
}

// Agent 7 — Humor / Spicy
function buildHumorSpicyHooksPrompt(topic, region) {
  return [
    `You are a meme-aware, edgy content writer for X (Twitter) users who love viral and weird angles.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 funny, meme-style, edgy X hooks about this topic. All 3 must use hook_style: "meme_spicy".`,
    `All emotion_type must be: humor.`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "meme_spicy", "platform": "X", "text": "...", "emotion_type": "humor", "hook_style": "meme_spicy" }`,
  ].join("\n");
}

// Agent 8 — LinkedIn Safe
function buildLinkedinSafeHooksPrompt(topic, region) {
  return [
    `You are a polished content writer for senior professionals and corporate LinkedIn audiences.`,
    `Topic: ${topic}`,
    `Region: ${region}`,
    ``,
    `Write 3 calm, emotionally intelligent, professional LinkedIn hooks about this topic.`,
    `No slang, no extreme opinions, no clickbait. Tone: thoughtful, credible, confident.`,
    `Hook 1: emotion_type: pride`,
    `Hook 2: emotion_type: inspiration`,
    `Hook 3: emotion_type: curiosity`,
    ``,
    `Output ONLY a JSON array of exactly 3 objects. No markdown. No preamble. No explanation.`,
    `Schema for each object:`,
    `{ "hook_type": "<pride_moment|inspiration|curiosity>", "platform": "LinkedIn", "text": "...", "emotion_type": "<pride|inspiration|curiosity>", "hook_style": "standard" }`,
  ].join("\n");
}

// Step 4 — Central Hook Runner
async function runHookAgentsForTopic(topic, region, category) {
  const prefix = getRegionPrefix(region);
  const fullTopic = prefix + topic;

  const agentBuilders = [
    { name: "news_general", fn: buildNewsGeneralHooksPrompt },
    { name: "news_current_affairs", fn: buildCurrentAffairsHooksPrompt },
    { name: "news_dmv_edtech", fn: buildDmvEdtechHooksPrompt },
    { name: "startup_news", fn: buildStartupNewsHooksPrompt },
    { name: "controversy_agent", fn: buildControversyHooksPrompt },
    { name: "personal_growth", fn: buildPersonalGrowthHooksPrompt },
    { name: "humor_spicy", fn: buildHumorSpicyHooksPrompt },
    { name: "linkedin_safe", fn: buildLinkedinSafeHooksPrompt },
  ];

  const results = [];

  for (const { name, fn } of agentBuilders) {
    try {
      console.log(`🔍 [hook-runner] Running agent: ${name}`);
      const raw = await callDirectWithRetry(fn(fullTopic, region), name);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = extractFirstJsonObject(raw); }
      const hooksArray = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      for (const hook of hooksArray) {
        results.push({
          category: name,
          topic,
          region,
          date: new Date().toISOString().split("T")[0],
          platform: hook.platform || "LinkedIn",
          hook_type: hook.hook_type || "general",
          text: hook.text || "",
          emotion_type: hook.emotion_type || "inspiration",
          hook_style: hook.hook_style || "standard",
        });
      }
      logStage(`HOOK_AGENT:${name}`, `${hooksArray.length} hooks generated`);
    } catch (err) {
      console.warn(`⚠️ [${name}] Hook agent failed: ${err.message}`);
    }
  }

  return results;
}

// Step 5 — Topic Research for Hook Pipeline
async function runHookPipeline({ region = "India", category = "startup", agentFilter = "all" }) {
  const { data: rawSignals, source } = await fetchLiveSignals(category, region);
  if (!rawSignals) throw new Error("No live signals available for hook pipeline.");

  console.log(`🔍 [hook-pipeline] Cleaning signals for category: ${category}`);
  const cleanerPrompt = buildSignalCleanerPrompt(rawSignals);
  const signals = await callDirectWithRetry(cleanerPrompt, "hook-signal-cleaner");

  // Pick top 3 topics instead of just 1
  const topicPickerPrompt = [
    `You are a topic selector for a social media content pipeline.`,
    `From the signals below, pick the TOP 3 most interesting topics for a ${category} audience.`,
    `Region: ${region}`,
    `Output ONLY a JSON array of 3 strings, each being a short topic title.`,
    `No explanation. No markdown. JSON only.`,
    `Example: ["Topic A", "Topic B", "Topic C"]`,
    `Signals:\n${signals}`
  ].join("\n");

  console.log(`🔍 [hook-pipeline] Picking top 3 topics...`);
  const rawTopics = await callDirectWithRetry(topicPickerPrompt, "hook-topic-picker");
  let topics;
  try {
    topics = JSON.parse(rawTopics);
    if (!Array.isArray(topics)) throw new Error("Not an array");
  } catch {
    topics = [rawTopics.trim()]; // fallback: treat whole output as one topic
  }

  logStage("HOOK_TOPICS", topics);

  const allHooks = [];
  for (const topic of topics.slice(0, 3)) {
    console.log(`🔍 [hook-pipeline] Running all 8 agents for topic: "${topic}"`);
    const hooks = await runHookAgentsForTopic(topic, region, category);
    allHooks.push(...hooks);
    rememberTopic(topic);
  }

  logStage("HOOK_PIPELINE_COMPLETE", `${allHooks.length} total hooks generated across ${topics.length} topics`);
  return { hooks: allHooks, source, topics };
}

// Step 7 — HTTP Endpoints for Hook Pipeline
app.post("/generate-hooks", async (req, res) => {
  const { region = "India", category = "startup", agent = "all" } = req.body || {};
  try {
    const result = await runHookPipeline({ region, category, agentFilter: agent });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/generate-hooks/test", async (req, res) => {
  // Runs one hardcoded topic through all 8 agents — for testing without hitting live APIs
  const testTopic = "India's NEET exam results spark protests across 10 cities";
  try {
    const hooks = await runHookAgentsForTopic(testTopic, "India", "dmv_edtech");
    res.json({ ok: true, hooks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "shoro-bot", status: "running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, processing: isProcessing });
});

ensureFont().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});