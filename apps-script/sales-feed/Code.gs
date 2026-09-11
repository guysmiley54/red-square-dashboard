/**
 * Sales Feed Processor - turns the 5-minute Yellowfin "Basic Item Sales Breakdown"
 * emails into a timestamped, item-level sales feed.
 *
 * The Yellowfin report is a FULL-DAY CUMULATIVE snapshot (each item's row is its
 * day-to-date qty and sales), re-sent every 5 minutes. This script:
 *   1. finds unprocessed report emails, oldest first
 *   2. parses each CSV (three store blocks per file)
 *   3. diffs it against the last known state for that day
 *   4. appends only the CHANGES to the SalesFeed tab, stamped with the email's
 *      send time - so you can see what sold in each 5-minute window
 *   5. updates the state, and moves the processed email to Trash
 *
 * Tabs it maintains in BG Ops Data:
 *   SalesFeed:  timestamp | date | venue | category | department | item | qty | sales
 *               (qty/sales are the DELTA for that window; negatives = refunds/voids)
 *   SalesState: date | venue | item_key | qty | sales   (internal - latest cumulative)
 *
 * SETUP:
 *   1. Paste into the BG Ops Data Apps Script project as its own script file.
 *   2. Run processSalesFeed once from the editor to authorise (Gmail + Sheets).
 *   3. Triggers (clock icon) > Add Trigger > processSalesFeed > time-driven >
 *      minutes timer > every 5 minutes.
 *
 * NOTES:
 *   - Emails are moved to TRASH (recoverable for 30 days), not hard-deleted.
 *   - When a report has no data, Yellowfin sends the literal text "No results returned."
 *     rather than an empty file. Every overnight broadcast looks like this. It's treated
 *     as a valid empty snapshot and binned like any other.
 *   - Uses the ADVANCED Gmail service (Services > Gmail API in the editor), not GmailApp.
 *     GmailApp searches by thread and hands back every message in the thread including
 *     trashed ones; with 500+ snapshots grouped into one thread that meant walking the lot
 *     on every run, which exhausted the account-wide Gmail quota by mid-morning and broke
 *     the Invoice Processor. If the Gmail service is not enabled this script will fail
 *     immediately with "Gmail is not defined".
 *   - Anything that genuinely fails to parse has its message ID recorded in Script
 *     Properties and is skipped from then on, so one bad file can't be re-picked every run
 *     and block every later snapshot behind it. Run clearSalesFeedSkipList() to retry them.
 *   - If the script is paused for a while, the backlog is processed in order, so
 *     the 5-minute resolution of the feed is preserved.
 *   - A new day simply starts fresh: first snapshot of the day diffs against
 *     nothing, so its rows land as one opening delta at that timestamp.
 */

var SF = {
  // The sales feed lives in its OWN spreadsheet, not BG Ops Data. At ~3k rows/day this
  // tab grows by roughly 700k cells a month, and a Google Sheet is capped at 10M cells
  // for the WHOLE workbook - sharing with the invoice data would eventually crowd it out
  // and slow every gviz fetch the Supplier Explorer makes. Paste the new sheet's ID here
  // (it's the long string in its URL between /d/ and /edit).
  SPREADSHEET_ID: "1QEUnzY43v3wVc6dP0oGPqgL_mvLRVGHnMYwtO3QMJY4",
  // Gmail search for the Yellowfin broadcast. If you apply a label with a filter, the
  // label: term alone is enough - it's the most reliable match since subjects can change.
  // Keep newer_than so the search stays cheap as the mailbox fills.
  QUERY: 'label:sales-feed has:attachment newer_than:2d',
  // Message IDs that failed to parse, kept in Script Properties. Gmail labels can only be
  // applied to a whole THREAD, and Gmail groups these identical subject lines - roughly
  // four snapshots per thread - so labelling one bad email would park three good ones with
  // it. Tracking individual message IDs skips only what actually failed, while still
  // stopping a bad file from being re-picked on every run and blocking the queue behind it.
  SKIP_PROP: "salesFeedSkipIds",
  MAX_SKIP_IDS: 300,
  FEED_TAB: "SalesFeed",
  STATE_TAB: "SalesState",
  // Yellowfin store names -> the venue names the rest of the system uses.
  VENUE_MAP: {
    "Luma": "Luma Kitchen",
    "Red Square Cafe": "Red Square Cambridge",
    "Red Square Cafe Glenorchy": "Red Square Glenorchy"
  },
  MAX_EMAILS_PER_RUN: 12,  // one hour of backlog per run; catches up quickly after a pause
  // Quiet hours, in the script's timezone. No store is open outside these, so Yellowfin's
  // overnight broadcasts carry no new information - the run returns before touching Gmail
  // at all, which is the point: the expensive part is walking the message thread, not the
  // parsing. Set QUIET_FROM to the hour trading stops and QUIET_TO to the hour it starts.
  // Nothing is lost overnight: the emails stay in the mailbox and are processed oldest
  // first at QUIET_TO, carrying their original timestamps, so late-evening sales still
  // land in the feed at the time they actually happened.
  // Accepts "HH:MM" or a whole hour number. Luma trades dinner Wed-Sun and was still
  // ringing up orders after a 21:00 cutoff, which parked them until the next morning.
  // Set QUIET_FROM and QUIET_TO to the same value to disable this and run around the clock.
  QUIET_FROM: "21:15",
  QUIET_TO: "07:00",
  // Per-day cutoffs, for days that close earlier. Anything not listed uses QUIET_FROM.
  // Keys are Mon/Tue/Wed/Thu/Fri/Sat/Sun (case doesn't matter, full names work too).
  // All venues shut at 4:15pm Monday and Tuesday.
  QUIET_FROM_BY_DAY: {
    Mon: "16:15",
    Tue: "16:15"
  },
  // A quiet-hours backlog is ~120 emails, nearly all "No results returned.". Those cost
  // almost nothing to bin, so they don't consume the MAX_EMAILS_PER_RUN budget - otherwise
  // the first hour of trading would be spent chewing through empty overnight snapshots
  // before reaching real data. These two caps stop that shortcut running away.
  MAX_MESSAGES_EXAMINED: 90,
  MAX_LIST_PAGES: 5,       // 500 messages - comfortably more than a 2-day backlog
  MAX_RUN_SECONDS: 240     // well inside the 6-minute execution limit
};

/**
 * One-off: wipe the feed and state and start collecting cleanly.
 *
 * DESTRUCTIVE - and deliberately awkward to run. It lives at the BOTTOM of this file, not
 * the top, because the Apps Script editor's run dropdown falls back to the FIRST function
 * in the file after a paste, and a one-click accidental wipe is exactly what happened on
 * 4 Aug 2026. See resetSalesFeed() at the end of this file.
 */

function processSalesFeed() {
  // Checked FIRST, before the lock and before any Gmail call, so an overnight run costs
  // nothing but a few milliseconds of trigger runtime.
  if (inQuietHours_()) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // previous run still going - skip, next trigger will catch up
  try { processSalesFeed_(); } finally { lock.releaseLock(); }
}

