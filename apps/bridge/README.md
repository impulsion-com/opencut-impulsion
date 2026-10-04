# @opencut/bridge : le sidecar qui branche Claude sur l'éditeur

Un petit processus Node 22 local, lancé à côté de l'éditeur, qui écoute sur `127.0.0.1:3457`. Il fait le lien entre Claude et l'onglet de l'éditeur OpenCut ouvert dans Chrome (`http://localhost:3456`), parce que tout le projet (timeline, médias) vit dans le navigateur et que Claude ne peut agir qu'à travers cet onglet.

Il héberge quatre choses sur le même port :

| Route                                        | Rôle                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ws://127.0.0.1:3457/editor`                 | Le hub WebSocket auquel l'onglet de l'éditeur se connecte. Les outils « tab » y sont relayés en RPC.                            |
| `http://127.0.0.1:3457/mcp`                  | Le serveur MCP (Streamable HTTP, avec sessions) partagé par toutes les sessions Claude Code en terminal.                        |
| chat (sur le WebSocket)                      | Le backend du panneau de chat intégré : Agent SDK `query()` sur ton Claude Code connecté (abonnement Max, jamais de clé d'API). |
| `GET /files/<id>` et `POST /exports/<jobId>` | Le service des fichiers du disque pour les imports, et la réception des exports rendus par l'onglet.                            |
| `GET /health`                                | L'état : version, onglet connecté, projet ouvert, sessions MCP et chat.                                                         |

Les 27 outils sont définis une seule fois dans `packages/claude-tools` (le contrat) et enregistrés deux fois avec le même registre (`src/tools.ts`) : sur le serveur MCP HTTP pour Claude Code, et sur le serveur MCP en mémoire du chat. Les outils « tab » sont relayés tels quels à l'onglet ; `list_disk_media`, `import_media`, `start_export`, `job_status` et `cancel_job` sont gérés ici (disque, tâches de fond), et `list_media` est enrichi du chemin disque des médias importés.

## Démarrer

Depuis la racine du dépôt :

```sh
bun run dev:impulsion   # l'éditeur (3456) et le sidecar (3457) ensemble, Ctrl+C arrête les deux
bun run dev:bridge      # le sidecar seul
```

`dev:impulsion` ne relance pas un service qui écoute déjà sur son port (par exemple un `bun run dev` déjà ouvert dans `apps/web`). Vérification rapide :

```sh
curl -s http://127.0.0.1:3457/health
cd apps/bridge && node --import tsx scripts/smoke-mcp.ts   # initialize, tools/list et quelques appels via le vrai client MCP
```

Ensuite, ouvre `http://localhost:3456` (toujours `localhost`, jamais `127.0.0.1:3456`) : l'onglet se connecte tout seul au hub et `/health` affiche `"connected": true`.

## Enregistrer le serveur dans Claude Code

Deux possibilités, au choix :

- **Par projet** : le fichier `.mcp.json` à la racine du dépôt déclare `opencut` (`http://127.0.0.1:3457/mcp`). Claude Code le propose dès que tu travailles dans le dossier `opencut`, avec les deux profils.
- **Partout** (portée utilisateur, à faire une fois par profil) :

  ```sh
  claude mcp add-json -s user opencut '{"type":"http","url":"http://127.0.0.1:3457/mcp","timeout":1800000}'
  CLAUDE_CONFIG_DIR=~/.claude-b claude mcp add-json -s user opencut '{"type":"http","url":"http://127.0.0.1:3457/mcp","timeout":1800000}'
  ```

  Le `timeout` (30 min) compte : sans lui, Claude Code abandonne un appel HTTP resté 5 minutes sans réponse ni notification de progression. `import_media` envoie une progression au moins toutes les 30 s, mais un `claude mcp add` sans `timeout` reste à la merci d'un client qui n'en demande pas. Un second `import_media` sur des fichiers déjà en cours d'import les ignore (raison dans `skipped`) au lieu de les copier deux fois.

Les outils apparaissent sous la forme `mcp__opencut__<nom>`. Les outils principaux portent `_meta["anthropic/alwaysLoad"]`, pour ne pas être repoussés derrière la recherche d'outils. Plusieurs sessions Claude Code peuvent utiliser le serveur en même temps ; elles pilotent toutes le même onglet actif.

Un seul onglet pilote l'éditeur. Un onglet qui se recharge garde ce rôle 5 s (les appels l'attendent au lieu de partir vers un autre onglet). Un onglet ouvert au premier plan prend la main ; un onglet ouvert ou reconnecté en arrière-plan reste passif jusqu'au clic sur « Piloter depuis cet onglet ». Après un redémarrage du sidecar, l'onglet qui pilotait reprend la main, quel que soit l'ordre des reconnexions. Un éditeur affiché dans un cadre (iframe) ne se connecte jamais au sidecar.

