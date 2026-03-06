import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import path from 'path';
import axios from 'axios';
import Parser from 'rss-parser';
import { WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const HTTP_PORT = Number(process.env.HTTP_PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 3001;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const NEWS_FETCH_INTERVAL = 15 * 60 * 1000;
const MARKET_FETCH_INTERVAL = 5 * 60 * 1000;
const MAX_NEWS_ITEMS = 500;
const NEWS_TTL = 24 * 60 * 60;

const REDIS_KEY_NEWS = 'warmonitor:news';
const REDIS_KEY_IDS = 'warmonitor:news:ids';
const REDIS_KEY_MARKETS = 'warmonitor:markets';

// ═══════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════

interface LocationEntry { lat: number; lng: number; country: string; flag: string; }
interface NewsLocation { lat: number; lng: number; country: string; flag: string; }

interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  priority: 'critical' | 'high' | 'general';
  location: NewsLocation | null;
  category: string;
}

interface MarketEntry { value: string; change: number; pct: number; }
type MarketData = Record<string, MarketEntry | null>;

// ═══════════════════════════════════════════════════════════════
// RSS SOURCES
// ═══════════════════════════════════════════════════════════════

const RSS_SOURCES = [
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'TRT World', url: 'https://www.trtworld.com/rss' },
];

// ═══════════════════════════════════════════════════════════════
// LOCATION MAP (90+ entries)
// ═══════════════════════════════════════════════════════════════

