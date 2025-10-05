// server.js — Mastermind Bet (Virtuals ++, exact manual cashout + more-random busts)
// Node 18+, ESM. package.json MUST contain:  { "type": "module" }
// Requires: express, cors, uuid, ejs, bwip-js
// Optional: node-thermal-printer (guarded)

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import bwipjs from 'bwip-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let ThermalPrinter = null, PrinterTypes = null;
try {
  const tp = require('node-thermal-printer');
  ThermalPrinter = tp.printer;
  PrinterTypes  = tp.types;
} catch { /* printer optional */ }

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ----------------- App & Config -----------------
const app = express();
app.use(cors());
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/static', express.static(path.join(__dirname, 'static')));

const PORT       = process.env.PORT || 4000;
const DOMAIN     = process.env.DOMAIN || 'mastermind-bet.com';
const CURRENCY   = 'KES';
const BUILD_SHA  = process.env.BUILD_SHA || 'local';
const PRINTER_ON = String(process.env.PRINTER_ENABLED||'false') === 'true';

const MIN_STAKE = 20;
const MAX_STAKE = 1000;
const MAX_PAYOUT = 20000;

// ----------------- Utils -----------------
const NOW = () => Date.now();
const MS = { s: 1000, m: 60000 };
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function floorDp(x, dp=2){ const k=10**dp; return Math.floor((x+1e-9)*k)/k; }
function belowDp(x, dp=2){ const k=10**dp; return Math.floor((x-1e-9)*k)/k; }

// odds helpers
const softmax = (arr) => {
  const m = Math.max(...arr);
  const exps = arr.map((v) => Math.exp(v - m));
  const s = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / s);
};
const addMargin = (probs, margin = 0.08) =>
  probs.map((p) => p * (1 - margin)).map((p) => (p <= 0 ? 1000 : 1 / p));
function sampleIndex(probabilities, rand) {
  const r = rand();
  let acc = 0;
  for (let i = 0; i < probabilities.length; i++) {
    acc += probabilities[i];
    if (r <= acc) return i;
  }
  return probabilities.length - 1;
}
function poisson(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

// ----------------- Data -----------------
const LEAGUES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'leagues.json'), 'utf-8')
);

// ----------------- In-memory State -----------------
const STATE = {
  games: ['football','dog','horse','colors','lotto49','aviator'],
  events: new Map(),
  markets: new Map(),
  marketsByEvent: new Map(),
  footballRounds: { EPL:0, LALIGA:0, UCL:0 },
  bets: new Map(),
  results: { football:[], dog:[], horse:[], colors:[], lotto49:[], aviator:[] },
  cashiers: new Map(),
  players: new Map(),

  // ---- Aviator engine ----
  aviator: {
    phase: 'betting',
    multiplier: 1.00,     // displayed (capped at bust)
    history: [],
    t0: Date.now(),
    nextChangeAt: Date.now() + 5000,
    seed: Math.floor(Math.random()*2**31),
    bustAt: 5.0,
    bets: new Map(),
    lastCashable: 1.00,    // last fair live multiplier strictly below bust (2dp)
    rateJitter: 1.0        // per-round speed jitter
  }
};

// Tunable pacing (frontend references SPEED to sync visuals)
const AVIATOR_CFG = {
  SPEED: 0.64,          // gentler baseline
  EASE_POWER: 1.20,     // smoother early ramp
  MIN_BET_MS: 4500,
  MIN_FLY_MS: 5500,
  BUST_HOLD_MS: 2000,
  MAX_BUST: 50
};

// Exposure-aware shaping (house edge preserved)
const EXPOSURE_CFG = {
  hiTailChanceNoBets: 0.35, // more big rounds when nobody bet
  hiTailMin: 8,
  hiTailMax: 30,
  softCapBase: 6.5,
  softCapPerK: 1.2,
  minBelowBustForManual: 0.01 // manual payouts strictly < bust
};

