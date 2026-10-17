# OF-PERF — étapes 0/1 et extension 48, objectif non atteint

## Décision de livraison

**Ne pas déployer comme correctif entièrement validé : le critère 46 reste non satisfait.**
Le correctif supprime les parses répétés à chaud ; la sérialisation/écriture synchrone de fin de tour reste bloquante. L’extension minimale 48 du processeur d’images a ensuite été explicitement autorisée ; aucun changement du banc ni élargissement au stockage d’archives pour maquiller le résultat.

- Worktree : `/Users/sechaosouchiam/Source/github.com/OpenFoxFork-perf-snapshot` ; branche `perf/snapshot-hot-path`.
- Base : `7e05ad22100962ac05c59acc5834f4b374b62ea4`. Révision du lot : commit contenant ce rapport sur `perf/snapshot-hot-path`, après les gates ; aucun push, PR, déploiement ou redémarrage. Les étapes 0/1 sont conservées ensemble pour ne pas reconstruire artificiellement un état intermédiaire ; le diff d’instrumentation initial reste dans `step0-instrumentation.patch`.
- Base contenant `298eb60a` ; fichiers concernés identiques à `openfox-base@42c357ed` au départ. `openfox-base` est resté propre.
- Diff préexistant CriteriaEditor du checkout principal inchangé : SHA-256 `96e53772257b8f1ec7a342fa7efa417d3d97b585467f25dcb4cb3a98fd125cfa`.
- Critères 17–47 validés par Claude Infra OpenFox Diag avant le premier test écrit. Les critères 1–16 du wrapper sont un autre chantier.

Les sections historiques ci-dessous, jusqu’à « Vérification finale du complément », décrivent `b74b840e`, avant le GO pour le critère 48. **L’état actuel et les dernières mesures sont dans « Extension autorisée 48 » en fin de rapport.**

## Modifications et choix

- `events/store.ts` : lecteur `getReplayEvents`, projections mémoire de fenêtre/compteur, publication immuable du snapshot, conservation au cleanup, maintien en cache des sessions actives, détection `PRAGMA data_version`.
- `events/immutable-snapshot.ts` : copie des objets/tableaux JSON, gel des copies et partage des chaînes immuables ; un WeakSet réutilise les sous-objets déjà possédés. Aucun `structuredClone` des payloads. Les propriétés `undefined` sont omises comme en JSON. Le coût du parcours des objets reste mesuré, pas supposé nul.
- `events/store-diagnostics.ts` : instrumentation optionnelle des lectures complètes, parses de lignes snapshot, hits/miss, octets UTF-8 parsés, timings et deltas mémoire de l'installation du cache. Pas de prompt ni de payload journalisé.
- Raccordements : `chat/conversation-history.ts`, `chat/orchestrator.ts`, `events/session.ts`, `utils/session-utils.ts`. Les doubles de tests correspondants ont été actualisés sans modifier leurs assertions métier.
- Nouveaux tests : `events/store-diagnostics.test.ts`, `events/store-hot-path.test.ts`, `chat/snapshot-hot-path.test.ts` ; bancs : `scripts/bench/snapshot-{hot-path,copy-equivalence}.ts`.

Le lecteur renvoie le snapshot en cache et les événements `seq > snapshot.seq`. Pour préserver exactement les folds existants, les événements encore conservés **avant** ce snapshot sont lus une fois puis mémorisés : leur suppression globale ferait perdre certains états. Ce préfixe peut inclure d'anciens snapshots non nettoyés (notamment après abort). Le lecteur brut `getEvents` reste disponible, non remplacé pour export/audit/auto-continue.

Les projections sont reconstruites à froid puis mises à jour à l'append, sans migration de schéma. Le compteur conserve volontairement sa sémantique legacy : nombre de `message.start` utilisateur non générés encore présents, **pas** total historique des utilisateurs absorbés dans les snapshots. Modifier cette anomalie aurait changé le contrat de nommage des sessions.

Le snapshot publié est isolé de l'appelant et figé. Une écriture rejetée n'installe rien. `cleanupOldEvents` conserve le dernier snapshot inchangé, tout en invalidant le préfixe/projections dont les événements peuvent avoir disparu. Update, suppressions, troncature et tombstones invalident les données concernées. Les recherches du dernier snapshot ignorent désormais les snapshots tombstonés, contrairement à l'ancien accesseur qui pouvait les ressusciter. Le lecteur brut les ignorait déjà.

