/**
 * Orders.gs — the write side of order-builder.html.
 *
 * A STANDALONE Apps Script project (script.new), not bound to the spreadsheet. Deploy as a
 * web app, execute as ME, access ANYONE, and paste the /exec URL into WEBAPP_URL in
 * order-builder.html.
 *
 * Standalone on purpose. Extensions > Apps Script on BG Ops Data opens the invoice
 * processor, which already has a doGet/doPost pair behind ManualPurchaseEntry. Duplicate
 * function names across .gs files in one project are legal and the last file loaded wins,
 * silently — so dropping this in beside it would have taken the phone entry app offline
 * with no error anywhere. It reaches the workbook by ID instead.
 *
 * Everything else in this platform reads the sheets over gviz, which is read-only. This
 * is the only path that writes, so it is deliberately narrow:
 *   - four actions, nothing generic
 *   - append-only tabs, so a mis-tick is corrected by a later row, never by an edit
 *   - email recipients are resolved HERE from the sheet, never taken from the request.
 *     The dashboard is public; an endpoint that emailed whatever address it was handed
 *     would be an open relay.
 *
 * The PIN lives in Script Properties as ORDER_PIN. Never in this file — the repo is public.
 */

/* Every venue a dashboard may write for. Cambridge Central uses the first two; Glenorchy HQ
   (glenorchy-hq.html) uses the third. One endpoint, one set of tabs — the venue column keeps
   the ledgers apart. Anything else is rejected at the write boundary as well as filtered on
   read, so a stale tab or a hand-edited request can't put an unknown venue into the data. */
var OB_STORES = ["Red Square Cambridge", "Luma Kitchen", "Red Square Glenorchy"];

/* What the supplier sees at the bottom of an emailed order, and where to deliver. Keyed by
   venue so a Glenorchy order doesn't sign off as Cambridge. */
var OB_VENUE = {
  "Red Square Cambridge": { addr:"66 Kennedy Drive, Cambridge TAS 7170",  signoff:"Red Square Cafe | Luma Kitchen" },
  "Luma Kitchen":         { addr:"66 Kennedy Drive, Cambridge TAS 7170",  signoff:"Red Square Cafe | Luma Kitchen" },
  "Red Square Glenorchy": { addr:"3/2 Howard Road, Glenorchy TAS 7010",   signoff:"Red Square Cafe Glenorchy" }
};

/* Bumped with every change to this file. An Apps Script deployment serves a SNAPSHOT, so
   saving the editor changes nothing until someone picks "New version" — and until now there
   was no way to tell from outside which code was actually live. doGet reports this, so the
   dashboard (and anyone with the URL) can see at a glance whether the deployment matches
   the repo. */
var OB_BUILD = "gs-v10-0539";

var OB = {
  SHEET_ID:     "1bICxitr-CyU7VF8TLKIZgw7gV2WTKur9AptfmskQNK4",   // BG Ops Data
  SETTINGS_STORE_TAB: "SupplierSettings",
  FAVS_TAB:     "Favourites",
  FAVLINES_TAB: "FavouriteLines",
  COVER_TAB:    "CategoryOverrides",
  ORDERS_TAB:   "Orders",
  LINES_TAB:    "OrderLines",
  TARGETS_TAB:  "OrderTargets",
  INVOICES_TAB: "Invoices",
  MAX_LINES:      300,     // one order; anything larger is a bug or a paste accident
  DAILY_SEND_CAP: 60,      // emails sent by this script per day, across all users
  SIGNOFF: ["B & G Fitness Pty Ltd", "accounts@redsquarecafe.com.au"],   // venue line inserted from OB_VENUE
  BCC: "accounts@redsquarecafe.com.au"
};

var ORDERS_HEADER = ["order_id","action","supplier","venue","order_date","subtotal","gst","total",
                     "channel","placed_by","note","logged_at","delivery_date"];
var LINES_HEADER  = ["order_id","line_no","item_code","description","unit","qty","unit_price","line_total"];
var TARGETS_HEADER= ["venue","cogs_pct","weekly_budget","updated_by","updated_at"];
var SUPSET_HEADER = ["supplier","rep_email","visible","portal_only","cc","note","updated_by","updated_at"];
var FAVS_HEADER   = ["fav_id","fav_name","venue","supplier","created_by","created_at"];
var FAVLINE_HEADER= ["fav_id","line_no","item_key","description","unit","qty","supplier"];
var COVER_HEADER  = ["item_key","supplier","description","category","hidden","updated_by","updated_at"];