// === Dynamic min-flight (instant bust for tiny multipliers) ===
function dynamicMinFlyMs(bust) {
  if (!bust || bust <= 1.02) return 120;
  if (bust <= 1.10) return 900;
  if (bust <= 1.30) return 2000;
  return AVIATOR_CFG.MIN_FLY_MS;
}

function ensureCashier(id){ if(!STATE.cashiers.has(id)) STATE.cashiers.set(id,{balance:0}); return STATE.cashiers.get(id); }
function creditCashier(id,amt){ ensureCashier(id).balance += Number(amt)||0; }
function ensurePlayer(id){ if(!STATE.players.has(id)) STATE.players.set(id,{balance:0}); return STATE.players.get(id); }
function creditPlayer(id,amt){ ensurePlayer(id).balance += Number(amt)||0; }
function debitPlayer(id,amt){ const u=ensurePlayer(id); if (u.balance < amt) return false; u.balance -= amt; return true; }

// cycles
const CYCLE = { football:180*MS.s, dog:120*MS.s, horse:120*MS.s, colors:60*MS.s, lotto49:60*MS.s };
const LOCK_OFFSET = 10*MS.s;

// ----------------- Builders -----------------
function putMarket(m){
  STATE.markets.set(m.id, m);
  if(!STATE.marketsByEvent.has(m.eventId)) STATE.marketsByEvent.set(m.eventId, []);
  STATE.marketsByEvent.get(m.eventId).push(m.id);
}
function scheduleEvent(game, extra = {}){
  const id = uuidv4();
  const seed = Math.floor(Math.random()*2**32);
  const startsAt = NOW();
  const runsAt   = startsAt + CYCLE[game];
  const locksAt  = runsAt - LOCK_OFFSET;
  const ev = { id, game, status:'OPEN', seed, startsAt, locksAt, runsAt, result:null, audit:[], ...extra };
  STATE.events.set(id, ev);
  buildMarketsForEvent(ev);
  return ev;
}
function pushResult(game, data){
  const arr = STATE.results[game];
  arr.unshift({ ts: Date.now(), ...data });
  if (arr.length > 30) arr.length = 30;
}

// Football fixtures (round-robin pairings)
function generateRoundFixtures(leagueKey, roundIdx){
  const teams = LEAGUES[leagueKey].map(([name,abbr])=>({name,abbr}));
  const list = teams.slice();
  if (list.length % 2 === 1) list.push({name:'BYE', abbr:'BYE'});
  const n = list.length, half = n/2;

  let left = list.slice(0, half);
  let right = list.slice(half).reverse();

  for (let r=0; r<roundIdx; r++){
    const keep = left[0];
    const l = left.slice(1);
    const firstRight = right[0];
    right = right.slice(1).concat(l[l.length-1]);
    left  = [keep, ...l.slice(0, l.length-1), firstRight];
  }

  const fixtures = [];
  for (let i=0;i<half;i++){
    const A = left[i], B = right[i];
    if (A.abbr!=='BYE' && B.abbr!=='BYE') fixtures.push([A,B]);
  }
  return fixtures;
}

function seedFootballBatch(leagueKey){
  const round = STATE.footballRounds[leagueKey] || 0;
  const fixtures = generateRoundFixtures(leagueKey, round);
  for (const [home, away] of fixtures.slice(0,10)){ // 10 fixtures
    scheduleEvent('football', { league: leagueKey, home, away });
  }
  STATE.footballRounds[leagueKey] = (round + 1) % 19;
}

