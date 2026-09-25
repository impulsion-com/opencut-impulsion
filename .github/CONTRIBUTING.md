# Contributing to OpenCut

⚠️ We are currently NOT accepting feature PRs while we build out the core editor.

If you want to contribute:

1. Open an issue first to discuss
2. Wait for maintainer approval
3. Only then start coding

Critical bug fixes may be accepted on a case-by-case basis.

Thank you for your interest in contributing to OpenCut! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/docs/installation)
- Rust toolchain (only needed for `apps/desktop`)

> **Impulsion fork:** the web app runs 100% locally for a single user. There is no database, auth, Redis, Docker or deployment target, and every environment variable is optional.

### Setup

1. Fork the repository
2. Clone your fork locally
3. Navigate to the web app directory: `cd apps/web`
4. Copy `.env.example` to `.env.local`:

   ```bash
   # Unix/Linux/Mac
   cp .env.example .env.local

   # Windows Command Prompt
   copy .env.example .env.local

   # Windows PowerShell
   Copy-Item .env.example .env.local
   ```

5. Install dependencies: `bun install`
6. Start the development server: `bun run dev`, then open [http://localhost:3456](http://localhost:3456) (always this exact URL: projects live in that origin's IndexedDB and OPFS).

> **Note:** Web development uses the published `opencut-wasm` package by default, so a fresh clone does not need a local WASM build.
>
> If you are editing `rust/wasm`, run `bun run build:wasm`, then `cd rust/wasm/pkg && bun link`, then `cd ../../../apps/web && bun link opencut-wasm`.

### Desktop setup

Only needed if you're working on `apps/desktop`. See [`apps/desktop/README.md`](../apps/desktop/README.md): it's a two-step process: Rust toolchain first via `script/setup-rust`, then desktop native dependencies via `apps/desktop/script/setup`.

## What to Focus On

**🎯 Good Areas to Contribute:**

- Timeline functionality and UI improvements
- Project management features
- Performance optimizations
- Bug fixes in existing functionality
- UI/UX improvements
- Documentation and testing

**⚠️ Areas to Avoid:**

- Preview panel enhancements (text fonts, stickers, effects)
- Export functionality improvements
- Preview rendering optimizations

**Why?** We're currently planning a major refactor of the preview system. The current preview renders DOM elements (HTML), but we're moving to a binary rendering approach similar to CapCut. This new system will ensure consistency between preview and export, and provide much better performance and quality.

The current HTML-based preview is essentially a prototype - the binary approach will be the "real deal." To avoid wasted effort, please focus on other areas of the application until this refactor is complete.

If you're unsure whether your idea falls into the preview category, feel free to ask us [directly in discord](https://discord.gg/zmR9N35cjK) or create a GitHub issue!

## Development Setup

The steps in [Setup](#setup) are all you need: there is no database to start and no secret to generate. From the repository root, `bun dev:web` does the same as `bun run dev` in `apps/web`.

### Desktop

Working on `apps/desktop`? See [`apps/desktop/README.md`](../apps/desktop/README.md) for setup. Web-only contributors can ignore this entirely.

## How to Contribute

### Reporting Bugs

- Use the bug report template
- Include steps to reproduce
- Provide screenshots if applicable

### Suggesting Features

- Use the feature request template
- Explain the use case
- Consider implementation details

### Code Contributions

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Make your changes
3. Run the relevant checks for the area you touched:

   - Web changes: from `apps/web`, run `bun run lint` and `bun run format`
   - Desktop changes: run `./apps/desktop/script/setup` if your environment isn't set up yet

4. Commit your changes with a descriptive message
5. Push to your fork and create a pull request

## Code Style

- We use ESLint for linting and Prettier for formatting
- Run `bun run format` from the `apps/web` directory to format code
- Run `bun run lint` from the `apps/web` directory to check for linting issues
- Follow the existing code patterns

## Pull Request Process

1. Fill out the pull request template completely
2. Link any related issues
3. Ensure CI passes
4. Request review from maintainers
5. Address any feedback

## Community

- Be respectful and inclusive
- Follow our Code of Conduct
- Help others in discussions and issues

Thank you for contributing!