/* The categories the dashboard knows how to render. A free-text category would save fine
   and then show up as a chip nobody can filter on, so the list is closed. */
var OB_CATEGORIES = ["Produce","Meat","Seafood","Dairy / Cold Storage","Frozen","Bakery","Dry Goods",
  "Beverage","Coffee","Hot Containers","Cold Containers","Packaging","Cleaning & Chemicals","Uncategorised"];

/* Only these settings can be written, and each value is checked. The endpoint is public
   behind a shared PIN, so "whatever field the request names" is not an option: a typo'd
   field would silently create a column the dashboard never reads, and the email fields are
   the one place a bad value turns into mail going somewhere unintended. */
var SETTING_FIELDS = {
  rep_email:   function (v) { return v === "" || isEmail_(v) ? v : null; },
  cc:          function (v) { return v === "" || isEmail_(v) ? v : null; },
  visible:     function (v) { return v === "yes" || v === "no" ? v : null; },
  portal_only: function (v) { return v === "yes" || v === "no" ? v : null; },
  note:        function (v) { return v.slice(0, 300); }
};
function isEmail_(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); }

/* ========================= ENTRY POINTS ========================= */

function doGet() {
  /* Health check only. It answers whether the deployment is reachable and current; it
     never returns sheet contents, because anyone can call it. */
  return out({ ok:true, service:"Orders.gs", build:OB_BUILD,
               actions:["place","send","receive","cancel","target","supplier_setting",
                        "favourite","favourite_delete","category_override","category_bulk"],
               pin_configured: !!scriptPin_(), time:new Date().toISOString() });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(20000)) return out({ ok:false, error:"busy, try again" });

    if (!e || !e.postData || !e.postData.contents) return out({ ok:false, error:"empty request" });
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch (err) { return out({ ok:false, error:"body is not JSON" }); }

    var pin = scriptPin_();
    if (!pin) return out({ ok:false, error:"ORDER_PIN is not set in Script Properties" });
    if (String(body.pin || "") !== String(pin)) return out({ ok:false, error:"wrong PIN" });

    var user = trim_(body.user).slice(0, 60);
    if (!user) return out({ ok:false, error:"no name supplied" });

    switch (trim_(body.action).toLowerCase()) {
      case "place":   return out(place_(body, user));
      case "send":    return out(send_(body, user));
      case "receive": return out(mark_(body, user, "receive"));
      case "cancel":  return out(mark_(body, user, "cancel"));
      /* A hand match: the invoice number rides in the note. Append-only like the others, so
         a wrong match is corrected by a later row, never by editing history. */
      case "match":   return out(mark_(body, user, "match"));
      case "target":  return out(target_(body, user));
      case "supplier_setting":  return out(supplierSetting_(body, user));
      case "favourite":         return out(favourite_(body, user));
      case "favourite_delete":  return out(favouriteDelete_(body, user));
      case "category_override": return out(categoryOverride_(body, user));
      case "category_bulk":     return out(categoryBulk_(body, user));
      default:        return out({ ok:false, error:"unknown action" });
    }
  } catch (err) {
    return out({ ok:false, error:String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ========================= ACTIONS ========================= */

/* Log an order. Idempotent on order_id: a double tap on a slow connection must not book
   the spend twice, so a repeat of an id already present is reported, not appended. */
function place_(body, user) {
  var o = validateOrder_(body);
  if (o.error) return { ok:false, error:o.error };

  var sh = tab_(OB.ORDERS_TAB, ORDERS_HEADER);
  if (hasOrder_(sh, o.order_id, "place")) return { ok:true, duplicate:true, order_id:o.order_id };

  var now = new Date();
  sh.appendRow([o.order_id, "place", o.supplier, o.venue, o.order_date, o.subtotal, o.gst, o.total,
                o.channel, user, o.note, now, o.delivery_date]);

  if (o.lines.length) {
    var ls = tab_(OB.LINES_TAB, LINES_HEADER);
    var rows = o.lines.map(function (l, i) {
      return [o.order_id, i + 1, l.item_code, l.description, l.unit, l.qty, l.unit_price, l.line_total];
    });
    ls.getRange(ls.getLastRow() + 1, 1, rows.length, LINES_HEADER.length).setValues(rows);
  }
  return { ok:true, order_id:o.order_id, lines:o.lines.length };
}

/* Log the order and email it to the supplier. The address is resolved from the sheet —
   OrderSettings first, then the addresses seen on that supplier's own invoice emails.
   A request cannot name a recipient. */
function send_(body, user) {
  var placed = place_(body, user);
  if (!placed.ok) return placed;

  var supplier = trim_(body.supplier);
  var to = supplierEmail_(supplier);
  if (!to) return { ok:true, order_id:placed.order_id, sent:false,
                    error:"logged, but no email is known for this supplier — add one to OrderSettings" };

  var used = bumpSendCount_();
  if (used > OB.DAILY_SEND_CAP) {
    return { ok:true, order_id:placed.order_id, sent:false,
             error:"logged, but the daily send cap (" + OB.DAILY_SEND_CAP + ") is reached" };
  }

  var o = validateOrder_(body);
  var lines = o.lines.map(function (l) {
    return "- " + l.qty + " x " + (l.unit || "ea") + "  " + l.description +
           (l.item_code ? " [" + l.item_code + "]" : "");
  }).join("\n");

  var vinfo = OB_VENUE[o.venue] || { addr:"", signoff:"Red Square Cafe" };
  var bodyText = "Hi " + supplier + ",\n\n" +
    "Could we please order the following for " + o.venue + ":\n\n" + lines +
    (vinfo.addr ? "\n\nDeliver to: " + vinfo.addr : "") +
    "\n\nPlease confirm availability and delivery day.\n\nThanks,\n" + user + "\n" +
    [OB.SIGNOFF[0], vinfo.signoff, OB.SIGNOFF[1]].join("\n");

  MailApp.sendEmail({
    to: to,
    bcc: OB.BCC,
    subject: "Order — " + o.venue + " — " + o.order_date,
    body: bodyText,
    name: "Red Square Cafe"
  });

  var sh = tab_(OB.ORDERS_TAB, ORDERS_HEADER);
  sh.appendRow([o.order_id, "sent", o.supplier, o.venue, o.order_date, o.subtotal, o.gst, o.total,
                "email:" + to, user, "", new Date()]);
  return { ok:true, order_id:placed.order_id, sent:true, to:to };
}

/* Append-only status change. The place row stays; the later row wins on read. */
function mark_(body, user, action) {
  var id = trim_(body.order_id);
  if (!id) return { ok:false, error:"no order_id" };
  var sh = tab_(OB.ORDERS_TAB, ORDERS_HEADER);
  if (action === "match" && !trim_(body.note)) return { ok:false, error:"a match needs the invoice number in note" };
  sh.appendRow([id, action, trim_(body.supplier), trim_(body.venue), trim_(body.order_date),
                num_(body.subtotal), num_(body.gst), num_(body.total), "", user,
                trim_(body.note).slice(0, 200), new Date(), ""]);
  return { ok:true, order_id:id, action:action };
}

/* One row per venue. Replaced in place rather than appended — a target is a current
   setting, not an event, and a stale second row would be read as the live one. */
function target_(body, user) {
  var venue = trim_(body.venue);
  if (!venue) return { ok:false, error:"no venue" };
  var pct = num_(body.cogs_pct), budget = num_(body.weekly_budget);
  if (pct < 0 || pct > 100) return { ok:false, error:"cogs_pct must be between 0 and 100" };
  if (budget < 0) return { ok:false, error:"weekly_budget must not be negative" };

  var sh = tab_(OB.TARGETS_TAB, TARGETS_HEADER);
  var last = sh.getLastRow();
  var row = 0;
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim().toLowerCase() === venue.toLowerCase()) { row = i + 2; break; }
    }
  }
  if (!row) row = last + 1;
  sh.getRange(row, 1, 1, TARGETS_HEADER.length).setValues([[venue, pct, budget, user, new Date()]]);
  return { ok:true, venue:venue, cogs_pct:pct, weekly_budget:budget };
}

