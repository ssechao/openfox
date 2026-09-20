# OpenFox — analyse des workflows et passation

Date de vérification : 20 septembre 2026.

Ce document rassemble l'analyse du code et les explications données à l'utilisateur sur les workflows, les prompts des agents, les critères d'acceptation, le TDD, la vérification et la personnalisation. Il sert de contexte de reprise pour un autre modèle. Il décrit l'existant ; les pistes d'amélioration sont explicitement séparées et n'ont pas été mises en œuvre.

## 1. Périmètre et état observé

| Élément                                | État vérifié                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dossier du code source                 | `/Users/sechaosouchiam/Source/github.com/OpenFoxFork`                                    |
| Branche                                | `main`, affichée en suivi de `origin/main`                                               |
| Commit local                           | `6ec55ee1c98668753b310ab650e51caf8e181dc2`                                               |
| Version dans le `package.json` racine  | `2.0.145-fork.14`                                                                        |
| Version dans `dist/package.json`       | `2.0.145-fork.15`                                                                        |
| Workflow intégré étudié                | `Build & Verify`, identifiant `default`, version `1.3.1`                                 |
| État Git avant création de ce document | Aucun changement signalé par `git status --short --branch`                               |
| Méthode                                | Lecture du code, des prompts et de la documentation locale ; pas d'exécution de workflow |

**Attention à la distinction source / build / processus actif.** Les sources sont bien étiquetées `fork.14`, mais les artefacts présents dans `dist/` portent une autre version. Cela ne prouve ni que le build correspond au commit courant, ni que le serveur actif utilise ce dossier. Le processus lancé et ses personnalisations effectives n'ont pas été audités dans cette analyse des workflows.

L'utilisateur avait demandé une analyse sans modifier le code. Sa demande suivante autorise la création du présent fichier Markdown, pas une modification des workflows, des agents ou du runtime.

Actions non réalisées : modification du code applicatif, modification des configurations personnelles ou de production, migration de base, lancement de workflow, build, tests applicatifs, redémarrage, commit, push et déploiement.

Les problèmes évoqués antérieurement dans la conversation — sessions absentes, imports, compaction, authentification, providers — ne sont pas diagnostiqués par ce document. Ne pas leur attribuer une cause à partir de cette seule analyse.

## 2. Conclusions essentielles

1. Un workflow décrit des étapes et les conditions qui permettent de passer de l'une à l'autre. Il peut faire intervenir un agent, un sous-agent, une commande ou un choix humain.
2. Le workflow intégré réalise le travail, vérifie les critères, fait une revue du code, traite les remarques puis produit un résumé.
3. Le Planner prépare les critères avant le lancement habituel du workflow. Il n'est pas une étape du workflow intégré `Build & Verify`.
4. Les critères sont des éléments structurés dans la session, rédigés par le modèle ou modifiés dans l'interface. Ce ne sont pas automatiquement des tests exécutables.
5. Le Builder reçoit une consigne TDD pour les corrections et les refactorings. Le moteur ne vérifie pas qu'un test rouge a précédé la modification.
6. Le Verifier reçoit la consigne d'exécuter des tests seulement si cela s'applique au critère. Son jugement peut suffire à marquer un critère réussi.
7. Le Reviewer s'intéresse surtout au diff, à l'expérience utilisateur, aux conventions et à la complexité. Après ses remarques, le Builder peut encore modifier le code.
8. Le parcours intégré ne repasse pas automatiquement par le Verifier ou le Reviewer après ces dernières modifications.
9. Les agents, leurs prompts, les étapes et les consignes des workflows sont personnalisables. L'interface privilégie la duplication des éléments intégrés.
10. Un workflow terminé n'est pas une preuve de TDD, de tests intégralement réussis, de commit ou de déploiement.

## 3. Carte du code à consulter

Les chemins liés ci-dessous sont relatifs au présent document, situé dans `docs/`.

