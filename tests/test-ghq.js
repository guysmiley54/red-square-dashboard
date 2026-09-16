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
    ["G3", iso(dm(20)),"150.00","150.00","0.00","Fresh Cut",G,"Food","invoice","email",iso(dm(20))+" 09:00:00"],
    ["G9", iso(wd(0)), "400.00","400.00","0.00","TasWaste",G,"Waste Management","invoice","email",iso(wd(0))+" 09:00:00"],
    ["C1", iso(wd(0)), "999.00","900.00","99.00","Doppio Foods",C,"Beverage","invoice","email",iso(wd(0))+" 09:00:00"],
    ["L1", iso(wd(1)), "555.00","555.00","0.00","Fresh Cut",L,"Food","invoice","email",iso(wd(1))+" 09:00:00"]
  ]),
  InvoiceLines: csv(["invoice_number","description","line_total","supplier","venue","item_code","qty","unit","unit_price"],[
    ["G1","Blend Beans 1kg","300.00","Doppio Foods",G,"BB1","3","kg","100.00"],
    ["G2","Bananas","100.00","Fresh Cut",G,"","10","kg","10.00"],
    ["G2","Peas","100.00","Fresh Cut",G,"","5","kg","20.00"],
    ["G3","Bananas","150.00","Fresh Cut",G,"","15","kg","10.00"],
    ["C1","Blend Beans 1kg","900.00","Doppio Foods",C,"BB1","9","kg","100.00"],
    ["C1","Cambridge Only Widget","0.00","Doppio Foods",C,"CW1","1","ea","0.00"],
    ["L1","Luma Only Lettuce","555.00","Fresh Cut",L,"","5","kg","111.00"]
  ]),
  SupplierConfig: csv(["supplier","merge_into","group","active"],[["Doppio Foods","","Beverage","yes"],["Fresh Cut","","Food","yes"],["TasWaste","","Waste Management","yes"]]),
  ProductMerge: csv(["supplier","match","into"],[]),
  ManualPurchases: csv(["date","shop","venue","amount"],[[iso(wd(1)),"Woolworths",G,"50.00"],[iso(wd(1)),"Woolworths",C,"7000.00"]]),
  Orders: csv(["order_id","action","supplier","venue","order_date","subtotal","gst","total","channel","placed_by","note","logged_at","delivery_date"],[
    ["og1","place","Fresh Cut",G,iso(wd(2)),"80","0","80","email","Tam","",iso(wd(2))+" 08:00:00",iso(wd(3))],
    ["oc1","place","Fresh Cut",C,iso(wd(2)),"5000","0","5000","email","Ange","",iso(wd(2))+" 08:00:00",iso(wd(3))]
  ]),
  OrderLines: csv(["order_id","line_no","item_code","description","unit","qty","unit_price","line_total"],[
    ["og1","1","","Bananas","kg","8","10","80"],["oc1","1","","Bananas","kg","500","10","5000"]]),
  SupplierSettings: csv(["supplier","rep_email","visible","portal_only","cc","note"],[["Fresh Cut","rep@freshcut.example","yes","no","",""]]),
  Favourites: csv(["fav_id","fav_name","venue","supplier","created_by","created_at"],[["f1","Glen weekly",G,"Fresh Cut","Tam",""],["f2","Camb weekly",C,"Fresh Cut","Ange",""]]),
  FavouriteLines: csv(["fav_id","line_no","item_key","description","unit","qty","supplier"],[["f1","1","x","Bananas","kg","4","Fresh Cut"],["f2","1","x","Bananas","kg","40","Fresh Cut"]]),
  CategoryOverrides: csv(["item_key","supplier","description","category","hidden"],[]),
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
  [iso(wd(0))+" 12:15:00",G,"Food T/A","Takeaway","Ham Roll","5","50"],
  [iso(wd(0))+" 12:20:00",G,"No Cat.","","Mystery Item","1","9"],
  [iso(wd(0))+" 08:15:00",C,"Beverage D/H","Coffee","Cambridge Latte","200","1000"],
  [iso(wd(0))+" 08:15:00",L,"Luma Food D/H","Luma Kitchen","Luma Bowl","200","1000"]
]);

function serve(url){
  const u=new URL(url); const sheet=u.searchParams.get("sheet"); const tq=u.searchParams.get("tq")||"";
  if(sheet==="SalesFeed"){ if(/select B, C, sum\(H\)/.test(tq)) return feedDaily; if(/select A,C,D,E,F,G,H/.test(tq)) return feedItems; return feedItems; }
  if(sheet==="Overrides"||sheet==="ItemMap") return TABS.Invoices;   // the gviz trap: wrong tab, HTTP 200
  if(TABS[sheet]!==undefined) return TABS[sheet];
  return TABS.Invoices;   // gviz trap for anything unknown
}

