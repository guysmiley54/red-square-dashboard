/**
 * End-of-Day Reconciliation ingestion.
 *
 * Staff complete a Google Form at close (~4pm). Form Publisher turns each response
 * into the PDF that gets emailed and printed. This script ignores the emails and the
 * PDFs entirely and reads the FORM RESPONSE SHEETS directly - the same data, already
 * structured, with no parsing and no Gmail quota cost.
 *
 * Three separate forms, one per venue, each its own workbook:
 *   Red Square Cambridge  POS 1-4, denomination count, Doshii
 *   Red Square Glenorchy  POS 1-3, denomination count
 *   Luma Kitchen          POS 1,   no denomination count (no safe float on site)
 *
 * Tabs it maintains in BG Sales Data:
 *   Reconciliation  date | venue | submitted_by | tills | impos_cash | actual_cash |
 *                   cash_var | impos_eft | doshii | float_total | n50 | n20 | n10 | n5 |
 *                   c2 | c1 | r2 | r1 | r50 | r20 | r10 | r5 | float_var | flags
 *                   (one row per venue per trading day)
 *   ReconTills      date | venue | pos | staff | impos_cash | actual_cash | variance | flag
 *                   (one row per till per venue per trading day - this is the
 *                    per-person over/short that nothing else in the platform sees)
 *
 * SETUP:
 *   1. Paste into the Sales Feed Apps Script project (bound to BG Sales Data) as its
 *      own script file. Do NOT paste it over Code.gs - see the naming trap in the
 *      handover; both Apps Script projects have a file called Code.gs.
 *   2. Run processReconciliation once from the editor to authorise (Sheets only -
 *      this script touches no Gmail and no external API).
 *   3. Triggers (clock icon) > Add Trigger > processReconciliation > time-driven >
 *      day timer > 5pm-6pm. Staff submit around 4pm, so 5pm clears them with an hour
 *      of slack.
 *
 * TRAPS THIS HANDLES - every one of these was measured in the live data, not guessed:
 *
 *   - THE STAFF-TYPED DATE FIELD IS NOT TRUSTWORTHY. 54 rows across the two cafe
 *     sheets carry years like 0001, 0011 and 2032. The form Timestamp is reliable and
 *     the staff Date is not, so the Date is used only when it lands within
 *     RECON.DATE_TOLERANCE_DAYS of the Timestamp, and the Timestamp date is used
 *     otherwise. Rows that fall back are flagged BAD_DATE rather than silently fixed -
 *     a venue suddenly throwing BAD_DATE every day means the form changed.
 *
 *   - THE THREE WORKBOOKS ARE NOT ON THE SAME TIMEZONE. Glenorchy's sheet is set to
 *     UTC; Cambridge and Luma are on Australia/Hobart. Measured 22 Sep 2026: a
 *     Glenorchy submission reads 06:22:30 against a 16:23 Hobart send time, while
 *     Cambridge reads 16:01:14 against 16:02. Reading cells as Date objects would
 *     silently shift Glenorchy's by ten hours and roll any morning submission back a
 *     day. So this script reads DISPLAY values and parses the dd/mm/yyyy text - what
 *     is on the screen, never a serial number re-interpreted in another timezone.
 *     This is the same failure mode as the SalesFeed column-A format defence.
 *
 *   - DECIMAL-POINT TYPOS FAKE ENORMOUS VARIANCES. Real examples: 28730 entered for
 *     287.30, and 24430 for 244.30. Raw, those two rows alone make Cambridge's July
 *     look like $24,213 of missing cash. A till whose two figures differ by more than
 *     RECON.TYPO_RATIO times is flagged DECIMAL? and its variance is NOT counted into
 *     the day's cash_var. The row is still written - it is a data-entry problem to fix,
 *     not a row to hide. Anything averaging this data without that guard produces
 *     alarming nonsense.
 *
 *   - HEADERS REPEAT. Both cafe forms have been edited over the years and their sheets
 *     carry legacy duplicate columns - "POS 1 Impos cash total" appears twice in the
 *     Cambridge sheet, and a second block of dead columns sits past column 40. Columns
 *     are therefore resolved BY HEADER NAME, and where a name appears more than once
 *     the copy carrying the most data wins. Nothing here is a hardcoded column index,
 *     so another form edit reshuffling the columns does not silently misread them.
 *
 *   - A SHEET THAT RETURNS DATA HAS NOT NECESSARILY RETURNED ITS DATA. The response
 *     tab is located by checking each tab's header against a required-column signature
 *     rather than by name or position, for the same reason fetchTab() in the dashboards
 *     checks TAB_COLUMNS: a wrong tab is rarely empty.
 *
 * ROLL VALUES are Royal Australian Mint standard. $1 = $20 a roll confirmed by Adrian,
 * 22 Sep 2026. If a site ever rolls its own short, these are the numbers to change.
 *
 * RE-READING: every run rebuilds the last RECON.LOOKBACK_DAYS days rather than
 * appending only what is new. Staff can edit a submission after the fact through the
 * Form Publisher edit link, and late submissions are normal, so a rolling rebuild keeps
 * the tab correct where an append-only feed would freeze the first version. Rows
 * outside the window are never touched.
 */

