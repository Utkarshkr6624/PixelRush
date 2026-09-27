/* ============================================================================
   set-domain — rewrite the site origin in every file that hard-codes it.

   The build ships with the reserved placeholder https://pixelrush.example,
   which does not resolve. Replace it with the real host before deploying:

       node set-domain.cjs yourdomain.com
       node set-domain.cjs arcade.yourdomain.com/arcade     (subpath is fine)

   It updates, in place: every *.html page (canonical, og:url, twitter:url and
   the JSON-LD @id graph), robots.txt, sitemap.xml and manifest.webmanifest.
   Run it with no argument to see the current value.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const OLD = 'https://pixelrush.example';
const arg = (process.argv[2] || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

const files = [];
for (const f of fs.readdirSync('.')) {
  if (/\.(html|xml|txt|webmanifest)$/i.test(f)) files.push(f);
}

if (!arg) {
  const hits = files.filter(f => fs.readFileSync(f, 'utf8').includes(OLD));
  console.log(`Current origin: ${OLD}`);
  console.log(`Found in ${hits.length} file(s): ${hits.join(', ') || 'none'}`);
  console.log('\nUsage:  node set-domain.cjs yourdomain.com');
  process.exit(0);
}

if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(arg)) {
  console.error(`"${arg}" does not look like a domain. Try: node set-domain.cjs yourdomain.com`);
  process.exit(1);
}

const NEW = 'https://' + arg;
let changed = 0, total = 0;
for (const f of files) {
  const p = path.join('.', f);
  const before = fs.readFileSync(p, 'utf8');
  const count = before.split(OLD).length - 1;
  if (!count) continue;
  fs.writeFileSync(p, before.split(OLD).join(NEW));
  console.log(`  ${f.padEnd(20)} ${count} replacement(s)`);
  changed++; total += count;
}
console.log(`\n${OLD} -> ${NEW}`);
console.log(`${total} reference(s) updated across ${changed} file(s).`);
console.log('Re-serve and hard-reload so nothing is cached from the old origin.');