function processSalesFeed_() {
  if (!SF.SPREADSHEET_ID || SF.SPREADSHEET_ID.indexOf("PASTE_") === 0) {
    throw new Error("Set SF.SPREADSHEET_ID to your BG Sales Data sheet ID before running.");
  }
  var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);
  var feed = ss.getSheetByName(SF.FEED_TAB) || ss.insertSheet(SF.FEED_TAB);
  if (feed.getLastRow() === 0) {
    feed.appendRow(["timestamp", "date", "venue", "category", "department", "item", "qty", "sales"]);
    feed.setFrozenRows(1);
  }
  // Force a datetime format on the timestamp column. Without this Sheets infers a
  // date-only format, which HIDES the time - and CSV export writes what's displayed, so
  // the time silently disappears on the way out and time-of-day analysis is impossible.
  feed.getRange("A2:A").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  var state = ss.getSheetByName(SF.STATE_TAB) || ss.insertSheet(SF.STATE_TAB);
  if (state.getLastRow() === 0) {
    state.appendRow(["date", "venue", "item_key", "qty", "sales"]);
    state.setFrozenRows(1);
    state.hideSheet();
  }
  // Keep the date column as PLAIN TEXT. If Sheets is allowed to coerce "2026-08-03" into
  // a Date, the key we rebuild on the next run won't match and the whole day gets
  // re-written as new deltas. The read path also normalises, but this stops it at source.
  state.getRange("A2:A").setNumberFormat("@");

  // Collect unprocessed report messages, OLDEST first so diffs stay sequential. Anything
  // that has already failed to parse is skipped by ID, so it can't be re-picked forever.
  //
  // This uses the ADVANCED Gmail service, not GmailApp, and that is the whole point.
  // GmailApp.search returns THREADS, and thread.getMessages() hands back every message in
  // the thread INCLUDING ones already trashed. Gmail groups all these identical-subject
  // snapshots into one or two threads, so by evening a single thread holds 500+ messages
  // and every five-minute run walked all of them to find the two that were new. That is
  // what exhausted the account-wide Gmail quota by mid-morning and starved the Invoice
  // Processor. Gmail.Users.Messages.list queries at MESSAGE level, excludes trash by
  // default, and returns only matching ids - about three calls per snapshot instead of
  // hundreds per run.
  var skip = loadSkipIds_();
  // Page through the WHOLE queue, not just the first page. list() returns NEWEST first,
  // so taking the first N would keep the newest and silently drop the oldest - which is
  // exactly backwards for a sequential diff, and cost Luma's Friday dinner service on
  // 8 Aug 2026: a ~120-email overnight backlog meant the oldest ~30 were cut off on every
  // run while the backlog stayed above the cap. Collect them all, then take from the END.
  var ids = [], seen = {}, pageToken = null, pages = 0;
  do {
    var page = Gmail.Users.Messages.list("me", {
      q: SF.QUERY,
      maxResults: 100,
      pageToken: pageToken || undefined
    });
    // De-duplicate. Mail arriving mid-paging shifts the pages, so the same message can
    // come back on two pages; processing it twice then fails on the second trash with
    // "Precondition check failed" because the message is already gone.
    (page.messages || []).forEach(function (m) {
      if (!skip[m.id] && !seen[m.id]) { seen[m.id] = true; ids.push(m.id); }
    });
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < SF.MAX_LIST_PAGES);
  if (!ids.length) return;
  if (pageToken) {
    // More than we paged for. The oldest are beyond our reach this run, but each run
    // trashes what it processes, so the queue shrinks and we catch up. Worth a log line.
    Logger.log("Queue longer than " + (SF.MAX_LIST_PAGES * 100) + " messages - catching up over several runs.");
  }

  // OLDEST first so the running diff stays sequential. internalDate is epoch millis as a
  // string, and is the send time - the same value GmailApp's getDate() gave us, so
  // timestamps in the feed are unchanged.
  var msgs = ids.slice(-SF.MAX_MESSAGES_EXAMINED).map(function (id) {
    var full = Gmail.Users.Messages.get("me", id, { format: "full" });
    return { id: id, when: new Date(Number(full.internalDate)), payload: full.payload };
  });
  msgs.sort(function (a, b) { return a.when - b.when; });

  // Load current state once; mutate in memory; write back once at the end.
  var stVals = state.getLastRow() > 1
    ? state.getRange(2, 1, state.getLastRow() - 1, 5).getValues() : [];
  var st = {}; // "date|venue|itemKey" -> {qty, sales}
  stVals.forEach(function (r) {
    // Sheets coerces the "yyyy-MM-dd" string we wrote into a real Date, so reading it
    // back gives a Date object whose toString() is nothing like the key we built from
    // dayKey. Without normalising here EVERY lookup misses, the diff treats every item
    // as new, and each snapshot re-writes the full day - duplicating the whole feed.
    var d = r[0] instanceof Date
      ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), "yyyy-MM-dd")
      : String(r[0]).trim();
    st[d + "|" + r[1] + "|" + r[2]] = { qty: Number(r[3]) || 0, sales: Number(r[4]) || 0 };
  });

  var newFeedRows = [];
  var processedCount = 0;   // snapshots with actual data - what MAX_EMAILS_PER_RUN caps
  var emptyCount = 0;       // empty snapshots binned - deliberately not capped
  var newSkips = [];
  var started = Date.now();

  msgs.forEach(function (msg) {
    // Two stop conditions. The first bounds the expensive work; the second bounds the
    // cheap work, so a huge backlog of empties can't push the run past the 6-minute limit.
    if (processedCount >= SF.MAX_EMAILS_PER_RUN) return;
    if (Date.now() - started > SF.MAX_RUN_SECONDS * 1000) return;

    var part = findCsvPart_(msg.payload);
    if (!part) { trash_(msg.id); return; } // report email without a CSV - nothing to do

    var when = msg.when;
    // The TRADING day comes from the report, not from the email. Yellowfin puts it in the
    // filename ("... - 08-08-2026.csv"). This matters at midnight: a snapshot sent at
    // 00:04 still carries the PREVIOUS day's cumulative totals, so stamping it with the
    // email's date makes every line look like a brand-new sale on the new day. That is
    // exactly what happened on 8 Aug 2026 - the whole of Friday was re-emitted as
    // Saturday ($17,903), then the next snapshots went $5,713 negative correcting it.
    // Fall back to the email time only if the filename has no date in it.
    var dayKey = reportDayKey_(part && part.filename) ||
                 Utilities.formatDate(when, Session.getScriptTimeZone(), "yyyy-MM-dd");
    var rows;
    try {
      rows = parseYellowfinCsv_(readAttachment_(msg.id, part));
    } catch (e) {
      // Genuinely malformed attachment. Record the message ID so it drops out of the queue
      // and can still be found by hand in Gmail, then skip - a broken snapshot is skipped
      // rather than corrupting the state. Recording it is what stops it blocking the queue.
      Logger.log("Could not parse " + (part.filename || "attachment") + ": " + e);
      newSkips.push(msg.id);
      return;
    }

    // A valid report with no item rows - every overnight broadcast, plus the start of a
    // trading day before anything sells. Nothing to diff, so bin it and move on WITHOUT
    // using the run's budget: these cost one small attachment read, and making them
    // compete with real snapshots would delay live data every morning.
    if (!rows.length) { trash_(msg.id); emptyCount++; return; }

    rows.forEach(function (r) {
      var venue = SF.VENUE_MAP[r.store] || r.store;
      var itemKey = [r.category, r.department, r.item].join(" / ");
      var k = dayKey + "|" + venue + "|" + itemKey;
      var prev = st[k] || { qty: 0, sales: 0 };
      var dq = round2_(r.qty - prev.qty);
      var ds = round2_(r.sales - prev.sales);
      if (dq !== 0 || ds !== 0) {
        newFeedRows.push([when, dayKey, venue, r.category, r.department, r.item, dq, ds]);
        st[k] = { qty: r.qty, sales: r.sales };
      }
    });

    trash_(msg.id);
    processedCount++;
  });

  if (newSkips.length) saveSkipIds_(skip, newSkips);

  if (newFeedRows.length) {
    feed.getRange(feed.getLastRow() + 1, 1, newFeedRows.length, 8).setValues(newFeedRows);
  }

  // Rewrite state: keep only today and yesterday (older days can never change again).
  var keep = [];
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var yest = Utilities.formatDate(new Date(Date.now() - 864e5), Session.getScriptTimeZone(), "yyyy-MM-dd");
  Object.keys(st).forEach(function (k) {
    var parts = k.split("|");
    if (parts[0] === today || parts[0] === yest) {
      keep.push([parts[0], parts[1], parts.slice(2).join("|"), st[k].qty, st[k].sales]);
    }
  });
  if (state.getLastRow() > 1) state.getRange(2, 1, state.getLastRow() - 1, 5).clearContent();
  if (keep.length) state.getRange(2, 1, keep.length, 5).setValues(keep);

  if (processedCount || emptyCount) {
    Logger.log("Processed " + processedCount + " snapshot(s), wrote " + newFeedRows.length +
               " feed row(s)" + (emptyCount ? ", binned " + emptyCount + " empty" : "") + ".");
  }
}

/**
 * Parse one Yellowfin "Basic Item Sales Breakdown" CSV.
 * Layout per store block:
 *   Store Name: <name>,,,,
 *   Category,Department,Item Name,Net Qty,Net Sales Inc GST
 *   <rows...>
 *   ,,,"<total qty>","$<total sales>"      <- totals row: blank cat/dept/item, SKIPPED
 * Money has $ and thousands-commas; item names can contain commas, so this is a real
 * CSV parse, not a split(",").
 */
function parseYellowfinCsv_(text) {
  // Yellowfin doesn't send an empty file when a report has no data - it sends the literal
  // string "No results returned." (21 bytes). Every overnight broadcast before trading
  // starts looks like this. It's a valid snapshot of nothing, so return [] and let the
  // caller bin it. Treating it as a parse failure is what froze the feed on 3 Aug.
  var head = String(text || "").trim();
  if (!head || /^no results returned\.?$/i.test(head)) return [];

  var out = [];
  var store = "";
  var sawStore = false;
  var lines = Utilities.parseCsv(text);
  for (var i = 0; i < lines.length; i++) {
    var c = lines[i];
    var first = String(c[0] || "").trim();
    if (first.indexOf("Store Name:") === 0) {
      store = first.replace("Store Name:", "").trim();
      sawStore = true;
      continue;
    }
    if (first === "Category" || first === "") continue; // header row / totals row / blanks
    if (!store) continue;
    var qty = num_(c[3]), sales = num_(c[4]);
    out.push({
      store: store,
      category: first,
      department: String(c[1] || "").trim(),
      item: String(c[2] || "").trim(),
      qty: qty,
      sales: sales
    });
  }
  // No store blocks at all means this isn't the report, or its layout really has changed
  // - that's a genuine error. Store blocks present but no item rows just means nothing has
  // sold yet, which is a valid empty snapshot. Return [] and let the caller bin it.
  if (!sawStore) throw new Error("no store blocks found - layout may have changed");
  return out;
}

/**
 * Pull the trading day out of the report filename, as yyyy-MM-dd.
 * Yellowfin names them "MIR222 - Basic Item Sales Breakdown - 08-08-2026.csv" (dd-mm-yyyy).
 * Returns "" if there is no date to read, so the caller can fall back.
 */
function reportDayKey_(filename) {
  if (!filename) return "";
  var m = String(filename).match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return "";
  var d = m[1], mo = m[2], y = m[3];
  // Sanity-check rather than trusting the digits blindly - a filename could carry some
  // other number pair and silently misfile a whole day.
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return "";
  return y + "-" + mo + "-" + d;
}

/**
 * Walk a Gmail message payload for the CSV attachment. Reports arrive with an inline PNG
 * signature image alongside the CSV, so match on the filename rather than taking the first
 * attachment. Parts nest, hence the recursion.
 */
function findCsvPart_(payload) {
  if (!payload) return null;
  if (payload.filename && /\.csv$/i.test(payload.filename) &&
      payload.body && payload.body.attachmentId) return payload;
  var parts = payload.parts || [];
  for (var i = 0; i < parts.length; i++) {
    var hit = findCsvPart_(parts[i]);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fetch and decode an attachment.
 *
 * The advanced Gmail service is inconsistent about what "data" actually is: sometimes a
 * base64URL string (- and _ in place of + and /), sometimes standard base64, sometimes
 * unpadded, and sometimes already a Blob. Small attachments can also come inline on the
 * part itself with no separate fetch needed. Assuming one shape gives you
 * "Could not decode string", so try each in turn and take the first that works.
 */
function readAttachment_(msgId, part) {
  var data = null;
  if (part.body && part.body.attachmentId) {
    var att = Gmail.Users.Messages.Attachments.get("me", msgId, part.body.attachmentId);
    data = att && att.data;
  }
  // Small attachments arrive inline, with no attachmentId to fetch.
  if (!data && part.body && part.body.data) data = part.body.data;
  if (!data) throw new Error("attachment had no data");

  // THE COMMON CASE with the advanced Gmail service: `data` is already a decoded BYTE
  // ARRAY, not a base64 string. Confirmed by inspectAttachment on 8 Aug 2026 - constructor
  // Array, first values 83,116,111,114,101 = "Store". Nothing to decode; wrap and read.
  // Missing this is what produced "Could not decode string": String(array) gives
  // "83,116,111,..." and no base64 decoder will touch that.
  if (Object.prototype.toString.call(data) === "[object Array]" ||
      (typeof data === "object" && typeof data.length === "number" && typeof data[0] === "number")) {
    // An empty array means the fetch came back with nothing, which is a failure - not the
    // same as a report with no rows. Say so rather than quietly binning the email.
    if (!data.length) throw new Error("attachment fetch returned an empty byte array");
    return Utilities.newBlob(data).getDataAsString();
  }
  // Already decoded to a Blob by the client library - nothing to do.
  if (typeof data.getDataAsString === "function") return data.getDataAsString();
  if (typeof data.getBytes === "function") return Utilities.newBlob(data.getBytes()).getDataAsString();

  // Strip whitespace first: base64Decode rejects any, and wrapped or newline-padded
  // payloads are common. Then build the two alphabets, both correctly padded.
  var s = String(data).replace(/\s+/g, "");
  var webSafe = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  var standard = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (standard.length % 4) standard += "=";
  var attempts = [
    function () { return Utilities.newBlob(Utilities.base64DecodeWebSafe(webSafe)).getDataAsString(); },
    function () { return Utilities.newBlob(Utilities.base64Decode(standard)).getDataAsString(); },
    function () { return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString(); },
    function () { return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString(); },
    function () { return String(data); }   // last resort: it was never encoded
  ];
  var lastErr = "";
  for (var i = 0; i < attempts.length; i++) {
    try {
      var out = attempts[i]();
      // A real report always names its stores; anything else means we decoded to noise.
      if (out && (out.indexOf("Store Name:") > -1 || /^\s*No results returned/i.test(out))) return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error("could not decode attachment (" + s.length + " chars) " + lastErr);
}

/**
 * Move a message to trash - recoverable for 30 days, same as before.
 *
 * NEVER throws. The sheet write happens AFTER the message loop, so an exception here
 * would discard every row the run had already parsed - losing real sales data because of
 * a failed cleanup. A message that cannot be trashed is at worst re-read next run, and
 * the diff makes that a no-op.
 *
 * "Precondition check failed" means the message is already gone, which is success.
 */
function trash_(msgId) {
  try {
    Gmail.Users.Messages.trash("me", msgId);
    return true;
  } catch (e) {
    var msg = String(e);
    if (msg.indexOf("Precondition check failed") > -1 || msg.indexOf("notFound") > -1) return true;
    Logger.log("Could not trash " + msgId + " (continuing): " + msg);
    return false;
  }
}

/**
 * Today's cutoff. Note the window is anchored on the day it STARTS: the small hours of
 * Tuesday belong to Monday's window, and are still covered because QUIET_TO is the same
 * every day - the "before 07:00" half of the test does the work. If you ever make
 * QUIET_TO vary by day, this needs revisiting.
 */
function quietFromToday_(now, tz) {
  var map = SF.QUIET_FROM_BY_DAY || {};
  var day = Utilities.formatDate(now, tz, "EEE");           // Mon, Tue, ...
  var full = Utilities.formatDate(now, tz, "EEEE");         // Monday, Tuesday, ...
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i].toLowerCase();
    if (k === day.toLowerCase() || k === full.toLowerCase()) return map[keys[i]];
  }
  return SF.QUIET_FROM;
}

/** Minutes since midnight for "HH:MM", or for a plain hour number. */
function minsOfDay_(v) {
  if (typeof v === "number") return v * 60;
  var m = String(v).match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2] || 0);
}

