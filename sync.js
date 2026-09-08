import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getUserTitles,
  getUserPlayedGames,
  getPurchasedGames,
} from "psn-api";
import { google } from "googleapis";

// ---- Config ----------------------------------------------------------------
const SHEET_TAB = process.env.SHEET_TAB || "Games";

// Cover art sizing. Mode 4 = force an exact pixel box (uniform shape).
// Switch COVER_MODE to 1 if you'd rather fit-without-distortion (may leave
// small gaps for off-ratio images). HLTB box art is ~3:4 portrait.
const COVER_MODE = 4;
const COVER_H = 132; // pixels tall
const COVER_W = 99;  // pixels wide (99x132 ≈ 3:4)
const CELL_PAD = 6;  // extra pixels so the image isn't clipped by the cell
// If HowLongToBeat has no cover, fall back to the (square) PSN trophy icon.
const FALLBACK_TO_ICON = true;

// Columns the script fills automatically. "Cover" is leftmost.
const AUTO_HEADERS = [
  "Cover",
  "Game",
  "Platform",
  "Progress %",
  "Playtime (hrs)",
  "Hours to beat",
  "Last played",
];
// Your columns — the script only ever READS these, so your edits are safe.
const PERSONAL_HEADERS = ["Status", "Rating", "Notes", "Goal/Reminder"];
const ALL_HEADERS = [...AUTO_HEADERS, ...PERSONAL_HEADERS];

// ---- Helpers ----------------------------------------------------------------
const norm = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[™®©:]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Build the =IMAGE() formula for a cover URL (or null if no URL).
function coverFormula(url) {
  if (!url) return null;
  const safe = String(url).replace(/"/g, "").replace(/^http:/, "https:");
  return COVER_MODE === 4
    ? `=IMAGE("${safe}", 4, ${COVER_H}, ${COVER_W})`
    : `=IMAGE("${safe}", ${COVER_MODE})`;
}

// ---- PSN pulls --------------------------------------------------------------
async function getAuth() {
  const npsso = process.env.NPSSO;
  if (!npsso) throw new Error("Missing NPSSO env var.");
  const accessCode = await exchangeNpssoForAccessCode(npsso);
  return exchangeAccessCodeForAuthTokens(accessCode);
}

// Reliable backbone: every game you've earned a trophy in, plus progress %.
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
        iconUrl: t.trophyTitleIconUrl || "", // square fallback cover
        coverUrl: "",
      });
    }
    if (titles.length < limit) break;
    offset += limit;
  }
  return games;
}

async function enrichPlayed(auth, games) {
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
      for (const t of titles) {
        const key = norm(t.name);
        if (!key) continue;
        const entry = games.get(key) || {
          name: t.name,
          platform: platformFromCategory(t.category),
          progress: "",
          iconUrl: "",
          coverUrl: "",
        };
        entry.playtime = durationToHours(t.playDuration);
        entry.lastPlayed = dateOnly(t.lastPlayedDateTime);
        if (!entry.platform) entry.platform = platformFromCategory(t.category);
        games.set(key, entry);
      }
      if (titles.length < limit) break;
      offset += limit;
    }
  } catch (e) {
    console.warn("Playtime pull skipped:", e.message);
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
        if (!key || games.has(key)) continue;
        games.set(key, {
          name: t.name,
          platform: platformFromCategory(t.category),
          progress: "",
          playtime: "",
          lastPlayed: "",
          iconUrl: "",
          coverUrl: "",
        });
      }
      if (titles.length < limit) break;
      offset += limit;
    }
  } catch (e) {
    console.warn("Purchased-games pull skipped:", e.message);
  }
}

