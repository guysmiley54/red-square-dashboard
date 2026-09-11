/**
 * OVERHEADS.GS — non-COGS supplier routing and the Supagas multi-site extractor
 *
 * Invoice Processor project (bound to BG Ops Data), alongside Code.gs. Every global here
 * starts with oh / OH_ : Apps Script shares one global scope across files and a clash
 * does not error, it silently overrides by load order.
 *
 * WHAT IT DOES
 *   1. Recognises the overhead suppliers (energy, waste, rent, repairs) by sender,
 *      subject or extracted supplier name - OH_PROFILES below.
 *   2. For those suppliers only, admits invoice/statement hybrids that the base prompt
 *      throws away as "statements". COGS suppliers are untouched: their statements are
 *      still skipped by Code.gs and captured by Statements.gs into the Statements tab.
 *   3. Stamps the category (Energy / Waste / Rent / Repairs) deterministically instead of
 *      trusting the model's category_guess. The supplier explorer's NON_COGS list already
 *      contains all four, so these rows fall out of COGS % and into overheads.
 *   4. Splits multi-site bills into one Invoices row per site, venue taken from the
 *      supplier's own site ID. Address matching cannot do this: Cambridge and Luma share a
 *      building on Kennedy Drive, detectVenue_ reads both as Cambridge, and each supplier
 *      numbers the units differently - see OH_RENT_UNIT_RULES.
 *   5. For a profile with 'usage' (Supagas today), writes one EnergyUsage row per site per
 *      bill: litres, price per litre, surcharge, equipment and service charges, total.
 *      Shaped so electricity (kWh) can use the same tab later without a schema change.
 *   6. For statement-only suppliers (Peter Brown), turns each charge line on the statement
 *      into an Invoices row, deduped against invoices already held.
 *
 * ENTRY POINTS (editor dropdown)
 *   ohSetup()                    once: creates the EnergyUsage tab
 *   ohAudit()                    writes only its own OverheadAudit tab. Lists every overhead
 *                                email that was skipped, failed or never seen, every COGS
 *                                statement that stays skipped, and every overhead row
 *                                already in Invoices with the category it would get.
 *   ohReprocessLatestSupagas()   re-reads ONLY the newest Supagas statement. Run this first
 *                                and check the rows before running ohReprocess.
 *   ohReprocess()                re-reads the audit's requeue list by message id, 8 per
 *                                run. Run again until it reports 0 remaining.
 *   ohRecategorise()             sets the category column on existing overhead rows.
 *
 * Needs Code.gs edits (all in the committed Code.gs): extractFromContent_ takes an extra
 * prompt, processAttachments_ routes profiled mail here, writeInvoice_ honours
 * venue_override / category_override / force_check.
 */

var OH = {
  VERSION: "overheads-111930",
  USAGE_SHEET: "EnergyUsage",
  AUDIT_SHEET: "OverheadAudit",
  REPROCESS_TAG: "overhead reprocess",
  MAX_REPROCESS_PER_RUN: 8,
  MAX_RUN_MS: 270000,          // stop starting new messages after 4.5 min of the 6
  COL: { SUPPLIER: 3, NUMBER: 4, DATE: 5, TOTAL: 9, CATEGORY: 10, TYPE: 11, STATUS: 12 },
  USAGE_HEADER: ["period", "period_end", "supplier", "account", "doc_number", "doc_type",
                 "venue", "site_id", "commodity", "unit", "quantity", "unit_price_ex",
                 "energy_ex", "surcharge_ex", "equipment_ex", "service_ex", "other_ex",
                 "subtotal_ex", "gst", "total_inc", "deliveries", "status", "notes",
                 "message_id", "captured"]
};

/* ---------------------------------------------------------------- profiles
 *
 * senders:    substrings of the From address (a bare domain covers every address under it)
 * subjectRe:  for suppliers who send through a shared platform (Xero) where the sender
 *             says nothing about who the bill is from
 * supplierRe: matched against the model's supplier name, and against column C of
 *             Invoices when auditing existing rows
 * skipRe:     subject or filename of mail from this supplier that is NOT a bill (letters,
 *             notices, delivery dockets). Checked before any API call.
 * supplier:   canonical name written to the sheet, so dedupe keys and the explorer's
 *             grouping stay stable whatever the model reads off the letterhead. These match
 *             the norm() keys payables.html already uses for these suppliers.
 * sites:      supplier site/location ID -> venue
 * auditQuery: Gmail search the audit uses to find mail from this supplier that the
 *             processor never logged. Narrow on purpose (shared Gmail quota).
 *
 * Verified from Gmail on 11 Sep 2026: every sender and subject pattern below was read off
 * a real message. What has NOT been seen is the inside of most of these documents - only
 * the Supagas statement has been read line by line.
 */
/* Unit numbers are PER SUPPLIER, never global. The landlord and the gas company number the
   same building differently, and the address that looks most authoritative - "LUMA, 21/66
   KENNEDY DRIVE" on every Supagas document - is the ACCOUNT'S MAILING ADDRESS, not a site.
   The account was opened for Luma's beer gas and kept that name and address when the LPG
   tanks were added, so it prints on Red Square Cambridge's deliveries too: both tanks are
   filled on the same trip, minutes apart, and both dockets carry the Luma line. Reading it
   as a site is how Cambridge's gas ends up on Luma.
   So a profile carries its own 'unitRules' only if its documents number units reliably.
   Supagas carries none - its sites are identified by Loc.ID and nothing else.
   In the LANDLORD's numbering (Adrian, 12 Sep 2026): Luma is Unit 22, and Red Square
   Cambridge has no unit number at all. */
var OH_RENT_UNIT_RULES = [
  { re: /\b(?:unit|shop|tenancy)\s*22\b|\b22\s*\/\s*66\b/i, venue: "Luma Kitchen" }
];

