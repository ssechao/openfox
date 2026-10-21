# Démo étape 1 — Tableau de bord de santé

Branche `mt/etape1-sante` (depuis `main` 6cd750e5). Mesures faites le 2026-10-21 sur le Mac mini, alors chargé par
d'autres sessions (charge moyenne 25 à 35 pour 14 cœurs) : les chiffres sont bruités. La même démo tourne dans la
porte de pré-commit, dans Docker sur la .122.

## Ce qui est livré

- `GET /api/diagnostics` (authentifié comme le reste de `/api`, contrairement à `/api/health`). Un collecteur unique
  range les observations par intervalles fixes d'1 s, garde 60 s d'historique (60 intervalles au plus) et calcule les
  statistiques sur les 10 dernières secondes en additionnant des histogrammes fusionnables. Un intervalle expire selon
  son horodatage, même si aucun tick n'a tourné pendant un blocage. Les lecteurs ne modifient jamais l'état.
- Séries : retard de la boucle p50, p99, max ; latence de `/api/health` (p99, temps de traitement côté serveur) ;
  lecture et écriture de l'EventStore (p99) ; taille du WAL ; sessions en cours ; RSS ; heap. Chaque série porte son
  unité, sa fenêtre et son nombre d'échantillons, et vaut `null` sans données.
- Page `/sante` (icône cœur dans l'en-tête) : lecture toutes les 2 s via `diagnosticsResource`, courbe du retard max
  par seconde sur 60 s, erreur et données périmées signalées, arrêt du polling au démontage.

## Vérifications

| Commande                                                                         | Résultat                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `npx vitest run src/server/diagnostics`                                          | 17 tests verts                                  |
| `npx vitest run web/src/components/health`                                       | 4 tests verts                                   |
| `npm run bench:diagnostics-overhead`                                             | surcoût 0,51 % d'un cœur (0,60 % contre 0,09 %) |
| `npx vitest run --config e2e/vitest.config.ts e2e/health-dashboard.demo.test.ts` | 3 tests verts                                   |

`HEALTH_DEMO_REPORT=<fichier>` conserve les chiffres de la démo ; ceux ci-dessous viennent de
[`etape1-report.json`](etape1-report.json).

## Instance isolée

HOME, XDG, `OPENFOX_DB_PATH` et la configuration pointent vers un dossier temporaire, posés avant le démarrage du
processus enfant. L'enfant refuse de démarrer si l'un d'eux sort de `tmpdir()`. Port 10600. `lsof` sur le serveur, le
processus de test et le banc : la base ouverte est `/private/tmp/openfox-health-demo-…/sessions.db`, et aucun fichier
sous `~/Library/Application Support/openfox*` n'est ouvert.

## a) Preuve du capteur : blocage calibré de 500 ms

Route `POST /api/test/block-loop`, présente seulement en mode test avec `OPENFOX_TEST_BLOCK_LOOP=1`.

| Moment                  | Retard p99 | Retard max |
| ----------------------- | ---------- | ---------- |
| Avant                   | 63,7 ms    | 63,7 ms    |
| Juste après le blocage  | 709,2 ms   | 709,2 ms   |
| 11,7 s après le blocage | 87,3 ms    | 120,4 ms   |

Le max détecte le blocage (au moins 80 % des 500 ms injectées) et retombe une fois l'intervalle sorti de la fenêtre de
10 s.

## b) Banc de streaming contre la même instance

`scripts/bench/stream-batching.ts --server-url=<instance>` : 40 appels LLM, 40 000 fragments à 3 000 par seconde. Tour
de 18,3 s, sans timeout. Un sondeur externe interroge `/api/health` toutes les 100 ms, avec un timeout de 2 s.

| Mesure                                    | Valeur                                     |
| ----------------------------------------- | ------------------------------------------ |
| Requêtes `/api/health`                    | 345                                        |
| Timeouts / erreurs                        | 0 / 0                                      |
| Latence externe p50 / p99 / max           | 1,6 / 69,6 / 457 ms                        |
| Retard de la boucle pendant le banc (pic) | p99 87,3 ms, max 588 ms                    |
| Sessions en cours                         | 0, puis 1 pendant le tour, puis 0 au repos |
| WAL                                       | de 8 Kio à environ 4 Mio                   |

## Captures de `/sante`

Instance isolée en mode développement (Vite dans le même processus), port 10610, banc de 60 appels et 60 000
fragments. Le retard monte au démarrage du banc, quand Vite compile aussi les modules de la page dans le processus
serveur (jusqu'à 1,75 s), puis redescend sous 100 ms. Aucun fichier de production ouvert (`lsof`).

Pendant le banc (une session en cours) :

![Page Santé pendant le banc](etape1-sante-pendant.png)

Après le banc (aucune session en cours, retard revenu au repos) :

![Page Santé après le banc](etape1-sante-apres.png)