var RECON = {
  // BG Sales Data - the workbook this script is bound to.
  SPREADSHEET_ID: '1QEUnzY43v3wVc6dP0oGPqgL_mvLRVGHnMYwtO3QMJY4',

  SHEET_DAY:  'Reconciliation',
  SHEET_TILL: 'ReconTills',

  LOOKBACK_DAYS: 14,
  DATE_TOLERANCE_DAYS: 7,

  // Script Property holding the list of venues already backfilled.
  BACKFILL_PROP: 'reconBackfillDone',

  // A till flagged DECIMAL? when the larger figure is this many times the smaller.
  TYPO_RATIO: 50,
  TYPO_MIN_ABS: 150,

  // A till variance at or beyond this is flagged BIG_VAR for the daily read.
  BIG_VAR: 20,

  // Target safe float per venue. Set these and the script flags FLOAT_OFF whenever a
  // day's count strays past the tolerance. Left null, float is recorded but not judged.
  TARGETS: {
    'Red Square Cambridge': null,
    'Red Square Glenorchy': null
  },
  FLOAT_TOLERANCE: 50,

  // Face value of one roll, in dollars.
  ROLL: { r2: 50, r1: 20, r50: 10, r20: 4, r10: 4, r5: 2 },

  SOURCES: [
    {
      venue: 'Red Square Cambridge',
      id: '1Xtqin9seucI9jO5IZ6ilJ1aRMapJs8E71aWBKa9lb2c',
      // Candidates in preference order. 'Submitted by:' only exists from 28 Nov 2021;
      // before that the form had a single 'Staff Name' field. First populated wins, so
      // a backfill reaching into 2019 still gets a name on the row.
      submittedBy: ['Submitted by:', 'Staff Name'],
      doshii: 'Doshii total sales',
      hasFloat: true,
      tills: [
        { pos: '1', staff: 'POS 1 Staff name:', imp: 'POS 1 Impos cash total', act: 'POS 1 Actual cash total', eft: 'POS 1 Impos EFT total' },
        { pos: '2', staff: 'POS 2 Staff name:', imp: 'POS 2 Impos cash total', act: 'POS 2 Actual cash total', eft: 'POS 2 Impos EFT total' },
        { pos: '3', staff: 'POS 3 Staff name:', imp: 'POS 3 Impos cash total', act: 'POS 3 Actual cash total', eft: 'POS 3 Impos EFT total' },
        { pos: '4', staff: 'POS 4 Staff name:', imp: 'POS 4 Impos cash total', act: 'POS 4 Actual cash total', eft: 'POS 4 Impos EFT total' }
      ]
    },
    {
      venue: 'Red Square Glenorchy',
      id: '13ZPE0A7EQuhiXfUvnRK77V9EvfQya0ZEgSIqm4yvvP0',
      submittedBy: ['Submitted by:', 'POS 1 Staff name:'],
      doshii: null,
      hasFloat: true,
      tills: [
        { pos: '1', staff: 'POS 1 Staff name:', imp: 'POS 1 Impos cash total', act: 'POS 1 Actual cash total', eft: 'POS 1 Impos EFT total' },
        { pos: '2', staff: 'POS 2 Staff name:', imp: 'POS 2 Impos cash total', act: 'POS 2 Actual cash total', eft: 'POS 2 Impos EFT total' },
        { pos: '3', staff: 'POS 3 Staff name:', imp: 'POS 3 Impos cash total', act: 'POS 3 Actual cash total', eft: 'POS 3 Impos EFT total' }
      ]
    },
    {
      venue: 'Luma Kitchen',
      id: '1v5vh8KvSS5beeTNW2tJ1deBl8T9hLGOJW3mqOkfSmug',
      submittedBy: ['Staff Name'],
      doshii: 'POS 1 Doshii total',
      hasFloat: false,
      tills: [
        { pos: '1', staff: 'Staff Name', imp: 'POS 1 Impos cash total', act: 'POS 1 Actual cash total', eft: 'POS 1 Impos EFT total' }
      ]
    }
  ],

  // Denomination columns, in float-value order.
  DENOM: [
    { key: 'n50', col: '$50 notes',        mult: 50 },
    { key: 'n20', col: '$20 notes',        mult: 20 },
    { key: 'n10', col: '$10 notes',        mult: 10 },
    { key: 'n5',  col: '$5 notes',         mult: 5  },
    { key: 'c2',  col: '$2 coins (loose)', mult: 2  },
    { key: 'c1',  col: '$1 coins (loose)', mult: 1  },
    { key: 'r2',  col: '$2 rolls',         mult: 50 },
    { key: 'r1',  col: '$1 rolls',         mult: 20 },
    { key: 'r50', col: '50c rolls',        mult: 10 },
    { key: 'r20', col: '20c rolls',        mult: 4  },
    { key: 'r10', col: '10c rolls',        mult: 4  },
    { key: 'r5',  col: '5c rolls',         mult: 2  }
  ],

  DAY_HEADER: ['date', 'venue', 'submitted_by', 'tills', 'impos_cash', 'actual_cash',
               'cash_var', 'impos_eft', 'doshii', 'float_total', 'n50', 'n20', 'n10',
               'n5', 'c2', 'c1', 'r2', 'r1', 'r50', 'r20', 'r10', 'r5', 'float_var',
               'flags'],

  TILL_HEADER: ['date', 'venue', 'pos', 'staff', 'impos_cash', 'actual_cash',
                'variance', 'flag']
};