| Sujet                               | Fichier principal et repère                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version des sources                 | [package.json](../package.json)                                                                                                                                                                                                       |
| Workflow intégré                    | [default.workflow.json](../src/server/workflows/defaults/default.workflow.json)                                                                                                                                                       |
| Prompt du Planner                   | [planner.agent.md](../src/server/agents/defaults/planner.agent.md)                                                                                                                                                                    |
| Prompt du Builder                   | [builder.agent.md](../src/server/agents/defaults/builder.agent.md)                                                                                                                                                                    |
| Prompt du Verifier                  | [verifier.agent.md](../src/server/agents/defaults/verifier.agent.md)                                                                                                                                                                  |
| Prompt du Reviewer                  | [code-reviewer.agent.md](../src/server/agents/defaults/code-reviewer.agent.md)                                                                                                                                                        |
| Prompt commun et rappels de rôle    | [prompts.ts](../src/server/chat/prompts.ts), `buildBasePrompt`, `buildTopLevelSystemPrompt`, `buildAgentReminder`                                                                                                                     |
| Injection des rappels               | [orchestrator.ts](../src/server/chat/orchestrator.ts), `injectAgentReminder`, `runAgentTurn`                                                                                                                                          |
| Assemblage des requêtes             | [request-context.ts](../src/server/chat/request-context.ts)                                                                                                                                                                           |
| Contexte des sous-agents            | [manager.ts](../src/server/sub-agents/manager.ts), `executeSubAgent` ; [conversation-history.ts](../src/server/chat/conversation-history.ts)                                                                                          |
| Critères et remarques               | [session-metadata.ts](../src/server/tools/session-metadata.ts)                                                                                                                                                                        |
| Persistance des métadonnées         | [manager.ts](../src/server/session/manager.ts), `setMetadataEntries`                                                                                                                                                                  |
| Moteur des workflows                | [executor.ts](../src/server/workflows/executor.ts), `evaluateCondition`, `resolveTemplate`, exécution des étapes                                                                                                                      |
| Types des workflows                 | [types.ts](../src/server/workflows/types.ts)                                                                                                                                                                                          |
| Chargement des workflows            | [registry.ts](../src/server/workflows/registry.ts)                                                                                                                                                                                    |
| Chargement des agents               | [registry.ts](../src/server/agents/registry.ts)                                                                                                                                                                                       |
| API d'édition                       | [workflows.ts](../src/server/routes/workflows.ts), [agents.ts](../src/server/routes/agents.ts), [crud-helpers.ts](../src/server/routes/crud-helpers.ts)                                                                               |
| Éditeur de workflows                | [WorkflowsModal.tsx](../web/src/components/settings/WorkflowsModal.tsx), [StepPanel.tsx](../web/src/components/settings/workflows/StepPanel.tsx), [TransitionPanel.tsx](../web/src/components/settings/workflows/TransitionPanel.tsx) |
| Éditeur d'agents                    | [AgentsModal.tsx](../web/src/components/settings/AgentsModal.tsx), [AgentForm.tsx](../web/src/components/settings/agents/AgentForm.tsx)                                                                                               |
| Lancement dans le chat              | [PlanPanel.tsx](../web/src/components/plan/PlanPanel.tsx), [MoreMenu.tsx](../web/src/components/plan/MoreMenu.tsx), [MessageList.tsx](../web/src/components/plan/MessageList.tsx)                                                     |
| Saisie, pause et arrêt              | [ChatInput.tsx](../web/src/components/plan/ChatInput.tsx), [WorkflowBar.tsx](../web/src/components/plan/WorkflowBar.tsx)                                                                                                              |
| Choix de l'agent                    | [AgentSelector.tsx](../web/src/components/plan/AgentSelector.tsx)                                                                                                                                                                     |
| Édition manuelle des critères       | [CriteriaEditor.tsx](../web/src/components/plan/CriteriaEditor.tsx)                                                                                                                                                                   |
| Reprise d'une exécution             | [launch.ts](../src/server/runner/launch.ts) ; [server.ts](../src/server/ws/server.ts), traitement `workflow.exit`                                                                                                                     |
| Référence de création des workflows | [SKILL.md](../src/server/skills/defaults/workflows/SKILL.md), également référencé par [WORKFLOWS.md](WORKFLOWS.md)                                                                                                                    |

## 4. Utilisation dans l'interface

### 4.1 Parcours habituel

1. Ouvrir une session sur le bon projet.
2. Choisir `Planner` pour préparer la demande sans implémenter.
3. Envoyer la demande, avec les contraintes et les résultats attendus.
4. Faire préciser ou corriger les critères proposés par le Planner.
5. Lancer `Build & Verify`, soit depuis le bouton proposé dans la conversation, soit depuis `…` → `Workflows`.
6. Choisir l'espace de travail actuel ou la création d'un nouvel espace.
7. Suivre les étapes et répondre aux choix humains éventuels.
8. Lire le résumé final et essayer les parcours utilisateur proposés.

Le bouton dans la conversation n'est pas permanent. `MessageList.tsx` le conditionne notamment à la présence de critères `pending`, à une réponse de l'assistant, à l'absence d'exécution en cours et à une session non terminée. Le menu constitue un autre point d'entrée.

**Envoyer la demande avant de lancer le workflow.** Dans `PlanPanel.tsx`, la sélection d'un workflow appelle le lancement sans transmettre le texte du brouillon, puis vide la saisie. Un texte seulement tapé n'est donc pas une demande déjà disponible dans la conversation.

Les workflows peuvent aussi être reconnus par une commande `/identifiant`. Les paramètres définis par un workflow peuvent être demandés au lancement ; les paramètres requis manquants sont signalés. Le workflow intégré étudié n'en définit pas.

### 4.2 Arrêt, pause, choix humain et sortie

| Commande ou situation               | Sens                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Pause de génération                 | Suspension/reprise du travail courant via le contrôle de pause du chat ; distincte d'une étape humaine                        |
| Étape de type `user`                | Le workflow attend un choix ; l'interface affiche les boutons issus des transitions ou `Continuer`                            |
| `Stopper`                           | Interruption du tour en cours ; l'exécution du workflow est conservée et peut être reprise, notamment avec un nouveau message |
| `Quitter` dans la barre du workflow | Annulation de l'exécution active et interruption du tour actif                                                                |

