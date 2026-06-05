# Vendored OpenAL EFX headers

These are the OpenAL extension headers from
[OpenAL-Soft](https://github.com/kcat/openal-soft) (`include/AL/efx.h`,
`efx-presets.h`, `alext.h`):

- `AL/efx.h` — EFX (environmental audio effects) typedefs/enums.
- `AL/efx-presets.h` — reverb presets.
- `AL/alext.h` — OpenAL extension typedefs/enums (HRTF, disconnect, etc.).

## Why they're here

Emscripten's built-in OpenAL port ships only a minimal `AL/al.h`, `AL/alc.h`,
and a **stub** `AL/alext.h` that lacks the EFX `LPAL*` function-pointer typedefs
and several ALC extension symbols (`LPALCRESETDEVICESOFT`, `ALC_CONNECTED`, …)
that dhewm3's sound system references in `neo/sound/snd_local.h`.

The Emscripten build adds this directory to the include path (ahead of the
sysroot) so `<AL/efx.h>` and `<AL/alext.h>` resolve to these full headers, while
`<AL/al.h>` / `<AL/alc.h>` still resolve to Emscripten's actual OpenAL
implementation. The EFX *functions* stay unresolved at link, but are never
called because Emscripten's OpenAL reports no `ALC_EXT_EFX` at runtime (and the
app runs with sound disabled anyway).

## Local modifications

Two minimal edits were applied so the headers parse against Emscripten's
older/minimal `al.h`:

1. Quote-includes (`#include "al.h"`) rewritten to bracket form
   (`#include <AL/al.h>`) so they resolve to Emscripten's core headers.
2. Empty fallback `#define`s added for annotation/calling-convention macros that
   Emscripten's `al.h` does not define: `AL_APIENTRY`, `ALC_APIENTRY`,
   `AL_API_NOEXCEPT`, `AL_API_NOEXCEPT17`, `ALC_API_NOEXCEPT`,
   `ALC_API_NOEXCEPT17`.

## License

OpenAL-Soft is distributed under the GNU LGPL v2. See
<https://github.com/kcat/openal-soft/blob/master/COPYING>. These are interface
headers retained for compilation compatibility.