const LOCATION_MAP: Record<string, LocationEntry> = {
  'tehran':        { lat: 35.69, lng: 51.39, country: 'İran', flag: '🇮🇷' },
  'tahran':        { lat: 35.69, lng: 51.39, country: 'İran', flag: '🇮🇷' },
  'tel aviv':      { lat: 32.08, lng: 34.78, country: 'İsrail', flag: '🇮🇱' },
  'jerusalem':     { lat: 31.77, lng: 35.23, country: 'İsrail/Filistin', flag: '🇮🇱' },
  'kudüs':         { lat: 31.77, lng: 35.23, country: 'İsrail/Filistin', flag: '🇮🇱' },
  'beirut':        { lat: 33.89, lng: 35.50, country: 'Lübnan', flag: '🇱🇧' },
  'beyrut':        { lat: 33.89, lng: 35.50, country: 'Lübnan', flag: '🇱🇧' },
  'gaza':          { lat: 31.50, lng: 34.47, country: 'Filistin', flag: '🇵🇸' },
  'gazze':         { lat: 31.50, lng: 34.47, country: 'Filistin', flag: '🇵🇸' },
  'baghdad':       { lat: 33.31, lng: 44.37, country: 'Irak', flag: '🇮🇶' },
  'bağdat':        { lat: 33.31, lng: 44.37, country: 'Irak', flag: '🇮🇶' },
  'damascus':      { lat: 33.51, lng: 36.29, country: 'Suriye', flag: '🇸🇾' },
  'şam':           { lat: 33.51, lng: 36.29, country: 'Suriye', flag: '🇸🇾' },
  'riyadh':        { lat: 24.71, lng: 46.67, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'riyad':         { lat: 24.71, lng: 46.67, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'amman':         { lat: 31.95, lng: 35.93, country: 'Ürdün', flag: '🇯🇴' },
  'sanaa':         { lat: 15.35, lng: 44.21, country: 'Yemen', flag: '🇾🇪' },
  'sana':          { lat: 15.35, lng: 44.21, country: 'Yemen', flag: '🇾🇪' },
  'aden':          { lat: 12.79, lng: 45.02, country: 'Yemen', flag: '🇾🇪' },
  'muscat':        { lat: 23.59, lng: 58.54, country: 'Umman', flag: '🇴🇲' },
  'doha':          { lat: 25.29, lng: 51.53, country: 'Katar', flag: '🇶🇦' },
  'dubai':         { lat: 25.20, lng: 55.27, country: 'BAE', flag: '🇦🇪' },
  'abu dhabi':     { lat: 24.45, lng: 54.65, country: 'BAE', flag: '🇦🇪' },
  'kuwait city':   { lat: 29.38, lng: 47.99, country: 'Kuveyt', flag: '🇰🇼' },
  'aleppo':        { lat: 36.20, lng: 37.15, country: 'Suriye', flag: '🇸🇾' },
  'halep':         { lat: 36.20, lng: 37.15, country: 'Suriye', flag: '🇸🇾' },
  'mosul':         { lat: 36.34, lng: 43.14, country: 'Irak', flag: '🇮🇶' },
  'musul':         { lat: 36.34, lng: 43.14, country: 'Irak', flag: '🇮🇶' },
  'basra':         { lat: 30.51, lng: 47.81, country: 'Irak', flag: '🇮🇶' },
  'ramallah':      { lat: 31.90, lng: 35.20, country: 'Filistin', flag: '🇵🇸' },
  'hebron':        { lat: 31.53, lng: 35.10, country: 'Filistin', flag: '🇵🇸' },
  'nablus':        { lat: 32.22, lng: 35.26, country: 'Filistin', flag: '🇵🇸' },
  'isfahan':       { lat: 32.65, lng: 51.68, country: 'İran', flag: '🇮🇷' },
  'tabriz':        { lat: 38.08, lng: 46.29, country: 'İran', flag: '🇮🇷' },
  'rafah':         { lat: 31.28, lng: 34.25, country: 'Filistin', flag: '🇵🇸' },
  'khan younis':   { lat: 31.34, lng: 34.31, country: 'Filistin', flag: '🇵🇸' },
  'idlib':         { lat: 35.93, lng: 36.63, country: 'Suriye', flag: '🇸🇾' },
  'homs':          { lat: 34.73, lng: 36.71, country: 'Suriye', flag: '🇸🇾' },
  'palmyra':       { lat: 34.55, lng: 38.27, country: 'Suriye', flag: '🇸🇾' },
  'deir ez-zor':   { lat: 35.34, lng: 40.14, country: 'Suriye', flag: '🇸🇾' },
  'latakia':       { lat: 35.52, lng: 35.79, country: 'Suriye', flag: '🇸🇾' },
  'kirkuk':        { lat: 35.47, lng: 44.39, country: 'Irak', flag: '🇮🇶' },
  'erbil':         { lat: 36.19, lng: 44.01, country: 'Irak', flag: '🇮🇶' },
  'jeddah':        { lat: 21.49, lng: 39.19, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'mecca':         { lat: 21.39, lng: 39.86, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'medina':        { lat: 24.47, lng: 39.61, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'manama':        { lat: 26.23, lng: 50.59, country: 'Bahreyn', flag: '🇧🇭' },
  'moscow':        { lat: 55.76, lng: 37.62, country: 'Rusya', flag: '🇷🇺' },
  'moskova':       { lat: 55.76, lng: 37.62, country: 'Rusya', flag: '🇷🇺' },
  'washington':    { lat: 38.91, lng: -77.04, country: 'ABD', flag: '🇺🇸' },
  'london':        { lat: 51.51, lng: -0.13, country: 'İngiltere', flag: '🇬🇧' },
  'paris':         { lat: 48.86, lng: 2.35, country: 'Fransa', flag: '🇫🇷' },
  'beijing':       { lat: 39.90, lng: 116.40, country: 'Çin', flag: '🇨🇳' },
  'pekin':         { lat: 39.90, lng: 116.40, country: 'Çin', flag: '🇨🇳' },
  'berlin':        { lat: 52.52, lng: 13.41, country: 'Almanya', flag: '🇩🇪' },
  'ankara':        { lat: 39.93, lng: 32.86, country: 'Türkiye', flag: '🇹🇷' },
  'istanbul':      { lat: 41.01, lng: 28.98, country: 'Türkiye', flag: '🇹🇷' },
  'new york':      { lat: 40.71, lng: -74.01, country: 'ABD', flag: '🇺🇸' },
  'tokyo':         { lat: 35.68, lng: 139.69, country: 'Japonya', flag: '🇯🇵' },
  'new delhi':     { lat: 28.61, lng: 77.21, country: 'Hindistan', flag: '🇮🇳' },
  'cairo':         { lat: 30.04, lng: 31.24, country: 'Mısır', flag: '🇪🇬' },
  'kahire':        { lat: 30.04, lng: 31.24, country: 'Mısır', flag: '🇪🇬' },
  'rome':          { lat: 41.90, lng: 12.50, country: 'İtalya', flag: '🇮🇹' },
  'brussels':      { lat: 50.85, lng: 4.35, country: 'Belçika', flag: '🇧🇪' },
  'geneva':        { lat: 46.20, lng: 6.14, country: 'İsviçre', flag: '🇨🇭' },
  'madrid':        { lat: 40.42, lng: -3.70, country: 'İspanya', flag: '🇪🇸' },
  'warsaw':        { lat: 52.23, lng: 21.01, country: 'Polonya', flag: '🇵🇱' },
  'kyiv':          { lat: 50.45, lng: 30.52, country: 'Ukrayna', flag: '🇺🇦' },
  'kiev':          { lat: 50.45, lng: 30.52, country: 'Ukrayna', flag: '🇺🇦' },
  'kharkiv':       { lat: 49.99, lng: 36.23, country: 'Ukrayna', flag: '🇺🇦' },
  'odessa':        { lat: 46.48, lng: 30.73, country: 'Ukrayna', flag: '🇺🇦' },
  'mariupol':      { lat: 47.10, lng: 37.55, country: 'Ukrayna', flag: '🇺🇦' },
  'donetsk':       { lat: 48.00, lng: 37.80, country: 'Ukrayna', flag: '🇺🇦' },
  'luhansk':       { lat: 48.57, lng: 39.33, country: 'Ukrayna', flag: '🇺🇦' },
  'zaporizhzhia':  { lat: 47.84, lng: 35.14, country: 'Ukrayna', flag: '🇺🇦' },
  'crimea':        { lat: 44.95, lng: 34.10, country: 'Ukrayna/Rusya', flag: '🇺🇦' },
  'minsk':         { lat: 53.90, lng: 27.57, country: 'Belarus', flag: '🇧🇾' },
  'dnipro':        { lat: 48.46, lng: 35.05, country: 'Ukrayna', flag: '🇺🇦' },
  'kherson':       { lat: 46.64, lng: 32.62, country: 'Ukrayna', flag: '🇺🇦' },
  'lviv':          { lat: 49.84, lng: 24.03, country: 'Ukrayna', flag: '🇺🇦' },
  'tripoli':       { lat: 32.90, lng: 13.18, country: 'Libya', flag: '🇱🇾' },
  'benghazi':      { lat: 32.12, lng: 20.09, country: 'Libya', flag: '🇱🇾' },
  'khartoum':      { lat: 15.59, lng: 32.53, country: 'Sudan', flag: '🇸🇩' },
  'mogadishu':     { lat: 2.05, lng: 45.32, country: 'Somali', flag: '🇸🇴' },
  'addis ababa':   { lat: 9.02, lng: 38.75, country: 'Etiyopya', flag: '🇪🇹' },
  'nairobi':       { lat: -1.29, lng: 36.82, country: 'Kenya', flag: '🇰🇪' },
  'kabul':         { lat: 34.53, lng: 69.17, country: 'Afganistan', flag: '🇦🇫' },
  'islamabad':     { lat: 33.69, lng: 73.04, country: 'Pakistan', flag: '🇵🇰' },
  'taipei':        { lat: 25.03, lng: 121.57, country: 'Tayvan', flag: '🇹🇼' },
  'pyongyang':     { lat: 39.04, lng: 125.76, country: 'Kuzey Kore', flag: '🇰🇵' },
  'seoul':         { lat: 37.57, lng: 126.98, country: 'Güney Kore', flag: '🇰🇷' },
  'iran':          { lat: 32.43, lng: 53.69, country: 'İran', flag: '🇮🇷' },
  'israel':        { lat: 31.05, lng: 34.85, country: 'İsrail', flag: '🇮🇱' },
  'lebanon':       { lat: 33.85, lng: 35.86, country: 'Lübnan', flag: '🇱🇧' },
  'lübnan':        { lat: 33.85, lng: 35.86, country: 'Lübnan', flag: '🇱🇧' },
  'syria':         { lat: 34.80, lng: 38.99, country: 'Suriye', flag: '🇸🇾' },
  'suriye':        { lat: 34.80, lng: 38.99, country: 'Suriye', flag: '🇸🇾' },
  'iraq':          { lat: 33.22, lng: 43.68, country: 'Irak', flag: '🇮🇶' },
  'irak':          { lat: 33.22, lng: 43.68, country: 'Irak', flag: '🇮🇶' },
  'yemen':         { lat: 15.55, lng: 48.52, country: 'Yemen', flag: '🇾🇪' },
  'palestine':     { lat: 31.95, lng: 35.23, country: 'Filistin', flag: '🇵🇸' },
  'filistin':      { lat: 31.95, lng: 35.23, country: 'Filistin', flag: '🇵🇸' },
  'ukraine':       { lat: 48.38, lng: 31.17, country: 'Ukrayna', flag: '🇺🇦' },
  'ukrayna':       { lat: 48.38, lng: 31.17, country: 'Ukrayna', flag: '🇺🇦' },
  'russia':        { lat: 61.52, lng: 105.32, country: 'Rusya', flag: '🇷🇺' },
  'rusya':         { lat: 61.52, lng: 105.32, country: 'Rusya', flag: '🇷🇺' },
  'libya':         { lat: 26.34, lng: 17.23, country: 'Libya', flag: '🇱🇾' },
  'sudan':         { lat: 12.86, lng: 30.22, country: 'Sudan', flag: '🇸🇩' },
  'somalia':       { lat: 5.15, lng: 46.20, country: 'Somali', flag: '🇸🇴' },
  'afghanistan':   { lat: 33.94, lng: 67.71, country: 'Afganistan', flag: '🇦🇫' },
  'pakistan':       { lat: 30.38, lng: 69.35, country: 'Pakistan', flag: '🇵🇰' },
  'taiwan':        { lat: 23.70, lng: 120.96, country: 'Tayvan', flag: '🇹🇼' },
  'saudi arabia':  { lat: 23.89, lng: 45.08, country: 'Suudi Arabistan', flag: '🇸🇦' },
  'türkiye':       { lat: 38.96, lng: 35.24, country: 'Türkiye', flag: '🇹🇷' },
  'turkey':        { lat: 38.96, lng: 35.24, country: 'Türkiye', flag: '🇹🇷' },
  'egypt':         { lat: 26.82, lng: 30.80, country: 'Mısır', flag: '🇪🇬' },
  'mısır':         { lat: 26.82, lng: 30.80, country: 'Mısır', flag: '🇪🇬' },
  'north korea':   { lat: 40.34, lng: 127.51, country: 'Kuzey Kore', flag: '🇰🇵' },
  'south korea':   { lat: 35.91, lng: 127.77, country: 'Güney Kore', flag: '🇰🇷' },
  'china':         { lat: 35.86, lng: 104.20, country: 'Çin', flag: '🇨🇳' },
  'united states': { lat: 37.09, lng: -95.71, country: 'ABD', flag: '🇺🇸' },
};

const LOCATION_KEYS = Object.keys(LOCATION_MAP).sort((a, b) => b.length - a.length);

// ═══════════════════════════════════════════════════════════════
// PRIORITY KEYWORDS
// ═══════════════════════════════════════════════════════════════

const CRITICAL_KEYWORDS = [
  'attack', 'attacked', 'missile', 'missiles', 'killed', 'kill', 'dead',
  'war', 'strike', 'strikes', 'airstrike', 'airstrikes', 'explosion',
  'bomb', 'bombing', 'bombings', 'shelling', 'invasion', 'massacre',
  'genocide', 'casualties', 'death toll', 'combat', 'offensive',
  'assassination', 'assassinated',
  'saldırı', 'füze', 'ölü', 'öldürüldü', 'savaş', 'patlama',
  'bomba', 'bombardman', 'hava saldırısı', 'istila', 'katliam',
  'çatışma', 'operasyon', 'şehit', 'suikast',
];

const HIGH_KEYWORDS = [
  'threat', 'warning', 'sanctions', 'sanction', 'protest', 'protests',
  'tension', 'tensions', 'crisis', 'emergency', 'evacuation', 'ceasefire',
  'military', 'troops', 'deploy', 'deployed', 'nuclear', 'weapons',
  'drone', 'drones', 'hostage', 'hostages', 'refugee', 'refugees',
  'displacement', 'humanitarian', 'blockade', 'siege', 'coup',
  'tehdit', 'uyarı', 'yaptırım', 'protesto', 'gerilim', 'kriz',
  'acil', 'tahliye', 'ateşkes', 'askeri', 'silah', 'nükleer',
  'insansız hava aracı', 'iha', 'siha', 'rehine', 'mülteci',
  'abluka', 'kuşatma', 'darbe',
];

// ═══════════════════════════════════════════════════════════════
// MARKET SYMBOLS
// ═══════════════════════════════════════════════════════════════

const MARKET_SYMBOLS: { key: string; symbol: string }[] = [
  { key: 'bist',   symbol: 'XU100.IS' },
  { key: 'sp500',  symbol: '^GSPC' },
  { key: 'nasdaq', symbol: '^IXIC' },
  { key: 'usd',    symbol: 'USDTRY=X' },
  { key: 'eur',    symbol: 'EURTRY=X' },
  { key: 'gold',   symbol: 'GC=F' },
];

// ═══════════════════════════════════════════════════════════════
// SERVICE INIT
// ═══════════════════════════════════════════════════════════════

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null;
    return Math.min(times * 500, 3000);
  },
});

redis.on('error', (err) => log('REDIS', `Hata: ${err.message}`));
redis.on('connect', () => log('REDIS', 'Bağlandı'));

const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'CoreX-WarMonitor/1.0',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
});

