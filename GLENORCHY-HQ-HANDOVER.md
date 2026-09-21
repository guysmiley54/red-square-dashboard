# Glenorchy HQ — handover

Ordering, spend control and sales reporting for **Red Square Glenorchy**. The Glenorchy build
of Cambridge Central. Read CAMBRIDGE-CENTRAL-HANDOVER.md first — everything there about the
model, reconciliation, categories, traps and schemas applies here unchanged. This file only
covers what differs.

Built 16 Sep 2026. Dashboard `ghq-v14-1256` (21 Sep), script `gs-v13-0909`.
Harness: 321 dashboard checks (two runs), 37 backend checks, all passing (see §5).

---

## 1. What it is

`glenorchy-hq.html` is `order-builder.html` with the venue swapped and the two-store
machinery reduced to one. Same two sheets, same `Orders.gs` endpoint, same `/exec` URL.

| | Cambridge Central | Glenorchy HQ |
|---|---|---|
| File | `order-builder.html` | `glenorchy-hq.html` |
| `LEDGER_VENUES` | Cambridge, Luma | Glenorchy |
| `ENTITY` | Red Square Cambridge | Red Square Glenorchy |
| Tags | Cambridge / Luma switch in header | one tag, picker hidden |
| Delivery address | 66 Kennedy Drive, Cambridge TAS 7170 | 3/2 Howard Road, Glenorchy TAS 7010 |
| Signoff line | Red Square Cafe \| Luma Kitchen | Red Square Cafe Glenorchy |
| Draft storage key | `ob3_drafts` | `ghq_drafts` |
| Build stamp | `build-vNN-HHMM` | `ghq-vN-HHMM` |

The diff between the two files is deliberately small so a fix to one can be carried to the
other. The `TAGS` array, `venue:null` catalogue calls and `setProdVenue` all still exist with
one venue; anything that renders a store picker checks `TAGS.length` first.

## 2. One backend, three venues

`Orders.gs` now accepts `Red Square Glenorchy` (`OB_STORES`). The `Orders`, `OrderLines`,
`Favourites` and `OrderTargets` tabs already carry a venue column, so Glenorchy's rows sit
beside Cambridge's and each dashboard filters to its own on read. Backend rejects any venue
outside the three.

Emailed orders now carry a **Deliver to:** line and a per-venue signoff (`OB_VENUE`). Before
this the backend email named the venue but no address and always signed off as Cambridge/Luma.
Cambridge Central's emails gain the address line too.

**Shared, by decision (Adrian, 16 Sep 2026):** rep email, cc and note in `SupplierSettings`
(facts about the supplier), and the *category* in `CategoryOverrides`. A rep email set in
one dashboard is used by the other; a category fix applies to both.

**Not shared (v11 / gs-v13, 18 Sep 2026): the supplier's ORDERING setting.** Adrian wanted
independent lists ("overall cleaner") and a way to see a supplier's spend without offering an
order — "if that supplier insists on using their proprietary ordering platform". One
per-dashboard setting with three states replaces the Visible and Portal-only ticks:

| Ordering | Order tab | Supplier page | Spend / reports / statement |
|---|---|---|---|
| **here** (default) | listed | Build order button | shown |
| **portal** | not listed | "Orders go through this supplier's own portal" | shown |
| **off** | not listed | nothing | shown |

- Cambridge Central is unchanged; its list stays in `SupplierSettings.visible` /
  `portal_only`. Glenorchy HQ **ignores both columns** and reads only `SupplierVisibility`,
  scope `glenorchy`: `supplier | scope | visible | updated_by | updated_at | ordering`.
  `ordering` sits LAST because the tab went live with the five-column header first and
  `tab_()` only extends a header in place when the old one is a strict prefix; `visible`
  is kept in step (no when off) for anyone reading the sheet. A row exists only while the
  supplier is not "here". Legacy rows with no `ordering` read as visible=no → off, and the
  backend rewrites them in full on its next write.
- Action `supplier_visibility` takes `ordering: here|portal|off` (legacy `visible: yes|no`
  still accepted as here|off). The Admin page has one **Ordering — Glenorchy HQ** column of
  three chips; rep email still posts `supplier_setting` ("Saved for everyone").
- Spend is visible in every state, on purpose: the moment a supplier vanished from the
  front page the header total would stop adding up to the table.
- **To give Cambridge Central the same:** add `cambridge` to `OB_VIS_SCOPES`, copy its
  current `visible=no` → `off` and `portal_only=yes` → `portal` rows into
  `SupplierVisibility` under that scope, port `sset()`, the load block, `saveOrdering` and
  the Admin column, and drop its `HIDE_PORTAL` chip. Nothing else moves.

