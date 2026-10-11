# AnoPick FX — couche d'amélioration (Motion + Lenis + Three.js, en TypeScript)

Rien dans le code existant d'AnoPick n'est modifié (hormis une phrase dans « À propos »,
qui mentionne désormais jsDelivr). Les effets s'ajoutent par-dessus, via le DOM.

## Reconstruire
    cd sources
    npm install                    # installe TypeScript (une seule fois)
    npm run build                  # produit ../app.html depuis original.html

`build.mjs` compile `src/fx.ts` (strict), injecte `src/fx.css` dans <head> et le JS
avant </body>. Il est idempotent.

## Contacts du développeur
Dans `src/fx.ts`, objet `DEVELOPER` : WhatsApp, e-mail et téléphone sont renseignés.
Un lien contenant `NUMERO`, `ADRESSE`, `exemple.com` ou `XXXX` reste inactif (aucun faux lien en ligne).
Ajoute, retire ou réordonne les entrées librement (icônes : chat, mail, phone, link, send).

## Présentation d'accueil
3 écrans, affichés à la première visite seulement (clé `anopick_intro_v1`), rejouables depuis
Réglages > « Revoir la présentation ». Un utilisateur qui a déjà des palettes n'est pas dérangé.

## Transitions
Chaque page a sa chorégraphie (objet `CHOREO`) ; l'ancienne page s'efface en « fantôme ».
Ajouter une page ou changer l'ordre d'arrivée des éléments = éditer `CHOREO`.

## Réglages (en haut de src/fx.ts)
- `LENIS_URL`, `THREE_URL` : versions épinglées. Pour fonctionner hors ligne, télécharge
  les deux fichiers dans ton dépôt et remplace par des chemins relatifs.
- `SYNC_HERO_WITH_PALETTE` : `false` pour garder les pastilles 3D aux couleurs de la marque.
- Pour désactiver une brique : retire sa ligne dans le tableau `features`.

## Garde-fous intégrés
- `prefers-reduced-motion` ET le réglage « Animations douces » de l'app coupent tout.
- Lenis, halo, magnétisme, tilt : uniquement appareils à souris.
- Three.js : jamais chargé si Save-Data, connexion 2G/3G, < 4 Go de RAM ou < 4 cœurs ;
  retombe sur les pastilles CSS si WebGL est absent, si le rendu est trop lent
  ou si le contexte est perdu.
