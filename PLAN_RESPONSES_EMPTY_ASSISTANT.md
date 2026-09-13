# OpenFox — corriger les faux messages assistant sur Responses

Date : 2026-09-13. Statut : **implémentation et validation terminées ; livraison autorisée en préparation ; récupération historique distincte**.

## Base et isolation vérifiées

- Branche dédiée : `fix/responses-empty-assistant`.
- Worktree : `/Users/sechaosouchiam/Source/github.com/OpenFoxFork-responses-empty-assistant`.
- Base exacte : `cb3f85a68814805125bf22bc04da990fc8947aee`, branche `main`.
- Production observée sur le port 450 : PID 11682, démarré le 13/09 à 02:52:02,
  version HTTP `2.0.145-fork.1`.
- Le CLI résout vers
  `/Users/sechaosouchiam/.local/share/openfox/releases/2.0.145-fork.1-cb3f85a6/dist/cli/index.js`.
  Son `DEPLOYMENT.md` désigne ce commit. Les trois SHA-256 ont été recalculés
  et correspondent au manifeste :
  - paquet : `406ee7c64deabba9fed4771c04bf5d43dbbd7de2b4f23e8a0508b9e49b0887ed` ;
  - CLI : `72bd187d5e63fd677e44b56b6686570fd23d024eac285957e73dad8428297d92` ;
  - dist/package.json : `dc26c427aab65657d1a1b67dee27d0322c28d22544299e15d1a92f60324610a7`.
- Attention : le `dist/` du clone principal est ancien ; il ne représente pas
  l'installation active. Ne pas le prendre comme base du correctif.
- Le patch de contournement wrapper, son worktree et sa branche
  `fix/resume-tool-call-padding` ont été retirés. Aucune modification wrapper
  ne fait partie de ce plan. Aucun commit du patch n'a été créé ni déployé.

## Objectif et cause établie

Garantir qu'un appel d'outil sans texte assistant ne crée aucun message texte
artificiel lors de sa reconstruction en requête Responses, y compris après
persistance, redémarrage et demande de compaction par le harnais.

Incident : session `openfox improve dev`, compactions refusées le 13/09 à
09:14:26 et 09:16:05 UTC avec `native_context_rebuild_required`.
La reconstruction réelle a retrouvé 19 messages supplémentaires `" "` avant
des appels de fonctions ; les 1 387 éléments du checkpoint correspondent
après exclusion de ces ajouts précis. Le deuxième corps normalisé mesurait
4 413 435 octets. Le checkpoint et son artefact natif étaient présents.

Chemin discriminant observé sur les 19 messages concernés :

1. SQLite et snapshot : `content: ""`.
2. Repli via `fold-messages.ts` : toujours `content: ""`.
3. `client-pure.ts`, `buildAssistantMessage` : `msg.content || ' '` crée l'espace.
4. `responses-native.ts`, `messageToInputItem` : le test de vérité sur
   `message.content` transforme cet espace en élément assistant indépendant.

Le défaut prouvé se situe dans l'adaptation HTTP, **pas dans la persistance**.
Le refus du wrapper protège correctement contre un historique différent.

## Périmètre de correction

- Propager jusqu'à la construction du message assistant le protocole effectif,
  déjà disponible comme `apiProtocol` dans les builders de requête.
- Sur Responses, conserver le texte vide original au lieu de produire le shim
  destiné à Chat Completions. Le convertisseur Responses peut alors émettre
  seulement le ou les `function_call`.
- Passer par le builder commun à `complete()` et `stream()` ; vérifier que la
  décision correspond au transport réellement utilisé, et non au nom du modèle.
- Préserver le comportement Chat Completions existant, notamment Qwen/vLLM,
  les champs de reasoning et le chemin natif Ollama.
- Ne jamais supprimer aveuglément tous les espaces dans `responses-native.ts` :
  un texte réellement présent, y compris `" "`, doit rester distinct d'un texte
  vide auquel OpenFox ajoute un espace.
- Ne modifier ni la clé de chaîne, ni ses gardes/digests, ni les données de
  session pour dissimuler une différence. Garder instructions/tools et delta.

Fichiers applicatifs : `src/server/llm/client-pure.ts` et une adaptation de
`client.ts` : le transport natif Ollama doit conserver le contrat Chat même si
un override Responses est défini. Ce cas a été reproduit par un RED HTTP.
Le convertisseur `responses-native.ts` reste inchangé.
Pas de refonte du pipeline, type métier, schéma Zod, API publique, UI,
migration SQLite, configuration utilisateur ou code wrapper/OpenCode.

