import express from 'express';
for(const mid of (STATE.marketsByEvent.get(ev.id)||[])){ const m=STATE.markets.get(mid); if(m) m.status='SETTLED'; }
settleBets(ev);
ev.status='SETTLED';
return ev;
}


function settleBets(ev){
for(const bet of STATE.bets.values()){
if (bet.eventId!==ev.id || bet.status!=='PENDING') continue;
const m = STATE.markets.get(bet.marketId); if(!m){ bet.status='LOST'; bet.payout=0; continue; }
let won=false;
if (ev.game==='colors' && m.type==='WIN') won = (bet.selectionId===ev.result.winner);
if ((ev.game==='dog'||ev.game==='horse') && m.type==='WIN') won = (bet.selectionId===ev.result.positions[0].id);
if ((ev.game==='dog'||ev.game==='horse') && m.type.startsWith('PLACE_')){ const n = parseInt(m.type.split('_')[1],10)||2; won = ev.result.positions.slice(0,n).some(p=>p.id===bet.selectionId); }
if (ev.game==='football' && m.type.startsWith('1X2')){ const o = ev.result.homeGoals>ev.result.awayGoals?'H':ev.result.homeGoals<ev.result.awayGoals?'A':'D'; won = (bet.selectionId===o); }
if (ev.game==='football' && m.type.startsWith('OU_2_5')){ const total = ev.result.homeGoals+ev.result.awayGoals; won = (bet.selectionId==='OVER'? total>2 : total<=2); }
if (ev.game==='aviator' && m.type==='AVIATOR_AUTO'){
const mult = Number(bet.selectionId.replace(/^X/,''));
won = (ev.result.bust >= mult);
if (won){ bet.status='WON'; bet.payout=Number((bet.stake*mult).toFixed(2)); } else { bet.status='LOST'; bet.payout=0; }
continue;
}
if (won){ bet.status='WON'; bet.payout=Number((bet.stake*bet.odds).toFixed(2)); } else { bet.status='LOST'; bet.payout=0; }
}
}


// ---- Admin/Agent aggregations ----
function summarizeBets(filter={}){
const rows = [...STATE.bets.values()].filter(b=>{
if (filter.cashierId && b.cashierId!==filter.cashierId) return false;
if (filter.status && b.status!==filter.status) return false;
return true;
});
const totalStake = rows.reduce((a,b)=>a+b.stake,0);
const totalPayout = rows.reduce((a,b)=>a+b.payout,0);
const won = rows.filter(b=>b.status==='WON').length;
const lost = rows.filter(b=>b.status==='LOST').length;
const pending = rows.filter(b=>b.status==='PENDING').length;
const byCashier = {};
for (const b of rows){
byCashier[b.cashierId] ||= { tickets:0, stake:0, payout:0, won:0, lost:0, pending:0 };
const t = byCashier[b.cashierId]; t.tickets++; t.stake+=b.stake; t.payout+=b.payout; t[b.status.toLowerCase()]++;
}
return { count: rows.length, totalStake, totalPayout, won, lost, pending, byCashier };
}


// ---- API ----
app.get('/health', (req,res)=>res.json({ok:true, ts:Date.now(), sha:BUILD_SHA}));
app.get('/games', (req,res)=>res.json(STATE.games));
app.get('/events', (req,res)=>{ const {game}=req.query; let arr=[...STATE.events.values()]; if(game) arr=arr.filter(e=>e.game===game); arr.sort((a,b)=>a.runsAt-b.runsAt); res.json(arr.slice(0,50)); });
app.get('/events/:id', (req,res)=>{ const ev=STATE.events.get(req.params.id); if(!ev) return res.status(404).json({error:'Not found'}); res.json(ev); });
app.get('/markets/:eventId', (req,res)=>{ const mids=STATE.marketsByEvent.get(req.params.eventId)||[]; const markets=mids.map(id=>STATE.markets.get(id)); if(!markets.length) return res.status(404).json({error:'No markets'}); res.json(markets); });
app.post('/events/:id/lock', (req,res)=>{ const ev=STATE.events.get(req.params.id); if(!ev) return res.status(404).json({error:'Not found'}); if(ev.status!=='OPEN') return res.status(400).json({error:'Not OPEN'}); ev.status='LOCKED'; res.json({ok:true,id:ev.id,status:ev.status}); });
app.post('/events/:id/run', (req,res)=>{ const ev=runEvent(req.params.id); if(!ev) return res.status(404).json({error:'Not found'}); res.json({ok:true, result:ev.result, status:ev.status}); });


