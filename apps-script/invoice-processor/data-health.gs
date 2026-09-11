// =====================================================================
// DATA HEALTH — paste at the bottom of invoice-analytics.gs
// =====================================================================
//
// The swap guard fixes dates at write time. This is the layer that tells you
// about everything it COULDN'T fix, plus the failure mode that has actually
// bitten you before: a supplier quietly stopping sending.
//
// Two edits to weeklyDigest()/sendDigest_() are described at the bottom.

var HCONFIG = {
  STALE_DATE_DAYS: 14,   // invoice dated more than this before the email that carried it
  QUIET_MULTIPLE: 2.5,   // supplier silent for this many times their normal gap
  QUIET_MIN_DAYS: 10,    // never flag quiet before this many days, whatever the cadence
  QUIET_MIN_COUNT: 4     // needs this many invoices in 90d to have a "normal cadence"
};

function dataHealth_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var inv = ss.getSheetByName("Invoices");
  if (!inv || inv.getLastRow() < 2) return "";

  var data = inv.getRange(2, 1, inv.getLastRow() - 1, 15).getValues();
  var now = new Date();
  var d7 = daysAgo_(now, 7);
  var d90 = daysAgo_(now, 90);

  var checks = [];       // status CHECK in the last 7 days
  var staleDates = [];   // invoice_date implausibly far before the email
  var noDates = [];      // missing / unparseable date
  var bySupplier = {};   // supplier -> sorted invoice dates, last 90d

  data.forEach(function (r) {
    var scanned = r[0], supplier = r[2], invNo = String(r[3]).replace(/^'/, "");
    var idate = parseDate_(r[4]), status = r[11];
    if (!(scanned instanceof Date)) return;

    if (status === "CHECK" && scanned >= d7) {
      checks.push("• " + supplier + " " + invNo + " — " + fmt_(idate));
    }
    if (!idate) {
      if (scanned >= d7) noDates.push("• " + supplier + " " + invNo);
    } else {
      // Survived the swap guard but still sits well before its own email. Either a
      // misread the swap couldn't explain, or a genuinely late-sent invoice.
      var gap = (scanned.getTime() - idate.getTime()) / 864e5;
      if (scanned >= d7 && gap > HCONFIG.STALE_DATE_DAYS) {
        staleDates.push("• " + supplier + " " + invNo + " — dated " + fmt_(idate) +
          ", emailed " + fmt_(scanned) + " (" + Math.round(gap) + " days apart)");
      }
      if (idate >= d90) {
        var k = String(supplier || "").trim();
        if (k) (bySupplier[k] = bySupplier[k] || []).push(idate);
      }
    }
  });

  // Suppliers who have gone quiet relative to their own cadence.
  var quiet = [];
  Object.keys(bySupplier).forEach(function (s) {
    var ds = bySupplier[s].sort(function (a, b) { return a - b; });
    if (ds.length < HCONFIG.QUIET_MIN_COUNT) return;

    var gaps = [];
    for (var i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / 864e5);
    gaps.sort(function (a, b) { return a - b; });
    var typical = gaps[Math.floor(gaps.length / 2)];        // median gap
    var silent = (now.getTime() - ds[ds.length - 1].getTime()) / 864e5;

    if (silent > Math.max(HCONFIG.QUIET_MIN_DAYS, typical * HCONFIG.QUIET_MULTIPLE)) {
      quiet.push("• " + s + " — last invoice " + fmt_(ds[ds.length - 1]) + ", " +
        Math.round(silent) + " days ago (usually every ~" + Math.round(typical) + " days)");
    }
  });

  var out = [];
  if (quiet.length)      out.push("SUPPLIERS GONE QUIET\n" + quiet.join("\n"));
  if (staleDates.length) out.push("DATES STILL LOOK WRONG\n" + staleDates.join("\n"));
  if (noDates.length)    out.push("NO DATE CAPTURED\n" + noDates.join("\n"));
  if (checks.length)     out.push("FLAGGED CHECK THIS WEEK\n" + checks.join("\n"));

  return out.length ? out.join("\n\n") : "";
}

function fmt_(d) {
  return (d instanceof Date)
    ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd")
    : "no date";
}


// ---------------------------------------------------------------- wiring
//
// weeklyDigest() currently returns early when there are no price rises, so the
// health block would never send. Two changes:
//
// 1. In weeklyDigest(), where it decides whether to send, replace the early
//    return with:
//
//       var health = dataHealth_();
//       if (finalAlerts.length || health) sendDigest_(finalAlerts, now, health);
//
// 2. Change the sendDigest_ signature and body:
//
//       function sendDigest_(alerts, now, health) {
//         ...
//         var body = "";
//         if (alerts.length) {
//           body += "Price rises detected in the last " + ACONFIG.LOOKBACK_DAYS +
//                   " days:\n\n" + lines.join("\n") + "\n\n";
//         }
//         if (health) body += "── DATA HEALTH ──\n\n" + health + "\n\n";
//         body += "Full history is in the Products and PriceAlerts tabs.\n\n— Invoice Processor";
//
//         MailApp.sendEmail({
//           to: ACONFIG.DIGEST_EMAIL,
//           subject: alerts.length
//             ? "Price watch: " + alerts.length + " supplier price rise" +
//               (alerts.length > 1 ? "s" : "") + (health ? " + data issues" : "")
//             : "Invoice data: issues to check",
//           body: body
//         });
//       }
//
// A silent week means a clean week. No email is the all-clear.