var OH_PROFILES = [
  {
    id: "supagas", supplier: "Supagas Pty Limited", category: "Energy",
    // The whole domain, so pod@ and the marketing address are recognised too - and then
    // skipped by skipRe before any API call. pod@ dockets carry litres that reappear,
    // priced, on the month-end statement; booking both would double count.
    senders: ["supagas.com.au"],
    supplierRe: /supagas/i,
    skipRe: /proof\s+of\s+delivery|\bpod\b|portal|website|scheduled\s+maintenance/i,
    model: "claude-sonnet-4-6",
    split: true,
    // Corrected 12 Sep 2026 (Adrian): Cambridge is the bigger gas user, so the larger site
    // is Cambridge and the smaller is Luma. The earlier mapping came from the unit numbers
    // printed beside each site, which are the gas company's own and do not agree with the
    // landlord's. Volume is the check that settles it - Aug 2026, 1,628 L against 827 L.
    sites: {
      "372577": "Red Square Glenorchy",    // 2 Howard Road, Glenorchy
      "934631S": "Red Square Cambridge",   // ~1,628 L/month
      "705228": "Luma Kitchen"             // ~827 L/month
    },
    account: "C618063",
    // No unitRules on purpose - see OH_RENT_UNIT_RULES above. The check that settles which
    // site is which is LITRES, not any address or unit number on the document.
    // The email body prints the statement reference; the subject prints its date. Both are
    // more reliable than the model and make the dedupe key identical on every re-read.
    refFromBody: /INVOICE\s+REFERENCE\s*:?\s*(C\d{5,}-\d{1,2}-\d{4})/i,
    dateFromSubject: /statement\s*-\s*(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})/i,
    usage: { commodity: "LPG", unit: "L" },
    prompt: "supagas",
    auditQuery: "from:ar@supagas.com.au has:attachment after:2025/12/31"
  },
  {
    id: "shell", supplier: "Shell Energy Retail Pty Ltd", category: "Energy",
    senders: ["shellenergy.com.au"],
    supplierRe: /shell\s+energy/i,
    // One bill per account, BGFI01_001 / _002 / _003, printed in the subject and the PDF
    // filename - one per site. Fill a mapping in and every Shell bill lands on its site;
    // until then venue comes from the supply address, and a bill with no venue on it lands
    // as CHECK rather than defaulting silently.
    siteFromText: /\b(BGFI01_\d{3})/i,
    sites: {
      // _001 (NMI 8590213746) and _002 (NMI 8590213738) both print "66 Kennedy Dr,
      // CAMBRIDGE" with no unit number - one is Red Square Cambridge, one is Luma, and
      // the bill cannot say which. Fill these two in once confirmed.
      // "BGFI01_001": "",
      // "BGFI01_002": "",
      "BGFI01_003": "Red Square Glenorchy"   // PDF filename is BGFI01_003_HowardRd_...
    },
    auditQuery: "from:shellenergy.com.au has:attachment newer_than:150d"
  },
  {
    id: "veolia", supplier: "Veolia Environmental Services (Australia) Pty Ltd", category: "Waste",
    senders: ["veolia.com.au", "veolia.com"],
    supplierRe: /veolia/i,
    // "Statement 31/08/2026 Account: ..." emails are a link to a portal, no document.
    skipRe: /statement\s+is\s+now\s+available|:\s*statement\s+\d/i,
    auditQuery: "from:(veolia.com.au OR veolia.com) has:attachment newer_than:150d"
  },
  {
    id: "elders", supplier: "Elders Real Estate", category: "Rent",
    senders: ["eldersrealestate.com.au", "elders.com.au"],
    supplierRe: /elders/i,
    // Abbie at Elders also sends centre notices with attachments.
    skipRe: /rent\s+review|renovation|shutdown|fencing|ceiling|storage|bathroom/i,
    // One lease reference (BG-FIP01) covers both tenancies in the building. The unit number
    // on the invoice separates them: Unit 22 is Luma, and Red Square Cambridge carries no
    // unit number at all.
    unitRules: OH_RENT_UNIT_RULES,
    auditQuery: "from:(eldersrealestate.com.au OR elders.com.au) subject:invoice has:attachment newer_than:150d"
  },
  {
    id: "spg", supplier: "SPG Hobart Pty Ltd", category: "Rent",
    // Glenorchy's landlord bills through its managing agent, Richard O'Brien / Spotlight
    // Property, to adrian@ - which is why "SPG never emails accounts@" was true but
    // "SPG never emails" was not.
    senders: ["richardobrien.com.au", "spotlightproperty.com.au"],
    supplierRe: /\bSPG\b|spotlight\s+property|richard\s+o'?brien/i,
    skipRe: /arrears|reminder|water|shutdown|food\s+van/i,
    // SPG is Glenorchy's landlord and nothing else - the other two tenancies are Elders',
    // in a different centre. Pinned, so no address or unit number on one of their letters
    // can ever push a Glenorchy rent charge onto Cambridge or Luma.
    fixedVenue: "Red Square Glenorchy",
    auditQuery: "from:(richardobrien.com.au OR spotlightproperty.com.au) subject:invoice has:attachment newer_than:150d"
  },
  {
    id: "scooters", supplier: "Scooter's Electrical Services Pty Ltd", category: "Repairs",
    senders: ["scootz.cresswell@gmail.com"],
    supplierRe: /scooter/i,
    auditQuery: "from:scootz.cresswell@gmail.com has:attachment newer_than:150d"
  },
  {
    id: "abrefrigeration", supplier: "AB Refrigeration Pty Ltd", category: "Repairs",
    senders: [],                         // sends through Xero's shared address
    subjectRe: /AB\s+Refri(d)?geration/i,
    supplierRe: /AB\s+Refri(d)?geration/i,
    // Xero "Bill INV-1206 ... is due" reminders re-send invoices already held.
    skipRe: /\bis\s+due\b|reminder|overdue/i,
    auditQuery: "subject:\"AB Refrigeration\" has:attachment newer_than:150d"
  },
  {
    id: "obrien", supplier: "O'Brien Electrical Moonah", category: "Repairs",
    senders: ["electrical.obrien.com.au"],
    supplierRe: /o'?brien\s+electrical/i,
    auditQuery: "from:electrical.obrien.com.au has:attachment newer_than:150d"
  },
  {
    id: "peterbrown", supplier: "Peter Brown (TAS) Pty Ltd", category: "Repairs",
    senders: [],                         // Xero again
    subjectRe: /Peter\s+Brown/i,
    supplierRe: /peter\s+brown/i,
    // Sends statements only, never invoices. Each charge line on the statement becomes
    // an Invoices row - see ohStatementLines_.
    statementLines: true,
    auditQuery: "subject:\"Peter Brown\" has:attachment newer_than:150d"
  }
];


/* ---------------------------------------------------------------- prompts */

/* Appended to EXTRACT_PROMPT for overhead suppliers only. Carried over from the 10 Sep
   MultiSite.gs work, which was built and tested but never deployed. */