Hypothèse opérationnelle : **un écrivain par base**, une base par instance. `PRAGMA data_version` est contrôlé avant de servir un cache ; une écriture d'une seconde connexion purge caches et projections. Cela n'instaure pas un protocole complet de concurrence multi-écrivains. La lecture snapshot/préfixe/suite utilise une transaction de lecture cohérente.

Les sessions actives restent en cache au-delà du plafond ; elles redeviennent évictables sur `running.changed=false`. Les sessions inactives conservent le plafond/politique FIFO antérieurs, y compris l'exception préexistante d'une entrée isolée supérieure au plafond. Aucun LRU ajouté. Le poids historique reste `payload.length` (unités JS), pas une garantie de heap/RSS. Les préfixes ont un poids supplémentaire non inclus dans ce budget : voir le complément de revue ci-dessous. Il n'existe donc pas de borne mémoire globale indépendante du nombre et de la taille des sessions actives ; pour ce profil, il faut prévoir le jeu actif de ~190 Mo sérialisés **plus** le cache inactif, les objets JS, SQLite et les allocations transitoires.

## Vérifications

- TDD : 3 tests rouges instrumentation, 7 rouges cache/lecteur, 1 rouge raccordement, puis 2 rouges forme JSON/coût mémoire et 1 rouge import technique/épinglage ; logs `step0-red.log`, `step1-red.log`, `wiring-red.log`, `cache-overhead-red.log`, `pinning-import-red.log`.
- Suite distante avant les compléments de revue : **6 111 tests unitaires passés, 29 ignorés ; 357 e2e passés, 49 ignorés**. Aucun échec ni rejet non géré. `npm run check` vert : typecheck serveur/web/e2e/bancs, lint, format et détection de duplication. Preuve : `review-gates.log`, sortie 0 (le passage précédent est conservé dans `final-gates.log`).
- Cas synthétiques : compaction principale/sous-agent, troncature, tombstones, abandon avec message partiel, absence de snapshot, réouverture, write failure, appendBatch/import, mutation de l'appelant et écriture externe. Le raccordement conversation/fenêtre/compteur utilise les vraies fonctions ; le test de conversation neutralise uniquement l'enrichissement d'images hors périmètre.
- Copie réelle : source SQLite ouverte en lecture seule avec `.backup`, copie sous `report/private/`, intégrité `quick_check=ok`. Sept grandes sessions de ~52 à 107 millions de caractères de snapshot, jusqu'à 1 544 événements survivants : égalité des replays, messages LLM, folds d'état, snapshots produits, ID et compteur. Les UUID éphémères d'images de résultats d'outils sont semés identiquement pour comparer les folds non déterministes ; aucun contenu n'est ignoré. Preuve : `real-copy-equivalence-final.json`.
- Les données réelles n'ont pas quitté le Mac. Copie en 0600, dossier en 0700 et ignoré par Git. Les transferts de sources excluent intégralement `report`, les DB et `.env*`. Seuls les rapports publics neutralisés JSON/Markdown ont ensuite été copiés par sélection explicite ; `report/private` a toujours été exclu. Ne pas lancer un autre script de synchronisation qui inclurait ce dossier privé.

## Mesures avant/après

Machine distante `.122`, conteneur `node:24-bookworm`, Node 24.21.0, Linux x64, Core Ultra 9 285 ; limites identiques **2 CPU / 4 Go**. Aucun build binaire de production. Sept sessions synthétiques : 50/46/32/26/24/6,5/6 Mo décimaux, taille JSON réelle totale **190 558 034 octets**. Même jeu, un round d'amorçage/session, 3 tours × 4 rounds × 7 sessions = 84 rounds et 21 snapshots. Sonde HTTP dans un autre processus à 10 ms ; `monitorEventLoopDelay` à 10 ms. Aucun fournisseur réel.

La baseline instrumentée a été exécutée avant le correctif (`baseline.json`, p99 health 6 777,64 ms). Trois paires finales `paired-{0,1}-{1,2,3}.json` utilisent exactement le même banc et le switch ancien/nouveau ; la petite correction de fixture `metadataEntries:{}` explique les 147 octets supplémentaires par rapport à la toute première baseline.

