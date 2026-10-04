# OpenCut Impulsion : l'éditeur vidéo que Claude pilote

Un fork d'[OpenCut classic](https://github.com/opencut-app/opencut-classic) (MIT) auquel on a ajouté un pont vers Claude Code. Tu montes dans le navigateur comme dans CapCut, et tu peux aussi donner tes consignes à Claude, qui agit directement sur la timeline : coupes, textes, sous-titres, export. Chaque modification de Claude s'annule avec Cmd+Z.

Tout tourne en local sur ton ordinateur. Tes vidéos ne partent nulle part, et le chat utilise ton propre abonnement Claude, jamais une clé d'API.

## Installation

Le plus simple : ouvre Claude Code et demande-lui « Installe https://github.com/impulsion-com/opencut-impulsion en suivant son README ».

### Ce qu'il te faut

- Un Mac (c'est la seule plateforme testée).
- [Claude Code](https://claude.com/claude-code), connecté à ton abonnement Claude (`claude`, puis `/login`).
- [Node.js](https://nodejs.org) 22 ou plus récent.
- [Bun](https://bun.sh/docs/installation).
- Google Chrome.
- ffmpeg, pour lire les métadonnées des rushes importés depuis le disque : `brew install ffmpeg`.

### Les étapes

```sh
git clone https://github.com/impulsion-com/opencut-impulsion.git
cd opencut-impulsion
bun install
bun run dev:impulsion
```

`dev:impulsion` lance l'éditeur et le pont Claude ensemble. Ctrl+C arrête les deux.

Ouvre ensuite **http://localhost:3456** dans Chrome. Utilise toujours cette adresse exacte : tes projets et tes médias sont rangés dans le navigateur pour cette adresse, et une autre (`127.0.0.1`, un autre port) les ferait « disparaître ».

### Parler à Claude

Deux façons, au choix :

- **Le panneau de chat de l'éditeur** : il marche dès que Claude Code est installé et connecté.
- **Claude Code dans un terminal** : lance `claude` depuis le dossier `opencut-impulsion` et accepte le serveur `opencut` qu'il te propose. Pour l'avoir depuis n'importe quel dossier :

  ```sh
  claude mcp add-json -s user opencut '{"type":"http","url":"http://127.0.0.1:3457/mcp","timeout":1800000}'
  ```

Dans les deux cas, l'éditeur doit être lancé et ouvert dans Chrome : Claude agit à travers cet onglet.

### Le motion design

L'onglet **Motion** du panneau de gauche liste les blocs animés : titre, sommaire, barre de commande, pile de cartes, notifications, appel à l'action, et trois plans plein écran. Un clic sur « Ajouter » pose le bloc à la tête de lecture, par-dessus ta vidéo.

Un bloc reste modifiable. Sélectionne-le dans la timeline : le panneau de droite affiche ses textes, sa position et sa durée. « Appliquer » le recalcule en quelques secondes, à la même place. Tu peux aussi l'étirer ou le raccourcir à la poignée : il se recale tout seul sur sa nouvelle durée, avec son entrée au début et sa sortie à la fin.

Tu peux aussi le demander à Claude : « ajoute un titre "Devenir Media Buyer" à 3 secondes », « change le texte de la pastille », « fais durer le sommaire 10 secondes ».

Ces blocs sont rendus par Remotion. Remotion est gratuit pour les particuliers et les entreprises de 3 personnes ou moins, payant au-delà : voir [remotion.dev/license](https://remotion.dev/license).

### Tes dossiers de vidéos

Claude peut importer des fichiers depuis `~/Movies`, `~/Downloads`, `~/Desktop` et les disques externes, et les exports arrivent dans `~/impulsion/videos/exports`. Pour changer ces dossiers, crée `~/.config/opencut-impulsion/config.json` :

```json
{
	"allowedRoots": ["~/Movies", "~/Mes rushes"],
	"exportsDir": "~/Movies/exports"
}
```

Pour le montage automatique à partir de consignes (sous-titres, zooms, motion design), installe aussi le [kit montage](https://github.com/impulsion-com/kit-montage).

Tous les réglages et le dépannage sont dans [`apps/bridge/README.md`](apps/bridge/README.md), l'architecture dans [`docs/impulsion-architecture.md`](docs/impulsion-architecture.md).

---

# OpenCut (Legacy)

The rest of this file is the upstream README. The original codebase is archived; its rewrite is happening at [opencut-app/opencut](https://github.com/opencut-app/opencut).

## Sponsors

Thanks to [Vercel](https://vercel.com?utm_source=github-opencut&utm_campaign=oss) and [fal.ai](https://fal.ai?utm_source=github-opencut&utm_campaign=oss) for their support of open-source software.

<a href="https://vercel.com/oss">
  <img alt="Vercel OSS Program" src="https://vercel.com/oss/program-badge.svg" />
</a>

<a href="https://fal.ai">
  <img alt="Powered by fal.ai" src="https://img.shields.io/badge/Powered%20by-fal.ai-000000?style=flat&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJMMTMuMDkgOC4yNkwyMCAxMEwxMy4wOSAxNS43NEwxMiAyMkwxMC45MSAxNS43NEw0IDEwTDEwLjkxIDguMjZMMTIgMloiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=" />
</a>

## Why?

- **Privacy**: Your videos stay on your device
- **Free features**: Most basic CapCut features are now paywalled 
- **Simple**: People want editors that are easy to use - CapCut proved that

## Project Structure

- `apps/web/`: Next.js web application
- `apps/desktop/`: Native desktop app built with GPUI (in progress)
- `rust/`: Platform-agnostic core: GPU compositor, effects, masks, and WASM bindings. We're actively migrating business logic here from TypeScript.
- `docs/`: Architecture and subsystem documentation

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/docs/installation)

> **Impulsion fork:** the web app runs 100% locally for a single user. There is no database, auth, Redis, telemetry or deployment target. Every environment variable is optional.
>
> Telemetry is off for Next (`NEXT_TELEMETRY_DISABLED=1`) and Turborepo (`TURBO_TELEMETRY_DISABLED=1`, `--no-update-notifier`). The remaining outbound calls are accepted on purpose: Google Fonts CSS for the editor's font picker, Hugging Face models for the in-browser Whisper captions, cdn.brandfetch.io guide icons and, in `next dev` only, Next's version check against registry.npmjs.org (it has no switch; `bun run build && bun run start` in `apps/web` avoids it).

### Setup

1. Fork and clone the repository

2. Copy the environment file:

   ```bash
   # Unix/Linux/Mac
   cp apps/web/.env.example apps/web/.env.local

   # Windows PowerShell
   Copy-Item apps/web/.env.example apps/web/.env.local
   ```

3. Install dependencies and start the dev server:

   ```bash
   bun install
   bun dev:web
   ```

The application will be available at [http://localhost:3456](http://localhost:3456). Always use exactly this URL: projects and media are stored in that origin's IndexedDB and OPFS.

### Desktop setup

Desktop is opt-in. If you're only working on the web app, skip this entirely.

If you want to get ready for `apps/desktop`, see [`apps/desktop/README.md`](apps/desktop/README.md). It's a two-step setup: Rust toolchain first, then desktop native dependencies.

### Local WASM development

Only needed if you're editing `rust/wasm` and want the web app to use your local build instead of the published package.

**Prerequisites**: install these once before anything else:

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# build the WASM package
cargo install wasm-pack

# reruns the build on file changes, used by bun dev:wasm
cargo install cargo-watch
```

1. Build the package once from the repo root:

   ```bash
   bun run build:wasm
   ```

2. Register the generated package for linking:

   ```bash
   cd rust/wasm/pkg
   bun link
   ```

3. Link `apps/web` to the local package:

   ```bash
   cd apps/web
   bun link opencut-wasm
   ```

4. Rebuild on changes while you work:

   ```bash
   bun dev:wasm
   ```

To switch `apps/web` back to the published package, run:

```bash
cd apps/web
bun add opencut-wasm
```

## Contributing

We welcome contributions! While we're actively developing and refactoring certain areas, there are plenty of opportunities to contribute effectively.

**🎯 Focus areas:** Timeline functionality, project management, performance, bug fixes, and UI improvements outside the preview panel.

**⚠️ Avoid for now:** Preview panel enhancements (fonts, stickers, effects) and export functionality - we're refactoring these with a new binary rendering approach.

See our [Contributing Guide](.github/CONTRIBUTING.md) for detailed setup instructions, development guidelines, and complete focus area guidance.

**Quick start for contributors:**

- Fork the repo and clone locally
- Follow the setup instructions in CONTRIBUTING.md
- Working on `apps/desktop`? See [`apps/desktop/README.md`](apps/desktop/README.md) for setup
- Create a feature branch and submit a PR

## License

[MIT LICENSE](LICENSE)

---

![Star History Chart](https://api.star-history.com/svg?repos=opencut-app/opencut&type=Date)