/* One row per supplier, replaced in place: a setting is current state, not an event, and a
   stale second row would be read back as the live one. */
function supplierSetting_(body, user) {
  var supplier = trim_(body.supplier).slice(0, 120);
  var field = trim_(body.field).toLowerCase();
  if (!supplier) return { ok:false, error:"no supplier" };
  if (!SETTING_FIELDS.hasOwnProperty(field)) return { ok:false, error:"not a settable field: " + field };

  var value = SETTING_FIELDS[field](trim_(body.value));
  if (value === null) return { ok:false, error:"invalid value for " + field };

  var sh = tab_(OB.SETTINGS_STORE_TAB, SUPSET_HEADER);
  var col = SUPSET_HEADER.indexOf(field) + 1;
  var last = sh.getLastRow(), row = 0;
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (norm_(vals[i][0]) === norm_(supplier)) { row = i + 2; break; }
    }
  }
  if (!row) {
    row = last + 1;
    /* A new row carries the defaults the dashboard assumes. Without them a supplier that
       only ever had its rep email set would read back hidden, with no stores. */
    sh.getRange(row, 1, 1, SUPSET_HEADER.length)
      .setValues([[supplier, "", "yes", "no", "", "", user, new Date()]]);
  }
  sh.getRange(row, col).setValue(value);
  sh.getRange(row, SUPSET_HEADER.indexOf("updated_by") + 1, 1, 2).setValues([[user, new Date()]]);
  return { ok:true, supplier:supplier, field:field, value:value };
}