Ni `Stopper` ni `Quitter` n'annulent automatiquement les modifications de fichiers déjà réalisées. Une reprise n'est pas non plus un rollback.

### 4.3 Sous-groupes

Le menu adjacent au bouton de lancement permet d'exécuter un sous-groupe plutôt que le workflow complet.

| Sous-groupe intégré | Travail effectué et précaution                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `build`             | Choix de l'espace, préparation éventuelle, implémentation ; ne déclenche pas automatiquement la vérification complète         |
| `verify`            | Vérification ; en cas d'échec, une transition autorise le retour au Builder, donc des modifications de code restent possibles |
| `code review`       | Revue puis `Finalize` par le Builder ; ce n'est pas une revue garantie en lecture seule                                       |
| `summarize`         | Résumé final                                                                                                                  |

Pour une analyse sans modification, ne pas assimiler les sous-groupes `verify` et `code review` à un mode d'audit immuable.

## 5. Déroulement exact de Build & Verify

La définition intégrée porte `entryStep: work_location`, `startCondition: always` et `maxIterations: 12`.

```text
Choisir l'espace de travail
  ├─ espace actuel ───────────────────┐
  └─ nouvel espace → préparer espace ┤
                                     ▼
                                Implement
                                     │
                            critères réalisés
                                     ▼
                                 Verifier
                    échec ───────────┤
                      │              │ tous passed
                      └→ Implement   ▼
                                Code Review
                                     ▼
                                  Finalize
                                     │
                   remarques resolved ou dismissed
                                     ▼
                                 Summarize
                                     ▼
                                    done
```

| Étape                           | Exécutant                | Ce qui est demandé                                                                             | Passage à la suite                                                      |
| ------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `work_location` / Where to work | Utilisateur              | Choisir `Work in current workspace` ou `Start a new workspace`                                 | Selon le bouton choisi                                                  |
| `setup_workspace`               | Builder                  | Créer/basculer vers un espace avec un nom choisi à partir de la tâche, sans encore implémenter | Après la fin de l'étape                                                 |
| `build` / Implement             | Builder                  | Réaliser la tâche et marquer les critères `completed`                                          | Tous les critères `completed` ou `passed`, sinon retour sur cette étape |
| `verify` / Verifier             | Sous-agent Verifier      | Vérifier les critères et les marquer `passed` ou `failed`                                      | Tous `passed` → revue ; sinon retour au Builder                         |
| `code_review` / Code Review     | Sous-agent Code Reviewer | Examiner le diff et enregistrer les remarques                                                  | Puis `Finalize`                                                         |
| `finalize` / Finalize           | Builder                  | Corriger ou écarter les remarques de revue                                                     | Toutes `resolved` ou `dismissed`, sinon poursuite de la finalisation    |
| `summarize` / Summarize         | Builder                  | Résumer le résultat et donner des manipulations à tester                                       | Fin                                                                     |

Les étapes `agent` doivent également appeler `step_done()` pour terminer leur tour d'étape. Le détail des contrôles est décrit en section 11.

Le choix initial de l'espace de travail est le seul arrêt humain explicitement prévu dans ce workflow intégré. Il ne faut pas supposer une validation humaine obligatoire à chaque étape.

Il n'y a pas d'étape explicite de commit, push ou déploiement. Il n'y a pas non plus d'étape `shell` dédiée à une commande de tests imposée par ce workflow : les tests éventuels sont exécutés par les agents via leurs outils.

## 6. Les différentes couches de prompts

### 6.1 Prompt système commun

`buildBasePrompt()` construit les instructions communes : identité OpenFox, environnement, comportement général, conventions, outils et catalogue des skills. Le système peut être enrichi par les instructions personnalisées chargées pour les agents principaux.

Extraits significatifs du socle :

```text
Follow repository and project instructions exactly.

OpenFox appends runtime control as USER-role messages wrapped in <system-reminder>...</system-reminder>.
These reminders are authoritative, treat them as higher-priority operational constraints.

Reminder = planning mode: focus on understanding, exploration, clarification, criteria quality.
Reminder = build mode: focus on implementation, verification, completing approved criteria.
```

Le socle demande aussi de vérifier la solution si possible avec des tests, de lancer lint/typecheck à la fin d'une tâche et de ne pas committer sans demande explicite. Ces phrases restent des consignes au modèle ; elles ne constituent pas à elles seules un contrôle du moteur.

Le prompt général est défini dans `src/server/chat/prompts.ts`. L'éditeur d'agents ne remplace pas ce socle complet.

### 6.2 Planner et Builder : rappel de rôle dans la conversation

Le prompt système des agents principaux est commun pour préserver le cache. Leur rôle spécifique vient du corps de leur fichier `.agent.md`, encadré par `<system-reminder>` et complété par la liste des outils disponibles.

`injectAgentReminder()` enregistre ce rappel avec `role: user`, `isSystemGenerated: true` et une métadonnée de type `agent`.