/**
 * Is now inside the quiet window? Handles a window that crosses midnight (21:15 to 07:00
 * is "after 21:15 OR before 07:00", not a simple between). Works to the minute, because
 * Luma's dinner service runs past a whole-hour cutoff. Uses the script's timezone, so set
 * that correctly in Project Settings - it is NOT necessarily the venues' timezone.
 */
function inQuietHours_() {
  var now = new Date(), tz = Session.getScriptTimeZone();
  var a = minsOfDay_(quietFromToday_(now, tz)), b = minsOfDay_(SF.QUIET_TO);
  // A malformed setting must not silently stop the feed for a day - run instead.
  if (isNaN(a) || isNaN(b)) {
    Logger.log("QUIET_FROM/QUIET_TO not understood - running anyway. Use \"HH:MM\".");
    return false;
  }
  if (a === b) return false; // disabled - run around the clock
  var n = Number(Utilities.formatDate(now, tz, "H")) * 60 +
          Number(Utilities.formatDate(now, tz, "m"));
  return (a < b) ? (n >= a && n < b) : (n >= a || n < b);
}

/** Load the set of message IDs that have already failed to parse. */
function loadSkipIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SF.SKIP_PROP);
  var set = {};
  if (raw) {
    try { JSON.parse(raw).forEach(function (id) { set[id] = true; }); }
    catch (e) { Logger.log("Skip list unreadable, starting fresh: " + e); }
  }
  return set;
}

/** Add newly failed IDs, keeping only the most recent MAX_SKIP_IDS so it can't grow forever. */
function saveSkipIds_(existing, added) {
  var ids = Object.keys(existing).concat(added);
  if (ids.length > SF.MAX_SKIP_IDS) ids = ids.slice(ids.length - SF.MAX_SKIP_IDS);
  PropertiesService.getScriptProperties().setProperty(SF.SKIP_PROP, JSON.stringify(ids));
}

/** Clear the skip list - use if you've fixed a parser bug and want the parked emails retried. */
function clearSalesFeedSkipList() {
  PropertiesService.getScriptProperties().deleteProperty(SF.SKIP_PROP);
  Logger.log("Skip list cleared. Previously failed emails will be retried on the next run.");
}

function num_(v) {
  return Number(String(v == null ? "" : v).replace(/[$,\s]/g, "")) || 0;
}
function round2_(n) { return Math.round(n * 100) / 100; }

/* ------------------------------------------------------------------------------------
 * DESTRUCTIVE OPERATIONS - kept at the bottom, behind a two-step confirmation.
 * ---------------------------------------------------------------------------------- */

/**
 * One-off: wipe the feed and state and start collecting cleanly.
 *
 * Only needed after a bug that corrupted the collected data - e.g. the original state-key
 * coercion bug, where every lookup missed and each snapshot re-wrote the whole day. Feed
 * collected during a bug like that can't be reliably de-duplicated after the fact, since
 * the same item legitimately sells many times a day and identical rows aren't proof of a
 * duplicate. Clearing and re-collecting is the honest fix.
 *
 * IT WILL NOT RUN ON ITS OWN. You must first add a script property:
 *   Project Settings > Script Properties > CONFIRM_RESET = RESET
 * Run it, and it consumes that property immediately - so a second accidental run does
 * nothing. This exists because running it by accident from the editor's function dropdown
 * wiped the feed on 4 Aug 2026.
 *
 * If you do wipe the sheet by mistake: File > Version history > See version history, and
 * restore a version from before the run. Do it before the trigger writes anything else.
 */
function resetSalesFeed() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("CONFIRM_RESET") !== "RESET") {
    Logger.log("resetSalesFeed did NOTHING - it is guarded.\n" +
               "This wipes every row in " + SF.FEED_TAB + ". If that is really what you want:\n" +
               "  Project Settings > Script Properties > add CONFIRM_RESET = RESET, then run again.\n" +
               "The property is consumed on use, so it can't fire twice.");
    return;
  }
  props.deleteProperty("CONFIRM_RESET"); // consume it FIRST, before anything is destroyed

  var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);
  var feed = ss.getSheetByName(SF.FEED_TAB);
  var state = ss.getSheetByName(SF.STATE_TAB);
  var wiped = feed && feed.getLastRow() > 1 ? feed.getLastRow() - 1 : 0;
  if (feed && feed.getLastRow() > 1) feed.getRange(2, 1, feed.getLastRow() - 1, feed.getLastColumn()).clearContent();
  if (state && state.getLastRow() > 1) state.getRange(2, 1, state.getLastRow() - 1, 5).clearContent();
  Logger.log("Sales feed and state cleared - " + wiped + " row(s) removed. " +
             "The next run rebuilds from the current snapshot. " +
             "To undo: File > Version history in the sheet.");
}

/**
 * Remove one trading day from BOTH the feed and the state.
 *
 * Needed when a day gets written wrongly - e.g. 8 Aug 2026, when a post-midnight snapshot
 * carrying the previous day's totals was stamped with the new date and re-emitted all of
 * Friday as Saturday. Deleting the feed rows alone is NOT enough: the state is what the
 * diff reads, so a stale day in SalesState keeps producing negative corrections until the
 * new day's takings exceed the old ones.
 *
 * Also handy because SalesState is hidden, and hand-editing a hidden tab while a trigger
 * might fire is how the feed got wiped once already.
 *
 * IT WILL NOT RUN ON ITS OWN. Set the day first:
 *   Project Settings > Script Properties > CLEAR_DAY = 2026-08-08
 * Then run it. The property is consumed immediately, so a second accidental run is a no-op.
 * After it finishes, the next trigger run rebuilds that day from the current snapshot as a
 * single opening delta - correct totals, but no time-of-day detail for the part already gone.
 */
function clearSalesFeedDay() {
  var props = PropertiesService.getScriptProperties();
  var day = String(props.getProperty("CLEAR_DAY") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    Logger.log("clearSalesFeedDay did NOTHING - it is guarded.\n" +
               "To remove a day from the feed AND the state:\n" +
               "  Project Settings > Script Properties > add CLEAR_DAY = yyyy-MM-dd\n" +
               "  (e.g. 2026-08-08), then run this again.\n" +
               "The property is consumed on use, so it can't fire twice.");
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("Could not get the lock - a run is in progress. Try again in a minute.");
    return;
  }
  try {
    props.deleteProperty("CLEAR_DAY"); // consume FIRST, before anything is destroyed
    var tz = Session.getScriptTimeZone();
    // The date column may hold a real Date or text depending on how the row was written,
    // so normalise both sides before comparing.
    function key(v) {
      if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
      return String(v == null ? "" : v).trim().slice(0, 10);
    }
    var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);

    function purge(tabName, dateCol) {
      var sh = ss.getSheetByName(tabName);
      if (!sh || sh.getLastRow() < 2) return 0;
      var cols = sh.getLastColumn();
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
      var keep = vals.filter(function (r) { return key(r[dateCol]) !== day; });
      var removed = vals.length - keep.length;
      if (!removed) return 0;
      sh.getRange(2, 1, vals.length, cols).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, cols).setValues(keep);
      return removed;
    }

    var f = purge(SF.FEED_TAB, 1);   // SalesFeed: timestamp, date, ...
    var s = purge(SF.STATE_TAB, 0);  // SalesState: date, venue, item_key, ...
    Logger.log("Cleared " + day + " - removed " + f + " feed row(s) and " + s +
               " state row(s). The next run rebuilds this day from the current snapshot. " +
               "To undo: File > Version history in the sheet.");
  } finally {
    lock.releaseLock();
  }
}


/* ======================================================================================
 * DIAGNOSTICS - read-only. None of these write to the sheet or touch any email.
 * Run them from the editor when something looks wrong, then read the Execution log.
 *   salesFeedHealthCheck() - triggers, code version, skip list, queue, sheet, lock
 *   inspectAttachment()    - what the Gmail API is actually handing back for a CSV
 * ==================================================================================== */

/**
 * Read-only health check. Changes nothing - no trashing, no writes, no sheet edits.
 * Run it from the editor and send the Execution log.
 *
 * Answers, in order: is there a trigger, is the skip list blocking anything, does the
 * query find the mail, can the script reach the sheet, and how far along is the feed.
 */
