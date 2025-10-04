// server.js — Mastermind Bet (Virtuals ++ 2025-10-04)
// Node 18+, ESM. Requires: express, cors, uuid, ejs, bwip-js, node-thermal-printer
// New: multi-fixture Football scheduler (10 fixtures/league cycle), dedicated Aviator engine,
//      improved endpoints for Aviator (no odds), receipts, KES shop rules.

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import bwipjs from 'bwip-js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ThermalPrinter = require('node-thermal-printer').printer;
const PrinterTypes = require('node-thermal-printer').types;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'static')));
app.get('/', (req,res)=> res.redirect('/static/cashier.html'));
app.get('/aviator', (req,res)=> res.sendFile(path.join(__dirname, 'static', 'aviator.html')));

// ---- Config ----
const PORT = process.env.PORT || 4000;
const DOMAIN = process.env.DOMAIN || 'mastermind-bet.com';
const CURRENCY = process.env.CURRENCY || 'KES';
const BUILD_SHA = process.env.BUILD_SHA || 'local';

const PRINTER_ENABLED = String(process.env.PRINTER_ENABLED||'false')==='true';
const PRINTER_HOST = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT = Number(process.env.PRINTER_PORT || 9100);

const MIN_STAKE = 20, MAX_STAKE = 1000, MAX_PAYOUT = 20000;