**Not shared (v2, 16 Sep 2026): turned-off items.** Cambridge had turned off Naan Bread (PFD),
which Glenorchy orders constantly, and v1 hid it at Glenorchy too. Now:

- Cambridge Central is unchanged. Its "off" flags stay in the `hidden` column of
  `CategoryOverrides`, written by `category_override` / `category_bulk`.
- Glenorchy HQ **ignores** that column. Its own flags live in a new tab, `ItemVisibility`:
  `item_key | scope | supplier | description | hidden | updated_by | updated_at`, scope
  `glenorchy`, written by a new action `item_visibility`. A row exists only while an item is off;
  turning it back on deletes the row.
- The tab is created by `Orders.gs` on the first "turn off" from Glenorchy HQ. Until then the
  dashboard's fetch hits the gviz missing-tab trap, the column signature rejects it, and the load
  treats that as nothing off. Tested both ways.
- `OB_VIS_SCOPES` in `Orders.gs` lists the scopes allowed. To give Cambridge Central the same
  treatment later, add a scope and point its `bulkHide` and HIDDEN read at the new tab; its
  existing flags would need copying across first.
- Changing a shared category from Glenorchy never clears Cambridge's off flag
  (`category_bulk` only touches fields it is sent; Glenorchy never sends `hidden`). Tested.

## 3. Where the Glenorchy data is — verified live 16 Sep 2026

- `Invoices`: 551 rows venue `Red Square Glenorchy` (Cambridge 740, Luma 128).
- `ManualPurchases`: 1 Glenorchy row. The tab has three extra trailing columns
  (`entered_by`, `logged_at`, `category`); the signature check only needs the first four.
- `Sales` (pre-feed weekly totals): 173 Glenorchy rows, 02/04/2023 to 16/08/2026, so Glenorchy
  gets the same July history Cambridge does, cut at the 3 Aug cutover like Cambridge.
- `SalesFeed` categories on Glenorchy rows: `Beverage D/H`, `Beverage T/A`, `Food D/H`,
  `Food T/A`, `ImPOS`, `No Cat.`. All were in `CAT_MAP` except `No Cat.`, added as
  Uncategorised. Departments seen: Coffee / Tea, Cold Beverage D/H, Drinks T/A, Breakfast D/H,
  Kids Menu and more — these only matter if the `Overrides` tab maps them, which is shared.

## 3b. Front page = Supplier Explorer (v5, 17 Sep 2026)

Adrian preferred Supplier Explorer's front page, so the dashboard now opens on it and
ordering moved to an **Order** tab. Nothing in the ordering flow changed; it is the old
front page under a new hash (`#order`), with the builder's back link going there.

**Nav is four buttons (v9, 18 Sep): Reports · Sales · Order · Admin.** Placed orders and
Favourites are a chip row at the top of the Order tab (`orderTabs`), since they only mean
anything while ordering. Reading pair first because reporting is the primary use.

- **Range bar** in the sticky filter strip on every reading route (home, Reports, supplier
  and product drills, group drill): Week / Month / Quarter / All time, ‹ › to step, or two
  dates. One `RANGE={kind,off,from,to}` drives every card under it — the Reports chips
  (This week / 4w / 8w …) are gone. `reportRange()` is the single reader. Independent of
  `WEEK_OFF`, which is still the *ordering* week and still shows on the Order / builder /
  Placed / Favourites / Admin routes. Stepping forward past the current period is blocked
  (the books have no future); a custom range steps by its own length.
- **Front page header follows the range** (v7/v8), and **forecasts only in Week mode**
  (Adrian, 17 Sep — the countdown is a lever for the orders about to go out; over a month
  "left to spend $8k" is true and useless, and forecasting spend would presume the decision).
  A live week is the countdown as before: income forecast, 30% envelope, less invoiced +
  awaiting invoice + drafts. Any other range, and any finished week, is **the books to
  date, no forecast**: Spent (incl. awaiting invoice) · **Tally vs 30%** (30% of income to
  date minus spend to date; + under, − over, that is the amount to claw back) · Income ·
  COGS % actual. `periodModel(period,today,opts)` is the one model, `booksBar` the second
  layout; `weekModel()` (ordering routes) and `rangeModel()` (reading routes) wrap it. The
  weekday profile is the last 6 complete weeks; drafts count only while live; open orders
  count whenever their date falls in the period.