var OH_HYBRID_RULES = [
  "",
  "ADDITIONAL RULES - THIS DOCUMENT IS FROM AN OVERHEAD SUPPLIER (utility, gas, energy, waste, landlord or repairs).",
  "",
  'A document titled "TAX INVOICE / STATEMENT", "INVOICE STATEMENT", "Tenant Tax Invoice", "Tenant Invoice", "Direct Charge Invoice", "Lease Invoice" or similar IS an invoice - extract it. These bill a period of service and often also show an opening or brought-forward balance and payments received. Do not reject them as statements.',
  "",
  'Report ONLY the CURRENT PERIOD charges. Never report the account balance, "Total Balance Due", "Total Amount Owing" or any figure that includes a brought-forward balance - that amount is last period\'s bill, already recorded, and including it double counts it. Never include "Balance Brought Forward" or "Payments Received" lines as items.',
  "",
  'MULTI-SITE BILLS: if the document bills more than one site, location or premises on the one account, add a "locations" array: one entry per site, each with its own charges:',
  '"locations":[{"location_id":"string as printed","location_name":"site name and/or address as printed","subtotal":number,"gst":number,"total":number,"items":[["description",qty,"unit",unit_price,line_total,"item_code or null",0]]}]',
  'location_id is the supplier\'s own site reference - "Location ID", "Site ID", "Premises", "NMI", "Meter", "Account/Site" or similar. Copy it EXACTLY, including any trailing letter. Put each site\'s lines in that site\'s items and leave the top-level "items" empty when you use "locations". The site totals must add up to the document\'s current-period total.',
  "If it bills only one site but prints a site ID, you may still give a single-entry locations array.",
  "",
  'A tenant invoice or utility bill often ends with a detachable REMITTANCE SLIP or "payment advice" tear-off for you to return with payment. That slip does NOT make the document a remittance advice - if the document charges rent, outgoings, energy, waste or service for a period, it is an invoice. An electricity, gas or water bill is an invoice even though the supplier is a utility.',
  "",
  'A notice, letter, reminder, rent review, or a pure statement that only lists other invoice numbers with amounts and has NO current-period charges of its own is not an invoice: respond with {"not_invoice":true,"reason":"statement"} or a brief reason.'
].join("\n");

/* Supplier-specific layout notes. Written from the 31 Aug 2026 Supagas statement. */
var OH_SUPAGAS_RULES = [
  "",
  "SUPAGAS INVOICE STATEMENT - LAYOUT NOTES",
  'This is a Supagas "INVOICE STATEMENT" for account C618063. It is a bill: doc_type "invoice" (or "credit_note" for a CREDIT NOTE).',
  "It covers several delivery LOCATIONS. Each location is headed by a Location ID (for example 372577, 705228, 934631S) and a site address. Give one locations entry per Location ID, even if a location has only one line.",
  "In each location's items include EVERY charge line printed under it:",
  '  - every "LP GAS BULK" delivery: qty = litres delivered, unit "L", unit_price = price per litre as printed, line_total = the line amount EX GST, item_code = the delivery docket number printed on that line (e.g. 1130024D3)',
  '  - every surcharge line, e.g. "Temporary Product Surcharge", with its docket number as item_code',
  "  - any tank or equipment rental, facility fee, service fee, delivery fee, credit or adjustment line",
  "Do not drop a line because it is small, and do not merge lines.",
  "Each location's subtotal = its lines ex GST; gst and total = that location's GST and GST-inclusive total.",
  "invoice_number = the Invoice Reference (e.g. C618063-8-2026). invoice_date = the statement date.",
  "Ignore the account summary block entirely: balance brought forward, payments and total balance due are not charges."
].join("\n");

function ohPromptFor_(prof) {
  if (!prof) return "";
  return OH_HYBRID_RULES + (prof.prompt === "supagas" ? "\n" + OH_SUPAGAS_RULES : "");
}

/* ---------------------------------------------------------------- matching */

function ohProfileForMessage_(from, subject) {
  var f = String(from || "").toLowerCase(), s = String(subject || "");
  for (var i = 0; i < OH_PROFILES.length; i++) {
    var p = OH_PROFILES[i];
    for (var k = 0; k < (p.senders || []).length; k++) {
      if (f.indexOf(String(p.senders[k]).toLowerCase()) !== -1) return p;
    }
    if (p.subjectRe && p.subjectRe.test(s)) return p;
  }
  return null;
}

function ohProfileForSupplier_(name) {
  var n = String(name || "");
  if (!n) return null;
  for (var i = 0; i < OH_PROFILES.length; i++) {
    if (OH_PROFILES[i].supplierRe && OH_PROFILES[i].supplierRe.test(n)) return OH_PROFILES[i];
  }
  return null;
}

/* True if this subject or filename is a notice from an overhead supplier rather than a
   bill. Costs nothing and runs before the API call. */
function ohSkipMessage_(prof, subject, fileName) {
  if (!prof || !prof.skipRe) return false;
  return prof.skipRe.test(String(subject || "")) || prof.skipRe.test(String(fileName || ""));
}

/* ---------------------------------------------------------------- venues */

function ohSiteVenue_(prof, siteId) {
  var sites = (prof && prof.sites) || {};
  var k = String(siteId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!k) return null;
  for (var key in sites) {
    var want = String(key).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!want) continue;
    if (want === k) return sites[key];
    // A model that copies the label with the id ("Location ID: 934631S") still matches,
    // but only across a non-digit boundary, so site 372577 never matches 1372577.
    if (k.length > want.length && k.slice(-want.length) === want &&
        !/[0-9]/.test(k.charAt(k.length - want.length - 1))) return sites[key];
  }
  return null;
}

/* Site ID first, then the profile's OWN unit rules, then the ordinary address match. Says
   which one it used, so a bill that fell all the way through can be flagged CHECK rather
   than quietly landing on the default venue.
   With no site id and no unit rule, a Kennedy Drive address resolves to Red Square
   Cambridge via CONFIG.VENUES - right under the landlord's numbering, where Cambridge is
   the tenancy with no unit number. */
function ohVenue_(prof, siteId, texts) {
  if (prof && prof.fixedVenue) return { venue: prof.fixedVenue, how: "fixed" };
  var v = ohSiteVenue_(prof, siteId);
  if (v) return { venue: v, how: "site-id" };
  var hay = (texts || []).filter(function (t) { return t; }).join(" | ");
  var rules = (prof && prof.unitRules) || [];
  if (/kennedy/i.test(hay)) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].re.test(hay)) return { venue: rules[i].venue, how: "unit" };
    }
  }
  var low = hay.toLowerCase();
  var venues = (typeof CONFIG !== "undefined" && CONFIG.VENUES) || {};
  for (var key in venues) {
    if (low.indexOf(key) !== -1) return { venue: venues[key], how: "address" };
  }
  var def = (typeof CONFIG !== "undefined" && CONFIG.DEFAULT_VENUE) || "Red Square Glenorchy";
  return { venue: def, how: "default" };
}

/* ---------------------------------------------------------------- the writer */