| Mesure                    |  Ancien chemin |     Nouveau chemin |
| ------------------------- | -------------: | -----------------: |
| Health p50 (3 exécutions) | 2 723–2 776 ms |         606–613 ms |
| Health p95                | 6 444–6 528 ms |     1 234–1 236 ms |
| Health p99                | 6 723–6 809 ms | **1 273–1 295 ms** |
| Erreurs HTTP              |              0 |                  0 |
| Parse snapshot par round  |              2 |              **0** |
| Parses / volume total     | 189 / 5,146 Go |          **0 / 0** |
| Round p99                 | 129,5–131,7 ms |       0,44–0,54 ms |
| Build snapshot p99        |       62–79 ms |       1,41–1,47 ms |
| Append + cleanup p99      |     131–136 ms |     **130–135 ms** |
| Retard event-loop p99/max |     674–694 ms |     **464–469 ms** |
| RSS final observé         |   1,11–1,67 Go |         599–611 Mo |

L'installation du cache prend 9,3–9,8 ms **au total pour 21 écritures**, au plus 1,22 ms par écriture. Delta heap observé par installation : maximum ~2,66 Mo ; RSS maximum ~0,39 Mo. Ces deltas incluent les effets de GC et ne constituent pas une mesure exacte des allocations retenues. `data_version` : 245 vérifications, total 0,84 ms, soit ~3,4 µs par vérification sur ce banc mémoire (pas une garantie sur tout disque/charge).

Les JSON détaillent p50/p95/p99/max de l'event-loop, timings de chaque round, compteurs de chaque fin de tour, stringify et mémoire. Les nouvelles lectures ne déplacent pas le coût JSON vers le cache ; **l'ancien coût de stringify + écriture demeure**. Plusieurs fins de tours synchrones consécutives font attendre la sonde HTTP. Le p99 demandé **<100 ms n'est pas atteint** ; la durée du banc est courte et ne prétend pas remplacer une mesure de production. Le profil contient dix messages dans la fenêtre active, les autres archivés ; il ne mesure pas l'enrichissement image ni un tour LLM complet. Aucune cadence ni taille n'a été ajustée pour passer le seuil.

## Retour arrière et risques

- `OPENFOX_SNAPSHOT_HOT_PATH=0` est lu à la création de l'EventStore et rétablit les lectures complètes, sans projections ni épinglage nouveau. Absent ou `1` : nouveau chemin. Les deux positions sont testées fonctionnellement et mesurées.
- Sur **450**, l'utilisateur devra modifier l'environnement du plist du LaunchDaemon puis redémarrer lui-même le service pour activer ce retour arrière. Cela ne demande pas de redéployer le code. **L'agent n'effectue aucune de ces actions.**
- `OPENFOX_SNAPSHOT_DIAGNOSTICS=1` active les compteurs à la création du store ; absent : pas d'état diagnostic. L'option de constructeur sert aux tests.
- Aucun changement image-processor, filtrage avant expansion, LRU ni stockage d'archives. La sérialisation hors thread principal reste une piste nécessitant un autre périmètre et une validation ; elle n'est pas implémentée.
- Les empreintes des sources et preuves sont dans `validation.json` ; les logs restent dans ce worktree. Le critère 46 et la revue de livraison restent ouverts.

## Complément de revue — variantes vision et fins de tour

Le banc passe maintenant par le vrai `processContextImages`, sans modification de ce module. `OF_PERF_WITHOUT_VISION=1` mesure son clone profond même en l’absence d’images/PDF ; la fixture reste identique. `OF_PERF_STAGGERED=1` ajoute seulement le délai déterministe `((session+1)*7919+(tour+1)*3571)%2001` avant chaque fin de tour (0–2000 ms), identique dans les deux modes. Toutes les autres tailles, cadences et limites sont conservées ; chaque variante est une exécution exploratoire, pas une distribution inter-exécutions.

Preuves : `review-bench-v<V>-s<S>-m<M>.json` ; V=1 sans vision, S=1 étalé, M=1 nouveau lecteur. Temps en ms :