const app = express();

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve monitor.html at /monitor
const monitorPath = path.resolve(__dirname, '..', '..', '..', 'monitor.html');
app.get('/monitor', (_req: Request, res: Response) => {
  res.sendFile(monitorPath);
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function md5(text: string): string {
  return createHash('md5').update(text.trim().toLowerCase()).digest('hex');
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function detectLocation(text: string): NewsLocation | null {
  const lower = text.toLowerCase();
  for (const key of LOCATION_KEYS) {
    const idx = lower.indexOf(key);
    if (idx === -1) continue;
    const charBefore = idx === 0 ? ' ' : lower[idx - 1];
    const charAfter = idx + key.length >= lower.length ? ' ' : lower[idx + key.length];
    if (/[a-zA-Z0-9]/.test(charBefore) || /[a-zA-Z0-9]/.test(charAfter)) continue;
    const loc = LOCATION_MAP[key];
    return { lat: loc.lat, lng: loc.lng, country: loc.country, flag: loc.flag };
  }
  return null;
}

function detectPriority(text: string): 'critical' | 'high' | 'general' {
  const lower = text.toLowerCase();
  for (const kw of CRITICAL_KEYWORDS) {
    if (lower.includes(kw)) return 'critical';
  }
  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) return 'high';
  }
  return 'general';
}

// ═══════════════════════════════════════════════════════════════
// RSS FETCHING
// ═══════════════════════════════════════════════════════════════

async function fetchSingleFeed(source: { name: string; url: string }): Promise<NewsItem[]> {
  try {
    const feed = await rssParser.parseURL(source.url);
    const items: NewsItem[] = [];

    for (const entry of feed.items || []) {
      const title = (entry.title || '').trim();
      if (!title) continue;

      const id = md5(title);
      const fullText = `${title} ${entry.contentSnippet || ""}`;
      const publishedAt = entry.pubDate
        ? Math.floor(new Date(entry.pubDate).getTime() / 1000)
        : Math.floor(Date.now() / 1000);
      const priority = detectPriority(fullText);

      items.push({
        id,
        title,
        source: source.name,
        url: entry.link || '',
        publishedAt,
        priority,
        location: detectLocation(fullText),
        category: priority,
      });
    }

    log('RSS', `${source.name}: ${items.length} haber`);
    return items;
  } catch (err: any) {
    log('RSS', `${source.name} HATA: ${err.message}`);
    return [];
  }
}

async function fetchAllFeeds(): Promise<void> {
  log('RSS', 'Tüm kaynaklar taranıyor...');

  const results = await Promise.allSettled(
    RSS_SOURCES.map((src) => fetchSingleFeed(src))
  );

  const allItems: NewsItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    }
  }

  let newCount = 0;
  const pipeline = redis.pipeline();

  for (const item of allItems) {
    const isDup = await redis.sismember(REDIS_KEY_IDS, item.id);
    if (isDup) continue;

    pipeline.zadd(REDIS_KEY_NEWS, item.publishedAt, JSON.stringify(item));
    pipeline.sadd(REDIS_KEY_IDS, item.id);
    newCount++;

    broadcastWs({ type: 'news', item });
  }

  if (newCount > 0) {
    await pipeline.exec();

    const total = await redis.zcard(REDIS_KEY_NEWS);
    if (total > MAX_NEWS_ITEMS) {
      const toRemove = await redis.zrange(REDIS_KEY_NEWS, 0, total - MAX_NEWS_ITEMS - 1);
      const cleanupPipeline = redis.pipeline();
      for (const raw of toRemove) {
        try {
          const parsed = JSON.parse(raw);
          cleanupPipeline.srem(REDIS_KEY_IDS, parsed.id);
        } catch { /* skip */ }
      }
      await cleanupPipeline.exec();
      await redis.zremrangebyrank(REDIS_KEY_NEWS, 0, total - MAX_NEWS_ITEMS - 1);
    }

    await redis.expire(REDIS_KEY_NEWS, NEWS_TTL);
    await redis.expire(REDIS_KEY_IDS, NEWS_TTL);
  }

  log('RSS', `Tamamlandı: +${newCount} yeni (${allItems.length} tarandı)`);
}