- **Catch-up chip** (v8): in the range bar in a live week, and in the ordering bar in the
  current week — the same `CATCHUP` state, so the front page and the Order tab never show
  different envelopes. Off on every load. On, it folds the calendar month's tally up to the
  day before this week (30% of income then, less invoices and open orders then) into this
  week's envelope; the Left-to-spend tile says by how much and from which dates. Resets by
  itself in a week that starts on the 1st. Not persisted — reached for, never left on.
- Then the every-supplier product search without the category chips
  (`productSearchCard({chips:false})` — the chips stay on the Order tab, and a chip picked
  there is ignored on the front page rather than silently narrowing a box that shows none), **Suppliers by spend** (sortable: name / invoices /
  total / usual-or-avg per week with ▲▼ / last invoice; footer totals; row → supplier
  drill), **Spend by group** (row → group drill).
- **Reports** keeps only the product-level cards (Top 10 purchased, Top 10 sold, Price
  creep) under the same header. The supplier and group cards it had are the front page now.
- **Supplier drill (`rsup::`) is the Supplier Explorer supplier page (v9):** weekly or
  monthly **statement** (toggle; whole periods covering the range; Invoices · Subtotal ·
  GST · Freight when any · Credits · Total; contact email), **products bought in the range**
  (Qty · Spend · Price · Was = last price before the range · Change, sortable, biggest rise
  first, turned-off items behind a chip), and **invoices in the range**. All three follow the
  range bar — Week by default, Month a click away. The 180-day catalogue view is gone from
  here; it still drives the order builder. Build order button stays.
- Same-origin note: `SUPP_SORT` etc. are page state only; nothing new in localStorage.

**Verified:** harness (259 checks — the drill against a week and a 5-week range, statement
rows and totals, products and Was/Change, invoices scoped; nav and Order chip row; a live 5-week range and a finished week in books mode with
hand-computed spend, income, tally and COGS %; the catch-up tally against an independent
computation from the fixtures, the Order tab agreeing, and off again) plus Chromium screenshots of the front page, Order tab and
Reports against the fixture data — layout holds at 1180px. **Not verified:** live data, phone
width, and the Sales tab / builder end-to-end (unchanged code, but the route table changed
around them).

## 3a. Reports tab additions (v3, 17 Sep 2026)

Reports defaults to **this week** (Cambridge Central opens on 8w). Three cards were added, all
obeying the range bar (v5; they followed the Reports chips until then). None exist in Cambridge Central yet;
the block is self-contained (`rangeProducts`, `repBoughtCard`, `repSoldCard`, `repCreepCard`)
and ports across with the `FEE` regex hoist.

- **Top 10 purchased — by spend in range.** Invoice lines grouped by the ordering key,
  across every supplier. Same `FEE` test as the catalogue strips delivery/fees, same
  `supActive` test as `spendRows` drops inactive suppliers. Line totals, so it will not
  reconcile to the supplier card to the cent — fees and GST live there. Price column is the
  latest paid in range with a ▲/▼ against the **baseline**: the last price paid before the
  range started. Nothing before the range → first price inside it is the baseline, so a
  steady price never reads as a rise. Rows open the price history.
- **Top 10 sold — in range.** Pulls the item feed for the range through the same
  `loadSalesWeek` cache the Sales tab uses (so opening Sales first makes it instant). Paid
  units only — $0 lines (loyalty, wastage) and kitchen requests excluded. Toggle by revenue /
  by units. Refuses ranges over 100 days (All time) and explains ranges before the 3 Aug cutover;
  a range straddling the cutover is clamped and says so. Neither case fetches. Tested.
- **▲▼ against usual (v12/v13, 21 Sep)** on both top-10s, beside the actual figure (Qty on
  purchased; revenue or units on sold, whichever the toggle shows), hover for the usual
  figure — a Usual column was tried and pulled as too busy. Usual is the product's rate over
  the 4 complete weeks before the range (`AVG_WEEKS`, same window as the supplier table's
  Usual/wk), scaled to the range length and **pro-rated while the range is running** — a
  Monday against a whole usual week would read ▼ on everything. ▲▼ at ±10%; blank where the
  product was not seen in those weeks. More than usual is red for purchases, green for
  sales. Sold's usual needs the feed for the prior 4 weeks: `feedFor(range)` fetches the
  range first, the prior window second (one `loadSalesWeek` at a time), and the column
  shows "…" until it lands. Sold also has **Units/day**: units over the days that actually
  traded in the range, so a Monday-morning week is not divided by seven.
