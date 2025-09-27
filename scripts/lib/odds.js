// scripts/lib/odds.js
function r(min, max){ return Math.random()*(max-min)+min; }
function fix2(x){ return Math.round(Number(x)*100)/100; }

// football base odds by strength delta
function threeWayOdds(delta){ // delta: -1.0..+1.0 (home weaker..stronger)
  // build reasonable 1X2 with margin
  const home = fix2(1.7 - 0.5*delta + r(-0.1,0.1));
  const draw = fix2(3.2 + r(-0.2,0.2));
  const away = fix2(4.0 + 0.6*delta + r(-0.2,0.2));
  return { H:Math.max(1.35,home), D:Math.max(2.8,draw), A:Math.max(1.7,away) };
}

function yesNoOdds(center){ // center ~ 1.85
  const y = fix2(center + r(-0.1,0.1));
  const n = fix2(3.7 - y); // simple mirror to keep fair-ish book
  return { Y:y, N:n };
}

function ouOdds(target){ // 1.5, 2.5
  const over = fix2(1.75 + (target===2.5?0.15:0) + r(-0.1,0.1));
  const under= fix2(2.1  - (target===2.5?0.15:0) + r(-0.1,0.1));
  return { OV:over, UN:under };
}

// derived double chance from 1X2 (shrink margin a bit)
function doubleChance(oneXtwo){
  const inv = (o)=>1/o;
  const norm = inv(oneXtwo.H)+inv(oneXtwo.D)+inv(oneXtwo.A);
  return {
    '1X': fix2(1/( (inv(oneXtwo.H)+inv(oneXtwo.D)) / norm ) - 0.05),
    '12': fix2(1/( (inv(oneXtwo.H)+inv(oneXtwo.A)) / norm ) - 0.05),
    'X2': fix2(1/( (inv(oneXtwo.D)+inv(oneXtwo.A)) / norm ) - 0.05),
  };
}

// race odds helpers (N runners)
function winBook(n){
  // simple descending prices 2.4 .. 9.0
  const arr=[]; for(let i=0;i<n;i++) arr.push(fix2(2.4 + i*0.9 + r(-0.15,0.15)));
  return arr;
}
function forecastPrice(win1, win2){ return fix2((win1*win2)/3.2); }
function quinellaPrice(win1, win2){ return fix2((win1*win2)/4.0); }
function tricastPrice(w1, w2, w3){ return fix2((w1*w2*w3)/5.0); }

module.exports = { threeWayOdds, yesNoOdds, ouOdds, doubleChance, winBook, forecastPrice, quinellaPrice, tricastPrice, fix2 };
