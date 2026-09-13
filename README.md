Keeps a Google Sheet synced with your PlayStation library.
Synced elements include: cover art, trophy counts by grade, trophy progress, time played, and an estimate of how long each game takes to finish.
Manual elements include: status, rating, notes, goal/reminder, and hidden.

Games that appear on both PS4 and PS5 are recorded in a single row.

## Columns

Written by the sync, and overwritten on every run:

Cover, Game, Platform, Source, Progress %, Bronze, Silver, Gold, Platinum, Playtime (hrs), Hours to beat, Last played, Sort order.

Bronze, Silver, and Gold are the counts of trophies you have earned in that game. Platinum is 1 if you have the platinum and 0 if you do not.

Source is filled in automatically from PlayStation's own records: "Purchased" if you own the game outright, "PS Plus" if you have it through the subscription. It reflects how you have access right now, so a Plus game you later buy outright will change.

Game titles link to their PlayStation Store page where Sony provides one.

Sort order is a formula, explained under Priority below.

Yours to fill in. The sync never writes a value into these:

Status, Priority, Rating, Price paid, Notes, Goal/Reminder, Hidden.

If you already have a sheet that is missing some of these columns, the script adds only the ones that are absent and leaves your existing columns where they are, so nothing shifts out of alignment.

## Formatting

The sync sets these up so the sheet stays readable as it grows.

1. Progress % is shaded from red to green as completion increases. Any game with the platinum is shaded light blue instead, so finished games stand out. A game with no trophies earned reads 0% and sits at the red end, rather than being left blank.
2. Status is a dropdown: Backlog, In Queue, Playing, Ongoing, Beaten, Platinum, Dropped. Configurable, see below.
3. Rating is a dropdown from 1 to 5 in half steps, so 3.5 is available.
4. Priority is yours to fill in. Enter 1 for the next game you intend to play, 2 for the one after, and so on. The Sort order column works out the actual running order from it: anything marked Beaten, Platinum, or Dropped sinks to the bottom, games with no priority sit in the middle, and your numbered games rise to the top. Sort by Sort order to see that list. It is a live formula, so changing a Status or a Priority reorders things straight away without waiting for a sync.
5. Price paid is yours to fill in, formatted to two decimal places.
6. Hidden is a checkbox. Tick it and the row drops out of the view. The row is not deleted and keeps syncing, it is only filtered out. To see hidden rows again, open the filter on the Hidden column and re-check TRUE, or clear the filter.
7. A banner across the top shows when the sync last ran. If that timestamp stops moving, the Action has stopped working.
8. The banner and header rows are frozen, so they stay visible while scrolling.
9. Rows alternate between white and light grey.
10. Progress % displays as a percentage, and Playtime displays to one decimal. Both are still numbers underneath, so sorting and the colour scale keep working.
11. Rows are 150px tall to give the cover art room, with a 25px header. Cover, Game, and Platform have fixed widths.

## Running through GitHub Actions