function salesFeedHealthCheck() {
  // 1. Triggers. If this list is empty, nothing is running on a schedule - that alone
  //    explains a stalled feed, and pasting new code never restores a deleted trigger.
  // Gmail service availability first - everything else is moot without it.
  Logger.log("GMAIL SERVICE: " + (typeof Gmail === "undefined"
    ? ">> NOT ENABLED. editor > Services > + > Gmail API > Add." : "enabled (advanced)"));

  var trigs = ScriptApp.getProjectTriggers();
  Logger.log("TRIGGERS: " + trigs.length);
  trigs.forEach(function (t) {
    Logger.log("   handler: " + t.getHandlerFunction() +
               " | source: " + t.getEventType() +
               " | id: " + t.getUniqueId());
  });
  if (!trigs.length) Logger.log("   >> NO TRIGGERS. Add one: processSalesFeed, time-driven, every 5 minutes.");
  var hasProcessor = trigs.some(function (t) { return t.getHandlerFunction() === "processSalesFeed"; });
  if (trigs.length && !hasProcessor) Logger.log("   >> No trigger points at processSalesFeed.");

  // 2. Which version of the code is actually saved. If SKIP_PROP is undefined the editor
  //    still holds the OLD script - the paste didn't save, or went into a different file.
  Logger.log("CODE VERSION: SKIP_PROP is " + (SF.SKIP_PROP ? "present (new code)" : "MISSING (old code still saved)"));
  Logger.log("   QUERY: " + SF.QUERY);
  if (SF.QUERY.indexOf("sales-feed-error") > -1) {
    Logger.log("   >> Query still excludes sales-feed-error. That is the old code.");
  }

  // 3. Skip list. Anything in here is being deliberately passed over.
  var raw = PropertiesService.getScriptProperties().getProperty(SF.SKIP_PROP);
  var skipIds = [];
  if (raw) { try { skipIds = JSON.parse(raw); } catch (e) { Logger.log("SKIP LIST unreadable: " + e); } }
  Logger.log("SKIP LIST: " + skipIds.length + " message id(s)");
  if (skipIds.length) Logger.log("   >> Run clearSalesFeedSkipList() to retry these.");

  // 4. What the query actually returns.
  var skip = {};
  skipIds.forEach(function (id) { skip[id] = true; });
  // Message-level, same as the processor. If this throws "Gmail is not defined", the
  // advanced Gmail service has not been enabled: editor > Services > + > Gmail API.
  var ids = [], usable = [], skipped = 0;
  try {
    var page = Gmail.Users.Messages.list("me", { q: SF.QUERY, maxResults: 100 });
    (page.messages || []).forEach(function (m) {
      if (skip[m.id]) { skipped++; return; }
      ids.push(m.id);
    });
  } catch (e) {
    Logger.log("QUERY FAILED: " + e);
    Logger.log("   >> If this says 'Gmail is not defined', enable the advanced Gmail service:");
    Logger.log("      editor left sidebar > Services > + > Gmail API > Add.");
    return;
  }
  Logger.log("QUERY: " + ids.length + " unprocessed message(s), " + skipped + " on the skip list");
  if (!ids.length) Logger.log("   >> Nothing waiting. Normal if the feed is up to date.");
  if (ids.length) {
    // Only peek at the oldest few - this is a health check, not a second processor.
    ids.slice(-3).forEach(function (id) {
      var m = Gmail.Users.Messages.get("me", id, { format: "full" });
      var part = findCsvPart_(m.payload);
      Logger.log("   " + new Date(Number(m.internalDate)) + " | " +
                 (part ? part.filename + " (" + (part.body.size || "?") + " bytes)" : "NO CSV ATTACHED"));
      usable.push(m);
    });
  }

  // 5. Can it reach the sheet, and where has the feed got to.
  try {
    var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);
    var feed = ss.getSheetByName(SF.FEED_TAB);
    var state = ss.getSheetByName(SF.STATE_TAB);
    Logger.log("SHEET: " + ss.getName());
    Logger.log("   " + SF.FEED_TAB + " rows: " + (feed ? feed.getLastRow() - 1 : "TAB MISSING"));
    Logger.log("   " + SF.STATE_TAB + " rows: " + (state ? state.getLastRow() - 1 : "TAB MISSING"));
    if (feed && feed.getLastRow() > 1) {
      var last = feed.getRange(feed.getLastRow(), 1, 1, 3).getDisplayValues()[0];
      Logger.log("   last feed row: " + last.join(" | "));
    }
  } catch (e) {
    Logger.log("SHEET: CANNOT OPEN - " + e);
  }

  // 6. Is another execution holding the lock.
  var lock = LockService.getScriptLock();
  if (lock.tryLock(0)) { lock.releaseLock(); Logger.log("LOCK: free"); }
  else Logger.log("LOCK: HELD - another execution is still running, every trigger run is skipping.");
}

/**
 * Read-only diagnostic for the "could not decode attachment" problem.
 *
 * Rather than guessing what the advanced Gmail service hands back in `data`, this reports
 * exactly what it is: the type, the length, which characters it contains, and what each
 * decode strategy actually produces. Changes nothing - no trashing, no writes.
 *
 * Run it and send the Execution log.
 */
function inspectAttachment() {
  if (typeof Gmail === "undefined") {
    Logger.log(">> Advanced Gmail service not enabled: editor > Services > + > Gmail API > Add.");
    return;
  }
  var page = Gmail.Users.Messages.list("me", { q: SF.QUERY, maxResults: 5 });
  var msgs = page.messages || [];
  if (!msgs.length) { Logger.log("No messages match: " + SF.QUERY); return; }

  var full = Gmail.Users.Messages.get("me", msgs[msgs.length - 1].id, { format: "full" });
  Logger.log("message date: " + new Date(Number(full.internalDate)));

  var part = findCsvPart_(full.payload);
  if (!part) { Logger.log("No CSV part found in this message."); return; }
  Logger.log("filename: " + part.filename);
  Logger.log("mimeType: " + part.mimeType);
  Logger.log("body keys: " + Object.keys(part.body || {}).join(", "));
  Logger.log("body.size: " + (part.body && part.body.size));

  var data = null;
  if (part.body && part.body.attachmentId) {
    var att = Gmail.Users.Messages.Attachments.get("me", full.id, part.body.attachmentId);
    Logger.log("Attachments.get returned keys: " + Object.keys(att || {}).join(", "));
    Logger.log("att.size: " + (att && att.size));
    data = att && att.data;
  } else {
    Logger.log("no attachmentId - data is inline on the part");
    data = part.body && part.body.data;
  }

  // ---- what IS this thing?
  Logger.log("--- data ---");
  Logger.log("typeof: " + (typeof data));
  Logger.log("is null/undefined: " + (data == null));
  if (data == null) return;
  Logger.log("has getDataAsString: " + (typeof data.getDataAsString === "function"));
  Logger.log("has getBytes: " + (typeof data.getBytes === "function"));
  Logger.log("constructor: " + (data.constructor && data.constructor.name));

  var s = String(data);
  Logger.log("String() length: " + s.length);
  Logger.log("first 80 chars: " + JSON.stringify(s.slice(0, 80)));
  Logger.log("last 40 chars:  " + JSON.stringify(s.slice(-40)));
  // Character classes are the tell: +/ means standard base64, -_ means base64url,
  // whitespace breaks base64Decode, anything else means it is not base64 at all.
  Logger.log("contains + or / : " + /[+/]/.test(s));
  Logger.log("contains - or _ : " + /[-_]/.test(s));
  Logger.log("contains whitespace: " + /\s/.test(s));
  Logger.log("length % 4: " + (s.length % 4));
  var odd = s.replace(/[A-Za-z0-9+/=\-_\s]/g, "");
  Logger.log("characters outside every base64 alphabet: " +
             (odd ? JSON.stringify(odd.slice(0, 40)) + " (" + odd.length + " of them)" : "none"));

  // ---- what does each strategy produce?
  var clean = s.replace(/\s+/g, "");
  var webSafe = clean.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  var standard = clean.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (standard.length % 4) standard += "=";
  var tries = [
    ["base64DecodeWebSafe(normalised)", function () { return Utilities.base64DecodeWebSafe(webSafe); }],
    ["base64Decode(normalised)",        function () { return Utilities.base64Decode(standard); }],
    ["base64DecodeWebSafe(as-is)",      function () { return Utilities.base64DecodeWebSafe(clean); }],
    ["base64Decode(as-is)",             function () { return Utilities.base64Decode(clean); }]
  ];
  Logger.log("--- decode attempts ---");
  tries.forEach(function (t) {
    try {
      var out = Utilities.newBlob(t[1]()).getDataAsString();
      Logger.log(t[0] + " -> OK, " + out.length + " chars, starts: " + JSON.stringify(out.slice(0, 60)));
    } catch (e) {
      Logger.log(t[0] + " -> FAILED: " + e);
    }
  });
}

/**
 * Restore ONE snapshot from the trash so it gets reprocessed.
 *
 * Gmail groups every snapshot into a single thread (identical subject), so the "Move to
 * inbox" button in Trash restores the WHOLE thread - days of old snapshots, which the diff
 * would then replay and scatter negative rows through the feed. The API can untrash a
 * single message, which is what this does.
 *
 * The one worth restoring is the LAST snapshot of a trading day: it is cumulative, so it
 * carries that day's complete totals and one diff recovers everything the feed missed.
 *
 * IT WILL NOT RUN ON ITS OWN. Set the day first:
 *   Project Settings > Script Properties > RECOVER_DAY = 2026-08-07
 * Then run it, then run processSalesFeed. The property is consumed on use.
 *
 * Do this on the SAME day or the day after the one you are recovering. State only keeps
 * today and yesterday, so once the day is pruned the diff has nothing to compare against
 * and the whole day would be written again as new rows.
 */
function recoverSnapshot() {
  var props = PropertiesService.getScriptProperties();
  var day = String(props.getProperty("RECOVER_DAY") || "").trim();
  var m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    Logger.log("recoverSnapshot did NOTHING - it is guarded.\n" +
               "  Project Settings > Script Properties > add RECOVER_DAY = yyyy-MM-dd\n" +
               "  (e.g. 2026-08-07), then run this again, then run processSalesFeed.");
    return;
  }
  if (typeof Gmail === "undefined") {
    Logger.log(">> Advanced Gmail service not enabled: Services > + > Gmail API > Add.");
    return;
  }
  props.deleteProperty("RECOVER_DAY"); // consume first

  // Yellowfin names the file after the report's DATA date, dd-mm-yyyy - confirmed 8 Aug 2026.
  var stamp = m[3] + "-" + m[2] + "-" + m[1] + ".csv";
  var q = 'label:sales-feed in:trash filename:"' + stamp + '"';
  var res = Gmail.Users.Messages.list("me", { q: q, maxResults: 10 });
  var found = res.messages || [];
  if (!found.length) {
    Logger.log("Nothing in the trash matching: " + q + "\n" +
               "Trash keeps mail for 30 days, so if this is empty the filename may differ.");
    return;
  }

  // list() is newest first, and the newest snapshot of a day holds that day's full totals.
  var full = Gmail.Users.Messages.get("me", found[0].id, { format: "full" });
  var part = findCsvPart_(full.payload);
  Gmail.Users.Messages.untrash("me", found[0].id);
  Logger.log("Restored 1 of " + found.length + " matching message(s):\n" +
             "  sent: " + new Date(Number(full.internalDate)) + "\n" +
             "  file: " + (part ? part.filename : "?") + "\n" +
             "Now run processSalesFeed. It will diff this against " + day +
             " and write only what was missing.");
}

