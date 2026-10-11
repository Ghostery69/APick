#!/usr/bin/env node
/**
 * Build AnoPick FX
 *
 *   node build.mjs <entrée.html> <sortie.html>
 *
 * 1. compile src/fx.ts avec tsc (mode strict) ;
 * 2. injecte src/fx.css dans <head> et le JS compilé avant </body> ;
 * 3. ajuste le texte « À propos » (les scripts d'effets viennent d'un CDN) ;
 * 4. est idempotent : relancer sur un fichier déjà construit remplace les blocs FX.
 *
 * Le code existant de l'app n'est jamais modifié.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage : node build.mjs <entrée.html> <sortie.html>');
  process.exit(1);
}

execFileSync('npx', ['tsc', '-p', resolve(here, 'tsconfig.json')], { stdio: 'inherit', cwd: here, shell: true });

const css = readFileSync(resolve(here, 'src/fx.css'), 'utf8').trim();
const js = readFileSync(resolve(here, 'dist/fx.js'), 'utf8').replace(/^export \{\};\s*$/m, '').trim();

const CSS_START = '<!--fx:css:start-->';
const CSS_END = '<!--fx:css:end-->';
const JS_START = '<!--fx:js:start-->';
const JS_END = '<!--fx:js:end-->';
const strip = (html, a, b) => html.replace(new RegExp(`\\n?${a}[\\s\\S]*?${b}\\n?`, 'g'), '\n');

let html = readFileSync(resolve(input), 'utf8');
html = strip(strip(html, CSS_START, CSS_END), JS_START, JS_END);

if (!html.includes('</head>') || !html.includes('</body>')) {
  console.error('Le fichier ne contient pas </head> ou </body>.');
  process.exit(1);
}

html = html.replace('</head>', `${CSS_START}\n<style id="fx-css">\n${css}\n</style>\n${CSS_END}\n</head>`);
// Module : exécuté après l'analyse du document, donc après le script de l'app et Motion.
html = html.replace('</body>', `${JS_START}\n<script type="module" id="fx-js">\n${js}\n</script>\n${JS_END}\n</body>`);

const before = 'Les polices peuvent être chargées depuis Google Fonts.';
const after =
  'Les polices peuvent être chargées depuis Google Fonts. Sur les appareils compatibles, des effets de défilement et de 3D peuvent être chargés depuis jsDelivr ; aucune image n’y est envoyée.';
if (html.includes('jsDelivr')) {
  // déjà ajusté lors d'un build précédent
} else if (html.includes(before)) html = html.replace(before, after);
else console.warn('Texte « À propos » introuvable : à vérifier à la main.');

writeFileSync(resolve(output), html);
console.log(`OK → ${output} (${(html.length / 1024).toFixed(0)} Ko)`);
