import {
  call,
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getUserTitles,
  getUserPlayedGames,
  getPurchasedGames,
} from "psn-api";
import { google } from "googleapis";

// ---- Config ----------------------------------------------------------------
// Everything here is overridable by environment variable; see README.
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const SHEET_TAB = process.env.SHEET_TAB || "Games";

// Cover art sizing. Mode 1 = fit inside the cell without distortion.
// (Switch to 4 to force an exact box, at the cost of stretching odd shapes.)
// 1 fits the art inside the cell without distorting it; 4 forces an exact
// pixel box and will stretch anything that isn't that shape.
const COVER_MODE = num("COVER_MODE", 1);
const COVER_W = num("COVER_W", 150);      // Cover column width, pixels
const GAME_W = num("GAME_W", 150);        // Game column width
const PLATFORM_W = num("PLATFORM_W", 25); // Platform column width
const ROW_HEIGHT = num("ROW_HEIGHT", 150);
const HEADER_HEIGHT = num("HEADER_HEIGHT", 50);

// Options offered by the Status dropdown, in order. Override with a
// comma-separated list to suit how you actually track things.
const STATUS_OPTIONS = (
  process.env.STATUS_OPTIONS ||
  "Backlog,Playing,Ongoing,Beaten,Platinum,Dropped"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Statuses that mean "done with it" — these sink to the bottom of the play order.
const DONE_STATUSES = ["Beaten", "Platinum", "Dropped"];

// Half steps, so a 3.5 is expressible.
const RATING_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

// PlayStation names the same game differently depending on which endpoint you
// ask, so a title can arrive twice under two names. This undocumented trophy
// endpoint maps a store title id to its trophy set, giving the two halves a
// shared key. Switch it off with TITLE_BRIDGE_ENABLED=0 if it ever misbehaves —
// the sync then falls back to matching on names alone.
const TITLE_BRIDGE_ENABLED = process.env.TITLE_BRIDGE_ENABLED !== "0";
const BRIDGE_BATCH = num("BRIDGE_BATCH", 5);
const BRIDGE_DELAY_MS = num("BRIDGE_DELAY_MS", 300);
const TROPHY_API = "https://m.np.playstation.com/api/trophy/v1";

const BANNER_HEIGHT = num("BANNER_HEIGHT", 28);
// How many cells the timestamp banner spans across the top.
const BANNER_SPAN = num("BANNER_SPAN", 5);

// HowLongToBeat is the slow, flaky step. HLTB_ENABLED=0 skips it entirely.
const HLTB_ENABLED = process.env.HLTB_ENABLED !== "0";
const HLTB_DELAY_MS = num("HLTB_DELAY_MS", 400);
// Covers come from PlayStation key art. If none exists, leave the cell blank
// rather than dropping in the square trophy icon.
const FALLBACK_TO_ICON = false;

// Renaming a column would otherwise look like "old one missing, add a new one",
// which would strand the data in the old column. Applied to the sheet's header
// before the missing-column check.
const HEADER_RENAMES = {
  "Progress %": "%",
  "Playtime (hrs)": "Hrs. Played",
  Bronze: "B",
  Silver: "S",
  Gold: "G",
  Platinum: "P",
};

const PROGRESS_H = "%";
const PLAYTIME_H = "Hrs. Played";

const AUTO_HEADERS = [
  "Cover",
  "Game",
  "Platform",
  "Source",
  PROGRESS_H,
  "B",
  "S",
  "G",
  "P",
  "Trophies",
  PLAYTIME_H,
  "Plays",
  "Hours to beat",
  "First played",
  "Last played",
  "PSN ID",
  "Sort order",
];
const TROPHY_COLUMNS = [
  { header: "B", grade: "bronze", color: [205, 127, 50] },
  { header: "S", grade: "silver", color: [192, 192, 192] },
  { header: "G", grade: "gold", color: [255, 215, 0] },
  // Platinum keeps the light blue PlayStation itself uses for the grade.
  { header: "P", grade: "platinum", color: [173, 216, 230] },
];
const TROPHY_HEADERS = TROPHY_COLUMNS.map((t) => t.header);
const PERSONAL_HEADERS = [
  "Status",
  "Priority",
  "Rating",
  "Price paid",
  "Notes",
  "Goal/Reminder",
  "Hidden",
];
const ALL_HEADERS = [...AUTO_HEADERS, ...PERSONAL_HEADERS];

// ---- Helpers ----------------------------------------------------------------
const ROMAN_NUMERALS = [
  "i", "ii", "iii", "iv", "v", "vi",
  "vii", "viii", "ix", "x", "xi", "xii",
];

// PSN sometimes writes a numeral as a single Unicode Roman character — "DARK
// SOULS Ⅱ" uses U+2161, not two letter I's. The alphanumeric strip below would
// delete it outright, so the same game ends up on two rows under two keys.
// U+2160-216B are the uppercase forms and U+2170-217B the lowercase.
const romanToAscii = (s) =>
  s.replace(/[\u2160-\u216B\u2170-\u217B]/g, (ch) => {
    const cp = ch.codePointAt(0);
    const base = cp >= 0x2170 ? 0x2170 : 0x2160;
    return ROMAN_NUMERALS[cp - base];
  });

const ROMAN_TO_NUM = Object.fromEntries(
  ROMAN_NUMERALS.map((r, i) => [r, i + 1])
);

// "PlayStation 4" and "PS5" are platform labels, not part of a game's name.
const PLATFORM_NOISE = /\b(?:playstation|ps)\s*[345]\b/g;

// Which entry in a series a title is: 0 for the first game, 2 for a sequel, and
// so on. Sony sometimes points a store entry at the wrong game's trophy set —
// "SPLITGATE: Arena Reloaded" resolves to Splitgate 2's — and merging on that
// would fold a sequel's hours into the original. Numbers have to agree.
function sequelNumber(normalisedName) {
  const tokens = normalisedName
    .replace(PLATFORM_NOISE, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^\d{1,2}$/.test(t)) return Number(t);
    if (ROMAN_TO_NUM[t]) return ROMAN_TO_NUM[t];
  }
  return 0;
}