## TDD — tâches et critères exécutables

Chaque RED doit échouer sur une assertion de contenu HTTP, pas sur une erreur
d'import, un timeout de fixture ou l'absence d'un serveur. Providers synthétiques
uniquement, ports éphémères liés explicitement à `127.0.0.1`.

### T1 — RED de conversion et distinction vide/espace

- [x] Étendre `src/server/llm/client-pure.test.ts` et les tests Responses existants.
- [x] Réponse assistant `content: ""` + un ou plusieurs appels : les builders
      Responses streaming/non-streaming ne fabriquent pas `content: " "`.
- [x] Même entrée sur Chat Completions : contrat existant inchangé.
- [x] Contrôles discriminants : commentaire réel, espace réel, saut de ligne,
      contenu absent si le type interne l'autorise, raisonnement avec/sans texte.
      Aucun `trim()` global ni perte silencieuse de contenu réel.
- [x] Vérifier IDs, noms, arguments complets, ordre des appels/résultats et images.

### T2 — RED du vrai parcours HTTP et persistance

- [x] Étendre `src/server/llm/responses-continuity.test.ts` : vrai client HTTP
      vers mock `/v1/responses`, pour Claude et Codex, via override effectif.
- [x] Rejouer un output fournisseur composé uniquement d'un `function_call`,
      persister le message et son résultat via les vraies primitives OpenFox,
      puis reconstruire le prochain corps. Zéro message assistant artificiel.
- [x] Fermer/réouvrir une SQLite de test, replier snapshot/événements et recréer
      le client. La reconstruction reste sémantiquement identique à celle avant
      fermeture ; ne pas simuler la persistance par un simple JSON round-trip.
- [x] Reproduire 19 cycles outil/résultat avec un historique synthétique long,
      puis une compaction demandée par le harnais. Capturer et comparer les éléments
      HTTP, pas seulement les nombres de tokens ou la longueur du corps.
- [x] Réutiliser les fixtures de `events/folding.test.ts`,
      `events/tool-result-parity.test.ts` ou `replay-compaction.integration.test.ts`.
      N'ajouter un fichier d'intégration que si ces fixtures ne conviennent pas.
- [x] Contrôles : commentaire réellement présent conservé ; changement d'argument,
      résultat ou image toujours détectable, pas normalisé à tort.

### T3 — GREEN minimal et non-régression

- [x] Appliquer la correction à la source seulement après capture des RED.
- [x] Les mêmes tests deviennent verts sans modifier leurs exigences.
- [x] Continuation normale : `previous_response_id` conservé, input = delta seul,
      instructions et outils actifs renvoyés, jamais de `conversation` simultanée.
- [x] Invalidation après compaction/replay/reset, A→B→A, Responses→Chat→Responses,
      deux sessions, réponse tardive/abort et ZDR restent conformes aux tests existants.
- [x] Qwen/vLLM reste sur `/v1/chat/completions` ; protocole auto/override,
      raisonner avec/sans outils, images et chemin Ollama ne régressent pas.
- [x] Neutraliser temporairement le correctif dans le worktree isolé : le test
      racine doit redevenir rouge ; restaurer exactement le correctif ensuite.

### T4 — Qualification des checkpoints déjà existants, sans réparation automatique

- [x] Comparer en lecture seule le préfixe HTTP corrigé de la session concernée
      au checkpoint existant, avec le matcher wrapper inchangé. Ne pas relancer la
      session et ne pas effectuer d'inférence pour cette comparaison.
- [x] Inclure une fixture où un ancien import contient déjà des espaces artificiels
      dans le checkpoint, puis où les tours natifs suivants n'en contiennent pas.
- [x] Distinguer les preuves : correctif des nouveaux envois, reprise d'un historique
      corrigé cohérent, compatibilité d'un ancien checkpoint déjà affecté.
- [x] Si la correction client seule ne permet pas la reprise d'un ancien checkpoint,
      consigner précisément le premier écart et soumettre une stratégie séparée à
      validation. Ne pas annoncer que toutes les anciennes sessions sont réparées.
      Aucun assouplissement du wrapper, suppression de checkpoint, réécriture de DB,
      changement de session masqué ou réinjection coûteuse automatique autorisé.

### T5 — Validation et livraison séparées

- [x] Tests ciblés, `git diff --check`, puis `npm run check` verts.
- [x] Suite unitaire complète à `--maxWorkers=1` et E2E à `--maxWorkers=4`,
      sorties complètes conservées ; ne pas masquer les erreurs par des pipes.
