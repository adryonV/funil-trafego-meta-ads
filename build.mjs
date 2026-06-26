// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
// Reads two PUBLIC Google Sheets (CSV export), cross-references sales to ads by UTM,
// and writes ./public/data.json (aggregated, NO personal data) for the static dashboard.
//
// READ-ONLY: it only fetches the sheets via the CSV export endpoint; it never writes to them.

import { writeFileSync, mkdirSync } from 'node:fs';

// --- Sources (the two shared Google Sheets) ---------------------------------
const SHEET_ADS =
  'https://docs.google.com/spreadsheets/d/1SbLwinQPazV59EBbFIsrIwhunooNqT4DNVtT4MRhqPc/export?format=csv&gid=0';
const SHEET_SALES =
  'https://docs.google.com/spreadsheets/d/1Qe1_LFcrd98hhOTa5rJAL78ZRUoHCZ-Pj4kIRgdiljI/export?format=csv&gid=335206954';

// --- Tax applied on top of ad spend (spend × TAX_RATE) ----------------------
const TAX_RATE = 1.1385;

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields containing commas / escaped quotes / newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse a number written in Brazilian (or plain) format: "1.234,56" / "16,14" / "197"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Normalize a join key: collapse runs of whitespace + trim.
// CRITICAL: Sheet 1 has "Lookalike  - 18a65" (double space) while the UTM in
// Sheet 2 has "Lookalike - 18a65" (single space). Without this they won't match.
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Is this UTM value a real attribution (not empty / not the literal "undefined")?
const isUtm = (s) => {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'undefined';
};

const pad = (n) => String(n).padStart(2, '0');

// Sheet 2 has two date columns: col A ("Data", UTC) and col B ("DATA ( UTC -3)", Brazil).
// Meta reports days in the account timezone (Brazil), so we want the Brazil date.
// Prefer col B when present; otherwise take col A (UTC) minus 3h.
function brazilDate(colA, colB) {
  const pick = (s) => {
    const m = String(s || '').trim().match(/(\d{2})\/(\d{2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    return { d: +m[1], mo: +m[2], y: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
  };
  const b = pick(colB);
  if (b) return `${b.y}-${pad(b.mo)}-${pad(b.d)}`;
  const a = pick(colA);
  if (!a) return null;
  const dt = new Date(Date.UTC(a.y, a.mo - 1, a.d, a.h, a.mi));
  dt.setUTCHours(dt.getUTCHours() - 3); // UTC -> Brazil (UTC-3)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  return await r.text();
}

function headerIndex(headerRow, name) {
  return headerRow.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

(async () => {
  const [csvAds, csvSales] = await Promise.all([fetchText(SHEET_ADS), fetchText(SHEET_SALES)]);

  // ---------------- Sheet 1: Meta Ads metrics ----------------
  const a = parseCSV(csvAds);
  const h1 = a[0];
  const I = {
    day: headerIndex(h1, 'Day'),
    camp: headerIndex(h1, 'Campaign Name'),
    set: headerIndex(h1, 'Ad Set Name'),
    ad: headerIndex(h1, 'Ad Name'),
    spend: headerIndex(h1, 'Amount Spent'),
    imp: headerIndex(h1, 'Impressions'),
    clk: headerIndex(h1, 'Link Clicks'),
    lpv: headerIndex(h1, 'Landing Page Views'),
    chk: headerIndex(h1, 'Checkouts Initiated'),
  };
  const ads = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // skip blanks / totals
    ads.push({
      date: day,
      campaign: normKey(r[I.camp]),
      adset: normKey(r[I.set]),
      ad: normKey(r[I.ad]),
      spend: num(r[I.spend]),
      impressions: Math.round(num(r[I.imp])),
      clicks: Math.round(num(r[I.clk])),
      lpv: Math.round(num(r[I.lpv])),
      checkouts: Math.round(num(r[I.chk])),
    });
  }

  // ---------------- Sheet 2: Buyers (sales) ----------------
  const s = parseCSV(csvSales);
  const h2 = s[0];
  const J = {
    val: headerIndex(h2, 'Valor da Compra'),
    camp: headerIndex(h2, 'utm_campaign'),
    set: headerIndex(h2, 'utm_medium'),
    ad: headerIndex(h2, 'utm_content'),
  };
  // Aggregate sales by (date, campaign, adset, ad) — NO names / emails leave this script.
  const salesMap = new Map();
  let salesTotal = 0, revenueTotal = 0, attributedTotal = 0;
  for (let i = 1; i < s.length; i++) {
    const r = s[i];
    if (!r || r.length < 2) continue;
    const date = brazilDate(r[0], r[1]);
    if (!date) continue;
    const value = num(r[J.val]);
    const campOk = isUtm(r[J.camp]);
    const setOk = isUtm(r[J.set]);
    const adOk = isUtm(r[J.ad]);
    const attributed = campOk; // attributed to a campaign at minimum
    const campaign = campOk ? normKey(r[J.camp]) : '';
    const adset = setOk ? normKey(r[J.set]) : '';
    const ad = adOk ? normKey(r[J.ad]) : '';
    const key = [date, campaign, adset, ad].join('||');
    if (!salesMap.has(key)) salesMap.set(key, { date, campaign, adset, ad, attributed, count: 0, revenue: 0 });
    const o = salesMap.get(key);
    o.count++; o.revenue += value;
    salesTotal++; revenueTotal += value;
    if (attributed) attributedTotal++;
  }
  const sales = [...salesMap.values()].map((o) => ({ ...o, revenue: Math.round(o.revenue * 100) / 100 }));

  // ---------------- Output ----------------
  const allDates = [...ads.map((x) => x.date), ...sales.map((x) => x.date)].sort();
  const out = {
    generatedAt: new Date().toISOString(),
    taxRate: TAX_RATE,
    currency: 'BRL',
    dateRange: { min: allDates[0] || null, max: allDates[allDates.length - 1] || null },
    counts: {
      adRows: ads.length,
      salesRows: sales.length,
      salesTotal,
      salesAttributed: attributedTotal,
      revenueTotal: Math.round(revenueTotal * 100) / 100,
    },
    ads,
    sales,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));
  console.log('Wrote public/data.json', out.counts, out.dateRange);

  if (ads.length === 0) {
    // Fail the build so we never publish an empty dashboard over a good one.
    throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
