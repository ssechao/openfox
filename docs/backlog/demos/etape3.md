# Démo — Étape 3 : plus d’appels bloquants dans les routes

Branche `mt/etape3-async` (depuis `origin/mt/etape2-verrou` 948f9d72). Référence du 2026-10-21, chiffres C3 du 2026-10-22.

## Référence avant correctif

Incident production (instance 450, 2026-10-21) : l’outil `workspace` a duré 227 s et a gelé l’instance pendant environ 110 s (`execSync` du setup).

Mesure contrôlée sur `origin/mt/etape2-verrou`, même capteur `setTimeout(20)` que l’étape 1 :

| Opération                          | Durée    | Retard du minuteur 20 ms |
| ---------------------------------- | -------- | ------------------------ |
| `execSync('sleep 2')`              | 2 295 ms | 2 295 ms                 |
| `fs.promises.rm` de 5 000 fichiers | 2 970 ms | 21 ms                    |

## Commandes

```bash
npx vitest run src/server/git/workspace.test.ts
npx vitest run src/server/utils/permissions.test.ts src/server/utils/project-creator.test.ts src/server/dev-server/inspect-proxy.test.ts
npx vitest run src/server/ws/server.test.ts src/server/git/diff.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/git-status-watcher.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/workspace-nonblocking.demo.test.ts
# Attribution des retards : un dossier par exécution, puis analyse
ETAPE3_CPU_PROF_DIR=/tmp/etape3/run1 npx vitest run --config e2e/vitest.config.ts e2e/workspace-nonblocking.demo.test.ts
npx tsx e2e/utils/loop-stall-profile.ts /tmp/etape3/run1
```

Linux : Docker `node:24-bookworm` sur `ssechao@192.168.71.122`.

## Résultats

| Critère                                                 | macOS (worktree)                    | Linux (.122 Docker)                    |
| ------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| C1 `workspace.test.ts`                                  | 41/41                               | 41/41                                  |
| C2 permissions / project-creator / inspect-proxy        | 36/36                               | 36/36                                  |
| Scrutation git `ws/server.test.ts` + `git/diff.test.ts` | 43 réussis, 1 ignoré                | `ws/` + `git/` : 139 réussis, 1 ignoré |
| `e2e/git-status-watcher.test.ts`                        | —                                   | 2/2                                    |
| C3 `workspace-nonblocking.demo.test.ts`                 | 2/2 ×5, écart témoin médian 36,3 ms | 2/2 ×3, écart témoin médian 2,0 ms     |

## Correctif de la scrutation git

La démo avec témoin (commit eecc6d3d, détails dans « Diagnostic avant correctif ») a montré que la scrutation git de `src/server/ws/server.ts` bloquait la boucle sur macOS. En production, l’instance scrute toutes les 10 s des répertoires que personne ne regarde, y compris des workspaces supprimés. Correctif :

1. **Seulement les répertoires suivis par un client WebSocket** (`activeWorkdir` d’au moins un client). `session_updated` ne démarre plus la scrutation : il met à jour le répertoire des clients de la session, arrête la scrutation des répertoires que plus aucun client ne suit (`moduleStopUnwatchedGitPolling`), et ne rafraîchit git que si un client suit le nouveau répertoire. Le même arrêt a lieu quand un client charge une autre session et quand le dernier client se déconnecte. Un workspace supprimé ou quitté cesse donc d’être scruté dès que la session revient au répertoire du projet.
2. **Un seul `spawn` git à la fois.** `nativeGetGitDiffFiles` (`src/server/git/diff.ts`) enchaîne `git diff` puis `git status` par `await`, au lieu de les lancer dans le même tick. Les rafraîchissements (scrutation de chaque répertoire et `git.status` qui suit un `session_updated`) passent par une file unique, dédupliquée par répertoire (`moduleQueueGitRefresh`) et traitée un répertoire après l’autre. Une rafale de `session_updated` donne au plus un rafraîchissement en cours et un en attente par répertoire. Seul le statut initial de `session.load` reste hors de la file, pour ne pas retarder l’accusé de réception ; ses appels git restent séquentiels.