- [x] Aucun échec intermittent rencontré dans les suites de cette livraison :
      comparaison de baseline non nécessaire, aucune qualification « flake » invoquée.
- [x] Mettre à jour ce suivi : RED/GREEN, commandes, résultats, fichiers réellement
      touchés, compatibilité ancienne/nouvelle session et limites non validées.
- [x] Revue du diff final. Commit, push, merge vers `main`, build de livraison et
      installation autorisés explicitement par l'utilisateur le 13/09.
      Le redémarrage reste réservé à l'utilisateur ; ne pas toucher au processus actif.
- [ ] Après autorisation de déploiement seulement : canary choisi par l'utilisateur,
      corrélation session/checkpoint/résident et suffixe réellement transmis. Aucune
      affirmation sur un cache fournisseur ou une économie monétaire non mesurée.

## Suivi d'implémentation

- [x] Contournement wrapper retiré ; autres travaux préservés.
- [x] Binaire actif et commit de provenance vérifiés.
- [x] Branche/worktree créés depuis le commit exact en production.
- [x] Plan TDD écrit ; seuls ce document et la métadonnée de branche sont ajoutés.
- [x] T1 : RED conversion — 2 échecs discriminants (`" "` reçu au lieu de `""`),
      32 tests verts, puis GREEN 34/34. Deux builders, deux protocoles, contenu vide,
      espace réel, saut de ligne, commentaire, reasoning activé/désactivé et deux appels
      parallèles. Le contenu absent n'est pas un cas du type métier (`content: string`).
- [x] T2 : RED HTTP + SQLite — 4 échecs (Claude/Codex × stream/complete),
      exactement 19 éléments assistant artificiels en trop. GREEN ensuite.
      Vrai EventStore, snapshot replié, fermeture/réouverture d'une DB temporaire,
      client recréé, 19 appels réellement reçus et résultats persistés ; suffixes seuls
      sur les continuations, historique complet identique à la source pour la compaction.
- [x] T3 : GREEN initial 56/56 ; matrice de transport ajoutée : 1 RED Ollama
      avec override Responses, corrigé en alignant les paramètres sur `httpFor`.
      Ensemble ciblé élargi : 8 fichiers, 122/122 tests verts.
- [x] T4 : comparaison de l'ancien checkpoint en lecture seule effectuée avec
      le matcher wrapper inchangé. Reprise historique NON garantie, voir ci-dessous.
- [x] T3 mutation : rétablir la seule ligne fautive provoque 6 échecs ciblés
      (conversion et HTTP/SQLite) ; restaurer la correction remet 78/78 tests au vert.
      Les SHA-256 des deux fichiers applicatifs sont identiques avant/après mutation.
- [x] T5 première suite complète : `VITEST_MAX_WORKERS=1 npm run test`,
      exit 0 — 5 590 unitaires passés / 32 skipped, puis 346 E2E passés / 49 skipped.
      `npm run check` vert (types server/web/e2e, lint, format, duplication : 0 clone).
- [x] E2E supplémentaires avec `npm run test:e2e -- --maxWorkers=4` :
      346 passés / 49 skipped, exit 0.
- [x] Trois contrôles HTTP supplémentaires gardent les éditions d'arguments,
      de résultat et d'image détectables (même longueur, aucun assouplissement de
      digest) : `responses-continuity.test.ts` 25/25 verts.
- [x] T5 suite unitaire finale : `npm run test:unit -- --maxWorkers=1`, exit 0,
      5 593 passés / 32 skipped, 414 fichiers passés / 2 skipped (161,70 s).
      Ciblés finaux : 125/125 verts (8 fichiers). Typecheck server, ESLint des
      fichiers modifiés, Prettier et diff-check reverifiés après les trois ajouts.

Diff applicatif final : deux fichiers (+9/−2 lignes), trois fichiers de tests
existants étendus et ce document. Aucun nouveau fichier applicatif ou test.
Pour la livraison, les seules métadonnées de version de `package.json`,
`package-lock.json` et de la référence `..` du lockfile web passent de fork.0 à
fork.1 ; le hook de build existant produira le paquet `2.0.145-fork.2`.
Aucune dépendance n'est modifiée.
SHA-256 après restauration de la mutation :

- `client-pure.ts` : `c9d118504dfe6256608868628d595f563e68de9ba9f6a7356323d5d9e44876e7` ;
- `client.ts` : `6759a7b37d6dd9c549141636f3a5e9c8494f6d3a1949eff45854f4c03cb1d984`.

### Commandes et limites

- Setup isolé : `npm ci --no-audit --no-fund` ; le postinstall a ajouté une ligne
  `name` à `web/package-lock.json`, annulée exactement. Aucun drift de lockfile.