/**
 * Writes one extracted overhead document. Called from processAttachments_ in place of the
 * plain dedupe + writeInvoice_ pair.
 *
 * ctx: { from, subject, body, emailDate, fileName, msgId, route, savePdf }  savePdf is a
 * function, called only once something is actually written, so a duplicate re-read does
 * not leave a second copy in Drive.
 *
 * Returns { written, dups, superseded, usage, note }.
 */
function ohWriteInvoice_(sheets, j, prof, existing, ctx) {
  var notes = [];
  var isCredit = j.doc_type === "credit_note";
  j.supplier = prof.supplier;
  j.category_override = prof.category;

  // Deterministic reference and date for suppliers whose email carries them.
  if (!isCredit && prof.refFromBody) {
    var ref = ohRefFromBody_(prof, ctx.body);
    if (ref && ref !== String(j.invoice_number || "")) {
      if (j.invoice_number) notes.push("reference " + ref + " from email (model read " + j.invoice_number + ")");
      j.invoice_number = ref;
    }
  }
  if (!isCredit && prof.dateFromSubject) {
    var sd = ohDateFromSubject_(prof, ctx.subject);
    if (sd && sd !== j.invoice_date) {
      if (j.invoice_date) notes.push("date " + sd + " from subject (model read " + j.invoice_date + ")");
      j.invoice_date = sd;
    }
  }

  var parts = ohParts_(j, prof, ctx, notes);

  // The site totals must add to the document. If they don't, a site or a line was lost
  // or misread - every row is flagged rather than trusting any of them.
  if (parts.length > 1) {
    var sum = parts.reduce(function (a, p) { return a + (Number(p.total) || 0); }, 0);
    var docTotal = Number(j.total) || 0;
    if (docTotal && Math.abs(sum - docTotal) > 0.06) {
      parts.forEach(function (p) { p.force_check = true; });
      notes.push("sites add to " + sum.toFixed(2) + " but the document says " + docTotal.toFixed(2));
    }
  }

  // An earlier run may have booked this bill whole, on one venue. Retire that row before
  // writing the split, or the gas is counted twice.
  var superseded = 0;
  if (parts.length > 1) superseded = ohSupersedeParent_(sheets.inv, prof, j, parts);
  if (superseded) notes.push("superseded " + superseded + " earlier unsplit row" + (superseded > 1 ? "s" : ""));

  var written = 0, dups = 0, pdfUrl = null;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (typeof isDupInvoice_ === "function" && isDupInvoice_(existing, p)) { dups++; continue; }
    if (typeof markInvoice_ === "function") markInvoice_(existing, p);
    if (pdfUrl === null) pdfUrl = ctx.savePdf ? (ctx.savePdf() || "") : "";
    writeInvoice_(sheets, p, ctx.from, ctx.fileName, pdfUrl, ctx.emailDate, ctx.route);
    written++;
  }

  var usage = 0;
  if (prof.usage) {
    try { usage = ohWriteUsage_(prof, j, parts, ctx, notes); }
    catch (e) { notes.push("usage not written: " + (e && e.message ? e.message : e)); }
  }

  var head = written
    ? "added " + j.invoice_number + (parts.length > 1 ? " split " + parts.map(function (p) {
        return ohShortVenue_(p.venue_override) + " " + (Number(p.total) || 0).toFixed(2);
      }).join(" / ") : "") + " [" + prof.category + "]"
    : "duplicate " + j.invoice_number + ", skipped";
  if (dups && written) head += " (" + dups + " site" + (dups > 1 ? "s" : "") + " already held)";
  if (usage) head += "; usage " + usage + " row" + (usage > 1 ? "s" : "");
  return { written: written, dups: dups, superseded: superseded, usage: usage,
           note: head + (notes.length ? "; " + notes.join("; ") : "") };
}

/* One invoice object per site, or the whole document as one part. */
function ohParts_(j, prof, ctx, notes) {
  var texts = [ctx.subject];
  var locs = Array.isArray(j.locations) ? j.locations.filter(function (L) {
    return L && isFinite(Number(L.total)) && Number(L.total) !== 0;
  }) : [];

  if (!prof.split || !locs.length) {
    var sid = locs.length === 1 ? locs[0].location_id : "";
    if (!sid && prof.siteFromText) {
      var sm = prof.siteFromText.exec(String(ctx.subject || "") + " " + String(ctx.fileName || ""));
      if (sm) sid = sm[1].toUpperCase();
    }
    var v = ohVenue_(prof, sid,
      [locs.length === 1 ? locs[0].location_name : "", j.deliver_to].concat(texts));
    var one = ohClone_(j);
    one.venue_override = v.venue;
    one._site_id = String(sid || "");
    if (locs.length === 1 && (!one.items || !one.items.length)) one.items = locs[0].items || [];
    if (v.how === "default") { one.force_check = true; notes.push("venue not found on the bill, defaulted to " + v.venue); }
    delete one.locations;
    return [one];
  }

  var parentNo = String(j.invoice_number || "").trim();
  var seen = {}, out = [];
  for (var i = 0; i < locs.length; i++) {
    var L = locs[i];
    var id = String(L.location_id || "").trim();
    var suffix = id || ("site" + (i + 1));
    if (seen[suffix]) continue;
    seen[suffix] = true;
    var vv = ohVenue_(prof, id, [L.location_name].concat(texts));
    if (vv.how === "default") notes.push("site " + suffix + " not mapped to a venue, defaulted");
    var total = Number(L.total);
    out.push({
      doc_type: j.doc_type, supplier: j.supplier,
      // Only suffixed when there is more than one site, so a single-site bill keeps the
      // number that is printed on it.
      invoice_number: locs.length > 1 && parentNo ? parentNo + "-" + suffix : parentNo,
      invoice_date: j.invoice_date,
      subtotal: ohNumOr_(L.subtotal, total - (Number(L.gst) || 0)),
      gst: Number(L.gst) || 0, total: total, freight: 0, cdl: 0,
      category_guess: j.category_guess, category_override: j.category_override,
      deliver_to: L.location_name || j.deliver_to || "",
      venue_override: vv.venue, force_check: vv.how === "default",
      order_ref: null, items: L.items || [],
      _site_id: id
    });
  }
  return out;
}

/* Retire rows for the same bill written before the split existed: same supplier and
   either the parent number, or the same date and document total under a number that is
   not one of our suffixed children. Sets type "superseded" - the convention order-dedupe
   already uses, and which both dashboards drop at load. Nothing is deleted. */