/** How many state rows exist for a day - used to refuse an unsafe replay. */
function countStateRowsForDay_(day) {
  var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);
  var sh = ss.getSheetByName(SF.STATE_TAB);
  if (!sh || sh.getLastRow() < 2) return 0;
  var tz = Session.getScriptTimeZone();
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var n = 0;
  vals.forEach(function (r) {
    var v = r[0];
    var k = (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd")
                                : String(v == null ? "" : v).trim().slice(0, 10);
    if (k === day) n++;
  });
  return n;
}

/**
 * Restore EVERY snapshot for one trading day from the trash, so the day can be rebuilt
 * with full time-of-day detail.
 *
 * recoverSnapshot() restores the last snapshot only, which recovers the day's TOTALS in a
 * single diff but lands them all at one timestamp. Replaying every snapshot in order
 * rebuilds the 5-minute shape as well - useful after a day has been cleared and rewritten
 * as one opening delta.
 *
 * ORDER MATTERS. Run these in sequence:
 *   1. CLEAR_DAY = yyyy-MM-dd, run clearSalesFeedDay   (wipe the day from feed and state)
 *   2. RECOVER_DAY_FULL = yyyy-MM-dd, run this
 *   3. run processSalesFeed repeatedly, or let the trigger catch up
 * Skipping step 1 replays snapshots against existing state and produces negative rows.
 *
 * IT WILL NOT RUN ON ITS OWN - set RECOVER_DAY_FULL in Script Properties first.
 * The property is consumed on use.
 */
function recoverDayFull() {
  var props = PropertiesService.getScriptProperties();
  var day = String(props.getProperty("RECOVER_DAY_FULL") || "").trim();
  var m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    Logger.log("recoverDayFull did NOTHING - it is guarded.\n" +
               "  1. CLEAR_DAY = yyyy-MM-dd, run clearSalesFeedDay first\n" +
               "  2. add RECOVER_DAY_FULL = yyyy-MM-dd, run this\n" +
               "  3. run processSalesFeed until the queue is clear\n" +
               "Skipping step 1 will produce negative rows.");
    return;
  }
  if (typeof Gmail === "undefined") {
    Logger.log(">> Advanced Gmail service not enabled: Services > + > Gmail API > Add.");
    return;
  }
  // Refuse if the day still has state. Replaying snapshots against existing state makes
  // every early snapshot look like a huge drop, and the day fills with negative rows -
  // which is exactly what step 1 exists to prevent, and exactly what gets skipped.
  var existing = countStateRowsForDay_(day);
  if (existing > 0) {
    Logger.log("recoverDayFull STOPPED - " + day + " still has " + existing + " state row(s).\n" +
               "Replaying on top of that produces negative rows. Do this first:\n" +
               "  Script Properties > CLEAR_DAY = " + day + ", then run clearSalesFeedDay\n" +
               "Then set RECOVER_DAY_FULL again and re-run this.");
    return;   // property NOT consumed - so you can just clear and re-run
  }
  props.deleteProperty("RECOVER_DAY_FULL");

  var stamp = m[3] + "-" + m[2] + "-" + m[1] + ".csv";
  var q = 'label:sales-feed in:trash filename:"' + stamp + '"';
  var ids = [], pageToken = null, pages = 0;
  do {
    var page = Gmail.Users.Messages.list("me", { q: q, maxResults: 100, pageToken: pageToken || undefined });
    (page.messages || []).forEach(function (x) { ids.push(x.id); });
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < SF.MAX_LIST_PAGES);

  if (!ids.length) {
    Logger.log("Nothing in the trash matching: " + q +
               "\nTrash keeps mail for 30 days; if this is empty the filename may differ.");
    return;
  }
  // Gmail's own newer_than window still applies once they are back, so anything older than
  // SF.QUERY allows will simply be ignored by the processor rather than half-processed.
  var done = 0;
  ids.forEach(function (id) {
    try { Gmail.Users.Messages.untrash("me", id); done++; }
    catch (e) { Logger.log("Could not restore " + id + ": " + e); }
  });
  Logger.log("Restored " + done + " of " + ids.length + " snapshot(s) for " + day + ".\n" +
             "Now run processSalesFeed until the log stops reporting new rows - it processes " +
             SF.MAX_EMAILS_PER_RUN + " snapshots with data per run, so expect several runs.");
}

/* ======================================================================================
 * STAFF REPORTS - weekly ingestion
 *
 * Four ImPOS reports broadcast to the "staff-reports" label at 9pm Sunday, covering the
 * previous 7 days. Nothing like the sales feed: these are COMPLETE period reports, not
 * cumulative snapshots, so there is no diffing, no state and no midnight rollover. Parse,
 * write, done.
 *
 * Each report replaces any existing rows whose trading date falls inside the range the
 * file covers, so re-running a week is harmless and overlapping broadcasts can't
 * duplicate. Messages are NOT trashed - a weekly report is the only copy of that week, so
 * processed message IDs are remembered instead.
 * ==================================================================================== */

var SR = {
  QUERY: 'label:staff-reports has:attachment newer_than:30d',
  DONE_PROP: "staffReportsDone",
  MAX_DONE_IDS: 200,
  MAX_MESSAGES: 40
};

/** Entry point. Put this on a weekly trigger - Monday morning is fine. */
function processStaffReports() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try { processStaffReports_(); } finally { lock.releaseLock(); }
}

function processStaffReports_() {
  if (typeof Gmail === "undefined") {
    Logger.log(">> Advanced Gmail service not enabled: Services > + > Gmail API > Add.");
    return;
  }
  var done = loadDoneIds_();
  var page = Gmail.Users.Messages.list("me", { q: SR.QUERY, maxResults: 100 });
  var ids = (page.messages || []).map(function (m) { return m.id; })
              .filter(function (id) { return !done[id]; });
  if (!ids.length) { Logger.log("No new staff reports."); return; }
  ids = ids.slice(-SR.MAX_MESSAGES);   // list() is newest first, so take the oldest

  var ss = SpreadsheetApp.openById(SF.SPREADSHEET_ID);
  var handled = [], summary = [];
  ids.forEach(function (id) {
    var full = Gmail.Users.Messages.get("me", id, { format: "full" });
    var parts = collectCsvParts_(full.payload);
    if (!parts.length) { handled.push(id); return; }   // nothing to do, don't look again
    parts.forEach(function (part) {
      var spec = reportFor_(part.filename);
      if (!spec) { Logger.log("Unrecognised report, skipped: " + part.filename); return; }
      var text;
      try { text = readAttachment_(id, part); }
      catch (e) { Logger.log("Could not read " + part.filename + ": " + e); return; }
      var out;
      try { out = spec.parse(Utilities.parseCsv(text)); }
      catch (e) { Logger.log("Could not parse " + part.filename + ": " + e); return; }
      if (!out.rows.length) { Logger.log(part.filename + ": no data rows"); return; }
      var n = writeReport_(ss, spec.tab, out.header, out.rows);
      summary.push(spec.key + " -> " + spec.tab + ": " + n.written + " row(s), " +
                   n.replaced + " replaced, " + out.from + " to " + out.to);
    });
    handled.push(id);
  });
  if (handled.length) saveDoneIds_(done, handled);
  Logger.log(summary.length ? summary.join("\n") : "Nothing written.");
}

/* ---- which report is this? ------------------------------------------------------- */
function reportFor_(filename) {
  var f = String(filename || "");
  for (var i = 0; i < STAFF_REPORTS.length; i++) {
    if (STAFF_REPORTS[i].match.test(f)) return STAFF_REPORTS[i];
  }
  return null;
}

/** Every CSV attachment on a message - a broadcast could carry more than one. */
function collectCsvParts_(payload, acc) {
  acc = acc || [];
  if (!payload) return acc;
  if (payload.filename && /\.csv$/i.test(payload.filename) &&
      payload.body && (payload.body.attachmentId || payload.body.data)) acc.push(payload);
  (payload.parts || []).forEach(function (p) { collectCsvParts_(p, acc); });
  return acc;
}