/* ------------------------------------------------------------------ helpers */

/** Number from a display string. Returns null for blank/unparseable, never NaN. */
function recNum_(v) {
  if (v === null || v === undefined) return null;
  var s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Zero-default flavour of recNum_, for denomination counts. */
function recNum0_(v) {
  var n = recNum_(v);
  return n === null ? 0 : n;
}

/** dd/mm/yyyy (optionally followed by a time) -> 'yyyy-mm-dd'. Null if not a date. */
function recDate_(v) {
  var m = String(v === null || v === undefined ? '' : v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  var d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Zero-pad the YEAR too. Staff have typed years 0001 and 0011 into the Date field;
  // unpadded those become '1-11-07', which sorts and compares as a string in a way
  // that would quietly slip past the window filter.
  var ys = String(y);
  while (ys.length < 4) ys = '0' + ys;
  return ys + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}

/** Whole days between two 'yyyy-mm-dd' keys. */
function recDayDiff_(a, b) {
  return Math.abs((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}

/** 'yyyy-mm-dd' n days before the given key. */
function recAddDays_(key, n) {
  var d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function recRound_(n) { return Math.round(n * 100) / 100; }


/**
 * Resolve logical column names to indices against a header row.
 *
 * Both cafe sheets carry duplicate header names left behind by form edits, so a plain
 * indexOf would happily bind to a dead column that has been empty for two years. Where
 * a name appears more than once, the copy carrying the most data across the sampled
 * rows wins. Names that appear nowhere resolve to -1 and the caller decides whether
 * that is fatal.
 */
function recColMap_(header, rows, names) {
  var map = {};
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!name) continue;
    var hits = [];
    for (var c = 0; c < header.length; c++) {
      if (String(header[c]).trim() === name) hits.push(c);
    }
    if (hits.length === 0) { map[name] = -1; continue; }
    if (hits.length === 1) { map[name] = hits[0]; continue; }
    var best = hits[0], bestN = -1;
    for (var h = 0; h < hits.length; h++) {
      var n = 0;
      for (var r = 0; r < rows.length; r++) {
        var v = rows[r][hits[h]];
        if (v !== undefined && v !== null && String(v).trim() !== '') n++;
      }
      if (n > bestN) { bestN = n; best = hits[h]; }
    }
    map[name] = best;
  }
  return map;
}

/** submittedBy accepts a string or a list; always hand back a list. */
function recSubmitCandidates_(src) {
  if (!src.submittedBy) return [];
  return (typeof src.submittedBy === 'string') ? [src.submittedBy] : src.submittedBy;
}

/** First populated candidate column for this row, or ''. */
function recSubmitter_(row, map, src) {
  var by = recSubmitCandidates_(src);
  for (var i = 0; i < by.length; i++) {
    var idx = map[by[i]];
    if (idx >= 0) {
      var v = String(row[idx] === undefined ? '' : row[idx]).trim();
      if (v !== '') return v;
    }
  }
  return '';
}

/** Every logical column name a source needs. */
function recNamesFor_(src) {
  var names = ['Timestamp', 'Date'];
  var by = recSubmitCandidates_(src);
  for (var b = 0; b < by.length; b++) names.push(by[b]);
  if (src.doshii) names.push(src.doshii);
  for (var i = 0; i < src.tills.length; i++) {
    names.push(src.tills[i].staff, src.tills[i].imp, src.tills[i].act, src.tills[i].eft);
  }
  if (src.hasFloat) {
    for (var d = 0; d < RECON.DENOM.length; d++) names.push(RECON.DENOM[d].col);
  }
  return names;
}

/**
 * Find the response tab by header signature rather than by name or position.
 * A tab that returns rows has not necessarily returned the right rows.
 */
function recFindResponseSheet_(ss, src) {
  var need = ['Timestamp', src.tills[0].imp, src.tills[0].act];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var lastCol = sheets[i].getLastColumn();
    if (lastCol < 3 || sheets[i].getLastRow() < 2) continue;
    var hdr = sheets[i].getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var ok = true;
    for (var n = 0; n < need.length; n++) {
      var found = false;
      for (var c = 0; c < hdr.length; c++) {
        if (String(hdr[c]).trim() === need[n]) { found = true; break; }
      }
      if (!found) { ok = false; break; }
    }
    if (ok) return sheets[i];
  }
  return null;
}


/* -------------------------------------------------------------- the main run */

function processReconciliation() {
  var t0 = new Date();
  var book = SpreadsheetApp.openById(RECON.SPREADSHEET_ID);

  // The window is anchored on today in HOBART, not on the script's idea of today and
  // not on any source sheet's timezone.
  var today = Utilities.formatDate(new Date(), 'Australia/Hobart', 'yyyy-MM-dd');
  var from  = recAddDays_(today, -RECON.LOOKBACK_DAYS);

  var dayRows = [], tillRows = [], report = [], problems = [], ok = [];

  for (var s = 0; s < RECON.SOURCES.length; s++) {
    var src = RECON.SOURCES[s];
    try {
      var got = recReadSource_(src, from, today);
      dayRows = dayRows.concat(got.days);
      tillRows = tillRows.concat(got.tills);
      ok.push(src.venue);
      report.push(src.venue + ': ' + got.days.length + ' days, ' + got.tills.length +
                  ' tills' + (got.badDates ? ', ' + got.badDates + ' BAD_DATE' : '') +
                  (got.typos ? ', ' + got.typos + ' DECIMAL?' : ''));
      if (got.notes.length) problems = problems.concat(got.notes);
    } catch (e) {
      problems.push(src.venue + ': READ FAILED - ' + e.message);
    }
  }

  recReplaceWindow_(book, RECON.SHEET_DAY,  RECON.DAY_HEADER,  dayRows,  from, today, ok);
  recReplaceWindow_(book, RECON.SHEET_TILL, RECON.TILL_HEADER, tillRows, from, today, ok);

  var secs = ((new Date() - t0) / 1000).toFixed(1);
  Logger.log('Reconciliation ' + from + ' .. ' + today + ' in ' + secs + 's');
  for (var r = 0; r < report.length; r++) Logger.log('  ' + report[r]);
  if (problems.length) {
    Logger.log('  PROBLEMS:');
    for (var p = 0; p < problems.length; p++) Logger.log('    ' + problems[p]);
  }
  return { days: dayRows.length, tills: tillRows.length, problems: problems };
}


/**
 * Read one venue's form responses for the window.
 * maxRows caps how far back up the sheet to look. The daily run only needs the tail;
 * a backfill passes Infinity and reads the lot.
 */
function recReadSource_(src, from, to, maxRows) {
  if (maxRows === undefined) maxRows = 400;
  var ss = SpreadsheetApp.openById(src.id);
  var sheet = recFindResponseSheet_(ss, src);
  if (!sheet) throw new Error('no tab matched the response header signature');

  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];

  // Only the tail can fall inside the window; reading the whole sheet costs nothing
  // useful and these go back to 2019. Take a generous tail and filter by date.
  var take = Math.min(lastRow - 1, maxRows);
  if (take <= 0) return { days: [], tills: [], badDates: 0, typos: 0, notes: [] };
  var rows = sheet.getRange(lastRow - take + 1, 1, take, lastCol).getDisplayValues();

  var map = recColMap_(header, rows, recNamesFor_(src));
  var notes = [];
  if (map['Timestamp'] < 0) throw new Error('no Timestamp column');

  var missing = [];
  for (var t = 0; t < src.tills.length; t++) {
    if (map[src.tills[t].imp] < 0 || map[src.tills[t].act] < 0) missing.push('POS ' + src.tills[t].pos);
  }
  if (missing.length === src.tills.length) throw new Error('no till columns resolved');
  if (missing.length) notes.push(src.venue + ': till columns missing for ' + missing.join(', '));

  if (src.hasFloat) {
    for (var d = 0; d < RECON.DENOM.length; d++) {
      if (map[RECON.DENOM[d].col] < 0) {
        notes.push(src.venue + ': denomination column "' + RECON.DENOM[d].col + '" not found');
      }
    }
  }

  var days = [], tills = [], badDates = 0, typos = 0, seen = {};

  for (var i = rows.length - 1; i >= 0; i--) {
    var row = rows[i];
    if (!recRowHasData_(row)) continue;

    var ts = recDate_(row[map['Timestamp']]);
    if (!ts) continue;

    var flags = [];
    var date = map['Date'] >= 0 ? recDate_(row[map['Date']]) : null;
    if (!date || recDayDiff_(date, ts) > RECON.DATE_TOLERANCE_DAYS) {
      if (date) { badDates++; flags.push('BAD_DATE'); }
      date = ts;
    }

    if (date < from || date > to) continue;

    // Latest submission for a venue-day wins. Rows are walked newest-first, so the
    // first one seen is the one kept - a resubmission supersedes the original.
    if (seen[date]) continue;
    seen[date] = true;

    var impCash = 0, actCash = 0, eft = 0, varSum = 0, nTills = 0, anyCash = false;

    for (var k = 0; k < src.tills.length; k++) {
      var cfg = src.tills[k];
      if (map[cfg.imp] < 0 || map[cfg.act] < 0) continue;
      var imp = recNum_(row[map[cfg.imp]]);
      var act = recNum_(row[map[cfg.act]]);
      var e   = map[cfg.eft] >= 0 ? recNum_(row[map[cfg.eft]]) : null;
      if (imp === null && act === null && e === null) continue;

      if (e !== null) eft += e;
      if (imp === null || act === null) continue;

      anyCash = true;
      nTills++;
      impCash += imp;
      actCash += act;

      var v = recRound_(act - imp);
      var tillFlag = '';
      var lo = Math.min(Math.abs(imp), Math.abs(act));
      var hi = Math.max(Math.abs(imp), Math.abs(act));
      if (Math.abs(v) >= RECON.TYPO_MIN_ABS && lo > 0 && hi / lo >= RECON.TYPO_RATIO) {
        tillFlag = 'DECIMAL?';
        typos++;
      } else {
        varSum += v;
        if (Math.abs(v) >= RECON.BIG_VAR) tillFlag = 'BIG_VAR';
      }

      tills.push([date, src.venue, cfg.pos,
                  map[cfg.staff] >= 0 ? String(row[map[cfg.staff]]).trim() : '',
                  imp, act, v, tillFlag]);
    }

    if (!anyCash && !src.hasFloat) continue;

    var denom = {}, floatTotal = 0;
    if (src.hasFloat) {
      for (var dd = 0; dd < RECON.DENOM.length; dd++) {
        var spec = RECON.DENOM[dd];
        var qty = map[spec.col] >= 0 ? recNum0_(row[map[spec.col]]) : 0;
        denom[spec.key] = qty;
        floatTotal += qty * spec.mult;
      }
      floatTotal = recRound_(floatTotal);
    }

    var floatVar = '';
    var target = RECON.TARGETS[src.venue];
    if (src.hasFloat && target !== null && target !== undefined) {
      floatVar = recRound_(floatTotal - target);
      if (Math.abs(floatVar) > RECON.FLOAT_TOLERANCE) flags.push('FLOAT_OFF');
    }
    if (src.hasFloat && floatTotal === 0) flags.push('NO_FLOAT_COUNT');

    for (var f = 0; f < tills.length; f++) {
      if (tills[f][0] === date && tills[f][1] === src.venue && tills[f][7] === 'DECIMAL?') {
        if (flags.indexOf('DECIMAL?') < 0) flags.push('DECIMAL?');
      }
    }

    days.push([
      date, src.venue,
      recSubmitter_(row, map, src),
      nTills, recRound_(impCash), recRound_(actCash), recRound_(varSum),
      recRound_(eft),
      src.doshii && map[src.doshii] >= 0 ? recNum0_(row[map[src.doshii]]) : '',
      src.hasFloat ? floatTotal : '',
      src.hasFloat ? denom.n50 : '', src.hasFloat ? denom.n20 : '',
      src.hasFloat ? denom.n10 : '', src.hasFloat ? denom.n5  : '',
      src.hasFloat ? denom.c2  : '', src.hasFloat ? denom.c1  : '',
      src.hasFloat ? denom.r2  : '', src.hasFloat ? denom.r1  : '',
      src.hasFloat ? denom.r50 : '', src.hasFloat ? denom.r20 : '',
      src.hasFloat ? denom.r10 : '', src.hasFloat ? denom.r5  : '',
      floatVar, flags.join(' ')
    ]);
  }

  days.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  tills.sort(function (a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
  });

  return { days: days, tills: tills, badDates: badDates, typos: typos, notes: notes };
}


function recRowHasData_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== undefined && row[i] !== null && String(row[i]).trim() !== '') return true;
  }
  return false;
}


