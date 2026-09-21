# Annotated screenshots for the Help page, from the harness's fake data. Badges are injected
# into the DOM before each shot so they sit exactly on the element they describe.
import subprocess
from playwright.sync_api import sync_playwright
html=open("glenorchy-hq.html",encoding="utf-8").read()
# the help page itself references these images; the shots must not include a "?" that isn't there yet, so shoot v13
def serve(url): return subprocess.run(["node","_serve.js",url],capture_output=True,text=True).stdout
BADGE_CSS="""
.hb{position:absolute;z-index:999;width:22px;height:22px;border-radius:50%;background:#c8102e;color:#fff;font:700 13px/22px -apple-system,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none}
"""
BADGE_JS="""
(pairs)=>{ if(!document.getElementById('hbcss')){const st=document.createElement('style');st.id='hbcss';st.textContent=%s;document.head.appendChild(st);}
  document.querySelectorAll('.hb').forEach(e=>e.remove());
  pairs.forEach(([n,sel,dx,dy])=>{ const el=typeof sel==='string'?document.querySelector(sel):sel; if(!el) return;
    const r=el.getBoundingClientRect(); const b=document.createElement('div'); b.className='hb'; b.textContent=n;
    b.style.left=(window.scrollX+r.left+(dx||0))+'px'; b.style.top=(window.scrollY+r.top+(dy||0))+'px'; document.body.appendChild(b); }); }
""" % repr(BADGE_CSS)
def chip(text): return "[...document.querySelectorAll('#filters .chip')].find(c=>c.textContent.trim()==='%s')" % text
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1180,"height":900},device_scale_factor=2)
    def handler(route,req):
        u=req.url
        if "script.google.com" in u: return route.fulfill(status=200,content_type="application/json",body='{"ok":true}')
        if "docs.google.com" in u: return route.fulfill(status=200,content_type="text/csv",body=serve(u))
        route.continue_()
    pg.route("**/*",handler)
    pg.set_content(html.replace("</head>","<base href='https://guysmiley54.github.io/red-square-dashboard/'></head>"))
    pg.wait_for_timeout(2500)
    def badges(spec):
        pg.evaluate("(spec)=>{const f=%s; f(spec.map(([n,sel,dx,dy])=>[n,typeof sel==='string'&&sel.startsWith('js:')?eval(sel.slice(3)):sel,dx,dy]));}" % BADGE_JS, spec)
    def shot(name, selector=None, clip=None, pad=8):
        pg.wait_for_timeout(200)
        if selector:
            el=pg.query_selector(selector); box=el.bounding_box()
            clip={"x":max(0,box["x"]-pad),"y":max(0,box["y"]-pad),"width":min(1180,box["width"]+2*pad),"height":box["height"]+2*pad}
        pg.screenshot(path="help/"+name+".png",clip=clip,full_page=True)
        pg.evaluate("document.querySelectorAll('.hb').forEach(e=>e.remove())")
    # 1. the header nav
    badges([[1,"header a.hbtn:nth-of-type(1)",-8,-8],[2,"header a.hbtn:nth-of-type(2)",-8,-8],[3,"header a.hbtn:nth-of-type(3)",-8,-8],[4,"header a.hbtn:nth-of-type(4)",-8,-8],[5,"header a.hbtn:nth-of-type(5)",-8,-8]])
    shot("nav","header",pad=0)
    # 2. the range bar
    badges([[1,"js:"+chip("‹"),-10,-12],[2,"js:"+chip("Week"),-10,-12],[3,"#rfrom",-10,-12],[4,"js:"+chip("catch-up"),-10,-12]])
    shot("range-bar","#filters",pad=0)
    # 3. the week header (countdown)
    shot("header-week",".summary")
    # 4. month header (books + tally)
    pg.evaluate("setRangeKind('month')"); pg.wait_for_timeout(300)
    shot("header-month",".summary")
    pg.evaluate("resetRange()"); pg.wait_for_timeout(300)
    # 5. suppliers by spend
    pg.evaluate("window.scrollTo(0,0)")
    el=pg.evaluate_handle("[...document.querySelectorAll('.card')].find(c=>/Suppliers by spend/.test(c.textContent))")
    box=el.bounding_box(); pg.screenshot(path="help/front-page.png",clip={"x":box["x"]-8,"y":box["y"]-8,"width":box["width"]+16,"height":box["height"]+16},full_page=True)
    # 6. reports: top 10s and wastage
    pg.evaluate("go('reports')"); pg.wait_for_timeout(1500); pg.evaluate("route()"); pg.wait_for_timeout(1500); pg.evaluate("route()"); pg.wait_for_timeout(300)
    el=pg.evaluate_handle("document.querySelector('.grid2')"); box=el.bounding_box()
    pg.screenshot(path="help/reports-top10.png",clip={"x":box["x"]-8,"y":box["y"]-8,"width":box["width"]+16,"height":box["height"]+16},full_page=True)
    el=pg.evaluate_handle("[...document.querySelectorAll('.card')].find(c=>/Wastage — in range/.test(c.textContent))"); box=el.bounding_box()
    pg.screenshot(path="help/reports-wastage.png",clip={"x":box["x"]-8,"y":box["y"]-8,"width":box["width"]+16,"height":box["height"]+16},full_page=True)
    # 7. supplier page
    pg.evaluate("go('rsup::Fresh%20Cut')"); pg.wait_for_timeout(400)
    pg.screenshot(path="help/supplier.png",clip={"x":0,"y":280,"width":1180,"height":520},full_page=True)
    b.close()
print("done")