// Create bet (cashier)
app.post('/bets', (req,res)=>{
const { eventId, marketId, selectionId, stake, cashierId } = req.body || {};
if (!eventId || !marketId || !selectionId || !stake || !cashierId) return res.status(400).json({error:'Missing fields'});
const ev=STATE.events.get(eventId); if(!ev) return res.status(404).json({error:'Event not found'});
if (ev.status!=='OPEN') return res.status(400).json({error:'Event not open'});
const m=STATE.markets.get(marketId); if(!m || m.status!=='OPEN') return res.status(400).json({error:'Market closed'});
const odds=m.odds[selectionId]; if(!odds) return res.status(400).json({error:'Bad selection'});
const id = uuidv4();
const ref = `T-${String(Date.now()).slice(-7)}-${id.slice(0,4).toUpperCase()}`;
const bet = { id, ref, eventId, marketId, selectionId, stake:Number(stake), cashierId, placedAt:Date.now(), odds:Number(odds), status:'PENDING', payout:0 };
STATE.bets.set(id, bet);
res.json({ ok:true, bet });
});


app.get('/bets', (req,res)=>{ const {cashierId}=req.query; let arr=[...STATE.bets.values()]; if(cashierId) arr=arr.filter(b=>b.cashierId===cashierId); arr.sort((a,b)=>b.placedAt-a.placedAt); res.json(arr.slice(0,200)); });


// Admin JSON endpoints (read-only)
app.get('/admin/summary', (req,res)=>{ res.json(summarizeBets({})); });
app.get('/admin/summary/by-cashier', (req,res)=>{ res.json(summarizeBets({}).byCashier); });
app.get('/admin/bets', (req,res)=>{ res.json([...STATE.bets.values()].sort((a,b)=>b.placedAt-a.placedAt).slice(0,500)); });
app.get('/admin/events', (req,res)=>{ res.json([...STATE.events.values()].sort((a,b)=>a.runsAt-b.runsAt).slice(0,100)); });


// ---- Receipt HTML with barcode ----
app.get('/receipt/:betId', async (req,res)=>{
const bet = STATE.bets.get(req.params.betId);
if (!bet) return res.status(404).send('Ticket not found');
const m = STATE.markets.get(bet.marketId); const ev = STATE.events.get(bet.eventId);
const png = await bwipjs.toBuffer({ bcid:'code128', text: bet.ref, scale:3, height:8, includetext:false, background:'FFFFFF' });
const barcodeBase64 = `data:image/png;base64,${png.toString('base64')}`;
res.render('receipt', { bet, market:m, event:ev, fmtMoney, barcodeBase64, CURRENCY, DOMAIN });
});


// ---- ESC/POS printing ----
app.post('/print/:betId', async (req,res)=>{
try{
if (!PRINTER_ENABLED) return res.status(400).json({error:'Printer disabled'});
const bet = STATE.bets.get(req.params.betId); if(!bet) return res.status(404).json({error:'Not found'});
const m = STATE.markets.get(bet.marketId); const ev = STATE.events.get(bet.eventId);
const printer = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: `tcp://${PRINTER_HOST}:${PRINTER_PORT}`, options:{ timeout:5000 } });
await printer.isPrinterConnected();
printer.alignCenter(); printer.bold(true); printer.println('MASTERMIND BET'); printer.bold(false);
printer.println(DOMAIN); printer.drawLine();
printer.println(bet.ref);
printer.setTextDoubleHeight(); printer.println(fmtMoney(bet.stake)); printer.setTextNormal();
printer.println(`${ev.game.toUpperCase()} — ${m.type}`);
printer.println(`Pick: ${bet.selectionId} @ ${bet.odds}`);
printer.println(new Date(bet.placedAt).toLocaleString('en-KE'));
printer.newLine(); printer.barcode(bet.ref, 73, { width:2, height:80, position:'OFF' });
printer.cut();
await printer.execute();
res.json({ok:true});
}catch(err){ console.error(err); res.status(500).json({error:'Print failed'}); }
});


// ---- Bootstrap ----
(function bootstrap(){ for(const g of STATE.games){ scheduleEvent(g); scheduleEvent(g); scheduleEvent(g); } })();


app.listen(PORT, ()=>{ console.log(`mastermind-bet virtuals on :${PORT} (${DOMAIN})`); });