// ---- Helpers ----
const NOW = ()=>Date.now();
const MS = { s:1000, m:60000 };
const fmtMoney = (x)=> new Intl.NumberFormat('en-KE',{style:'currency',currency:'KES'}).format(Number(x||0));
function mulberry32(a){ return function(){ let t=(a+=0x6D2B79F5); t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
const softmax = arr => { const m=Math.max(...arr); const exps=arr.map(v=>Math.exp(v-m)); const s=exps.reduce((a,b)=>a+b,0); return exps.map(e=>e/s); };
const addMargin = (probs, margin=0.08)=> probs.map(p=>p*(1-margin)).map(p=> p<=0?1000:1/p);
const sampleIndex = (probs, rand)=>{ const r=rand(); let a=0; for(let i=0;i<probs.length;i++){ a+=probs[i]; if(r<=a) return i; } return probs.length-1; };
function poisson(lambda, rand){ const L=Math.exp(-lambda); let k=0,p=1; do{ k++; p*=rand(); } while(p>L); return k-1; }

// ---- Data (leagues) ----
const LEAGUES = JSON.parse(fs.readFileSync(path.join(__dirname,'data','leagues.json'),'utf-8'));

// ---- State ----
const STATE = {
  games: ['football','dog','horse','colors','lotto49','aviator'],
  events: new Map(),          // id -> event
  markets: new Map(),         // id -> market
  marketsByEvent: new Map(),  // eventId -> [marketId]
  footballRounds: { EPL:0, LALIGA:0, UCL:0 },
  bets: new Map(),
  results: { football:[], dog:[], horse:[], colors:[], lotto49:[], aviator:[] },
  cashiers: new Map(),
  players: new Map(),
  aviator: { roundId:null, status:'IDLE', startedAt:0, bustAt:0, liveMultiplier:1.0, tickets:[] } // tickets: array of {playerId,...}
};

const CYCLE = { football:180*MS.s, dog:120*MS.s, horse:120*MS.s, colors:60*MS.s, lotto49:60*MS.s };
const LOCK_OFFSET = 10*MS.s;

// ---- Cashiers & Players ----
function ensureCashier(id){ if(!STATE.cashiers.has(id)) STATE.cashiers.set(id,{balance:0}); return STATE.cashiers.get(id); }
function creditCashier(id,amt){ ensureCashier(id).balance += Number(amt)||0; }
function debitCashier(id,amt){ ensureCashier(id).balance -= Number(amt)||0; if(ensureCashier(id).balance<0) ensureCashier(id).balance=0; }
function ensurePlayer(id){ if(!STATE.players.has(id)) STATE.players.set(id,{balance:0}); return STATE.players.get(id); }
function creditPlayer(id,amt){ ensurePlayer(id).balance += Number(amt)||0; }
function debitPlayer(id,amt){ ensurePlayer(id).balance -= Number(amt)||0; if(ensurePlayer(id).balance<0) ensurePlayer(id).balance=0; }

// ---- Core builders ----
function putMarket(m){ STATE.markets.set(m.id,m); if(!STATE.marketsByEvent.has(m.eventId)) STATE.marketsByEvent.set(m.eventId,[]); STATE.marketsByEvent.get(m.eventId).push(m.id); }
function scheduleEvent(game, extra={}){
  const id=uuidv4(); const seed=Math.floor(Math.random()*2**32); const startsAt=NOW();
  const runsAt=startsAt+CYCLE[game]; const locksAt=runsAt-LOCK_OFFSET;
  const ev = { id, game, status:'OPEN', seed, startsAt, locksAt, runsAt, result:null, audit:[], ...extra };
  STATE.events.set(id, ev); buildMarketsForEvent(ev); return ev;
}
function pushResult(game, data){ const arr=STATE.results[game]; arr.unshift({ts:Date.now(), ...data}); if(arr.length>20) arr.length=20; }

// ---- Football fixtures (round-robin) ----
function generateRoundFixtures(leagueKey, roundIdx){
  const teams = LEAGUES[leagueKey].map(([name,abbr])=>({name,abbr}));
  // standard Berger algorithm
  const n = teams.length; const list = teams.slice();
  if (n%2===1) list.push({name:'BYE',abbr:'BYE'});
  const half = list.length/2;
  // produce pairings for a specific round
  const left = list.slice(0,half);
  const right = list.slice(half).reverse();
  // rotate by roundIdx
  for (let r=0; r<roundIdx; r++){
    // rotation step
    const keep = left[0];
    const l = left.slice(1); l.push(right[0]); right.shift(); right.push(left[left.length-1]); left.length=1; left.push(...l);
    left[0] = keep;
  }
  const fixtures=[];
  for (let i=0;i<half;i++){
    const A = left[i], B = right[i];
    if (A.abbr!=='BYE' && B.abbr!=='BYE') fixtures.push([A,B]);
  }
  return fixtures; // ~10 games for 20 teams
}

// ---- Market builders ----
function buildMarketsForEvent(ev){
  const rand = mulberry32(ev.seed);

  if (ev.game==='football'){
    // Expect ev.home/away/league already set by scheduler
    const { home, away, league } = ev;
    // team strengths
    const homeAtk = 1.1 + rand()*0.6, homeDef = 1.0 + rand()*0.5;
    const awayAtk = 1.0 + rand()*0.6, awayDef = 1.1 + rand()*0.5;
    const lamH = 1.35 * homeAtk / awayDef;
    const lamA = 1.10 * awayAtk / homeDef;
    // simulate probs
    let H=0,D=0,A=0,BTTSy=0,H15=0,A15=0; const trials=3000; const r2=mulberry32(ev.seed^0x55aa);
    function poiss(l){ return poisson(l,r2); }
    for(let t=0;t<trials;t++){ const gh=poiss(lamH), ga=poiss(lamA); if(gh>ga) H++; else if(gh<ga) A++; else D++; if(gh>0&&ga>0) BTTSy++; if(gh>=2) H15++; if(ga>=2) A15++; }
    const pH=H/trials, pD=D/trials, pA=A/trials, pBTTSy=BTTSy/trials;
    function poissCdf(k,lam){ let p=Math.exp(-lam); if(k===0) return p; let acc=p; for(let i=1;i<=k;i++){ p=p*lam/i; acc+=p; } return acc; }
    const lamT=lamH+lamA; const pOver15 = 1 - poissCdf(1,lamT), pOver25 = 1 - poissCdf(2,lamT);
    const odds1x2 = addMargin([pH,pD,pA], 0.07).map(x=>Number(x.toFixed(2)));
    const oddsOU15= addMargin([pOver15,1-pOver15],0.05).map(x=>Number(x.toFixed(2)));
    const oddsOU25= addMargin([pOver25,1-pOver25],0.05).map(x=>Number(x.toFixed(2)));
    const oddsBTTS= addMargin([pBTTSy,1-pBTTSy],0.05).map(x=>Number(x.toFixed(2)));
    const oddsHomeOU15 = addMargin([H15/trials, 1-H15/trials],0.06).map(x=>Number(x.toFixed(2)));
    const oddsAwayOU15 = addMargin([A15/trials, 1-A15/trials],0.06).map(x=>Number(x.toFixed(2)));
    function comboOdds(sel, overProb){ const p = (sel==='H'?pH: sel==='D'?pD:pA) * overProb; return Number((1/(p*0.90)).toFixed(2)); }
    const oddsCombo15 = { 'H&OV15': comboOdds('H',pOver15), 'D&OV15': comboOdds('D',pOver15), 'A&OV15': comboOdds('A',pOver15),
                          'H&UN15': comboOdds('H',1-pOver15), 'D&UN15': comboOdds('D',1-pOver15), 'A&UN15': comboOdds('A',1-pOver15) };
    const oddsCombo25 = { 'H&OV25': comboOdds('H',pOver25), 'D&OV25': comboOdds('D',pOver25), 'A&OV25': comboOdds('A',pOver25),
                          'H&UN25': comboOdds('H',1-pOver25), 'D&UN25': comboOdds('D',1-pOver25), 'A&UN25': comboOdds('A',1-pOver25) };

    putMarket({ id:uuidv4(), eventId:ev.id, type:`MAIN_1X2_${league}`, status:'OPEN',
      selections:[{id:'H',name:`${home.abbr} (1)`},{id:'D',name:'Draw (X)'},{id:'A',name:`${away.abbr} (2)`}],
      odds:{H:odds1x2[0],D:odds1x2[1],A:odds1x2[2]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`OU_1_5_${league}`, status:'OPEN',
      selections:[{id:'OVER',name:'Over 1.5'},{id:'UNDER',name:'Under 1.5'}],
      odds:{OVER:oddsOU15[0],UNDER:oddsOU15[1]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`OU_2_5_${league}`, status:'OPEN',
      selections:[{id:'OVER',name:'Over 2.5'},{id:'UNDER',name:'Under 2.5'}],
      odds:{OVER:oddsOU25[0],UNDER:oddsOU25[1]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`BTTS_${league}`, status:'OPEN',
      selections:[{id:'YES',name:'BTTS Yes'},{id:'NO',name:'BTTS No'}],
      odds:{YES:oddsBTTS[0],NO:oddsBTTS[1]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`HOME_OU_1_5_${league}`, status:'OPEN',
      selections:[{id:'H_OVER',name:`${home.abbr} Over 1.5`},{id:'H_UNDER',name:`${home.abbr} Under 1.5`}],
      odds:{H_OVER:oddsHomeOU15[0], H_UNDER:oddsHomeOU15[1]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`AWAY_OU_1_5_${league}`, status:'OPEN',
      selections:[{id:'A_OVER',name:`${away.abbr} Over 1.5`},{id:'A_UNDER',name:`${away.abbr} Under 1.5`}],
      odds:{A_OVER:oddsAwayOU15[0], A_UNDER:oddsAwayOU15[1]} });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`COMBO_1X2_OU_1_5_${league}`, status:'OPEN',
      selections:Object.keys(oddsCombo15).map(k=>({id:k,name:k})), odds: oddsCombo15 });
    putMarket({ id:uuidv4(), eventId:ev.id, type:`COMBO_1X2_OU_2_5_${league}`, status:'OPEN',
      selections:Object.keys(oddsCombo25).map(k=>({id:k,name:k})), odds: oddsCombo25 });
  }

  if (ev.game==='dog' || ev.game==='horse'){
    const runners = ev.game==='dog'?6:8;
    const ratings = Array.from({length:runners}, ()=>0.5+(rand()-0.5)*0.6);
    const names = Array.from({length:runners}, (_,i)=> `${ev.game.toUpperCase()} #${i+1}`);
    const probs = softmax(ratings);
    const winOdds = addMargin(probs, 0.08).map(x=>Number(x.toFixed(2)));
    putMarket({ id:uuidv4(), eventId:ev.id, type:`MAIN_WIN`, status:'OPEN',
      selections: names.map((n,i)=>({id:`R${i+1}`,name:n})), odds: Object.fromEntries(names.map((_,i)=>[`R${i+1}`,winOdds[i]])) });

    // FORECAST / QUINELLA / TRICAST
    const forecastOdds = {};
    for(let a=1;a<=runners;a++) for(let b=1;b<=runners;b++) if(a!==b){
      const p = probs[a-1] * (probs[b-1] / (1 - probs[a-1] + 1e-9));
      forecastOdds[`R${a}>R${b}`] = Number((1/(p*0.88)).toFixed(2));
    }
    putMarket({ id:uuidv4(), eventId:ev.id, type:`FORECAST`, status:'OPEN',
      selections:Object.keys(forecastOdds).map(k=>({id:k,name:k.replace('>',' → ')})), odds:forecastOdds });

    const quinellaOdds = {};
    for(let a=1;a<=runners;a++) for(let b=a+1;b<=runners;b++){
      const p = probs[a-1]*probs[b-1]*2;
      quinellaOdds[`R${a}&R${b}`] = Number((1/(p*0.90)).toFixed(2));
    }
    putMarket({ id:uuidv4(), eventId:ev.id, type:`QUINELLA`, status:'OPEN',
      selections:Object.keys(quinellaOdds).map(k=>({id:k,name:k.replace('&',' + ')})), odds:quinellaOdds });

    const tricastOdds = {}; let count=0; const limit=ev.game==='dog'?60:80;
    for(let a=1;a<=runners;a++){ for(let b=1;b<=runners;b++){ for(let c=1;c<=runners;c++){
      if(a===b||b===c||a===c) continue;
      const p = probs[a-1] * (probs[b-1]/(1-probs[a-1]+1e-9)) * (probs[c-1]/(1-probs[a-1]-probs[b-1]+1e-9));
      tricastOdds[`R${a}>R${b}>R${c}`] = Number((1/(p*0.82)).toFixed(2)); count++; if(count>=limit) break;
    }} if(count>=limit) break;}
    putMarket({ id:uuidv4(), eventId:ev.id, type:`TRICAST`, status:'OPEN',
      selections:Object.keys(tricastOdds).map(k=>({id:k,name:k.replace(/>/g,' → ')})), odds:tricastOdds });
  }

  if (ev.game==='colors'){
    const colors = ['RED','BLUE','GREEN','YELLOW','PURPLE','BLACK'];
    const colorProbs = [0.18,0.18,0.18,0.16,0.15,0.15];
    const colorOdds = addMargin(colorProbs,0.05).map(x=>Number(x.toFixed(2)));
    putMarket({ id:uuidv4(), eventId:ev.id, type:'MAIN_COLOR', status:'OPEN',
      selections: colors.map((c)=>({id:c,name:c})), odds: Object.fromEntries(colors.map((c,i)=>[c,colorOdds[i]])) });
  }
  if (ev.game==='lotto49'){
    const picks = Array.from({length:49},(_,i)=>String(i+1));
    const p=1/49; const price = Number((1/(p*0.92)).toFixed(2));
    putMarket({ id:uuidv4(), eventId:ev.id, type:'PICK1', status:'OPEN',
      selections: picks.map(id=>({id,name:id})), odds: Object.fromEntries(picks.map(id=>[id,price])) });
  }
}

// ---- Settlement & Running ----
function settleBetsForEvent(ev){
  for(const bet of STATE.bets.values()){
    if (bet.eventId!==ev.id || bet.status!=='PENDING') continue;
    const m = STATE.markets.get(bet.marketId); if (!m){ bet.status='LOST'; bet.payout=0; continue; }
    let won=false, payout=0;
    if (ev.game==='football'){
      const total = ev.result.homeGoals + ev.result.awayGoals;
      const outcome = ev.result.homeGoals>ev.result.awayGoals?'H': ev.result.homeGoals<ev.result.awayGoals?'A':'D';
      if (m.type.startsWith('MAIN_1X2')) won = (bet.selectionId===outcome);
      if (m.type.startsWith('OU_1_5')) won = (bet.selectionId==='OVER'? total>1 : total<=1);
      if (m.type.startsWith('OU_2_5')) won = (bet.selectionId==='OVER'? total>2 : total<=2);
      if (m.type.startsWith('BTTS')){ const y = (ev.result.homeGoals>0 && ev.result.awayGoals>0)?'YES':'NO'; won=(bet.selectionId===y); }
      if (m.type.startsWith('HOME_OU_1_5')){ const over = ev.result.homeGoals>=2; won = (bet.selectionId==='H_OVER'? over : !over); }
      if (m.type.startsWith('AWAY_OU_1_5')){ const over = ev.result.awayGoals>=2; won = (bet.selectionId==='A_OVER'? over : !over); }
      if (m.type.startsWith('COMBO_1X2_OU_1_5')){
        const map = { 'H&OV15': outcome==='H' && total>1, 'D&OV15': outcome==='D' && total>1, 'A&OV15': outcome==='A' && total>1,
                      'H&UN15': outcome==='H' && total<=1, 'D&UN15': outcome==='D' && total<=1, 'A&UN15': outcome==='A' && total<=1 };
        won = !!map[bet.selectionId];
      }
      if (m.type.startsWith('COMBO_1X2_OU_2_5')){
        const map = { 'H&OV25': outcome==='H' && total>2, 'D&OV25': outcome==='D' && total>2, 'A&OV25': outcome==='A' && total>2,
                      'H&UN25': outcome==='H' && total<=2, 'D&UN25': outcome==='D' && total<=2, 'A&UN25': outcome==='A' && total<=2 };
        won = !!map[bet.selectionId];
      }
    }
    if ((ev.game==='dog'||ev.game==='horse')){
      if (m.type==='MAIN_WIN') won = (bet.selectionId===ev.result.positions[0].id);
      if (m.type==='FORECAST'){ const [a,b] = bet.selectionId.split('>').map(s=>s.trim()); won = (ev.result.positions[0].id===a && ev.result.positions[1].id===b); }
      if (m.type==='QUINELLA'){ const [a,b] = bet.selectionId.split('&').map(s=>s.trim()); const top2 = ev.result.positions.slice(0,2).map(p=>p.id); won = top2.includes(a) && top2.includes(b); }
      if (m.type==='TRICAST'){ const [a,b,c] = bet.selectionId.split('>').map(s=>s.trim()); const p=ev.result.positions; won = (p[0].id===a && p[1].id===b && p[2].id===c); }
    }
    if (ev.game==='colors' && m.type==='MAIN_COLOR'){ won = (bet.selectionId===ev.result.color); }
    if (ev.game==='lotto49' && m.type==='PICK1'){ won = (String(ev.result.ball)===String(bet.selectionId)); }

    payout = won? Number((bet.stake*bet.odds).toFixed(2)) : 0;
    payout = Math.min(payout, MAX_PAYOUT);
    bet.payout = payout; bet.status = won?'WON':'LOST';
    if (won) creditCashier(bet.cashierId, payout);
  }
}
function runEvent(eventId){
  const ev = STATE.events.get(eventId); if(!ev || ev.status==='SETTLED' || ev.status==='RUNNING') return ev;
  ev.status='RUNNING';
  const rand = mulberry32(ev.seed^0x123456);
  if (ev.game==='football'){
    const r2=mulberry32(ev.seed^0x99aa);
    const gh=poisson(1.3+0.7*r2(), r2); const ga=poisson(1.1+0.6*r2(), r2);
    ev.result = { league: ev.league, home: ev.home, away: ev.away, homeGoals: gh, awayGoals: ga };
    pushResult('football', { league: ev.league, score: `${ev.home.abbr} ${gh}-${ga} ${ev.away.abbr}` });
  }
  if (ev.game==='dog' || ev.game==='horse'){
    const mIds = STATE.marketsByEvent.get(ev.id) || [];
    const winM = mIds.map(id=>STATE.markets.get(id)).find(x=>x.type==='MAIN_WIN');
    const ids = winM.selections.map(s=>s.id);
    const fair = ids.map(id=>1/winM.odds[id]); const s=fair.reduce((a,b)=>a+b,0); for(let i=0;i<fair.length;i++) fair[i]/=s;
    const pool = ids.map((id,i)=>({id,w:fair[i]})); const positions=[]; let tmp=pool.slice();
    while(tmp.length){ const sum=tmp.map(x=>x.w).reduce((a,b)=>a+b,0); const probs=tmp.map(x=>x.w/sum); const ix=sampleIndex(probs,rand); positions.push({id:tmp[ix].id}); tmp.splice(ix,1);}
    const result = positions.map((p,i)=>({id:p.id, rank:i+1}));
    ev.result = { positions: result };
    pushResult(ev.game, { podium: result });
  }
  if (ev.game==='colors'){
    const ball = 1 + Math.floor(rand()*49);
    const colorMap = ['RED','BLUE','GREEN','YELLOW','PURPLE','BLACK'];
    const color = colorMap[(ball-1)%6];
    ev.result = { ball, color };
    pushResult('colors', { ball, color });
  }
  if (ev.game==='lotto49'){
    const ball = 1 + Math.floor(rand()*49);
    ev.result = { ball };
    pushResult('lotto49', { ball });
  }
  for (const mid of (STATE.marketsByEvent.get(ev.id)||[])){ const m=STATE.markets.get(mid); if (m) m.status='SETTLED'; }
  settleBetsForEvent(ev);
  ev.status='SETTLED';
  return ev;
}

// ---- Football scheduler: create 10 fixtures per league each cycle ----
function seedFootballBatch(leagueKey){
  const round = STATE.footballRounds[leagueKey] || 0;
  const fixtures = generateRoundFixtures(leagueKey, round);
  const ten = fixtures.slice(0, 10); // 10 matches per round for 20 teams
  for (const [home, away] of ten){
    scheduleEvent('football', { league: leagueKey, home, away });
  }
  STATE.footballRounds[leagueKey] = (round + 1) % 19; // 19 rounds unique pairings in one half-season
}

// ---- Tick: lock/run; keep queues filled ----
setInterval(()=>{
  const t=NOW();
  for (const ev of STATE.events.values()){
    if (ev.status==='OPEN' && t>=ev.locksAt) ev.status='LOCKED';
    if ((ev.status==='LOCKED'||ev.status==='OPEN') && t>=ev.runsAt) runEvent(ev.id);
  }
  // ensure queues
  const racing = ['dog','horse','colors','lotto49'];
  for (const g of racing){
    const future = [...STATE.events.values()].filter(e=>e.game===g && (e.status==='OPEN'||e.status==='LOCKED'));
    if (future.length<1) scheduleEvent(g);
  }
  // football — if we have <10 future events per league, seed next round
  ['EPL','LALIGA','UCL'].forEach(L=>{
    const future = [...STATE.events.values()].filter(e=>e.game==='football' && e.league===L && (e.status==='OPEN'||e.status==='LOCKED'));
    if (future.length<10) seedFootballBatch(L);
  });
}, 1000);

// ---- API (common) ----
app.get('/health',(req,res)=>res.json({ok:true, ts:Date.now(), sha:BUILD_SHA}));
app.get('/games',(req,res)=>res.json(STATE.games));
app.get('/events',(req,res)=>{ const {game}=req.query; let arr=[...STATE.events.values()]; if(game) arr=arr.filter(e=>e.game===game); arr.sort((a,b)=>a.runsAt-b.runsAt); res.json(arr.slice(0,50)); });
app.get('/events/:id',(req,res)=>{ const ev=STATE.events.get(req.params.id); if(!ev) return res.status(404).json({error:'Not found'}); res.json(ev); });
app.get('/markets/:eventId',(req,res)=>{ const mids=STATE.marketsByEvent.get(req.params.eventId)||[]; const markets=mids.map(id=>STATE.markets.get(id)); if(!markets.length) return res.status(404).json({error:'No markets'}); res.json(markets); });
app.get('/results',(req,res)=>{ const game=(req.query.game||'').toLowerCase(); const limit=Math.min(Number(req.query.limit||10),20); if(!STATE.results[game]) return res.status(400).json({error:'Bad game'}); res.json(STATE.results[game].slice(0,limit)); });

// Cashier & Player
app.get('/cashier/:id/balance',(req,res)=> res.json({cashierId:req.params.id, balance: ensureCashier(req.params.id).balance}));
app.post('/cashier/topup',(req,res)=>{ const {cashierId,amount}=req.body||{}; if(!cashierId||!amount) return res.status(400).json({error:'cashierId & amount required'}); creditCashier(cashierId,Number(amount)); res.json({ok:true, balance: ensureCashier(cashierId).balance}); });
app.get('/players/:id',(req,res)=> res.json({playerId:req.params.id, balance: ensurePlayer(req.params.id).balance}));
app.post('/players/topup',(req,res)=>{ const {playerId,amount}=req.body||{}; if(!playerId||!amount) return res.status(400).json({error:'playerId & amount required'}); creditPlayer(playerId,Number(amount)); res.json({ok:true, balance: ensurePlayer(playerId).balance}); });
app.post('/players/clear/:id',(req,res)=>{ ensurePlayer(req.params.id).balance=0; res.json({ok:true, balance:0}); });

// Place bet (classic markets)
app.post('/bets',(req,res)=>{
  const {eventId,marketId,selectionId,stake,cashierId} = req.body||{};
  if (!eventId||!marketId||!selectionId||!stake||!cashierId) return res.status(400).json({error:'Missing fields'});
  const ev=STATE.events.get(eventId); if(!ev) return res.status(404).json({error:'Event not found'});
  if (ev.status!=='OPEN') return res.status(400).json({error:'Event not open'});
  const m=STATE.markets.get(marketId); if(!m||m.status!=='OPEN') return res.status(400).json({error:'Market closed'});
  const odds=m.odds[selectionId]; if(!odds) return res.status(400).json({error:'Bad selection'});
  const s=Number(stake); if(s<MIN_STAKE) return res.status(400).json({error:`Min stake is ${MIN_STAKE}`}); if (s>MAX_STAKE) return res.status(400).json({error:`Max stake is ${MAX_STAKE}`});
  const c=ensureCashier(cashierId); if (c.balance < s) return res.status(400).json({error:`Insufficient balance. Available ${fmtMoney(c.balance)}`});
  debitCashier(cashierId, s);
  const id=uuidv4(); const ref=`T-${String(Date.now()).slice(-7)}-${id.slice(0,4).toUpperCase()}`;
  const bet={ id, ref, eventId, marketId, selectionId, stake:s, cashierId, placedAt:Date.now(), odds:Number(odds), status:'PENDING', payout:0 };
  STATE.bets.set(id, bet);
  res.json({ ok:true, bet, rules:{MIN_STAKE,MAX_STAKE,MAX_PAYOUT}, balance: ensureCashier(cashierId).balance });
});
app.get('/bets',(req,res)=>{ const {cashierId}=req.query; let arr=[...STATE.bets.values()]; if(cashierId) arr=arr.filter(b=>b.cashierId===cashierId); arr.sort((a,b)=>b.placedAt-a.placedAt); res.json(arr.slice(0,200)); });

// Receipts
app.get('/receipt/:betId', async (req,res)=>{
  const bet = STATE.bets.get(req.params.betId); if(!bet) return res.status(404).send('Ticket not found');
  const m = STATE.markets.get(bet.marketId); const ev = STATE.events.get(bet.eventId);
  const png = await bwipjs.toBuffer({ bcid:'code128', text: bet.ref, scale:3, height:8, includetext:false, background:'FFFFFF' });
  const barcodeBase64 = `data:image/png;base64,${png.toString('base64')}`;
  res.render('receipt',{ bet, market:m, event: ev, fmtMoney, barcodeBase64, CURRENCY, DOMAIN });
});

// ---- Aviator (separate UI, no odds) ----
// State: round RUNNING -> BUSTED -> IDLE -> restart
function startAviatorRound(){
  const seed = Math.floor(Math.random()*2**32);
  const rand = mulberry32(seed^0x777);
  const u = Math.max(1e-9, rand()); const bust = Math.max(1.0, Number((0.99/u).toFixed(2)));
  STATE.aviator = { roundId: uuidv4(), status:'RUNNING', startedAt: NOW(), bustAt: bust, liveMultiplier: 1.0, tickets: [] };
  // clear any pending manual tickets from previous round
}
function endAviatorRound(){
  const bust = STATE.aviator.bustAt;
  // settle tickets
  for (const tk of STATE.aviator.tickets){
    if (tk.status==='PENDING'){ tk.status='LOST'; tk.payout=0; }
  }
  pushResult('aviator',{ bust });
  STATE.aviator.status='BUSTED';
  setTimeout(()=>{ STATE.aviator.status='IDLE'; STATE.aviator.roundId=null; STATE.aviator.startedAt=0; STATE.aviator.bustAt=0; STATE.aviator.liveMultiplier=1.0; STATE.aviator.tickets=[]; startAviatorRound(); }, 1200);
}
// live loop
setInterval(()=>{
  if (STATE.aviator.status==='IDLE'){ startAviatorRound(); return; }
  if (STATE.aviator.status!=='RUNNING') return;
  const elapsed = (NOW()-STATE.aviator.startedAt)/1000;
  const live = Math.min(STATE.aviator.bustAt, Number((1 + 0.85*elapsed + 0.05*Math.pow(elapsed,1.4)).toFixed(2)));
  STATE.aviator.liveMultiplier = live;
  if (live >= STATE.aviator.bustAt) endAviatorRound();
}, 120);

// Aviator endpoints
app.get('/aviator/state',(req,res)=>{ const A=STATE.aviator; res.json({roundId:A.roundId,status:A.status,startedAt:A.startedAt,bust:A.bustAt,liveMultiplier:A.liveMultiplier}); });
app.get('/aviator/history',(req,res)=>{ res.json(STATE.results.aviator.slice(0,20)); });
app.post('/aviator/place',(req,res)=>{
  const { playerId, cashierId, stake, mode, autoCashout } = req.body||{};
  if (!playerId||!cashierId||!stake) return res.status(400).json({error:'playerId, cashierId, stake required'});
  if (STATE.aviator.status!=='RUNNING') return res.status(400).json({error:'Round not running'});
  const s=Number(stake); if (s<MIN_STAKE) return res.status(400).json({error:`Min stake is ${MIN_STAKE}`}); if (s>MAX_STAKE) return res.status(400).json({error:`Max stake is ${MAX_STAKE}`});
  const P = ensurePlayer(playerId); if (P.balance < s) return res.status(400).json({error:'Player balance too low'});
  debitPlayer(playerId, s); creditCashier(cashierId, s);
  const tk = { id:uuidv4(), ref:`A-${String(Date.now()).slice(-6)}-${Math.floor(Math.random()*900+100)}`, roundId:STATE.aviator.roundId, playerId, cashierId, stake:s, mode:(mode==='manual'?'manual':'auto'), autoCashout:(mode==='manual'? null : Number(autoCashout||2.0)), placedAt:Date.now(), status:'PENDING', payout:0 };
  STATE.aviator.tickets.push(tk);
  // instant auto resolution if threshold already passed
  if (tk.mode==='auto' && STATE.aviator.liveMultiplier>=tk.autoCashout){
    tk.status='WON'; tk.payout=Math.min(Number((tk.stake*tk.autoCashout).toFixed(2)), MAX_PAYOUT); creditCashier(cashierId, tk.payout);
  }
  res.json({ok:true, ticket: tk});
});
app.post('/aviator/cashout',(req,res)=>{
  const { playerId, cashierId } = req.body||{}; if(!playerId||!cashierId) return res.status(400).json({error:'playerId & cashierId required'});
  if (STATE.aviator.status!=='RUNNING') return res.status(400).json({error:'Round not running'});
  const tk = STATE.aviator.tickets.find(t=>t.playerId===playerId && t.status==='PENDING'); if(!tk) return res.status(404).json({error:'No live ticket'});
  const mult = STATE.aviator.liveMultiplier; tk.status='WON'; tk.payout=Math.min(Number((tk.stake*mult).toFixed(2)), MAX_PAYOUT); creditCashier(cashierId, tk.payout);
  res.json({ ok:true, ticket: tk });
});
app.get('/aviator/tickets',(req,res)=>{ const {playerId}=req.query; const list=STATE.aviator.tickets.filter(t=>playerId? t.playerId===playerId : true); list.sort((a,b)=>b.placedAt-a.placedAt); res.json(list.slice(0,50)); });

// ---- Bootstrap
(function bootstrap(){
  ['dog','horse','colors','lotto49'].forEach(g=>scheduleEvent(g));
  ['EPL','LALIGA','UCL'].forEach(L=>seedFootballBatch(L));
  startAviatorRound();
})();

app.listen(PORT, ()=> console.log(`mastermind-bet virtuals on :${PORT} (${DOMAIN})`) );