Sans onglet connecté, les outils de l'éditeur répondent proprement `EDITOR_NOT_CONNECTED` (avec la consigne d'ouvrir `http://localhost:3456`), sans rien casser. Si l'onglet vient de se recharger, l'appel attend jusqu'à 5 s qu'il revienne.

## Le chat intégré

Chaque fil de discussion (`sessionKey`, choisi par le panneau) a sa propre session Agent SDK de longue durée, qui lance le binaire `claude` installé (`~/.local/bin/claude`, jamais le binaire embarqué du SDK) :

- **Abonnement, pas d'API** : le processus lancé ne reçoit qu'une liste blanche de variables (`HOME`, `PATH`, `LANG`, `LC_*`, proxy...). Ni clé (`ANTHROPIC_*`, `OPENAI_API_KEY`, jeton 1Password...), ni variable qui change de compte ou de fournisseur (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`...), ni variable d'une session Claude Code qui aurait lancé le sidecar ne passe ; celles qui changeraient de compte sont signalées au démarrage. Si `system/init` indique malgré tout une autre source que `none`, le panneau reçoit un avertissement en français.
- **Profils** : A (`~/.claude`, le compte par défaut) et B (`~/.claude-b`, un second compte facultatif). Changer de profil relance la session et reprend la même conversation dans l'autre profil (la transcription est copiée si besoin).
- **Modèles** : ceux de `CHAT_MODELS` (Opus 5.5 par défaut). Un changement de modèle s'applique à la session en cours, sans la relancer.
- **Outils** : uniquement les outils opencut (`tools: []`, `strictMcpConfig`, `settingSources: []` : ni tes réglages, ni tes autres serveurs MCP). Les outils destructifs (aujourd'hui `remove_media`) déclenchent un `permission_request` dans le panneau et attendent la réponse ; sans réponse au bout de 5 minutes, l'action est refusée.
- **Reprise** : après un redémarrage du sidecar, le panneau renvoie `resumeSessionId` (reçu dans `turn_end`) et la conversation reprend. Si elle est introuvable, une nouvelle conversation démarre et le message est renvoyé.

Les messages de l'Agent SDK sont traduits en `ChatEvent` (contrat) : `session`, `text_delta`, `thinking_delta`, `tool_start`, `tool_end` (avec une miniature si l'outil a renvoyé une image), `assistant_done`, `turn_end`, `permission_request`, `job`, `rate_limit`, `error`. Un même `toolUseId` peut arriver deux fois dans `tool_start` : d'abord avec `input: null` dès que Claude commence l'appel, puis avec l'entrée complète. Le panneau doit mettre à jour la puce existante.

## Imports et exports

- `import_media` vérifie chaque chemin (liste blanche, fichier existant, type vidéo, audio ou image), puis donne à l'onglet une URL opaque `http://127.0.0.1:3457/files/<id>` valable 24 h : le chemin disque ne circule jamais dans une URL. Une fois l'import terminé, l'index `~/.config/opencut-impulsion/projects/<projectId>/media-index.json` associe chaque `mediaId` à son chemin, sa taille et sa date.
- `start_export` crée une tâche, demande le rendu à l'onglet avec l'adresse d'envoi `POST /exports/<jobId>`, et renvoie aussitôt `{jobId, outputPath}`. Le fichier est écrit dans un fichier temporaire caché puis mis à son nom final (suffixe « (2) » si le nom existe déjà). `job_status` suit la progression, `cancel_job` l'annule.

## Configuration

Tout est optionnel. Fichier `~/.config/opencut-impulsion/config.json` (les clés inconnues sont refusées, pour que les fautes de frappe se voient) :

```json
{
	"allowedRoots": [
		"~/impulsion/videos",
		"~/Movies",
		"~/Downloads",
		"~/Desktop",
		"/Volumes"
	],
	"exportsDir": "~/impulsion/videos/exports",
	"claudePath": "~/.local/bin/claude",
	"profiles": { "A": "~/.claude", "B": "~/.claude-b" },
	"defaultProfile": "A",
	"defaultModel": "claude-opus-5-5",
	"chatEffort": "high",
	"ffprobePath": "/opt/homebrew/bin/ffprobe",
	"ffmpegPath": "/opt/homebrew/bin/ffmpeg",
	"maxExportBytes": 21474836480,
	"fileTokenTtlHours": 24,
	"logLevel": "info"
}
```

Les variables d'environnement passent devant le fichier : `OPENCUT_BRIDGE_CONFIG`, `OPENCUT_BRIDGE_ALLOWED_ROOTS` (séparées par `:`), `OPENCUT_BRIDGE_EXPORTS_DIR`, `OPENCUT_BRIDGE_DATA_DIR`, `OPENCUT_BRIDGE_CLAUDE_PATH`, `OPENCUT_BRIDGE_PROFILE_A`, `OPENCUT_BRIDGE_PROFILE_B`, `OPENCUT_BRIDGE_DEFAULT_PROFILE`, `OPENCUT_BRIDGE_DEFAULT_MODEL`, `OPENCUT_BRIDGE_FFPROBE`, `OPENCUT_BRIDGE_FFMPEG`, `OPENCUT_BRIDGE_LOG_LEVEL`, et `OPENCUT_BRIDGE_PORT` (pour les tests seulement : l'éditeur appelle toujours le port 3457).