function ohSupersedeParent_(inv, prof, j, parts) {
  var last = inv.getLastRow();
  if (last < 2) return 0;
  var C = OH.COL;
  var vals = inv.getRange(2, 1, last - 1, C.TYPE).getValues();
  var parentKey = ohNorm_(j.invoice_number);
  var children = {};
  parts.forEach(function (p) { children[ohNorm_(p.invoice_number)] = true; });
  var docTotal = Math.round((Number(j.total) || 0) * 100);
  var n = 0;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[C.TYPE - 1]) === "superseded") continue;
    if (!prof.supplierRe.test(String(r[C.SUPPLIER - 1] || ""))) continue;
    var num = ohNorm_(String(r[C.NUMBER - 1] || "").replace(/^'/, ""));
    if (children[num]) continue;
    var sameNumber = parentKey && num === parentKey;
    var sameBill = docTotal && Math.round((Number(r[C.TOTAL - 1]) || 0) * 100) === docTotal &&
                   ohIsoOf_(r[C.DATE - 1]) === String(j.invoice_date || "");
    if (!sameNumber && !sameBill) continue;
    inv.getRange(i + 2, C.TYPE).setValue("superseded");
    n++;
  }
  return n;
}

/* ---------------------------------------------------------------- statement-only suppliers */

/**
 * For a supplier that only ever sends statements (Peter Brown). Reads the statement with
 * Statements.gs's own extractor, then writes every invoice or credit line that is not
 * already in Invoices as its own row. Payments and brought-forward lines are ignored.
 *
 * These rows always land as CHECK: the amount is off the statement, the GST is derived
 * (amount / 11) and there are no line items behind it. They count in spend and show
 * with the check pill until someone has looked.
 *
 * Gap worth knowing: these statements list OPEN items only. An invoice raised and paid
 * inside one statement cycle never appears on any statement, so it never arrives here.
 * The real fix is Peter Brown emailing invoices to accounts@.
 */
function ohStatementLines_(apiKey, sheets, existing, msg, att, prof, ctx) {
  if (typeof stmtExtract_ !== "function" || typeof stmtNormalise_ !== "function") {
    throw new Error("Statements.gs is not in this project - it is needed to read " + prof.supplier + " statements");
  }
  var j = stmtExtract_(apiKey, att, msg);
  if (!j || j.not_statement) return { written: 0, note: "not a statement (" + ((j && j.reason) || "?") + ")" };
  var scratch = [];
  var st = stmtNormalise_(j, msg, scratch);
  var v = ohVenue_(prof, "", [ctx.subject, st.account]);
  var written = 0, dups = 0, pdfUrl = null;
  st.lines.forEach(function (L) {
    if (L.kind !== "invoice" && L.kind !== "credit") return;
    if (!L.reference || !L.amount) return;
    var amt = Math.abs(Number(L.amount) || 0);
    var gst = Math.round(amt / 11 * 100) / 100;
    var inv = {
      doc_type: L.kind === "credit" ? "credit_note" : "invoice",
      supplier: prof.supplier, invoice_number: L.reference,
      invoice_date: L.line_date || st.statement_date,
      subtotal: Math.round((amt - gst) * 100) / 100, gst: gst, total: amt,
      freight: 0, cdl: 0, category_override: prof.category,
      venue_override: v.venue, force_check: true, order_ref: null, items: []
    };
    if (typeof isDupInvoice_ === "function" && isDupInvoice_(existing, inv)) { dups++; return; }
    if (typeof markInvoice_ === "function") markInvoice_(existing, inv);
    if (pdfUrl === null) pdfUrl = ctx.savePdf ? (ctx.savePdf() || "") : "";
    writeInvoice_(sheets, inv, ctx.from, ctx.fileName + " (statement line)", pdfUrl, ctx.emailDate, ctx.route);
    written++;
  });
  return { written: written, dups: dups,
           note: "statement " + st.statement_date + ": " + written + " line" + (written === 1 ? "" : "s") +
                 " added as " + prof.category + " (" + v.venue + ")" + (dups ? ", " + dups + " already held" : "") };
}

/* ---------------------------------------------------------------- usage (EnergyUsage tab) */

/* Line types for the usage columns. Order matters: "Facility Fee" is equipment, not a
   fee; "LPG Delivery Fee" is service, not gas. Anything unrecognised goes to other_ex and
   the row is flagged, so a new kind of charge shows up instead of vanishing. */
function ohLineKind_(desc) {
  var d = String(desc || "");
  if (/surcharge|levy|carbon/i.test(d)) return "surcharge";
  // Work done on the equipment is service, even though it names the tank.
  if (/inspect|maintenance|repair|call[\s-]?out|install|relocat/i.test(d)) return "service";
  if (/rent(al)?\b|facility|equipment|tank|cylinder|vessel|hire|lease/i.test(d)) return "equipment";
  if (/fee|service|delivery|freight|admin|account\s+keeping|late\s+payment/i.test(d)) return "service";
  if (/\bLP\s*GAS\b|\bLPG\b|propane|autogas|bulk\s+gas/i.test(d)) return "energy";
  return "other";
}

function ohItem_(li) {
  return Array.isArray(li)
    ? { d: li[0] || "", q: Number(li[1]) || 0, u: li[2] || "", p: Number(li[3]) || 0, t: Number(li[4]) || 0, c: li[5] || "" }
    : { d: li.description || "", q: Number(li.qty) || 0, u: li.unit || "", p: Number(li.unit_price) || 0, t: Number(li.line_total) || 0, c: li.item_code || "" };
}

/* Pure: one usage row per part. Exported for tests. */
function ohUsageRows_(prof, j, parts, ctx) {
  var sign = j.doc_type === "credit_note" ? -1 : 1;
  var period = String(j.invoice_date || "").slice(0, 7);
  return parts.map(function (p) {
    var sums = { energy: 0, surcharge: 0, equipment: 0, service: 0, other: 0 };
    var qty = 0, dockets = {}, rowNotes = [], status = "OK";
    (p.items || []).map(ohItem_).forEach(function (it) {
      var k = ohLineKind_(it.d);
      sums[k] += it.t;
      if (k === "energy") {
        qty += it.q;
        if (it.c) dockets[it.c] = true;
        // Litres x price should give the line. If it doesn't, the litres or the price was
        // misread, and $/L - the number this tab exists for - would be wrong.
        var calc = it.q * it.p;
        if (it.q && it.p && Math.abs(calc - it.t) > Math.max(0.05, Math.abs(it.t) * 0.01)) {
          status = "CHECK"; rowNotes.push(it.c + " " + it.q + " x " + it.p + " = " + calc.toFixed(2) + " not " + it.t.toFixed(2));
        }
      }
      if (k === "other") { status = "CHECK"; rowNotes.push("unclassified line: " + it.d); }
    });
    var lineSum = sums.energy + sums.surcharge + sums.equipment + sums.service + sums.other;
    var sub = Number(p.subtotal) || 0;
    if (!(p.items || []).length) { status = "CHECK"; rowNotes.push("no line items"); }
    else if (Math.abs(lineSum - sub) > 0.06) { status = "CHECK"; rowNotes.push("lines " + lineSum.toFixed(2) + " vs site subtotal " + sub.toFixed(2)); }
    if (qty === 0 && sums.energy === 0 && (p.items || []).length) rowNotes.push("no gas delivered this period");
    if (p.force_check) status = "CHECK";
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    return {
      period: period, period_end: j.invoice_date || "", supplier: prof.supplier,
      account: prof.account || "", doc_number: p.invoice_number || "", doc_type: j.doc_type || "invoice",
      venue: p.venue_override || "", site_id: p._site_id || "",
      commodity: prof.usage.commodity, unit: prof.usage.unit,
      quantity: sign * Math.round(qty * 10) / 10,
      unit_price_ex: qty ? Math.round(sums.energy / qty * 10000) / 10000 : "",
      energy_ex: sign * r2(sums.energy), surcharge_ex: sign * r2(sums.surcharge),
      equipment_ex: sign * r2(sums.equipment), service_ex: sign * r2(sums.service), other_ex: sign * r2(sums.other),
      subtotal_ex: sign * r2(sub), gst: sign * r2(Number(p.gst) || 0), total_inc: sign * r2(Number(p.total) || 0),
      deliveries: Object.keys(dockets).length, status: status, notes: rowNotes.join("; "),
      message_id: ctx.msgId || "", captured: new Date().toISOString()
    };
  });
}