/**
 * Replace rows inside [from, to] with the freshly-read set, leaving everything outside
 * the window alone. Idempotent: running twice produces the same tab.
 *
 * `venues` is the list of venues whose rows may be replaced, and it matters. Without it
 * a run where one workbook failed to open would clear that venue's rows for the whole
 * window and write nothing back - a read failure would silently destroy good history.
 * Only venues that actually returned data are cleared.
 */
function recReplaceWindow_(book, name, header, rows, from, to, venues) {
  var sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }

  // Column A holds a date KEY, not a date. Force it to plain text so Sheets cannot
  // coerce '2026-09-21' into a Date - which would make every key comparison miss and
  // rewrite the whole window each run. Same defence as SalesState column A.
  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), 1).setNumberFormat('@');

  var last = sheet.getLastRow();
  var kept = [];
  if (last > 1) {
    var existing = sheet.getRange(2, 1, last - 1, header.length).getValues();
    for (var i = 0; i < existing.length; i++) {
      var key = String(existing[i][0]).trim();
      if (key === '') continue;
      var inWindow = (key >= from && key <= to);
      var mine = !venues || venues.indexOf(String(existing[i][1])) >= 0;
      if (inWindow && mine) continue;   // being replaced by this run
      kept.push(existing[i]);
    }
  }

  var out = kept.concat(rows);
  out.sort(function (a, b) {
    if (String(a[0]) !== String(b[0])) return String(a[0]) < String(b[0]) ? -1 : 1;
    return String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0;
  });

  if (last > 1) sheet.getRange(2, 1, last - 1, header.length).clearContent();
  if (out.length) sheet.getRange(2, 1, out.length, header.length).setValues(out);
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
}