- Si le dernier rappel de la fenêtre courante n'est pas celui du même agent, le rappel complet est injecté.
- Sinon, un rappel court indique le mode courant.

Le nom `<system-reminder>` ne change donc pas le rôle protocolaire du message en `system`. Le prompt système commun demande au modèle de respecter ces messages comme des instructions de fonctionnement.

### 6.3 Consigne d'étape du workflow

Une étape possède son propre `prompt`. Il s'ajoute aux instructions de rôle et contient éventuellement des variables comme `{{criteriaCount}}` ou `{{criteriaList}}`.

Pour une étape `agent`, le moteur ajoute une demande d'appel à `step_done()`. Lorsqu'elle doit continuer ou être rejouée dans la boucle, une `nudgePrompt` peut fournir une relance et les problèmes à corriger. La reprise d'une étape interrompue a un traitement spécifique pour éviter de réinjecter immédiatement la consigne initiale.

Il faut distinguer :

- prompt d'agent : comment ce rôle doit travailler en général ;
- prompt d'étape : ce qu'il doit réaliser maintenant ;
- invite de relance : quoi poursuivre ou corriger ;
- transitions : ce que le code contrôle pour continuer.

### 6.4 Verifier et Reviewer : prompt spécifique et contexte distinct

Les sous-agents reçoivent un prompt système composé du socle et de leurs instructions propres, ainsi que des compléments d'exécution. Leur tâche est passée dans un message dédié.

`executeSubAgent()` crée une identité de sous-agent. `buildSubAgentContextMessages()` ne sélectionne que les messages portant cette identité, avec prise en compte de sa compaction éventuelle. Ils ne reçoivent donc pas automatiquement toute la conversation du Planner et du Builder.

Le contexte distinct n'est pas une garantie de modèle différent : la résolution du modèle dépend des préférences et des remplacements configurés pour chaque agent.

## 7. Planner : prompt exact et construction des critères

### 7.1 Corps exact du prompt intégré

Le bloc suivant reproduit le corps de `planner.agent.md`, hors métadonnées YAML et liste des outils :

```text
# Plan Mode

CRITICAL: Plan mode ACTIVE - you are in read-only phase.

You may only inspect, analyze, ask clarifying questions, and propose, refine and/or add acceptance criteria.
You MUST NOT make any edits, implementations, commits, config changes, or other system modifications.

## Responsibility

- Understand the user's goal before locking in details.
- Explore the codebase with read-only actions when needed.
- Present clear, verifiable criteria for the user to approve or refine.
- Stay in planning mode until the user explicitly switches to build mode.
- Never ask "Do you approve these criteria and shall I switch to build? (Yes/No)" — answering cannot switch modes; mode changes are driven externally, not by your question. Present the criteria plainly and stop there — do not write until a new <system-reminder> switches you to build mode, which only the user or a launched workflow can trigger.
```

### 7.2 Ce que cela demande, et ce que cela ne demande pas

Le modèle doit comprendre la demande, explorer si nécessaire et proposer des critères vérifiables. Il n'existe pas ici d'algorithme qui déduit mécaniquement les critères à partir du code.

Ce prompt ne prescrit pas explicitement :

- un format Given/When/Then ;
- un test automatisé par critère ;
- un inventaire obligatoire des cas limites ;
- une commande de validation par critère ;
- un format de preuve rouge/vert ;
- un nombre minimal de critères.

Il ne demande pas non plus d'écrire des tests à ce stade. Le Planner doit rester en préparation sans implémenter. Une autre instruction de projet ou un agent personnalisé peut demander davantage ; cela ne fait pas partie de ce prompt intégré minimal.

La mention « lecture seule » est une instruction de comportement, pas une preuve que tout effet de bord est matériellement impossible. La liste d'outils comprend notamment `run_command`. Cette analyse n'est pas un audit exhaustif des permissions et du confinement.

## 8. Critères : écriture, stockage et statut

### 8.1 Outil utilisé

`session_metadata` gère des listes sous des clés telles que `criteria`, `todos` et `review_findings`. Il offre les actions `get`, `list`, `add`, `update`, `remove` et `schema`.

Pour `criteria`, le schéma descriptif indique :

- `id` : identifiant ;
- `description` : ce qu'il faut faire et comment le vérifier ;
- `status` : `pending`, `completed`, `passed` ou `failed`.

Exemple illustratif, non exécuté :

```json
{
  "action": "add",
  "key": "criteria",
  "description": "La recherche retrouve une session par son titre sans distinguer majuscules et minuscules. Vérification : une recherche 'MOU' retrouve 'laMoulière'.",
  "status": "pending"
}
```

À l'ajout, le statut vaut `pending` s'il n'est pas précisé. L'outil construit une entrée et appelle `sessionManager.setMetadataEntries()`. Cette méthode émet l'événement de métadonnées et la notification correspondante. L'état de la session est reconstruit depuis les événements.

`CriteriaEditor.tsx` permet aussi l'ajout, la modification, la suppression et le changement de statut depuis l'interface.

### 8.2 Cycle prévu