(async()=>{
  const html=fs.readFileSync(FILE,"utf8");
  const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://guysmiley54.github.io/red-square-dashboard/glenorchy-hq.html",
    beforeParse(w){ w.__OB_NO_AUTOLOAD=true;
      w.fetch=async(url,opts)=>{ if(/script\.google\.com/.test(url)) return {ok:true,text:async()=>JSON.stringify({ok:true,order_id:"x"}),json:async()=>({ok:true,order_id:"x"})};
        const t=serve(url); return {ok:true,text:async()=>t,json:async()=>({})}; };
      w.alert=()=>{}; w.confirm=()=>true;
      // a leftover Cambridge Central draft on the SAME origin — must not count here
      w.localStorage.setItem("ob3_drafts",JSON.stringify({"Red Square Cambridge::Fresh Cut":{supplier:"Fresh Cut",tag:"Red Square Cambridge",qty:{"fresh cut||bananas|kg":999},note:""}}));
    }});
  const w=dom.window; await new Promise(r=>setTimeout(r,300));
  const ev=s=>w.eval(s);
  ok("title is Glenorchy HQ", w.document.title==="Glenorchy HQ");
  ok("header h1", w.document.querySelector("header h1").textContent==="Glenorchy HQ");
  ok("build id", /^ghq-v1-/.test(ev("BUILD_ID")), ev("BUILD_ID"));
  ok("draft key is not Cambridge's", ev("DRAFT_KEY")==="ghq_drafts");
  await ev("loadAll()"); await new Promise(r=>setTimeout(r,200));
  ok("no load error", !w.document.querySelector(".err"), (w.document.querySelector(".err")||{}).textContent);
  const INV=ev("INV"), LINES=ev("LINES"), ORDERS=ev("ORDERS"), FAVS=ev("FAVS"), SALES=ev("SALES");
  ok("INV: only Glenorchy", INV.length>0 && INV.every(r=>r.venue===G), INV.map(r=>r.number+"@"+r.venue));
  ok("INV: non-COGS dropped", !INV.some(r=>r.supplier==="TasWaste"));
  ok("INV: manual purchase kept, Cambridge one dropped", INV.filter(r=>r.supplier==="Woolworths").map(r=>r.total).join()==="50");
  ok("LINES: only Glenorchy", LINES.length===4 && LINES.every(r=>r.venue===G), LINES.map(r=>r.desc+"@"+r.venue));
  ok("ORDERS: Cambridge order excluded", ORDERS.length===1 && ORDERS[0].id==="og1", ORDERS.map(o=>o.id));
  ok("FAVS loaded both, scoped at render", FAVS.length===2);
  const pre=SALES.filter(r=>r.weekly); const cut=new Date("2026-08-03");
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
  // home render
  ev("route()");
  const home=w.document.getElementById("app").textContent;
  ok("home mentions Glenorchy, not Cambridge", /Glenorchy/.test(home) && !/Cambridge|Luma|both kitchens/.test(home));
  ok("home shows income 2,200 (this week, Glenorchy only)", /2,200/.test(home), home.match(/Income this week[\s\S]{0,80}/)&&home.match(/Income this week[\s\S]{0,80}/)[0]);
  // spend this week: G1 330 + G2 200 + manual 50 = 580 invoiced; TasWaste and Cambridge excluded
  ok("home spend 580", /\$580\b/.test(home), (home.match(/\$5\d\d/g)||[]).slice(0,3));
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
  // sales tab: item feed
  ev(`go('sales')`); await new Promise(r=>setTimeout(r,400));
  ev(`route()`); await new Promise(r=>setTimeout(r,50));
  const sd=ev(`Object.values(SD).flat()`);
  ok("item feed: only Glenorchy rows", sd.length===3 && sd.every(r=>r.venue===G), sd.map(r=>r.item+"@"+r.venue));
  ok("item feed: 'No Cat.' -> Uncategorised", (sd.find(r=>r.item==="Mystery Item")||{}).group==="Uncategorised", sd.map(r=>r.item+":"+r.group));
  const sales=w.document.getElementById("app").textContent;
  ok("sales page: no store chips / Both", !/Both/.test(sales) && !/both kitchens/.test(sales));
  ok("sales page: no Cambridge", !/Cambridge|Luma/.test(sales));
  ok("sales page: headline tile names Glenorchy", /Sales — Red Square Glenorchy/.test(sales), (sales.match(/Sales — [^\n]{0,40}/)||[])[0]);
  // reports
  ev(`go('reports')`); await new Promise(r=>setTimeout(r,50));
  const rep=w.document.getElementById("app").textContent;
  ok("reports: no Cambridge/Luma/both", !/Cambridge|Luma|both kitchens|both stores/.test(rep));
  console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL?1:0);
})().catch(e=>{console.error("HARNESS CRASH",e);process.exit(2);});
