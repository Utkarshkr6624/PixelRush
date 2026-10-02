const fs=require('fs');
let total=0; const files=[];
for(const f of fs.readdirSync('games').filter(x=>x.endsWith('.js'))){
  const p='games/'+f; let s=fs.readFileSync(p,'utf8'); const before=s;
  // ~140 one-pixel fillRects a frame, every frame, to draw a 3px stripe.
  // Bake the stripe into a 1x3 pattern once and fill with it instead. The
  // pattern hangs off the ctx, so it is released with the canvas.
  s=s.replace(
    /(ctx\.fillStyle = ')([^']*)(';\r?\n\s*)for \((\w+) = 0; \4 < h; \4 \+= 3\) ctx\.fillRect\(0, \4, w, 1\);/g,
    (m, a, colr, b, v) =>
      a + colr + b +
      'if (ctx.__pxH !== h) { var __px = document.createElement(\'canvas\'); __px.width = 1; __px.height = 3;\n' +
      '        var __pxg = __px.getContext(\'2d\'); __pxg.fillStyle = \'' + colr + '\'; __pxg.fillRect(0, 0, 1, 1);\n' +
      '        ctx.__pxP = ctx.createPattern(__px, \'repeat\'); ctx.__pxH = h; }\n' +
      '        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, w, h);'
  );
  if(s!==before){ fs.writeFileSync(p,s); files.push(f); total++; }
}
console.log('patched '+total+' games:');
console.log('  '+files.join('\n  '));