/* ---- shared parsing helpers ------------------------------------------------------ */
/** dd/mm/yyyy (with optional trailing time) -> yyyy-MM-dd. Returns "" if unrecognised. */
function srDate_(v) {
  var m = String(v || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
}
/** "05/08/2026 5:47 pm" -> "17:47". Void times are 12-hour; every other report is 24-hour. */
function srTime_(v) {
  var s = String(v || "").trim();
  var m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return "";
  var h = Number(m[1]), ap = (m[4] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return ("0" + h).slice(-2) + ":" + m[2];
}
function srNum_(v) {
  var n = Number(String(v == null ? "" : v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}
/** Header index by name, tolerant of trailing spaces and case. */
function srCol_(head, name) {
  for (var i = 0; i < head.length; i++) {
    if (String(head[i]).trim().toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}
/** Carry a value down when the cell is blank - these reports blank repeated values for
 *  readability, so an empty Store Name means "same as the row above", not "unknown". */
function srFill_(cur, v) { var s = String(v == null ? "" : v).trim(); return s || cur; }

/* ---- the four reports ------------------------------------------------------------ */
var STAFF_REPORTS = [
{
  key: "MIR039", match: /MIR0?39/i, tab: "StaffItemDiscounts",
  // Flat listing, no repeated-value blanking. One row per item-level discount.
  parse: function (g) {
    var head = g.shift() || [];
    var c = {store: srCol_(head,"Store Name"), emp: srCol_(head,"Employee Item Discount"),
             stn: srCol_(head,"Station Item Discount"), date: srCol_(head,"Trading Date"),
             item: srCol_(head,"Item No"), name: srCol_(head,"Item Disc Name"),
             rate: srCol_(head,"Item Discount Rate/Amount"), amt: srCol_(head,"Discount Amount")};
    var rows = [];
    g.forEach(function (r) {
      var d = srDate_(r[c.date]);
      if (!d || !String(r[c.name] || "").trim()) return;
      rows.push([d, String(r[c.store]||"").trim(), String(r[c.emp]||"").trim(),
                 String(r[c.stn]||"").trim(), String(r[c.item]||"").trim(),
                 String(r[c.name]||"").trim(), String(r[c.rate]||"").trim(), srNum_(r[c.amt])]);
    });
    return finish_(["date","store","employee","station","item_no","discount_name","rate","amount"], rows);
  }
},
{
  key: "MIR040", match: /MIR0?40/i, tab: "StaffCheckDiscounts",
  // Store / Employee / Station are blanked on repeat - carry them down.
  parse: function (g) {
    var head = g.shift() || [];
    var c = {store: srCol_(head,"Store Name"), emp: srCol_(head,"Employee Discount"),
             stn: srCol_(head,"Discount Station"), date: srCol_(head,"Trading Date"),
             chk: srCol_(head,"Check No"), name: srCol_(head,"Discount Name"),
             rate: srCol_(head,"Discount Rate/Amount"), amt: srCol_(head,"Discount Amount")};
    var store="", emp="", stn="", rows=[];
    g.forEach(function (r) {
      store = srFill_(store, r[c.store]); emp = srFill_(emp, r[c.emp]); stn = srFill_(stn, r[c.stn]);
      var d = srDate_(r[c.date]);
      if (!d || !String(r[c.chk] || "").trim()) return;
      rows.push([d, store, emp, stn, String(r[c.chk]).trim(),
                 String(r[c.name]||"").trim(), String(r[c.rate]||"").trim(), srNum_(r[c.amt])]);
    });
    return finish_(["date","store","employee","station","check_no","discount_name","rate","amount"], rows);
  }
},
{
  key: "MIR183", match: /MIR1?83/i, tab: "StaffVoids",
  // Store and Void Reason are blanked on repeat. Rows with a blank Item Name are group
  // SUBTOTALS, not voids - including them would double-count every reason.
  parse: function (g) {
    var head = g.shift() || [];
    var c = {store: srCol_(head,"Store Name"), reason: srCol_(head,"Void Reason"),
             item: srCol_(head,"Item Name"), vtime: srCol_(head,"Void Time"),
             emp: srCol_(head,"Employee"), chk: srCol_(head,"Check No"),
             cdate: srCol_(head,"Check Date"), qty: srCol_(head,"Gross Qty"),
             inc: srCol_(head,"Price (Inc.)"), note: srCol_(head,"Void Notes")};
    var store="", reason="", rows=[];
    g.forEach(function (r) {
      store = srFill_(store, r[c.store]); reason = srFill_(reason, r[c.reason]);
      var item = String(r[c.item]||"").trim();
      if (!item) return;                                  // subtotal row
      var d = srDate_(r[c.cdate]) || srDate_(r[c.vtime]);
      if (!d) return;
      rows.push([d, store, reason, item, srTime_(r[c.vtime]), String(r[c.emp]||"").trim(),
                 String(r[c.chk]||"").trim(), srNum_(r[c.qty]), srNum_(r[c.inc]),
                 String(r[c.note]||"").trim()]);
    });
    return finish_(["date","store","void_reason","item","void_time","employee","check_no",
                    "qty","price_inc","notes"], rows);
  }
},
{
  key: "RR008", match: /RR0?08/i, tab: "Transactions",
  // Different shape again: "Store Name:" banner rows, and the column header repeats for
  // each store. Carries EVERY transaction line, with amounts only on exceptions.
  parse: function (g) {
    var store = "", head = null, c = null, rows = [];
    g.forEach(function (r) {
      var a = String(r[0] || "").trim();
      if (!a && !r.slice(1).join("").trim()) return;
      if (a.indexOf("Store Name:") === 0) { store = a.replace("Store Name:", "").trim(); return; }
      if (a.toLowerCase() === "check no") {
        head = r;
        c = {chk:0, date: srCol_(head,"Check Date"), time: srCol_(head,"Order Time"),
             item: srCol_(head,"Item Name"), ref: srCol_(head,"Refund Amount"),
             di: srCol_(head,"Discount - Item Level"), dc: srCol_(head,"Discount - Check Level"),
             rev: srCol_(head,"Reversal Amount"), void: srCol_(head,"Void Amount")};
        return;
      }
      if (!c) return;
      var d = srDate_(r[c.date]);
      if (!d || !String(r[c.item] || "").trim()) return;
      rows.push([d, store, String(r[0]).trim(), srTime_(r[c.time]), String(r[c.item]).trim(),
                 srNum_(r[c.ref]), srNum_(r[c.di]), srNum_(r[c.dc]), srNum_(r[c.rev]), srNum_(r[c.void])]);
    });
    return finish_(["date","store","check_no","time","item","refund","discount_item",
                    "discount_check","reversal","void"], rows);
  }
}
];

/** Sort by date and record the range the file covers - that range is what gets replaced. */
function finish_(header, rows) {
  rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return { header: header, rows: rows,
           from: rows.length ? rows[0][0] : "", to: rows.length ? rows[rows.length-1][0] : "" };
}

/* ---- writing ---------------------------------------------------------------------- */
/**
 * Replace-by-date-range: drop any existing rows whose date falls inside the range this
 * file covers, then write the new ones. That makes a re-run idempotent and lets two
 * broadcasts overlap at the week boundary without duplicating.
 */
function writeReport_(ss, tabName, header, rows) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  var from = rows[0][0], to = rows[rows.length - 1][0];
  var replaced = 0;
  if (sh.getLastRow() > 1) {
    var cols = Math.max(sh.getLastColumn(), header.length);
    var old = sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
    var keep = old.filter(function (r) {
      var d = r[0];
      if (d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
      d = String(d || "").trim().slice(0, 10);
      if (!d) return false;
      return d < from || d > to;
    });
    replaced = old.length - keep.length;
    sh.getRange(2, 1, old.length, cols).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, cols).setValues(keep);
  }
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, header.length).setValues(rows);
  return { written: rows.length, replaced: replaced };
}

/* ---- remembering what has been handled -------------------------------------------- */
function loadDoneIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SR.DONE_PROP);
  var set = {};
  if (raw) { try { JSON.parse(raw).forEach(function (id) { set[id] = true; }); } catch (e) {} }
  return set;
}
function saveDoneIds_(existing, added) {
  var ids = Object.keys(existing).concat(added);
  if (ids.length > SR.MAX_DONE_IDS) ids = ids.slice(ids.length - SR.MAX_DONE_IDS);
  PropertiesService.getScriptProperties().setProperty(SR.DONE_PROP, JSON.stringify(ids));
}
/** Re-read reports that have already been handled - safe, because writes replace by date. */
function clearStaffReportsHistory() {
  PropertiesService.getScriptProperties().deleteProperty(SR.DONE_PROP);
  Logger.log("Staff report history cleared. The next run re-reads everything in the last 30 days.");
}

/* ======================================================================================
 * DEPUTY - wage cost pulled from timesheets
 *
 * Writes shifts to a DeputyShifts tab in BG Sales Data. The dashboard spreads them into
 * 15-minute slots at read time rather than the sheet storing slots, so the spreading rule
 * can change without re-pulling, and the tab stays small.
 *
 * SETUP
 *   1. Deputy > (top right) > Integrations > API/Permanent Token, or
 *      https://reds3.au.deputy.com/exec/devapp/oauth_clients
 *   2. Project Settings > Script Properties > DEPUTY_TOKEN = <the token>
 *   3. Run inspectDeputy() FIRST - it prints the field names Deputy actually returns
 *      without writing anything.
 *   4. Then put processDeputy on a daily trigger (early morning is fine).
 *
 * The token is a credential: it lives in Script Properties, never in the code and never in
 * a dashboard - the dashboards are public on GitHub Pages.
 * ==================================================================================== */

var DP = {
  BASE: "https://reds3.au.deputy.com/api/v1",
  TAB: "DeputyShifts",
  TOKEN_PROP: "DEPUTY_TOKEN",
  // How to present the token. Deputy documents "Bearer" for OAuth tokens, but PERMANENT
  // tokens have historically wanted "OAuth", and some installs accept a query parameter.
  // testDeputyAuth() finds the right one and stores it here so nothing has to guess.
  AUTH_PROP: "DEPUTY_AUTH_STYLE",
  // Timesheets are approved retrospectively, so recent days keep changing. Re-pull a
  // rolling window each night and replace by date - the same pattern as the staff reports.
  LOOKBACK_DAYS: 14,
  // Deputy location -> the venue name the sales feed uses. The bracketed suffixes are
  // Deputy's own uniqueness codes and are stripped before matching.
  LOCATIONS: {
    "luma kitchen": "Luma Kitchen",
    "red square cambridge": "Red Square Cambridge",
    "red square glenorchy": "Red Square Glenorchy"
  },
  /* Locations that are a real wage cost but produce no revenue AT THAT LOCATION.
     TasTAFE is apprentice school time, paid at base rate. It must NOT be dropped - it is
     money out the door and belongs in the venue's wage total - but it must not appear in
     the time-of-day curve either, or 10am on a Wednesday looks overstaffed when the person
     is in a classroom. So it is attributed to the venue the apprentice works at and tagged
     "training", and the dashboard decides which figures include it.
     Keyed by location -> the venue that carries the cost. */
  NONOPERATIONAL: { "tastafe": "Red Square Cambridge" },
  // Locations to drop entirely. Nothing qualifies today; kept for anything that is genuinely
  // not our cost.
  EXCLUDE: []
};

/** Location id -> name. OperationalUnit is the AREA ("BOH", "Kitchen"); the LOCATION is
 *  its Company. Fetched once per run and cached. */
var DP_LOC_CACHE = null;
function dpLocations_() {
  if (DP_LOC_CACHE) return DP_LOC_CACHE;
  DP_LOC_CACHE = {};
  try {
    var cos = dpPost_("/resource/Company/QUERY", { max: 200 });
    (cos || []).forEach(function (c) { DP_LOC_CACHE[c.Id] = c.CompanyName || c.TradingName || ("Company " + c.Id); });
  } catch (e) { Logger.log("Could not read the location list: " + e); }
  return DP_LOC_CACHE;
}

function dpToken_() {
  var t = PropertiesService.getScriptProperties().getProperty(DP.TOKEN_PROP);
  if (!t) throw new Error("No " + DP.TOKEN_PROP + " in Script Properties. " +
    "Project Settings > Script Properties > add DEPUTY_TOKEN = <your permanent token>.");
  return t;
}

/** The auth style testDeputyAuth() settled on. Defaults to OAuth, which is what Deputy's
 *  permanent tokens want - Bearer is for OAuth 2.0 access tokens and returns 401 here. */
function dpAuthStyle_() {
  return PropertiesService.getScriptProperties().getProperty(DP.AUTH_PROP) || "OAuth";
}
/** Build the request options for a given style, so the tester and the real calls agree. */
function dpOpts_(style, payload) {
  var o = { method: "post", contentType: "application/json",
            payload: JSON.stringify(payload || {}), muteHttpExceptions: true };
  if (style === "query") o.headers = {};
  else o.headers = { Authorization: style + " " + dpToken_() };
  return o;
}
function dpUrl_(style, path) {
  return DP.BASE + path + (style === "query" ? "?access_token=" + encodeURIComponent(dpToken_()) : "");
}

/** POST to a Deputy resource endpoint. Deputy returns a bare array, not a wrapped object. */
function dpPost_(path, payload) {
  var style = dpAuthStyle_();
  var res = UrlFetchApp.fetch(dpUrl_(style, path), dpOpts_(style, payload));
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 401 || code === 403) {
    throw new Error("Deputy rejected the token (" + code + ") using the '" + style + "' auth style.\n" +
                    "Run testDeputyAuth() - it tries every form and reports which one works, " +
                    "or confirms the token itself is the problem.");
  }
  if (code < 200 || code >= 300) throw new Error("Deputy " + path + " returned " + code + ": " + body.slice(0, 300));
  try { return JSON.parse(body); }
  catch (e) { throw new Error("Deputy " + path + " did not return JSON: " + body.slice(0, 200)); }
}

/** Strip Deputy's bracketed uniqueness suffix: "Red Square Cambridge (va4kn28r)". */
function dpLocName_(s) {
  return String(s || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}
function dpVenue_(locName) {
  var k = dpLocName_(locName).toLowerCase();
  if (DP.EXCLUDE.indexOf(k) > -1) return "";           // deliberately dropped
  if (DP.NONOPERATIONAL[k]) return DP.NONOPERATIONAL[k];
  return DP.LOCATIONS[k] || dpLocName_(locName);       // unknown locations pass through, visibly
}
/** "shift" = on the floor and countable against revenue. "training" = paid, but not there. */
function dpKind_(locName) {
  return DP.NONOPERATIONAL[dpLocName_(locName).toLowerCase()] ? "training" : "shift";
}

/**
 * READ-ONLY. Tries every way Deputy accepts a token against the simplest endpoint there is
 * ("Who am I"), reports which works, and remembers it.
 *
 * Deputy's docs describe Bearer, but that is for OAuth 2.0 access tokens; permanent tokens
 * have historically wanted "OAuth". Rather than guess, this asks.
 */
function testDeputyAuth() {
  var token;
  try { token = dpToken_(); }
  catch (e) { Logger.log(String(e)); return; }
  Logger.log("Token found: " + token.length + " characters, starts " + token.slice(0, 4) + "...");
  if (/\s/.test(token)) Logger.log(">> WARNING: the token contains whitespace. A stray space or " +
                                   "newline when pasting is a common cause of 401.");

  /* /me is a GET. POSTing to it makes Deputy try to read the body as a login and answer
     "Invalid email" - which looks like an auth failure but is not: it means the token was
     ACCEPTED and the request shape was wrong. Test the verb as well as the header. */
  var styles = ["OAuth", "Bearer", "query"];
  var winner = null, sawAuthOk = false;
  styles.forEach(function (style) {
    ["get", "post"].forEach(function (verb) {
      if (winner) return;
      try {
        var o = dpOpts_(style, verb === "post" ? {} : null);
        o.method = verb;
        if (verb === "get") { delete o.payload; delete o.contentType; }
        var res = UrlFetchApp.fetch(dpUrl_(style, "/me"), o);
        var code = res.getResponseCode();
        var body = res.getContentText().replace(/\s+/g, " ").slice(0, 140);
        Logger.log(style + " + " + verb.toUpperCase() + " -> HTTP " + code + "  " + body);
        // 400 "Invalid email" = the token got through; only the request shape was wrong.
        if (code === 400 && /email/i.test(body)) sawAuthOk = true;
        if (code >= 200 && code < 300) winner = style;
      } catch (e) { Logger.log(style + " + " + verb + " -> threw: " + e); }
    });
  });
  if (!winner && sawAuthOk) {
    Logger.log("\nDeputy ACCEPTED the token - the 400 'Invalid email' is a request-shape " +
               "complaint, not an auth failure. Falling back to the real endpoint to confirm.");
    ["OAuth", "Bearer"].forEach(function (style) {
      if (winner) return;
      try {
        var res = UrlFetchApp.fetch(dpUrl_(style, "/resource/Timesheet/QUERY"),
                                    dpOpts_(style, { max: 1 }));
        var code = res.getResponseCode();
        Logger.log("  " + style + " on Timesheet/QUERY -> HTTP " + code + "  " +
                   res.getContentText().replace(/\s+/g, " ").slice(0, 120));
        if (code >= 200 && code < 300) winner = style;
      } catch (e) { Logger.log("  " + style + " -> threw: " + e); }
    });
  }

  if (!winner) {
    if (sawAuthOk) {
      Logger.log("\nThe token authenticates but no endpoint returned data. The token's user " +
                 "may not have permission to read timesheets - check it is a System " +
                 "Administrator with access to all locations.");
      return;
    }
    Logger.log("\nNone worked. That points at the TOKEN rather than the header:");
    Logger.log("  - was it created at reds3.au.deputy.com/exec/devapp/oauth_clients ?");
    Logger.log("  - is the account that created it a System Administrator, and still active?");
    Logger.log("  - was the whole value copied, with no trailing space?");
    return;
  }
  PropertiesService.getScriptProperties().setProperty(DP.AUTH_PROP, winner);
  Logger.log("\nWorking auth style: " + winner + " - saved, nothing else to configure.");
  Logger.log("Now run inspectDeputy().");
}

/** GET a Deputy endpoint (some are GET-only, like /me and the discovery endpoints). */
function dpGet_(path) {
  var style = dpAuthStyle_();
  var o = { method: "get", muteHttpExceptions: true };
  if (style !== "query") o.headers = { Authorization: style + " " + dpToken_() };
  var res = UrlFetchApp.fetch(dpUrl_(style, path), o);
  var body = res.getContentText();
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    throw new Error(path + " -> " + res.getResponseCode() + ": " + body.slice(0, 200));
  }
  try { return JSON.parse(body); } catch (e) { return body; }
}

/**
 * READ-ONLY. Finds where salaried wage cost actually lives.
 *
 * Deputy's own wage cost report includes salaried staff, so the figure exists somewhere -
 * it is simply not on the timesheet. Rather than guess at field names again, this asks
 * Deputy: list the resources, then ask each candidate for its real field list, then pull a
 * sample. Writes nothing.
 */
function inspectDeputySalary() {
  Logger.log("=== what resources exist? ===");
  var all;
  try {
    all = dpGet_("/resource");
    var names = (all && typeof all === "object") ? Object.keys(all) : [];
    Logger.log(names.length + " resources. Ones that look pay-related:");
    names.filter(function (n) {
      return /pay|salar|wage|cost|rate|agreement|contract/i.test(n);
    }).forEach(function (n) { Logger.log("   " + n); });
  } catch (e) { Logger.log("resource list failed: " + e); }

  // INFO gives the REAL field names, which is what the "Invalid search field" error was about.
  ["EmployeeAgreement", "EmployeeAgreementHistory", "PayRules", "EmployeeSalary",
   "CompanyPeriod", "Timesheet"].forEach(function (r) {
    Logger.log("=== " + r + " fields ===");
    try {
      var info = dpGet_("/resource/" + r + "/INFO");
      if (info && info.fields) Logger.log("   " + Object.keys(info.fields).join(", "));
      else Logger.log("   " + JSON.stringify(info).slice(0, 300));
    } catch (e) { Logger.log("   " + e); }
  });

  // A sample agreement, unfiltered - the search field was the problem, not the resource.
  Logger.log("=== sample EmployeeAgreement ===");
  try {
    var ag = dpPost_("/resource/EmployeeAgreement/QUERY", { max: 2 });
    Logger.log(JSON.stringify(ag).slice(0, 900));
  } catch (e) { Logger.log("   " + e); }

  // OnCost sits on the timesheet and we have never looked at it.
  Logger.log("=== OnCost on recent timesheets ===");
  try {
    var tz = Session.getScriptTimeZone();
    var to = new Date(), from = new Date(to.getTime() - 14 * 864e5);
    var ts = dpPost_("/resource/Timesheet/QUERY", {
      search: { s1: { field: "Date", data: Utilities.formatDate(from, tz, "yyyy-MM-dd"), type: "ge" },
                s2: { field: "Date", data: Utilities.formatDate(to, tz, "yyyy-MM-dd"), type: "le" } },
      join: ["EmployeeObject"], max: 60
    });
    var zero = (ts || []).filter(function (x) { return !Number(x.Cost); });
    Logger.log(zero.length + " of " + (ts || []).length + " have no Cost. Looking at those:");
    zero.slice(0, 6).forEach(function (x) {
      Logger.log("   " + ((x.EmployeeObject && x.EmployeeObject.DisplayName) || x.Employee) +
                 "  hours " + x.TotalTime + "  Cost " + x.Cost + "  OnCost " + x.OnCost +
                 "  EmployeeAgreement " + x.EmployeeAgreement +
                 "  PayRuleApproved " + x.PayRuleApproved + "  Exported " + x.Exported);
    });
    if (zero.length) {
      Logger.log("=== pay lines for one uncosted timesheet ===");
      var pr = dpPost_("/resource/TimesheetPayReturn/QUERY", {
        search: { s1: { field: "Timesheet", data: zero[0].Id, type: "eq" } }, max: 10 });
      Logger.log("   " + JSON.stringify(pr).slice(0, 600));
    }
  } catch (e) { Logger.log("   " + e); }
  Logger.log("\nSend this log - between the field lists and the sample agreement, the rate " +
             "should be locatable.");
}

/**
 * READ-ONLY. Works out why Cost comes back 0.
 *
 * Deputy returns Value (hours) but Cost 0 on both Timesheet and TimesheetPayReturn. That
 * is normally one of: pay rates not set on the employee agreement, the API user not being
 * allowed to see wage costs, or costs only landing after payroll export. This checks a
 * spread of timesheets and looks at what else is visible, rather than guessing.
 */
function inspectDeputyCost() {
  var tz = Session.getScriptTimeZone();
  var to = new Date(), from = new Date(to.getTime() - 28 * 864e5);
  var f = Utilities.formatDate(from, tz, "yyyy-MM-dd"), t = Utilities.formatDate(to, tz, "yyyy-MM-dd");
  var ts;
  try {
    ts = dpPost_("/resource/Timesheet/QUERY", {
      search: { s1: { field: "Date", data: f, type: "ge" },
                s2: { field: "Date", data: t, type: "le" } },
      max: 200
    });
  } catch (e) { Logger.log("FAILED: " + e); return; }
  if (!ts || !ts.length) { Logger.log("No timesheets " + f + " to " + t + "."); return; }

  var withCost = ts.filter(function (x) { return Number(x.Cost) > 0; });
  Logger.log(ts.length + " timesheet(s) " + f + " to " + t + "; " + withCost.length +
             " with a non-zero Cost.");
  var approved = ts.filter(function (x) { return x.PayRuleApproved; });
  var exported = ts.filter(function (x) { return x.Exported; });
  Logger.log("  PayRuleApproved: " + approved.length + "   Exported: " + exported.length);
  if (withCost.length) {
    Logger.log("  >> Cost DOES populate on some. Sample: Id " + withCost[0].Id +
               " cost " + withCost[0].Cost + ", PayRuleApproved " + withCost[0].PayRuleApproved +
               ", Exported " + withCost[0].Exported);
    Logger.log("  Compare that against a zero-cost one to see which flag makes the difference.");
  } else {
    Logger.log("  >> Cost is 0 on ALL of them, approved or not. That points at pay rates " +
               "rather than timing.");
  }

  // Can we see pay rates at all? If not, cost has to come from somewhere else.
  Logger.log("--- can this token see pay rates? ---");
  var emp = ts[0].Employee;
  ["/resource/EmployeeAgreement/QUERY", "/resource/EmployeeSalaryOverride/QUERY"].forEach(function (p) {
    try {
      var r = dpPost_(p, { search: { s1: { field: "Employee", data: emp, type: "eq" } }, max: 2 });
      var txt = JSON.stringify(r).slice(0, 300);
      Logger.log(p + " -> " + txt);
    } catch (e) { Logger.log(p + " -> " + e); }
  });
  Logger.log("\nIf pay rates are visible, hours x rate is a workable fallback. If they are " +
             "not, Deputy restricts wage data to its Advanced Employee API, which has to be " +
             "enabled by Deputy - worth an email to their support with your install name.");
}

/**
 * READ-ONLY diagnostic. Pulls one day of timesheets and prints the field names Deputy
 * actually returns, plus one sample record. Writes nothing.
 *
 * Run this before processDeputy. The Deputy docs describe several shapes depending on
 * plan and configuration, and guessing at field names is how the Gmail attachment problem
 * cost an afternoon - better to look.
 */
function inspectDeputy() {
  var to = new Date(), from = new Date(to.getTime() - 7 * 864e5);
  var tz = Session.getScriptTimeZone();
  var f = Utilities.formatDate(from, tz, "yyyy-MM-dd"), t = Utilities.formatDate(to, tz, "yyyy-MM-dd");
  Logger.log("Querying timesheets " + f + " to " + t);

  var rows;
  try {
    rows = dpPost_("/resource/Timesheet/QUERY", {
      search: { s1: { field: "Date", data: f, type: "ge" },
                s2: { field: "Date", data: t, type: "le" } },
      join: ["OperationalUnitObject", "EmployeeObject"],
      max: 5
    });
  } catch (e) { Logger.log("FAILED: " + e); return; }

  Logger.log("returned " + (rows && rows.length) + " record(s)");
  if (!rows || !rows.length) {
    Logger.log("No timesheets in that window. Widen the range, or check the token's user " +
               "can see all locations.");
    return;
  }
  var r = rows[0];
  Logger.log("--- top-level fields ---");
  Logger.log(Object.keys(r).join(", "));
  ["Id","Date","StartTime","EndTime","Mealbreak","TotalTime","Cost","Employee",
   "OperationalUnit","IsInProgress","Disputed","TimeApproved"].forEach(function (k) {
    if (k in r) Logger.log("   " + k + " = " + JSON.stringify(r[k]));
  });
  if (r.OperationalUnitObject) {
    Logger.log("--- OperationalUnitObject (location + area) ---");
    Logger.log(JSON.stringify(r.OperationalUnitObject).slice(0, 500));
  }
  if (r.EmployeeObject) {
    Logger.log("--- EmployeeObject ---");
    Logger.log("   DisplayName = " + r.EmployeeObject.DisplayName);
  }
  Logger.log("--- does Timesheet carry Cost directly? ---");
  Logger.log("   Cost present: " + ("Cost" in r) + "   value: " + r.Cost);
  if (!("Cost" in r) || !r.Cost) {
    Logger.log("   No cost on the timesheet - trying TimesheetPayReturn for Id " + r.Id);
    try {
      var pay = dpPost_("/resource/TimesheetPayReturn/QUERY", {
        search: { s1: { field: "Timesheet", data: r.Id, type: "eq" } }, max: 5
      });
      Logger.log("   TimesheetPayReturn: " + JSON.stringify(pay).slice(0, 400));
    } catch (e) { Logger.log("   TimesheetPayReturn failed: " + e); }
  }
  Logger.log("--- locations seen, and how they map ---");
  var locs = dpLocations_();
  Logger.log("   location list from Deputy: " + JSON.stringify(locs));
  var seen = {};
  rows.forEach(function (x) {
    var ou = x.OperationalUnitObject || {};
    var n = locs[ou.Company] || ("Company " + ou.Company);
    seen[n + "  [area: " + (ou.OperationalUnitName || "?") + "]"] = dpVenue_(n) || "(EXCLUDED)";
  });
  Object.keys(seen).forEach(function (k) { Logger.log("   " + k + "  ->  " + seen[k]); });
  Logger.log("\nIf a location maps to itself rather than a sales-feed venue name, add it to " +
             "DP.LOCATIONS. If it is paid time with no revenue at that site (like TasTAFE), " +
             "add it to DP.NONOPERATIONAL pointing at the venue that carries the cost.");
}

/** Entry point. Daily trigger, early morning. */
function processDeputy() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try { processDeputy_(); } finally { lock.releaseLock(); }
}