```text
pending : à réaliser
   ↓ Builder
completed : déclaré réalisé, à vérifier
   ↓ Verifier
passed : jugé satisfait
   ou
failed : jugé non satisfait → retour Builder → completed → nouvelle vérification
```

La liste envoyée au Verifier présente ces statuts sous forme de marqueurs : `[NOT COMPLETED]`, `[NEEDS VERIFICATION]`, `[PASSED]`, `[FAILED]`.

### 8.3 Limites du contrôle

Les statuts attendus sont décrits, mais l'argument `status` de l'outil est une chaîne libre. L'outil ne demande pas de chemin de fichier de test, de commande, de code de retour ni de pièce justificative obligatoire.

Les critères restent modifiables ; le chemin étudié ne présente pas un contrat approuvé puis verrouillé. Les agents disposent de `session_metadata` sans séparation, dans leurs définitions intégrées, qui réserverait matériellement le statut `passed` au seul Verifier. La répartition Builder/Verifier est donc principalement une consigne.

Le prompt du Verifier demande d'expliquer l'échec « in the reason », mais l'outil courant n'expose pas de paramètre `reason`. Le retour textuel peut contenir l'explication ; il ne faut pas supposer un champ de preuve structuré obligatoire. De même, le schéma descriptif des remarques mentionne une sévérité optionnelle, sans argument dédié dans l'outil étudié.

## 9. Builder et TDD

### 9.1 Corps exact du prompt intégré

```text
# Build Mode

CRITICAL: Build mode ACTIVE - implementation is now allowed.

You are no longer in read-only mode.
You may read files, edit files, run commands, and use tools as needed to satisfy the approved criteria.

## Responsibility

- Execute the approved work with focused changes.
- Follow TDD when fixing or refactoring: write or update the failing test first, then make it pass.
- Verify changes as you go.
- Finish criteria systematically instead of replanning from scratch.
```

### 9.2 Instruction de l'étape Implement

Le workflow lui demande de réaliser la tâche, de satisfaire les `{{criteriaCount}}` critères et de les marquer `completed` via `session_metadata`.

Il lui demande aussi de ne pas appeler lui-même `code_reviewer` et `verifier`, puisque le workflow prévoit leur exécution plus tard. La relance fournit les retours de vérification et demande de corriger les échecs avant de remettre les critères à `completed`.

### 9.3 Réponse précise à « est-ce du TDD ? »

| Question                                                         | Réponse pour les définitions intégrées       |
| ---------------------------------------------------------------- | -------------------------------------------- |
| TDD demandé pour un bug ?                                        | Oui, explicitement dans le prompt Builder    |
| TDD demandé pour un refactoring ?                                | Oui, avec la même formulation                |
| TDD explicitement imposé à toute nouvelle fonctionnalité ?       | Non, pas par cette phrase                    |
| Test rouge exigé par le moteur avant la modification ?           | Non dans le workflow intégré                 |
| Preuve enregistrée d'un rouge puis d'un vert ?                   | Aucun champ ou passage obligatoire prévu ici |
| Tests, lint et typecheck encouragés/demandés par les prompts ?   | Oui, selon les consignes du rôle et du socle |
| Leur exécution est-elle nécessairement prouvée par `completed` ? | Non                                          |

Le TDD est donc une consigne partielle de méthode. Le moteur contrôle la fin de l'étape et les statuts des critères, pas la chronologie test en échec → modification → test réussi.

## 10. Verifier, Review et Finalize

### 10.1 Verifier : contrôle des exigences

Le prompt intégré décrit une vérification indépendante. Pour chaque critère `[NEEDS VERIFICATION]`, il demande :

1. d'interpréter la demande et le critère ;
2. de lire les fichiers modifiés si le critère nécessite du code ;
3. de juger les critères conceptuels sur leur description ;
4. de lancer des tests ou des commandes seulement si applicable ;
5. de mettre le statut à `passed` ou `failed` et de fournir un retour exploitable.

Extraits exacts particulièrement importants :

```text
Run tests or commands only if applicable to the criterion

For trivial or non-code criteria, pass them immediately without exploring the codebase

Don't re-verify criteria already marked [PASSED]
```

Le prompt d'étape du workflow lui transmet `{{criteriaList}}` et `{{modifiedFiles}}`. Bien que le rôle évoque un « Task summary », le modèle de cette étape ne contient pas de section explicite dédiée au résumé complet de la demande. Il ne faut pas supposer que tout le contexte de planification est automatiquement transmis.

`{{modifiedFiles}}` est une liste de chemins avec leur statut, pas le diff complet. `src/server/git/diff.ts` la construit à partir des modifications Git par rapport à `HEAD` et des fichiers non suivis. Elle peut inclure des changements préexistants dans un espace déjà modifié ; elle n'établit pas à elle seule l'auteur de chaque modification. Le sous-agent doit utiliser ses outils pour lire le code et le diff pertinents.

Tous les critères `passed` autorisent la revue. Un critère non passé renvoie vers le Builder. Les tests ne sont pas une condition distincte dans cette transition.