/* One row per product, replaced in place. It carries two independent things: a category
   override, and whether the product is turned off in the ordering screens. A row with
   neither is deleted rather than left as an empty record, so "undo" needs no extra action.
   Turning a product off never affects spend or reporting — that would hide money. */
function categoryOverride_(body, user) {
  var sh = tab_(OB.COVER_TAB, COVER_HEADER);
  var res = writeCover_(sh, body, user);
  return res.error ? { ok:false, error:res.error } : { ok:true, item_key:res.key,
                                                       category:res.cat, hidden:res.hidden, cleared:res.cleared };
}

/* The whole selection in one call. Fifty single posts would burn quota and could half-apply
   if one failed midway; here a bad item is reported and the rest still land. */
/* One read and one write for the whole selection. Doing it item by item meant a full-column
   read plus a single-row write per product — eighteen products took eighteen round trips to
   the sheet, which is why it crawled. Here the sheet is read once, edited in memory, and
   written back in one setValues. */
function categoryBulk_(body, user) {
  var items = body.items || [];
  if (!items.length) return { ok:false, error:"no items" };
  if (items.length > 500) return { ok:false, error:"too many items (" + items.length + ")" };

  var sh = tab_(OB.COVER_TAB, COVER_HEADER);
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, COVER_HEADER.length).getValues() : [];
  var index = {};
  for (var i = 0; i < rows.length; i++) index[String(rows[i][0]).trim()] = i;

  var now = new Date(), written = 0, cleared = 0, failed = [], drop = {};
  for (var k = 0; k < items.length; k++) {
    var o = items[k];
    var key = trim_(o.item_key).slice(0, 200);
    var cat = trim_(o.category);
    var hid = trim_(o.hidden).toLowerCase();
    if (!key) { failed.push("no item_key"); continue; }
    if (cat && OB_CATEGORIES.indexOf(cat) === -1) { failed.push("unknown category: " + cat); continue; }
    if (hid && hid !== "yes" && hid !== "no") { failed.push("hidden must be yes or no"); continue; }

    var at = index.hasOwnProperty(key) ? index[key] : -1;
    var curRow = at >= 0 ? rows[at] : null;
    var keepCat = curRow ? String(curRow[3] || "").trim() : "";
    var keepHid = curRow ? String(curRow[4] || "").trim().toLowerCase() : "";
    var newCat = o.hasOwnProperty("category") ? cat : keepCat;
    var newHid = hid || keepHid || "no";

    /* Nothing left to remember: mark the row for removal rather than leaving an empty record. */
    if (!newCat && newHid !== "yes") {
      if (at >= 0) { drop[at] = true; cleared++; }
      continue;
    }
    var out = [key, trim_(o.supplier).slice(0, 120), trim_(o.description).slice(0, 200),
               newCat, newHid, user, now];
    if (at >= 0) rows[at] = out;
    else { index[key] = rows.length; rows.push(out); }
    written++;
  }

  var keep = [];
  for (var r = 0; r < rows.length; r++) if (!drop[r]) keep.push(rows[r]);
  if (keep.length) sh.getRange(2, 1, keep.length, COVER_HEADER.length).setValues(keep);
  var stale = (last - 1) - keep.length;
  if (stale > 0) sh.getRange(2 + keep.length, 1, stale, COVER_HEADER.length).clearContent();

  return { ok:true, written:written, cleared:cleared, failed:failed };
}

