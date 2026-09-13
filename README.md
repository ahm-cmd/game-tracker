# Game Tracker

Keeps a Google Sheet in sync with your PlayStation library — cover art, trophy
progress, playtime, and an estimate of how long each game takes to finish — while
leaving your own columns (status, rating, notes) untouched.

It runs itself. A GitHub Action fires once a day; you never open a terminal after setup.

<!-- TODO: screenshot your sheet, save it as docs/screenshot.png, and uncomment
     the line below. A picture of the cover-art grid is the entire pitch. -->
<!-- ![The synced sheet](docs/screenshot.png) -->

## What lands in the sheet

Seven columns are written by the sync and will be overwritten on every run:

| Column | Source |
|---|---|
| Cover | PlayStation key art, embedded with `=IMAGE()` |
| Game | PSN title name |
| Platform | PS5 / PS4 / PS3 / PS Vita |
| Progress % | Trophy completion |
| Playtime (hrs) | PSN play duration |
| Hours to beat | [HowLongToBeat](https://howlongtobeat.com) main-story estimate |
| Last played | Date only |

Four more are yours. The sync never writes to them:

**Status** · **Rating** · **Notes** · **Goal/Reminder**

Games are matched between runs by a normalized title, so your notes stay attached
to the right row even when PSN changes a name's punctuation. A game that appears
on both PS4 and PS5 collapses into a single row.

## Setup

Roughly 15 minutes, most of it in Google Cloud. You need a Google account and a
PlayStation account.

### 1. Create the sheet

Make a new Google Sheet. Rename the first tab to **`Games`** (exact, case-sensitive).
Put these headers in row 1:

```
Cover | Game | Platform | Progress % | Playtime (hrs) | Hours to beat | Last played | Status | Rating | Notes | Goal/Reminder
```

Order doesn't matter and you can add extra columns of your own — the script finds
columns by name. If row 1 is empty or missing any of the eleven, the script writes
the full header itself on the first run.

From the sheet's URL, grab the ID:

```
https://docs.google.com/spreadsheets/d/<THIS_IS_YOUR_SHEET_ID>/edit
```

### 2. Create a Google service account

The script writes to your sheet as a robot user, not as you.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project.
2. Enable the **Google Sheets API** for it (APIs & Services → Library → search "Sheets").
3. APIs & Services → Credentials → **Create credentials** → **Service account**. Name it anything; skip the optional role and access steps.
4. Open the new service account → **Keys** → Add key → **Create new key** → **JSON**. A file downloads. This file is a credential — treat it like a password.
5. Copy the `client_email` from that file (it looks like `something@your-project.iam.gserviceaccount.com`).
6. Back in your Google Sheet, click **Share** and give that email **Editor** access.

Step 6 is the one people miss. Without it every run fails with a permission error.

### 3. Get your NPSSO token

This is your PlayStation session token.

1. Log in at [playstation.com](https://www.playstation.com).
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character value of `npsso`.

> **It expires about every two months.** When your sync starts failing, this is
> almost always why — repeat these three steps and update the secret.

### 4. Wire it up

Fork this repo, then add three repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `NPSSO` | The token from step 3 |
| `SHEET_ID` | The ID from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The **entire contents** of the JSON key file from step 2 |

Then run it once by hand: **Actions → Sync PSN games → Run workflow**. The first run
takes a few minutes because every game needs a HowLongToBeat lookup; later runs reuse
the values already in the sheet and finish in about two.

After that it runs daily at 08:00 UTC. Change the `cron` line in
[`.github/workflows/sync.yml`](.github/workflows/sync.yml) if you'd rather it ran
at another time.

## Running locally

Node 20.6 or newer.

```bash
npm ci
cp .env.example .env   # then fill it in
node --env-file=.env sync.js
```

## Configuration

Everything optional, set as environment variables (or as repository *variables*
in the Actions settings):

| Variable | Default | Effect |
|---|---|---|
| `SHEET_TAB` | `Games` | Which tab to write to |
| `COVER_W` / `COVER_H` | `99` / `132` | Cover art cell size, in pixels |
| `HLTB_ENABLED` | `1` | Set to `0` to skip HowLongToBeat lookups entirely |
| `HLTB_DELAY_MS` | `400` | Pause between HowLongToBeat lookups |

## How it works

```
PSN trophy titles ─┐
PSN played games  ─┼─► merge by normalized title ─► HowLongToBeat ─► Google Sheet
PSN purchases     ─┘
```

Three PSN endpoints are merged because none is complete on its own: trophy titles
give completion percentages, played games give playtime and the high-resolution key
art, and purchases catch games you own but have never launched.

The sheet is read before it's written, so existing rows are updated in place and
only genuinely new games get appended. HowLongToBeat is the slow, flaky dependency,
so any value already sitting in the sheet is reused rather than looked up again —
which also means you can correct a wrong estimate by hand and it will stick.

## Caveats

- **Don't edit the sheet while a sync is running.** The script reads the whole tab, then writes the whole tab back. An edit made in between will be overwritten.
- HowLongToBeat scrapes an unofficial source. It breaks occasionally; when it does, the run logs how many lookups succeeded and continues without those values.
- Deleting a row doesn't blacklist the game — the next sync will add it back.
- Cover art is PlayStation key art. Some older titles have none, and those cells stay blank.

## Built with

[`psn-api`](https://github.com/achievements-app/psn-api) ·
[`howlongtobeat-core`](https://www.npmjs.com/package/howlongtobeat-core) ·
[`googleapis`](https://github.com/googleapis/google-api-nodejs-client)

## License

MIT — see [LICENSE](LICENSE).
