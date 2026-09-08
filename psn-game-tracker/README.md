# PSN Game Tracker

Pulls your PlayStation games and progress into a Google Sheet on a schedule,
for free, via GitHub Actions. You open the Sheet; the sheet keeps itself
current. The script only touches the "auto" columns, so your own notes,
ratings, and goals are never overwritten.

## What ends up in the Sheet

| Column | Filled by |
|---|---|
| Cover | script (box art from HowLongToBeat, forced to a uniform box; square PSN icon as fallback) |
| Game | script |
| Platform | script |
| Progress % | script (trophy completion, 0–100 — this is trophies earned, not story %) |
| Playtime (hrs) | script (best-effort) |
| Hours to beat | script (best-effort, from HowLongToBeat — main-story estimate) |
| Last played | script (best-effort) |
| Status | **you** |
| Rating | **you** |
| Notes | **you** |
| Goal/Reminder | **you** |

---

## One-time setup

### 1. Make the Sheet
- Create a new Google Sheet. Rename the first tab to `Games`.
- In row 1, paste these headers across A1:K1:
  `Cover`, `Game`, `Platform`, `Progress %`, `Playtime (hrs)`, `Hours to beat`, `Last played`, `Status`, `Rating`, `Notes`, `Goal/Reminder`
- Copy the **Sheet ID** from the URL — it's the long string between `/d/` and `/edit`.

### 2. Make a Google service account (so the script can write)
- Go to console.cloud.google.com → create a project (any name).
- "APIs & Services" → **enable the Google Sheets API**.
- "Credentials" → Create credentials → **Service account**. Name it, create.
- Open the service account → "Keys" → Add key → **Create new key → JSON**. A `.json` file downloads. Keep it private.
- Copy the service account's **email** (looks like `name@project.iam.gserviceaccount.com`).
- **Back in your Sheet, click Share and give that email Editor access.** This is the step everyone forgets — without it the script can't write.

### 3. Get your PSN token
- Log in at playstation.com, then open `https://ca.account.sony.com/api/v1/ssocookie` in the same browser.
- Copy the 64-character `npsso` value from the JSON.

### 4. Put it all on GitHub
- Create a new GitHub repo and add these files (sync.js, package.json, .github/workflows/sync.yml, .gitignore, this README).
- In the repo: Settings → Secrets and variables → Actions → **New repository secret**, add three:
  - `NPSSO` — the 64-char token from step 3
  - `SHEET_ID` — from step 1
  - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the **entire contents** of the JSON file from step 2

### 5. Run it
- Actions tab → "Sync PSN games" → **Run workflow**. Watch the log; then check your Sheet.
- It'll then run automatically once a day. Change the `cron` line in `sync.yml` for a different time/frequency.

---

## Ongoing upkeep

Almost none — but the PSN token expires roughly every couple of months. When
the sheet stops updating, redo step 3 and update the `NPSSO` secret with the
fresh value. That's it.

## Notes & limits
- PSN has no official public API; this uses the community `psn-api` library.
  Treat your NPSSO like a password.
- Progress is trophy-based, so games with no trophies show blank progress.
- Playtime/last-played and purchased-but-unplayed titles are best-effort; if
  PSN changes those endpoints, those columns may go blank but games + progress
  keep working.
- "Hours to beat" comes from HowLongToBeat via an unofficial scraper (the
  `howlongtobeat` package), matched by game name. It's looked up once per game
  and then reused from the sheet, so daily runs don't re-scrape it. A game whose
  name doesn't confidently match anything on HLTB is left blank — you can always
  type a value in by hand and the script won't overwrite it.
- Cover art is inserted with the `=IMAGE()` formula, which only accepts public
  HTTPS URLs (fine for PSN/HLTB) and caps each image at 2 MB / 1500 px (covers
  are far smaller). The script sets the cover column width and every row's
  height so images share one uniform box. Tweak `COVER_H` / `COVER_W` at the top
  of `sync.js`, or set `COVER_MODE = 1` to fit-without-distortion instead of
  forcing an exact box. For a very large library, hundreds of images can be slow
  to load in the browser — if that bites, you can limit covers to games you
  actually care about.