const norm = (s) =>
  romanToAscii((s || "").toString())
    .toLowerCase()
    .replace(/[™®©:]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    // PS3- and PS4-era trophy lists come back suffixed, e.g. "Apex Legends
    // Trophies" or "Vigor Trophy Set". Same game as the unsuffixed entry.
    .replace(/\s+(trophies|trophy set)$/, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Total across all four grades. Platinum is 0 or 1, so it counts as one trophy.
const totalTrophies = (t) =>
  t ? (t.bronze || 0) + (t.silver || 0) + (t.gold || 0) + (t.platinum || 0) : 0;

// The Game cell may hold a =HYPERLINK() formula rather than bare text. The game
// name is the formula's label, and that name is the key every row is matched on,
// so it has to be recovered before normalising or rows would duplicate.
const HYPERLINK_LABEL = /^\s*=HYPERLINK\(\s*"[^"]*"\s*,\s*"([^"]*)"/i;
function gameNameFromCell(v) {
  if (typeof v !== "string") return v;
  const m = HYPERLINK_LABEL.exec(v);
  return m ? m[1] : v;
}

// PSN's own store URL for a game, built from its concept id.
function gameCell(name, conceptId) {
  if (!conceptId) return name;
  const safe = String(name).replace(/"/g, "'");
  return `=HYPERLINK("https://store.playstation.com/concept/${conceptId}", "${safe}")`;
}

// How the account has access to the game, as reported by PSN.
function sourceLabel(service, purchased) {
  if (service === "ps_plus") return "PS Plus";
  if (service === "none_purchased") return "Purchased";
  return purchased ? "Purchased" : "";
}

function durationToHours(iso) {
  if (!iso) return "";
  const m = /P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?/.exec(iso);
  if (!m) return "";
  const [, d, h, min, sec] = m.map((x) => (x ? parseFloat(x) : 0));
  const hours = (d || 0) * 24 + (h || 0) + (min || 0) / 60 + (sec || 0) / 3600;
  return hours ? Math.round(hours * 10) / 10 : "";
}

const dateOnly = (iso) => (iso ? iso.slice(0, 10) : "");

function platformFromCategory(cat) {
  if (!cat) return "";
  if (cat.includes("ps5")) return "PS5";
  if (cat.includes("ps4")) return "PS4";
  if (cat.includes("ps3")) return "PS3";
  if (cat.includes("vita")) return "PS Vita";
  return "";
}

// Pick the best cover from a PSN title's concept art (high-res). Prefer key
// art / portrait; avoid backgrounds and screenshots. Returns "" if none.
function pickCover(title) {
  const imgs = title && title.concept && title.concept.media && title.concept.media.images;
  if (!Array.isArray(imgs) || imgs.length === 0) return "";
  const prefer = ["MASTER", "KEYART", "KEY_ART", "COVER", "PORTRAIT"];
  for (const p of prefer) {
    const hit = imgs.find((im) => im && im.url && (im.type || "").toUpperCase().includes(p));
    if (hit) return hit.url;
  }
  const bad = /BACKGROUND|SCREENSHOT|PROMO|LOGO|BANNER/i;
  const nice = imgs.find((im) => im && im.url && !bad.test(im.type || ""));
  return ((nice || imgs[0]) || {}).url || "";
}

// Cover cells written by earlier versions of this script are pinned to a fixed
// pixel box, which squashes art that isn't exactly that shape. Re-emit any
// existing formula in the current mode, keeping whatever URL it already points
// at. Returns null if the cell isn't an =IMAGE() formula.
const EXISTING_IMAGE = /^\s*=IMAGE\(\s*"([^"]+)"/i;
function restyleCover(existing) {
  if (typeof existing !== "string") return null;
  const m = EXISTING_IMAGE.exec(existing);
  return m ? coverFormula(m[1]) : null;
}

function coverFormula(url) {
  if (!url) return null;
  const safe = String(url).replace(/"/g, "").replace(/^http:/, "https:");
  return COVER_MODE === 4
    ? `=IMAGE("${safe}", 4, ${ROW_HEIGHT}, ${COVER_W})`
    : `=IMAGE("${safe}", ${COVER_MODE})`;
}

// ---- PSN pulls --------------------------------------------------------------
async function getAuth() {
  const npsso = process.env.NPSSO;
  try {
    const accessCode = await exchangeNpssoForAccessCode(npsso);
    return await exchangeAccessCodeForAuthTokens(accessCode);
  } catch {
    // Overwhelmingly the cause: NPSSO tokens expire roughly every two months.
    throw new Error(
      "PSN sign-in failed — your NPSSO token has expired or is invalid. Log in " +
        "at playstation.com, open https://ca.account.sony.com/api/v1/ssocookie, " +
        "and update the NPSSO secret with the fresh value."
    );
  }
}

async function pullTrophyTitles(auth) {
  const games = new Map();
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const res = await getUserTitles(
      { accessToken: auth.accessToken },
      "me",
      { limit, offset }
    );
    const titles = res.trophyTitles || [];
    for (const t of titles) {
      const key = norm(t.trophyTitleName);
      if (!key) continue;
      games.set(key, {
        name: t.trophyTitleName,
        platform: t.trophyTitlePlatform || "",
        progress: typeof t.progress === "number" ? t.progress : "",
        playtime: "",
        lastPlayed: "",
        iconUrl: t.trophyTitleIconUrl || "",
        coverUrl: "",
        // PSN reports platinum as 0 or 1 — a title has at most one.
        trophies: t.earnedTrophies || null,
        definedTrophies: t.definedTrophies || null,
        npComm: t.npCommunicationId || "",
        // Games hidden on the PSN profile itself.
        hidden: t.hiddenFlag === true,
      });
    }
    if (titles.length < limit) break;
    offset += limit;
  }
  return games;
}

// Ask the trophy service which trophy set each store title belongs to.
// Returns a Map of npTitleId -> npCommunicationId. Any failure returns what it
// has so far: a missing bridge just means falling back to name matching.
async function bridgeTitleIds(auth, titleIds) {
  const found = new Map();
  if (!TITLE_BRIDGE_ENABLED || titleIds.length === 0) return found;

  let shapeLogged = false;
  for (let i = 0; i < titleIds.length; i += BRIDGE_BATCH) {
    const slice = titleIds.slice(i, i + BRIDGE_BATCH);
    try {
      const res = await call(
        {
          url: `${TROPHY_API}/users/me/titles/trophyTitles?npTitleIds=${slice.join(",")}`,
        },
        { accessToken: auth.accessToken }
      );

      // Undocumented endpoint: accept either shape it might return, and print
      // the raw keys once so an unexpected response is diagnosable from the log
      // rather than silently yielding nothing.
      const rows = res.titles || res.trophyTitles || [];
      if (!shapeLogged) {
        shapeLogged = true;
        if (!Array.isArray(rows) || rows.length === 0) {
          console.warn(
            "Title bridge: unrecognised response shape, keys =",
            Object.keys(res || {}).join(",") || "(none)"
          );
        }
      }

      for (const row of rows) {
        const npTitleId = row.npTitleId || row.npTitleIds;
        const sets = row.trophyTitles || (row.npCommunicationId ? [row] : []);
        // A store title can map to several trophy sets. Keep them all so the
        // merge step can reject one and try the next.
        const ids = sets.map((s) => s && s.npCommunicationId).filter(Boolean);
        if (npTitleId && ids.length) found.set(npTitleId, ids);
      }
    } catch (e) {
      console.warn(`Title bridge stopped after ${found.size} matches:`, e.message);
      return found;
    }
    await sleep(BRIDGE_DELAY_MS);
  }
  return found;
}

async function enrichPlayed(auth, games) {
  let played = [];
  try {
    const limit = 100;
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = await getUserPlayedGames(
        { accessToken: auth.accessToken },
        "me",
        { limit, offset }
      );
      const titles = res.titles || [];
      played.push(...titles);
      if (titles.length < limit) break;
      offset += limit;
    }
  } catch (e) {
    console.warn("Playtime pull skipped:", e.message);
    return;
  }

  // Where the name already matches a trophy title there's nothing to resolve,
  // so only the leftovers go through the bridge. That's usually a small
  // fraction of the library and keeps the extra calls down.
  const byNpComm = new Map();
  for (const [key, g] of games) {
    if (g.npComm) byNpComm.set(g.npComm, key);
  }
  const unmatched = played.filter(
    (t) => t.name && !games.has(norm(t.name)) && t.titleId
  );
  const bridged = await bridgeTitleIds(
    auth,
    unmatched.map((t) => t.titleId)
  );
  const merges = [];
  const rejected = [];
  // How many PlayStation entries fed each game, so a row built from more than
  // one is visible rather than having to be inferred.
  const contributions = new Map();

  for (const t of played) {
    let key = norm(t.name);
    if (!key) continue;
    if (!games.has(key)) {
      // The same game under the store's name rather than the trophy set's.
      for (const npComm of bridged.get(t.titleId) || []) {
        const existingKey = byNpComm.get(npComm);
        if (!existingKey) continue;
        const target = games.get(existingKey);
        const targetName = (target && target.name) || existingKey;
        if (sequelNumber(norm(t.name)) !== sequelNumber(norm(targetName))) {
          rejected.push([t.name, targetName]);
          continue;
        }
        merges.push([t.name, targetName]);
        key = existingKey;
        break;
      }
    }
    const entry = games.get(key) || {
      name: t.name,
      platform: platformFromCategory(t.category),
      progress: "",
      iconUrl: "",
      coverUrl: "",
      trophies: null,
    };
    // A game can arrive as several PSN entries — a PS4 and a PS5 edition, say —
    // that all land on one row. Overwriting meant the last one seen won, so a
    // brief PS5 launch could bury a hundred hours logged on PS4. Accumulate
    // instead: hours and launches add up, first played is the earliest seen and
    // last played the most recent.
    const hrs = durationToHours(t.playDuration);
    if (hrs !== "") {
      const running = typeof entry.playtime === "number" ? entry.playtime : 0;
      entry.playtime = Math.round((running + hrs) * 10) / 10;
    }
    const lastSeen = dateOnly(t.lastPlayedDateTime);
    if (lastSeen && (!entry.lastPlayed || lastSeen > entry.lastPlayed)) {
      entry.lastPlayed = lastSeen;
    }
    const firstSeen = dateOnly(t.firstPlayedDateTime);
    if (firstSeen && (!entry.firstPlayed || firstSeen < entry.firstPlayed)) {
      entry.firstPlayed = firstSeen;
    }
    // Owning a game outright beats having it through the subscription.
    if (t.service && entry.service !== "none_purchased") entry.service = t.service;
    if (typeof t.playCount === "number") {
      entry.playCount = (entry.playCount || 0) + t.playCount;
    }
    if (t.concept && t.concept.id) entry.conceptId = t.concept.id;
    if (!entry.platform) entry.platform = platformFromCategory(t.category);
    const cov = pickCover(t);
    if (cov) entry.coverUrl = cov; // high-res PSN key art
    games.set(key, entry);
    contributions.set(key, (contributions.get(key) || 0) + 1);
  }

  if (TITLE_BRIDGE_ENABLED) {
    console.log(
      `Title bridge: resolved ${bridged.size} of ${unmatched.length} unmatched ` +
        `titles, merging ${merges.length} into an existing trophy set.`
    );
    for (const [from, to] of merges) {
      console.log(`  merged "${from}"  ->  "${to}"`);
    }
    for (const [from, to] of rejected) {
      console.log(`  refused "${from}"  ->  "${to}" (different entry in the series)`);
    }
  }

  const combined = [...contributions].filter(([, n]) => n > 1);
  if (combined.length) {
    console.log(`${combined.length} game(s) built from several PlayStation entries:`);
    for (const [key, n] of combined) {
      const g = games.get(key);
      console.log(
        `  ${g.name}: ${n} entries -> ${g.playtime}h, ${g.playCount ?? 0} plays, ` +
          `first ${g.firstPlayed || "?"}, last ${g.lastPlayed || "?"}`
      );
    }
  }
}

async function enrichPurchased(auth, games) {
  try {
    const limit = 100;
    let offset = 0;
    for (let page = 0; page < 50; page++) {
      const res = await getPurchasedGames(
        { accessToken: auth.accessToken },
        { limit, offset }
      );
      const titles = res.titles || [];
      for (const t of titles) {
        const key = norm(t.name);
        if (!key) continue;
        const existing = games.get(key);
        if (existing) {
          existing.purchased = true;
          if (!existing.conceptId && t.concept && t.concept.id) {
            existing.conceptId = t.concept.id;
          }
          if (!existing.coverUrl) {
            const c = pickCover(t);
            if (c) existing.coverUrl = c;
          }
          continue;
        }
        games.set(key, {
          name: t.name,
          platform: platformFromCategory(t.category),
          progress: "",
          playtime: "",
          lastPlayed: "",
          iconUrl: "",
          coverUrl: pickCover(t),
          trophies: null,
          purchased: true,
          conceptId: t.concept && t.concept.id ? t.concept.id : null,
        });
      }
      if (titles.length < limit) break;
      offset += limit;
    }
  } catch (e) {
    console.warn("Purchased-games pull skipped:", e.message);
  }
}

// "Hours to beat" from HowLongToBeat (maintained library). Logs how many
// lookups actually succeeded, so a silent breakage is visible in the run log.
async function enrichHltb(games, knownHours) {
  let attempted = 0;
  let matched = 0;
  if (!HLTB_ENABLED) {
    for (const [key, g] of games) {
      if (knownHours.has(key)) g.hoursToBeat = knownHours.get(key);
    }
    console.log("HLTB: disabled (HLTB_ENABLED=0); reused existing sheet values.");
    return;
  }
  try {
    const mod = await import("howlongtobeat-core");
    const HowLongToBeat =
      mod.HowLongToBeat || (mod.default && mod.default.HowLongToBeat) || mod.default;
    const hltb = new HowLongToBeat();

    for (const [key, g] of games) {
      if (knownHours.has(key)) {
        g.hoursToBeat = knownHours.get(key);
        continue;
      }
      attempted++;
      try {
        const results = await hltb.search(g.name);
        if (results && results.length) {
          results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
          const best = results[0];
          if ((best.similarity || 0) >= 0.4) {
            const hrs = best.gameplayMain || best.gameplayMainExtra || "";
            if (hrs) {
              g.hoursToBeat = hrs;
              matched++;
            }
          }
        }
      } catch {
        // one bad lookup shouldn't stop the rest
      }
      await sleep(HLTB_DELAY_MS);
    }
  } catch (e) {
    console.warn("HowLongToBeat unavailable:", e.message);
  }
  console.log(`HLTB: filled hours for ${matched} of ${attempted} new lookups.`);
}

// ---- Google Sheets ----------------------------------------------------------
function getSheetsClient() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON. It should be the entire " +
        "contents of the service-account key file, braces included."
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getSheetId(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const found = (meta.data.sheets || []).find(
    (s) => s.properties.title === SHEET_TAB
  );
  if (!found) {
    const names = (meta.data.sheets || [])
      .map((s) => `"${s.properties.title}"`)
      .join(", ");
    throw new Error(
      `No tab named "${SHEET_TAB}" in this spreadsheet. Found: ${names}. ` +
        `Rename a tab to "${SHEET_TAB}" or set SHEET_TAB to one of these.`
    );
  }
  return found.properties.sheetId;
}

async function readSheet(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_TAB,
    valueRenderOption: "FORMULA",
  });
  const rows = read.data.values || [];
  // A timestamp banner may sit above the header, so find the header by content
  // rather than assuming row 1. Sheets written by older versions have no banner.
  let headerRow = rows.findIndex(
    (r) => Array.isArray(r) && r.some((c) => gameNameFromCell(c) === "Game")
  );
  if (headerRow === -1) headerRow = rows.length ? 0 : -1;
  let header = headerRow === -1 ? null : rows[headerRow];
  const body = headerRow === -1 ? [] : rows.slice(headerRow + 1);
  // Keep whatever column order the sheet already uses and append only what is
  // missing. Replacing the header wholesale would silently shift every existing
  // row out of alignment the first time a new column is introduced.
  if (header) {
    header = header.map((h) => HEADER_RENAMES[h] || h);
  }
  if (!header || header.filter(Boolean).length === 0) {
    header = [...ALL_HEADERS];
  } else {
    for (const h of ALL_HEADERS) if (!header.includes(h)) header.push(h);
  }
  return { spreadsheetId, header, body };
}

function existingHoursMap(header, body) {
  const map = new Map();
  const gameCol = header.indexOf("Game");
  const hoursCol = header.indexOf("Hours to beat");
  if (hoursCol === -1) return map;
  for (const r of body) {
    const key = norm(gameNameFromCell(r[gameCol]));
    const val = r[hoursCol];
    if (key && val !== undefined && val !== "") map.set(key, val);
  }
  return map;
}

async function writeSheet(sheets, spreadsheetId, header, body, games) {
  const idx = {};
  ALL_HEADERS.forEach((h) => (idx[h] = header.indexOf(h)));

  const gameCol = idx["Game"];
  const width = header.length;
  const pad = (r) => {
    while (r.length < width) r.push("");
    return r;
  };
  const setAuto = (row, g) => {
    row[idx["Game"]] = gameCell(g.name, g.conceptId);
    row[idx["Platform"]] = g.platform || "";
    if (idx["Source"] !== -1) {
      row[idx["Source"]] = sourceLabel(g.service, g.purchased);
    }
    row[idx[PROGRESS_H]] = typeof g.progress === "number" ? g.progress : 0;
    row[idx[PLAYTIME_H]] = g.playtime ?? "";
    row[idx["Last played"]] = g.lastPlayed || "";
    if (idx["First played"] !== -1) {
      row[idx["First played"]] = g.firstPlayed || "";
    }
    if (idx["PSN ID"] !== -1 && g.npComm) row[idx["PSN ID"]] = g.npComm;
    if (idx["Trophies"] !== -1) {
      row[idx["Trophies"]] = g.definedTrophies
        ? `${totalTrophies(g.trophies)} / ${totalTrophies(g.definedTrophies)}`
        : "";
    }
    if (idx["Plays"] !== -1) {
      row[idx["Plays"]] = typeof g.playCount === "number" ? g.playCount : "";
    }
    // PSN's own hidden flag ticks the box but never unties it. Hiding a game in
    // the sheet is your decision, and PSN not hiding it is no reason to undo it.
    if (idx["Hidden"] !== -1 && g.hidden) {
      const current = String(row[idx["Hidden"]] ?? "").trim().toUpperCase();
      if (current !== "TRUE") row[idx["Hidden"]] = true;
    }
    for (const t of TROPHY_COLUMNS) {
      const i = idx[t.header];
      if (i === -1) continue;
      const v = g.trophies ? g.trophies[t.grade] : undefined;
      row[i] = typeof v === "number" ? v : "";
    }
    if (g.hoursToBeat !== undefined && g.hoursToBeat !== "") {
      row[idx["Hours to beat"]] = g.hoursToBeat;
    }
    const existingCover = row[idx["Cover"]];
    if (g.coverUrl) {
      row[idx["Cover"]] = coverFormula(g.coverUrl);
    } else {
      const restyled = restyleCover(existingCover);
      if (restyled) {
        row[idx["Cover"]] = restyled;
      } else if (!existingCover && FALLBACK_TO_ICON && g.iconUrl) {
        row[idx["Cover"]] = coverFormula(g.iconUrl);
      }
    }
  };

  const rowByKey = new Map();
  const rowById = new Map();
  const collisions = new Map();
  const psnIdCol = idx["PSN ID"];
  for (const r of body) {
    if (psnIdCol !== -1 && r[psnIdCol]) {
      rowById.set(String(r[psnIdCol]).trim(), r);
    }
    const key = norm(gameNameFromCell(r[gameCol]));
    if (!key) continue;
    if (rowByKey.has(key)) {
      const names = collisions.get(key) || [
        gameNameFromCell(rowByKey.get(key)[gameCol]),
      ];
      names.push(gameNameFromCell(r[gameCol]));
      collisions.set(key, names);
    }
    rowByKey.set(key, r);
  }
  // Rows that already exist can't be merged for you: each may carry its own
  // notes and rating, and picking a winner isn't the script's call. Only one of
  // each pair gets updated from here on, so name them plainly.
  if (collisions.size) {
    console.warn(
      `\n${collisions.size} pair(s) of rows now resolve to the same game. ` +
        `Only one of each is being kept up to date — delete the other by hand:`
    );
    for (const names of collisions.values()) {
      console.warn(`  - ${names.join("   ==   ")}`);
    }
    console.warn("");
  }

  // The trophy-set id is the stable identifier, so it wins where the sheet has
  // one recorded. Names are the fallback, and the only option on the first run
  // after this column appears.
  const rowFor = (key, g) =>
    (g.npComm && rowById.get(g.npComm)) || rowByKey.get(key);

  const matched = new Set();
  for (const [key, g] of games) {
    const existing = rowFor(key, g);
    if (existing) {
      matched.add(existing);
      pad(existing);
      setAuto(existing, g);
    }
  }

  // Rows left untouched are usually the far half of a pair that has just been
  // merged under one identity. They are never deleted automatically — a row may
  // carry notes you want — but they are worth naming.
  const orphans = body.filter(
    (r) => !matched.has(r) && norm(gameNameFromCell(r[gameCol]))
  );
  if (orphans.length) {
    console.warn(
      `\n${orphans.length} row(s) matched no game in this sync and were left ` +
        `untouched. If a game now appears twice, this is the stale copy:`
    );
    for (const r of orphans.slice(0, 25)) {
      console.warn(`  - ${gameNameFromCell(r[gameCol])}`);
    }
    if (orphans.length > 25) {
      console.warn(`  ... and ${orphans.length - 25} more`);
    }
    console.warn("");
  }

  const newGames = [...games.entries()].filter(([k, g]) => !rowFor(k, g));
  newGames.sort((a, b) => (b[1].lastPlayed || "").localeCompare(a[1].lastPlayed || ""));
  const appended = newGames.map(([, g]) => {
    const r = pad([]);
    setAuto(r, g);
    return r;
  });

  const banner = pad([
    `Last synced: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ]);
  const finalValues = [banner, header, ...body, ...appended];

  // Sort order is a formula, not a value, so it keeps reacting as you edit
  // Status and Priority by hand. Row numbers are only known now that the sheet
  // has been assembled, hence writing it here rather than in setAuto.
  const sortCol = idx["Sort order"];
  const statusCol = idx["Status"];
  const priorityCol = idx["Priority"];
  if (sortCol !== -1 && statusCol !== -1 && priorityCol !== -1) {
    const s = colLetter(statusCol);
    const p = colLetter(priorityCol);
    const done = DONE_STATUSES.map((x) => `$${s}{R}="${x}"`).join(",");
    for (let i = 2; i < finalValues.length; i++) {
      const R = i + 1; // 1-based sheet row
      finalValues[i][sortCol] =
        `=IF(OR(${done.replace(/\{R\}/g, R)}),1000000,` +
        `IF($${p}${R}="",500000,$${p}${R}))`;
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: finalValues },
  });

  console.log(`Synced ${games.size} games (${appended.length} new).`);
  return finalValues.length - 2;
}

// ---- Formatting -------------------------------------------------------------
// Spreadsheet column index (0-based) to its A1 letter: 0 -> A, 26 -> AA.
function colLetter(i) {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

const rgb = (r, g, b) => ({ red: r / 255, green: g / 255, blue: b / 255 });

const PRICE_FORMAT = process.env.PRICE_FORMAT || "0.00";

const PLATINUM_BG = rgb(173, 216, 230); // light blue, the platinum convention


const PROGRESS_LOW = rgb(230, 124, 115);
const PROGRESS_MID = rgb(255, 214, 102);
const PROGRESS_HIGH = rgb(87, 187, 138);

// Column sizing, conditional colour, and the rating dropdown. Safe to re-run:
// every request here overwrites rather than appends, and the conditional rules
// are torn down and rebuilt so repeated syncs can't stack duplicates.
async function applyFormatting(sheets, spreadsheetId, sheetId, header, dataRowCount) {
  const col = (name) => header.indexOf(name);
  const requests = [];

  const sizeRows = (startIndex, endIndex, px) =>
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex, endIndex },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });

  const sizeCol = (name, px) => {
    const i = col(name);
    if (i === -1) return;
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  };

  sizeRows(0, 1, BANNER_HEIGHT);
  sizeRows(1, 2, HEADER_HEIGHT);
  if (dataRowCount > 0) sizeRows(2, 2 + dataRowCount, ROW_HEIGHT);

  sizeCol("Cover", COVER_W);
  sizeCol("Game", GAME_W);
  sizeCol("Platform", PLATFORM_W);
  sizeCol("Sort order", 70);
  sizeCol(PROGRESS_H, 50);
  sizeCol(PLAYTIME_H, 50);
  sizeCol("Hours to beat", 50);
  sizeCol("PSN ID", 90);
  sizeCol("Trophies", 60);
  sizeCol("Plays", 50);
  sizeCol("First played", 75);
  sizeCol("Last played", 75);
  for (const t of TROPHY_HEADERS) sizeCol(t, 25);

  // Everything sits in the vertical middle of its row. Done first and as a
  // single field so the per-column rules below layer on top of it.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: header.length },
      cell: { userEnteredFormat: { verticalAlignment: "MIDDLE" } },
      fields: "userEnteredFormat.verticalAlignment",
    },
  });

  // Per-column presentation. Each call names only the fields it sets, so these
  // never clobber one another or anything set by hand in the sheet.
  const styleCol = (name, fmt, fields, fromRow = 2, toRow) => {
    const i = col(name);
    if (i === -1) return;
    const range = {
      sheetId,
      startRowIndex: fromRow,
      startColumnIndex: i,
      endColumnIndex: i + 1,
    };
    if (toRow !== undefined) range.endRowIndex = toRow;
    requests.push({
      repeatCell: {
        range,
        cell: { userEnteredFormat: fmt },
        fields: fields.map((f) => `userEnteredFormat.${f}`).join(","),
      },
    });
  };

  const CENTER = [{ horizontalAlignment: "CENTER" }, ["horizontalAlignment"]];
  const WRAP = [{ wrapStrategy: "WRAP" }, ["wrapStrategy"]];

  styleCol(PROGRESS_H, ...CENTER);
  styleCol(PLAYTIME_H, ...CENTER);
  styleCol("Hours to beat", ...CENTER);
  styleCol("Trophies", ...CENTER);
  styleCol("Plays", ...CENTER);
  styleCol("Game", ...WRAP);
  styleCol("Notes", ...WRAP);
  styleCol("Goal/Reminder", ...WRAP);

  // Platform is a 25px column, so the label is turned on its side to fit.
  styleCol(
    "Platform",
    { textRotation: { angle: 90 } },
    ["textRotation"]
  );

  // The header row gets room to breathe and wraps, since several columns are
  // now narrower than their own titles.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: header.length },
      cell: {
        userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" },
      },
      fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
    },
  });

  // Tint each trophy column's header cell with its grade colour.
  for (const t of TROPHY_COLUMNS) {
    styleCol(t.header, { backgroundColor: rgb(...t.color) }, ["backgroundColor"], 1, 2);
    styleCol(t.header, ...CENTER);
  }

  // Keep the header on screen while scrolling a few hundred rows.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 2 } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  // Display formats only — the underlying values stay numeric so sorting,
  // filtering and the colour scale all keep working.
  const numberFormat = (name, pattern) => {
    const i = col(name);
    if (i === -1) return;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 2,
          startColumnIndex: i,
          endColumnIndex: i + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  };
  // PSN reports progress as 0-100, so append a literal % rather than using a
  // PERCENT format, which would multiply by 100 again and show "4200%".
  numberFormat(PROGRESS_H, '0"%"');
  numberFormat(PLAYTIME_H, "0.0");
  numberFormat("Price paid", PRICE_FORMAT);
  numberFormat("Priority", "0");
  numberFormat("Plays", "0");

  // One read of the tab's current formatting state, used by the merge,
  // banding and conditional-rule sections below.
  // removed, so delete from the end backwards.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      "sheets(properties.sheetId,conditionalFormats,basicFilter,merges,bandedRanges)",
  });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties.sheetId === sheetId
  );

  // Merge the banner across the top. Re-merging an existing merge errors, so
  // only touch it when the current merge doesn't already match.
  const bannerWidth = Math.min(BANNER_SPAN, header.length);
  const existingMerges = (sheet && sheet.merges) || [];
  const bannerMerge = existingMerges.find((m) => m.startRowIndex === 0);
  const bannerMatches =
    bannerMerge &&
    bannerMerge.startColumnIndex === 0 &&
    bannerMerge.endColumnIndex === bannerWidth &&
    bannerMerge.endRowIndex === 1;
  if (!bannerMatches) {
    if (bannerMerge) {
      requests.push({
        unmergeCells: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        },
      });
    }
    requests.push({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: bannerWidth,
        },
        mergeType: "MERGE_ALL",
      },
    });
  }

  // Alternating row colours. Like the conditional rules these stack if simply
  // re-added, so the existing ones go first.
  for (const b of (sheet && sheet.bandedRanges) || []) {
    requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
  }
  requests.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: header.length },
        rowProperties: {
          headerColor: rgb(232, 232, 232),
          firstBandColor: rgb(255, 255, 255),
          secondBandColor: rgb(246, 246, 246),
        },
      },
    },
  });

  const existingRules = (sheet && sheet.conditionalFormats) || [];
  for (let i = existingRules.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }

  const progressCol = col(PROGRESS_H);
  const platinumCol = col("P");
  if (progressCol !== -1) {
    // No endRowIndex: the rules cover the whole column, including rows that
    // don't exist yet, so they never need revisiting as the library grows.
    const ranges = [
      {
        sheetId,
        startRowIndex: 2,
        startColumnIndex: progressCol,
        endColumnIndex: progressCol + 1,
      },
    ];

    // Rules are evaluated in order, so the platinum rule goes first and wins
    // outright where it matches.
    let index = 0;
    if (platinumCol !== -1) {
      requests.push({
        addConditionalFormatRule: {
          index: index++,
          rule: {
            ranges,
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [
                  { userEnteredValue: `=$${colLetter(platinumCol)}3=1` },
                ],
              },
              format: { backgroundColor: PLATINUM_BG },
            },
          },
        },
      });
    }

    // Everything else grades red -> yellow -> green across 0-100% complete.
    requests.push({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges,
          gradientRule: {
            minpoint: { color: PROGRESS_LOW, type: "NUMBER", value: "0" },
            midpoint: { color: PROGRESS_MID, type: "NUMBER", value: "50" },
            maxpoint: { color: PROGRESS_HIGH, type: "NUMBER", value: "100" },
          },
        },
      },
    });
  }

  // Validation applied before the banner existed is anchored to the grid, not
  // to the content, so when the banner pushed everything down a row it ended up
  // covering the header — which is why "Status" and "Rating" show as errors in
  // their own header cells. Clear the top two rows outright before re-applying.
  requests.push({
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 2,
        startColumnIndex: 0,
        endColumnIndex: header.length,
      },
    },
  });

  // Dropdowns. strict:false warns on values outside the list rather than
  // rejecting them, so nothing already in a column gets blocked.
  const dropdown = (name, options) => {
    const i = col(name);
    if (i === -1 || options.length === 0) return;
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 2,
          startColumnIndex: i,
          endColumnIndex: i + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: options.map((o) => ({ userEnteredValue: String(o) })),
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
  };

  dropdown("Rating", RATING_OPTIONS);
  dropdown("Status", STATUS_OPTIONS);

  // Hidden is a checkbox. Ticking it drops the row out of the view via the
  // filter below; untick it, or clear the filter, to get the row back.
  const hiddenCol = col("Hidden");
  if (hiddenCol !== -1) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 2,
          startColumnIndex: hiddenCol,
          endColumnIndex: hiddenCol + 1,
        },
        rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
      },
    });

    // Set the filter once and then leave it alone: re-applying it on every run
    // would throw away whatever sort or extra criteria you'd set up. Delete the
    // filter in Sheets and the next sync will recreate it from scratch.
    // Same problem as the validation above: a filter created before the banner
    // starts on the banner row and treats it as the header. Leave an aligned
    // filter alone so a sort you set survives, but rebuild a misaligned one.
    const existingFilter = sheet && sheet.basicFilter;
    const filterAligned =
      existingFilter &&
      existingFilter.range &&
      existingFilter.range.startRowIndex === 1;
    if (!filterAligned) {
      requests.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: header.length,
            },
            criteria: { [hiddenCol]: { hiddenValues: ["TRUE"] } },
            ...(col("Sort order") !== -1
              ? {
                  sortSpecs: [
                    {
                      dimensionIndex: col("Sort order"),
                      sortOrder: "ASCENDING",
                    },
                  ],
                }
              : {}),
          },
        },
      });
    }
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

// ---- Run --------------------------------------------------------------------
function preflight() {
  const required = ["NPSSO", "SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Running locally? Copy .env.example to .env and use ` +
        `\`node --env-file=.env sync.js\`. Running in GitHub Actions? Add them ` +
        `under Settings > Secrets and variables > Actions. See the README.`
    );
  }
}

async function main() {
  preflight();
  const auth = await getAuth();
  const sheets = getSheetsClient();

  const { spreadsheetId, header, body } = await readSheet(sheets);
  const sheetId = await getSheetId(sheets, spreadsheetId);
  const knownHours = existingHoursMap(header, body);

  const games = await pullTrophyTitles(auth);
  await enrichPlayed(auth, games);
  await enrichPurchased(auth, games);
  await enrichHltb(games, knownHours);

  const dataRowCount = await writeSheet(sheets, spreadsheetId, header, body, games);
  await applyFormatting(sheets, spreadsheetId, sheetId, header, dataRowCount);
}

main().catch((e) => {
  console.error(`\nSync failed: ${e.message}\n`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