/* ----------------------------------------------------------------- backfill */

/**
 * One-off: load the entire history of every venue into the two tabs.
 *
 * Cambridge goes back to 1 Aug 2019 and Glenorchy to 15 Jun 2022, so this is roughly
 * 6,000 day rows and 16,000 till rows. That is a comfortable amount of data for Sheets
 * but too much to read and write inside one six-minute execution with any margin, so
 * this runs ONE VENUE PER INVOCATION and remembers which are done in Script Properties.
 *
 * Run it, wait for it to finish, run it again. It reports what is left each time and
 * says DONE when there is nothing outstanding. Re-running after it says DONE does
 * nothing until reconBackfillReset() is called.
 *
 * Safe to run against populated tabs, and safe to interrupt. Each venue is written with
 * a venue-scoped window replace, so a venue already loaded is simply rewritten with the
 * same values and no other venue is touched. It does not need the daily trigger paused.
 *
 * WHAT THE OLDER ROWS DO AND DO NOT CARRY - read before trusting a long-range average:
 *   - Cash totals and the full denomination count run the whole way back at both cafes.
 *     Float history is therefore genuinely seven years deep at Cambridge.
 *   - Cambridge POS 3 does not exist before 12 Nov 2020. Its absence is not a zero
 *     till - the day row's `tills` count reflects how many were actually running.
 *   - PER-TILL STAFF NAMES ONLY EXIST FROM 28 NOV 2021 at Cambridge. Before that the
 *     form captured one name for the whole day, which lands in `submitted_by` and
 *     leaves `staff` blank on the till rows. Any per-person variance analysis has to
 *     start at Nov 2021 or it will quietly attribute four tills to one person.
 *   - Doshii starts 24 Mar 2023. Tyro totals stopped 15 Jul 2022 and are not ingested
 *     at all - the EFT figure used here is the Impos one, which spans the full history.
 */