| Vision | Fins     | Lecteur | Health p50 | Health p95 | Health p99 | Round p99 | Event-loop p99 | Event-loop max |
| ------ | -------- | ------- | ---------: | ---------: | ---------: | --------: | -------------: | -------------: |
| oui    | groupées | ancien  |    3084.52 |    6935.80 |    7242.28 |    144.16 |         675.81 |         675.81 |
| oui    | groupées | nouveau |     597.06 |    1217.87 |    1268.14 |      0.51 |         462.68 |         462.68 |
| oui    | étalées  | ancien  |     128.57 |    1324.31 |    1690.91 |    150.88 |         573.57 |         659.03 |
| oui    | étalées  | nouveau |       0.29 |     106.06 |     158.57 |      0.34 |         129.63 |         135.92 |
| non    | groupées | ancien  |    4065.31 |    8607.87 |    8959.72 |    182.96 |         675.28 |         675.28 |
| non    | groupées | nouveau |     931.22 |    2392.89 |    2513.34 |     39.77 |         461.11 |         461.11 |
| non    | étalées  | ancien  |     187.89 |    1831.91 |    2253.72 |    192.11 |         608.70 |        1016.59 |
| non    | étalées  | nouveau |       9.11 |     204.76 |     383.42 |     36.74 |         173.28 |         228.07 |

Zéro erreur HTTP dans les huit variantes. Les nouveaux chemins ont toujours **zéro parse**, contre 189 parses/5,146 Go pour les anciens. Sans vision, le clone persistant fait passer le round p99 de 0,34–0,51 ms à 36,74–39,77 ms et le RSS final atteint 885–1214 Mo au lieu de 688–728 Mo avec vision. Le gain de lecture existe mais ne supprime pas le clone.

Même étalé, le p99 health reste **158,57 ms avec vision / 383,42 ms sans vision**. Un append isolé reste à environ 129–138 ms au p99 : ce lot ne peut pas garantir un serveur réactif sous 100 ms pendant une écriture. Atteindre durablement la cible exige de traiter les snapshots cumulés ou de déporter sérialisation/écriture, hors de ce périmètre. Un p99 dépend aussi de la fréquence des blocages et des requêtes : ce n’est pas une preuve d’impossibilité pour toute autre cadence. Aucun résultat défavorable n’a été remplacé par la variante étalée.

## Complément de revue — objets gelés

Méthode : recherche de tous les appels à `getLatestSnapshot`, `getReplayEvents` et `getEventsSinceSnapshot`, puis lecture des folds et consommateurs directs/indirects ; recherche ciblée des affectations, `delete`, `push`, `splice`, `sort` sur `data`, `messages`, `toolCalls`, `attachments`, `metadata`, critères et todos. Les modifications des nouveaux objets locaux ont été distinguées des mutations d’alias vers le cache.