function writeCover_(sh, o, user) {
  var key = trim_(o.item_key).slice(0, 200);
  var cat = trim_(o.category);
  var hid = trim_(o.hidden).toLowerCase();
  if (!key) return { error:"no item_key" };
  if (cat && OB_CATEGORIES.indexOf(cat) === -1) return { error:"unknown category: " + cat };
  if (hid && hid !== "yes" && hid !== "no") return { error:"hidden must be yes or no" };

  var last = sh.getLastRow(), row = 0, cur = null;
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, COVER_HEADER.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === key) { row = i + 2; cur = vals[i]; break; }
    }
  }
  /* Only the fields the request actually names are changed: setting a category must not
     quietly un-hide a product, and turning one off must not drop its category. */
  var keepCat = cur ? String(cur[3] || "").trim() : "";
  var keepHid = cur ? String(cur[4] || "").trim().toLowerCase() : "";
  var newCat = o.hasOwnProperty("category") ? cat : keepCat;
  var newHid = hid || keepHid || "no";

  if (!newCat && newHid !== "yes") {
    if (row) sh.deleteRow(row);
    return { key:key, cleared:true };
  }
  if (!row) row = last + 1;
  sh.getRange(row, 1, 1, COVER_HEADER.length).setValues([[key,
    trim_(o.supplier).slice(0, 120), trim_(o.description).slice(0, 200), newCat, newHid, user, new Date()]]);
  return { key:key, cat:newCat, hidden:newHid };
}

function favourite_(body, user) {
  var id = trim_(body.fav_id).slice(0, 40);
  var name = trim_(body.fav_name).slice(0, 80);
  var venue = trim_(body.venue);
  var supplier = trim_(body.supplier).slice(0, 120);
  if (!id) return { ok:false, error:"no fav_id" };
  if (!name) return { ok:false, error:"a favourite needs a name" };
  if (OB_STORES.indexOf(venue) === -1) return { ok:false, error:"unknown venue: " + venue };

  var lines = (body.lines || []).filter(function (l) { return num_(l.qty) > 0; });
  if (!lines.length) return { ok:false, error:"no lines" };
  if (lines.length > OB.MAX_LINES) return { ok:false, error:"too many lines" };

  var fs = tab_(OB.FAVS_TAB, FAVS_HEADER);
  if (hasId_(fs, id)) return { ok:true, duplicate:true, fav_id:id };
  fs.appendRow([id, name, venue, supplier, user, new Date()]);

  var ls = tab_(OB.FAVLINES_TAB, FAVLINE_HEADER);
  var rows = lines.map(function (l, i) {
    return [id, i + 1, trim_(l.item_key).slice(0, 200), trim_(l.description).slice(0, 200),
            trim_(l.unit).slice(0, 16), num_(l.qty), trim_(l.supplier || supplier).slice(0, 120)];
  });
  ls.getRange(ls.getLastRow() + 1, 1, rows.length, FAVLINE_HEADER.length).setValues(rows);
  return { ok:true, fav_id:id, lines:rows.length };
}

/* Favourites are a list the user curates, so delete really deletes. An append-only
   tombstone would leave a deleted template on screen until something read an action
   column, which is the wrong behaviour for a thing somebody just said to remove. */
function favouriteDelete_(body, user) {
  var id = trim_(body.fav_id);
  if (!id) return { ok:false, error:"no fav_id" };
  var removed = deleteRowsById_(tab_(OB.FAVS_TAB, FAVS_HEADER), id)
              + deleteRowsById_(tab_(OB.FAVLINES_TAB, FAVLINE_HEADER), id);
  return { ok:true, fav_id:id, rows_removed:removed };
}
function deleteRowsById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var gone = 0;
  for (var i = vals.length - 1; i >= 0; i--) {          // bottom up: row numbers shift
    if (String(vals[i][0]).trim() === id) { sh.deleteRow(i + 2); gone++; }
  }
  return gone;
}
function hasId_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === id) return true;
  return false;
}