function ohWriteUsage_(prof, j, parts, ctx, notes) {
  var sh = ohUsageSheet_();
  var have = {};
  var last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 8).getValues().forEach(function (r) {
      have[ohNorm_(r[2]) + "|" + ohNorm_(r[4]) + "|" + ohNorm_(r[7])] = true;
    });
  }
  var rows = ohUsageRows_(prof, j, parts, ctx).filter(function (u) {
    var k = ohNorm_(u.supplier) + "|" + ohNorm_(u.doc_number) + "|" + ohNorm_(u.site_id);
    if (have[k]) return false;
    have[k] = true;
    return true;
  });
  if (!rows.length) return 0;
  var out = rows.map(function (u) { return OH.USAGE_HEADER.map(function (h) { return u[h] === undefined ? "" : String(u[h]); }); });
  var rng = sh.getRange(sh.getLastRow() + 1, 1, out.length, OH.USAGE_HEADER.length);
  rng.setNumberFormat("@");        // survive gviz as written, same as Statements.gs
  rng.setValues(out);
  var flagged = rows.filter(function (u) { return u.status === "CHECK"; }).length;
  if (flagged) notes.push(flagged + " usage row" + (flagged > 1 ? "s" : "") + " flagged CHECK");
  return rows.length;
}

function ohUsageSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(OH.USAGE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(OH.USAGE_SHEET);
    sh.getRange(1, 1, 1, OH.USAGE_HEADER.length).setValues([OH.USAGE_HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  var cur = sh.getRange(1, 1, 1, OH.USAGE_HEADER.length).getValues()[0].map(function (v) { return String(v || "").trim(); });
  if (cur.join("|") !== OH.USAGE_HEADER.join("|")) {
    if (sh.getLastRow() > 1) throw new Error("'" + OH.USAGE_SHEET + "' has an unexpected header - rename it rather than let this overwrite it");
    sh.getRange(1, 1, 1, OH.USAGE_HEADER.length).setValues([OH.USAGE_HEADER]).setFontWeight("bold");
  }
  return sh;
}

/* ---------------------------------------------------------------- entry points */

function ohSetup() {
  ohUsageSheet_();
  Logger.log(OH.VERSION + ": " + OH.USAGE_SHEET + " tab ready. " + OH_PROFILES.length + " overhead profiles loaded.");
}

/**
 * The backfill check. Writes the OverheadAudit tab and nothing else.
 *
 * Why it cannot filter on status: a statement the model rejects is logged with status
 * OK and a note "<file>: skipped (statement)". Only SKIPPED rows are the no-attachment and
 * no-invoice-signal cases. So the notes are read, not the status.
 */
function ohAudit() {
  var res = ohCandidates_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(OH.AUDIT_SHEET) || ss.insertSheet(OH.AUDIT_SHEET);
  sh.clearContents();
  var header = ["section", "profile", "message_id", "date", "from", "subject", "current", "action"];
  var rows = res.report.map(function (r) { return header.map(function (h) { return String(r[h] == null ? "" : r[h]); }); });
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  if (rows.length) {
    var rng = sh.getRange(2, 1, rows.length, header.length);
    rng.setNumberFormat("@");
    rng.setValues(rows);
  }
  sh.setFrozenRows(1);
  Logger.log(OH.VERSION + " audit: " + res.summary);
  return res;
}

/** Re-reads the requeue list by message id. Safe to run repeatedly. */
function ohReprocess() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log("Another processor run is in progress - try again shortly."); return; }
  try {
    var res = ohCandidates_();
    var queue = res.requeue;
    var t0 = Date.now(), done = 0, failed = 0;
    for (var i = 0; i < queue.length && done + failed < OH.MAX_REPROCESS_PER_RUN; i++) {
      if (Date.now() - t0 > OH.MAX_RUN_MS) break;
      var r = ohReprocessMessage_(queue[i].message_id);
      if (r.status === "FAILED") failed++; else done++;
      Logger.log(queue[i].message_id + " " + r.status + ": " + r.note);
    }
    var left = queue.length - done - failed;
    Logger.log(OH.VERSION + " reprocess: " + done + " done, " + failed + " failed, " + left +
      " remaining" + (left ? " - run ohReprocess() again." : "."));
  } finally { lock.releaseLock(); }
}

/** The one-message trial: the newest Supagas statement only. */
function ohReprocessLatestSupagas() {
  var threads = GmailApp.search('from:ar@supagas.com.au subject:"invoice statement" has:attachment', 0, 1);
  if (!threads.length) { Logger.log("No Supagas statement found in this mailbox."); return; }
  var msgs = threads[0].getMessages();
  var r = ohReprocessMessage_(msgs[msgs.length - 1].getId());
  Logger.log("Supagas " + msgs[msgs.length - 1].getSubject() + ": " + r.status + " - " + r.note);
}