1. Create a new Google Sheet. Rename the first tab to "Games".
2. Grab the Sheet's URL ID and save it for later.
```
https://docs.google.com/spreadsheets/d/<THIS_IS_YOUR_SHEET_ID>/edit
```
3. Create a Google service account.
4. Open the [Google Cloud console](https://console.cloud.google.com/). Create a project.
5. Enable Google Sheets API: **APIs & Services > Library > search "Sheets"**.
6. Open the new service account > **Keys > Add key > Create new key > JSON**. Save this file for later.
7. Copy the "client_email" from that file:
```
"something@your-project.iam.gserviceaccount.com"
```
8. In your Sheet, click **Share** and give Editor access to your "client_email" address.
9. Log in at [Playstation](https://www.playstation.com).
10. Now that you've logged in, open (https://ca.account.sony.com/api/v1/ssocookie).
11. Copy the 64-character "npsso" value and save it for later. This is your PlayStation session token, and could be used to access your account if leaked. *Keep it private.*
12. Note that this value expires every two months or so, so you will need to remember to retrieve a new NPSSO token when this one expires.
13. Fork this repo. You will now add three repository secrets.
14. In your new repo, go to **Settings > Secrets and variables > Actions**.
15. Enter three new secrets, named exactly as seen below.
16. 'NPSSO': the token from step 11.
17. 'SHEET_ID': the URL ID from step 2.
18. 'GOOGLE_SERVICE_ACCOUNT_KEY': the entire contents of the JSON file from step 6.
19. Run the Workflow once by hand. In your forked repo, **Actions > Sync PSN games > Run workflow**. It may take a few minutes.
20. Now that you've run it once, the Workflow will run once daily at 8:00 UTC. This time is configurable in the "cron" line in [.github/workflows/sync.yml](.github/workflows/sync.yml).

## Running locally

Node 22 or newer is required (googleapis will not run on anything older).

```bash
npm ci # "clean install command" that reads package-lock.json and installs those versions
cp .env.example .env # this makes a file, .env, from the template .env.example. Open. env in a text editor and fill in the three "Secrets" listed above: NPSSO, SHEET_ID, and GOOGLE_SERVICE_ACCOUNT_KEY
node --env-file=.env sync.js # runs the script itself
```
After setup, you can run ```npm run sync:local``` for convenience.

## Configuration

Several variables you may want to adjust.

Variable: "SHEET_TAB"
Default: "Games"
Note: Determines the tab name in the shared Sheet that the Action's output will write to.

Variable: "COVER_W" / "GAME_W" / "PLATFORM_W"
Default: 150 / 150 / 25
Note: Column widths in pixels.

Variable: "BANNER_SPAN" / "BANNER_HEIGHT"
Default: 5 / 28
Note: How many cells the last-synced banner spans across the top, and how tall that row is.

Variable: "PRICE_FORMAT"
Default: 0.00
Note: Number format for the Price paid column. Change it if you want a currency symbol, e.g. "£"#,##0.00

Variable: "COVER_MODE"
Default: 1
Note: 1 scales cover art to fit the cell without distorting it. 4 forces an exact pixel box and will stretch art that is not that shape.

Variable: "ROW_HEIGHT" / "HEADER_HEIGHT"
Default: 150 / 25
Note: Row heights in pixels. Cover art scales to fit the cell.

Variable: "STATUS_OPTIONS"
Default: Backlog,Playing,Beaten,Platinum,Dropped
Note: Comma-separated list of choices in the Status dropdown.

Variable: HLTB_ENABLED
Default: 1
Note: Set to 0 to skip HowLongToBeat lookups

Variable: HLTB_DELAY_MS
Default: 400
Note: Pause between each HLTB lookup. Lowering this value may result in rejected calls to HLTB.

## How it works

On first run, all necessary rows and titles populate the "Game" sheet. Trophy titles, played games, and purchases import via your PlayStation session token. All entries are merged by normalized titles. On subsequent runs, existing rows are updated in place and rows are only created when new games have been added to your PlayStation library since the last run. HowLongToBeat values are never updated given the slow and unreliable nature of calls to its database.

## When it breaks

If a scheduled run fails, the workflow opens an issue on your repo with a link to the run log, instead of failing quietly. It will not open a second issue while the first one is still open. The most common cause is an expired NPSSO token, see step 12.

## Restrictions

Don't edit the sheet while a sync is working. Because the script reads the whole tab and writes it all back, any edits will be overwritten.
HowLongToBeat is not always reliable for the purposes of this project, and access may break in the future.
Deleting a row is not the way to hide a game from your list, since the next sync will just add it back. Tick the Hidden checkbox instead.
Cover art is drawn directly from Sony's servers. Older titles without cover art will appear blank.
Sony does not publish key art for every title. Where it is missing, the sheet keeps whatever cover it already had rather than blanking the cell.
The sync owns conditional formatting on the Games tab. It clears the existing rules and rebuilds its own on every run, so custom colour rules added there will not survive. Borders, fonts, and other formatting are left alone.
The sync also owns the row banding and the banner merge at the top of the sheet, rebuilding both on every run. It does not touch fonts, borders, text wrapping, or vertical alignment, so anything you set there by hand will survive.
The filter is created once and then left alone, so any sort or extra criteria you add will survive future syncs. Delete the filter in Sheets and the next run will rebuild the default one.

## Built with

[`psn-api`](https://github.com/achievements-app/psn-api) ·
[`howlongtobeat-core`](https://www.npmjs.com/package/howlongtobeat-core) ·
[`googleapis`](https://github.com/googleapis/google-api-nodejs-client)

## License

MIT — see [LICENSE](LICENSE).