| Appelants/consommateurs vérifiés                                                                   | Constat                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events/store.ts` : lecteur replay, projections, prompts, `getEventsSinceSnapshot`, `getAllEvents` | Arrays et objets de restitution nouveaux ; lecture des champs du snapshot. `getAllEvents` conserve des alias attachments/metadata, consommés en lecture dans `orchestrator` pour la recherche du dernier agent.                                               |
| `events/session.ts` : état/session, contexte, fenêtre active, combinaison, troncature              | Combinaison/reconstruction dans de nouveaux arrays. Troncature par spread + slice, pas de modification du snapshot.                                                                                                                                           |
| `events/fold-state.ts` : état, critères/todos/metadata, snapshots                                  | Mises à jour par map/spread ou nouveaux objets ; réutilisation en lecture de certains objets imbriqués. `trimSnapshotStreamingOutput` reconstruit les objets modifiés.                                                                                        |
| `events/fold-messages.ts` : messages UI/LLM, événements synthétiques                               | Messages et arrays de travail reconstruits ; les push/splice/delete portent sur ces objets. Les arguments d’outils, attachments, metadata et segments peuvent rester partagés en lecture.                                                                     |
| `events/apply-events.ts`                                                                           | **Trois erreurs reproduites et corrigées** : streamingOutput, preparingToolCalls et formatRetries de messages initiaux restaient partagés. Leur push sur snapshot gelé levait TypeError. Copie des seuls arrays avant replay ; aucun clone des gros payloads. |
| `chat/conversation-history.ts`, `chat/orchestrator.ts`                                             | Lecture/fold et construction de nouveaux messages/snapshots. Le processeur d’images actuel clone avant ses mutations en non-vision ; avec vision il ne modifie rien.                                                                                          |
| `session/manager.ts`, `session/export-import.ts`                                                   | Fork par slice/map/spread ; critères modifiés par map/filter/spread ; objets de messages/contexte reconstruits ; export en lecture.                                                                                                                           |
| `session/name-generator.ts:198`, `ws/server.ts:588`                                                | Combinaison/folds puis diffusion/serialization ; mutations de l’état des clients WS distinctes du snapshot.                                                                                                                                                   |
| `routes/session-stats.ts:36`                                                                       | Folds/statistiques ; `stats.events = rollup` porte sur le nouvel agrégat, pas les stats stockées.                                                                                                                                                             |
| `index.ts:982,1031,1141,1168,1354,1507,3837`                                                       | GET session/status, changement provider/mode, confirmations et historique MCP : combinaison/folds puis réponse JSON/diffusion.                                                                                                                                |

Preuve TDD : `review-audit-red.log` (3 TypeError et une exclusion rsync absente), puis `review-audit-green.log` (29 tests verts avec cache/projections/raccordement). Le test couvre les trois événements à partir de messages initiaux gelés, l’égalité avec le replay legacy et la non-mutation de la source. Le premier gate complet a relevé `messageId` manquant dans la fixture tool.output ; corrigé sans changer les assertions.

Limites signalées : les types de retour ne sont pas `DeepReadonly`, et les alias imbriqués transmis à des extensions/plugins non audités pourraient encore être modifiés par ceux-ci. L’audit du code intégré ne prouve pas la sûreté d’un plugin arbitraire. Les événements appendés/notifiés restent distincts de la copie immuable publiée ; l’émetteur n’est pas gelé.

`SessionSnapshot` déclare des dates numériques et les builders reçoivent normalement les données d’événements déjà normalisées par JSON ; aucun Date/toJSON explicite trouvé dans leurs champs construits. **Pas de garantie pour un appelant externe fournissant des objets non JSON dans un champ libre** : `immutableSnapshot(new Date())` donne `{}` et ne reproduit pas toJSON ; cette limite reste documentée, pas corrigée silencieusement.

## Complément de revue — mémoire et hygiène

`getDiagnostics().replayPrefixes` expose `entries`, `events` et `serializedBytes` (somme UTF-8 des payloads des lignes retenues), sans resérialisation à chaque lecture ni modification de la politique d’éviction. C’est une jauge actuelle, conservée après reset des compteurs. Test rouge/vert : `review-prefix-{red,green}.log` ; préfixe avec ancien snapshot, reset, cleanup et suppression. Les variantes ci-dessus nettoient chaque tour et finissent à zéro octet de préfixe ; elles ne bornent pas le cas d’aborts successifs.

Provisionnement : snapshots actifs (~190,56 Mo sérialisés ici) **+ somme des préfixes retenus** (anciens snapshots compris) + cache inactif + overhead des objets JS/SQLite/projections + allocations transitoires (dont clone non-vision). Les préfixes sortent à l’éviction de leur snapshot ou lors des invalidations/cleanup, mais ne sont pas inclus dans le plafond de capacité. Aucun plafond global de heap/RSS n’est promis. Une session sans running.changed=false peut rester épinglée ; redémarrer vide la mémoire mais une nouvelle lecture d’un état persistant encore running peut l’épingler à nouveau.

Chemin distant unique de ce chantier : `/tmp/openfox-perf-dev0.kW992T`, créé par mktemp, monté sur `/work` dans les conteneurs Docker `--rm`. Les bancs ont les limites 2 CPU/4 Go ; les gates complètes utilisent le lanceur standard du dépôt. Aucun usage de `~/Source` ni du répertoire par défaut `/tmp/openfox-precommit`. Le contrôle en lecture seule de `~/Source` n’a trouvé aucune entrée ; `report/private` est absent du remote.

Le hook utilisera explicitement `OPENFOX_TEST_REMOTE_DIR=/tmp/openfox-perf-dev0.kW992T` et `openfox.testRemote=ssechao@192.168.71.122`. Le script `test-remote.sh` exclut désormais intégralement `/report/private/` et `.env*`, avec test de ses arguments avant transfert. Aucun bypass du hook ni gate exécutée localement. Le nettoyage final du seul répertoire dédié sera confirmé après le commit et l’arrêt de ses conteneurs ; jamais de nettoyage global de Docker ou de `~/Source`.

La copie réelle `report/private/sessions-copy.db` reste conservée localement (0600, dossier 0700) jusqu’à décision utilisateur. Aucun changement à image-processor sans autorisation explicite supplémentaire reçue.

## Vérification finale du complément

Après correction des trois tableaux partagés : **6 116 tests unitaires passés, 29 ignorés ; 357 e2e passés, 49 ignorés**. Typecheck serveur/web/e2e/bancs, lint, format et duplication verts, sortie 0 (`review-final-gates-v2.log`). La copie réelle a été relue sur le Mac : **7/7 équivalences exactes et zéro parse à chaud**, sans transfert (`real-copy-equivalence-review.json`).

Les huit variantes ont été réexécutées sur ces sources finales, mêmes paramètres. Cette deuxième série ne remplace pas la précédente : `review-final-bench-v<V>-s<S>-m<M>.json`.

| Vision | Fins     | Lecteur | Health p50 | Health p95 | Health p99 | Round p99 | Event-loop p99 | Event-loop max |
| ------ | -------- | ------- | ---------: | ---------: | ---------: | --------: | -------------: | -------------: |
| oui    | groupées | ancien  |    3071.35 |    6916.91 |    7216.75 |    139.11 |         682.10 |         682.10 |
| oui    | groupées | nouveau |     606.66 |    1232.85 |    1283.09 |      0.60 |         470.29 |         470.29 |
| oui    | étalées  | ancien  |     132.00 |    1328.77 |    1693.62 |    173.60 |         581.96 |         702.55 |
| oui    | étalées  | nouveau |       0.30 |     102.16 |     145.43 |      0.41 |         132.58 |         142.08 |
| non    | groupées | ancien  |    3787.66 |    8092.91 |    8431.33 |    172.58 |         667.42 |         667.42 |
| non    | groupées | nouveau |     944.47 |    2413.89 |    2535.04 |     42.77 |         455.34 |         455.34 |
| non    | étalées  | ancien  |     192.73 |    1872.21 |    2300.04 |    201.34 |         623.90 |         983.04 |
| non    | étalées  | nouveau |       9.40 |     179.31 |     350.66 |     30.72 |         173.41 |         232.78 |

La conclusion reste inchangée : zéro parse à chaud, mais p99 health **145,43 ms / 350,66 ms** avec fins étalées, donc critère 46 non satisfait. Zéro erreur HTTP ; aucun changement image-processor.

Avant le premier commit : aucun appel réel au hook/test-remote.sh pendant la présence de la copie privée, uniquement les transferts manuels excluant report intégralement et le test avec SSH/rsync factices. Sur .122, `/tmp/openfox-precommit/report` et `/tmp/openfox-perf-dev0.kW992T/report/private` sont **absents** ; preuve `remote-private-check.log`. La protection du transfert est dans le commit séparé `dbe1fe7bfb8c0ebc7a4bd2796c1796b486e5ea40`, conformément à la revue. L’attestation de nettoyage post-commit du répertoire dédié sera conservée dans `remote-cleanup.log`.

Le relais `.husky/_` manquait dans ce worktree neuf : le premier commit de protection n’a pas exécuté le hook. Anomalie détectée sur sa durée/log ; installation du relais Husky standard, configuration distante inchangée, puis remplacement de ce seul commit local par amendement avec le hook complet distant vert. Preuve : `commit-private-exclusion-verified.log` (6116 unitaires, 357 e2e et gates statiques). Aucun contournement demandé ni conservé.

Les sources, ce rapport, `validation.json` et le résultat neutralisé de la copie réelle sont versionnés. Les JSON bruts volumineux des bancs, le patch initial et les logs restent conservés dans ce worktree, hors commit ; leurs empreintes sont dans `validation.json`.

## Extension autorisée 48 — processeur d’images sans clone global

GO utilisateur transmis par Claude Infra OpenFox Diag puis précisé dans ses messages #17/#18, critère 48 mis à jour et relu avant implémentation. La contrainte initiale « seulement message.start » ne préservait pas les enrichissements de résultats d’outils et de snapshots ; l’exception minimale a été explicitement approuvée.

Seuls les objets du chemin à enrichir sont recopiés superficiellement : event/data/attachments/élément pour message.start ; event/data/result/metadata pour tool.result ; event/data/messages/message puis attachments ou toolCalls/result/metadata pour un snapshot. Les autres objets, tableaux et chaînes sont partagés. Aucun structuredClone, aucun parcours récursif des payloads. Si toutes les descriptions/pdfContent sont déjà non vides, tous les objets **et le tableau des événements** sont rendus identiques par référence. Les champs vides gardent leur sémantique legacy : ils nécessitent un enrichissement. Les boucles d’enrichissement, callbacks et persistance existantes sont inchangées.

TDD : **8 tests rouges** sur les identités/copies globales (`image48-red.log`), puis **8 verts +27 tests existants verts** (`image48-green.log`). Les valeurs événements/descriptions/persistEvent attendues passent déjà avant la modification ; les assertions de partage échouent, puis passent après. Couverture : aucune pièce jointe, image, PDF, mélange ; snapshot entièrement décrit ; une seule nouvelle image avec autres messages et attachments conservés par référence ; metadata d’image de résultat outil, brute et dans un snapshot. Toutes les entrées sont gelées ; leur sérialisation reste inchangée après traitement. persistEvent reçoit exactement l’objet data de l’événement retourné, et les mêmes valeurs qu’avant. Une seconde passe sur le snapshot enrichi ne copie rien et ne persiste rien.

Banc repris **sans aucune modification** sur un nouveau répertoire dédié `/tmp/openfox-perf-image48.awODDY` (montage `/work`, node:24-bookworm, 2 CPU/4 Go, sans vision, lecteur optimisé actif). Deux variantes avant modification puis les deux après. La série antérieure à `b74b840e` reste conservée (2535 ms groupé, 351 ms étalé) ; la nouvelle exécution avant correction donne 2535/405 ms. Variabilité exposée, pas de sélection de la meilleure baseline.

| Fins     | Version image-processor | Health p50 | Health p95 | Health p99 | Round p99 | Event-loop p99 | RSS final Mo |
| -------- | ----------------------- | ---------: | ---------: | ---------: | --------: | -------------: | -----------: |
| groupées | avant                   |     849.85 |    2413.77 |    2534.98 |     40.56 |         459.01 |      1219.49 |
| groupées | après                   |     584.91 |    1226.52 |    1276.73 |      0.52 |         465.57 |       661.31 |
| étalées  | avant                   |      10.29 |     223.80 |     404.73 |     39.51 |         179.18 |       920.64 |
| étalées  | après                   |       0.30 |     104.02 |     143.21 |      0.27 |         131.53 |       693.64 |

Zéro erreur HTTP et zéro parse de snapshot dans les quatre exécutions. En régime établi sans vision, le coût du clone disparaît : round p99 0,27–0,52 ms. Le p99 health **143 ms étalé /1277 ms groupé** reste supérieur à 100 ms, à cause de la sérialisation/écriture synchrone inchangée ; critère 46 toujours ouvert. La fixture ne contient pas d’images/PDF à décrire : elle mesure le coût évité sur le régime établi, pas la latence d’un fournisseur vision ni le coût d’écriture du premier enrichissement.

La copie de DB réelle reste sur le Mac ; l’équivalence 7/7 précédemment vérifiée concerne le stockage/fold inchangé par cette extension, pas une validation de fournisseur vision réel. Les données du banc restent synthétiques. Le hook du troisième commit utilisera le nouveau répertoire dédié ; contrôle et nettoyage final dans `image48-cleanup.log`. Aucun push, déploiement ni redémarrage.

Gates finales du critère 48 : **6 124 unitaires passés, 29 ignorés ; 357 e2e passés, 49 ignorés** ; typecheck serveur/web/e2e/bancs, lint, format et duplication verts, sortie 0 (`image48-gates.log`). La revue indépendante reste attendue ; completed ne signifie pas verified.