Deux conséquences : un critère peut être accepté sans test exécuté ; un critère déjà passé peut ne pas être revérifié après une correction qui le ferait régresser.

### 10.2 Code Reviewer : qualité des changements

Le Reviewer reçoit une consigne centrée sur le `git diff`, avec deux axes principaux :

- expérience utilisateur : comportements confus, frictions, interactions ;
- qualité du projet : conventions, maintenabilité, complexité et gonflement inutile.

Extraits exacts :

```text
You are a code reviewer. Review the **git diff** of the modified files rather than reading the full files.

You're not looking for 100% perfection. Just something that feels good to use and doesn't bloat the software.
```

Il crée les remarques sous `review_findings` avec le statut `open`. Son prompt sait également traiter une nouvelle revue : remarques corrigées → `resolved`, remarques non pertinentes → `dismissed`.

Cette capacité à faire une seconde revue ne signifie pas que le workflow intégré la déclenche : la transition de `code_review` mène directement à `finalize`.

### 10.3 Finalize : le Builder traite les remarques

Le Builder reçoit le retour du Reviewer, lit les remarques enregistrées puis doit :

- corriger un problème et le marquer `resolved` ;
- ou l'écarter comme non applicable et le marquer `dismissed`.

L'étape poursuit son travail tant qu'une remarque n'a pas un de ces deux statuts. Une fois les remarques traitées et l'étape terminée, elle va à `summarize`.

**Il n'y a pas de retour automatique au Verifier ou au Reviewer après Finalize.** Les derniers changements peuvent donc survenir après le contrôle des critères. Le Builder peut effectuer ses propres vérifications, mais un second contrôle indépendant n'est pas garanti par le graphe.

### 10.4 Summarize

La dernière étape demande un résumé de ce qui a été réalisé, des fichiers clés, des décisions et un petit guide de tests manuels du point de vue utilisateur. Elle termine ensuite le workflow. Ce résumé n'est pas un mécanisme de validation supplémentaire.

## 11. Ce que le moteur contrôle réellement

### 11.1 Types d'étapes

| Type        | Exécution                                            | Signal de fin ou résultat                                     |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `agent`     | Tour de l'agent principal désigné                    | Appel réussi à `step_done()` ; sinon relance de la même étape |
| `sub_agent` | Sous-agent avec contexte distinct                    | Retour via `return_value`, puis examen des transitions        |
| `shell`     | Commande avec délai et codes de succès configurables | Résultat `success` ou `failure` selon le code de retour       |
| `user`      | Attente d'un choix humain                            | Choix renvoyé par l'utilisateur                               |

`step_done()` ne signifie pas « les tests ont réussi ». Il indique que l'agent termine l'étape ; les transitions décident ensuite de la suite.

Le registre d'outils distingue `step_done` pour les agents principaux et `return_value` pour les sous-agents. Certaines formulations de la référence documentaire mentionnent `return_value` pour les étapes principales : ne pas en déduire qu'il est disponible dans leur politique d'outils actuelle. Vérifier [tool-policy.ts](../src/server/tools/tool-policy.ts) avant de concevoir un nouveau branchement.

### 11.2 Conditions de transition

Les transitions sont évaluées dans l'ordre ; la première qui correspond est retenue.

| Condition            | Contrôle                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `always`             | Toujours vraie                                                      |
| `step_result`        | Le résultat de l'étape correspond exactement à une chaîne           |
| `metadata_all_match` | Tous les éléments d'une clé possèdent une valeur donnée             |
| `metadata_all_in`    | Tous les éléments d'une clé ont une valeur dans une liste autorisée |

**Une liste de critères absente ou vide satisfait les conditions « tous les critères… » lorsque l'objet de métadonnées est disponible.** `evaluateCondition()` renvoie vrai pour cette liste vide. Avec `startCondition: always`, le workflow intégré ne possède donc pas de garde imposant des critères non vides avant de commencer. Le bouton proposé dans le chat et l'autorisation réelle du moteur ne sont pas équivalents.

### 11.3 Relances, limite et blocages

Une étape d'agent qui n'appelle pas `step_done()` est relancée. Une condition de transition non satisfaite peut ramener sur la même étape ou sur une étape précédente.

`maxIterations: 12` limite les passages de la boucle d'exécution intégrée ; ce n'est ni douze tests, ni douze tentatives par critère. Le compteur est local à une invocation de l'exécuteur et réinitialisé lorsqu'il est réinvoqué : ne pas le présenter comme un budget cumulatif immuable sur toutes les pauses et reprises.

Les causes de blocage comprennent une condition d'entrée non satisfaite, l'absence de transition correspondante, l'épuisement de la limite et certains échecs d'appel au modèle. Le chemin de reprise conserve notamment l'étape courante, les paramètres et le résultat précédent.

### 11.4 Variables utiles

Les prompts peuvent recevoir notamment `{{workdir}}`, `{{criteriaCount}}`, `{{criteriaList}}`, `{{reason}}`, `{{modifiedFiles}}` et `{{stepOutput.content}}`. Les commandes peuvent exploiter les sorties de l'étape précédente : `stdout`, `stderr`, `exitCode`.

