const fs=require('fs');
let total=0; const files=[];
for(const f of fs.readdirSync('games').filter(x=>x.endsWith('.js'))){
  const p='games/'+f; let s=fs.readFileSync(p,'utf8'); const before=s;
  s=s.replace(
    /(ctx\.fillStyle = ')([^']*)(';[ \t]*\r?\n\s*)for \((?:var )?(\w+) = 0; \4 < h; \4 \+= 3\) ctx\.fillRect\(0, \4, w, 1\);/g,
    (m, a, colr, b, v) =>
      a + colr + b +
      'if (ctx.__pxH !== h) { var __px = document.createElement(\'canvas\'); __px.width = 1; __px.height = 3;\n' +
      '          var __pxg = __px.getContext(\'2d\'); __pxg.fillStyle = \'' + colr + '\'; __pxg.fillRect(0, 0, 1, 1);\n' +
      '          ctx.__pxP = ctx.createPattern(__px, \'repeat\'); ctx.__pxH = h; }\n' +
      '        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, w, h);'
  );
  if(s!==before){ fs.writeFileSync(p,s); files.push(f); total++; }
}
console.log('patched '+total+' games: '+files.join(', '));