function reconBackfill() {
  var props = PropertiesService.getScriptProperties();
  var done = JSON.parse(props.getProperty(RECON.BACKFILL_PROP) || '[]');
  var book = SpreadsheetApp.openById(RECON.SPREADSHEET_ID);
  var today = Utilities.formatDate(new Date(), 'Australia/Hobart', 'yyyy-MM-dd');

  var next = null;
  for (var s = 0; s < RECON.SOURCES.length; s++) {
    if (done.indexOf(RECON.SOURCES[s].venue) < 0) { next = RECON.SOURCES[s]; break; }
  }
  if (!next) {
    Logger.log('Backfill DONE - all ' + RECON.SOURCES.length + ' venues loaded.');
    Logger.log('Run reconBackfillReset() first if you need to load them again.');
    return { done: true };
  }

  var t0 = new Date();
  Logger.log('Backfilling ' + next.venue + ' ...');

  var got = recReadSource_(next, '0000-01-01', today, Infinity);
  if (!got.days.length) {
    Logger.log('  no rows returned - NOT marking done. Run reconHealthCheck().');
    return { done: false, venue: next.venue, rows: 0 };
  }

  var earliest = got.days[0][0];
  recReplaceWindow_(book, RECON.SHEET_DAY,  RECON.DAY_HEADER,  got.days,
                    earliest, today, [next.venue]);
  recReplaceWindow_(book, RECON.SHEET_TILL, RECON.TILL_HEADER, got.tills,
                    earliest, today, [next.venue]);

  done.push(next.venue);
  props.setProperty(RECON.BACKFILL_PROP, JSON.stringify(done));

  var remaining = [];
  for (var r = 0; r < RECON.SOURCES.length; r++) {
    if (done.indexOf(RECON.SOURCES[r].venue) < 0) remaining.push(RECON.SOURCES[r].venue);
  }

  Logger.log('  ' + got.days.length + ' days, ' + got.tills.length + ' tills, ' +
             earliest + ' .. ' + got.days[got.days.length - 1][0] +
             ' in ' + ((new Date() - t0) / 1000).toFixed(1) + 's');
  if (got.badDates) Logger.log('  ' + got.badDates + ' rows fell back to the timestamp date');
  if (got.typos)    Logger.log('  ' + got.typos + ' tills flagged DECIMAL?');
  for (var n = 0; n < got.notes.length; n++) Logger.log('  note: ' + got.notes[n]);
  Logger.log(remaining.length ? 'NEXT: run reconBackfill() again for ' + remaining.join(', ')
                              : 'Backfill COMPLETE.');

  return { done: remaining.length === 0, venue: next.venue,
           days: got.days.length, tills: got.tills.length, remaining: remaining };
}