function processDeputy_() {
  var tz = Session.getScriptTimeZone();
  var to = new Date(), from = new Date(to.getTime() - DP.LOOKBACK_DAYS * 864e5);
  var f = Utilities.formatDate(from, tz, "yyyy-MM-dd"), t = Utilities.formatDate(to, tz, "yyyy-MM-dd");

  var sheets = dpPost_("/resource/Timesheet/QUERY", {
    search: { s1: { field: "Date", data: f, type: "ge" },
              s2: { field: "Date", data: t, type: "le" } },
    join: ["OperationalUnitObject", "EmployeeObject"],
    max: 500
  });
  if (!sheets || !sheets.length) { Logger.log("No timesheets " + f + " to " + t + "."); return; }

  // Cost sometimes lives on the timesheet and sometimes only on TimesheetPayReturn. Fetch
  // the pay lines for anything missing it and sum them - one timesheet can have several
  // (ordinary, overtime, penalty), and the total is what matters here.
  var needCost = sheets.filter(function (s) { return !s.Cost; }).map(function (s) { return s.Id; });
  var payByTs = {};
  for (var i = 0; i < needCost.length; i += 100) {
    var batch = needCost.slice(i, i + 100);
    try {
      var pay = dpPost_("/resource/TimesheetPayReturn/QUERY", {
        search: { s1: { field: "Timesheet", data: batch, type: "in" } }, max: 500
      });
      (pay || []).forEach(function (p) {
        payByTs[p.Timesheet] = (payByTs[p.Timesheet] || 0) + (Number(p.Cost) || 0);
      });
    } catch (e) { Logger.log("Pay lookup failed for a batch (cost will be 0): " + e); }
  }

  var rows = [], skipped = 0, unknown = {};
  sheets.forEach(function (s) {
    var ou = s.OperationalUnitObject || {};
    var area = ou.OperationalUnitName || "";              // BOH, Bar, FOH, Kitchen
    var locRaw = dpLocations_()[ou.Company] || "";        // the actual venue
    var venue = dpVenue_(locRaw);
    if (!venue) { skipped++; return; }                    // excluded location
    var kind = dpKind_(locRaw);
    var lk = dpLocName_(locRaw).toLowerCase();
    if (!DP.LOCATIONS[lk] && !DP.NONOPERATIONAL[lk]) unknown[dpLocName_(locRaw)] = 1;

    var start = dpTime_(s.StartTime), end = dpTime_(s.EndTime);
    if (!start || !end) return;                           // in progress, or no clock-out
    // TotalTime is paid hours, already net of the meal break - use it. Mealbreak itself is
    // a DATETIME expressing a duration from midnight ("...T00:30:00" = 30 minutes), not a
    // number, so treating it as one produced NaN.
    var hours = Number(s.TotalTime) || ((end - start) / 36e5 - dpBreakHours_(s.Mealbreak));
    /* Cost only appears once the timesheet is EXPORTED to payroll - not when it is merely
       approved (196 approved vs 111 costed in the 28 days to 23 Aug 2026, against 109
       exported). So a zero on a recent shift means "not costed yet", not "cost nothing".
       Carry the flag so the dashboard can show hours now and dollars when they land,
       instead of quietly averaging in zeros and understating labour. */
    var cost = Number(s.Cost) || payByTs[s.Id] || 0;
    var costed = cost > 0 ? "final" : "pending";
    rows.push([
      Utilities.formatDate(start, tz, "yyyy-MM-dd"),
      venue,
      kind,                                                // shift | training
      area,                                                // FOH, Kitchen, BOH, Bar
      (s.EmployeeObject && s.EmployeeObject.DisplayName) || String(s.Employee || ""),
      Utilities.formatDate(start, tz, "HH:mm"),
      Utilities.formatDate(end, tz, "HH:mm"),
      Math.round(hours * 100) / 100,
      Math.round(cost * 100) / 100,
      costed
    ]);
  });
  if (!rows.length) { Logger.log("Nothing to write (" + skipped + " excluded)."); return; }

  var header = ["date","venue","kind","area","employee","start","end","hours","cost","costed"];
  var n = writeReport_(SpreadsheetApp.openById(SF.SPREADSHEET_ID), DP.TAB, header,
                       rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }));
  var pending = rows.filter(function (r) { return r[9] === "pending"; });
  var training = rows.filter(function (r) { return r[2] === "training"; });
  Logger.log("Deputy " + f + " to " + t + ": " + n.written + " shift(s), " + n.replaced +
             " replaced" + (skipped ? ", " + skipped + " excluded" : "") + ".");
  if (training.length) {
    Logger.log("  of those, " + training.length + " training line(s) worth $" +
               training.reduce(function (a, r) { return a + r[8]; }, 0).toFixed(2) +
               " - real wage cost, but kept out of the time-of-day view.");
  }
  if (pending.length) {
    Logger.log("  " + pending.length + " shift(s) not yet costed (" +
               pending.reduce(function (a, r) { return a + r[7]; }, 0).toFixed(1) +
               " hours). Deputy fills the cost in when the timesheet is exported to " +
               "payroll; the next run picks it up.");
  }
  var u = Object.keys(unknown);
  if (u.length) Logger.log("Locations not in DP.LOCATIONS, passed through as-is: " + u.join(", "));
}

/** Mealbreak arrives as "2026-08-16T00:30:00+10:00" - a duration expressed as a time. */
function dpBreakHours_(v) {
  if (v == null || v === "") return 0;
  var m = String(v).match(/T(\d{2}):(\d{2})/);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  var n = Number(v);
  return isNaN(n) ? 0 : n / 3600;          // some installs send seconds
}

/** Deputy times are unix seconds; be tolerant of a string date if the shape differs. */
function dpTime_(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v * 1000);
  var n = Number(v);
  if (!isNaN(n) && n > 1e8) return new Date(n * 1000);
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
