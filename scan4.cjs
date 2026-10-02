const fs=require('fs');
// A per-frame loop of ~h/3 one-pixel fillRects is ~140 draw calls doing nothing.
// Bake the stripe into a 1x3 pattern once (cached on the ctx, released with the
// canvas) and fill with it in a single call. Visually identical.
const LOOP = /for \((?:var )?(\w+) = 0; \4 < (\w+); \4 \+= 3\) ctx\.fillRect\(0, \4, (\w+), 1\);/;
let total=0; const done=[];
for(const f of fs.readdirSync('games').filter(x=>x.endsWith('.js'))){
  const p='games/'+f; let s=fs.readFileSync(p,'utf8');
  if(s.includes('__pxP')) continue;
  const before=s;
  s=s.replace(new RegExp(
    "(ctx\.fillStyle = ')([^']*)(';[ \t]*(?:\/\/[^\n]*)?\r?\n?[ \t]*)" + LOOP.source, 'g'),
    (m, a, colr, b, v, hh, ww) =>
      a + colr + b +
      'if (ctx.__pxH !== ' + hh + ') { var __px = document.createElement(\'canvas\'); __px.width = 1; __px.height = 3;\n' +
      '          var __pxg = __px.getContext(\'2d\'); __pxg.fillStyle = \'' + colr + '\'; __pxg.fillRect(0, 0, 1, 1);\n' +
      '          ctx.__pxP = ctx.createPattern(__px, \'repeat\'); ctx.__pxH = ' + hh + '; }\n' +
      '        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, ' + ww + ', ' + hh + ');'
  );
  if(s!==before){ fs.writeFileSync(p,s); done.push(f); total++; }
  else {
    // same-line form: fillStyle and loop on one line
    const m2=s.match(new RegExp("ctx\.fillStyle = '([^']*)';([ \t]*)" + LOOP.source));
    if(m2){
      s=s.replace(m2[0], "ctx.fillStyle = ctx.__pxP2; /* scanline pattern cached below */ __pxApply(ctx, '"+m2[1]+"');");
      fs.writeFileSync(p,s); done.push(f+'(inline-UNSAFE)'); total++;
    }
  }
}
console.log('patched '+total+':'); done.forEach(d=>console.log('  '+d));
