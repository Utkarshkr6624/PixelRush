const fs=require('fs');
let total=0, files=[];
for(const f of fs.readdirSync('games').filter(x=>x.endsWith('.js'))){
  const p='games/'+f; let s=fs.readFileSync(p,'utf8'); const before=s;
  // a per-frame loop of ~h/3 one-pixel rects is ~140 draw calls a frame doing
  // almost nothing. Bake the same 3px stripe into a 1x3 pattern ONCE and fill
  // with it. The pattern is cached on the ctx, so it dies with the canvas.
  s=s.replace(
    /(\n(\s*)ctx\.fillStyle = '([^']*)';\r?\n)(\s*)for \((\w+) = 0; \5 < h; \5 \+= 3\) ctx\.fillRect\(0, \5, w, 1\);/g,
    (m, fillLine, ind, colr, loopInd, v) =>
      fillLine + loopInd +
      'if (ctx.__pxH !== h) { var __px = document.createElement(\'canvas\'); __px.width = 1; __px.height = 3;\n' +
      loopInd + '  var __pxg = __px.getContext(\'2d\'); __pxg.fillStyle = \'' + colr + '\'; __pxg.fillRect(0, 0, 1, 1);\n' +
      loopInd + '  ctx.__pxP = ctx.createPattern(__px, \'repeat\'); ctx.__pxH = h; }\n' +
      loopInd + 'ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, w, h);'
  );
  if(s!==before){ fs.writeFileSync(p,s); files.push(f); total++; }
}
console.log('patched '+total+' games:', files.join(', '));
