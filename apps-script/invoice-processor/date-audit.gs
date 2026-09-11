// =====================================================================
// DATE AUDIT v2 — report only, writes nothing
// =====================================================================
//
// v1 compared each row to its immediate neighbours. That failed when a whole
// batch flipped together — two adjacent wrong rows made each other look fine —
// and it never tested the first or last row in a series.
//
// v2 fits a trend line across the entire series instead. Invoice number against
// date is close to linear (Manna issues ~108 numbers a day), and the slope is
// taken as a MEDIAN, so a handful of wrong dates can't drag it. Every row is
// then measured against the line. Adjacent errors no longer hide each other,
// and boundary rows get checked like any other.
//
// Still writes NOTHING.

var AUDIT = {
  MIN_SERIES:  6,     // too few rows to fit a line — skip rather than guess
  TOLERANCE:   14,    // days a row may sit off the trend before it's suspicious
  FUTURE_DAYS: 21     // dated further ahead than this is wrong on its face
};

function auditDatesReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inv = ss.getSheetByName("Invoices");
  var rows = inv.getRange(2, 1, inv.getLastRow() - 1, 15).getValues();

  var horizon = new Date(Date.now() + AUDIT.FUTURE_DAYS * 864e5);
  var series = {}, future = [], flagged = [], skipped = [];

  rows.forEach(function (r, i) {
    var supplier = String(r[2] || "").trim().toUpperCase();
    var numRaw = String(r[3] || "").replace(/^'/, "").trim();
    var date = parseAuditDate_(r[4]);
    if (!supplier || !date) return;

    if (date > horizon) {
      future.push({ row: i + 2, supplier: r[2], num: numRaw, date: date, swap: swapOf_(date) });
    }
    if (!/^\d+$/.test(numRaw)) return;

    var key = supplier + "|" + numRaw.length;   // separates multiple number series
    (series[key] = series[key] || []).push({ row: i + 2, supplier: r[2], num: +numRaw, date: date });
  });

  Object.keys(series).forEach(function (k) {
    var list = series[k];
    if (list.length < AUDIT.MIN_SERIES) { skipped.push(k + " (" + list.length + " rows)"); return; }
    list.sort(function (a, b) { return a.num - b.num; });

    // Median slope in days per invoice number, from consecutive pairs. Wrong dates
    // produce wild individual slopes; the median ignores them.
    var slopes = [];
    for (var i = 1; i < list.length; i++) {
      var dn = list[i].num - list[i - 1].num;
      if (dn > 0) slopes.push((list[i].date - list[i - 1].date) / 864e5 / dn);
    }
    var slope = median_(slopes);
    if (!isFinite(slope)) return;

    // Median intercept, again robust to bad rows.
    var intercept = median_(list.map(function (x) {
      return x.date.getTime() / 864e5 - slope * x.num;
    }));

    list.forEach(function (x) {
      var predicted = (slope * x.num + intercept) * 864e5;
      var offBy = (x.date.getTime() - predicted) / 864e5;
      if (Math.abs(offBy) <= AUDIT.TOLERANCE) return;

      var sw = swapOf_(x.date);
      if (!sw) return;
      var swOffBy = (sw.getTime() - predicted) / 864e5;
      if (Math.abs(swOffBy) > AUDIT.TOLERANCE) return;      // swap is no better

      flagged.push({
        row: x.row, supplier: x.supplier, num: x.num,
        date: x.date, swap: sw,
        off: Math.round(offBy), expected: new Date(predicted)
      });
    });
  });

  flagged.sort(function (a, b) { return a.row - b.row; });

  Logger.log("=== DATED IN THE FUTURE ===");
  future.forEach(function (f) {
    Logger.log("row " + f.row + "  " + f.supplier + "  " + f.num + "  " +
      fmtA_(f.date) + "  -> probably " + (f.swap ? fmtA_(f.swap) : "?"));
  });
  if (!future.length) Logger.log("none");

  Logger.log("");
  Logger.log("=== OFF THE TREND FOR THEIR SUPPLIER ===");
  flagged.forEach(function (o) {
    Logger.log("row " + o.row + "  " + o.supplier + "  " + o.num + "  " +
      fmtA_(o.date) + "  -> probably " + fmtA_(o.swap));
    Logger.log("        sequence suggests around " + fmtA_(o.expected) +
      "  (currently " + o.off + " days out)");
  });
  if (!flagged.length) Logger.log("none");

  if (skipped.length) {
    Logger.log("");
    Logger.log("Series too small to check: " + skipped.join(", "));
  }
  Logger.log("");
  Logger.log("--- " + future.length + " future, " + flagged.length +
    " off trend. Nothing was changed. ---");
}

function median_(a) {
  if (!a.length) return NaN;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseAuditDate_(v) {
  if (v instanceof Date) return v;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function swapOf_(d) {
  var mo = d.getMonth() + 1, day = d.getDate();
  if (day > 12 || mo > 12 || day === mo) return null;
  return new Date(d.getFullYear(), day - 1, mo);
}

function fmtA_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}