function ohReprocessMessage_(id) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from Script Properties");
  var sheets = getSheets_();
  var existing = existingInvoiceKeys_(sheets.inv);
  var msg;
  try { msg = GmailApp.getMessageById(id); } catch (e) { msg = null; }
  if (!msg) {
    // Logged under the reprocess tag so the audit stops offering it, rather than failing
    // on it every run.
    sheets.log.appendRow([id, new Date(), "", "", "FAILED", OH.REPROCESS_TAG + ": message no longer in Gmail"]);
    return { status: "FAILED", note: "message " + id + " no longer in Gmail" };
  }
  var notes = [], status = "OK";
  try {
    processAttachments_(apiKey, sheets, existing, msg, notes, 1);
    if (!notes.length) notes.push("no PDF or image attachment");
  } catch (e) {
    status = "FAILED";
    notes.push(String(e && e.message ? e.message : e));
  }
  var note = OH.REPROCESS_TAG + ": " + notes.join("; ");
  logProcessed_(sheets.log, msg, status, note);
  return { status: status, note: notes.join("; ") };
}

/**
 * Tidies overhead rows already in Invoices. Logs every change; deletes nothing.
 *   - category -> the profile's category
 *   - venue    -> the mapped site, where the profile reads a site id off the source
 *                 column (Shell's BGFI01_00n filename) and the sheet says otherwise
 *   - $0 Supagas delivery dockets (pod@) -> type "superseded". They are not bills: the
 *     same litres are billed, priced, on the month-end statement.
 */
function ohRecategorise() {
  var inv = getSheets_().inv;
  var last = inv.getLastRow();
  if (last < 2) return;
  var C = OH.COL, SRC = 13;
  var vals = inv.getRange(2, 1, last - 1, SRC).getValues();
  var changed = 0;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i], row = i + 2;
    var prof = ohProfileForSupplier_(r[C.SUPPLIER - 1]);
    if (!prof || String(r[C.TYPE - 1]) === "superseded") continue;
    var tag = "row " + row + " " + r[C.SUPPLIER - 1] + " " + String(r[C.NUMBER - 1]).replace(/^'/, "") + ": ";
    var src = String(r[SRC - 1] || "");
    if (prof.id === "supagas" && /pod@supagas/i.test(src) && !(Number(r[C.TOTAL - 1]) || 0)) {
      inv.getRange(row, C.TYPE).setValue("superseded");
      Logger.log(tag + "$0 delivery docket -> superseded"); changed++;
      continue;
    }
    var cur = String(r[C.CATEGORY - 1] || "");
    if (cur !== prof.category) {
      inv.getRange(row, C.CATEGORY).setValue(prof.category);
      Logger.log(tag + "category " + (cur || "(blank)") + " -> " + prof.category); changed++;
    }
    if (prof.siteFromText) {
      var m = prof.siteFromText.exec(src);
      var v = m ? ohSiteVenue_(prof, m[1]) : null;
      if (v && v !== r[1]) {
        inv.getRange(row, 2).setValue(v);
        Logger.log(tag + "venue " + r[1] + " -> " + v + " (site " + m[1] + ")"); changed++;
      }
    }
  }
  Logger.log(OH.VERSION + " recategorise: " + changed + " change(s).");
}

/* ---------------------------------------------------------------- candidate list */

/**
 * Shared by the audit and the reprocess, so what the audit shows is exactly what the
 * reprocess will do. Includes a narrow Gmail sweep per profile for mail the processor
 * never logged at all - Shell and Scooter's never reach the processor's query today.
 */
function ohCandidates_() {
  var sheets = getSheets_();
  var log = sheets.log;
  var logVals = log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 6).getValues() : [];
  var inv = sheets.inv;
  var invVals = inv.getLastRow() > 1 ? inv.getRange(2, 1, inv.getLastRow() - 1, OH.COL.TYPE).getValues() : [];

  var gmail = {};
  OH_PROFILES.forEach(function (p) {
    if (!p.auditQuery) return;
    try {
      GmailApp.search(p.auditQuery, 0, 40).forEach(function (t) {
        t.getMessages().forEach(function (m) {
          gmail[m.getId()] = { from: m.getFrom(), subject: m.getSubject(), date: m.getDate(), profile: p.id };
        });
      });
    } catch (e) { gmail["error:" + p.id] = { error: String(e && e.message ? e.message : e) }; }
  });

  return ohClassify_(logVals, invVals, gmail);
}

/**
 * Pure: classifies ProcessedEmails rows, Invoices rows and Gmail hits. Exported for tests.
 * logVals: [message_id, processed_at, from, subject, status, notes]
 * invVals: Invoices columns A..K
 * gmail:   { id: {from, subject, date, profile} }
 */