Comportement conservé pour un client qui suit une session : statut git initial au chargement, mise à jour à chaque passage de la scrutation si le diff change, `git.status` après chaque `session_updated`. Ce dernier message part désormais vers tous les clients qui suivent le répertoire (chacun avec sa propre session), et plus seulement vers ceux de la session mise à jour. Limite connue : `runGitText` n’a pas de délai maximal, donc un `git` bloqué bloquerait la file de scrutation. Avant le correctif, un `git` bloqué laissait au contraire un processus de plus toutes les 10 s.

Tests (`src/server/ws/server.test.ts`, minuteurs `setInterval` simulés, `getGitBranch`/`getGitDiffFiles` simulés) :

- sans client WebSocket, aucun appel git après `session_updated`, ni ensuite pendant 3 cycles ;
- client connecté qui n’a pas chargé la session : aucun appel git ;
- deux clients sur le même répertoire : la scrutation continue au départ du premier et s’arrête au départ du dernier ;
- workspace supprimé (la session revient au projet) : plus aucun appel sur le workspace, scrutation du projet ;
- client qui charge une autre session : l’ancien répertoire n’est plus scruté ;
- client qui suit la session : `git.status` initial, mise à jour par la scrutation, `git.status` après `session_updated` ;
- deux répertoires suivis : un seul appel git en cours à la fois.

`src/server/git/diff.test.ts` vérifie l’ordre `git diff` lancé, `git diff` terminé, puis `git status` lancé. `e2e/git-status-watcher.test.ts`, qui couvre la scrutation réelle côté interface, passe sans modification (2/2 sur la .122).

## Chiffres C3 après correctif (2026-10-22, processus témoin)

Ces mesures remplacent celles des commits 30d7b9bb (surcoût par rapport à une référence au repos, qui ne séparait pas la contention CPU d’un blocage) et eecc6d3d (avant correctif de la scrutation).

Méthode :

- Le serveur de démo (`OPENFOX_DEMO_LOOP_PROBE=1`, mode développement uniquement, jamais en production) arme un minuteur `setTimeout(20)` dédié et horodate chaque retard ; la route `/api/health/loop-delay` les renvoie.
- Un **processus témoin** (un second `node` indépendant, sans aucune charge) arme le même minuteur en même temps.
- Trois phases disjointes et contiguës : `create` (`switch-workspace` : clone, puis setup qui écrit 5 000 fichiers et `sleep 1`), `delete` (`delete-workspace`), puis une référence au repos de durée `create` + `delete`. La sonde `/sante`, `/api/diagnostics` et `/api/health` (toutes les 200 ms) tourne pendant les trois phases.
- Indicateur de blocage par phase : max sur des fenêtres alignées de 1 s de (retard max OpenFox − retard max témoin). La contention CPU retarde les deux processus ; un blocage de la boucle ne retarde qu’OpenFox.
- Seuil : écart témoin ≤ 100 ms dans chaque phase, **affirmé sur macOS et Linux**. Le surcoût par rapport à la référence (≤ 100 ms) reste affirmé sur Linux.
- Charge : moyenne sur 1 min (`uptime` ; dans le conteneur, `/proc/loadavg`, qui reflète l’hôte) avant chaque exécution.

### Linux (.122, Docker `node:24-bookworm`, 24 cœurs, 3 exécutions)

| Exécution | Charge 1 min | Écart `create` | Écart `delete` | Écart référence | Max témoin | Durée create | Durée delete | Résultat |
| --------- | ------------ | -------------- | -------------- | --------------- | ---------- | ------------ | ------------ | -------- |
| 1         | 0,42         | 2,0 ms         | 0,4 ms         | 0,7 ms          | 0,2 ms     | 1 152 ms     | 48 ms        | 2/2      |
| 2         | 0,39         | 3,1 ms         | −0,1 ms        | 0,6 ms          | 1,1 ms     | 1 176 ms     | 45 ms        | 2/2      |
| 3         | 0,36         | 1,6 ms         | 0,4 ms         | 0,6 ms          | 0,2 ms     | 1 178 ms     | 45 ms        | 2/2      |