/* ========================= HELPERS ========================= */

function validateOrder_(body) {
  var o = {
    order_id:   trim_(body.order_id).slice(0, 40),
    supplier:   trim_(body.supplier).slice(0, 120),
    venue:      trim_(body.venue).slice(0, 60),
    order_date: trim_(body.order_date).slice(0, 10),
    subtotal:   num_(body.subtotal),
    gst:        num_(body.gst),
    total:      num_(body.total),
    channel:    trim_(body.channel).slice(0, 30) || "email",
    note:       trim_(body.note).slice(0, 500),
    delivery_date: trim_(body.delivery_date).slice(0, 10),
    lines: []
  };
  if (o.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(o.delivery_date)) return { error:"delivery_date must be yyyy-mm-dd" };
  if (!o.order_id)  return { error:"no order_id" };
  if (!o.supplier)  return { error:"no supplier" };
  if (!o.venue)     return { error:"no venue" };
  if (OB_STORES.indexOf(o.venue) === -1) return { error:"unknown venue: " + o.venue };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.order_date)) return { error:"order_date must be yyyy-mm-dd" };

  var lines = body.lines || [];
  if (!lines.length)               return { error:"no lines" };
  if (lines.length > OB.MAX_LINES) return { error:"too many lines (" + lines.length + ")" };
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var qty = num_(l.qty);
    if (!(qty > 0)) continue;                       // a zero line is simply not ordered
    o.lines.push({
      item_code:   trim_(l.item_code).slice(0, 40),
      description: trim_(l.description).slice(0, 200),
      unit:        trim_(l.unit).slice(0, 16),
      qty:         qty,
      unit_price:  num_(l.unit_price),
      line_total:  num_(l.line_total)
    });
  }
  if (!o.lines.length) return { error:"every line is zero" };
  return o;
}

function hasOrder_(sh, id, action) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var vals = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === id && String(vals[i][1]).trim().toLowerCase() === action) return true;
  }
  return false;
}

/* Same preference order as the dashboard: a configured address beats a harvested one, and
   a real mailbox beats a no-reply relay. Invoices arrive via Xero and NetSuite relays, so
   the From header is often a robot that goes nowhere. */
function supplierEmail_(supplier) {
  var key = norm_(supplier);
  var set = readTab_(OB.SETTINGS_STORE_TAB);
  for (var i = 0; i < set.length; i++) {
    if (norm_(set[i].supplier) === key && trim_(set[i].rep_email)) return trim_(set[i].rep_email);
  }
  var inv = readTab_(OB.INVOICES_TAB), tally = {};
  for (var j = 0; j < inv.length; j++) {
    if (norm_(inv[j].supplier) !== key) continue;
    var found = String(inv[j].source || "").match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
    for (var k = 0; k < found.length; k++) {
      var a = found[k].toLowerCase();
      if (/redsquarecafe|beckitt|bgfitness|lumakitchen/.test(a)) continue;
      var w = /sent-via|noreply|no-reply|donotreply|notifications?@|mailer|bounce/.test(a) ? 1 : 10;
      tally[a] = (tally[a] || 0) + w;
    }
  }
  var best = "", bestW = 0;
  for (var addr in tally) if (tally[addr] > bestW) { best = addr; bestW = tally[addr]; }
  return best;
}

/* One handle per execution. openById is a network call; getActive was free. */
var OB_BOOK = null;
function book_() {
  if (!OB_BOOK) OB_BOOK = SpreadsheetApp.openById(OB.SHEET_ID);
  return OB_BOOK;
}