function buildMarketsForEvent(ev){
  const rand = mulberry32(ev.seed);

  if (ev.game === 'football'){
    const { home, away, league } = ev;
    const homeAtk = 1.1 + rand()*0.6, homeDef = 1.0 + rand()*0.5;
    const awayAtk = 1.0 + rand()*0.6, awayDef = 1.1 + rand()*0.5;
    const lamH = 1.35 * homeAtk / awayDef;
    const lamA = 1.10 * awayAtk / homeDef;

    let H=0,D=0,A=0,BTTSy=0,H15=0,A15=0; const trials=3000; const r2=mulberry32(ev.seed^0x55aa);
    for(let t=0;t<trials;t++){
      const gh=poisson(lamH,r2), ga=poisson(lamA,r2);
      if (gh>ga) H++; else if (gh<ga) A++; else D++;
      if (gh>0 && ga>0) BTTSy++;
      if (gh>=2) H15++; if (ga>=2) A15++;
    }
    const pH=H/trials, pD=D/trials, pA=A/trials;
    function poissCdf(k,lam){ let p=Math.exp(-lam); if(k===0) return p; let acc=p; for(let i=1;i<=k;i++){ p=p*lam/i; acc+=p; } return acc; }
    const lamT = lamH + lamA;
    const pOver15 = 1 - poissCdf(1, lamT);
    const pOver25 = 1 - poissCdf(2, lamT);
    const odds1x2 = addMargin([pH,pD,pA], 0.07).map(x=>Number(x.toFixed(2)));
    const oddsOU15= addMargin([pOver15,1-pOver15],0.05).map(x=>Number(x.toFixed(2)));
    const oddsOU25= addMargin([pOver25,1-pOver25],0.05).map(x=>Number(x.toFixed(2)));
    const oddsBTTS= addMargin([BTTSy/trials,1-BTTSy/trials],0.05).map(x=>Number(x.toFixed(2)));
    const oddsHomeOU15 = addMargin([H15/trials, 1-H15/trials],0.06).map(x=>Number(x.toFixed(2)));
    const oddsAwayOU15 = addMargin([A15/trials, 1-A15/trials],0.06).map(x=>Number(x.toFixed(2)));

    function comboOdds(sel, overProb){ const base = (sel==='H'?pH: sel==='D'?pD:pA) * overProb; return Number((1/(base*0.90)).toFixed(2)); }
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
    const runners = ev.game==='dog' ? 6 : 8;
    const ratings = Array.from({length:runners}, ()=> 0.5 + (rand()-0.5)*0.6);
    const names = Array.from({length:runners}, (_,i)=> `${ev.game.toUpperCase()} #${i+1}`);
    const probs = softmax(ratings);
    const winOdds = addMargin(probs, 0.08).map(x=>Number(x.toFixed(2)));

    putMarket({ id:uuidv4(), eventId:ev.id, type:'MAIN_WIN', status:'OPEN',
      selections:names.map((n,i)=>({id:`R${i+1}`, name:n})),
      odds:Object.fromEntries(names.map((_,i)=>[`R${i+1}`, winOdds[i]])) });

    const forecastOdds = {};
    for(let a=1;a<=runners;a++) for(let b=1;b<=runners;b++) if(a!==b){
      const p = probs[a-1] * (probs[b-1] / (1 - probs[a-1] + 1e-9));
      forecastOdds[`R${a}>R${b}`] = Number((1/(p*0.88)).toFixed(2));
    }
    putMarket({ id:uuidv4(), eventId:ev.id, type:'FORECAST', status:'OPEN',
      selections:Object.keys(forecastOdds).map(k=>({id:k, name:k.replace('>',' → ')})),
      odds:forecastOdds });

    const quinellaOdds = {};
    for(let a=1;a<=runners;a++) for(let b=a+1;b<=runners;b++){
      const p = probs[a-1]*probs[b-1]*2;
      quinellaOdds[`R${a}&R${b}`] = Number((1/(p*0.90)).toFixed(2));
    }
    putMarket({ id:uuidv4(), eventId:ev.id, type:'QUINELLA', status:'OPEN',
      selections:Object.keys(quinellaOdds).map(k=>({id:k, name:k.replace('&',' + ')})),
      odds:quinellaOdds });

    const tricastOdds = {}; let count=0; const limit = ev.game==='dog'?60:80;
    for(let a=1;a<=runners;a++){ for(let b=1;b<=runners;b++){ for(let c=1;c<=runners;c++){
      if (a===b||b===c||a===c) continue;
      const p = probs[a-1] * (probs[b-1]/(1-probs[a-1]+1e-9)) * (probs[c-1]/(1-probs[a-1]-probs[b-1]+1e-9));
      tricastOdds[`R${a}>R${b}>R${c}`] = Number((1/(p*0.82)).toFixed(2)); count++; if(count>=limit) break;
    }} if(count>=limit) break; }
    putMarket({ id:uuidv4(), eventId:ev.id, type:'TRICAST', status:'OPEN',
      selections:Object.keys(tricastOdds).map(k=>({id:k, name:k.replace(/>/g,' → ')})),
      odds:tricastOdds });
  }

  if (ev.game==='colors'){
    const colors = ['RED','BLUE','GREEN','YELLOW','PURPLE','BLACK'];
    const probs  = [0.18,0.18,0.18,0.16,0.15,0.15];
    const odds   = addMargin(probs, 0.05).map(x=>Number(x.toFixed(2)));
    putMarket({ id:uuidv4(), eventId:ev.id, type:'MAIN_COLOR', status:'OPEN',
      selections:colors.map(c=>({id:c, name:c})),
      odds:Object.fromEntries(colors.map((c,i)=>[c,odds[i]])) });
  }

  if (ev.game==='lotto49'){
    const picks = Array.from({length:49},(_,i)=>String(i+1));
    const p=1/49; const price = Number((1/(p*0.92)).toFixed(2));
    putMarket({ id:uuidv4(), eventId:ev.id, type:'PICK1', status:'OPEN',
      selections:picks.map(id=>({id, name:id})),
      odds:Object.fromEntries(picks.map(id=>[id,price])) });
  }
}

