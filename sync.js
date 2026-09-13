import {
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
const COVER_MODE = 1;
const COVER_W = num("COVER_W", 150);      // Cover column width, pixels
const GAME_W = num("GAME_W", 150);        // Game column width
const PLATFORM_W = num("PLATFORM_W", 25); // Platform column width
const ROW_HEIGHT = num("ROW_HEIGHT", 150);
const HEADER_HEIGHT = num("HEADER_HEIGHT", 25);

// Options offered by the Status dropdown, in order. Override with a
// comma-separated list to suit how you actually track things.
const STATUS_OPTIONS = (
  process.env.STATUS_OPTIONS || "Backlog,Playing,Beaten,Platinum,Dropped"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// HowLongToBeat is the slow, flaky step. HLTB_ENABLED=0 skips it entirely.
const HLTB_ENABLED = process.env.HLTB_ENABLED !== "0";
const HLTB_DELAY_MS = num("HLTB_DELAY_MS", 400);
// Covers come from PlayStation key art. If none exists, leave the cell blank
// rather than dropping in the square trophy icon.
const FALLBACK_TO_ICON = false;

const AUTO_HEADERS = [
  "Cover",
  "Game",
  "Platform",
  "Progress %",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Playtime (hrs)",
  "Hours to beat",
  "Last played",
];
const TROPHY_HEADERS = ["Bronze", "Silver", "Gold", "Platinum"];
const PERSONAL_HEADERS = ["Status", "Rating", "Notes", "Goal/Reminder", "Hidden"];
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
          trophies: null,
        };
        entry.playtime = durationToHours(t.playDuration);
        entry.lastPlayed = dateOnly(t.lastPlayedDateTime);
        if (!entry.platform) entry.platform = platformFromCategory(t.category);
        const cov = pickCover(t);
        if (cov) entry.coverUrl = cov; // high-res PSN key art
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
        if (!key) continue;
        const existing = games.get(key);
        if (existing) {
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
  let header = rows[0];
  const body = rows.slice(1);
  // Keep whatever column order the sheet already uses and append only what is
  // missing. Replacing the header wholesale would silently shift every existing
  // row out of alignment the first time a new column is introduced.
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
    for (const h of TROPHY_HEADERS) {
      const i = idx[h];
      if (i === -1) continue;
      const v = g.trophies ? g.trophies[h.toLowerCase()] : undefined;
      row[i] = typeof v === "number" ? v : "";
    }
    if (g.hoursToBeat !== undefined && g.hoursToBeat !== "") {
      row[idx["Hours to beat"]] = g.hoursToBeat;
    }
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
  return finalValues.length - 1;
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

  sizeRows(0, 1, HEADER_HEIGHT);
  if (dataRowCount > 0) sizeRows(1, 1 + dataRowCount, ROW_HEIGHT);

  sizeCol("Cover", COVER_W);
  sizeCol("Game", GAME_W);
  sizeCol("Platform", PLATFORM_W);

  // Keep the header on screen while scrolling a few hundred rows.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
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
          startRowIndex: 1,
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
  numberFormat("Progress %", '0"%"');
  numberFormat("Playtime (hrs)", "0.0");

  // Clear existing rules before re-adding ours. Indices shift as rules are
  // removed, so delete from the end backwards.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties.sheetId,conditionalFormats,basicFilter)",
  });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties.sheetId === sheetId
  );
  const existingRules = (sheet && sheet.conditionalFormats) || [];
  for (let i = existingRules.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }

  const progressCol = col("Progress %");
  const platinumCol = col("Platinum");
  if (progressCol !== -1) {
    // No endRowIndex: the rules cover the whole column, including rows that
    // don't exist yet, so they never need revisiting as the library grows.
    const ranges = [
      {
        sheetId,
        startRowIndex: 1,
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
                  { userEnteredValue: `=$${colLetter(platinumCol)}2=1` },
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

  // Dropdowns. strict:false warns on values outside the list rather than
  // rejecting them, so nothing already in a column gets blocked.
  const dropdown = (name, options) => {
    const i = col(name);
    if (i === -1 || options.length === 0) return;
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 1,
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

  dropdown("Rating", [1, 2, 3, 4, 5]);
  dropdown("Status", STATUS_OPTIONS);

  // Hidden is a checkbox. Ticking it drops the row out of the view via the
  // filter below; untick it, or clear the filter, to get the row back.
  const hiddenCol = col("Hidden");
  if (hiddenCol !== -1) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 1,
          startColumnIndex: hiddenCol,
          endColumnIndex: hiddenCol + 1,
        },
        rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
      },
    });

    // Set the filter once and then leave it alone: re-applying it on every run
    // would throw away whatever sort or extra criteria you'd set up. Delete the
    // filter in Sheets and the next sync will recreate it from scratch.
    const hasFilter = Boolean(sheet && sheet.basicFilter);
    if (!hasFilter) {
      requests.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: header.length,
            },
            criteria: { [hiddenCol]: { hiddenValues: ["TRUE"] } },
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
