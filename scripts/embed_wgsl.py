import sys, os, re
out_dir = sys.argv[1]
src_dir = sys.argv[2]
out_path = os.path.join(out_dir, "embedded_shaders.h")
shaders = {}
for fname in sorted(os.listdir(src_dir)):
    if not fname.endswith(".wgsl"): continue
    name = re.sub(r"\.wgsl$", "", fname).replace(".", "_")
    with open(os.path.join(src_dir, fname)) as f:
        content = f.read()
    # Escape for C string
    escaped = content.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n\"\n\"")
    shaders[name] = (fname, escaped)

with open(out_path, "w") as f:
    f.write("// Auto-generated from webgpu-port/shaders/*.wgsl — do not edit.\n")
    f.write("// Regenerate: python3 scripts/embed_wgsl.py\n")
    f.write("#pragma once\n\n")
    for name, (fname, esc) in shaders.items():
        f.write(f"// {fname}\n")
        f.write(f'static const char* const kWGSL_{name} = "{esc}";\n\n')
print(f"Wrote {out_path} with {len(shaders)} shaders: {list(shaders.keys())}")