// ----------------- Run & Settle -----------------
function settleBetsForEvent(ev){
  for (const bet of STATE.bets.values()){
    if (bet.eventId !== ev.id || bet.status !== 'PENDING') continue;
    const m = STATE.markets.get(bet.marketId); if (!m){ bet.status='LOST'; bet.payout=0; continue; }

    let won = false;
    if (ev.game==='football'){
      const total = ev.result.homeGoals + ev.result.awayGoals;
      const outcome = ev.result.homeGoals>ev.result.awayGoals?'H': ev.result.homeGoals<ev.result.awayGoals?'A':'D';
      if (m.type.startsWith('MAIN_1X2')) won = (bet.selectionId===outcome);
      if (m.type.startsWith('OU_1_5')) won = (bet.selectionId==='OVER'? total>1 : total<=1);
      if (m.type.startsWith('OU_2_5')) won = (bet.selectionId==='OVER'? total>2 : total<=2);
      if (m.type.startsWith('BTTS')){
        const y = (ev.result.homeGoals>0 && ev.result.awayGoals>0)?'YES':'NO';
        won = (bet.selectionId===y);
      }
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

    const payout = won ? Math.min(Number((bet.stake * bet.odds).toFixed(2)), MAX_PAYOUT) : 0;
    bet.payout = payout; bet.status = won ? 'WON' : 'LOST';
    if (won) creditCashier(bet.cashierId, payout);
  }
}

function runEvent(eventId){
  const ev = STATE.events.get(eventId);
  if (!ev || ev.status==='SETTLED' || ev.status==='RUNNING') return ev;
  ev.status = 'RUNNING';
  const rand = mulberry32(ev.seed ^ 0x123456);

  if (ev.game==='football'){
    const r2 = mulberry32(ev.seed ^ 0x99aa);
    const gh = poisson(1.3+0.7*r2(), r2);
    const ga = poisson(1.1+0.6*r2(), r2);
    ev.result = { league:ev.league, home:ev.home, away:ev.away, homeGoals:gh, awayGoals:ga };
    pushResult('football', { league: ev.league, score: `${ev.home.abbr} ${gh}-${ga} ${ev.away.abbr}` });
  }

  if (ev.game==='dog' || ev.game==='horse'){
    const mIds = STATE.marketsByEvent.get(ev.id) || [];
    const winM = mIds.map(id=>STATE.markets.get(id)).find(x=>x.type==='MAIN_WIN');
    const ids = winM?.selections?.map(s=>s.id) || [];
    const fair = ids.map(id => 1/(winM?.odds?.[id]||1));
    const s = fair.reduce((a,b)=>a+b,0)||1; for(let i=0;i<fair.length;i++) fair[i]/=s;
    const pool = ids.map((id,i)=>({id,w:fair[i]}));
    const positions=[]; let tmp=pool.slice();
    while(tmp.length){
      const sum=tmp.map(x=>x.w).reduce((a,b)=>a+b,0);
      const probs=tmp.map(x=>x.w/sum);
      const ix=sampleIndex(probs,rand);
      positions.push({id:tmp[ix].id}); tmp.splice(ix,1);
    }
    ev.result = { positions: positions.map((p,i)=>({id:p.id, rank:i+1})) };
    pushResult(ev.game, { podium: ev.result.positions });
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
  ev.status = 'SETTLED';
  return ev;
}

// ----------------- Aviator Helpers -----------------
function drawBustCore(seed, alpha = 3.2, min = 1.00, max = AVIATOR_CFG.MAX_BUST){
  const r = mulberry32(seed)();
  const bust = min / Math.pow(1 - r, 1/alpha);
  return Math.max(min, Math.min(bust, max));
}
function drawBust(seed){ return drawBustCore(seed, 3.2, 1.00, AVIATOR_CFG.MAX_BUST); }
function roundRef(){ return 'R-' + String(STATE.results.aviator.length+1).padStart(5,'0'); }

function liveExposureSummary(A){
  let stakeTotal = 0, liveCount = 0;
  for (const [,bet] of A.bets){ if (bet.live && !bet.cashed){ liveCount++; stakeTotal += bet.stake||0; } }
  return { liveCount, stakeTotal };
}
function pickBustForRound(A){
  const { liveCount, stakeTotal } = liveExposureSummary(A);
  // Wider alpha jitter for more variety (2.2–5.0)
  const alphaJitter = 2.2 + mulberry32(A.seed ^ 0x3434)()*2.8;

  // No bets: allow heavy tails more often
  if (liveCount === 0){
    const hi = mulberry32(A.seed ^ 0x5a5a)() < EXPOSURE_CFG.hiTailChanceNoBets;
    if (hi){
      // micro-jitter to diversify decimals
      const micro = 1 + (mulberry32(A.seed ^ 0x9e9e)() - 0.5)*0.02; // +/-1%
      return Math.max(
        EXPOSURE_CFG.hiTailMin,
        Math.min(drawBustCore(A.seed ^ 0x7777, alphaJitter, 1.00, EXPOSURE_CFG.hiTailMax)*micro, EXPOSURE_CFG.hiTailMax)
      );
    }
    const micro = 1 + (mulberry32(A.seed ^ 0x8a8a)() - 0.5)*0.02;
    return drawBustCore(A.seed, alphaJitter, 1.00, AVIATOR_CFG.MAX_BUST)*micro;
  }

  // With exposure: soft cap increases with stakes
  const perK = Math.max(0, stakeTotal/1000);
  const softCap = Math.max(2.0, EXPOSURE_CFG.softCapBase + perK * EXPOSURE_CFG.softCapPerK);

  const micro = 1 + (mulberry32(A.seed ^ 0x7c7c)() - 0.5)*0.02;
  const base = drawBustCore(A.seed, alphaJitter, 1.00, AVIATOR_CFG.MAX_BUST)*micro;
  if (base <= softCap) return base;

  const over = base - softCap;
  const squashed = softCap + over / (1 + 0.9*over); // smooth squashing above softCap
  return Math.min(Math.max(1.00, squashed), AVIATOR_CFG.MAX_BUST);
}

function startTakeoff(A, now){
  A.phase = 'flying';
  A.t0 = now;
  A.seed = (A.seed + 1) >>> 0;
  A.rateJitter = 0.92 + mulberry32(A.seed ^ 0xaaaa)()*0.22; // 0.92–1.14
  A.bustAt = pickBustForRound(A);
  A.multiplier = 1.00;
  A.lastCashable = 1.00;
}

function liveMultiplierNow(A, now){
  const tSec   = Math.max(0, (now - A.t0)/1000);
  const shaped = Math.pow(tSec, AVIATOR_CFG.EASE_POWER);
  const speed  = AVIATOR_CFG.SPEED * (A.rateJitter || 1.0);
  return Math.max(1.00, Math.exp(speed * shaped)); // uncapped
}

function advanceAviator(now){
  const A = STATE.aviator;

  if (A.phase==='betting' && now - A.nextChangeAt > 60000){
    A.nextChangeAt = now + 800;
  }

  if (A.phase === 'betting'){
    if (now >= A.nextChangeAt){
      startTakeoff(A, now);
    }
    return;
  }

  if (A.phase === 'flying'){
    const mLive  = liveMultiplierNow(A, now);
    A.multiplier = Math.min(mLive, A.bustAt);
    const nextUnderBust = belowDp(A.bustAt, 2);
    A.lastCashable = Math.max(1.00, Math.min(floorDp(mLive,2), nextUnderBust));

    // Auto-cashouts (exact target)
    for (const [pid, bet] of A.bets){
      if (!bet.live || bet.cashed || !bet.autoCashOut) continue;
      if (A.multiplier >= bet.autoCashOut){
        bet.cashed = true; bet.live=false;
        bet.hit    = Number(bet.autoCashOut.toFixed(2));
        bet.payout = Math.min(bet.stake * bet.hit, MAX_PAYOUT);
        creditPlayer(pid, bet.payout);
      }
    }

    if (mLive >= A.bustAt && (now - A.t0) >= dynamicMinFlyMs(A.bustAt)){
      A.phase = 'busted';
      const m = Number(A.bustAt.toFixed(2));
      STATE.results.aviator.unshift(m); if (STATE.results.aviator.length>120) STATE.results.aviator.length=120;

      for (const [pid, bet] of A.bets){
        if (bet.live && !bet.cashed){ bet.live=false; bet.payout=0; bet.hit=m; }
      }
      A.nextChangeAt = now + AVIATOR_CFG.BUST_HOLD_MS;
      A.multiplier = A.bustAt;
    }
    return;
  }

  if (A.phase === 'busted'){
    if (now >= A.nextChangeAt){
      A.phase = 'betting';
      A.multiplier = 1.00;
      A.bets.clear();
      A.t0 = now;
      A.nextChangeAt = now + AVIATOR_CFG.MIN_BET_MS;
    }
    return;
  }
}

// ----------------- Global scheduler (other games) -----------------
function schedulerTick(now){
  for (const ev of STATE.events.values()){
    if (ev.status==='OPEN' && now >= ev.locksAt) ev.status='LOCKED';
    if ((ev.status==='LOCKED' || ev.status==='OPEN') && now >= ev.runsAt) runEvent(ev.id);
  }
  // keep queues filled
  ['dog','horse','colors','lotto49'].forEach(g=>{
    const future = [...STATE.events.values()].filter(e=>e.game===g && (e.status==='OPEN'||e.status==='LOCKED'));
    if (future.length < 1) scheduleEvent(g);
  });
  ['EPL','LALIGA','UCL'].forEach(L=>{
    const future = [...STATE.events.values()].filter(e=>e.game==='football' && e.league===L && (e.status==='OPEN'||e.status==='LOCKED'));
    if (future.length < 10) seedFootballBatch(L);
  });
}

// ----------------- Tickers -----------------
const TICK_MS = 100;
setInterval(()=>{ try{ advanceAviator(NOW()); }catch(e){ console.error('Aviator tick error:', e); } }, TICK_MS);
setInterval(()=>{ try{ schedulerTick(NOW()); }catch(e){ console.error('Scheduler tick error:', e); } }, 1000);
advanceAviator(NOW());
schedulerTick(NOW());

// ----------------- API: Common -----------------
app.get('/health', (_req,res)=> res.json({ ok:true, ts:Date.now(), sha:BUILD_SHA }));
app.get('/games',  (_req,res)=> res.json(STATE.games));
app.get('/events', (req,res)=> {
  const { game } = req.query;
  let arr = [...STATE.events.values()];
  if (game) arr = arr.filter(e=>e.game===game);
  arr.sort((a,b)=>a.runsAt-b.runsAt);
  res.json(arr.slice(0,60));
});
app.get('/events/:id', (req,res)=> {
  const ev = STATE.events.get(req.params.id);
  if (!ev) return res.status(404).json({error:'Not found'});
  res.json(ev);
});
app.get('/markets/:eventId', (req,res)=>{
  const mids = STATE.marketsByEvent.get(req.params.eventId)||[];
  const markets = mids.map(id=>STATE.markets.get(id));
  if (!markets.length) return res.status(404).json({error:'No markets'});
  res.json(markets);
});

// ----------------- Bets & Receipts -----------------
app.post('/bets', (req,res)=>{
  const { eventId, marketId, selectionId, stake, cashierId } = req.body || {};
  if (!eventId || !marketId || !selectionId || !stake || !cashierId) return res.status(400).json({error:'Missing fields'});
  const st = Math.max(MIN_STAKE, Math.min(MAX_STAKE, Number(stake)));
  const ev = STATE.events.get(eventId); if (!ev) return res.status(404).json({error:'Event not found'});
  if (ev.status!=='OPEN') return res.status(400).json({error:`Event not open. Status=${ev.status}`});
  const m = STATE.markets.get(marketId); if (!m) return res.status(404).json({error:'Market not found'});
  if (m.status!=='OPEN') return res.status(400).json({error:'Market closed'});
  const odds = Number(m.odds[selectionId]); if (!odds) return res.status(400).json({error:'Selection not found'});

  const id = uuidv4();
  const bet = { id, eventId, marketId, selectionId, stake: st, cashierId, placedAt: Date.now(), odds, status:'PENDING', payout:0, game: ev.game };
  STATE.bets.set(id, bet);
  res.json({ ok:true, betId:id, bet });
});

app.get('/receipt/:id', async (req,res)=>{
  const bet = STATE.bets.get(req.params.id);
  if (!bet) return res.status(404).send('Not found');

  const code = bet.id.slice(0,8).toUpperCase();
  let barcodePng = '';
  try{
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 2, height: 10, includetext:false });
    barcodePng = `data:image/png;base64,${png.toString('base64')}`;
  }catch{}

  res.render('receipt', {
    domain: DOMAIN,
    ref: `T-${code}`,
    game: bet.game.toUpperCase(),
    market: STATE.markets.get(bet.marketId)?.type || '',
    pick: bet.selectionId,
    odds: bet.odds,
    stake: bet.stake,
    placedAt: new Date(bet.placedAt),
    barcodePng
  });
});