// ═══════════════════════════════════════════════════════════════
// MARKET DATA (Yahoo Finance)
// ═══════════════════════════════════════════════════════════════

async function fetchMarketSymbol(symbol: string): Promise<MarketEntry | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'CoreX-WarMonitor/1.0' },
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prevClose;
    const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0;

    return {
      value: price.toLocaleString('tr-TR', { maximumFractionDigits: 2 }),
      change: parseFloat(change.toFixed(2)),
      pct: parseFloat(pct.toFixed(2)),
    };
  } catch (err: any) {
    log('MARKET', `${symbol} HATA: ${err.message}`);
    return null;
  }
}

async function fetchAllMarkets(): Promise<void> {
  log('MARKET', 'Piyasa verileri güncelleniyor...');

  const data: MarketData = {};
  const pipeline = redis.pipeline();

  const results = await Promise.allSettled(
    MARKET_SYMBOLS.map(async (m) => {
      const entry = await fetchMarketSymbol(m.symbol);
      return { key: m.key, entry };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.entry) {
      const { key, entry } = result.value;
      data[key] = entry;
      pipeline.hset(REDIS_KEY_MARKETS, key, JSON.stringify(entry));
    }
  }

  await pipeline.exec();
  broadcastWs({ type: 'markets', data });

  const count = Object.values(data).filter(Boolean).length;
  log('MARKET', `Güncellendi: ${count}/${MARKET_SYMBOLS.length} sembol`);
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

const wss = new WebSocketServer({ port: WS_PORT });
const wsClients = new Set<WebSocket>();

wss.on('connection', async (socket) => {
  wsClients.add(socket);
  log('WS', `+1 bağlantı (toplam: ${wsClients.size})`);

  try {
    const rawItems = await redis.zrevrange(REDIS_KEY_NEWS, 0, 49);
    const items = rawItems
      .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(Boolean);
    socket.send(JSON.stringify({ type: 'init', items }));
  } catch (err: any) {
    log('WS', `Init hatası: ${err.message}`);
  }

  socket.on('close', () => {
    wsClients.delete(socket);
    log('WS', `-1 bağlantı (toplam: ${wsClients.size})`);
  });

  socket.on('error', () => wsClients.delete(socket));
});

function broadcastWs(data: object): void {
  if (wsClients.size === 0) return;
  const payload = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

log('WS', `WebSocket sunucusu :${WS_PORT} portunda dinliyor`);

// ═══════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════

app.get('/api/news', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const category = (req.query.category as string) || 'all';

    const fetchCount = category === 'all' ? limit : limit * 3;
    const rawItems = await redis.zrevrange(REDIS_KEY_NEWS, 0, fetchCount - 1);

    let items: NewsItem[] = rawItems
      .map((raw) => { try { return JSON.parse(raw) as NewsItem; } catch { return null as any; } })
      .filter(Boolean);

    if (category !== 'all') {
      items = items.filter((item) => item.priority === category);
    }

    res.json(items.slice(0, limit));
  } catch (err: any) {
    log('API', `/api/news HATA: ${err.message}`);
    res.status(500).json({ error: 'Haberler alınamadı' });
  }
});

app.get('/api/markets', async (_req: Request, res: Response) => {
  try {
    const raw = await redis.hgetall(REDIS_KEY_MARKETS);
    const data: Record<string, MarketEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      try { data[key] = JSON.parse(value); } catch { /* skip */ }
    }
    res.json(data);
  } catch (err: any) {
    log('API', `/api/markets HATA: ${err.message}`);
    res.status(500).json({ error: 'Piyasa verileri alınamadı' });
  }
});

app.get('/health', async (_req: Request, res: Response) => {
  const redisOk = redis.status === 'ready';
  let newsCount = 0;
  try { newsCount = await redis.zcard(REDIS_KEY_NEWS); } catch { /* 0 */ }

  res.json({
    status: redisOk ? 'ok' : 'degraded',
    redis: redis.status,
    newsCount,
    wsClients: wsClients.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════

app.listen(HTTP_PORT, () => {
  log('HTTP', `API sunucusu http://localhost:${HTTP_PORT}`);
  log('HTTP', '  GET /api/news?limit=50&category=all|critical|high|general');
  log('HTTP', '  GET /api/markets');
  log('HTTP', '  GET /health');
  log('HTTP', '  GET /monitor');
});

(async () => {
  try {
    await Promise.allSettled([fetchAllFeeds(), fetchAllMarkets()]);
    log('SYS', 'İlk veri çekme tamamlandı');
  } catch (err: any) {
    log('SYS', `Başlatma hatası: ${err.message}`);
  }
})();

setInterval(fetchAllFeeds, NEWS_FETCH_INTERVAL);
setInterval(fetchAllMarkets, MARKET_FETCH_INTERVAL);

function shutdown() {
  log('SYS', 'Kapatılıyor...');
  wss.close();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