`stepOutput` désigne la sortie immédiatement précédente, pas une mémoire nommée et persistante de toutes les étapes. Les paramètres de lancement sont également substitués dans les modèles de texte.

L'interface expose une invite de relance pour les étapes agent et sous-agent, mais le chemin `sub_agent` étudié résout son `prompt` à chaque appel sans lire `nudgePrompt`. Ne pas supposer que ce champ de l'interface a la même portée sur les deux types.

## 12. Personnalisation prévue par le produit

### 12.1 Modifier le workflow

Chemin : `…` → `Workflows` → `Gérer les workflows`.

L'interface permet de partir d'une copie du workflow intégré, puis de changer :

- le nom, la description et la version ;
- l'étape d'entrée et la limite d'itérations ;
- les étapes, leur type et leur agent ;
- les prompts et les relances ;
- les transitions et leurs conditions ;
- les paramètres demandés au lancement ;
- les commandes, délais et codes de succès des étapes `shell` ;
- les choix humains et les sous-groupes.

Les modèles intégrés servent de référence ; le parcours normal de personnalisation crée une copie, sans éditer leur fichier source livré avec le logiciel.

### 12.2 Modifier les agents

Chemin : sélecteur d'agent → `Gérer les agents`.

On peut consulter et dupliquer Planner, Builder, Verifier ou Reviewer, puis modifier le prompt, les outils, le type agent/sous-agent et le modèle utilisé. Les copies reçoivent un nouvel identifiant. La création par l'API des agents refuse un identifiant intégré déjà réservé.

**Une copie ne remplace pas automatiquement l'original.** Pour utiliser un Planner personnalisé, il faut le sélectionner lors de la préparation. Pour utiliser un Builder, un Verifier ou un Reviewer personnalisé, il faut les désigner dans le workflow personnalisé. Vérifier toutes les étapes : le Builder est aussi utilisé dans `setup_workspace`, `finalize` et `summarize`.

### 12.3 Stockage et portée

| Portée               | Agents                                    | Workflows                                         |
| -------------------- | ----------------------------------------- | ------------------------------------------------- |
| Intégrée aux sources | `src/server/agents/defaults/*.agent.md`   | `src/server/workflows/defaults/*.workflow.json`   |
| Personnelle          | `{configDir}/agents/*.agent.md`           | `{configDir}/workflows/*.workflow.json`           |
| Projet               | `{projectDir}/.openfox/agents/*.agent.md` | `{projectDir}/.openfox/workflows/*.workflow.json` |

Les définitions de projet sont versionnables et partageables. Le remplacement du modèle d'un agent est enregistré séparément dans les réglages de base de données ; copier son fichier `.agent.md` ne suffit pas nécessairement à partager cette préférence.

La résolution automatique des définitions utilise la priorité projet → utilisateur → intégré, par identifiant. Le catalogue de workflows peut aussi présenter plusieurs portées et permettre de choisir explicitement celle à lancer. Vérifier l'identifiant et la portée, pas seulement le nom affiché.

Les définitions sont chargées par le runtime : leur personnalisation ne nécessite pas de rebuild du logiciel. Cela ne constitue pas une garantie de remplacement immédiat des instructions déjà présentes dans une conversation ou du graphe d'une exécution en cours. Pour valider une personnalisation, préférer une nouvelle exécution contrôlée après autorisation.

### 12.4 Ce qui reste dans le code

Le prompt système commun, les types de conditions et les règles de l'exécuteur sont du code. Modifier le prompt d'un agent ne remplace pas ces mécanismes.

Des instructions personnalisées peuvent compléter le contexte des agents principaux. Leur transmission effective aux différents sous-agents et aux sessions existantes doit être vérifiée si une modification future en dépend ; cette analyse ne certifie pas toutes les combinaisons de configuration.

## 13. Limites et points d'attention à transmettre

| Point constaté                                                          | Conséquence pratique                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sources `fork.14`, manifeste `dist` `fork.15`                           | Vérifier l'artefact et le processus actifs avant toute conclusion sur la version utilisée |
| Planner peu prescriptif sur la forme des critères                       | La précision des critères dépend fortement du modèle et de la demande                     |
| Critères textuels et statuts déclarés                                   | Un statut vert ne prouve pas à lui seul une exécution de test                             |
| Critères modifiables, pas de preuve structurée obligatoire              | Ne pas parler de contrat immuable ou d'audit TDD garanti                                  |
| Liste vide acceptée par les conditions universelles                     | Un lancement sans critères n'est pas bloqué par ces conditions                            |
| TDD limité à une consigne pour correction/refactoring                   | Pas de contrôle automatique de l'ordre rouge/vert                                         |
| Tests du Verifier « si applicable »                                     | Certains critères peuvent passer sur simple analyse                                       |
| Critères déjà `passed` non revérifiés selon le prompt                   | Risque de régression non détectée après les corrections suivantes                         |
| Contexte distinct du sous-agent                                         | Les informations nécessaires doivent être transmises explicitement                        |
| `modifiedFiles` liste Git, pas diff complet ni attribution à la session | Le Reviewer doit lire le diff ; attention aux changements préexistants                    |
| Builder autorisé à `dismissed` une remarque                             | Une remarque peut être écartée sans validation humaine ou seconde revue                   |
| Pas de nouveau Verifier après Finalize                                  | Les dernières corrections n'ont pas de contrôle indépendant obligatoire                   |
| Sous-groupes `verify` et `code review` pouvant appeler le Builder       | Ne pas les vendre comme des audits garantis sans modification                             |
| Brouillon non transmis par la sélection de workflow                     | Envoyer la demande avant le lancement                                                     |
| Arrêt ou annulation sans rollback                                       | Les modifications déjà réalisées restent à examiner                                       |

