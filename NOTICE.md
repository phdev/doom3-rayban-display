# Notices

This repository is a web app shell, source patch, and packaging workflow for a DOOM 3 (id Tech 4) WebAssembly build for Meta Ray-Ban Display.

Engine baseline:

- dhewm3 (GPL DOOM 3 source port): <https://github.com/dhewm/dhewm3>
- id Tech 4 / DOOM 3 GPL source: <https://github.com/id-Software/DOOM-3>
- GL4ES (OpenGL -> GLES/WebGL translation): <https://github.com/ptitSeb/gl4es>
- Emscripten: <https://emscripten.org/>

The DOOM 3 engine code used by dhewm3 is GPL-3.0-licensed. This repository keeps generated WebAssembly artifacts and game data out of git by default.

DOOM 3 game data is **not** included. DOOM 3 game assets (`base/pak000.pk4` ... `base/pak008.pk4`) are proprietary and owned by id Software / ZeniMax. Provide your own legally owned data and reduce it locally before importing it into the browser app or embedding it in a private build.

Status: a fully working Emscripten/WASM build of DOOM 3 is **experimental**. dhewm3 does not ship an official Emscripten target. The patch and build scripts here describe the intended pipeline; the renderer, memory footprint, and performance on Meta Ray-Ban Display hardware are works in progress. See README.md for current limitations.