- **Wastage — in range, by % wasted (v12).** The Sales tab's wastage definition (a $0 line
  in a perishable group for an item that also sold for money; `wasteRows` is shared),
  always sorted by % wasted, worst 15, red at 25%+. Sits between the top-10s and Price
  creep.
- **Price creep.** Extra paid = Σ over deliveries in range of qty × (price − baseline).
  Sorted by dollars, not percent. Rises / falls toggle; headline gives rises, falls and net.
  This is the actionable one — the top row is the phone call worth making.

**Usual/wk (v4).** "Per week" on the supplier and group cards was spend ÷ weeks, which at the
this-week default just mirrored Spend. Now Supplier Explorer's rule, the one Adrian says
works in practice: under four weeks the column is the average over the **4 complete weeks
before the range** (`usualWeek`, `AVG_WEEKS`), labelled Usual/wk, with ▲▼ when the range is
more than 10% off it; four weeks or more it stays spend ÷ weeks, labelled Avg/wk. The same
figure is a new **Usual/wk** column on the Order tab's supplier list, where "Spend so far" is
week-to-date — the note there says to read it against Sunday's number, not Tuesday's. Weeks
with no delivery count as zero weeks (a fortnightly supplier really does average half).
Differs from Supplier Explorer in one way: the window ends at the week start, not at the last
invoice, so the current partial week never dilutes its own benchmark.

**Verified:** all of the above against the harness (fixtures: a rise, a fall, a steady product, a fee
line, a $0 loyalty line, a wide range, a pre-cutover range). **Not verified:** against live
Glenorchy data — no browser or Sheets access this session. First thing to eyeball on the live
page: whether Glenorchy's invoice lines carry sensible `unit_price`/`qty` (a supplier that
invoices by the carton one week and the unit the next will show as a phantom price move; the
ordering key includes unit, so only same-unit lines compare).

## 3c. Help page (v14, 21 Sep 2026)

`#help`, reached from the **?** in the header. Written for the crew: getting around, the
date range (with the Monday note — "Week" on a Monday is a few hours, tap ‹), the header in
both modes, the front page, finding the wastage, the rest of Reports, a supplier page.
Eight annotated screenshots live in **`help/`** next to the HTML — generated from the harness's
fake data by `make-help.py` (numbered badges are injected into the DOM before each shot), so
no real figures travel with a forwarded link. **Commit the `help/` folder with the HTML**; the
harness checks every image the page references exists. Re-run `make-help.py` after any layout
change the pictures show, or the help page lies.

## 4. Same origin, separate drafts

Both dashboards are served from `guysmiley54.github.io`, so they share `localStorage`.
`ob_identity` (user + PIN) is shared on purpose. Drafts are not: a Cambridge draft under the
old key would have counted against Glenorchy's countdown, so Glenorchy HQ keeps its own key.
The harness plants a Cambridge draft and checks it is ignored.

## 5. Testing

```
npm install jsdom
node tests/test-ghq.js            # dashboard, 321 checks
node tests/test-orders-gs.js      # backend, 37 checks
```

`test-ghq.js`'s fake gviz filters the item feed by the dates in the query (the live one
does), serves an Overrides tab so two items land in Sandwiches, and carries four prior weeks
of feed for "usual". It serves every tab with rows for all three venues and checks only Glenorchy
survives: invoices, lines, manual purchases, orders, favourites, weekly Sales, daily feed, item
feed, catalogue, order text, email body, payload, and the three Reports top-10 cards. Run
against `order-builder.html` it fails, which is the point. The Cambridge Central handover's own 400/104-check suites were
never committed to the repo; these are smaller and Glenorchy-specific.

**Not tested:** anything that needs a browser — layout, the screen after a real place/send
against the live endpoint. Same "never tested end to end" caveat as Cambridge Central applies,
doubly, since no Glenorchy order has ever been placed through it.

## 6. Deploying a change

**Deployed 18 Sep 09:04:** `gs-v12-0830` verified live via `/exec` (build reported, both
visibility actions listed) and `ghq-v10-0830` verified on Pages against real data — 492
invoices, no load warnings, no JS errors across every route. **`gs-v13` is the next paste.**

Same as Cambridge Central. A change to `Orders.gs` is three steps, none of which does the
others: commit to the repo, paste into the Apps Script editor, **Deploy → New version**. The
deployment is shared, so a new version goes live for Cambridge Central at the same moment.
`doGet` on the `/exec` URL reports `build`; if it does not say `gs-v13-…` the deployment is
stale.