// ----------------- Aviator API -----------------
app.get('/aviator', (_req,res)=> res.sendFile(path.join(__dirname, 'static', 'aviator.html')));
app.get('/aviator/state', (_req,res)=>{
  const now = NOW();
  advanceAviator(now); // drive engine on read

  const A = STATE.aviator;
  const phaseMap = { betting:'BETTING', flying:'RUNNING', busted:'BUST' };

  res.json({
    phase: A.phase,
    multiplier: Number(A.multiplier.toFixed(2)),
    history: STATE.results.aviator.slice(0,60),
    roundId: roundRef(),
    status: phaseMap[A.phase],
    liveMultiplier: Number(A.multiplier.toFixed(2)),
    bust: Number(A.bustAt.toFixed(2)),
    serverNow: now,
    speed: AVIATOR_CFG.SPEED,
    minBetMs: AVIATOR_CFG.MIN_BET_MS,
    minFlyMs: AVIATOR_CFG.MIN_FLY_MS,
    bustHoldMs: AVIATOR_CFG.BUST_HOLD_MS
  });
});

app.post('/aviator/wallet/load', (req,res)=>{
  const { playerId, amount } = req.body || {};
  if (!playerId || !amount) return res.status(400).json({ ok:false, error:'playerId & amount required' });
  creditPlayer(playerId, Number(amount));
  res.json({ ok:true, balance: ensurePlayer(playerId).balance });
});
app.get('/aviator/wallet/:playerId', (req,res)=> res.json({ ok:true, balance: ensurePlayer(req.params.playerId).balance }));