function readTab_(name) {
  var sh = book_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getDataRange().getValues();
  var head = vals.shift().map(function (h) { return String(h).trim().toLowerCase(); });
  return vals.map(function (r) {
    var o = {};
    head.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

/* Every write below addresses columns BY POSITION, so a header left over from an older
   version of this file silently puts values in the wrong column. SupplierSettings lost its
   per-site "stores" column in v3, which would have pushed cc, note and updated_by one place
   left on a tab created by v2. An empty tab is simply re-headed; a tab with data is not
   touched and the call fails loudly, because shifting live rows is worse than refusing. */
function tab_(name, header) {
  var ss = book_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  /* A header that is a strict PREFIX of the expected one is extended in place. Adding a
     column at the END shifts nothing, so it is safe with data present; "delivery_date"
     joined Orders this way. */
  if (sh.getLastRow() > 1) {
    var have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0]
                 .map(function (h) { return String(h).trim().toLowerCase(); })
                 .filter(function (h) { return h; });
    var isPrefix = have.length < header.length;
    for (var p = 0; p < have.length && isPrefix; p++) if (have[p] !== header[p]) isPrefix = false;
    if (isPrefix) {
      sh.getRange(1, have.length + 1, 1, header.length - have.length)
        .setValues([header.slice(have.length)]).setFontWeight("bold");
      Logger.log("extended '" + name + "' header with: " + header.slice(have.length).join(", "));
    }
  }
  if (sh.getLastRow() <= 1) {                       // absent or header-only: safe to re-head
    sh.getRange(1, 1, 1, sh.getLastColumn() || header.length).clearContent();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  var cur = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0]
              .map(function (h) { return String(h).trim().toLowerCase(); });
  /* A known old layout is migrated rather than reported. v3 made supplier settings global and
     dropped the per-site "stores" column; the shape it left behind is specific enough to
     recognise exactly, so drop that one column and carry on. Anything else still refuses —
     a generic "rewrite whatever is there" would shift live data on the first typo. */
  cur = migrateLegacy_(sh, name, cur);
  for (var i = 0; i < header.length; i++) {
    if (cur[i] !== header[i]) {
      throw new Error("'" + name + "' column " + (i + 1) + " is '" + cur[i] + "', expected '" +
        header[i] + "'. It has data, so nothing was written. Fix the header row by hand, then retry.");
    }
  }
  return sh;
}

var LEGACY_LAYOUTS = [{
  tab: "SupplierSettings",
  was: ["supplier","rep_email","visible","portal_only","stores","cc","note","updated_by","updated_at"],
  drop: "stores"
}];
function migrateLegacy_(sh, name, cur) {
  for (var i = 0; i < LEGACY_LAYOUTS.length; i++) {
    var L = LEGACY_LAYOUTS[i];
    if (L.tab !== name || L.was.length !== cur.length) continue;
    var same = true;
    for (var j = 0; j < L.was.length; j++) if (cur[j] !== L.was[j]) { same = false; break; }
    if (!same) continue;
    var col = L.was.indexOf(L.drop) + 1;
    sh.deleteColumn(col);
    cur = cur.slice(0, col - 1).concat(cur.slice(col));
    Logger.log("migrated '" + name + "': dropped dead column '" + L.drop + "'");
  }
  return cur;
}

/* The send cap is per calendar day and shared by everyone, which is the point: it bounds
   what a leaked PIN can do before anyone notices. */
function bumpSendCount_() {
  var p = PropertiesService.getScriptProperties();
  var key = "ORDER_SENDS_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
  var n = (parseInt(p.getProperty(key), 10) || 0) + 1;
  p.setProperty(key, String(n));
  return n;
}

function scriptPin_() { return PropertiesService.getScriptProperties().getProperty("ORDER_PIN"); }
function trim_(v) { return String(v == null ? "" : v).trim(); }
function num_(v)  { var n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; }
function norm_(v) { return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function out(o)   { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ========================= SETUP, run once from the editor ========================= */

function setup() {
  tab_(OB.ORDERS_TAB, ORDERS_HEADER);
  tab_(OB.LINES_TAB, LINES_HEADER);
  tab_(OB.TARGETS_TAB, TARGETS_HEADER);
  tab_(OB.SETTINGS_STORE_TAB, SUPSET_HEADER);
  tab_(OB.FAVS_TAB, FAVS_HEADER);
  tab_(OB.FAVLINES_TAB, FAVLINE_HEADER);
  tab_(OB.COVER_TAB, COVER_HEADER);
  var pin = scriptPin_();
  Logger.log(pin ? "ORDER_PIN is set. Tabs ready." :
    "Tabs ready. NOW SET ORDER_PIN: Project Settings > Script Properties > Add, key ORDER_PIN.");
}