Écart témoin maximal par exécution : 2,0 / 3,1 / 1,6 ms, **médiane 2,0 ms** ; charge médiane 0,39. Surcoût par rapport à la référence : 1,2 / 2,4 / 1,0 ms. Aucune sonde en timeout ni en erreur.

### macOS (Mac mini 14 cœurs, macOS 26.2, Node 25.6.1, 5 exécutions)

| Exécution | Charge 1 min | Écart `create` | Écart `delete` | Écart référence | Max témoin | Durée create | Durée delete | Résultat |
| --------- | ------------ | -------------- | -------------- | --------------- | ---------- | ------------ | ------------ | -------- |
| 1         | 14,66        | 23,8 ms        | 28,3 ms        | 6,8 ms          | 23,4 ms    | 6 230 ms     | 3 912 ms     | 2/2      |
| 2         | 12,46        | 93,2 ms        | 20,1 ms        | 52,1 ms         | 25,4 ms    | 8 659 ms     | 4 749 ms     | 2/2      |
| 3         | 14,71        | 17,3 ms        | 24,0 ms        | 12,1 ms         | 36,7 ms    | 5 432 ms     | 2 854 ms     | 2/2      |
| 4         | 14,58        | 16,0 ms        | 36,3 ms        | 5,2 ms          | 31,5 ms    | 5 793 ms     | 2 389 ms     | 2/2      |
| 5         | 15,34        | 82,3 ms        | 26,8 ms        | 11,4 ms         | 174,8 ms   | 6 122 ms     | 2 350 ms     | 2/2      |

Écart témoin maximal par exécution : 28,3 / 93,2 / 24,0 / 36,3 / 82,3 ms, **médiane 36,3 ms**. Médianes par phase : `create` 23,8 ms, `delete` 26,8 ms, référence 11,4 ms. Charge médiane 14,66 pour 14 cœurs (de 12,46 à 15,34), plus élevée que pendant les séries d’avant correctif (médianes 11,85 et 7,99). Le seuil ≤ 100 ms tient dans les 5 exécutions, sans sonde en timeout ni en erreur.

Dans l’exécution 5, le témoin lui-même a subi un retard de 174,8 ms pendant la référence, et OpenFox un de 182,1 ms au même moment : l’écart reste de 11,4 ms. C’est l’effet attendu du témoin, qui sépare la contention CPU (les deux processus retardés) d’un blocage de la boucle. La marge reste faible dans la phase `create` : 93,2 ms (exécution 2) et 82,3 ms (exécution 5). Cette série n’a pas été profilée. D’après la série profilée d’avant correctif, les `spawn` de l’opération elle-même (`runGit`, `captureStdout`, `runShell`) atteignent 102 à 110 ms sur ce Mac chargé.

## Diagnostic avant correctif (commit eecc6d3d)

Mêmes méthode et seuil ; scrutation git d’origine.

### Linux avant correctif (.122, 3 exécutions)

| Exécution | Charge 1 min | Écart `create` | Écart `delete` | Écart référence | Max témoin | Durée create | Durée delete | Résultat |
| --------- | ------------ | -------------- | -------------- | --------------- | ---------- | ------------ | ------------ | -------- |
| 1         | 0,33         | 3,6 ms         | 3,6 ms         | 0,1 ms          | 1,1 ms     | 1 176 ms     | 54 ms        | 2/2      |
| 2         | 0,30         | 2,2 ms         | 1,4 ms         | 0,1 ms          | 1,2 ms     | 1 186 ms     | 51 ms        | 2/2      |
| 3         | 0,62         | 1,0 ms         | 3,5 ms         | 2,5 ms          | 1,1 ms     | 1 178 ms     | 52 ms        | 2/2      |

Écart témoin maximal par exécution : 3,6 / 2,2 / 3,5 ms, **médiane 3,5 ms** ; charge médiane 0,33. Aucune sonde en timeout ni en erreur.

### macOS avant correctif (5 exécutions)

