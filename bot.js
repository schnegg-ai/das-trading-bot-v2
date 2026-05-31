/**
 * DAS Trading Bot v2 — 6-Confluence Framework
 * ─────────────────────────────────────────────────────────────
 * Basiert auf: DAS Trading Handbuch
 *
 * Strategie: 6 Confluences müssen ALLE zutreffen:
 *   1. Marktstruktur     → HH+HL (bullish) oder LH+LL (bearish)
 *   2. Top-Down-Analyse  → 4H + 1H + 15m müssen übereinstimmen
 *   3. AOI               → Preiszone mit 3+ Touches
 *   4. Break of Structure→ Preis bricht AOI klar
 *   5. Retest            → Preis kehrt zur gebrochenen Zone zurück
 *   6. Candlestick       → Morning Star / Evening Star / Engulfing
 *
 * Assets:
 *   Crypto  → Kraken  (XBTUSDT, ETHUSDT, SOLUSDT, XRPUSDT, ADAUSDT)
 *   Aktien  → Alpaca  (NVDA, TSLA, AAPL, AMZN, MSFT)
 *
 *  node bot.js        → Strategie für alle Assets
 *  node bot.js --pnl  → Portfolio-Übersicht
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Credentials Check ───────────────────────────────────────────────────────

if (!process.env.KRAKEN_API_KEY || !process.env.KRAKEN_SECRET_KEY) {
  console.log("⚠️  KRAKEN_API_KEY oder KRAKEN_SECRET_KEY fehlen in .env");
  process.exit(0);
}
if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  console.log("⚠️  ALPACA_API_KEY oder ALPACA_SECRET_KEY fehlen in .env");
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CRYPTO_COINS  = (process.env.CRYPTO_COINS || "XBTUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ADAUSDT").split(",").map(s => s.trim());
const STOCK_SYMBOLS = (process.env.STOCK_SYMBOLS || "NVDA,TSLA,AAPL,AMZN,MSFT").split(",").map(s => s.trim());

const CONFIG = {
  initialCapital:  parseFloat(process.env.INITIAL_CAPITAL_USD || "100"),
  compoundPct:     parseFloat(process.env.COMPOUND_PCT        || "0.10"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  targetUSD:       parseFloat(process.env.TARGET_USD          || "1000"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  stopLossPct:   0.005,    // 0.5%
  takeProfitPct: 0.015,    // 1.5% → 1:3 RR
  swingLookback: 3,        // Kerzen links/rechts für Swing-Erkennung
  aoiTolerance:  0.004,    // 0.4% Toleranz für AOI-Clustering
  aoiMinTouches: 3,        // Mindestanzahl Touches für AOI
  retestTolerance: 0.006,  // 0.6% Toleranz für Retest-Erkennung
  kraken: {
    apiKey:    process.env.KRAKEN_API_KEY,
    secretKey: process.env.KRAKEN_SECRET_KEY,
    baseUrl:   "https://api.kraken.com",
  },
  alpaca: {
    apiKey:    process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl:   "https://paper-api.alpaca.markets",
    dataUrl:   "https://data.alpaca.markets",
  },
  smtp: {
    email:    process.env.SMTP_EMAIL,
    password: process.env.SMTP_PASSWORD,
    reportTo: process.env.REPORT_EMAIL,
  },
};

const FEE_RATE = 0.001; // 0.1% (Alpaca = kostenlos, Kraken ~0.26%)

// ─── File Helpers ─────────────────────────────────────────────────────────────

const posFile   = (sym, type) => `position_${type}_${sym}.json`;
const csvFile   = (sym, type) => `trades_${type}_${sym}.csv`;
const pfFile    = (sym, type) => `portfolio_${type}_${sym}.json`;
const stateFile = (sym, type) => `state_${type}_${sym}.json`;   // BOS/Retest State

// ─── Portfolio / Compounding ──────────────────────────────────────────────────

function loadPortfolio(sym, type) {
  const f = pfFile(sym, type);
  if (!existsSync(f)) {
    const p = { symbol: sym, type, value: CONFIG.initialCapital, initialValue: CONFIG.initialCapital,
      trades: 0, wins: 0, losses: 0, totalPnL: 0, startDate: new Date().toISOString() };
    writeFileSync(f, JSON.stringify(p, null, 2));
    return p;
  }
  return JSON.parse(readFileSync(f, "utf8"));
}

function updatePortfolio(sym, type, pnlUSD) {
  const p = loadPortfolio(sym, type);
  p.value    = Math.max(p.value + pnlUSD, 0.01);
  p.trades  += 1;
  p.totalPnL += pnlUSD;
  if (pnlUSD >= 0) p.wins += 1; else p.losses += 1;
  writeFileSync(pfFile(sym, type), JSON.stringify(p, null, 2));
  return p;
}

function getTradeSize(sym, type) {
  const p = loadPortfolio(sym, type);
  return Math.min(p.value * CONFIG.compoundPct, CONFIG.maxTradeSizeUSD);
}

// ─── Position Tracking ────────────────────────────────────────────────────────

function loadPosition(sym, type)      { const f = posFile(sym, type); if (!existsSync(f)) return null; return JSON.parse(readFileSync(f, "utf8")) || null; }
function savePosition(sym, type, pos) { writeFileSync(posFile(sym, type), JSON.stringify(pos, null, 2)); }
function clearPosition(sym, type)     { writeFileSync(posFile(sym, type), "null"); }

// ─── State (BOS/Retest) ───────────────────────────────────────────────────────

function loadState(sym, type)       { const f = stateFile(sym, type); if (!existsSync(f)) return {}; return JSON.parse(readFileSync(f, "utf8")); }
function saveState(sym, type, state){ writeFileSync(stateFile(sym, type), JSON.stringify(state, null, 2)); }

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADER = "Date,Time UTC,Exchange,Symbol,Type,Action,Side,Quantity,Entry Price,Exit Price,Size USD,Fee,P&L USD,P&L %,Exit Reason,Confluences,Order ID,Mode,Portfolio,Notes\n";

function initCsv(sym, type) {
  if (!existsSync(csvFile(sym, type))) writeFileSync(csvFile(sym, type), CSV_HEADER);
}

function writeCsvRow(sym, type, row) {
  const fee  = (row.sizeUSD * FEE_RATE).toFixed(4);
  const mode = CONFIG.paperTrading ? "PAPER" : "LIVE";
  const line = [
    row.date, row.time, type === "stock" ? "Alpaca" : "Kraken",
    sym, type.toUpperCase(), row.action, row.side, row.quantity,
    row.entryPrice != null ? row.entryPrice.toFixed(4) : "",
    row.exitPrice  != null ? row.exitPrice.toFixed(4)  : "",
    row.sizeUSD    != null ? row.sizeUSD.toFixed(2)    : "",
    fee,
    row.pnlUSD  != null ? row.pnlUSD.toFixed(2)       : "",
    row.pnlPct  != null ? row.pnlPct.toFixed(3) + "%" : "",
    row.exitReason || "", `"${row.confluences || ""}"`, row.orderId || "", mode,
    row.portfolioValue != null ? row.portfolioValue.toFixed(2) : "",
    `"${row.notes || ""}"`,
  ].join(",");
  appendFileSync(csvFile(sym, type), line + "\n");
}

// ─── Market Data — Kraken ─────────────────────────────────────────────────────

const KRAKEN_INTERVALS = { "15m":"15", "1H":"60", "4H":"240" };

async function fetchKrakenCandles(symbol, tf, limit = 200) {
  const pair = symbol.replace(/^BTC/, "XBT");
  const interval = KRAKEN_INTERVALS[tf] || "15";
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}&count=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error[0]);
  const key = Object.keys(data.result).find(k => k !== "last");
  return data.result[key].map(k => ({
    time: k[0] * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[6]),
  }));
}

// ─── Market Data — Alpaca ─────────────────────────────────────────────────────

const ALPACA_TF = { "15m":"15Min", "1H":"1Hour", "4H":"4Hour" };

async function fetchAlpacaCandles(symbol, tf, limit = 200) {
  const timeframe = ALPACA_TF[tf] || "15Min";
  const url = `${CONFIG.alpaca.dataUrl}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (!res.ok) throw new Error(`Alpaca HTTP ${res.status}`);
  const data = await res.json();
  if (!data.bars || data.bars.length === 0) throw new Error(`Keine Daten für ${symbol}`);
  return data.bars.map(b => ({
    time:   new Date(b.t).getTime(),
    open:   b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

// ─── Markt-Session Check ──────────────────────────────────────────────────────

function isUSMarketOpen() {
  const now = new Date();
  const etOffset = -4; // EDT (Sommerzeit)
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin  = now.getUTCMinutes();
  const etTime = etHour * 60 + etMin;
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // Wochenende
  return etTime >= 570 && etTime <= 960; // 9:30 - 16:00 ET
}

// ─── Indikator: Swing Points ──────────────────────────────────────────────────

function detectSwingPoints(candles, lookback = CONFIG.swingLookback) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isHigh = candles.slice(i - lookback, i).every(c => c.high  <= candles[i].high) &&
                   candles.slice(i + 1, i + lookback + 1).every(c => c.high  <= candles[i].high);
    const isLow  = candles.slice(i - lookback, i).every(c => c.low   >= candles[i].low)  &&
                   candles.slice(i + 1, i + lookback + 1).every(c => c.low   >= candles[i].low);
    if (isHigh) swings.push({ type: "high", price: candles[i].high, index: i });
    if (isLow)  swings.push({ type: "low",  price: candles[i].low,  index: i });
  }
  return swings;
}

// ─── Indikator: Marktstruktur ─────────────────────────────────────────────────

function detectStructure(swings) {
  const highs = swings.filter(s => s.type === "high").slice(-3);
  const lows  = swings.filter(s => s.type === "low").slice(-3);
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const hh = highs[highs.length-1].price > highs[highs.length-2].price;
  const hl = lows[lows.length-1].price   > lows[lows.length-2].price;
  const lh = highs[highs.length-1].price < highs[highs.length-2].price;
  const ll = lows[lows.length-1].price   < lows[lows.length-2].price;

  if (hh && hl) return "bullish";
  if (lh && ll) return "bearish";
  return "neutral";
}

// ─── Indikator: Top-Down-Analyse ──────────────────────────────────────────────

async function topDownAnalysis(symbol, isStock) {
  const fetch4H = isStock ? fetchAlpacaCandles(symbol, "4H") : fetchKrakenCandles(symbol, "4H");
  const fetch1H = isStock ? fetchAlpacaCandles(symbol, "1H") : fetchKrakenCandles(symbol, "1H");
  const [c4H, c1H] = await Promise.all([fetch4H, fetch1H]);

  const s4H = detectStructure(detectSwingPoints(c4H));
  const s1H = detectStructure(detectSwingPoints(c1H));

  return { s4H, s1H, agree: s4H !== "neutral" && s4H === s1H };
}

// ─── Indikator: AOI (Area of Interest) ───────────────────────────────────────

function detectAOI(candles) {
  const points = [];
  candles.slice(-100).forEach(c => { points.push(c.high); points.push(c.low); });
  points.sort((a, b) => a - b);

  const zones = [];
  for (let i = 0; i < points.length; i++) {
    const price = points[i];
    const range = price * CONFIG.aoiTolerance;
    const touches = points.filter(p => Math.abs(p - price) <= range).length;
    if (touches >= CONFIG.aoiMinTouches) {
      const exists = zones.find(z => Math.abs(z.price - price) <= range * 3);
      if (!exists) zones.push({ price, touches, range });
    }
  }
  return zones.sort((a, b) => b.touches - a.touches);
}

// ─── Indikator: Break of Structure ───────────────────────────────────────────

function detectBOS(candles, structure, aois) {
  if (aois.length === 0 || structure === "neutral") return null;
  const curr = candles[candles.length - 1].close;
  const prev = candles[candles.length - 2].close;

  for (const aoi of aois.slice(0, 5)) {
    if (structure === "bullish" && prev < aoi.price && curr > aoi.price * 1.001)
      return { type: "bullish_break", level: aoi.price, aoi };
    if (structure === "bearish" && prev > aoi.price && curr < aoi.price * 0.999)
      return { type: "bearish_break", level: aoi.price, aoi };
  }
  return null;
}

// ─── Indikator: Retest ────────────────────────────────────────────────────────

function detectRetest(candles, bosLevel, bosType) {
  if (!bosLevel) return false;
  const curr  = candles[candles.length - 1].close;
  const range = bosLevel * CONFIG.retestTolerance;
  const isNear = Math.abs(curr - bosLevel) <= range;
  if (!isNear) return false;

  // War der Preis zwischendurch weg von der Zone?
  const prevCandles = candles.slice(-8, -1);
  const wasAway = bosType === "bullish_break"
    ? prevCandles.some(c => c.close > bosLevel + range * 2)
    : prevCandles.some(c => c.close < bosLevel - range * 2);

  return wasAway;
}

// ─── Indikator: Candlestick Pattern ──────────────────────────────────────────

function detectCandlestick(candles) {
  const n = candles.length;
  if (n < 3) return null;
  const [c1, c2, c3] = [candles[n-3], candles[n-2], candles[n-1]];

  const body1 = Math.abs(c1.close - c1.open);
  const body2 = Math.abs(c2.close - c2.open);
  const body3 = Math.abs(c3.close - c3.open);
  const lowerShadow3 = Math.min(c3.open, c3.close) - c3.low;
  const upperShadow3 = c3.high - Math.max(c3.open, c3.close);

  // Morning Star → Long Signal
  if (c1.close < c1.open && body2 < body1 * 0.4 && c3.close > c3.open &&
      c3.close > (c1.open + c1.close) / 2)
    return { pattern: "Morning Star", signal: "buy", strength: "⭐⭐⭐" };

  // Evening Star → Short Signal
  if (c1.close > c1.open && body2 < body1 * 0.4 && c3.close < c3.open &&
      c3.close < (c1.open + c1.close) / 2)
    return { pattern: "Evening Star", signal: "sell", strength: "⭐⭐⭐" };

  // Bullish Engulfing → Long Signal
  if (c2.close < c2.open && c3.close > c3.open &&
      c3.close > c2.open && c3.open < c2.close)
    return { pattern: "Bullish Engulfing", signal: "buy", strength: "⭐⭐" };

  // Bearish Engulfing → Short Signal
  if (c2.close > c2.open && c3.close < c3.open &&
      c3.close < c2.open && c3.open > c2.close)
    return { pattern: "Bearish Engulfing", signal: "sell", strength: "⭐⭐" };

  // Hammer → Long Signal
  if (lowerShadow3 > body3 * 2 && upperShadow3 < body3 * 0.5 && c3.close > c3.open)
    return { pattern: "Hammer", signal: "buy", strength: "⭐⭐" };

  // Shooting Star → Short Signal
  if (upperShadow3 > body3 * 2 && lowerShadow3 < body3 * 0.5 && c3.close < c3.open)
    return { pattern: "Shooting Star", signal: "sell", strength: "⭐⭐" };

  return null;
}

// ─── Kraken Order ─────────────────────────────────────────────────────────────

function signKraken(path, nonce, body) {
  const h = crypto.createHash("sha256").update(nonce + body).digest();
  const s = Buffer.from(CONFIG.kraken.secretKey, "base64");
  return crypto.createHmac("sha512", s).update(Buffer.concat([Buffer.from(path, "latin1"), h])).digest("base64");
}

async function placeKrakenOrder(symbol, side, sizeUSD, price) {
  const pair   = symbol.replace(/^BTC/, "XBT");
  const volume = (sizeUSD / price).toFixed(8);
  const nonce  = Date.now().toString();
  const body   = new URLSearchParams({ nonce, ordertype: "market", type: side, volume, pair }).toString();
  const path   = "/0/private/AddOrder";
  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "API-Key": CONFIG.kraken.apiKey, "API-Sign": signKraken(path, nonce, body) },
    body,
  });
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error.join(", "));
  return data.result;
}

// ─── Alpaca Order ─────────────────────────────────────────────────────────────

async function placeAlpacaOrder(symbol, side, sizeUSD) {
  const body = JSON.stringify({ symbol, notional: sizeUSD.toFixed(2), side, type: "market", time_in_force: "day" });
  const res = await fetch(`${CONFIG.alpaca.baseUrl}/v2/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
    body,
  });
  const data = await res.json();
  if (data.code) throw new Error(data.message || "Alpaca Order Fehler");
  return data;
}

// ─── Exit Check ───────────────────────────────────────────────────────────────

function checkExit(pos, price) {
  const { side, entryPrice, stopLoss, takeProfit, sizeUSD } = pos;
  const pnlPct = side === "buy"
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
  const pnlUSD = (pnlPct / 100) * sizeUSD;

  if (side === "buy"  && price <= stopLoss)   return { shouldExit: true, reason: "Stop Loss",   pnlPct, pnlUSD };
  if (side === "sell" && price >= stopLoss)   return { shouldExit: true, reason: "Stop Loss",   pnlPct, pnlUSD };
  if (side === "buy"  && price >= takeProfit) return { shouldExit: true, reason: "Take Profit", pnlPct, pnlUSD };
  if (side === "sell" && price <= takeProfit) return { shouldExit: true, reason: "Take Profit", pnlPct, pnlUSD };
  return { shouldExit: false, pnlPct, pnlUSD };
}

// ─── Portfolio Übersicht ──────────────────────────────────────────────────────

function showAllPnL() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  DAS BOT v2 — PORTFOLIO ÜBERSICHT");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\n  ${"Asset".padEnd(10)} ${"Typ".padEnd(7)} ${"Portfolio".padEnd(12)} ${"ROI".padEnd(10)} ${"Trades".padEnd(8)} ${"Win%"}`);
  console.log("  " + "─".repeat(58));

  let totalValue = 0;
  const allAssets = [
    ...CRYPTO_COINS.map(s  => ({ sym: s, type: "crypto" })),
    ...STOCK_SYMBOLS.map(s => ({ sym: s, type: "stock"  })),
  ];

  for (const { sym, type } of allAssets) {
    const p       = loadPortfolio(sym, type);
    const roi     = ((p.value - p.initialValue) / p.initialValue * 100).toFixed(2);
    const winRate = p.trades > 0 ? ((p.wins / p.trades) * 100).toFixed(1) : "0.0";
    const icon    = parseFloat(roi) >= 0 ? "🟢" : "🔴";
    const badge   = type === "stock" ? "📈" : "🪙";
    console.log(`  ${icon} ${sym.padEnd(8)} ${badge} ${type.padEnd(5)} $${p.value.toFixed(2).padEnd(10)} ${((parseFloat(roi) >= 0 ? "+" : "") + roi + "%").padEnd(10)} ${p.trades.toString().padEnd(8)} ${winRate}%`);
    totalValue += p.value;
  }

  const totalInvested = CONFIG.initialCapital * allAssets.length;
  const totalROI      = ((totalValue - totalInvested) / totalInvested * 100).toFixed(2);
  console.log("  " + "─".repeat(58));
  console.log(`\n  Investiert:  $${totalInvested.toFixed(2)}`);
  console.log(`  Aktuell:     $${totalValue.toFixed(2)}`);
  console.log(`  Gesamt ROI:  ${parseFloat(totalROI) >= 0 ? "+" : ""}${totalROI}%`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Strategie für ein Asset ──────────────────────────────────────────────────

async function runAsset(symbol, type) {
  const isStock = type === "stock";
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  try {
    // US-Aktien: nur während Marktzeiten
    if (isStock && !isUSMarketOpen()) {
      console.log(`  💤 ${symbol.padEnd(6)} [STOCK] Markt geschlossen (09:30-16:00 ET)`);
      return;
    }

    // Daten holen
    const candles15m = isStock
      ? await fetchAlpacaCandles(symbol, "15m")
      : await fetchKrakenCandles(symbol, "15m");

    const price     = candles15m[candles15m.length - 1].close;
    const portfolio = loadPortfolio(symbol, type);
    const tradeSize = getTradeSize(symbol, type);

    const fmt = (p) => p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p.toFixed(4);

    // ── Exit-Check wenn Position offen ──────────────────────────────────────
    const position = loadPosition(symbol, type);
    if (position) {
      const exit = checkExit(position, price);
      const icon = exit.pnlUSD >= 0 ? "🟢" : "🔴";

      if (exit.shouldExit) {
        console.log(`  ${icon} ${symbol.padEnd(6)} CLOSE ${position.side.toUpperCase()} @ $${fmt(price)} | ${exit.reason} | P&L: ${exit.pnlUSD >= 0 ? "+" : ""}$${exit.pnlUSD.toFixed(2)}`);

        let orderId = `PAPER-CLOSE-${Date.now()}`;
        if (!CONFIG.paperTrading) {
          try {
            if (isStock) {
              const exitSide = position.side === "buy" ? "sell" : "buy";
              const order = await placeAlpacaOrder(symbol, exitSide, position.sizeUSD);
              orderId = order.id || orderId;
            } else {
              const exitSide = position.side === "buy" ? "sell" : "buy";
              const order = await placeKrakenOrder(symbol, exitSide, position.sizeUSD, price);
              orderId = order.txid?.[0] || orderId;
            }
          } catch (err) { console.log(`  ❌ ${symbol}: Exit-Order Fehler — ${err.message}`); }
        }

        const updatedPF = updatePortfolio(symbol, type, exit.pnlUSD);
        writeCsvRow(symbol, type, {
          date, time, action: "CLOSE", side: position.side,
          quantity: (position.sizeUSD / price).toFixed(6),
          entryPrice: position.entryPrice, exitPrice: price,
          sizeUSD: position.sizeUSD, pnlUSD: exit.pnlUSD, pnlPct: exit.pnlPct,
          exitReason: exit.reason, confluences: position.confluences || "",
          orderId, portfolioValue: updatedPF.value,
          notes: `Portfolio: $${updatedPF.value.toFixed(2)}`,
        });
        clearPosition(symbol, type);

      } else {
        console.log(`  ⏳ ${symbol.padEnd(6)} Halten ${position.side.toUpperCase()} @ $${fmt(position.entryPrice)} | P&L: ${exit.pnlPct >= 0 ? "+" : ""}${exit.pnlPct.toFixed(2)}%`);
      }
      return;
    }

    // ── Ziel erreicht? ───────────────────────────────────────────────────────
    if (portfolio.value >= CONFIG.targetUSD) {
      console.log(`  🏆 ${symbol.padEnd(6)} ZIEL ERREICHT! $${portfolio.value.toFixed(2)}`);
      return;
    }

    // ── Confluence-Check ─────────────────────────────────────────────────────
    const swings    = detectSwingPoints(candles15m);
    const structure = detectStructure(swings);

    // Confluence 2: Top-Down
    let topDown;
    try { topDown = await topDownAnalysis(symbol, isStock); }
    catch { topDown = { agree: false, s4H: "neutral", s1H: "neutral" }; }

    // Confluence 3: AOI
    const aois = detectAOI(candles15m);

    // Confluence 4+5: State laden (BOS + Retest)
    const state = loadState(symbol, type);

    // BOS neu prüfen oder aus State laden
    let bos = state.bos || null;
    if (!bos || structure !== state.structure) {
      bos = detectBOS(candles15m, structure, aois);
      if (bos) {
        saveState(symbol, type, { structure, bos, waitingForRetest: true, updatedAt: now.toISOString() });
        console.log(`  💥 ${symbol.padEnd(6)} BOS erkannt! ${bos.type} @ $${fmt(bos.level)} | Warte auf Retest...`);
        return;
      }
    }

    // Confluence 6: Candlestick + Retest
    const candlestick = detectCandlestick(candles15m);
    const isRetesting = bos ? detectRetest(candles15m, bos.level, bos.type) : false;

    // Confluences zusammenzählen
    const confluences = [
      structure !== "neutral"                 ? `1.Struktur(${structure})` : null,
      topDown.agree                           ? `2.TopDown(${topDown.s4H})` : null,
      aois.length > 0                         ? `3.AOI($${fmt(aois[0]?.price)})` : null,
      bos                                     ? `4.BOS(${bos.type})` : null,
      isRetesting                             ? "5.Retest✅" : null,
      candlestick                             ? `6.${candlestick.pattern}` : null,
    ].filter(Boolean);

    const allPass = confluences.length >= 5 &&
      structure !== "neutral" &&
      topDown.agree &&
      aois.length > 0 &&
      bos &&
      isRetesting &&
      candlestick;

    // Signal prüfen
    const bosSignal = bos?.type === "bullish_break" ? "buy" : bos?.type === "bearish_break" ? "sell" : null;
    const candleSignal = candlestick?.signal;
    const signalMatches = bosSignal && candleSignal && bosSignal === candleSignal;

    if (!allPass || !signalMatches) {
      const missing = [];
      if (structure === "neutral")  missing.push("Struktur");
      if (!topDown.agree)           missing.push("Top-Down");
      if (aois.length === 0)        missing.push("AOI");
      if (!bos)                     missing.push("BOS");
      if (!isRetesting)             missing.push("Retest");
      if (!candlestick)             missing.push("Candlestick");
      if (!signalMatches)           missing.push("Signal-Übereinstimmung");

      console.log(`  💤 ${symbol.padEnd(6)} Kein Setup | ${confluences.length}/6 Confluences | fehlt: ${missing.join(", ")}`);
      return;
    }

    // ── TRADE ENTRY ──────────────────────────────────────────────────────────
    const bias       = bosSignal;
    const stopLoss   = bias === "buy" ? price * (1 - CONFIG.stopLossPct)   : price * (1 + CONFIG.stopLossPct);
    const takeProfit = bias === "buy" ? price * (1 + CONFIG.takeProfitPct) : price * (1 - CONFIG.takeProfitPct);
    const confluenceStr = confluences.join(" | ");

    console.log(`\n  ✅ ${symbol} [${type.toUpperCase()}] — ALLE 6 CONFLUENCES ✅`);
    console.log(`     ${confluenceStr}`);
    console.log(`     Einstieg: ${bias.toUpperCase()} @ $${fmt(price)} | SL: $${fmt(stopLoss)} | TP: $${fmt(takeProfit)} | Größe: $${tradeSize.toFixed(2)}\n`);

    let orderId = `PAPER-${Date.now()}`;
    if (!CONFIG.paperTrading) {
      try {
        if (isStock) {
          const order = await placeAlpacaOrder(symbol, bias, tradeSize);
          orderId = order.id || orderId;
        } else {
          const order = await placeKrakenOrder(symbol, bias, tradeSize, price);
          orderId = order.txid?.[0] || orderId;
        }
      } catch (err) { console.log(`  ❌ ${symbol}: Entry-Order Fehler — ${err.message}`); }
    }

    savePosition(symbol, type, {
      side: bias, entryPrice: price, stopLoss, takeProfit,
      sizeUSD: tradeSize, openedAt: now.toISOString(), orderId, confluences: confluenceStr,
    });

    writeCsvRow(symbol, type, {
      date, time, action: "OPEN", side: bias,
      quantity: (tradeSize / price).toFixed(6),
      entryPrice: price, exitPrice: null,
      sizeUSD: tradeSize, pnlUSD: undefined, pnlPct: undefined,
      exitReason: "", confluences: confluenceStr, orderId,
      portfolioValue: portfolio.value,
      notes: `SL:$${fmt(stopLoss)} TP:$${fmt(takeProfit)} | ${candlestick.pattern}`,
    });

    // State zurücksetzen nach Entry
    saveState(symbol, type, {});

  } catch (err) {
    console.log(`  ❌ ${symbol} [${type}]: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const now = new Date();
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  DAS Trading Bot v2  |  ${now.toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Crypto: ${CRYPTO_COINS.join(", ")}`);
  console.log(`  Aktien: ${STOCK_SYMBOLS.join(", ")} ${isUSMarketOpen() ? "🟢 Markt offen" : "🔴 Markt zu"}`);
  console.log(`  Strategie: 6-Confluence | SL: ${(CONFIG.stopLossPct*100).toFixed(1)}% | TP: ${(CONFIG.takeProfitPct*100).toFixed(1)}% (1:3 RR)`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // CSV initialisieren
  CRYPTO_COINS.forEach(s  => initCsv(s, "crypto"));
  STOCK_SYMBOLS.forEach(s => initCsv(s, "stock"));

  // Crypto
  console.log("  🪙 CRYPTO:\n");
  for (const sym of CRYPTO_COINS) await runAsset(sym, "crypto");

  // US-Aktien
  console.log("\n  📈 US AKTIEN:\n");
  for (const sym of STOCK_SYMBOLS) await runAsset(sym, "stock");

  showAllPnL();
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.argv.includes("--pnl")) {
  showAllPnL();
} else {
  run().catch(err => {
    console.error("\n❌ Bot Fehler:", err.message);
    process.exit(1);
  });
}