- Node `v25.6.1`, Vitest `4.1.10`. Appels de tests vers localhost uniquement.
- Ciblés : `npx vitest run src/server/llm/client-pure.test.ts src/server/llm/responses-continuity.test.ts src/server/llm/api-protocol-override.test.ts src/server/llm/responses-native.test.ts src/server/llm/responses-image.test.ts src/server/llm/ollama-native.test.ts src/server/events/tool-result-parity.test.ts src/server/replay-compaction.integration.test.ts --maxWorkers=1 --reporter=dot --silent=passed-only`.
- RED/GREEN et suites exécutés sans filtrer leur sortie par tail/grep.
- Aucun LLM réel/payant, crash brutal, démarrage de résident ou canary de production.
  La réouverture testée est une fermeture propre de la SQLite synthétique.
- Aucun changement wrapper, OpenCode, UI, configuration utilisateur ou données
  de production ; aucune chaîne/clé/digest modifié pour masquer le défaut.
- Livraison autorisée en préparation : commit/push de la branche, merge
  fast-forward vers `main`, paquet isolé vérifié et installation atomique.
  Le manifeste `DEPLOYMENT.md` du répertoire de release consignera le SHA exact,
  les hashes de l'artefact, les vérifications et le retour arrière.
  Aucun redémarrage par l'agent. Cette validation n'est pas une preuve de
  réparation de l'ancienne session et n'autorise pas une reconstruction coûteuse.

### Anciennes sessions : limite de compatibilité établie

Checkpoint `b61cc2bb…` : `ready`, 1 387 éléments, artefact natif présent.
La chaîne de réponses persistée reconstruit exactement ces 1 387 hashes.
Le matcher distant est inchangé, SHA-256
`ac5a91eb1691fc7c1ec553f70117b60107a07ab08bd4ede5925faae8638e75fa`.

Reproduction finale : ancien input normalisé = 4 413 435 octets / 1 410 éléments,
premier écart index 1 342 ; nouvel input = 4 393 570 octets / 1 028 éléments,
premier écart index 5. Les deux sont refusés. Le SHA-256 de l'input HTTP corrigé
avant normalisation wrapper est
`b02f4a82cda00e363ab3846943e48d9d15ef34a529c081b0a6caaade8ab43ea5`.
Ces tailles JSON ne sont ni une mesure de tokens, ni une preuve de facturation.

Sur le snapshot réel 166 (+ événements jusqu'à 168), la correction supprime
382 placeholders produits par OpenFox, et pas seulement les 19 nouveaux apparus
depuis le checkpoint. L'ancien checkpoint comporte déjà des placeholders dans
son préfixe : **premier écart à l'index 5**, message assistant `" "` dans l'archive,
appel de fonction directement dans le nouvel input. Le matcher refuse toujours
la reprise, conformément à sa protection. Aucun appel LLM n'a été exécuté.

Une fixture indépendante avec le même matcher confirme : préfixe propre + delta
accepté ; ancien import avec placeholder + tour natif sans placeholder refusé
face à un historique corrigé. Ne pas présenter cette livraison comme le déblocage
automatique de `openfox improve dev` ou de toutes les conversations historiques.

Suite proposée **à faire valider séparément** : qualifier une migration explicite
des anciens historiques avec preuve de provenance des placeholders et contrôle
du contexte natif réellement conservé. Ne pas simplement ré-hasher/supprimer
l'archive, assouplir la comparaison ou forcer une réinjection complète. Si aucune
reprise sûre n'est démontrable, exposer le choix de reconstruction et son coût,
sans le déclencher automatiquement.

Preuve reproductible temporaire (aucun contenu de conversation écrit dans le fichier) :
`/tmp/openfox-empty-assistant-proof.3UZr2I/check-legacy.mts`.
Ce script lit les deux DB en lecture seule et fait seulement une comparaison
en mémoire, sans route de génération, restauration de résident ni écriture wrapper.

Référence de contrat consultée via OpenAI Docs :
[Function calling](https://developers.openai.com/api/docs/guides/function-calling).
Les appels de fonctions sont des items autonomes ; aucun texte assistant factice
n'est nécessaire. La preuve du défaut OpenFox reste celle des tests exécutés.

OpenCode a été vérifié séparément : son parcours usuel wrapper ne présente pas
le défaut (18 requêtes HTTP de mock vérifiées, 51 tests existants verts).
Le cas particulier d'historique Anthropic signé fabriquant un séparateur espace
est un sujet distinct, exclu de ce correctif OpenFox.