## Modèle de sécurité

Outil personnel, local et mono-utilisateur, qui pilote ta propre connexion Claude Code : ne jamais le déployer ni le partager.

- **Boucle locale uniquement** : tout écoute sur `127.0.0.1`, jamais sur le réseau.
- **Hub WebSocket** : les WebSockets échappent au CORS, donc le hub refuse toute connexion dont l'`Origin` n'est pas exactement `http://localhost:3456` (y compris sans `Origin`), et tout `Host` autre que `127.0.0.1` ou `localhost`. Un site web ouvert dans Chrome ne peut pas s'y connecter.
- **En-tête Host (DNS rebinding)** : l'application Express reprend la protection de `createMcpExpressApp` (le SDK MCP) et refuse tout `Host` autre que `localhost`, `127.0.0.1` ou `[::1]` sur toutes les routes. Elle accepte des corps JSON jusqu'à 16 Mo sur `/mcp` (la limite de 100 ko d'Express refusait des appels valides, par exemple 200 marqueurs avec de longues notes).
- **`/mcp`** : toute requête qui porte un `Origin` (donc venant d'un navigateur) est refusée. Claude Code n'en envoie pas.
- **`/files` et `/exports`** : CORS réservé à `http://localhost:3456` ; une requête avec un autre `Origin` est refusée d'emblée. Les fichiers servis passent par une liste blanche stricte : chemin réel (liens symboliques résolus) à l'intérieur d'un dossier autorisé, aucun fichier ou dossier caché, revérifié à chaque requête. Seules les URL opaques émises par le sidecar existent. Un export n'est accepté que pour une tâche créée par `start_export`, une seule fois, avec une limite de taille et une vérification de l'espace libre.
- **Côté onglet** : les schémas du contrat n'acceptent que des URL `http://127.0.0.1:3457/files...` et `/exports...`, pour que l'onglet ne lise ni n'envoie rien ailleurs.
- **Journal** : une ligne horodatée par événement, sans secret, sans contenu de fichier ni texte de prompt.

## Tests

```sh
bun test apps/bridge                                  # hub, fichiers, exports, chat, registre, serveur
bunx tsc --noEmit -p apps/bridge/tsconfig.json
```

## Dépannage

- **`port 3457 already in use`** : un autre sidecar tourne déjà (`lsof -nP -iTCP:3457 -sTCP:LISTEN`).
- **Le chat dit que Claude Code n'a pas pu démarrer** : le profil n'est pas connecté. Lance `claude` (ou `CLAUDE_CONFIG_DIR=~/.claude-b claude`) puis `/login`.
- **Avertissement de clé d'API dans le chat** : une clé traîne dans l'environnement ou dans un `apiKeyHelper` ; retire-la et relance le sidecar.
- **Chrome affiche « WebSocket connection failed » dans la console** : normal quand le sidecar est arrêté, l'onglet réessaie toutes les 15 s au plus.
