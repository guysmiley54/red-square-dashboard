/**
 * Manual Purchase Entry - a small web app for logging ad-hoc purchases that never
 * arrive as an email (a chef's supermarket run, a cash purchase, a market stall).
 *
 * Replaces the old 2023-era manual tracking sheet with richer detail: it captures WHO
 * entered the purchase, and uses the venue names the rest of the system uses so this
 * spend lines up with the email-captured invoices.
 *
 * Writes to a "ManualPurchases" tab in BG Ops Data (created on first use):
 *   date | shop | venue | amount | entered_by | logged_at
 *
 * The Shop and Person dropdowns GROW: each page load reads the distinct values already
 * entered and offers them as options, with a "+ new" choice for anything not yet seen.
 * Venue is a fixed list of the three trading venues.
 *
 * SETUP (once):
 *   1. Paste this file into the BG Ops Data Apps Script project (or its own project
 *      bound to the same spreadsheet - see SPREADSHEET_ID below).
 *   2. Deploy > New deployment > type "Web app".
 *        Execute as: Me.   Who has access: Anyone with the link (or your Workspace).
 *   3. Open the web-app URL on a phone; add it to the home screen for one-tap access.
 */

var CFG = {
  // Leave "" if this script is bound to the BG Ops Data spreadsheet (the usual case).
  // Otherwise paste the spreadsheet ID from its URL.
  SPREADSHEET_ID: "",
  TAB: "ManualPurchases",
  // category is APPENDED, not inserted before entered_by: rows already logged would
  // otherwise have their entered_by / logged_at values shifted a column.
  HEADERS: ["date", "shop", "venue", "amount", "entered_by", "logged_at", "category"],
  // Fixed venue list - matches the names used in the Invoices tab so manual and
  // email-captured spend can be reported together.
  VENUES: ["Red Square Cambridge", "Red Square Glenorchy", "Luma Kitchen"],
  // Spend categories, matching the ones the invoice extractor uses. Picking one is
  // REQUIRED: the dashboard's COGS % counts Food/Beverage/Coffee/Packaging as cost of
  // goods and excludes the rest, so a wrong or missing category quietly skews the KPI.
  // "Other" is the escape hatch and is treated as non-COGS.
  CATEGORIES: ["Food", "Beverage", "Coffee", "Packaging", "Cleaning", "Equipment", "Repairs", "Other"]
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile("entry")
    .setTitle("Log a purchase")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, maximum-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Spreadsheet handle, whether the script is bound or standalone. */
function ss_() {
  return CFG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CFG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

/** The ManualPurchases sheet, created with headers if it doesn't exist yet. */
function sheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(CFG.TAB);
  if (!sh) {
    sh = ss.insertSheet(CFG.TAB);
    sh.appendRow(CFG.HEADERS);
    sh.getRange(1, 1, 1, CFG.HEADERS.length).setFontWeight("bold");
    sh.setFrozenRows(1);
  } else if (String(sh.getRange(1, 7).getValue()).trim() !== "category") {
    // Sheet created before categories existed - add the header. Existing rows keep their
    // columns and simply have no category (the dashboard falls back to Food for those).
    sh.getRange(1, 7).setValue("category").setFontWeight("bold");
  }
  return sh;
}

/** Options for the dropdowns: fixed venues, plus shops and people seen so far. */
function getOptions() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var shops = {}, people = {};
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, CFG.HEADERS.length).getValues();
    vals.forEach(function (r) {
      var shop = String(r[1] || "").trim();
      var who = String(r[4] || "").trim();
      if (shop) shops[shop] = true;
      if (who) people[who] = true;
    });
  }
  function sorted(o) { return Object.keys(o).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }); }
  return { venues: CFG.VENUES, categories: CFG.CATEGORIES, shops: sorted(shops), people: sorted(people) };
}

/**
 * Append one purchase. Returns {ok:true, ...} or {ok:false, error:"..."}.
 * Server-side validation is the real gate - the page validates too, for a faster
 * response, but never trust the client alone.
 */
function addPurchase(form) {
  try {
    form = form || {};
    var date = String(form.date || "").trim();          // yyyy-mm-dd from the date input
    var shop = String(form.shop || "").trim();
    var venue = String(form.venue || "").trim();
    var amountRaw = String(form.amount || "").trim().replace(/^\$/, "").replace(/,/g, "");
    var enteredBy = String(form.enteredBy || "").trim();
    var category = String(form.category || "").trim();

    if (!date) return { ok: false, error: "Pick a date." };
    if (!shop) return { ok: false, error: "Enter the shop." };
    if (CFG.VENUES.indexOf(venue) === -1) return { ok: false, error: "Pick a venue." };
    var amount = Number(amountRaw);
    if (!isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a dollar amount greater than 0." };
    if (CFG.CATEGORIES.indexOf(category) === -1) return { ok: false, error: "Pick a category." };
    if (!enteredBy) return { ok: false, error: "Enter who's logging this." };

    // Normalise the date to a real Date at local midnight so the sheet sorts/formats it.
    var parts = date.split("-");
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));

    sheet_().appendRow([d, shop, venue, Math.round(amount * 100) / 100, enteredBy, new Date(), category]);
    return { ok: true, shop: shop, venue: venue, amount: amount, enteredBy: enteredBy, category: category };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}