| Exécution | Charge 1 min | Écart `create` | Écart `delete` | Écart référence | Max témoin | Durée create | Durée delete | Résultat          |
| --------- | ------------ | -------------- | -------------- | --------------- | ---------- | ------------ | ------------ | ----------------- |
| 1         | 10,36        | 305,7 ms       | 104,2 ms       | 154,6 ms        | 27,8 ms    | 14 979 ms    | 5 792 ms     | échec (`create`)  |
| 2         | 11,85        | 133,1 ms       | 160,4 ms       | 158,8 ms        | 62,5 ms    | 16 083 ms    | 8 467 ms     | échec (`create`)  |
| 3         | 18,05        | 222,8 ms       | 238,8 ms       | 283,0 ms        | 50,1 ms    | 14 127 ms    | 8 798 ms     | échec (`create`)  |
| 4         | 13,46        | 27,8 ms        | 63,8 ms        | 109,1 ms        | 26,7 ms    | 5 700 ms     | 3 794 ms     | échec (référence) |
| 5         | 10,29        | 42,1 ms        | 43,5 ms        | 42,2 ms         | 90,9 ms    | 8 318 ms     | 3 257 ms     | 2/2               |

Écart témoin maximal par exécution : 305,7 / 160,4 / 283,0 / 109,1 / 43,5 ms, **médiane 160,4 ms** (médianes par phase : `create` 133,1 ms, `delete` 104,2 ms, référence 154,6 ms). Charge médiane 11,85 pour 14 cœurs. Le témoin n’a jamais dépassé 100 ms (max 90,9 ms). La phase de référence, sans aucune opération de workspace, dépasse elle aussi 100 ms dans 4 exécutions sur 5. Le seuil n’a pas été relâché : l’assertion macOS échouait, et la cause est identifiée ci-dessous.

Une seconde série de 5 exécutions avec profil CPU (`ETAPE3_CPU_PROF_DIR`, charge médiane 7,99) donne le même résultat : écart maximal 157,8 / 193,1 / 200,8 / 191,3 / 212,2 ms, médiane 193,1 ms, 5 échecs (2 en `create`, 1 en `delete`, 2 en référence). C’est sur cette série que porte l’attribution.

### Origine des dépassements sur macOS avant correctif

Attribution par `e2e/utils/loop-stall-profile.ts` : profil CPU V8 du serveur (`--cpu-prof`), aligné sur les retards horodatés grâce à l’horloge renvoyée par `/api/health/loop-delay`.

**1. Middleware Vite de développement (corrigé dans la démo).** Premières mesures avec témoin : écart de 7 100 ms et 7 356 ms en `create`, de 640 à 1 346 ms en référence. Tous les retards de la phase `create` étaient des transformations Babel (`@vitejs/plugin-react`, `react-refresh`, PostCSS/Tailwind) déclenchées par `warmupRequest`, et celui de la référence était le ramasse-miettes qui les suivait. Cause : en mode développement (`src/server/index.ts`, `createViteServer`), la première réponse HTML de `/sante` lance le pré-chargement (`preTransformRequests`) de tout le graphe de modules de `web/`. Sur un Mac chargé, ce pré-chargement déborde sur les phases mesurées. Ce travail n’existe pas en production (fichiers déjà construits) et n’a pas de lien avec les workspaces : avec `OPENFOX_DEMO_LOOP_PROBE=1`, la démo passe donc `preTransformRequests: false`. `/sante` reste servie par Vite, sans pré-chargement.

**2. `child_process.spawn` lancé par la scrutation git (corrigé, voir « Correctif de la scrutation git »).** Les 17 retards supérieurs à 100 ms de la série profilée :

| Appel bloquant (pile du profil)                                           | Phases                        | Retards        | Nombre |
| ------------------------------------------------------------------------- | ----------------------------- | -------------- | ------ |
| `src/server/git/diff.ts` `nativeGetGitDiffFiles` / `runGitText` → `spawn` | `create`, `delete`, référence | 106 à 223 ms   | 12     |
| `src/server/git/workspace.ts` `runGit` / `captureStdout` → `spawn`        | `create`, `delete`            | 103 ms, 110 ms | 2      |
| `src/server/utils/bounded-exec.ts` `runShell` → `spawn` (setup)           | `create`                      | 102 ms         | 1      |
| ramasse-miettes (`(garbage collector)`)                                   | `create`                      | 167 ms, 169 ms | 2      |