Ces constats décrivent des possibilités et limites statiques. Ils ne démontrent pas qu'un modèle particulier a effectivement commis une erreur dans une session donnée.

## 14. Pistes possibles, non mises en œuvre

L'utilisateur a cherché à comprendre le comportement et la possibilité de le personnaliser. Il n'a pas autorisé la mise en place du scénario suivant. Ce sont des options de conception à discuter, pas un plan approuvé.

Pour rendre le processus plus rigoureux, il serait possible de combiner :

1. un Planner qui associe à chaque critère un résultat attendu, des cas limites et une méthode de vérification ;
2. une validation humaine explicite avant l'implémentation si souhaitée ;
3. un Builder configuré pour produire un test ciblé avant le correctif ;
4. une étape de commande contrôlant l'échec attendu, puis une étape contrôlant la réussite ;
5. une obligation de conserver les commandes et résultats pertinents ;
6. une revue suivie de corrections, puis d'une nouvelle vérification sur l'état final ;
7. une distinction claire entre validation locale, commit, CI et déploiement.

Un code de sortie non nul ne suffit pas à prouver le « rouge » TDD : une commande introuvable, un environnement cassé ou un échec sans rapport ne démontrent pas la reproduction du problème visé. De même, un code zéro ne prouve que les vérifications réellement exécutées, pas l'ensemble du besoin utilisateur.

Les étapes `shell`, les transitions et les pauses humaines permettent déjà une partie de ce renforcement sans toucher au moteur. Une preuve structurée obligatoire, une immutabilité des critères ou un contrôle d'attribution des statuts peuvent nécessiter une analyse et des évolutions supplémentaires. Ne pas promettre que quelques phrases de prompt suffisent à les imposer.

## 15. Consignes de reprise pour le prochain modèle

### 15.1 Contexte utilisateur

L'utilisateur veut comprendre comment le Planner établit les critères, si le Builder pratique le TDD, ce que vérifient réellement Verifier et Reviewer, et comment personnaliser tout cela. Il préfère des explications concrètes et a explicitement demandé de ne pas modifier le code pendant l'analyse.

La seule écriture autorisée dans ce travail de passation est ce document Markdown. Ne pas transformer la lecture de ce document en autorisation de modifier les agents, de déployer ou de toucher aux sessions.

### 15.2 Ordre de reprise conseillé

1. Lire ce document et l'[AGENTS.md du dépôt](../AGENTS.md).
2. Confirmer le dossier, le commit et l'état Git, sans écraser de changements existants.
3. Si la question concerne le comportement en production, identifier le processus et ses fichiers/configurations effectifs avant de généraliser l'analyse des sources.
4. Lire les définitions personnalisées pertinentes uniquement si nécessaire pour la demande ; ne pas supposer que les modèles intégrés sont ceux réellement utilisés.
5. Si l'utilisateur demande une modification, préciser si elle concerne un prompt de rôle, une consigne d'étape, les transitions ou le moteur.
6. Pour créer ou modifier un workflow, suivre la référence locale `src/server/skills/defaults/workflows/SKILL.md` conformément à `AGENTS.md`.
7. Séparer ensuite modification, validation, livraison et runtime. Ne pas effectuer de commit, push, redémarrage ou déploiement sans autorisation correspondante.

### 15.3 Éléments non prouvés par cette passation

- Le prompt exact envoyé lors d'une requête réelle d'une session existante.
- L'absence de personnalisations utilisateur ou projet.
- La version et l'artefact effectivement servis par un processus actif.
- Le respect réel du TDD dans les sessions précédentes.
- La qualité réelle des modèles configurés pour chaque rôle.
- Le succès des tests applicatifs ou d'un workflow personnalisé.
- La résolution des incidents de sessions, d'import ou d'authentification évoqués antérieurement.

### 15.4 Formulation courte à conserver

> OpenFox possède un workflow configurable piloté par des critères et des statuts, avec des rôles distincts de planification, réalisation, vérification et revue. Le TDD et une partie des contrôles restent des consignes aux modèles. Le workflow intégré ne constitue pas une chaîne de preuve TDD stricte et ne revérifie pas automatiquement les modifications de Finalize. Les prompts et workflows peuvent être personnalisés, mais leurs copies doivent être explicitement sélectionnées. L'analyse porte sur les sources locales, pas sur une exécution réelle certifiée.
