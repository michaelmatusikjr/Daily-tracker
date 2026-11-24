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
- **Decided (2026-11-24):**
  - **Conflicts:** the latest edit wins (per item, by its timestamp).
  - **First sign-in on a device:** ask which profiles to sync to the account; the user can pick one or more, or none.
  - **Device-only profiles:** profiles not synced stay on the device, untouched. While signed in, each one shows a persistent "on this device only" indicator wherever it makes sense (e.g. the profile menu and avatar). The indicator stays until that profile is synced to the account.
  - **Adding a profile while signed in:** the user chooses where it's saved: this device only, or the account.
  - **Signing in on another device that has its own profiles:** offer to migrate those profiles into the account.
  - **Unique names:** every profile name in an account must be unique. If a device profile has the same name as an account profile, the app asks the user to rename the device profile before merging it into the account.
  - **The "On this device only" mark shows before sign-in too** (decided 2026-11-24).
  - **Phased release:**
    - **Phase 1 – shipped in v1.15.0 (2026-11-24):** account and sign-in (password **and passkeys**, with rate limiting), end-to-end encryption plus a recovery key, and sync of profile data (tasks, habits, workouts, journal, settings), including the profile-selection, device-only and migration rules above. Design: `SYNC.md`.
    - **Phase 2 (in progress, with #30 in v1.16.0):** task photos sync (habit image icons already sync inside the habit record since phase 1).
  - **Follow-ups decided during phase 1 QA:** profile order is per device (only names/avatars sync); deleting a whole kept copy only removes it from that device; a kept copy deleted from the account elsewhere stays on the device as device-only.
  - **Defaults chosen for phase 1 (change if wanted):** creating an account needs the server's register key (the reminders one), so strangers can't use the server; signing out asks "keep copies on this device" (default) or "remove"; deleting a synced profile deletes it everywhere (the confirm says so); Settings › Account offers change password, sign out other devices, and delete account.

### 30. Sign in first on a new install; picker options; device-only tag layout
- **What:**
  - On a brand-new install (no profiles yet), offer "Sign in to your account" before a default profile is created; otherwise "Get started on this device" as today.
  - After signing in, each device profile gets a choice: sync to the account, keep on this device only, or delete from this device.
  - Fix the "On this device only" tag in the profile menu, which overflows its row.
- **Added:** 2026-11-24
- **Status:** in progress (ships with sync phase 2 as v1.16.0)

### 31. Clear out completed tasks in bulk by date
- **What:** an easy place to delete completed tasks in bulk by date, for when storage gets low.
- **Defaults (change if wanted):**
  - **Where:** a new **Storage** section in Settings showing how much space is used (data and photos), with **Clear completed tasks**. The Completed tasks screen gets a shortcut to it. When storage is nearly full, the existing "storage full" messages link there.
  - **By date:** "Completed before" with quick picks (older than 1 month, 3 months, 1 year) or a custom date. Before deleting it shows how many tasks and photos, and how much space that frees.
  - **Repeating tasks (decided 2026-11-24):** old completions of running repeating tasks can be cleared too. The task keeps repeating; occurrences before the date no longer exist (not shown, not missed). Stored as `clearedBefore` on the task (schema v7). A finished series is cleared like a one-off.
  - **Safety:** a confirm, then Undo on the result. For a synced profile it also deletes them from the account and other devices (the confirm says so). Habits, workouts and the journal are never touched.
- **Added:** 2026-11-24
- **Status:** planned for v1.16.0

### 32. Bug: Settings jumps (scrolls) when a setting changes
- **What:** changing the accent colour, the week's start day, the theme, etc. makes the Settings screen scroll. It must stay exactly where it was.
- **Likely cause:** every change re-renders the whole screen (`render()` in `js/app.js` replaces the view); the scroll position and the tapped control's focus aren't kept.
- **Type:** bug. **Size:** small.
- **Added:** 2026-11-24
- **Status:** planned for v1.16.0

### 33. Register key syncs with the account
- **What:** the reminders register key (Settings › Reminders › Advanced) travels with the account, end-to-end encrypted like the rest of the data, so a newly signed-in device gets closed-app reminders without typing it again.
- **Rules:** it's an account-level secret (not per profile); never shown in plain text in logs or exports; a key typed on a device updates the account's copy (latest wins); signing out leaves the device's copy as it is.
- **Added:** 2026-11-24
- **Status:** planned for v1.16.0

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

### 9. Move the "Completed" link to the Calendar tab
- **What:** remove "Completed ›" from the progress card on Today, and put the entry point somewhere on the Calendar tab, e.g. a "Completed tasks" button in the Calendar header. The Stats link can stay or go with the Stats tab (see #14).
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Decided (2026-11-17):** a "Completed tasks" button at the top of the Calendar tab.
- **Shipped:** v1.10.0 (2026-11-17)

### 10. Bug: tapping a notification for another profile
- **What:** tapping a notification that belongs to a different profile sometimes doesn't switch to that profile. Once it did switch, but the accent colour stayed the old profile's.
- **Fix:** the switch must always happen, and must apply that profile's theme and accent, both when the app is already open and when it's launched from the notification.
- **Type:** bug.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

### 12. Bug: reminder doesn't fire again after moving a task later
- **What:** if a task's reminder has already gone off and the task's time is changed to later, the new reminder never comes.
- **Fix:** changing the time (or date) re-arms the reminder for the new time, both in the app's own timers and on the push server, which currently remembers "already sent for that day".
- **Type:** bug.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

### 13. Remove the encouragement text on Today's top card
- **What:** remove "More than halfway there" and any similar message that appears on the progress card at the top of Today.
- **Size:** tiny.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

### 15. No zooming or selecting UI
- **What:**
  - Disable pinch/double-tap zoom everywhere except the full-screen photo viewer.
  - Make buttons, labels and lists unselectable. Only editable text (inputs, notes being edited) can be selected.
- **Note:** iPhone Safari ignores the usual "no zoom" setting, so this is done with touch handling instead. It also removes zoom as an accessibility aid; text sizes should stay comfortable.
- **Decided (2026-11-17):** OK to block zoom via touch handling, accepting the accessibility trade-off.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

### 16. Crop and adjust the profile photo
- **What:** when setting a profile photo, show a crop step: drag to position, pinch or slider to zoom, in a round preview, before saving.
- **Optional:** simple brightness/rotate adjustments.
- **Size:** small–medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Decided (2026-11-17):** crop (drag + zoom) and rotate; no brightness.
- **Follow-up (v1.10.1, 2026-11-17):** after the cropper closed, the app could stay slightly zoomed in on iPhone. The cropper now resets the zoom on close, and a safety net snaps the page back whenever it is zoomed outside the photo viewer.
- **Shipped:** v1.10.0 (2026-11-17)

### 19. Photo import edge case (from v1.9.1 QA)
- **What:** if a crafted backup's photo has to be renamed and a later photo then fails to save (storage full), the imported task can keep pointing at the old id. That id belongs to another profile, so deleting the task could delete that profile's photo.
- **Fix:** `importFiles` returns the rename list even when it stops early, and the caller always rewrites task references before reporting the error.
- **Note:** this can't happen with the app's own backups.
- **Type:** bug (low).
- **Size:** tiny.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

### 20. Habit photo icons fill the whole icon
- **What:**
  - Habit image icons that are photos fill the entire rounded square. They scale so the shorter side matches the square, with the overflow cropped (centred), and no letterbox bars.
- **Details:**
  - **New photos:** cropped to a square when picked, using the same crop/zoom/rotate step as the profile photo (#16) so the user can position it.
  - **Genmoji/stickers with transparency:** stay fully visible (not cropped).
  - **Existing photo icons:** they were stored with transparent bars. Trim the bars and fill the square automatically (may look slightly softer); re-picking gives full sharpness.
- **Size:** small.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.10.0 (2026-11-17)

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
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Shipped:** v1.11.0 (2026-11-17)

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
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Decided (2026-11-17):**
  - **Converting existing habits:** Morning → by 12:00 PM, Afternoon → by 5:00 PM, Evening → by 9:00 PM.
  - **"Time running out" warning:**
    - The default is **30 minutes before** the target.
    - The default can be changed or turned off in Settings.
    - Each habit can also change or remove its own warning.
- **Shipped:** v1.11.0 (2026-11-17)

### 18. Habits in the schedule alongside tasks
- **What:** on Today, habits with a target time appear in the timeline with the timed tasks, at their target time. Anytime habits join the Anytime list with untimed tasks, and both can be dragged to reorder together.
- **Depends on:** #17.
- **Size:** medium.
- **Added:** 2026-11-17
- **Scheduled:** Fri Nov 27, 8:00 AM (US Central) update (runs in a fresh session)
- **Decided (2026-11-17):** a habit sits in the timeline at its target time, shown like "Floss · by 8:00 AM".
- **Shipped:** v1.11.0 (2026-11-17)

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
- **Scheduled:** Fri Dec 4, 8:00 AM (US Central) update (runs in a fresh session)
- **Decided (2026-11-17):** keep the 5-emoji mood picker with journal entries.
- **Shipped:** v1.12.0 (2026-11-17)

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
- **Shipped:** v1.12.0 (2026-11-17)

### 20. Settings defaults layout, no habit time reminders, weather fixes
- **What:** Settings › Defaults pickers compact on the right; habit time-of-day Reminder removed (the "complete by" warning stays); US ZIP search (zippopotam.us); current location re-checked on opening the app (at most once a minute) and with a new pull-down-to-refresh on Today; city name looked up at ~100 m; weather line spread across the screen.
- **Added:** 2026-11-17
- **Shipped:** v1.12.1 (2026-11-17)

### 19. Toasts: fewer, a top pill, full-screen celebrations, subtle animations
- **Added:** 2026-11-17
- **Decided (2026-11-17):**
  - **Full-screen takeover** (blurred backdrop, card springs in, tap anywhere except Undo to dismiss): "Everything done for the day" (with confetti), new personal record (🏆), "Saved data couldn’t be read".
  - **Drop these toasts** (the result is already visible and undoable in place): task completed, duplicated, order updated, task added for the day you're viewing (adding to another day keeps "Added to … · View"), habit created, journal saved/updated, workout logged/saved, exercise added/saved, "Switched to X" when picked by the user, category added, "Reminders on" / "Notifications allowed", closed-app reminders on/off success (warnings/failures stay).
  - **Remaining toasts become a top pill** that drops from under the status bar (message left, Undo right; swipe up or tap to dismiss; ~4 s, 6 s with Undo; never covers the + button or tab bar).
  - **Animations:** tab switches slide/fade (150–200 ms), check-off pop + progress ring animation, list items slide in / collapse out, springier sheets, long-press menu scales from the item, streak flame flicker, pull-to-refresh spinner. Reduced Motion → fades only, no confetti.
- **Size:** medium.
- **Shipped:** v1.13.0 (2026-11-18)

### 21. Warning on a daily habit missed two or more days in a row
- **What:** if a daily habit wasn't done for 2+ consecutive days, the next day's habit row shows that (e.g. "Missed 2 days") and changes colour to a warning colour.
- **Size:** small.
- **Added:** 2026-11-23
- **Decided (2026-11-23):** days marked "missed" on purpose count toward the streak of misses; the warning clears once the habit is done. (Non-daily habits: not in scope for now.)
- **Shipped:** v1.14.0 (2026-11-23)

### 22. Tell habits and tasks apart on Today
- **What:** a coloured bar down the left edge of each Today row, one colour for habits and another for tasks, with the word "Habit" or "Task" inside the bar, rotated 90° counter-clockwise.
- **Size:** small.
- **Added:** 2026-11-23
- **Decided (2026-11-23):** colours must work in light and dark mode and not clash with priority/category colours or the #21 warning colour.
- **Shipped:** v1.14.0 (2026-11-23)

### 23. Move Completed tasks to the profile-avatar menu
- **What:** move the "Completed tasks" entry point (currently a button at the top of the Calendar tab, see #9) into the menu that opens when tapping the profile avatar. It's already searchable (#7); keep search and filters.
- **Size:** small.
- **Added:** 2026-11-23
- **Decided (2026-11-23):** remove the "Completed tasks" button from the Calendar tab; the rest of the Calendar tab stays the same.
- **Shipped:** v1.14.0 (2026-11-23)

### 24. Remove the arrow on the profile avatar
- **What:** drop the dropdown arrow next to the profile avatar; tapping the avatar still opens the menu.
- **Size:** tiny.
- **Added:** 2026-11-23
- **Shipped:** v1.14.0 (2026-11-23)

### 25. Completed tasks list: wrap long task names
- **What:** task names in the Completed list wrap onto more lines instead of being cut off.
- **Size:** tiny.
- **Added:** 2026-11-23
- **Shipped:** v1.14.0 (2026-11-23)

### 26. "Future tasks" section at the bottom of Today
- **What:** below the day's schedule, a "Future tasks" list of tasks scheduled for later days, each showing the date it's scheduled for, so they can be done ahead of time.
- **Rules:**
  - **Repeating tasks:** only the next occurrence is listed.
  - **New task-form marker:** "Must be done on this day" (or similar). Tasks with it set are left out of Future tasks.
  - Works like missed tasks carrying into later days, but in reverse: upcoming tasks appear early, at the bottom.
- **Size:** medium.
- **Added:** 2026-11-23
- **Decided (2026-11-23):**
  - **Window:** tasks in the next **2 weeks** are listed. Later ones sit behind a "More future tasks" expander, or a button that opens their own sheet.
  - **Completing early:** the task is marked complete **as of the day it was completed**, so it shows as done that day and no longer appears on its scheduled day.
  - **Stats:** not affected. Only habits are tracked in stats.
  - **Only on today's Today view.** Other days (past or future) show only that day's habits and tasks.
- **Shipped:** v1.14.0 (2026-11-23)

### 27. Notifications: show the whole habit/task name
- **What:** iOS cuts the bold notification title to one line, so long names get cut off ("Mick: 30 minutes left to read Bi…"). Move the name into the body, which wraps over several lines.
  - **Title:** profile + timing, e.g. "Mick · 30 min left".
  - **Body:** name + detail, e.g. "Read Bible – complete by 12:00".
  - Same pattern for task reminders, for both local reminders and closed-app push (`js/notify.js`, `js/push.js`, and the server's copy of the text if it builds any).
- **Size:** small (touches reminders/push, so it gets a QA review).
- **Added:** 2026-11-23
- **Shipped:** v1.14.0 (2026-11-23)

### 28. Opening an item from a notification: Complete/Missed up front
- **What:** iOS doesn't allow buttons on web-app notifications, so tapping the notification is the way in. When a task or habit is opened from a notification, its View sheet shows big **Complete** and **Missed** buttons first.
- **Already done:** if it was already completed (or marked missed) in the app, make that obvious instead, e.g. a clear "Completed at 11:42" banner with an Undo option rather than the buttons.
- **Size:** small.
- **Added:** 2026-11-23
- **Shipped:** v1.14.0 (2026-11-23)

### 29. Fixed, tighter header on every tab
- **What:** a header that stays put while the page scrolls under it (slightly see-through), and is more compact: about 56pt plus the status bar instead of about 90pt.
  - **Every tab, left:** the profile avatar (opens the profile menu, see #23/#24) plus the tab title at a smaller size (about 20pt instead of 28pt).
  - **Drop the grey eyebrow line** above titles (the greeting and counts like "3 active"). On Today, the greeting can move into the top card.
  - **Today:** ◀ ▶ arrows and the "Today" chip on the right; the week strip is pinned underneath.
  - **Calendar:** the month and its ◀ ▶ arrows.
  - **Habits and Workouts:** their sub-tabs (Active/Stats, Workouts/Stats) are pinned under the title.
  - **Completed and Journal:** the search box is pinned under the title, where there is one.
  - Detail sheets (habit detail, Settings) keep their back button in the header.
- **Size:** medium (touches every view; needs a screenshot check on iPhone sizes).
- **Added:** 2026-11-23
- **Decided (2026-11-23):** go with the layout above.
- **Shipped:** v1.14.0 (2026-11-23)
