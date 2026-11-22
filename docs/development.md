# Development

```sh
pnpm install --frozen-lockfile
pnpm dev         # Chromium extension with live reload
pnpm compile     # TypeScript checks
pnpm build       # Chromium extension build
pnpm zip         # Chrome Web Store package in .output/
pnpm build:firefox
```

## Project layout

| Folder | Contains |
| --- | --- |
| [`src/shelf/`](../src/shelf/) | Wall, Feed, People, and the lightbox. |
| [`src/master/`](../src/master/) and [`src/snapshot/`](../src/snapshot/) | The classic and per-source Explorer entries. |
| [`src/popup/`](../src/popup/) | The extension popup. |
| [`src/entrypoints/background.ts`](../src/entrypoints/background.ts) | Backup, download, and archive export logic. |

Vite builds the Explorer entries as standalone HTML templates. The extension fills them with archive data during export.

The icon source is [`src/assets/icon.svg`](../src/assets/icon.svg). Run `pnpm icons` with `rsvg-convert` installed to regenerate the extension’s PNG icons.
