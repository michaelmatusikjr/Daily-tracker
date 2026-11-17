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
- **Decided (2026-11-17):**
  - **Sign-in:** a **passkey** (Face ID / Touch ID), with a **username + password as backup** sign-in. Store passwords only as a strong salted hash (e.g. PBKDF2 via WebCrypto on the Worker) and rate-limit attempts.
  - **One account holds all profiles** (a household account).
  - **End-to-end encryption on:** only the user's devices can read the data. The password can unlock the encryption key, plus a one-time **recovery key** to save, so the data isn't lost if every device is lost.
  - **Photos sync too:** task photos and habit image icons.
  - **Devices:** all of them (iPhone, iPad, computers), so test across Safari, Chrome and Firefox.

### 4. Weather line on Today
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central)
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
- **Decided (2026-11-17):**
  - **Units:** °F by default, changeable in Settings (°F/°C).
  - **Location:** the phone's location by default. If permission is denied, prompt to add a city.
  - **Location pill:** the location on the weather line is a tappable pill with an up/down chevron icon (⌃ over ⌄) showing it can be changed. This is the only interactive part of the weather line.
  - **The dropdown** lists "Current location" plus saved locations; select one, add a new one (search by city/ZIP), or delete one. The choice is remembered per profile.

### 9. Move the "Completed" link to the Calendar tab
- **What:** remove "Completed ›" from the progress card on Today, and put the entry point somewhere on the Calendar tab, e.g. a "Completed tasks" button in the Calendar header. The Stats link can stay or go with the Stats tab (see #14).
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update
- **Decided (2026-11-17):** a "Completed tasks" button at the top of the Calendar tab.

### 10. Bug: tapping a notification for another profile
- **What:** tapping a notification that belongs to a different profile sometimes doesn't switch to that profile. Once it did switch, but the accent colour stayed the old profile's.
- **Fix:** the switch must always happen, and must apply that profile's theme and accent, both when the app is already open and when it's launched from the notification.
- **Type:** bug.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 11. Default task time and default alert per profile
- **What:** each profile can set a default task time (e.g. 6:00 AM) and a default alert (e.g. "at time of event").
- **Example:** with those defaults, adding "Dentist tomorrow" gives a task at 6:00 AM tomorrow with an alert at 6:00 AM, with no extra steps.
- **Decided (2026-11-17):**
  - **New tasks:** they stay Anytime unless a time is chosen.
  - **Anytime tasks:** get a default reminder at **6:00 AM** on their day. The time is a per-profile setting, default 6:00 AM.
  - **Tasks with a time:** get a default reminder **at the time of the event**. It can be removed or changed per task.
  - Applies to quick add too.
- **Size:** small–medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 12. Bug: reminder doesn't fire again after moving a task later
- **What:** if a task's reminder has already gone off and the task's time is changed to later, the new reminder never comes.
- **Fix:** changing the time (or date) re-arms the reminder for the new time, both in the app's own timers and on the push server, which currently remembers "already sent for that day".
- **Type:** bug.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 13. Remove the encouragement text on Today's top card
- **What:** remove "More than halfway there" and any similar message that appears on the progress card at the top of Today.
- **Size:** tiny.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 14. Journal tab and reorganised tabs
- **What:**
  - **Journal on Today:**
    - Remove the journal box at the bottom of Today; new entries are added from the **+** button.
    - On previous days that have an entry, Today shows it read-only. Nothing shows if there's no entry.
    - Entries can be edited or deleted with a long-press.
  - **New Journal tab** replaces the Stats tab, listing all entries, newest first. Probably searchable, like Completed.
  - **Habits tab** gets two tabs: **Active habits** and **Stats** (the habit stats move here). Remove the "+" at the top; the bottom "+" is enough.
  - **Workouts tab** gets two tabs: **Workouts** and **Stats** (the workout stats and progress table). Remove the "Log workout" button at the top; the bottom "+" is enough.
- **Decided (2026-11-17):** the remaining general stats (today's %, task counts, 7/30-day chart, etc.) are **removed**, not moved.
- **Open detail:** whether the journal mood picker stays (assume yes unless told otherwise).
- **Size:** medium–large.
- **Added:** 2026-11-17
- **Scheduled:** Fri Dec 4, 8:00 AM (US Central) update
- **Decided (2026-11-17):** keep the 5-emoji mood picker with journal entries.

### 15. No zooming or selecting UI
- **What:**
  - Disable pinch/double-tap zoom everywhere except the full-screen photo viewer.
  - Make buttons, labels and lists unselectable. Only editable text (inputs, notes being edited) can be selected.
- **Note:** iPhone Safari ignores the usual "no zoom" setting, so this is done with touch handling instead. It also removes zoom as an accessibility aid; text sizes should stay comfortable.
- **Decided (2026-11-17):** OK to block zoom via touch handling, accepting the accessibility trade-off.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 16. Crop and adjust the profile photo
- **What:** when setting a profile photo, show a crop step: drag to position, pinch or slider to zoom, in a round preview, before saving.
- **Optional:** simple brightness/rotate adjustments.
- **Size:** small–medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update
- **Decided (2026-11-17):** crop (drag + zoom) and rotate; no brightness.

### 17. Habit target time, and a "time running out" reminder
- **What:**
  - **Target time:** each habit gets a "complete by" time (e.g. "Work out before 8:00 AM") or **Anytime**. This replaces the Morning/Afternoon/Evening grouping.
  - **Reminder for a habit with a target time:** an "X minutes before target" setting. Example: floss before 8:00 AM with a 30-minute warning gives "30 minutes left to floss" at 7:30 AM, **only if it isn't done yet**.
  - **Anytime habits** keep a normal reminder at any chosen time.
- **Notes:**
  - Existing Morning/Afternoon/Evening habits need a sensible conversion, or Anytime plus a prompt.
  - The push server already skips reminders once a habit is marked done and synced.
- **Size:** medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update
- **Decided (2026-11-17):**
  - **Converting existing habits:** Morning → by 12:00 PM, Afternoon → by 5:00 PM, Evening → by 9:00 PM.
  - **"Time running out" warning:**
    - The default is **30 minutes before** the target.
    - The default can be changed or turned off in Settings.
    - Each habit can also change or remove its own warning.

### 18. Habits in the schedule alongside tasks
- **What:** on Today, habits with a target time appear in the timeline with the timed tasks, at their target time. Anytime habits join the Anytime list with untimed tasks, and both can be dragged to reorder together.
- **Depends on:** #17.
- **Size:** medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update
- **Decided (2026-11-17):** a habit sits in the timeline at its target time, shown like "Floss · by 8:00 AM".

### 19. Photo import edge case (from v1.9.1 QA)
- **What:** if a crafted backup's photo has to be renamed and a later photo then fails to save (storage full), the imported task can keep pointing at the old id. That id belongs to another profile, so deleting the task could delete that profile's photo.
- **Fix:** `importFiles` returns the rename list even when it stops early, and the caller always rewrites task references before reporting the error.
- **Note:** this can't happen with the app's own backups.
- **Type:** bug (low).
- **Size:** tiny.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

### 20. Habit photo icons fill the whole icon
- **What:**
  - Habit image icons that are photos fill the entire rounded square. They scale so the shorter side matches the square, with the overflow cropped (centred), and no letterbox bars.
- **Details:**
  - **New photos:** cropped to a square when picked, using the same crop/zoom/rotate step as the profile photo (#16) so the user can position it.
  - **Genmoji/stickers with transparency:** stay fully visible (not cropped).
  - **Existing photo icons:** they were stored with transparent bars. Trim the bars and fill the square automatically (may look slightly softer); re-picking gives full sharpness.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update

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

### 6. Image attachments on tasks
- **Shipped:** v1.9.0 (2026-11-17)
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
- **Shipped:** v1.9.0 (2026-11-17)
- **What:** a place to see every completed task, searchable, and filterable by category, date (range), priority and so on.
- **Feasible:** yes; all the data is already stored.
- **Open details:**
  - **Location:** probably a "Completed" entry reachable from Today and from Stats.
  - **Repeating tasks:** each completed occurrence appears as its own row.
  - **Actions:** tapping a row opens View task, so you can un-complete it.
- **Size:** small–medium.
- **Added:** 2026-11-16

### 8. Reminder-note polish (from v1.8.1 QA and user feedback)
- **Shipped:** v1.9.0 (2026-11-17)
- **What:**
  - **No positive message:** never say "Reminders arrive even when the app is closed". Only show a note when reminders will **not** arrive while the app is closed: push off or unhealthy, notifications blocked, or iOS not installed to the Home Screen.
  - **Blocked notifications:** the habit form currently contradicts the "notifications blocked" note; the reach check must also require notification permission.
  - **No duplicate line** in the habit form.
  - **Focus after delete:** after deleting a task from the View task screen, keyboard focus should go to the next item instead of getting lost.
- **Size:** small.
- **Added:** 2026-11-16