app.post('/aviator/bet', (req,res)=>{
  const { playerId, stake, autoCashOut } = req.body || {};
  if (!playerId) return res.status(400).json({ ok:false, error:'playerId required' });
  const A = STATE.aviator;
  if (A.phase !== 'betting') return res.status(400).json({ ok:false, error:'Round closed' });
  if (A.bets.has(playerId)) return res.status(400).json({ ok:false, error:'Already placed' });

  const st = Math.max(MIN_STAKE, Math.min(MAX_STAKE, Number(stake||0)));
  if (!debitPlayer(playerId, st)) return res.status(400).json({ ok:false, error:`Insufficient balance` });

  const bet = { ticketId:`${roundRef()}-${playerId}`, stake:st, autoCashOut:autoCashOut?Math.max(1.05,Number(autoCashOut)):null, live:true, cashed:false };
  A.bets.set(playerId, bet);
  res.json({ ok:true, ticketId: bet.ticketId, stake: bet.stake, autoCashOut: bet.autoCashOut, balance: ensurePlayer(playerId).balance });
});

// Manual cashout: exact live multiplier at click, floored to 2dp (never bust)
app.post('/aviator/cashout', (req,res)=>{
  const { playerId } = req.body || {};
  const now = NOW();
  advanceAviator(now); // sync engine before computing live
  const A = STATE.aviator;

  const bet = A.bets.get(playerId);
  if (!bet) return res.status(400).json({ ok:false, error:'No live bet' });
  if (A.phase !== 'flying') return res.status(400).json({ ok:false, error:'Not flying' });
  if (!bet.live || bet.cashed) return res.status(400).json({ ok:false, error:'Already settled' });

  const mLive = liveMultiplierNow(A, now);
  if (mLive >= A.bustAt) return res.status(400).json({ ok:false, error:'Too late (busting)' });

  const exact = floorDp(Math.min(mLive, A.bustAt - EXPOSURE_CFG.minBelowBustForManual), 2); // e.g. 1.19 stays 1.19
  const hit   = Math.max(1.00, exact);

  bet.cashed = true; bet.live = false; bet.hit = hit;
  bet.payout = Math.min(bet.stake * hit, MAX_PAYOUT);
  creditPlayer(playerId, bet.payout);

  res.json({ ok:true, multiplier: hit, payout: Number(bet.payout.toFixed(2)), balance: ensurePlayer(playerId).balance });
});

// --- admin nudges (optional) ---
app.post('/aviator/admin/nudge', (_req,res)=>{
  const A = STATE.aviator;
  if (A.phase==='betting') A.nextChangeAt = NOW() + 300;
  res.json({ ok:true, phase:A.phase, nextChangeAt:A.nextChangeAt });
});
app.post('/aviator/admin/reset', (_req,res)=>{
  const A = STATE.aviator;
  A.phase='betting'; A.multiplier=1; A.bets.clear(); A.t0=NOW(); A.nextChangeAt=NOW()+1500;
  res.json({ ok:true });
});

// ----------------- Root -----------------
app.get('/', (_req,res)=> res.redirect('/static/cashier.html'));

// ----------------- Boot -----------------
app.listen(PORT, ()=>{
  console.log(`Mastermind server on :${PORT} (${DOMAIN})`);
  // seed queues
  ['dog','horse','colors','lotto49'].forEach(g=>{ scheduleEvent(g); });
  ['EPL','LALIGA','UCL'].forEach(L=> seedFootballBatch(L));
});
