# Notices

This repository is a web app shell, source patch, and packaging workflow for a DOOM 3 (id Tech 4) WebAssembly build for Meta Ray-Ban Display.

Engine baseline:

- dhewm3 (GPL DOOM 3 source port): <https://github.com/dhewm/dhewm3>
- id Tech 4 / DOOM 3 GPL source: <https://github.com/id-Software/DOOM-3>
- GL4ES (OpenGL -> GLES/WebGL translation): <https://github.com/ptitSeb/gl4es>
- Emscripten: <https://emscripten.org/>

The DOOM 3 engine code used by dhewm3 is GPL-3.0-licensed. This repository keeps generated WebAssembly artifacts and game data out of git by default.

DOOM 3 game data is **not** included. DOOM 3 game assets (`base/pak000.pk4` ... `base/pak008.pk4`) are proprietary and owned by id Software / ZeniMax. Provide your own legally owned data and reduce it locally before importing it into the browser app or embedding it in a private build.

Status: dhewm3 does not ship an official Emscripten target, so this repo adds one. The patch + build scripts have been verified to compile and link DOOM 3 to WebAssembly and boot it in-browser (SDL video, memory, networking, and File System init) up to the point it requires game data. Rendered gameplay still needs your owned DOOM 3 data plus further runtime iteration (threading/audio, WebGL renderer validation, performance on Meta Ray-Ban Display hardware). See README.md for current limitations.

This repo also vendors three OpenAL extension headers from OpenAL-Soft (LGPL) under `vendor/openal-efx/` for build compatibility; see `vendor/openal-efx/README.md`.
