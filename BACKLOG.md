# Backlog

Ideas waiting to be built. Newest at the bottom. Items move to "Done" once shipped.

## Open

### 2. Accounts and sync across devices
- **Scheduled:** Fri Dec 4, 8:00 AM (US Central)
- **What:** sign in, and see the same tasks, habits, workouts, journal and settings on every device (e.g. iPhone + iPad + computer).
- **Feasible:** yes. It builds on the push server already running on Cloudflare (Worker + D1).
- **Things to decide or build:**
  - **Sign-in method:** passkeys (Face ID / Touch ID, no password; works in Home Screen web apps on iOS 16+), or an emailed sign-in link (needs an email-sending service).
  - **Profiles:** how they map to accounts. One account holding all profiles, or one account per person.
  - **Conflicts:** edits made offline on two devices need merging. The app already has per-item timestamps from the old-tab merge work, which helps.
  - **Privacy:** the data would live on your Cloudflare server. End-to-end encryption, where only your devices can read it, is possible but makes recovery harder if you lose every device.
  - **Storage limits:** photos and Genmoji icons count against free-tier limits. These are fine for one household.
- **Size:** large (the biggest item here).
- **Added:** 2026-11-16

### 4. Weather line on Today
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central), together with #4, #6, #7 and #8
- **What:** a small, non-interactive line under the week strip on Today, e.g. "📍 Springfield · ⛅ 72° / 51° · 💧 20%":
  - today's high/low temperature and chance of precipitation
  - the location name
- **Other days:** when another day within the next 7 days is selected in the week strip, the line shows that day's forecast. Days past 7, and past days, show nothing.
- **Shown nowhere else.**
- **Feasible:** yes.
  - **Forecast source:** Open-Meteo, which is free with no API key and works directly from the app (no server needed).
  - **Location:** your phone's location, with a one-time permission prompt. A city typed in Settings could be a fallback.
  - **Location name:** turning coordinates into a city name needs a small reverse-geocoding lookup.
- **Notes:**
  - It needs internet. Offline, it shows the last forecast it fetched (marked as stale) or hides itself.
  - Your approximate location is sent to the weather service. Precision can be rounded to about 1 km for privacy.
  - °F/°C and units would follow a setting.
- **Size:** small–medium.
- **Added:** 2026-11-16

### 6. Image attachments on tasks
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central), together with #4, #6, #7 and #8
- **What:** attach one or more photos or images to a task, shown on the View task screen; tap one to see it full size.
- **Feasible:** yes.
- **Notes:**
  - **Storage:** images can't go in the app's current storage (localStorage, about 5 MB shared by all profiles). They'd be stored in the browser's larger on-device database (IndexedDB), shrunk on the phone first (e.g. up to ~1600 px, JPEG).
  - **Backups:** Export/Import would need to include the images, so backup files get bigger.
  - **Sync:** item #2 would have to upload them too.
  - **Clean-up:** deleting a task deletes its images, unless Undo is used.
- **Size:** medium.
- **Added:** 2026-11-16

### 7. Completed tasks history
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central), together with #4, #6, #7 and #8
- **What:** a place to see every completed task, searchable, and filterable by category, date (range), priority and so on.
- **Feasible:** yes; all the data is already stored.
- **Open details:**
  - **Location:** probably a "Completed" entry reachable from Today and from Stats.
  - **Repeating tasks:** each completed occurrence appears as its own row.
  - **Actions:** tapping a row opens View task, so you can un-complete it.
- **Size:** small–medium.
- **Added:** 2026-11-16

### 8. Reminder-note polish (from v1.8.1 QA and user feedback)
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central), together with #4, #6 and #7
- **What:**
  - **No positive message:** never say "Reminders arrive even when the app is closed". Only show a note when reminders will **not** arrive while the app is closed: push off or unhealthy, notifications blocked, or iOS not installed to the Home Screen.
  - **Blocked notifications:** the habit form currently contradicts the "notifications blocked" note; the reach check must also require notification permission.
  - **No duplicate line** in the habit form.
  - **Focus after delete:** after deleting a task from the View task screen, keyboard focus should go to the next item instead of getting lost.
- **Size:** small.
- **Added:** 2026-11-16

## Done

### 1. Mark a habit or task as "missed"
- **What:** an option (in the long-press menu) to mark today's habit or task as missed, which takes it off the Today list because there's no chance to do it anymore. Example: "Morning prayer" was missed this morning.
- **Rules:**
  - Marking missed only hides it from Today for that day. It is not required: anything not marked complete already counts as missed.
  - It doesn't count as done: streaks and completion stats treat it exactly like any other missed day.
  - Should be undoable (Undo toast, and "Unmark missed" from the menu or from a small "Missed (n)" section).
- **Added:** 2026-11-15
- **Shipped:** v1.7.1 (2026-11-16)

### 3. Workouts progress table
- **What:** one easy-to-scan table of every strength exercise, with columns for:
  - most recent 3×5 weight (and its date), if any
  - best 3×5 weight
  - 1-rep max
- **Feasible:** yes. All the numbers already exist in the records logic.
- **Open details:**
  - **Placement:** likely the top of the Workouts tab, plus a link from Stats.
  - **Sorting:** probably by name, or by most recently trained.
  - **Scope:** whether to include bodyweight exercises with a vest (likely not; strength only, as asked).
- **Size:** small.
- **Added:** 2026-11-16
- **Shipped:** v1.8.0 (2026-11-16)

### 5. Non-daily habits counted by their own frequency
- **What:** habits that aren't daily (e.g. "Work out 3×/week") shouldn't drag down the daily completion percentage. They're judged only against their own target:
  - Hitting 3 of 3 in a week counts as 100%.
  - Days without it aren't counted as misses.
  - Doing it 5 times still counts as 100%, with no extra credit.
- **Feasible:** yes; it's a change to how stats are calculated.
- **Decided (2026-11-16):**
  - **Today:** an X-per-week habit shows on Today as a weekly habit with how many are still needed this week (e.g. "2 left this week"). It does **not** count toward that day's progress ring.
  - **"Specific days" habits** (e.g. Mon/Wed/Fri) count exactly like daily habits, but only on their scheduled days.
  - **The current week:** it isn't counted against you until it ends. As soon as the weekly target is met, it counts as complete in weekly/overall progress (no need to wait for the week to end).
  - **Capping:** a week counts as complete when the target is met. Extra sessions beyond the target add nothing.
  - **First, partial week** (habit created mid-week): counts like any other week. If the target isn't met, it's a miss. Decided 2026-11-16, option (c).
- **Size:** small–medium.
- **Added:** 2026-11-16
- **Shipped:** v1.8.0 (2026-11-16)