/** Clear the backfill cursor so reconBackfill() will run the venues again. */
function reconBackfillReset() {
  PropertiesService.getScriptProperties().deleteProperty(RECON.BACKFILL_PROP);
  Logger.log('Backfill cursor cleared.');
}


/* ------------------------------------------------------------- diagnostics */

/**
 * Read-only. Reports what each source sheet looks like from here - which tab matched,
 * which columns resolved, and which did not. Run this first whenever a venue stops
 * appearing, before changing anything.
 */
function reconHealthCheck() {
  for (var s = 0; s < RECON.SOURCES.length; s++) {
    var src = RECON.SOURCES[s];
    Logger.log('--- ' + src.venue);
    try {
      var ss = SpreadsheetApp.openById(src.id);
      var sheet = recFindResponseSheet_(ss, src);
      if (!sheet) { Logger.log('  NO MATCHING TAB'); continue; }
      var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
      var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
      var take = Math.min(lastRow - 1, 40);
      var rows = sheet.getRange(lastRow - take + 1, 1, take, lastCol).getDisplayValues();
      var map = recColMap_(header, rows, recNamesFor_(src));
      Logger.log('  tab "' + sheet.getName() + '"  rows=' + (lastRow - 1) + '  cols=' + lastCol);
      Logger.log('  last timestamp: ' + rows[rows.length - 1][map['Timestamp']]);
      var missing = [];
      for (var k in map) if (map[k] < 0) missing.push(k);
      Logger.log(missing.length ? '  UNRESOLVED: ' + missing.join(' | ') : '  all columns resolved');
    } catch (e) {
      Logger.log('  FAILED: ' + e.message);
    }
  }
}

/**
 * Read-only. Prints the float series for a venue so a target can be set from evidence
 * rather than memory. Pass a venue name exactly as it appears in RECON.SOURCES.
 */
function reconFloatHistory(venue, days) {
  var book = SpreadsheetApp.openById(RECON.SPREADSHEET_ID);
  var sheet = book.getSheetByName(RECON.SHEET_DAY);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('no Reconciliation rows yet'); return; }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, RECON.DAY_HEADER.length).getValues();
  var n = 0;
  for (var i = rows.length - 1; i >= 0 && n < (days || 30); i--) {
    if (venue && String(rows[i][1]) !== venue) continue;
    Logger.log(rows[i][0] + '  ' + rows[i][1] + '  float=' + rows[i][9] +
               '  cash_var=' + rows[i][6] + '  ' + rows[i][23]);
    n++;
  }
}
