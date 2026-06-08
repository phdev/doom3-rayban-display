// Minimal WebGL call recorder. Wraps every method on the WebGL2 prototype
// and records (name, arg signature) per call. Detects frame boundaries by
// wrapping requestAnimationFrame.
//
// Binary diagnostic: if frame N and frame N+1 have IDENTICAL call streams
// for the same scene, the per-frame intensity drift we observe lives BELOW
// WebGL (Apple Metal driver) — nothing we can fix in WebKit. If the streams
// DIFFER, the engine is sending different commands and we can hunt the
// variable.
//
// Usage:
//   window.__d3WebGLRecord.start();
//   // wait ~3 rAFs
//   const log = window.__d3WebGLRecord.stop();
//   // log is array of {frame, name, sig}
//
// Gated via ?record URL flag (otherwise zero overhead).

if (/[?&]record\b/.test(location.search)) {
  let frameId = 0;
  let calls = [];
  let recording = false;
  const MAX_CALLS = 200000;
  let dropped = 0;

  // Args signature: compact stringified version. Don't include full TypedArray
  // contents (way too big); instead hash to length + sample.
  function sigArg(a) {
    if (a == null) return String(a);
    if (typeof a === "number") return Number.isInteger(a) ? `i${a}` : `f${a.toFixed(6)}`;
    if (typeof a === "boolean") return a ? "T" : "F";
    if (typeof a === "string") return a.length > 32 ? `S${a.length}:${a.slice(0, 20)}` : `S:${a}`;
    if (a && typeof a.length === "number" && a.BYTES_PER_ELEMENT) {
      // TypedArray — sig = type+length+first/last/mid samples
      const t = a.constructor.name;
      const n = a.length;
      if (n === 0) return `${t}[0]`;
      const s = `${a[0]},${a[Math.floor(n / 2)]},${a[n - 1]}`;
      return `${t}[${n}]:${s}`;
    }
    if (a instanceof WebGLProgram || a instanceof WebGLShader ||
        a instanceof WebGLBuffer || a instanceof WebGLTexture ||
        a instanceof WebGLFramebuffer || a instanceof WebGLRenderbuffer ||
        a instanceof WebGLUniformLocation) {
      // Use a stable per-object id rather than the object identity
      if (!a.__d3id) a.__d3id = (Math.random() * 1e9 | 0);
      return `${a.constructor.name}#${a.__d3id}`;
    }
    if (Array.isArray(a)) return `[${a.length}]`;
    return typeof a;
  }

  function sigArgs(args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) parts.push(sigArg(args[i]));
    return parts.join("|");
  }

  function wrapProto(proto) {
    if (!proto || proto.__d3WrappedRecord) return;
    proto.__d3WrappedRecord = true;
    // Walk the chain and wrap each function. Use Object.getOwnPropertyNames
    // because WebGL2RenderingContext puts methods on the prototype.
    let p = proto;
    const seen = new Set();
    while (p && p !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(p)) {
        if (seen.has(key) || key === "constructor") continue;
        seen.add(key);
        const desc = Object.getOwnPropertyDescriptor(p, key);
        if (!desc || typeof desc.value !== "function") continue;
        const orig = desc.value;
        // Don't wrap the very-hot non-state-changing readers if we want speed;
        // record EVERYTHING for now since the diagnostic needs completeness.
        const wrapped = function () {
          const r = orig.apply(this, arguments);
          if (recording && calls.length < MAX_CALLS) {
            calls.push([frameId, key, sigArgs(arguments)]);
          } else if (recording) {
            dropped++;
          }
          return r;
        };
        try { proto[key] = wrapped; } catch (_) { /* read-only */ }
      }
      p = Object.getPrototypeOf(p);
    }
  }

  // Wrap rAF to mark frame boundaries
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return origRAF((t) => {
      if (recording) frameId++;
      cb(t);
    });
  };

  wrapProto(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrapProto(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  window.__d3WebGLRecord = {
    start() { calls = []; dropped = 0; frameId = 0; recording = true; },
    stop() {
      recording = false;
      return { calls: calls.slice(), dropped, frameId };
    },
    state() { return { recording, frame: frameId, n: calls.length, dropped }; }
  };

  // Loud console signal so we know the recorder is live
  console.log("[d3-record] WebGL recorder active — call window.__d3WebGLRecord.start() to begin");
}