function ohClassify_(logVals, invVals, gmail) {
  var byId = {}, order = [];
  logVals.forEach(function (r) {
    var id = String(r[0] || "");
    if (!id) return;
    if (!byId[id]) { byId[id] = { id: id, rows: [] }; order.push(id); }
    byId[id].rows.push({ at: r[1], from: String(r[2] || ""), subject: String(r[3] || ""),
                         status: String(r[4] || ""), notes: String(r[5] || "") });
  });

  var report = [], requeue = [], counts = { requeue: 0, cogsStatement: 0, captured: 0, reprocessed: 0, neverSeen: 0, rows: 0, recat: 0, notice: 0 };
  var profById = {};
  OH_PROFILES.forEach(function (p) { profById[p.id] = p; });

  order.forEach(function (id) {
    var m = byId[id];
    var first = m.rows[0], lastRow = m.rows[m.rows.length - 1];
    var prof = ohProfileForMessage_(first.from, first.subject);
    var reprocessed = m.rows.some(function (x) { return x.notes.indexOf(OH.REPROCESS_TAG) === 0; });
    var allNotes = m.rows.map(function (x) { return x.notes; }).join(" | ");
    var skippedWhy = ohSkipReason_(allNotes);
    var added = /\badded\b/.test(allNotes);
    var failed = lastRow.status === "FAILED" || lastRow.status === "GAVE_UP";
    var isStatementSkip = skippedWhy && /statement|account\s+summary|open\s+item/i.test(skippedWhy);

    if (!prof) {
      if (isStatementSkip) {
        counts.cogsStatement++;
        report.push({ section: "cogs statement - stays skipped", profile: "", message_id: id,
          date: ohIsoOf_(first.at), from: first.from, subject: first.subject,
          current: "skipped (" + skippedWhy + ")", action: "none - Statements tab only" });
      }
      return;
    }
    if (reprocessed) {
      counts.reprocessed++;
      report.push({ section: "overhead - already reprocessed", profile: prof.id, message_id: id,
        date: ohIsoOf_(first.at), from: first.from, subject: first.subject,
        current: lastRow.notes.slice(0, 200), action: "none" });
      return;
    }
    if (ohSkipMessage_(prof, first.subject, "")) {
      counts.notice++;
      report.push({ section: "overhead - notice, not a bill", profile: prof.id, message_id: id,
        date: ohIsoOf_(first.at), from: first.from, subject: first.subject,
        current: lastRow.status, action: "none" });
      return;
    }
    // Split profiles are re-read even when they were captured: an unsplit capture sits on
    // one venue, and the re-read supersedes it.
    // SKIPPED rows are "no PDF/image attachments" or "no invoice signals" - nothing to
    // re-read, so they are not requeued.
    var need = skippedWhy || failed || (prof.split && added) || (prof.statementLines && lastRow.status !== "SKIPPED");
    if (need) {
      counts.requeue++;
      var why = skippedWhy ? "skipped (" + skippedWhy + ")" : failed ? lastRow.status + ": " + lastRow.notes.slice(0, 120)
              : (prof.split && added) ? "captured unsplit" : "statement-only supplier";
      requeue.push({ message_id: id, profile: prof.id });
      report.push({ section: "overhead - requeue", profile: prof.id, message_id: id,
        date: ohIsoOf_(first.at), from: first.from, subject: first.subject, current: why,
        action: "reprocess as " + prof.category });
    } else if (added) {
      counts.captured++;
      report.push({ section: "overhead - captured", profile: prof.id, message_id: id,
        date: ohIsoOf_(first.at), from: first.from, subject: first.subject,
        current: lastRow.notes.slice(0, 200), action: "recategorise only" });
    } else {
      // remittances, attachment-less mail, "no invoice signals" - nothing to re-read
      counts.notice++;
      report.push({ section: "overhead - nothing to re-read", profile: prof.id, message_id: id,
        date: ohIsoOf_(first.at), from: first.from, subject: first.subject,
        current: lastRow.status + ": " + lastRow.notes.slice(0, 160), action: "none" });
    }
  });

  Object.keys(gmail || {}).forEach(function (id) {
    var g = gmail[id];
    if (g.error) { report.push({ section: "gmail search failed", profile: id.replace("error:", ""), current: g.error }); return; }
    if (byId[id]) return;
    var prof = profById[g.profile] || ohProfileForMessage_(g.from, g.subject);
    if (!prof) return;
    if (ohSkipMessage_(prof, g.subject, "")) return;
    counts.neverSeen++;
    requeue.push({ message_id: id, profile: prof.id });
    report.push({ section: "overhead - never seen by the processor", profile: prof.id, message_id: id,
      date: ohIsoOf_(g.date), from: g.from, subject: g.subject,
      current: "not in ProcessedEmails", action: "reprocess as " + prof.category });
  });

  (invVals || []).forEach(function (r, i) {
    var prof = ohProfileForSupplier_(r[OH.COL.SUPPLIER - 1]);
    if (!prof) return;
    counts.rows++;
    var cat = String(r[OH.COL.CATEGORY - 1] || "");
    var type = String(r[OH.COL.TYPE - 1] || "");
    if (cat !== prof.category && type !== "superseded") counts.recat++;
    report.push({ section: "invoices row", profile: prof.id, message_id: "row " + (i + 2),
      date: ohIsoOf_(r[OH.COL.DATE - 1]), from: r[OH.COL.SUPPLIER - 1],
      subject: String(r[OH.COL.NUMBER - 1] || "").replace(/^'/, "") + "  " + r[1] + "  $" + (Number(r[OH.COL.TOTAL - 1]) || 0).toFixed(2),
      current: (cat || "(blank)") + (type ? " / " + type : ""),
      action: type === "superseded" ? "none" : cat === prof.category ? "none" : "recategorise -> " + prof.category });
  });

  var summary = counts.requeue + " logged overhead emails to reprocess, " + counts.neverSeen +
    " overhead emails the processor never saw, " + counts.captured + " captured already, " +
    counts.reprocessed + " already reprocessed, " + counts.notice + " notices; " +
    counts.cogsStatement + " COGS statements stay skipped; " + counts.rows +
    " overhead rows in Invoices, " + counts.recat + " need recategorising.";
  return { report: report, requeue: requeue, counts: counts, summary: summary };
}

/* The model's reason, pulled out of a ProcessedEmails note. Only the FILENAME guard's
   remittance skips are excluded ("remittance advice, not a bill") - those are
   deterministic and right. A remittance verdict from the MODEL is not trusted here: the
   live log shows it rejected every SPG tenant invoice and every Peter Brown statement as
   "remittance advice", and business-card logos in forwarded mail are skipped too. */
function ohSkipReason_(notes) {
  var re = /skipped \(([^)]*)\)/gi, m, out = [];
  while ((m = re.exec(String(notes || "")))) {
    if (/remittance advice, not a bill/i.test(m[1])) continue;
    if (/business card|contact (sheet|information)|logo|signature/i.test(m[1])) continue;
    out.push(m[1]);
  }
  return out.join(", ");
}

/* ---------------------------------------------------------------- small helpers */

/* What the writer needs to know about the email a document came in on. The body is only
   read for profiled mail - it carries the Supagas statement reference. */
function ohContext_(msg, att, lane) {
  var body = "";
  try { body = msg.getPlainBody() || msg.getBody() || ""; } catch (e) {}
  return { from: msg.getFrom(), subject: msg.getSubject(), body: body, emailDate: msg.getDate(),
           fileName: att.getName(), msgId: msg.getId(), route: route_(msg, lane || 1), savePdf: null };
}

function ohRefFromBody_(prof, body) {
  if (!prof.refFromBody || !body) return "";
  var text = String(body).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  var m = prof.refFromBody.exec(text);
  return m ? m[1].toUpperCase() : "";
}

function ohDateFromSubject_(prof, subject) {
  var m = prof.dateFromSubject && prof.dateFromSubject.exec(String(subject || ""));
  if (!m) return "";
  var MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  var mo = MON[m[2].toUpperCase()];
  if (!mo) return "";
  var y = +m[3]; if (y < 100) y += 2000;
  var d = +m[1];
  if (d < 1 || d > 31) return "";
  return y + "-" + (mo < 10 ? "0" : "") + mo + "-" + (d < 10 ? "0" : "") + d;
}

function ohShortVenue_(v) {
  return String(v || "").replace(/^Red Square /, "").replace(/ Kitchen$/, "") || "?";
}
function ohNorm_(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function ohNumOr_(v, fallback) {
  var n = Number(v);
  return (v !== null && v !== "" && v !== undefined && isFinite(n)) ? n : fallback;
}
function ohClone_(o) { return JSON.parse(JSON.stringify(o)); }
function ohIsoOf_(v) {
  if (v instanceof Date && !isNaN(v)) {
    return v.getFullYear() + "-" + ("0" + (v.getMonth() + 1)).slice(-2) + "-" + ("0" + v.getDate()).slice(-2);
  }
  var s = String(v || "");
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[0] : s;
}
