/**
 * BACKFILL.GS — week-by-week invoice backfill
 * Paste as a NEW file in the BG Ops Data Apps Script project, alongside its Code.gs.
 * Nothing in Code.gs needs editing. This drives the existing processInvoices() over a
 * moving one-week window instead of the live newer_than:14d one.
 *
 * WHY WEEK WINDOWS AND NOT A FLAT after:2026/06/01
 * runLane_ starts at start=0 on every run and GmailApp.search returns NEWEST FIRST.
 * Already-processed ids are skipped with `continue` before state.handled++, so they cost
 * a read but never count toward the budget. With a flat six-month query every run would
 * re-page the ~1,800 messages already in ProcessedEmails before reaching anything new,
 * which is exactly how the previous attempt burned the shared Gmail quota without ever
 * reaching the old mail. A one-week window holds 15-40 threads, so it is exhausted in a
 * single run and nothing is ever paged twice.
 *
 * RUN ORDER
 *   1. backfillStart()        once - sets the cursor to BACKFILL.FROM
 *   2. backfillRunWindow()    point a time-driven trigger at this, every 10 minutes
 *   3. backfillStatus()       any time - where it is up to
 *   4. backfillStop()         deletes the trigger and clears the cursor when done
 *
 * It stops by itself when the cursor reaches the live 14-day window, so it cannot run
 * past the point where the hourly cruising job already has coverage.
 */

var BACKFILL = {
  FROM: "2026-06-01",     // first window start (ISO). June 2026 = where the data begins.
  WINDOW_DAYS: 7,
  // Per lane, per run. This counts NEW messages only - already-processed ones are free.
  // 12 keeps a run inside the 6-minute execution limit even when every message is a
  // fresh PDF extraction at ~10-15s each.
  MAX_PER_RUN: 12,
  CURSOR_PROP: "invoiceBackfillCursor",
  // Leave the last 14 days to the hourly cruising job; overlapping it just wastes reads.
  STOP_WITHIN_DAYS: 14
};

// ---------------------------------------------------------------- control

function backfillStart() {
  PropertiesService.getScriptProperties().setProperty(BACKFILL.CURSOR_PROP, BACKFILL.FROM);
  Logger.log("Backfill cursor set to " + BACKFILL.FROM +
    ". Now add a time-driven trigger on backfillRunWindow (every 10 minutes).");
}

function backfillStatus() {
  var cur = PropertiesService.getScriptProperties().getProperty(BACKFILL.CURSOR_PROP);
  if (!cur) { Logger.log("No backfill in progress. Run backfillStart() first."); return; }
  var stopAt = bfStopDate_();
  var left = Math.ceil((stopAt.getTime() - bfParse_(cur).getTime()) / (BACKFILL.WINDOW_DAYS * 864e5));
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log("Backfill cursor: " + cur +
    "\nStops at: " + bfFmtIso_(stopAt) +
    "\nWindows remaining: " + Math.max(0, left) +
    "\nInvoices tab rows: " + ss.getSheetByName("Invoices").getLastRow() +
    "\nProcessedEmails rows: " + ss.getSheetByName("ProcessedEmails").getLastRow());
}

function backfillStop() {
  PropertiesService.getScriptProperties().deleteProperty(BACKFILL.CURSOR_PROP);
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "backfillRunWindow") { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log("Backfill stopped. Cursor cleared, " + n + " trigger(s) removed. " +
    "The hourly processInvoicesLocked job is untouched.");
}

// ---------------------------------------------------------------- the worker

/**
 * Processes ONE week window, then advances the cursor - but only if the window was
 * genuinely exhausted. If the run hit MAX_PER_RUN the window may still hold unprocessed
 * mail, so the cursor stays put and the next run picks up where this one stopped
 * (already-done messages are skipped via ProcessedEmails, so there is no double billing).
 */
function backfillRunWindow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another run in progress - stepping aside."); return; }

  try {
    var props = PropertiesService.getScriptProperties();
    var cur = props.getProperty(BACKFILL.CURSOR_PROP);
    if (!cur) { Logger.log("No cursor set. Run backfillStart() first."); return; }

    var from = bfParse_(cur);
    var stopAt = bfStopDate_();
    if (from.getTime() >= stopAt.getTime()) {
      Logger.log("Backfill complete - cursor " + cur + " has reached the live " +
        BACKFILL.STOP_WITHIN_DAYS + "-day window. Run backfillStop() to clean up.");
      return;
    }
    var to = new Date(from.getTime() + BACKFILL.WINDOW_DAYS * 864e5);

    // Gmail: after: is inclusive, before: is exclusive, so [from, to) windows tile the
    // range with no gap and no overlap.
    var win = " after:" + bfFmtGmail_(from) + " before:" + bfFmtGmail_(to);

    var saved = {
      s: CONFIG.SEARCH_QUERY, b: CONFIG.BODY_QUERY, m: CONFIG.MAX_EMAILS_PER_RUN
    };
    // Derived from CONFIG rather than retyped, so the backfill always matches whatever
    // the live queries are. If the date clause is ever renamed this throws instead of
    // silently sweeping the wrong range.
    var s2 = saved.s.replace(/\s*newer_than:\d+d/, win);
    var b2 = saved.b.replace(/\s*newer_than:\d+d/, win);
    if (s2 === saved.s || b2 === saved.b) {
      throw new Error("Could not find 'newer_than:Nd' in CONFIG.SEARCH_QUERY/BODY_QUERY - " +
        "backfill aborted rather than sweep an unbounded range.");
    }

    var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("ProcessedEmails");
    var before = log ? log.getLastRow() : 0;

    CONFIG.SEARCH_QUERY = s2;
    CONFIG.BODY_QUERY = b2;
    CONFIG.MAX_EMAILS_PER_RUN = BACKFILL.MAX_PER_RUN;

    var t0 = new Date();
    try {
      processInvoices();
    } finally {
      CONFIG.SEARCH_QUERY = saved.s;
      CONFIG.BODY_QUERY = saved.b;
      CONFIG.MAX_EMAILS_PER_RUN = saved.m;
    }

    var added = (log ? log.getLastRow() : 0) - before;
    var secs = Math.round((new Date().getTime() - t0.getTime()) / 1000);

    // Each lane has its own budget, so a full sweep can log up to 2 x MAX_PER_RUN.
    // Anything at or above one lane's budget means a lane may have been cut short.
    var maybeMore = added >= BACKFILL.MAX_PER_RUN;
    if (maybeMore) {
      Logger.log("Window " + bfFmtIso_(from) + " -> " + bfFmtIso_(to) + ": " + added +
        " message(s) in " + secs + "s. Budget reached, so the window may not be finished - " +
        "cursor held, next run resumes the same week.");
    } else {
      props.setProperty(BACKFILL.CURSOR_PROP, bfFmtIso_(to));
      Logger.log("Window " + bfFmtIso_(from) + " -> " + bfFmtIso_(to) + ": " + added +
        " message(s) in " + secs + "s. Window exhausted, cursor advanced to " + bfFmtIso_(to) + ".");
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- dates

function bfParse_(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) throw new Error("Bad cursor date '" + iso + "' - expected YYYY-MM-DD.");
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function bfFmtIso_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function bfFmtGmail_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

function bfStopDate_() {
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(today.getTime() - BACKFILL.STOP_WITHIN_DAYS * 864e5);
}