L’appel synchrone est `child_process.spawn` lui-même : libuv crée le processus fils (`posix_spawn` sur macOS) sur le fil de la boucle et attend la fin de l’`exec`. Mesure isolée (`node`, 40 lancements de `git --version`) : sur ce Mac à charge 11, médiane 21,3 ms et maximum 57 ms par appel ; sur la .122, 0,4 ms (4,6 ms avec un tas de 400 Mo). Plusieurs lancements dans le même tick s’additionnent.

Les 12 retards de `diff.ts` venaient de la scrutation git de `src/server/ws/server.ts` (`moduleGitPoll`, toutes les 10 s). Les piles synchrones commencent après un `await` et ne remontent donc pas jusqu’à elle, mais `getGitDiffFiles` (44 des 65 échantillons de `diff.ts`) n’a qu’un appelant actif dans la démo, `moduleGitDiff` : la démo n’ouvre pas de WebSocket et ne lance pas de workflow. Chaque passage de la scrutation lançait 3 processus `git`, dont 2 (`git diff` et `git status`) dans le même tick. Avant correctif, `moduleStartGitPolling` démarrait cette scrutation à chaque mise à jour de session, même sans client WebSocket abonné. Elle n’était arrêtée pour l’ancien répertoire que si un client le suivait : après `switch-workspace` puis `delete-workspace`, la démo scrutait donc le workspace supprimé et le projet.

**Confirmation par l’expérience.** Même démo, scrutation repoussée à 1 h (variable `ETAPE3_GIT_POLL_INTERVAL=3600000` de la démo au commit eecc6d3d, qui posait `OPENFOX_GIT_POLL_INTERVAL` sur l’instance isolée ; retirée depuis, car sans client WebSocket la démo ne scrute plus rien), en alternance avec la configuration normale pour neutraliser la charge :

| Paire | Scrutation | Charge 1 min | Écart `create` | Écart `delete` | Écart référence | Résultat          |
| ----- | ---------- | ------------ | -------------- | -------------- | --------------- | ----------------- |
| 1     | 10 s       | 4,75         | 9,8 ms         | 24,7 ms        | 136,4 ms        | échec (référence) |
| 1     | 1 h        | 6,65         | 12,3 ms        | 64,9 ms        | 24,3 ms         | 2/2               |
| 2     | 10 s       | 8,74         | 75,4 ms        | 80,5 ms        | 118,7 ms        | échec (référence) |
| 2     | 1 h        | 9,05         | 63,1 ms        | 34,2 ms        | 10,0 ms         | 2/2               |
| 3     | 10 s       | 8,08         | 137,9 ms       | 73,7 ms        | 70,7 ms         | échec (`create`)  |
| 3     | 1 h        | 8,66         | 14,7 ms        | 47,7 ms        | 21,9 ms         | 2/2               |

À charge égale, scrutation active : 3 échecs sur 3 (écart maximal médian 136,4 ms) ; scrutation coupée : 3 réussites sur 3 (écart maximal médian 63,1 ms). Trois exécutions de plus, scrutation coupée et profil actif (charge 3,5 à 4,5) : 3 réussites, écart maximal 16,0 / 42,8 / 48,9 ms, aucun retard supérieur à 100 ms. Sans la scrutation, l’opération de workspace elle-même reste donc sous le seuil sur ce Mac (6 exécutions sur 6, maximum 64,9 ms). La marge est faible : dans la série profilée, des `spawn` uniques de l’opération (`runGit`, `captureStdout`, `runShell`) ont atteint 102 à 110 ms, profil compris.

Les deux premières pistes de ce diagnostic sont implémentées (section « Correctif de la scrutation git ») : ne scruter que les répertoires suivis par un client WebSocket, et ne pas lancer `git diff` et `git status` dans le même tick. La troisième reste ouverte : lancer les processus fils hors du fil principal (worker ou processus auxiliaire).

HOME, config et `OPENFOX_DB_PATH` temporaires, ports ≥ 10630, `lsof` sans fichier sous `~/Library/Application Support/openfox*`.

Une suppression annulée ou expirée lève `WorkspaceDeleteIncompleteError` : des fichiers peuvent rester ; un nouvel appel à `deleteWorkspace` termine le nettoyage.