// Best-effort: "hours to beat" + portrait cover art from HowLongToBeat.
// Cached: games already carrying an hours value in the sheet are skipped.
async function enrichHltb(games, knownHours) {
  try {
    const mod = await import("howlongtobeat");
    const HowLongToBeatService =
      mod.HowLongToBeatService ||
      (mod.default && mod.default.HowLongToBeatService);
    const service = new HowLongToBeatService();

    for (const [key, g] of games) {
      if (knownHours.has(key)) {
        g.hoursToBeat = knownHours.get(key);
        continue; // cover for these is preserved from the sheet
      }
      try {
        const results = await service.search(g.name);
        if (results && results.length) {
          results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
          const best = results[0];
          if ((best.similarity || 0) >= 0.4) {
            g.hoursToBeat = best.gameplayMain || best.gameplayMainExtra || "";
            if (best.imageUrl) g.coverUrl = best.imageUrl;
          }
        }
      } catch {
        // one bad lookup shouldn't stop the rest
      }
      await sleep(300);
    }
  } catch (e) {
    console.warn("HowLongToBeat pull skipped:", e.message);
  }
}

// ---- Google Sheets ----------------------------------------------------------
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
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
  if (!found) throw new Error(`Tab "${SHEET_TAB}" not found.`);
  return found.properties.sheetId;
}

async function readSheet(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("Missing SHEET_ID env var.");
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_TAB,
    valueRenderOption: "FORMULA", // so existing =IMAGE() formulas survive
  });
  const rows = read.data.values || [];
  let header = rows[0];
  const body = rows.slice(1);
  const headerLooksValid = header && ALL_HEADERS.every((h) => header.includes(h));
  if (!headerLooksValid) header = [...ALL_HEADERS];
  return { spreadsheetId, header, body };
}

function existingHoursMap(header, body) {
  const map = new Map();
  const gameCol = header.indexOf("Game");
  const hoursCol = header.indexOf("Hours to beat");
  if (hoursCol === -1) return map;
  for (const r of body) {
    const key = norm(r[gameCol]);
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
    row[idx["Game"]] = g.name;
    row[idx["Platform"]] = g.platform || "";
    row[idx["Progress %"]] = g.progress === "" ? "" : g.progress;
    row[idx["Playtime (hrs)"]] = g.playtime ?? "";
    row[idx["Last played"]] = g.lastPlayed || "";
    if (g.hoursToBeat !== undefined && g.hoursToBeat !== "") {
      row[idx["Hours to beat"]] = g.hoursToBeat;
    }
    // Cover: a fresh HLTB cover wins; otherwise keep whatever is there;
    // only if the cell is empty do we drop in the square icon fallback.
    const existingCover = row[idx["Cover"]];
    if (g.coverUrl) {
      row[idx["Cover"]] = coverFormula(g.coverUrl);
    } else if (!existingCover && FALLBACK_TO_ICON && g.iconUrl) {
      row[idx["Cover"]] = coverFormula(g.iconUrl);
    }
  };

  const rowByKey = new Map();
  for (const r of body) {
    const key = norm(r[gameCol]);
    if (key) rowByKey.set(key, r);
  }

  for (const [key, g] of games) {
    const existing = rowByKey.get(key);
    if (existing) {
      pad(existing);
      setAuto(existing, g);
    }
  }

  const newGames = [...games.entries()].filter(([k]) => !rowByKey.has(k));
  newGames.sort((a, b) => (b[1].lastPlayed || "").localeCompare(a[1].lastPlayed || ""));
  const appended = newGames.map(([, g]) => {
    const r = pad([]);
    setAuto(r, g);
    return r;
  });

  const finalValues = [header, ...body, ...appended];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: finalValues },
  });

  console.log(`Synced ${games.size} games (${appended.length} new).`);
  return finalValues.length - 1; // number of data rows
}

// Size the cover column + data rows so every image sits in an identical box.
async function sizeCovers(sheets, spreadsheetId, sheetId, dataRowCount) {
  if (dataRowCount < 1) return;
  const requests = [
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: COVER_W + CELL_PAD },
        fields: "pixelSize",
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: 1,
          endIndex: 1 + dataRowCount,
        },
        properties: { pixelSize: COVER_H + CELL_PAD },
        fields: "pixelSize",
      },
    },
  ];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// ---- Run --------------------------------------------------------------------
async function main() {
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
  await sizeCovers(sheets, spreadsheetId, sheetId, dataRowCount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
