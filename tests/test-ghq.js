/* Glenorchy HQ harness. Runs the real page in jsdom against a fake gviz server whose tabs
   carry rows for ALL THREE venues, and checks that only Red Square Glenorchy survives. */
const fs=require("fs"), {JSDOM}=require("jsdom");
const FILE=process.argv[2]||"/home/claude/ghq/glenorchy-hq.html";
let PASS=0,FAIL=0;
const ok=(n,c,x)=>{ if(c){PASS++;console.log("  ok   "+n);} else {FAIL++;console.log("  FAIL "+n+(x!==undefined?"  ["+JSON.stringify(x)+"]":""));} };
const pad=n=>String(n).padStart(2,"0");
const iso=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const today=new Date(); today.setHours(12,0,0,0);
const dm=(n)=>{const d=new Date(today); d.setDate(d.getDate()-n); return d;};
// this week's Monday
const mon=new Date(today); mon.setDate(mon.getDate()-((mon.getDay()+6)%7));
const wd=(n)=>{const d=new Date(mon); d.setDate(d.getDate()+n); return d;};
const q=v=>'"'+String(v).replace(/"/g,'""')+'"';
const csv=(head,rows)=>[head,...rows].map(r=>r.map(q).join(",")).join("\n");

const G="Red Square Glenorchy", C="Red Square Cambridge", L="Luma Kitchen";
const TABS={
  Invoices: csv(["invoice_number","invoice_date","total","subtotal","gst","supplier","venue","category","type","source","scanned"],[
    ["G1", iso(wd(0)), "330.00","300.00","30.00","Doppio Foods",G,"Beverage","invoice","email",iso(wd(0))+" 09:00:00"],
    ["G2", iso(wd(1)), "200.00","200.00","0.00","Fresh Cut",G,"Food","invoice","email",iso(wd(1))+" 09:00:00"],
    ["G3", iso(wd(-20)),"150.00","150.00","0.00","Fresh Cut",G,"Food","invoice","email",iso(wd(-20))+" 09:00:00"],
    ["G9", iso(wd(0)), "400.00","400.00","0.00","TasWaste",G,"Waste Management","invoice","email",iso(wd(0))+" 09:00:00"],
    ["G4", iso(wd(-10)),"96.00","96.00","0.00","PFD Food Services",G,"Food","invoice","email",iso(wd(-10))+" 09:00:00"],
    ["G5", iso(wd(-29)),"90.00","90.00","0.00","Fresh Cut",G,"Food","invoice","email",iso(wd(-29))+" 09:00:00"],   // outside the 4-week window
    ["G6", iso(wd(-25)),"220.00","220.00","0.00","Doppio Foods",G,"Beverage","invoice","email",iso(wd(-25))+" 09:00:00"],
    ["C1", iso(wd(0)), "999.00","900.00","99.00","Doppio Foods",C,"Beverage","invoice","email",iso(wd(0))+" 09:00:00"],
    ["L1", iso(wd(1)), "555.00","555.00","0.00","Fresh Cut",L,"Food","invoice","email",iso(wd(1))+" 09:00:00"]
  ]),
  InvoiceLines: csv(["invoice_number","description","line_total","supplier","venue","item_code","qty","unit","unit_price"],[
    ["G1","Blend Beans 1kg","300.00","Doppio Foods",G,"BB1","3","kg","100.00"],
    ["G2","Bananas","100.00","Fresh Cut",G,"","10","kg","10.00"],
    ["G2","Peas","100.00","Fresh Cut",G,"","5","kg","20.00"],
    ["G3","Bananas","150.00","Fresh Cut",G,"","15","kg","10.00"],
    ["G4","Naan Bread","96.00","PFD Food Services",G,"","24","ea","4.00"],
    ["G5","Peas","90.00","Fresh Cut",G,"","5","kg","18.00"],
    ["G6","Blend Beans 1kg","220.00","Doppio Foods",G,"BB1","2","kg","110.00"],
    ["G1","Delivery Fee","15.00","Doppio Foods",G,"","1","ea","15.00"],
    ["C1","Blend Beans 1kg","900.00","Doppio Foods",C,"BB1","9","kg","100.00"],
    ["C1","Cambridge Only Widget","0.00","Doppio Foods",C,"CW1","1","ea","0.00"],
    ["L1","Luma Only Lettuce","555.00","Fresh Cut",L,"","5","kg","111.00"]
  ]),
  SupplierConfig: csv(["supplier","merge_into","group","active"],[["Doppio Foods","","Beverage","yes"],["Fresh Cut","","Food","yes"],["TasWaste","","Waste Management","yes"],["PFD Food Services","","Food","yes"]]),
  ProductMerge: csv(["supplier","match","into"],[]),
  ManualPurchases: csv(["date","shop","venue","amount"],[[iso(wd(1)),"Woolworths",G,"50.00"],[iso(wd(1)),"Woolworths",C,"7000.00"]]),
  Orders: csv(["order_id","action","supplier","venue","order_date","subtotal","gst","total","channel","placed_by","note","logged_at","delivery_date"],[
    ["og1","place","Fresh Cut",G,iso(wd(2)),"80","0","80","email","Tam","",iso(wd(2))+" 08:00:00",iso(wd(3))],
    ["oc1","place","Fresh Cut",C,iso(wd(2)),"5000","0","5000","email","Ange","",iso(wd(2))+" 08:00:00",iso(wd(3))]
  ]),
  OrderLines: csv(["order_id","line_no","item_code","description","unit","qty","unit_price","line_total"],[
    ["og1","1","","Bananas","kg","8","10","80"],["oc1","1","","Bananas","kg","500","10","5000"]]),
  SupplierSettings: csv(["supplier","rep_email","visible","portal_only","cc","note"],[["Fresh Cut","rep@freshcut.example","no","no","",""]]),
  SupplierVisibility: null,   // per run: present (Doppio off here, PFD off for a foreign scope) or absent (gviz trap)
  Favourites: csv(["fav_id","fav_name","venue","supplier","created_by","created_at"],[["f1","Glen weekly",G,"Fresh Cut","Tam",""],["f2","Camb weekly",C,"Fresh Cut","Ange",""]]),
  FavouriteLines: csv(["fav_id","line_no","item_key","description","unit","qty","supplier"],[["f1","1","x","Bananas","kg","4","Fresh Cut"],["f2","1","x","Bananas","kg","40","Fresh Cut"]]),
  CategoryOverrides: null,     // built per run once the page can compute product keys
  ItemVisibility: null,
  // pre-feed weekly totals, week ENDING Sunday. One week in July (pre-cutover) for all three venues,
  // plus the overlap weeks up to 16 Aug that must be cut.
  Sales: csv(["Date","Venue","Sales","Wages"],[
    ["12/07/2026",G,"7,000.00","2,000"],["12/07/2026",C,"70,000.00","2,000"],["12/07/2026",L,"7,000.00","2,000"],
    ["16/08/2026",G,"70,000.00","2,000"],["16/08/2026",C,"70,000.00","2,000"]
  ])
};
// SalesFeed daily rollup (select B,C,sum(H)) and the item query (select A,C,D,E,F,G,H)
const feedDaily=csv(["date","venue","sales"],[
  [iso(wd(0)),G,"1000"],[iso(wd(1)),G,"1200"],[iso(wd(0)),C,"9000"],[iso(wd(0)),L,"9000"],
  ...[1,2,3,4,5,6].flatMap(w=>[0,1,2,3,4,5,6].map(d=>[iso(wd(d-7*w)),G,"1000"])),   // 6 prior weeks, Glenorchy
  ...[1,2,3,4,5,6].flatMap(w=>[0,1,2,3,4,5,6].map(d=>[iso(wd(d-7*w)),C,"9000"])),
  ["2026-08-10",G,"500"],["2026-08-04",G,"500"]   // inside the overlap fortnight
]);
const feedItems=csv(["timestamp","venue","category","department","item","qty","sales"],[
  [iso(wd(0))+" 08:15:00",G,"Beverage D/H","Coffee / Tea","Flat White","20","100"],
  [iso(wd(0))+" 09:15:00",G,"Beverage D/H","Coffee / Tea","Flat White","2","0"],
  [iso(wd(0))+" 12:15:00",G,"Food T/A","Takeaway","Ham Roll","5","50"],
  [iso(wd(0))+" 12:20:00",G,"No Cat.","","Mystery Item","1","9"],
  [iso(wd(0))+" 08:15:00",C,"Beverage D/H","Coffee","Cambridge Latte","200","1000"],
  [iso(wd(0))+" 08:15:00",L,"Luma Food D/H","Luma Kitchen","Luma Bowl","200","1000"]
]);

function serve(url){
  const u=new URL(url); const sheet=u.searchParams.get("sheet"); const tq=u.searchParams.get("tq")||"";
  if(sheet==="SalesFeed"){ if(/select B, C, sum\(H\)/.test(tq)) return feedDaily; if(/select A,C,D,E,F,G,H/.test(tq)) return feedItems; return feedItems; }
  if(sheet==="Overrides"||sheet==="ItemMap") return TABS.Invoices;   // the gviz trap: wrong tab, HTTP 200
  if(TABS[sheet]!=null) return TABS[sheet];
  return TABS.Invoices;   // gviz trap for anything unknown
}

async function run(withVis){
  console.log(withVis?"\n-- run: ItemVisibility tab present":"\n-- run: ItemVisibility tab not created yet (gviz trap)");
  const html=fs.readFileSync(FILE,"utf8");
  const POSTS=[], FETCHES=[];
  const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://guysmiley54.github.io/red-square-dashboard/glenorchy-hq.html",
    beforeParse(w){ w.__OB_NO_AUTOLOAD=true;
      w.fetch=async(url,opts)=>{ FETCHES.push(String(url)); if(/script\.google\.com/.test(url)){ POSTS.push(JSON.parse(opts.body)); } if(/script\.google\.com/.test(url)) return {ok:true,text:async()=>JSON.stringify({ok:true,order_id:"x"}),json:async()=>({ok:true,order_id:"x"})};
        const t=serve(url); return {ok:true,text:async()=>t,json:async()=>({})}; };
      w.alert=()=>{}; w.confirm=()=>true;
      // a leftover Cambridge Central draft on the SAME origin — must not count here
      w.localStorage.setItem("ob_identity",JSON.stringify({user:"Test",pin:"1"}));
      w.localStorage.setItem("ob3_drafts",JSON.stringify({"Red Square Cambridge::Fresh Cut":{supplier:"Fresh Cut",tag:"Red Square Cambridge",qty:{"fresh cut||bananas|kg":999},note:""}}));
    }});
  const w=dom.window; await new Promise(r=>setTimeout(r,300));
  const ev=s=>w.eval(s);
  const key=(sup,desc,unit)=>ev(`prodKey(${JSON.stringify(sup)},"",${JSON.stringify(desc)},${JSON.stringify(unit)})`);
  const NAAN=key("PFD Food Services","Naan Bread","ea"), BAN=key("Fresh Cut","Bananas","kg"), PEAS=key("Fresh Cut","Peas","kg");
  // Cambridge Central turned Naan off and gave it a category; the category must apply here, the "off" must not
  TABS.CategoryOverrides=csv(["item_key","supplier","description","category","hidden","updated_by","updated_at"],
    [[NAAN,"PFD Food Services","Naan Bread","Bakery","yes","Ange",""],[PEAS,"Fresh Cut","Peas","","yes","Ange",""]]);
  TABS.SupplierVisibility=withVis?csv(["supplier","scope","visible","updated_by","updated_at"],
    [["Doppio Foods","glenorchy","no","Tam",""],["PFD Food Services","cambridge","no","x",""]]):null;
  TABS.ItemVisibility=withVis?csv(["item_key","scope","supplier","description","hidden","updated_by","updated_at"],
    [[BAN,"glenorchy","Fresh Cut","Bananas","yes","Tam",""],[PEAS,"cambridge","Fresh Cut","Peas","yes","x",""]]):null;
  ok("title is Glenorchy HQ", w.document.title==="Glenorchy HQ");
  ok("header h1", w.document.querySelector("header h1").textContent==="Glenorchy HQ");
  ok("build id", /^ghq-v\d+-/.test(ev("BUILD_ID")), ev("BUILD_ID"));
  ok("draft key is not Cambridge's", ev("DRAFT_KEY")==="ghq_drafts");
  await ev("loadAll()"); await new Promise(r=>setTimeout(r,200));
  ok("no load error", !w.document.querySelector(".err"), (w.document.querySelector(".err")||{}).textContent);
  const INV=ev("INV"), LINES=ev("LINES"), ORDERS=ev("ORDERS"), FAVS=ev("FAVS"), SALES=ev("SALES");
  ok("INV: only Glenorchy", INV.length>0 && INV.every(r=>r.venue===G), INV.map(r=>r.number+"@"+r.venue));
  ok("INV: non-COGS dropped", !INV.some(r=>r.supplier==="TasWaste"));
  ok("INV: manual purchase kept, Cambridge one dropped", INV.filter(r=>r.supplier==="Woolworths").map(r=>r.total).join()==="50");
  ok("LINES: only Glenorchy", LINES.length===8 && LINES.every(r=>r.venue===G), LINES.map(r=>r.desc+"@"+r.venue));
  ok("ORDERS: Cambridge order excluded", ORDERS.length===1 && ORDERS[0].id==="og1", ORDERS.map(o=>o.id));
  ok("FAVS loaded both, scoped at render", FAVS.length===2);
  const pre=SALES.filter(r=>r.weekly); const cut=new Date(2026,7,3);   // local midnight, like gvizDate
  ok("SALES pre-feed: only Glenorchy", pre.length>0 && pre.every(r=>r.venue===G), [...new Set(pre.map(r=>r.venue))]);
  ok("SALES pre-feed: overlap weeks cut at cutover", pre.every(r=>r.date<cut), pre.filter(r=>r.date>=cut).length);
  ok("SALES pre-feed: 7000/7 per day", Math.abs(pre.reduce((t,r)=>t+r.sales,0)-7000)<0.01, pre.reduce((t,r)=>t+r.sales,0));
  const feed=SALES.filter(r=>!r.weekly);
  ok("SALES feed: only Glenorchy", feed.every(r=>r.venue===G));
  ok("SALES feed: nothing before cutover", feed.every(r=>r.date>=cut));
  ok("tag picker empty", w.document.getElementById("tagpick").innerHTML==="");
  ok("TAG is Glenorchy", ev("TAG.name")===G && ev("TAG.addr")==="3/2 Howard Road, Glenorchy TAS 7010");
  // countdown: Cambridge draft in shared origin storage must not count
  ok("Cambridge draft ignored", ev("allDraftTotal()")===0, ev("allDraftTotal()"));
  // ---- front page: the Supplier Explorer layout, this week by default
  const app=()=>w.document.getElementById("app");
  const cardByLabel=t=>[...app().querySelectorAll(".card")].find(c=>(c.querySelector(".label")||{}).textContent.indexOf(t)>-1);
  const rowsOf=c=>[...c.querySelectorAll("tbody tr")].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
  ev("location.hash=''; route()");
  const home=app().textContent;
  ok("home mentions Glenorchy, not Cambridge", /Glenorchy/.test(home) && !/Cambridge|Luma|both kitchens/.test(home));
  ok("home: range bar in the filter strip, Week on", /Week.*Month.*Quarter.*All time/.test(w.document.getElementById("filters").textContent) && ev("RANGE.kind")==="week" && ev("RANGE.off")===0);
  ok("home: countdown header kept, ordering list moved out", /Left to spend/.test(home) && !/Start an order/.test(home));
  {
    const sc=cardByLabel("Find a product");
    ok("home search: no category chips", sc && !sc.querySelector(".chip") && !/pick a category/.test(sc.textContent), sc&&sc.textContent.slice(0,120));
    // a category picked on the Order tab must not silently narrow the chip-less box
    ev("GCAT_FILT='Bakery'; GSEARCH='ba'; route()"); await new Promise(r=>setTimeout(r,30));
    const hits=rowsOf(cardByLabel("Find a product")).map(r=>r[0]);
    ok("home search ignores the Order tab's category filter", hits.some(h=>/Bananas/.test(h)), hits);
    ev("GCAT_FILT=''; GSEARCH=''; route()"); await new Promise(r=>setTimeout(r,30));
  }
  {
    const tiles=[...app().querySelectorAll(".summary .tile")].map(t=>t.textContent.replace(/\s+/g," ").trim());
    // this ordering week: spent G1 330 + G2 200 + manual 50 = 580; income 1000+1200
    ok("home header: spent $580, income $2,200, projected COGS", tiles.length===4 && /Spent so far — this week \$580\b/.test(tiles[0]) && /Left to spend/.test(tiles[1]) && /Income — this week \$2,200/.test(tiles[2]) && /COGS %/.test(tiles[3]), tiles);
    const card=cardByLabel("Suppliers by spend");
    ok("home: suppliers card labelled with the week", card && /\(this week\)/.test(card.querySelector(".label").textContent), card&&card.querySelector(".label").textContent);
    const rows=rowsOf(card);
    ok("home: sorted by total — Doppio, Fresh Cut, Woolworths", rows.map(r=>r[0].replace(/\s*(Beverage|Food)$/,"")).join("|")==="Doppio Foods|Fresh Cut|Woolworths", rows.map(r=>r[0]));
    ok("home: header says Usual/wk at 1w", /Usual\/wk/.test(card.querySelector("thead").textContent));
    const dop=rows.find(r=>r[0].startsWith("Doppio")), fc=rows.find(r=>r[0].startsWith("Fresh Cut")), ww=rows.find(r=>r[0].startsWith("Woolworths"));
    ok("home: Doppio 1 invoice, $330 vs usual $55 ▲", dop&&dop[1]==="1"&&dop[2]==="$330.00"&&/\$55\.00\s*▲/.test(dop[3]), dop);
    ok("home: Fresh Cut $200 vs usual $37.50 ▲", fc&&/\$37\.50\s*▲/.test(fc[3]), fc);
    ok("home: Woolworths no history → — and no arrow", ww&&/^—$/.test(ww[3]), ww);
    ok("home: footer totals $580", /\$580\.00/.test(card.querySelector("tfoot").textContent));
    ok("home: note explains the 4-week benchmark", /4 full weeks before/.test(card.textContent));
    ok("home: rows open the supplier drill", /rsup::/.test(card.innerHTML));
    const gcard=cardByLabel("Spend by group");
    const grows=rowsOf(gcard); const bev=grows.find(r=>r[0]==="Beverage");
    ok("home groups: Beverage usual $55 ▲", bev&&/\$55\.00\s*▲/.test(bev[2]), grows);
    ev("sortSuppliers('name')"); await new Promise(r=>setTimeout(r,30));
    ok("home: sort by name", rowsOf(cardByLabel("Suppliers by spend"))[0][0].startsWith("Doppio") && rowsOf(cardByLabel("Suppliers by spend"))[2][0].startsWith("Woolworths"));
    ev("sortSuppliers('spend')"); ev("sortSuppliers('spend')"); await new Promise(r=>setTimeout(r,30));   // back to spend desc
    // 8 whole weeks as a custom range: the column is the range's own average, no arrows
    ev(`RANGE={kind:"custom",off:0,from:"${iso(wd(-49))}",to:"${iso(wd(6))}"}; renderFilters(); route()`); await new Promise(r=>setTimeout(r,30));
    const card8=cardByLabel("Suppliers by spend"); const rows8=rowsOf(card8);
    const dop8=rows8.find(r=>r[0].startsWith("Doppio"));
    ok("8w custom: header says Avg/wk, Doppio (330+220)/8 = $68.75, no arrow", /Avg\/wk/.test(card8.querySelector("thead").textContent) && dop8&&dop8[3]==="$68.75", dop8);
    ok("8w custom: note says spend ÷ 8 weeks", /spend ÷ 8 weeks/.test(card8.textContent));
    // stepping a custom range moves it by its own length
    ev("shiftRange(-1)"); await new Promise(r=>setTimeout(r,30));
    ok("custom range steps back by its own length", ev("RANGE.from")===iso(wd(-105)) && ev("RANGE.to")===iso(wd(-50)), [ev("RANGE.from"),ev("RANGE.to")]);
    ev("setRangeKind('week')"); await new Promise(r=>setTimeout(r,30));
    ev("shiftRange(1)"); ok("no future weeks", ev("RANGE.off")===0);
    ev("shiftRange(-1)"); await new Promise(r=>setTimeout(r,30));
    ok("last week: label says so, Doppio absent (nothing bought)", /\(last week\)/.test(cardByLabel("Suppliers by spend").querySelector(".label").textContent) && !rowsOf(cardByLabel("Suppliers by spend")).some(r=>r[0].startsWith("Doppio")));
    ev("setRangeKind('all')"); await new Promise(r=>setTimeout(r,30));
    ok("all time: label, every Glenorchy supplier, ‹ › hidden", /all captured data/.test(cardByLabel("Suppliers by spend").querySelector(".label").textContent) && rowsOf(cardByLabel("Suppliers by spend")).length===4 && !/‹/.test(w.document.getElementById("filters").textContent), rowsOf(cardByLabel("Suppliers by spend")).map(r=>r[0]));
    // ---- the header follows the range (Adrian, 17 Sep): a 5-week custom range in progress
    const tile=i=>[...app().querySelectorAll(".summary .tile")][i].textContent.replace(/\s+/g," ").trim();
    ev(`RANGE={kind:"custom",off:0,from:"${iso(wd(-28))}",to:"${iso(wd(6))}"}; renderFilters(); route()`); await new Promise(r=>setTimeout(r,30));
    // spend: this week 580 + G3 150 + G4 96 + G6 220 = 1,046 (G5 at −29d is outside); income: 28 past days × 1000 + 2,200
    // books mode: no forecast. spent 1,046 + og1 80 awaiting invoice = 1,126; income 30,200 to date
    ok("5w live: Spent to date $1,126 (incl. $80 awaiting invoice), no forecast", /^Spent — .*\$1,126 .*awaiting invoice.*to date/.test(tile(0)) && !/Forecast/.test(app().textContent), tile(0));
    ok("5w live: tally = 30% × 30,200 − 1,126 = +$7,934 under so far", /^Tally vs 30%.*\+\$7,934 .*\$9,060 allowed.*under so far/.test(tile(1)), tile(1));
    ok("5w live: income $30,200 to date, no forecast", /^Income — .*\$30,200 to date, no forecast/.test(tile(2)), tile(2));
    ok("5w live: COGS % actual 3.5%, not projected", /^COGS % vs 30% 3\.5%/.test(tile(3)), tile(3));
    // a finished week: budget minus actual is the tally to carry forward
    ev(`RANGE={kind:"custom",off:0,from:"${iso(wd(-14))}",to:"${iso(wd(-8))}"}; renderFilters(); route()`); await new Promise(r=>setTimeout(r,30));
    ok("past week: Spent $96, 1 invoice, not 'to date'", /^Spent — .*\$96 1 invoice\(s\)$/.test(tile(0)), tile(0));
    ok("past week: tally = 30% of $7,000 − $96 = +$2,004 under", /\+\$2,004 .*\$2,100 allowed.*under$/.test(tile(1)), tile(1));
    ok("past week: income $7,000, period complete", /\$7,000 period complete/.test(tile(2)), tile(2));
    ok("past week: COGS % 1.4%", /^COGS % vs 30% 1\.4%/.test(tile(3)), tile(3));
    ev("resetRange()"); await new Promise(r=>setTimeout(r,30));
    ok("back to this week: countdown again", /^Spent so far — this week/.test(tile(0)) && /Forecast/.test(tile(2)), tile(0));
    // ---- catch-up: the month's tally up to the Sunday before this week, folded into the envelope
    ok("catch-up chip present in a live week, off", /catch-up/.test(w.document.getElementById("filters").textContent) && ev("CATCHUP")===false);
    ev("setRangeKind('month')"); ok("no catch-up chip outside week mode", !/catch-up/.test(w.document.getElementById("filters").textContent));
    ev("setRangeKind('week')"); const rem0=ev("weekModel().remaining"); ev("toggleCatchup()"); await new Promise(r=>setTimeout(r,30));
    {
      const m0=new Date(mon.getFullYear(),mon.getMonth(),1), dayBefore=wd(-1);
      // fixture income is 1,000 on every day wd(-42)..wd(-1); spend is the fixture invoices in the window
      let days=0; for(let d=new Date(m0); d<=dayBefore; d.setDate(d.getDate()+1)) if(d>=wd(-42)) days++;
      const spendIn=[[wd(-20),150],[wd(-10),96],[wd(-25),220],[wd(-29),90]].filter(([d])=>d>=m0&&d<=dayBefore).reduce((a,[,v])=>a+v,0);
      const expect=days*1000*0.3-spendIn;
      const cu=ev("weekModel().catchup");
      ok("catch-up tally = 30% of month income before this week − spend then", cu && Math.abs(cu.tally-expect)<1e-6, [cu&&cu.tally,expect,days,spendIn]);
      ok("catch-up moves left-to-spend by the tally", Math.abs(ev("weekModel().remaining")-(rem0+expect))<1e-6, [ev("weekModel().remaining"),rem0,expect]);
      ok("tile explains the catch-up", new RegExp(expect<0?"less \\$.* over from":"plus \\$.* under from").test(tile(1)) || Math.abs(expect)<0.5, tile(1));
      ok("Order tab sees the same envelope", (()=>{ ev("go('order')"); return Math.abs(ev("weekModel().remaining")-(rem0+expect))<1e-6 && /catch-up on/.test(w.document.getElementById("filters").textContent); })());
      ev("toggleCatchup(); location.hash=''; route()"); await new Promise(r=>setTimeout(r,30));
      ok("catch-up off again: left to spend back where it was", Math.abs(ev("weekModel().remaining")-rem0)<1e-6);
    }
  }
  // ---- nav: one button per job; Placed and Favourites live inside the Order tab
  {
    const nav=[...w.document.querySelectorAll("header a.hbtn")].map(a=>a.textContent.trim());
    ok("header is Reports · Sales · Order · Admin", nav.join("|")==="Reports|Sales|Order|Admin", nav);
  }
  // ---- supplier drill: the Explorer page, everything for the range (this week)
  {
    ev("go('rsup::Fresh%20Cut')"); await new Promise(r=>setTimeout(r,30));
    if(withVis){
      const p1=rowsOf(cardByLabel("Products ("));
      ok("drill: turned-off Bananas hidden by default, chip offers it", p1.length===1 && /show 1 turned-off/.test(cardByLabel("Products (").textContent), p1.map(r=>r[0]));
      ev("SHOW_HIDDEN=true; route()"); await new Promise(r=>setTimeout(r,30));
    }
    const st=cardByLabel("Weekly statement");
    ok("drill: weekly statement card, contact email", st && /rep@freshcut\.example/.test(st.textContent), st&&st.textContent.slice(0,80));
    const srows=rowsOf(st);
    ok("drill: one week row — 1 invoice, $200, total shown $200", srows.length===2 && srows[0][1]==="1" && srows[0][5]==="$200.00" && /Total shown.*\$200\.00/.test(srows[1].join(" ")), srows);
    const pc=cardByLabel("Products (");
    const prows=rowsOf(pc);
    ok("drill: products in the range only — Peas and Bananas, not Luma lettuce", prows.length===2 && prows.every(r=>/Peas|Bananas/.test(r[0])), prows.map(r=>r[0]));
    ok("drill: sorted by change — Peas ▲ 11.1% first, Bananas no change", /^Peas/.test(prows[0][0]) && /▲ 11\.1%/.test(prows[0][6]) && /—/.test(prows[1][6]), prows);
    ok("drill: Peas 'was' $18.00 from before the range", prows[0][5]==="$18.00", prows[0]);
    const ic=cardByLabel("Invoices — Fresh Cut");
    ok("drill: invoices scoped to the range — only G2", ic && /1 invoice\(s\), \$200\.00/.test(ic.textContent) && !/G3|G5/.test(ic.innerHTML), ic&&ic.textContent.slice(0,60));
    ev("setStmt('month')"); await new Promise(r=>setTimeout(r,30));
    ok("drill: month toggle relabels the statement", !!cardByLabel("Monthly statement"));
    ev("setStmt('week')");
    // widen to 5 weeks: G3 (−20d) joins, G5 (−29d) does not
    ev(`RANGE={kind:"custom",off:0,from:"${iso(wd(-28))}",to:"${iso(wd(6))}"}; renderFilters(); route()`); await new Promise(r=>setTimeout(r,30));
    const st5=rowsOf(cardByLabel("Weekly statement"));
    ok("drill 5w: two week rows, total shown $350", st5.length===3 && /\$350\.00/.test(st5[2].join(" ")), st5);
    ok("drill 5w: invoices G2 and G3, $350", /2 invoice\(s\), \$350\.00/.test(cardByLabel("Invoices — Fresh Cut").textContent));
    const p5=rowsOf(cardByLabel("Products ("));
    const ban5=p5.find(r=>/^Bananas/.test(r[0]));
    ok("drill 5w: Bananas 25 kg, $250 across both invoices", ban5 && ban5[2]==="25" && ban5[3]==="$250.00", ban5);
    ev("SHOW_HIDDEN=false; resetRange()"); await new Promise(r=>setTimeout(r,30));
  }
  // ---- Order tab: the old front page
  ev("go('order')"); await new Promise(r=>setTimeout(r,30));
  const order=app().textContent;
  ok("order tab: chip row Order · Placed orders · Favourites", /Order\s*Placed orders\s*Favourites/.test(order.replace(/\s+/g," ")), order.slice(0,200));
  // ---- supplier visibility is this dashboard's own list
  {
    const names=ev("supplierList().filter(s=>s.orderable).map(s=>s.name)");
    ok("Cambridge's visible=no on Fresh Cut ignored — Fresh Cut orderable", names.indexOf("Fresh Cut")>-1, names);
    ok(withVis?"Doppio off here (SupplierVisibility, scope glenorchy)":"no tab yet — Doppio orderable", (names.indexOf("Doppio Foods")>-1)!==withVis, names);
    ok("PFD off under a foreign scope — still orderable here", names.indexOf("PFD Food Services")>-1, names);
    ok("hidden supplier still counts in spend", ev("spendRows(reportRange()).sup.some(x=>x.name==='Doppio Foods')"));
    const n0=POSTS.length;
    await ev("saveSupplier('Fresh Cut','visible','no')");
    const vp=POSTS[POSTS.length-1]||{};
    ok("Admin untick posts supplier_visibility, scope glenorchy", POSTS.length===n0+1 && vp.action==="supplier_visibility" && vp.scope==="glenorchy" && vp.supplier==="Fresh Cut" && vp.visible==="no", vp);
    ok("no supplier_setting sent for visible", !POSTS.slice(n0).some(x=>x.action==="supplier_setting"));
    ok("Fresh Cut now off locally", ev("!sset('Fresh Cut').visible"));
    await ev("saveSupplier('Fresh Cut','visible','yes')");
    ok("tick back on", ev("sset('Fresh Cut').visible") && POSTS[POSTS.length-1].visible==="yes");
    await ev("saveSupplier('Fresh Cut','rep_email','new@x.example')");
    ok("rep email still goes to the shared supplier_setting", POSTS[POSTS.length-1].action==="supplier_setting" && POSTS[POSTS.length-1].field==="rep_email");
  }
  ok("order tab: ordering list with countdown", /Start an order — Red Square Glenorchy/.test(order) && /Left to spend/.test(order));
  ok("order tab: week stepper in the filter strip, no range chips", /Tag: Glenorchy/.test(w.document.getElementById("filters").textContent) && !/Quarter/.test(w.document.getElementById("filters").textContent));
  ok("order tab shows income 2,200 (this week, Glenorchy only)", /Income — this week[\s\S]{0,30}\$2,200/.test(order), order.match(/Income — this week[\s\S]{0,80}/)&&order.match(/Income — this week[\s\S]{0,80}/)[0]);
  ok("order tab spend 580", /\$580\b/.test(order), (order.match(/\$5\d\d/g)||[]).slice(0,3));
  ok("order tab search keeps the category chips", !![...app().querySelectorAll(".card")].find(c=>/Find a product/.test((c.querySelector(".label")||{}).textContent)&&c.querySelector(".chip")));
  // usual/wk = 4 full weeks before this one ÷ 4: Fresh Cut 150 (G5 at −29d is outside), Doppio 220, PFD 96
  const sl=ev("supplierList()"), usualOf=n=>(sl.find(x=>x.name===n)||{}).usualWk;
  ok("usual/wk: Fresh Cut 37.50", Math.abs(usualOf("Fresh Cut")-37.5)<1e-9, usualOf("Fresh Cut"));
  ok("usual/wk: Doppio 55.00", Math.abs(usualOf("Doppio Foods")-55)<1e-9, usualOf("Doppio Foods"));
  ok("usual/wk: PFD 24.00 (G5 at −29d excluded)", Math.abs(usualOf("PFD Food Services")-24)<1e-9, usualOf("PFD Food Services"));
  ok("order tab shows Usual/wk column", /Usual\/wk/.test(order) && /\$37\.50/.test(order) && (withVis||/\$55\.00/.test(order)));
  // ---- turned-off items are per dashboard ----
  const naan=ev(`deriveCatalogue(LINES,"PFD Food Services",new Date()).find(p=>p.desc==="Naan Bread")`);
  ok("Naan: Cambridge's 'off' ignored", naan && naan.hidden===false, naan&&naan.hidden);
  ok("Naan: shared category still applies", naan && naan.cat==="Bakery", naan&&naan.cat);
  const fc=ev(`deriveCatalogue(LINES,"Fresh Cut",new Date())`);
  const byDesc=d=>fc.find(p=>p.desc===d)||{};
  ok("Peas: Cambridge 'off' and a foreign scope both ignored", byDesc("Peas").hidden===false);
  ok(withVis?"Bananas: Glenorchy 'off' honoured":"Bananas: no tab yet, nothing off", byDesc("Bananas").hidden===withVis);
  ev(`SUPPLIER="PFD Food Services"; PICKED={}; PICKED[${JSON.stringify(NAAN)}]=true;`);
  await ev(`bulkHide(true)`);
  const vp=POSTS[POSTS.length-1]||{};
  ok("turn off posts item_visibility, scope glenorchy", vp.action==="item_visibility"&&vp.scope==="glenorchy", vp.action+"/"+vp.scope);
  ok("turn off payload carries no category", vp.items&&vp.items.length===1&&vp.items[0].hidden==="yes"&&!("category" in vp.items[0]), vp.items);
  ok("no category_bulk was sent", !POSTS.some(x=>x.action==="category_bulk"));
  ok("Naan now off locally", ev(`HIDDEN[${JSON.stringify(NAAN)}]===true`));
  ev(`SHOW_HIDDEN=true; PICKED={}; PICKED[${JSON.stringify(NAAN)}]=true;`);
  await ev(`bulkHide(false)`);
  ok("turn back on posts hidden=no", (POSTS[POSTS.length-1].items||[])[0].hidden==="no");
  ok("Naan back on locally", ev(`!HIDDEN[${JSON.stringify(NAAN)}]`));
  ev(`SHOW_HIDDEN=false; SUPPLIER="";`);
  // catalogue for Fresh Cut: Glenorchy lines only
  const cat=ev(`deriveCatalogue(LINES,"Fresh Cut",new Date(),{venue:"${G}"}).map(p=>p.desc)`);
  ok("catalogue: Glenorchy products only", cat.indexOf("Bananas")>-1 && cat.indexOf("Luma Only Lettuce")===-1, cat);
  const catAll=ev(`deriveCatalogue(LINES,"Doppio Foods",new Date(),{venue:null}).map(p=>p.desc)`);
  ok("venue:null still never reaches Cambridge", catAll.indexOf("Cambridge Only Widget")===-1, catAll);
  // draft + order text
  ev(`SUPPLIER="Fresh Cut"; const k=deriveCatalogue(LINES,"Fresh Cut",new Date()).find(p=>p.desc==="Bananas").key; setQty("Fresh Cut",k,3);`);
  const txt=ev(`orderText("Fresh Cut",{prices:true})`);
  ok("order text: Glenorchy address", /Deliver to: 3\/2 Howard Road, Glenorchy TAS 7010/.test(txt), txt.split("\n").slice(0,4));
  ok("order text: tagged Glenorchy", /Order — Red Square Glenorchy/.test(txt));
  const body=ev(`orderEmailBody("Fresh Cut")`);
  ok("email body: Glenorchy signoff, no Luma", /Red Square Cafe Glenorchy/.test(body) && !/Luma/.test(body), body.split("\n").slice(-4));
  const pay=ev(`JSON.stringify(buildPayload("place"))`);
  ok("payload venue is Glenorchy", JSON.parse(pay).venue===G);
  ok("draft stored under ghq key", JSON.parse(w.localStorage.getItem("ghq_drafts")||"{}")[G+"::Fresh Cut"]!==undefined);
  ok("Cambridge draft untouched", JSON.parse(w.localStorage.getItem("ob3_drafts"))["Red Square Cambridge::Fresh Cut"].qty["fresh cut||bananas|kg"]===999);
  // favourites view scoped
  ev(`go('favs')`); await new Promise(r=>setTimeout(r,50));
  const favs=w.document.getElementById("app").textContent;
  ok("favourites: Glen only", /Glen weekly/.test(favs) && !/Camb weekly/.test(favs));
  // placed
  ev(`go('placed')`); await new Promise(r=>setTimeout(r,50));
  const placed=w.document.getElementById("app").textContent;
  ok("placed: no Cambridge order", !/5,000|Ange/.test(placed) && /Tam|80/.test(placed));
  ok("placed: chip row present, Placed on", !![...app().querySelectorAll(".chip.on")].find(c=>/Placed orders/.test(c.textContent)));
  // sales tab: item feed
  ev(`go('sales')`); await new Promise(r=>setTimeout(r,400));
  ev(`route()`); await new Promise(r=>setTimeout(r,50));
  const sd=ev(`Object.values(SD).flat()`);
  ok("item feed: only Glenorchy rows", sd.length===4 && sd.every(r=>r.venue===G), sd.map(r=>r.item+"@"+r.venue));
  ok("item feed: 'No Cat.' -> Uncategorised", (sd.find(r=>r.item==="Mystery Item")||{}).group==="Uncategorised", sd.map(r=>r.item+":"+r.group));
  const sales=w.document.getElementById("app").textContent;
  ok("sales page: no store chips / Both", !/Both/.test(sales) && !/both kitchens/.test(sales));
  ok("sales page: no Cambridge", !/Cambridge|Luma/.test(sales));
  ok("sales page: headline tile names Glenorchy", /Sales — Red Square Glenorchy/.test(sales), (sales.match(/Sales — [^\n]{0,40}/)||[])[0]);
  // reports
  ev(`go('reports')`); await new Promise(r=>setTimeout(r,50));
  const rep=w.document.getElementById("app").textContent;
  ok("reports: no Cambridge/Luma/both", !/Cambridge|Luma|both kitchens|both stores/.test(rep));
  // ---- top 10s, default range = This week
  ok("reports default range is this week", ev("RANGE.kind")==="week" && ev("RANGE.off")===0 && /\(this week\)/.test(rep));
  ok("reports: supplier/group cards moved to the front page", !/Suppliers by spend|Spend by group/.test(rep));
  const bought=cardByLabel("Top 10 purchased");
  ok("bought card present", !!bought);
  const br=rowsOf(bought);
  ok("bought: Blend Beans first (300 > 100)", br[0]&&br[0][0]==="Blend Beans 1kg"&&/\$300\.00/.test(br[0][3]), br.map(r=>r[0]+" "+r[3]));
  ok("bought: this week only — Naan (last week) absent", !br.some(r=>r[0]==="Naan Bread"));
  ok("bought: fee line stripped", !br.some(r=>/Delivery Fee/.test(r[0])));
  ok("bought: 3 products, $500 total", /3 products · \$500\.00/.test(bought.textContent), bought.querySelector(".note").textContent.slice(0,60));
  const peas=br.find(r=>r[0]==="Peas"), beans=br.find(r=>r[0]==="Blend Beans 1kg"), ban=br.find(r=>r[0]==="Bananas");
  ok("bought: Peas ▲ 11.1% vs $18 before range", peas&&/▲ 11\.1%/.test(peas[5]), peas&&peas[5]);
  ok("bought: Beans ▼ 9.1% vs $110 before range", beans&&/▼ 9\.1%/.test(beans[5]), beans&&beans[5]);
  ok("bought: Bananas steady", ban&&/—/.test(ban[5])&&!/[▲▼]/.test(ban[5]), ban&&ban[5]);
  ok("bought: rows link to price history", /rprod::/.test(bought.innerHTML));
  // creep
  const creep=cardByLabel("Price creep");
  ok("creep card present", !!creep);
  ok("creep: rises cost $10, falls saved $30, net −$20 saved", /Rises cost \$10\.00/.test(creep.textContent)&&/falls saved \$30\.00/.test(creep.textContent)&&/net −\$20\.00 saved/.test(creep.textContent), creep.textContent.match(/Rises[^\n]{0,80}/)&&creep.textContent.match(/Rises[^\n]{0,80}/)[0]);
  const cr=rowsOf(creep);
  ok("creep: rises list = Peas $10.00", cr.length===1&&cr[0][0]==="Peas"&&/\$18\.00 → \$20\.00/.test(cr[0][2])&&cr[0][5]==="$10.00", cr);
  ev("setCreepDir('down')"); await new Promise(r=>setTimeout(r,50));
  const cr2=rowsOf(cardByLabel("Price creep"));
  ok("creep: falls list = Beans $30.00", cr2.length===1&&cr2[0][0]==="Blend Beans 1kg"&&cr2[0][5]==="$30.00", cr2);
  ev("setCreepDir('up')");
  // sold — the Sales tab already cached this week, so the card renders straight away
  ev("route()"); await new Promise(r=>setTimeout(r,50));
  const sold=cardByLabel("Top 10 sold");
  ok("sold card present", !!sold);
  const sr=rowsOf(sold);
  ok("sold: Flat White first, 20 paid units (the $0 loyalty line excluded), $100, 62.9%", sr[0]&&sr[0][0]==="Flat White"&&sr[0][2]==="20"&&sr[0][3]==="$100.00"&&sr[0][4]==="62.9%", sr[0]);
  ok("sold: 3 products, $159 paid", /3 products · \$159\.00 paid sales/.test(sold.textContent), sold.querySelector(".note").textContent.slice(0,50));
  ev("setSoldBy('qty')"); await new Promise(r=>setTimeout(r,50));
  const sq=rowsOf(cardByLabel("Top 10 sold"));
  ok("sold by units: Flat White 20 = 76.9% of 26 units", sq[0]&&sq[0][0]==="Flat White"&&sq[0][4]==="76.9%", sq[0]);
  ev("setSoldBy('sales')");
  // wide range: the feed is not pulled
  const fetches0=FETCHES.length;
  ev(`RANGE={kind:"custom",off:0,from:"${iso(wd(-175))}",to:"${iso(wd(6))}"}; renderFilters(); route()`); await new Promise(r=>setTimeout(r,50));
  const sold26=cardByLabel("Top 10 sold");
  ok("26w: feed not fetched, says Week/Month/Quarter", /Week, Month or Quarter/.test(sold26.textContent) && !FETCHES.slice(fetches0).some(u=>/select A,C,D,E,F,G,H/.test(u)), sold26.textContent.slice(0,80));
  const b26=rowsOf(cardByLabel("Top 10 purchased"));
  ok("26w: Naan now in the purchased list with no price change on record", b26.some(r=>r[0]==="Naan Bread"&&/—/.test(r[5])), b26.map(r=>r[0]));
  const peas26=b26.find(r=>r[0]==="Peas");
  ok("26w: Peas baseline falls back to first price in range (18 → 20 still ▲ 11.1%)", peas26&&/▲ 11\.1%/.test(peas26[5]), peas26&&peas26[5]);
  // a range before the feed existed
  ev("RANGE={kind:'custom',off:0,from:'2026-07-06',to:'2026-07-12'}; renderFilters(); route()"); await new Promise(r=>setTimeout(r,50));
  ok("pre-cutover: sold card explains, no fetch", /only exist from 3\/8\/2026|only exist from 03\/08\/2026/.test(cardByLabel("Top 10 sold").textContent) && !FETCHES.slice(fetches0).some(u=>/select A,C,D,E,F,G,H/.test(u)), cardByLabel("Top 10 sold").textContent.slice(0,90));
  ev("resetRange()");
  dom.window.close();
}
(async()=>{ await run(true); await run(false);
  console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL?1:0);
})().catch(e=>{console.error("HARNESS CRASH",e);process.exit(2);});
