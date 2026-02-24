/**
 * Finance Plugin — Stock prices, crypto, and currency conversion.
 *
 * Uses free APIs (no key needed):
 * - Yahoo Finance (via query2.finance.yahoo.com)
 * - CoinGecko (crypto)
 * - frankfurter.app (currency conversion)
 */

const YAHOO_BASE = "https://query2.finance.yahoo.com/v8/finance/chart";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const CURRENCY_BASE = "https://api.frankfurter.app";

// Common crypto IDs
const CRYPTO_MAP = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana",
  ada: "cardano", cardano: "cardano",
  doge: "dogecoin", dogecoin: "dogecoin",
  xrp: "ripple", ripple: "ripple",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  link: "chainlink", chainlink: "chainlink",
  avax: "avalanche-2", avalanche: "avalanche-2",
};

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "MrLevin/1.0", ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getStockPrice(symbol) {
  const data = await fetchJSON(`${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Symbol "${symbol}" nicht gefunden`);

  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const change = price - prevClose;
  const changePct = (change / prevClose * 100);
  const currency = meta.currency || "USD";

  return {
    symbol: meta.symbol,
    name: meta.shortName || meta.symbol,
    price,
    change,
    changePct,
    currency,
    exchange: meta.exchangeName,
    marketState: meta.marketState,
  };
}

async function getCryptoPrice(id) {
  const data = await fetchJSON(
    `${COINGECKO_BASE}/simple/price?ids=${id}&vs_currencies=usd,eur&include_24hr_change=true&include_market_cap=true`
  );
  const coin = data[id];
  if (!coin) throw new Error(`Crypto "${id}" nicht gefunden`);

  return {
    id,
    usd: coin.usd,
    eur: coin.eur,
    change24h: coin.usd_24h_change,
    marketCapUsd: coin.usd_market_cap,
  };
}

async function convertCurrency(amount, from, to) {
  const data = await fetchJSON(
    `${CURRENCY_BASE}/latest?amount=${amount}&from=${from.toUpperCase()}&to=${to.toUpperCase()}`
  );
  return {
    amount,
    from: from.toUpperCase(),
    to: to.toUpperCase(),
    result: data.rates?.[to.toUpperCase()],
    date: data.date,
  };
}

function formatNumber(n, decimals = 2) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  return n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export default {
  name: "finance",
  description: "Aktienkurse, Krypto-Preise und Währungsumrechnung",
  version: "1.0.0",
  author: "Mr. Levin",

  commands: [
    {
      command: "stock",
      description: "Aktienkurs abfragen (z.B. /stock AAPL)",
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply("📈 Nutze: `/stock AAPL` oder `/stock MSFT GOOGL TSLA`", { parse_mode: "Markdown" });
          return;
        }

        const symbols = args.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 5);
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        const results = [];
        for (const sym of symbols) {
          try {
            const data = await getStockPrice(sym);
            const arrow = data.change >= 0 ? "📈" : "📉";
            const sign = data.change >= 0 ? "+" : "";
            results.push(
              `${arrow} *${data.symbol}* (${data.name})\n` +
              `   ${formatNumber(data.price)} ${data.currency} (${sign}${formatNumber(data.change)} / ${sign}${data.changePct.toFixed(2)}%)\n` +
              `   _${data.exchange} — ${data.marketState}_`
            );
          } catch (err) {
            results.push(`❌ ${sym}: ${err.message}`);
          }
        }

        await ctx.reply(results.join("\n\n"), { parse_mode: "Markdown" });
      },
    },
    {
      command: "crypto",
      description: "Krypto-Preis abfragen (z.B. /crypto btc)",
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply("🪙 Nutze: `/crypto btc` oder `/crypto eth sol doge`", { parse_mode: "Markdown" });
          return;
        }

        const coins = args.toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 5);
        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        const results = [];
        for (const coin of coins) {
          const id = CRYPTO_MAP[coin] || coin;
          try {
            const data = await getCryptoPrice(id);
            const arrow = data.change24h >= 0 ? "📈" : "📉";
            const sign = data.change24h >= 0 ? "+" : "";
            results.push(
              `${arrow} *${id.charAt(0).toUpperCase() + id.slice(1)}*\n` +
              `   $${formatNumber(data.usd)} / €${formatNumber(data.eur)}\n` +
              `   24h: ${sign}${data.change24h?.toFixed(2)}% | MCap: $${formatNumber(data.marketCapUsd, 0)}`
            );
          } catch (err) {
            results.push(`❌ ${coin}: ${err.message}`);
          }
        }

        await ctx.reply(results.join("\n\n"), { parse_mode: "Markdown" });
      },
    },
    {
      command: "fx",
      description: "Währung umrechnen (z.B. /fx 100 USD EUR)",
      handler: async (ctx, args) => {
        if (!args) {
          await ctx.reply("💱 Nutze: `/fx 100 USD EUR`", { parse_mode: "Markdown" });
          return;
        }

        const parts = args.split(/\s+/);
        if (parts.length < 3) {
          await ctx.reply("Format: `/fx <Betrag> <VON> <NACH>`\nBeispiel: `/fx 100 USD EUR`", { parse_mode: "Markdown" });
          return;
        }

        const amount = parseFloat(parts[0]);
        if (isNaN(amount)) {
          await ctx.reply("❌ Ungültiger Betrag.");
          return;
        }

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        try {
          const data = await convertCurrency(amount, parts[1], parts[2]);
          if (!data.result) throw new Error("Währungspaar nicht unterstützt");
          await ctx.reply(
            `💱 *${formatNumber(data.amount)} ${data.from}* = *${formatNumber(data.result)} ${data.to}*\n` +
            `_Kurs vom ${data.date}_`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          await ctx.reply(`❌ ${err.message}`);
        }
      },
    },
  ],

  tools: [
    {
      name: "get_stock_price",
      description: "Get current stock price for a ticker symbol",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker symbol (e.g. AAPL, MSFT)" },
        },
        required: ["symbol"],
      },
      execute: async (params) => {
        const data = await getStockPrice(params.symbol);
        return JSON.stringify(data);
      },
    },
    {
      name: "get_crypto_price",
      description: "Get current cryptocurrency price",
      parameters: {
        type: "object",
        properties: {
          coin: { type: "string", description: "Coin name or symbol (e.g. bitcoin, btc, eth)" },
        },
        required: ["coin"],
      },
      execute: async (params) => {
        const id = CRYPTO_MAP[params.coin?.toLowerCase()] || params.coin;
        const data = await getCryptoPrice(id);
        return JSON.stringify(data);
      },
    },
    {
      name: "convert_currency",
      description: "Convert between currencies",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Amount to convert" },
          from: { type: "string", description: "Source currency (e.g. USD)" },
          to: { type: "string", description: "Target currency (e.g. EUR)" },
        },
        required: ["amount", "from", "to"],
      },
      execute: async (params) => {
        const data = await convertCurrency(params.amount, params.from, params.to);
        return JSON.stringify(data);
      },
    },
  ],
};
